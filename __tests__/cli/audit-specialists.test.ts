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
