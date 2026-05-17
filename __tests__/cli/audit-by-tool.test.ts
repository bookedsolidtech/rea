/**
 * Tests for `rea audit by-tool` (0.46.0 charter item 1).
 *
 * Pins:
 *   - Basic rollup correctness (counts + pct)
 *   - `--top=N` cap behavior (visible tools + long-tail summary)
 *   - `--since=DUR` window filtering (delegates parsing to audit-summary)
 *   - JSON-vs-text rendering
 *   - Empty log + missing audit file paths
 *   - `--top` bounds + duration error propagation
 *   - Rotated-file walk
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeAuditByTool,
  parseTopOption,
  renderAuditByTool,
  AuditByToolOptionError,
  AUDIT_BY_TOOL_SCHEMA_VERSION,
  DEFAULT_TOP,
  MAX_TOP,
} from '../../src/cli/audit-by-tool.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../src/audit/append.js';

async function setupRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-by-tool-')));
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

// Codex round-1 P3 (0.46.0): the commander `--top` parser must reject
// non-integer input rather than silently truncating it. Pre-fix the
// parser used `Number.parseInt(raw, 10)` which accepted `1.5` as `1`
// and `10abc` as `10`, changing the requested top-N under the
// operator's nose with no error signal.
describe('parseTopOption — strict integer validation', () => {
  it('accepts bare positive integers', () => {
    expect(parseTopOption('1')).toBe(1);
    expect(parseTopOption('20')).toBe(20);
    expect(parseTopOption('999')).toBe(999);
  });

  it('accepts negative integers (range validation handled downstream)', () => {
    expect(parseTopOption('-5')).toBe(-5);
  });

  it('strips surrounding whitespace', () => {
    expect(parseTopOption('  42  ')).toBe(42);
  });

  it('rejects fractional input (would silently truncate)', () => {
    expect(() => parseTopOption('1.5')).toThrow(AuditByToolOptionError);
    expect(() => parseTopOption('20.0')).toThrow(AuditByToolOptionError);
  });

  it('rejects trailing-garbage input (would silently drop chars)', () => {
    expect(() => parseTopOption('10abc')).toThrow(AuditByToolOptionError);
    expect(() => parseTopOption('20k')).toThrow(AuditByToolOptionError);
  });

  it('rejects empty / non-numeric input', () => {
    expect(() => parseTopOption('')).toThrow(AuditByToolOptionError);
    expect(() => parseTopOption('   ')).toThrow(AuditByToolOptionError);
    expect(() => parseTopOption('abc')).toThrow(AuditByToolOptionError);
    expect(() => parseTopOption('NaN')).toThrow(AuditByToolOptionError);
  });

  it('rejects scientific / hex / binary forms', () => {
    expect(() => parseTopOption('1e2')).toThrow(AuditByToolOptionError);
    expect(() => parseTopOption('0x10')).toThrow(AuditByToolOptionError);
    expect(() => parseTopOption('0b10')).toThrow(AuditByToolOptionError);
  });
});

describe('computeAuditByTool — basic rollup', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns zero counts on an empty repo', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const result = await computeAuditByTool({ baseDir: dir });
    expect(result.schema_version).toBe(AUDIT_BY_TOOL_SCHEMA_VERSION);
    expect(result.total_events).toBe(0);
    expect(result.unique_tools).toBe(0);
    expect(result.tools).toEqual([]);
    expect(result.top).toBe(DEFAULT_TOP);
  });

  it('counts and percentages match the underlying log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    for (let i = 0; i < 5; i += 1) {
      await emit(dir, { toolName: 'Bash', sessionId: 's1' });
    }
    for (let i = 0; i < 3; i += 1) {
      await emit(dir, { toolName: 'Edit', sessionId: 's1' });
    }
    for (let i = 0; i < 2; i += 1) {
      await emit(dir, { toolName: 'Write', sessionId: 's2' });
    }
    const result = await computeAuditByTool({ baseDir: dir });
    expect(result.total_events).toBe(10);
    expect(result.unique_tools).toBe(3);
    // Sorted desc by count.
    expect(result.tools[0]).toEqual({ name: 'Bash', count: 5, pct: 50 });
    expect(result.tools[1]).toEqual({ name: 'Edit', count: 3, pct: 30 });
    expect(result.tools[2]).toEqual({ name: 'Write', count: 2, pct: 20 });
  });

  it('breaks ties alphabetically (deterministic ordering)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Zeta', sessionId: 's1' });
    await emit(dir, { toolName: 'Alpha', sessionId: 's1' });
    const result = await computeAuditByTool({ baseDir: dir });
    expect(result.tools.map((t) => t.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('buckets unknown / empty tool_names to (unknown)', async () => {
    // Hand-write a record with missing tool_name so we exercise the
    // fallback path without going through the validated append API.
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const bad = {
      timestamp: '2026-05-16T10:00:00.000Z',
      session_id: 's1',
      tool_name: '',
      server_name: 'test',
      tier: 'read',
      status: 'allowed',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    await fs.writeFile(auditPath, `${JSON.stringify(bad)}\n`, 'utf8');
    const result = await computeAuditByTool({ baseDir: dir });
    expect(result.tools[0]).toEqual({ name: '(unknown)', count: 1, pct: 100 });
  });
});

describe('computeAuditByTool — --top cap', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('caps visible tools at --top and surfaces unique_tools accurately', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    // 5 distinct tools, top=3 — should show 3 and report 5 unique.
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      await emit(dir, { toolName: name, sessionId: 's' });
    }
    const result = await computeAuditByTool({ baseDir: dir, top: 3 });
    expect(result.tools.length).toBe(3);
    expect(result.unique_tools).toBe(5);
    expect(result.top).toBe(3);
    expect(result.total_events).toBe(5);
  });

  it('rejects --top < 1', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await expect(computeAuditByTool({ baseDir: dir, top: 0 })).rejects.toThrow(
      AuditByToolOptionError,
    );
    await expect(computeAuditByTool({ baseDir: dir, top: -5 })).rejects.toThrow(
      AuditByToolOptionError,
    );
  });

  it('rejects --top > MAX_TOP', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await expect(computeAuditByTool({ baseDir: dir, top: MAX_TOP + 1 })).rejects.toThrow(
      AuditByToolOptionError,
    );
  });

  it('rejects non-integer --top', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await expect(computeAuditByTool({ baseDir: dir, top: 1.5 })).rejects.toThrow(
      AuditByToolOptionError,
    );
  });

  it('accepts --top at the MAX_TOP boundary', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's' });
    const result = await computeAuditByTool({ baseDir: dir, top: MAX_TOP });
    expect(result.top).toBe(MAX_TOP);
  });
});

describe('computeAuditByTool — --since window', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('drops records outside the window', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    await emit(dir, {
      toolName: 'Stale',
      sessionId: 's1',
      timestamp: '2026-05-16T09:00:00.000Z', // 3h ago — outside 1h window
    });
    await emit(dir, {
      toolName: 'Fresh',
      sessionId: 's2',
      timestamp: '2026-05-16T11:30:00.000Z', // 30m ago — inside
    });
    const result = await computeAuditByTool({ baseDir: dir, since: '1h', now });
    expect(result.total_events).toBe(1);
    expect(result.tools[0]?.name).toBe('Fresh');
    expect(result.window.seconds).toBe(3600);
    expect(result.window.start).toBe('2026-05-16T11:00:00.000Z');
    expect(result.window.end).toBe('2026-05-16T12:00:00.000Z');
  });

  it('reports null window when --since is omitted', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's' });
    const result = await computeAuditByTool({ baseDir: dir });
    expect(result.window.seconds).toBeNull();
    expect(result.window.start).toBeNull();
    expect(result.window.end).toBeNull();
  });

  it('rejects malformed --since via AuditByToolOptionError', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await expect(computeAuditByTool({ baseDir: dir, since: 'forever' })).rejects.toThrow(
      AuditByToolOptionError,
    );
  });
});

describe('computeAuditByTool — rotated audit walks', () => {
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
      status: 'allowed',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    await fs.writeFile(rotated, `${JSON.stringify(r)}\n`, 'utf8');
    await emit(dir, { toolName: 'NewTool', sessionId: 'new' });
    const result = await computeAuditByTool({ baseDir: dir });
    expect(result.files_scanned.length).toBe(2);
    expect(result.total_events).toBe(2);
    expect(result.unique_tools).toBe(2);
  });
});

describe('renderAuditByTool', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('emits a no-events notice on an empty log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const result = await computeAuditByTool({ baseDir: dir });
    const out = renderAuditByTool(result);
    expect(out).toContain('No events in the audit log.');
  });

  it('renders the table with counts + pct on a populated log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's' });
    await emit(dir, { toolName: 'Bash', sessionId: 's' });
    await emit(dir, { toolName: 'Edit', sessionId: 's' });
    const result = await computeAuditByTool({ baseDir: dir });
    const out = renderAuditByTool(result);
    expect(out).toContain('Bash');
    expect(out).toContain('Edit');
    // Stable header.
    expect(out).toContain('rea audit by-tool');
    expect(out).toContain('total: 3 events');
  });

  it('renders the long-tail summary line when --top elides rows', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      await emit(dir, { toolName: name, sessionId: 's' });
    }
    const result = await computeAuditByTool({ baseDir: dir, top: 2 });
    const out = renderAuditByTool(result);
    expect(out).toMatch(/\(other:.*3 tools.*3 events/);
  });

  it('coarsest-unit window header when --since is set', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    await emit(dir, { toolName: 'Bash', sessionId: 's', timestamp: '2026-05-16T11:30:00.000Z' });
    const result = await computeAuditByTool({ baseDir: dir, since: '24h', now });
    const out = renderAuditByTool(result);
    expect(out).toContain('last 1d');
  });

  it('uses "all time" header without --since', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's' });
    const result = await computeAuditByTool({ baseDir: dir });
    const out = renderAuditByTool(result);
    expect(out).toContain('all time');
  });
});

describe('computeAuditByTool — JSON shape stability', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('produces a stable JSON shape for dashboards', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'Bash', sessionId: 's' });
    await emit(dir, { toolName: 'Edit', sessionId: 's' });
    const result = await computeAuditByTool({ baseDir: dir });
    // Fields explicitly present.
    expect(Object.keys(result).sort()).toEqual(
      ['files_scanned', 'schema_version', 'tools', 'top', 'total_events', 'unique_tools', 'window'].sort(),
    );
    expect(Object.keys(result.window).sort()).toEqual(['end', 'seconds', 'start']);
    for (const t of result.tools) {
      expect(Object.keys(t).sort()).toEqual(['count', 'name', 'pct']);
    }
  });
});
