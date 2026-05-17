/**
 * Tests for `rea audit summary` (0.41.0).
 *
 * The summary command rolls up the audit log into headline counts,
 * grouped by tool_name / tier / status / session. Two scoping modes:
 *
 *   - No `--since` → walks current `.rea/audit.jsonl` only, all-time.
 *   - `--since <duration>` → filters to records within the last window.
 *
 * We pin: duration parsing edge cases, in-window filtering, the four
 * rollup buckets, chain-sample integrity (ok + tampered detection),
 * and JSON-vs-text rendering.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeAuditSummary,
  parseDurationSeconds,
  renderAuditSummary,
  AuditSummarySinceError,
  AUDIT_SUMMARY_SCHEMA_VERSION,
} from '../../src/cli/audit-summary.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../src/audit/append.js';

async function setupRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-summary-')));
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  return dir;
}

async function emit(
  baseDir: string,
  args: {
    toolName: string;
    sessionId: string;
    tier?: Tier;
    status?: InvocationStatus;
    timestamp?: string;
  },
): Promise<void> {
  await appendAuditRecord(baseDir, {
    tool_name: args.toolName,
    server_name: 'test',
    tier: args.tier ?? Tier.Read,
    status: args.status ?? InvocationStatus.Allowed,
    session_id: args.sessionId,
    ...(args.timestamp !== undefined ? { timestamp: args.timestamp } : {}),
  });
}

describe('parseDurationSeconds', () => {
  it('parses every supported unit', () => {
    expect(parseDurationSeconds('30s')).toBe(30);
    expect(parseDurationSeconds('5m')).toBe(300);
    expect(parseDurationSeconds('2h')).toBe(7200);
    expect(parseDurationSeconds('1d')).toBe(86400);
    expect(parseDurationSeconds('1w')).toBe(604800);
  });

  it('accepts upper-case units', () => {
    expect(parseDurationSeconds('24H')).toBe(86400);
    expect(parseDurationSeconds('7D')).toBe(604800);
  });

  it('strips surrounding whitespace', () => {
    expect(parseDurationSeconds('  12h  ')).toBe(43200);
  });

  it('rejects bare numbers', () => {
    expect(() => parseDurationSeconds('300')).toThrow(AuditSummarySinceError);
  });

  it('rejects fractional or negative durations', () => {
    expect(() => parseDurationSeconds('1.5h')).toThrow(AuditSummarySinceError);
    expect(() => parseDurationSeconds('-5d')).toThrow(AuditSummarySinceError);
    expect(() => parseDurationSeconds('0h')).toThrow(AuditSummarySinceError);
  });

  it('rejects unknown units', () => {
    expect(() => parseDurationSeconds('5y')).toThrow(AuditSummarySinceError);
    expect(() => parseDurationSeconds('30sec')).toThrow(AuditSummarySinceError);
  });

  it('rejects empty strings', () => {
    expect(() => parseDurationSeconds('')).toThrow(AuditSummarySinceError);
  });
});

describe('computeAuditSummary — basic rollups', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns zero counts on an empty repo', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const result = await computeAuditSummary({ baseDir: dir });
    expect(result.schema_version).toBe(AUDIT_SUMMARY_SCHEMA_VERSION);
    expect(result.total_events).toBe(0);
    expect(result.session_count).toBe(0);
    expect(result.earliest_timestamp).toBeNull();
    expect(result.latest_timestamp).toBeNull();
    expect(result.chain_integrity).toBe('unsampled');
  });

  it('counts by tool_name, tier, status, session', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's1', tier: Tier.Read });
    await emit(dir, { toolName: 'Bash', sessionId: 's1', tier: Tier.Read });
    await emit(dir, { toolName: 'Edit', sessionId: 's1', tier: Tier.Write });
    await emit(dir, {
      toolName: 'Write',
      sessionId: 's2',
      tier: Tier.Destructive,
      status: InvocationStatus.Denied,
    });
    const result = await computeAuditSummary({ baseDir: dir });
    expect(result.total_events).toBe(4);
    expect(result.by_tool_name.Bash).toBe(2);
    expect(result.by_tool_name.Edit).toBe(1);
    expect(result.by_tool_name.Write).toBe(1);
    expect(result.by_tier.read).toBe(2);
    expect(result.by_tier.write).toBe(1);
    expect(result.by_tier.destructive).toBe(1);
    expect(result.by_status.allowed).toBe(3);
    expect(result.by_status.denied).toBe(1);
    expect(result.by_session.s1).toBe(3);
    expect(result.by_session.s2).toBe(1);
    expect(result.session_count).toBe(2);
  });

  it('records earliest and latest timestamps from in-window records', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's1',
      timestamp: '2026-05-16T10:00:00.000Z',
    });
    await emit(dir, {
      toolName: 'Edit',
      sessionId: 's1',
      timestamp: '2026-05-16T12:00:00.000Z',
    });
    const result = await computeAuditSummary({ baseDir: dir });
    expect(result.earliest_timestamp).toBe('2026-05-16T10:00:00.000Z');
    expect(result.latest_timestamp).toBe('2026-05-16T12:00:00.000Z');
  });
});

describe('computeAuditSummary — `--since` window filtering', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('drops records outside the window', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    // 2 hours ago → in 1h window? No.
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's1',
      timestamp: '2026-05-16T10:00:00.000Z',
    });
    // 30 minutes ago → in 1h window? Yes.
    await emit(dir, {
      toolName: 'Edit',
      sessionId: 's2',
      timestamp: '2026-05-16T11:30:00.000Z',
    });
    const result = await computeAuditSummary({ baseDir: dir, since: '1h', now });
    expect(result.total_events).toBe(1);
    expect(result.by_tool_name.Edit).toBe(1);
    expect(result.by_tool_name.Bash).toBeUndefined();
    expect(result.window_seconds).toBe(3600);
    expect(result.window_start).toBe('2026-05-16T11:00:00.000Z');
    expect(result.window_end).toBe('2026-05-16T12:00:00.000Z');
  });

  it('keeps records exactly at window_start (inclusive boundary)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    // Exactly 1h ago.
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's1',
      timestamp: '2026-05-16T11:00:00.000Z',
    });
    const result = await computeAuditSummary({ baseDir: dir, since: '1h', now });
    expect(result.total_events).toBe(1);
  });

  it('reports null window when --since is omitted', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's1' });
    const result = await computeAuditSummary({ baseDir: dir });
    expect(result.window_seconds).toBeNull();
    expect(result.window_start).toBeNull();
    expect(result.window_end).toBeNull();
  });
});

describe('computeAuditSummary — chain integrity sampling', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('reports `ok` on a clean log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    for (let i = 0; i < 5; i += 1) {
      await emit(dir, { toolName: 'Bash', sessionId: 's1' });
    }
    const result = await computeAuditSummary({ baseDir: dir });
    expect(result.chain_integrity).toBe('ok');
    expect(result.chain_samples_verified).toBeGreaterThan(0);
  });

  it('reports `tampered` when a hash byte is flipped', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    for (let i = 0; i < 5; i += 1) {
      await emit(dir, { toolName: 'Bash', sessionId: 's1' });
    }
    // Corrupt the second line's hash by flipping one character.
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const raw = await fs.readFile(auditPath, 'utf8');
    const lines = raw.split('\n');
    const tampered = JSON.parse(lines[1]!) as { hash: string };
    const flipChar = tampered.hash[0] === '0' ? '1' : '0';
    tampered.hash = flipChar + tampered.hash.slice(1);
    lines[1] = JSON.stringify(tampered);
    await fs.writeFile(auditPath, lines.join('\n'), 'utf8');

    const result = await computeAuditSummary({ baseDir: dir });
    expect(result.chain_integrity).toBe('tampered');
  });

  it('does NOT report tampered when out-of-window records break adjacency (codex round-2 P1)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    // Pattern: in-window → out-of-window → in-window. The middle
    // record drops out under --since filtering; the third record's
    // prev_hash legitimately points to the dropped record (the
    // on-disk chain is unbroken), so a naïve adjacency check would
    // false-positive `tampered`.
    await emit(dir, {
      toolName: 'A',
      sessionId: 's',
      timestamp: '2026-05-16T11:30:00.000Z', // in window (1h)
    });
    await emit(dir, {
      toolName: 'B',
      sessionId: 's',
      timestamp: '2026-05-16T10:00:00.000Z', // OUT of window
    });
    await emit(dir, {
      toolName: 'C',
      sessionId: 's',
      timestamp: '2026-05-16T11:45:00.000Z', // in window
    });
    const result = await computeAuditSummary({ baseDir: dir, since: '1h', now });
    expect(result.total_events).toBe(2);
    expect(result.chain_integrity).toBe('ok');
  });

  it('reports `unsampled` when window is empty', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's1',
      // Far outside any window.
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const result = await computeAuditSummary({ baseDir: dir, since: '1h', now });
    expect(result.chain_integrity).toBe('unsampled');
    expect(result.chain_samples_verified).toBe(0);
  });
});

describe('computeAuditSummary — rotated audit walks (codex round-1 P2)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('walks rotated audit files by default (no --since)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    // Place a fake rotated file with a hand-written record so the
    // walker has something to scan WITHOUT needing to drive the real
    // rotation machinery. The summary reader ignores hash linkage
    // across the rotated/current boundary (chain integrity only
    // covers IN-WINDOW records), so a single well-formed line is
    // enough to verify it gets counted.
    const rotated = path.join(dir, '.rea', 'audit-20260515-100000.jsonl');
    const record = {
      timestamp: '2026-05-15T10:00:01.000Z',
      session_id: 'oldSession',
      tool_name: 'OldTool',
      server_name: 'test',
      tier: 'read',
      status: 'allowed',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    await fs.writeFile(rotated, `${JSON.stringify(record)}\n`, 'utf8');
    // And one record in the current file via the real append path.
    await emit(dir, { toolName: 'NewTool', sessionId: 'newSession' });

    const result = await computeAuditSummary({ baseDir: dir });
    expect(result.files_scanned.length).toBe(2);
    expect(result.total_events).toBe(2);
    expect(result.by_tool_name.OldTool).toBe(1);
    expect(result.by_tool_name.NewTool).toBe(1);
    expect(result.by_session.oldSession).toBe(1);
    expect(result.by_session.newSession).toBe(1);
  });

  it('still scopes correctly with --since when rotated files exist', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    // Old rotated file with a far-out-of-window record.
    const rotated = path.join(dir, '.rea', 'audit-20260101-000000.jsonl');
    const oldRecord = {
      timestamp: '2026-01-01T00:00:01.000Z',
      session_id: 's1',
      tool_name: 'Stale',
      server_name: 'test',
      tier: 'read',
      status: 'allowed',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    await fs.writeFile(rotated, `${JSON.stringify(oldRecord)}\n`, 'utf8');
    // Current-file record inside the 1h window.
    await emit(dir, {
      toolName: 'Fresh',
      sessionId: 's2',
      timestamp: '2026-05-16T11:30:00.000Z',
    });
    const result = await computeAuditSummary({ baseDir: dir, since: '1h', now });
    expect(result.total_events).toBe(1);
    expect(result.by_tool_name.Fresh).toBe(1);
    expect(result.by_tool_name.Stale).toBeUndefined();
  });
});

describe('renderAuditSummary', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('emits a no-events notice on an empty log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const result = await computeAuditSummary({ baseDir: dir });
    const out = renderAuditSummary(result);
    expect(out).toContain('total events:');
    expect(out).toContain('No events in the audit log.');
  });

  it('renders the four bucket tables on a populated log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's1' });
    await emit(dir, { toolName: 'Edit', sessionId: 's1', tier: Tier.Write });
    await emit(dir, {
      toolName: 'Write',
      sessionId: 's2',
      tier: Tier.Destructive,
      status: InvocationStatus.Denied,
    });
    const result = await computeAuditSummary({ baseDir: dir });
    const out = renderAuditSummary(result);
    expect(out).toContain('by tool_name:');
    expect(out).toContain('by tier:');
    expect(out).toContain('by status:');
    expect(out).toContain('top sessions:');
    expect(out).toContain('chain integrity:');
  });

  it('uses a coarsest-unit window header when --since is set', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    await emit(dir, {
      toolName: 'Bash',
      sessionId: 's1',
      timestamp: '2026-05-16T11:00:00.000Z',
    });
    // 24h = 86400s = 1d; the renderer picks the coarsest single unit.
    const result = await computeAuditSummary({ baseDir: dir, since: '24h', now });
    const out = renderAuditSummary(result);
    expect(out).toContain('(last 1d)');
    // And a non-coarse window stays in hours.
    const result2 = await computeAuditSummary({ baseDir: dir, since: '5h', now });
    const out2 = renderAuditSummary(result2);
    expect(out2).toContain('(last 5h)');
  });

  it('uses "all time" header without --since', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's1' });
    const result = await computeAuditSummary({ baseDir: dir });
    const out = renderAuditSummary(result);
    expect(out).toContain('(all time)');
  });
});
