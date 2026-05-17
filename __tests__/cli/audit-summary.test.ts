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
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  // 0.42.0 charter item 3 — rotated filenames are NOT authoritative
  // for "earliest record contained". The filename stamp marks the
  // ROTATION INSTANT; a rotation that landed late (because the size
  // cap was reached only after a long quiet period) can contain
  // records that pre-date its filename by days. Pre-0.42.0 the
  // walker pruned rotated files by their filename stamp, dropping
  // in-window records from any rotation that occurred long after
  // its earliest contents.
  //
  // Concrete shape exercised below:
  //   - Rotated filename: audit-20260510-000000.jsonl (stamped 6
  //     days BEFORE the 5d window start of 2026-05-11)
  //   - First record inside: timestamp 2026-05-12 (INSIDE the 5d
  //     window — should be counted)
  //   - Second record inside: timestamp 2026-05-05 (OUTSIDE — should
  //     be filtered out by the per-record check)
  //   - Pre-0.42.0: the filename stamp 2026-05-10 < cutoff
  //     2026-05-11, so the file was pruned from the walk and BOTH
  //     records were silently dropped, even though the first was
  //     in-window. Post-0.42.0: the file is walked, the per-record
  //     filter keeps the in-window record and drops the
  //     out-of-window one.
  it('walks rotated files even when their filename stamp pre-dates the window (late-rotation correctness)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T00:00:00.000Z');
    const rotatedPath = path.join(dir, '.rea', 'audit-20260510-000000.jsonl');
    const inWindowRecord = {
      timestamp: '2026-05-12T10:00:00.000Z', // 4d before now → inside 5d window
      session_id: 's1',
      tool_name: 'LateRotated',
      server_name: 'test',
      tier: 'read',
      status: 'allowed',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    const outOfWindowRecord = {
      timestamp: '2026-05-05T10:00:00.000Z', // 11d before now → outside 5d window
      session_id: 's1',
      tool_name: 'StaleEntry',
      server_name: 'test',
      tier: 'read',
      status: 'allowed',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      prev_hash: '0'.repeat(64),
      hash: 'b'.repeat(64),
    };
    await fs.writeFile(
      rotatedPath,
      `${JSON.stringify(inWindowRecord)}\n${JSON.stringify(outOfWindowRecord)}\n`,
      'utf8',
    );
    const result = await computeAuditSummary({ baseDir: dir, since: '5d', now });
    expect(result.total_events).toBe(1);
    expect(result.by_tool_name.LateRotated).toBe(1);
    expect(result.by_tool_name.StaleEntry).toBeUndefined();
    // The rotated file MUST appear in files_scanned even though its
    // filename stamp pre-dates the window — that's the whole fix.
    expect(result.files_scanned).toContain(rotatedPath);
  });

  it('walks ALL rotated files under --since regardless of filename stamp position', async () => {
    // Multiple rotated segments + a window narrow enough that the
    // pre-0.42.0 logic would have pruned all but one. Confirms the
    // walker now includes every segment so the per-record filter
    // gets to see them.
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    const oldStamps = ['20260101-000000', '20260201-000000', '20260301-000000'];
    for (const stamp of oldStamps) {
      const recordTimestamp = `2026-${stamp.slice(4, 6)}-01T00:00:01.000Z`;
      const r = {
        timestamp: recordTimestamp,
        session_id: 's',
        tool_name: `Old-${stamp}`,
        server_name: 'test',
        tier: 'read',
        status: 'allowed',
        autonomy_level: 'L1',
        duration_ms: 0,
        emission_source: 'other',
        prev_hash: '0'.repeat(64),
        hash: 'c'.repeat(64),
      };
      await fs.writeFile(
        path.join(dir, '.rea', `audit-${stamp}.jsonl`),
        `${JSON.stringify(r)}\n`,
        'utf8',
      );
    }
    // 1h window — none of the rotated records are in-window. Still,
    // every rotated file MUST appear in files_scanned so the operator
    // sees the walker is honest about what it scanned.
    const result = await computeAuditSummary({ baseDir: dir, since: '1h', now });
    expect(result.total_events).toBe(0);
    expect(result.files_scanned.length).toBeGreaterThanOrEqual(oldStamps.length);
    for (const stamp of oldStamps) {
      expect(result.files_scanned).toContain(path.join(dir, '.rea', `audit-${stamp}.jsonl`));
    }
  });

  // Codex round 4 + 5 + 6 P2 (2026-05-16) — convergent fix.
  //
  // Round 4 flagged that requiring every rotated segment to be
  // readable broke `--since 1h` whenever an old backup-restored
  // archive sat in `.rea/`. Round 5 narrowed the soft-skip to a
  // permission-only allow-list (so EIO/EMFILE wouldn't get swallowed).
  // Round 6 caught the deeper unsoundness: because
  // `resolveSummaryFileWalk` enqueues every rotated segment under
  // `--since` (filename-stamp pruning was correctly removed in 0.41.0
  // round-3), we cannot prove an unreadable file is out-of-scope
  // without reading it. A soft-skip therefore silently undercounts
  // in-window records and reports `chain_integrity: ok` on an
  // incomplete scan — exactly the failure mode round 5 already
  // identified for EIO, just generalized.
  //
  // The settled behavior: ANY non-ENOENT read error throws with a
  // precise, actionable remediation message (chmod / move / delete).
  // `unreadable_segments` stays in the public schema but is always
  // empty in 0.42.0 — reserved for a future release that ships
  // per-segment time-range metadata strong enough to prove a
  // skipped file truly cannot contribute in-window records.
  it('codex round 6 P2: throws with an actionable message on EACCES rather than soft-skipping', async () => {
    if (process.getuid?.() === 0) {
      // Root bypasses file mode bits — chmod 000 doesn't restrict.
      return;
    }
    const dir = await setupRepo();
    cleanup.push(dir);
    const rotated = path.join(dir, '.rea', 'audit-20260101-000000.jsonl');
    const record = {
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
    await fs.writeFile(rotated, `${JSON.stringify(record)}\n`, 'utf8');
    await fs.chmod(rotated, 0o000);
    try {
      await emit(dir, { toolName: 'CurrentTool', sessionId: 'sCurrent' });
      await expect(
        computeAuditSummary({ baseDir: dir, since: '1h' }),
      ).rejects.toThrow(/cannot read.*EACCES/);
      // Sanity: also rejects with the actionable remediation text so
      // operators see the chmod / move / delete options.
      await expect(
        computeAuditSummary({ baseDir: dir, since: '1h' }),
      ).rejects.toThrow(/Fix permissions/);
    } finally {
      await fs.chmod(rotated, 0o600).catch(() => undefined);
    }
  });

  // Codex round 5 P2 stays valid under round 6's settled behavior:
  // EIO / EMFILE on any segment throws. (Effectively the same code
  // path as the EACCES test above now, but pinning it separately
  // documents the corruption / resource-exhaustion shape.)
  it('codex round 5 P2: throws on EIO / EMFILE on a rotated segment', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const rotated = path.join(dir, '.rea', 'audit-20260101-000000.jsonl');
    await fs.writeFile(rotated, '');
    await emit(dir, { toolName: 'CurrentTool', sessionId: 's1' });

    for (const errno of ['EIO', 'EMFILE'] as const) {
      const readSpy = vi
        .spyOn(fs, 'readFile')
        .mockImplementation(async (filePath: unknown, ...rest: unknown[]) => {
          if (typeof filePath === 'string' && filePath === rotated) {
            const e = new Error(`mocked ${errno}`) as NodeJS.ErrnoException;
            e.code = errno;
            throw e;
          }
          readSpy.mockRestore();
          try {
            return await fs.readFile(
              filePath as Parameters<typeof fs.readFile>[0],
              ...(rest as []),
            );
          } finally {
            // intentional no-op; spy is restored above
          }
        });
      try {
        await expect(computeAuditSummary({ baseDir: dir })).rejects.toThrow();
      } finally {
        readSpy.mockRestore();
      }
    }
  });

  // Negative control: an IO error on the CURRENT audit.jsonl is
  // still fatal — that file is authoritative for active sessions.
  it('codex round 4 P2: IO error on the current audit.jsonl still throws', async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const dir = await setupRepo();
    cleanup.push(dir);
    const current = path.join(dir, '.rea', 'audit.jsonl');
    await fs.writeFile(current, '');
    await fs.chmod(current, 0o000);
    try {
      await expect(computeAuditSummary({ baseDir: dir })).rejects.toThrow();
    } finally {
      await fs.chmod(current, 0o600).catch(() => undefined);
    }
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
