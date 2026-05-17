/**
 * Tests for `rea audit top-blocks` (0.47.0 charter item 3).
 *
 * Pins:
 *   - Refusal filter (denied / error) — allowed records are excluded
 *   - `--limit=N` cap behavior + `total_matched` vs `events.length`
 *   - `--since=DUR` window filtering
 *   - Newest-first sort + intra-millisecond stable order
 *   - JSON shape stability for dashboard consumers
 *   - Empty log + missing audit file paths
 *   - `--limit` bounds, strict integer parsing
 *   - Reason fallback when `error` field is absent
 *   - Reason truncation in human renderer (full text in JSON)
 *   - Rotated-file walk
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeAuditTopBlocks,
  parseLimitOption,
  renderAuditTopBlocks,
  AuditTopBlocksOptionError,
  AUDIT_TOP_BLOCKS_SCHEMA_VERSION,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../../src/cli/audit-top-blocks.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../src/audit/append.js';

async function setupRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-top-blocks-')));
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  return dir;
}

interface EmitArgs {
  toolName: string;
  sessionId: string;
  tier?: Tier;
  status?: InvocationStatus;
  timestamp?: string;
  error?: string;
}

async function emit(baseDir: string, args: EmitArgs): Promise<void> {
  await appendAuditRecord(baseDir, {
    tool_name: args.toolName,
    server_name: 'test',
    tier: args.tier ?? Tier.Read,
    status: args.status ?? InvocationStatus.Allowed,
    session_id: args.sessionId,
    ...(args.timestamp !== undefined ? { timestamp: args.timestamp } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
  });
}

describe('parseLimitOption — strict integer validation', () => {
  it('accepts bare positive integers', () => {
    expect(parseLimitOption('1')).toBe(1);
    expect(parseLimitOption('20')).toBe(20);
    expect(parseLimitOption('999')).toBe(999);
  });

  it('strips surrounding whitespace', () => {
    expect(parseLimitOption('  42  ')).toBe(42);
  });

  it('rejects fractional input (would silently truncate)', () => {
    expect(() => parseLimitOption('1.5')).toThrow(AuditTopBlocksOptionError);
    expect(() => parseLimitOption('20.0')).toThrow(AuditTopBlocksOptionError);
  });

  it('rejects trailing-garbage input (would silently drop chars)', () => {
    expect(() => parseLimitOption('10abc')).toThrow(AuditTopBlocksOptionError);
    expect(() => parseLimitOption('20k')).toThrow(AuditTopBlocksOptionError);
  });

  it('rejects empty / non-numeric input', () => {
    expect(() => parseLimitOption('')).toThrow(AuditTopBlocksOptionError);
    expect(() => parseLimitOption('   ')).toThrow(AuditTopBlocksOptionError);
    expect(() => parseLimitOption('abc')).toThrow(AuditTopBlocksOptionError);
    expect(() => parseLimitOption('NaN')).toThrow(AuditTopBlocksOptionError);
  });

  it('rejects scientific / hex / binary forms', () => {
    expect(() => parseLimitOption('1e2')).toThrow(AuditTopBlocksOptionError);
    expect(() => parseLimitOption('0x10')).toThrow(AuditTopBlocksOptionError);
  });
});

describe('computeAuditTopBlocks — refusal filter', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns an empty list on an empty repo', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const result = await computeAuditTopBlocks({ baseDir: dir });
    expect(result.schema_version).toBe(AUDIT_TOP_BLOCKS_SCHEMA_VERSION);
    expect(result.total_matched).toBe(0);
    expect(result.events).toEqual([]);
    expect(result.limit).toBe(DEFAULT_LIMIT);
    expect(result.since).toBeNull();
  });

  it('excludes `allowed` records and includes `denied` + `error`', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's', status: InvocationStatus.Allowed });
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's',
      status: InvocationStatus.Denied,
      error: 'rm -rf bypass attempted',
    });
    await emit(dir, {
      toolName: 'Write',
      sessionId: 's',
      status: InvocationStatus.Error,
      error: 'protected-path .env',
    });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    expect(result.total_matched).toBe(2);
    expect(result.events.length).toBe(2);
    const statuses = result.events.map((e) => e.status).sort();
    expect(statuses).toEqual(['denied', 'error']);
  });

  it('surfaces non-standard status values as refusals (forward-compat)', async () => {
    // A future enum extension (or consumer-emitted status) should
    // appear in the report rather than being silently dropped.
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const rec = {
      timestamp: '2026-05-17T10:00:00.000Z',
      session_id: 's',
      tool_name: 'Bash',
      server_name: 'test',
      tier: 'read',
      status: 'rate-limited',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    await fs.writeFile(auditPath, `${JSON.stringify(rec)}\n`, 'utf8');
    const result = await computeAuditTopBlocks({ baseDir: dir });
    expect(result.total_matched).toBe(1);
    expect(result.events[0]?.status).toBe('rate-limited');
  });
});

describe('computeAuditTopBlocks — sort + limit', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('sorts events newest-first', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, {
      toolName: 'A',
      sessionId: 's',
      status: InvocationStatus.Denied,
      timestamp: '2026-05-17T09:00:00.000Z',
      error: 'old',
    });
    await emit(dir, {
      toolName: 'B',
      sessionId: 's',
      status: InvocationStatus.Denied,
      timestamp: '2026-05-17T11:00:00.000Z',
      error: 'new',
    });
    await emit(dir, {
      toolName: 'C',
      sessionId: 's',
      status: InvocationStatus.Denied,
      timestamp: '2026-05-17T10:00:00.000Z',
      error: 'mid',
    });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    expect(result.events.map((e) => e.tool)).toEqual(['B', 'C', 'A']);
  });

  it('caps visible events at --limit but reports total_matched', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    for (let i = 0; i < 5; i += 1) {
      await emit(dir, {
        toolName: `T${String(i)}`,
        sessionId: 's',
        status: InvocationStatus.Denied,
        timestamp: `2026-05-17T1${String(i)}:00:00.000Z`,
        error: `r${String(i)}`,
      });
    }
    const result = await computeAuditTopBlocks({ baseDir: dir, limit: 3 });
    expect(result.events.length).toBe(3);
    expect(result.total_matched).toBe(5);
    expect(result.limit).toBe(3);
  });

  it('rejects --limit < 1', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await expect(computeAuditTopBlocks({ baseDir: dir, limit: 0 })).rejects.toThrow(
      AuditTopBlocksOptionError,
    );
    await expect(computeAuditTopBlocks({ baseDir: dir, limit: -5 })).rejects.toThrow(
      AuditTopBlocksOptionError,
    );
  });

  it('rejects --limit > MAX_LIMIT', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await expect(computeAuditTopBlocks({ baseDir: dir, limit: MAX_LIMIT + 1 })).rejects.toThrow(
      AuditTopBlocksOptionError,
    );
  });

  it('rejects non-integer --limit', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await expect(computeAuditTopBlocks({ baseDir: dir, limit: 1.5 })).rejects.toThrow(
      AuditTopBlocksOptionError,
    );
  });

  it('accepts --limit at the MAX_LIMIT boundary', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'X', sessionId: 's', status: InvocationStatus.Denied });
    const result = await computeAuditTopBlocks({ baseDir: dir, limit: MAX_LIMIT });
    expect(result.limit).toBe(MAX_LIMIT);
  });

  // Codex round-2 P2 (0.47.0): a raw-string lex sort would put
  // `2026-05-17T23:00:00+02:00` (= 21:00:00Z, OLDER) ahead of
  // `2026-05-17T22:30:00Z` (NEWER). The sort must compare PARSED
  // instants, not raw strings, or top-blocks misorders refusal events
  // and `--limit` can omit the actual newest one.
  it('sorts by parsed instant, not raw timestamp string (codex round-2 P2)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const baseRec = (hash: string, prev: string, tool: string, ts: string) => ({
      timestamp: ts,
      session_id: 's',
      tool_name: tool,
      server_name: 'test',
      tier: 'read',
      status: 'denied',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      error: 'reason',
      prev_hash: prev,
      hash,
    });
    // Older instant rendered in +02:00 offset form (= 21:00:00Z).
    const older = baseRec('a'.repeat(64), '0'.repeat(64), 'OlderInOffset', '2026-05-17T23:00:00+02:00');
    // Newer instant rendered in Z form (= 22:30:00Z).
    const newer = baseRec('b'.repeat(64), 'a'.repeat(64), 'NewerInZ', '2026-05-17T22:30:00Z');
    await fs.writeFile(auditPath, `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`, 'utf8');
    const result = await computeAuditTopBlocks({ baseDir: dir });
    // Newer instant must be first, even though its raw string would
    // lex-sort AFTER the older offset-form one.
    expect(result.events[0]?.tool).toBe('NewerInZ');
    expect(result.events[1]?.tool).toBe('OlderInOffset');
  });

  it('stable sort on intra-millisecond timestamp ties', async () => {
    // Two records with identical timestamps must produce a stable
    // order so dashboards don't churn between runs. The implementation
    // falls back to hash comparison.
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const baseRec = (hash: string, prev: string, tool: string) => ({
      timestamp: '2026-05-17T10:00:00.000Z',
      session_id: 's',
      tool_name: tool,
      server_name: 'test',
      tier: 'read',
      status: 'denied',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      error: 'reason',
      prev_hash: prev,
      hash,
    });
    await fs.writeFile(
      auditPath,
      `${JSON.stringify(baseRec('b'.repeat(64), '0'.repeat(64), 'B'))}\n` +
        `${JSON.stringify(baseRec('a'.repeat(64), 'b'.repeat(64), 'A'))}\n`,
      'utf8',
    );
    const r1 = await computeAuditTopBlocks({ baseDir: dir });
    const r2 = await computeAuditTopBlocks({ baseDir: dir });
    expect(r1.events.map((e) => e.hash)).toEqual(r2.events.map((e) => e.hash));
    // Sort tiebreaker: hash ascending — 'a...' before 'b...'.
    expect(r1.events[0]?.hash.startsWith('a')).toBe(true);
  });
});

describe('computeAuditTopBlocks — --since window', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('drops records outside the window', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-17T12:00:00.000Z');
    await emit(dir, {
      toolName: 'Stale',
      sessionId: 's1',
      status: InvocationStatus.Denied,
      timestamp: '2026-05-17T09:00:00.000Z', // 3h ago — outside 1h
      error: 'old',
    });
    await emit(dir, {
      toolName: 'Fresh',
      sessionId: 's2',
      status: InvocationStatus.Denied,
      timestamp: '2026-05-17T11:30:00.000Z', // 30m ago — inside
      error: 'recent',
    });
    const result = await computeAuditTopBlocks({ baseDir: dir, since: '1h', now });
    expect(result.total_matched).toBe(1);
    expect(result.events[0]?.tool).toBe('Fresh');
    expect(result.since).toBe('1h');
    expect(result.window.seconds).toBe(3600);
  });

  it('reports null window when --since is omitted', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'X', sessionId: 's', status: InvocationStatus.Denied });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    expect(result.since).toBeNull();
    expect(result.window.seconds).toBeNull();
  });

  it('rejects malformed --since', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await expect(computeAuditTopBlocks({ baseDir: dir, since: 'forever' })).rejects.toThrow(
      AuditTopBlocksOptionError,
    );
  });
});

// Codex round-10 P2 (0.47.0): in a policy-storm scenario the
// command shouldn't accumulate every refusal then sort+slice. The
// bounded-buffer shape keeps memory O(limit) and still reports the
// correct `total_matched`.
describe('computeAuditTopBlocks — bounded memory under heavy refusals (codex round-10 P2)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns the correct top-N and total_matched on a refusal-heavy log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const lines: string[] = [];
    // 500 refusals spread across an hour.
    const anchor = new Date('2026-05-17T10:00:00.000Z').getTime();
    for (let i = 0; i < 500; i += 1) {
      const ts = new Date(anchor + i * 1000).toISOString();
      lines.push(
        JSON.stringify({
          timestamp: ts,
          session_id: 's',
          tool_name: `T${String(i)}`,
          server_name: 'test',
          tier: 'read',
          status: 'denied',
          autonomy_level: 'L1',
          duration_ms: 0,
          emission_source: 'other',
          error: `reason ${String(i)}`,
          prev_hash: '0'.repeat(64),
          hash: i.toString(16).padStart(64, '0'),
        }),
      );
    }
    await fs.writeFile(auditPath, lines.join('\n') + '\n', 'utf8');
    const result = await computeAuditTopBlocks({ baseDir: dir, limit: 5 });
    // Only 5 events returned, but total_matched counts every refusal.
    expect(result.events.length).toBe(5);
    expect(result.total_matched).toBe(500);
    // And the 5 returned are the NEWEST (last 5 inserted = highest tool index).
    const returnedTools = result.events.map((e) => e.tool);
    expect(returnedTools).toEqual(['T499', 'T498', 'T497', 'T496', 'T495']);
  });
});

describe('computeAuditTopBlocks — reason fallback', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('uses the error field when present', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's',
      status: InvocationStatus.Denied,
      error: 'rm -rf bypass attempted',
    });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    expect(result.events[0]?.reason).toBe('rm -rf bypass attempted');
  });

  it('synthesizes a "<status>: <tool>" fallback when error is absent', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, {
      toolName: 'Write',
      sessionId: 's',
      status: InvocationStatus.Denied,
      // no error field
    });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    expect(result.events[0]?.reason).toBe('denied: Write');
  });
});

describe('computeAuditTopBlocks — rotated audit walks', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('walks rotated audit files by default', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const rotated = path.join(dir, '.rea', 'audit-20260515-100000.jsonl');
    const r = {
      timestamp: '2026-05-15T10:00:01.000Z',
      session_id: 'old',
      tool_name: 'OldTool',
      server_name: 'test',
      tier: 'read',
      status: 'denied',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      error: 'old block',
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    await fs.writeFile(rotated, `${JSON.stringify(r)}\n`, 'utf8');
    await emit(dir, {
      toolName: 'NewTool',
      sessionId: 'new',
      status: InvocationStatus.Denied,
      error: 'fresh block',
    });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    expect(result.files_scanned.length).toBe(2);
    expect(result.total_matched).toBe(2);
  });
});

describe('renderAuditTopBlocks', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('emits a no-events notice on an empty log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const result = await computeAuditTopBlocks({ baseDir: dir });
    const out = renderAuditTopBlocks(result);
    expect(out).toContain('No refusal events in the audit log.');
  });

  it('renders the table with short hash, timestamp, tool, reason', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's',
      status: InvocationStatus.Denied,
      timestamp: '2026-05-17T10:00:00.000Z',
      error: 'rm -rf bypass attempted',
    });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    const out = renderAuditTopBlocks(result);
    expect(out).toContain('rea audit top-blocks');
    expect(out).toContain('Bash');
    expect(out).toContain('rm -rf bypass attempted');
    expect(out).toContain('2026-05-17T10:00:00.000Z');
    // Short hash is 8 chars — appears at the start of an event line.
    // The actual hash content depends on the chain seed; just confirm a
    // hex-ish 8-char prefix is present somewhere on the body.
    expect(out).toMatch(/[0-9a-f]{8}/);
  });

  // Codex round-10 P3 (0.47.0): multiline reasons (shell stderr,
  // Node stack traces) must be collapsed before column rendering or
  // a single event will spill across multiple lines and break the
  // hash/timestamp/tool columns. JSON path preserves the raw text.
  it('collapses multiline reasons in human renderer, preserves in JSON (codex round-10 P3)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const multiline = 'first line\nsecond line\r\nthird line\tafter-tab';
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's',
      status: InvocationStatus.Denied,
      error: multiline,
    });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    const out = renderAuditTopBlocks(result);
    // Human renderer collapses newlines/tabs to single spaces.
    expect(out).toContain('first line second line third line after-tab');
    // Each event still occupies exactly one terminal line in the
    // table body — easy way to confirm: split on newline and count
    // lines that start with the short-hash hex prefix.
    const tableRows = out.split('\n').filter((l) => /^[0-9a-f]{8}/.test(l));
    expect(tableRows.length).toBe(1);
    // JSON shape keeps the raw multiline message.
    expect(result.events[0]?.reason).toBe(multiline);
  });

  it('truncates reason in human renderer (full text in JSON shape)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const longReason = 'x'.repeat(200);
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's',
      status: InvocationStatus.Denied,
      error: longReason,
    });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    const out = renderAuditTopBlocks(result);
    // Truncated to ~80 chars with ellipsis.
    expect(out).toContain('xxxxx…');
    expect(out).not.toContain(longReason);
    // JSON path preserves the full reason.
    expect(result.events[0]?.reason).toBe(longReason);
  });

  it('shows "N of M" line when limit elides events', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    for (let i = 0; i < 5; i += 1) {
      await emit(dir, {
        toolName: `T${String(i)}`,
        sessionId: 's',
        status: InvocationStatus.Denied,
        timestamp: `2026-05-17T1${String(i)}:00:00.000Z`,
        error: `r${String(i)}`,
      });
    }
    const result = await computeAuditTopBlocks({ baseDir: dir, limit: 2 });
    const out = renderAuditTopBlocks(result);
    expect(out).toContain('2 of 5 refusal events shown');
    expect(out).toContain('--limit=2');
  });

  it('uses "all time" header without --since', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's', status: InvocationStatus.Denied });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    const out = renderAuditTopBlocks(result);
    expect(out).toContain('all time');
  });

  it('uses coarsest-unit window header with --since', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-17T12:00:00.000Z');
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's',
      status: InvocationStatus.Denied,
      timestamp: '2026-05-17T11:30:00.000Z',
    });
    const result = await computeAuditTopBlocks({ baseDir: dir, since: '24h', now });
    const out = renderAuditTopBlocks(result);
    expect(out).toContain('last 1d');
  });
});

describe('computeAuditTopBlocks — JSON shape stability', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('produces a stable JSON shape for dashboards', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's',
      status: InvocationStatus.Denied,
      error: 'reason',
    });
    const result = await computeAuditTopBlocks({ baseDir: dir });
    expect(Object.keys(result).sort()).toEqual(
      [
        'events',
        'files_scanned',
        'limit',
        'schema_version',
        'since',
        'total_matched',
        'window',
      ].sort(),
    );
    expect(Object.keys(result.window).sort()).toEqual(['end', 'seconds', 'start']);
    for (const ev of result.events) {
      expect(Object.keys(ev).sort()).toEqual(
        ['hash', 'reason', 'session_id', 'status', 'timestamp', 'tool'].sort(),
      );
    }
  });
});
