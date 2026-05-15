/**
 * Tests for `rea audit specialists` (0.29.0).
 *
 * The reader CLI walks `.rea/audit.jsonl`, filters records by
 * `tool_name === 'rea.delegation_signal'`, groups by
 * `metadata.subagent_type`, and renders a table (default) or JSON
 * (`--json`).
 *
 * v1 ships with NO `--since` / `--session` flags. Filtering uses
 * `process.env.CLAUDE_SESSION_ID` (env-derived) or `sessionFilter`
 * (test-only seam). Records outside the active session are dropped.
 *
 * Note on the test-only `sessionFilter` seam: the public CLI flow
 * (`runAuditSpecialists` → `computeAuditSpecialists`) reads
 * `process.env.CLAUDE_SESSION_ID` to decide. Tests pass `sessionFilter`
 * directly so we don't have to mutate `process.env` and risk leaking
 * state across vitest workers.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeAuditSpecialists,
  groupBySubagent,
  resolveAuditFileWalk,
  listRotatedAuditFiles,
  AuditSpecialistsSinceError,
} from '../../src/cli/audit-specialists.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../src/audit/append.js';
import {
  DELEGATION_SIGNAL_TOOL_NAME,
  DELEGATION_SIGNAL_SERVER_NAME,
  DELEGATION_SIGNAL_SCHEMA_VERSION,
  type DelegationSignalMetadata,
  type DelegationTool,
} from '../../src/audit/delegation-event.js';

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function setupRepo(): Promise<string> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-specialists-')),
  );
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  return dir;
}

async function emit(
  baseDir: string,
  args: {
    subagent: string;
    sessionId: string;
    tool?: DelegationTool;
    parent?: string | null;
  },
): Promise<void> {
  const m: DelegationSignalMetadata = {
    schema_version: DELEGATION_SIGNAL_SCHEMA_VERSION,
    delegation_tool: args.tool ?? 'Agent',
    subagent_type: args.subagent,
    session_id_observed: args.sessionId,
    parent_subagent_type: args.parent ?? null,
    invocation_description_sha256: EMPTY_HASH,
  };
  await appendAuditRecord(baseDir, {
    tool_name: DELEGATION_SIGNAL_TOOL_NAME,
    server_name: DELEGATION_SIGNAL_SERVER_NAME,
    tier: Tier.Read,
    status: InvocationStatus.Allowed,
    session_id: args.sessionId,
    metadata: m as unknown as Record<string, unknown>,
  });
}

describe('groupBySubagent — pure aggregation', () => {
  it('produces empty list on empty input', () => {
    expect(groupBySubagent([])).toEqual([]);
  });

  it('groups records by subagent_type and counts agent/skill separately', () => {
    const ts = new Date('2026-05-12T20:00:00Z').toISOString();
    const groups = groupBySubagent([
      {
        timestamp: ts,
        session_id_observed: 's',
        delegation_tool: 'Agent',
        subagent_type: 'a',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      },
      {
        timestamp: ts,
        session_id_observed: 's',
        delegation_tool: 'Agent',
        subagent_type: 'a',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      },
      {
        timestamp: ts,
        session_id_observed: 's',
        delegation_tool: 'Skill',
        subagent_type: 'b',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      },
    ]);
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.subagent_type === 'a')!;
    const b = groups.find((g) => g.subagent_type === 'b')!;
    expect(a.count).toBe(2);
    expect(a.by_tool.Agent).toBe(2);
    expect(a.by_tool.Skill).toBe(0);
    expect(b.count).toBe(1);
    expect(b.by_tool.Skill).toBe(1);
  });

  it('sorts by descending count then alphabetical on tie', () => {
    const ts = new Date('2026-05-12T20:00:00Z').toISOString();
    const groups = groupBySubagent([
      {
        timestamp: ts,
        session_id_observed: 's',
        delegation_tool: 'Agent',
        subagent_type: 'zebra',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      },
      {
        timestamp: ts,
        session_id_observed: 's',
        delegation_tool: 'Agent',
        subagent_type: 'alpha',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      },
      {
        timestamp: ts,
        session_id_observed: 's',
        delegation_tool: 'Agent',
        subagent_type: 'beta',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      },
      {
        timestamp: ts,
        session_id_observed: 's',
        delegation_tool: 'Agent',
        subagent_type: 'beta',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      },
    ]);
    expect(groups.map((g) => g.subagent_type)).toEqual(['beta', 'alpha', 'zebra']);
  });
});

describe('computeAuditSpecialists — current-session filtering', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns empty groups when audit log is missing', async () => {
    const r = await computeAuditSpecialists({ baseDir: dir, sessionFilter: null });
    expect(r.groups).toEqual([]);
    expect(r.records).toEqual([]);
    expect(r.files_scanned).toEqual([]);
  });

  it('ignores non-delegation records in the chain', async () => {
    await appendAuditRecord(dir, {
      tool_name: 'rea.local_review',
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: { unrelated: true },
    });
    await emit(dir, { subagent: 'agent-a', sessionId: 's1' });
    const r = await computeAuditSpecialists({ baseDir: dir, sessionFilter: null });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.subagent_type).toBe('agent-a');
  });

  it('filters to records matching the supplied session_id_observed', async () => {
    await emit(dir, { subagent: 'agent-a', sessionId: 'session-current' });
    await emit(dir, { subagent: 'agent-b', sessionId: 'session-current' });
    await emit(dir, { subagent: 'agent-x', sessionId: 'session-old' });
    const r = await computeAuditSpecialists({
      baseDir: dir,
      sessionFilter: 'session-current',
    });
    expect(r.session_filter).toBe('session-current');
    expect(r.session_filter_source).toBe('option');
    expect(r.records).toHaveLength(2);
    const names = r.groups.map((g) => g.subagent_type).sort();
    expect(names).toEqual(['agent-a', 'agent-b']);
  });

  it('returns ALL records when sessionFilter is null (no filter)', async () => {
    await emit(dir, { subagent: 'agent-a', sessionId: 's1' });
    await emit(dir, { subagent: 'agent-b', sessionId: 's2' });
    const r = await computeAuditSpecialists({ baseDir: dir, sessionFilter: null });
    expect(r.records).toHaveLength(2);
    expect(r.session_filter).toBeNull();
    expect(r.session_filter_source).toBe('none');
  });

  it('emits a stable rollup ordering across multiple delegation tools', async () => {
    await emit(dir, { subagent: 'rea-orchestrator', sessionId: 's', tool: 'Agent' });
    await emit(dir, { subagent: 'rea-orchestrator', sessionId: 's', tool: 'Agent' });
    await emit(dir, { subagent: 'deep-dive', sessionId: 's', tool: 'Skill' });
    const r = await computeAuditSpecialists({ baseDir: dir, sessionFilter: null });
    expect(r.groups[0]!.subagent_type).toBe('rea-orchestrator');
    expect(r.groups[0]!.count).toBe(2);
    expect(r.groups[1]!.subagent_type).toBe('deep-dive');
    expect(r.groups[1]!.by_tool.Skill).toBe(1);
  });

  it('reports files_scanned with the audit file when present', async () => {
    await emit(dir, { subagent: 'agent-a', sessionId: 's' });
    const r = await computeAuditSpecialists({ baseDir: dir, sessionFilter: null });
    expect(r.files_scanned).toHaveLength(1);
    expect(r.files_scanned[0]).toContain('audit.jsonl');
  });
});

describe('computeAuditSpecialists — env-derived session filter', () => {
  let dir: string;
  let savedSession: string | undefined;
  beforeEach(async () => {
    dir = await setupRepo();
    savedSession = process.env['CLAUDE_SESSION_ID'];
  });
  afterEach(async () => {
    if (savedSession === undefined) {
      delete process.env['CLAUDE_SESSION_ID'];
    } else {
      process.env['CLAUDE_SESSION_ID'] = savedSession;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('uses $CLAUDE_SESSION_ID when option is omitted', async () => {
    process.env['CLAUDE_SESSION_ID'] = 'env-session';
    await emit(dir, { subagent: 'agent-a', sessionId: 'env-session' });
    await emit(dir, { subagent: 'agent-x', sessionId: 'other-session' });
    const r = await computeAuditSpecialists({ baseDir: dir });
    expect(r.session_filter).toBe('env-session');
    expect(r.session_filter_source).toBe('env');
    expect(r.records).toHaveLength(1);
  });

  it('falls back to no-filter when env is absent', async () => {
    delete process.env['CLAUDE_SESSION_ID'];
    await emit(dir, { subagent: 'agent-a', sessionId: 's1' });
    await emit(dir, { subagent: 'agent-b', sessionId: 's2' });
    const r = await computeAuditSpecialists({ baseDir: dir });
    expect(r.session_filter).toBeNull();
    expect(r.session_filter_source).toBe('none');
    expect(r.records).toHaveLength(2);
  });
});

// ── 0.31.0 — `--session` flag ───────────────────────────────────────
describe('computeAuditSpecialists — --session flag (0.31.0)', () => {
  let dir: string;
  let savedSession: string | undefined;
  beforeEach(async () => {
    dir = await setupRepo();
    savedSession = process.env['CLAUDE_SESSION_ID'];
  });
  afterEach(async () => {
    if (savedSession === undefined) delete process.env['CLAUDE_SESSION_ID'];
    else process.env['CLAUDE_SESSION_ID'] = savedSession;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('--session <id> filters to that session, source = option', async () => {
    await emit(dir, { subagent: 'agent-a', sessionId: 'flag-session' });
    await emit(dir, { subagent: 'agent-x', sessionId: 'other' });
    const r = await computeAuditSpecialists({ baseDir: dir, sessionOption: 'flag-session' });
    expect(r.session_filter).toBe('flag-session');
    expect(r.session_filter_source).toBe('option');
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.subagent_type).toBe('agent-a');
  });

  it('--session all disables filtering (shows every session), source = none', async () => {
    await emit(dir, { subagent: 'agent-a', sessionId: 's1' });
    await emit(dir, { subagent: 'agent-b', sessionId: 's2' });
    const r = await computeAuditSpecialists({ baseDir: dir, sessionOption: 'all' });
    expect(r.session_filter).toBeNull();
    expect(r.session_filter_source).toBe('none');
    expect(r.records).toHaveLength(2);
  });

  it('--session ALL is case-insensitive', async () => {
    await emit(dir, { subagent: 'agent-a', sessionId: 's1' });
    await emit(dir, { subagent: 'agent-b', sessionId: 's2' });
    const r = await computeAuditSpecialists({ baseDir: dir, sessionOption: 'ALL' });
    expect(r.session_filter).toBeNull();
    expect(r.records).toHaveLength(2);
  });

  it('--session wins over $CLAUDE_SESSION_ID when both are set', async () => {
    process.env['CLAUDE_SESSION_ID'] = 'env-session';
    await emit(dir, { subagent: 'agent-a', sessionId: 'env-session' });
    await emit(dir, { subagent: 'agent-b', sessionId: 'flag-session' });
    const r = await computeAuditSpecialists({ baseDir: dir, sessionOption: 'flag-session' });
    expect(r.session_filter).toBe('flag-session');
    expect(r.session_filter_source).toBe('option');
    expect(r.records.map((x) => x.subagent_type)).toEqual(['agent-b']);
  });

  it('the test-only sessionFilter seam still wins over sessionOption', async () => {
    // Tests inject `sessionFilter` directly; it must take precedence so
    // existing tests keep their semantics.
    await emit(dir, { subagent: 'agent-a', sessionId: 'seam' });
    await emit(dir, { subagent: 'agent-b', sessionId: 'flag' });
    const r = await computeAuditSpecialists({
      baseDir: dir,
      sessionFilter: 'seam',
      sessionOption: 'flag',
    });
    expect(r.session_filter).toBe('seam');
    expect(r.records.map((x) => x.subagent_type)).toEqual(['agent-a']);
  });

  it('falls through to $CLAUDE_SESSION_ID when --session is omitted', async () => {
    process.env['CLAUDE_SESSION_ID'] = 'env-session';
    await emit(dir, { subagent: 'agent-a', sessionId: 'env-session' });
    await emit(dir, { subagent: 'agent-x', sessionId: 'other' });
    const r = await computeAuditSpecialists({ baseDir: dir });
    expect(r.session_filter).toBe('env-session');
    expect(r.session_filter_source).toBe('env');
  });
});

// ── 0.31.0 — `--since` rotated-file walk ────────────────────────────
describe('resolveAuditFileWalk — --since rotated-file resolution (0.31.0)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('walks only the current audit.jsonl when --since is omitted', async () => {
    await fs.writeFile(path.join(dir, '.rea', 'audit.jsonl'), '{}\n');
    const files = await resolveAuditFileWalk(dir, undefined);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('audit.jsonl');
    expect(files[0]).not.toMatch(/audit-\d{8}/);
  });

  it('returns an empty list when neither rotated nor current files exist', async () => {
    const files = await resolveAuditFileWalk(dir, undefined);
    expect(files).toEqual([]);
  });

  it('throws AuditSpecialistsSinceError for a non-rotated --since name', async () => {
    await expect(resolveAuditFileWalk(dir, 'not-an-audit-file.jsonl')).rejects.toBeInstanceOf(
      AuditSpecialistsSinceError,
    );
  });

  it('throws AuditSpecialistsSinceError when the named rotated file does not exist', async () => {
    await expect(
      resolveAuditFileWalk(dir, 'audit-20260101-000000.jsonl'),
    ).rejects.toBeInstanceOf(AuditSpecialistsSinceError);
  });

  it('walks the named rotated file + every later rotated file + the current audit.jsonl', async () => {
    const reaDir = path.join(dir, '.rea');
    // Three rotated files + the current one.
    await fs.writeFile(path.join(reaDir, 'audit-20260101-000000.jsonl'), '{}\n');
    await fs.writeFile(path.join(reaDir, 'audit-20260102-000000.jsonl'), '{}\n');
    await fs.writeFile(path.join(reaDir, 'audit-20260103-000000.jsonl'), '{}\n');
    await fs.writeFile(path.join(reaDir, 'audit.jsonl'), '{}\n');
    // --since the MIDDLE rotated file: expect [02, 03, current].
    const files = await resolveAuditFileWalk(dir, 'audit-20260102-000000.jsonl');
    expect(files).toHaveLength(3);
    expect(files[0]).toContain('audit-20260102-000000.jsonl');
    expect(files[1]).toContain('audit-20260103-000000.jsonl');
    expect(files[2]).toMatch(/audit\.jsonl$/);
  });
});

// ── round-2 P3 — rotated-file ordering with two-digit collision suffixes ──
describe('listRotatedAuditFiles — numeric sort of intra-second suffixes (round-2 P3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('orders two-digit `-N` collision suffixes numerically, not lexically', async () => {
    const reaDir = path.join(dir, '.rea');
    // 12 rotations in the same second. A plain lexical sort puts
    // `-10`, `-11`, `-12` BEFORE `-2` — the bug. The base file
    // (no `-N`) is the first rotation, so it must sort first.
    const created = [
      'audit-20260101-000000.jsonl',
      'audit-20260101-000000-1.jsonl',
      'audit-20260101-000000-2.jsonl',
      'audit-20260101-000000-9.jsonl',
      'audit-20260101-000000-10.jsonl',
      'audit-20260101-000000-11.jsonl',
      'audit-20260101-000000-12.jsonl',
    ];
    // Write them in shuffled order to prove the sort, not insertion, wins.
    for (const name of [...created].reverse()) {
      await fs.writeFile(path.join(reaDir, name), '{}\n');
    }
    const listed = await listRotatedAuditFiles(reaDir);
    expect(listed).toEqual(created);
  });

  it('resolveAuditFileWalk slices from the correct index with two-digit suffixes', async () => {
    const reaDir = path.join(dir, '.rea');
    for (const name of [
      'audit-20260101-000000.jsonl',
      'audit-20260101-000000-1.jsonl',
      'audit-20260101-000000-2.jsonl',
      'audit-20260101-000000-10.jsonl',
    ]) {
      await fs.writeFile(path.join(reaDir, name), '{}\n');
    }
    await fs.writeFile(path.join(reaDir, 'audit.jsonl'), '{}\n');
    // --since the `-2` file: numerically that is index 2, so the walk
    // must include `-2`, `-10`, and the current audit.jsonl. A lexical
    // sort would have placed `-10` BEFORE `-2` and dropped it here.
    const files = await resolveAuditFileWalk(dir, 'audit-20260101-000000-2.jsonl');
    expect(files).toHaveLength(3);
    expect(files[0]).toContain('audit-20260101-000000-2.jsonl');
    expect(files[1]).toContain('audit-20260101-000000-10.jsonl');
    expect(files[2]).toMatch(/audit\.jsonl$/);
  });

  it('sorts across distinct timestamps ahead of the suffix tie-break', async () => {
    const reaDir = path.join(dir, '.rea');
    const created = [
      'audit-20260101-000000-10.jsonl',
      'audit-20260101-000001.jsonl',
      'audit-20260102-000000.jsonl',
    ];
    for (const name of [...created].reverse()) {
      await fs.writeFile(path.join(reaDir, name), '{}\n');
    }
    const listed = await listRotatedAuditFiles(reaDir);
    // Distinct YYYYMMDD-HHMMSS stamps sort chronologically; the `-N`
    // suffix only breaks ties WITHIN one stamp.
    expect(listed).toEqual(created);
  });
});

describe('computeAuditSpecialists — --since walks rotated files (0.31.0)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('aggregates delegation records across a rotated file and the current chain', async () => {
    const reaDir = path.join(dir, '.rea');
    // Hand-craft a rotated file holding one delegation record. The
    // exact envelope shape only needs the fields the reader parses.
    const rotatedRecord = {
      timestamp: '2026-05-01T00:00:00.000Z',
      tool_name: DELEGATION_SIGNAL_TOOL_NAME,
      server_name: DELEGATION_SIGNAL_SERVER_NAME,
      metadata: {
        schema_version: DELEGATION_SIGNAL_SCHEMA_VERSION,
        delegation_tool: 'Agent',
        subagent_type: 'rotated-agent',
        session_id_observed: 's-rotated',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      },
    };
    await fs.writeFile(
      path.join(reaDir, 'audit-20260501-000000.jsonl'),
      JSON.stringify(rotatedRecord) + '\n',
    );
    // The current chain holds a fresh record via the real append path.
    await emit(dir, { subagent: 'current-agent', sessionId: 's-current' });

    // Without --since: only the current record.
    const noSince = await computeAuditSpecialists({ baseDir: dir, sessionFilter: null });
    expect(noSince.records.map((r) => r.subagent_type)).toEqual(['current-agent']);

    // With --since: both the rotated and current records.
    const withSince = await computeAuditSpecialists({
      baseDir: dir,
      sessionFilter: null,
      since: 'audit-20260501-000000.jsonl',
    });
    const names = withSince.records.map((r) => r.subagent_type).sort();
    expect(names).toEqual(['current-agent', 'rotated-agent']);
    // files_scanned reflects the multi-file walk.
    expect(withSince.files_scanned).toHaveLength(2);
  });

  it('--since composes with --session filtering', async () => {
    const reaDir = path.join(dir, '.rea');
    const mk = (subagent: string, session: string, ts: string): string =>
      JSON.stringify({
        timestamp: ts,
        tool_name: DELEGATION_SIGNAL_TOOL_NAME,
        server_name: DELEGATION_SIGNAL_SERVER_NAME,
        metadata: {
          schema_version: DELEGATION_SIGNAL_SCHEMA_VERSION,
          delegation_tool: 'Agent',
          subagent_type: subagent,
          session_id_observed: session,
          parent_subagent_type: null,
          invocation_description_sha256: EMPTY_HASH,
        },
      }) + '\n';
    await fs.writeFile(
      path.join(reaDir, 'audit-20260501-000000.jsonl'),
      mk('old-keep', 'target', '2026-05-01T00:00:00Z') +
        mk('old-drop', 'other', '2026-05-01T00:01:00Z'),
    );
    await emit(dir, { subagent: 'new-keep', sessionId: 'target' });
    await emit(dir, { subagent: 'new-drop', sessionId: 'other' });
    const r = await computeAuditSpecialists({
      baseDir: dir,
      sessionOption: 'target',
      since: 'audit-20260501-000000.jsonl',
    });
    const names = r.records.map((x) => x.subagent_type).sort();
    expect(names).toEqual(['new-keep', 'old-keep']);
  });
});
