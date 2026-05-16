/**
 * Unit tests for `computeDelegationAdvisory` — focused on the 0.40.0
 * charter item 1 fix: the `& disown` race between
 * `delegation-capture.sh` (which fire-and-forgets `rea hook
 * delegation-signal --detach &` for sub-50ms PreToolUse latency) and
 * the `delegation-advisory.sh` PostToolUse path (which scans the
 * audit chain to decide whether the session has actually delegated).
 *
 * # The race we close
 *
 * Pre-fix, `sessionHasRealDelegation` ran ONE scan of
 * `.rea/audit.jsonl` + rotated segments. If a write-class call landed
 * in the narrow window AFTER the Agent/Skill dispatch but BEFORE the
 * backgrounded audit append committed to disk, the scan saw an empty
 * chain → the advisory fired → `.fired` sentinel was written →
 * silenced every future nudge in the session even though delegation
 * DID happen.
 *
 * Post-fix the function polls with a 50ms / 150ms / 300ms backoff
 * schedule (total ~500ms worst case) before declaring "no delegation".
 * Total budget is acceptable for a PostToolUse hook on
 * `Bash|Edit|Write|MultiEdit|NotebookEdit`.
 *
 * These tests use the `sleepOverride` test seam to drive the schedule
 * deterministically without wall-clocking on 500ms per test.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeDelegationAdvisory,
  DELEGATION_POLL_BACKOFF_MS,
} from './delegation-advisory.js';
import { appendAuditRecord } from '../audit/append.js';
import {
  DELEGATION_SIGNAL_TOOL_NAME,
  DELEGATION_SIGNAL_SERVER_NAME,
  DELEGATION_SIGNAL_SCHEMA_VERSION,
} from '../audit/delegation-event.js';

interface ScratchRepo {
  dir: string;
}

/**
 * Lay down the minimal `.rea/` skeleton `computeDelegationAdvisory`
 * needs: just the directory exists. (The CLI tolerates a missing
 * policy.yaml — that path resolves to `enabled: false`. We pass
 * `policyOverride` instead.)
 */
async function makeRepo(): Promise<ScratchRepo> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-delegadv-')));
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  return { dir };
}

/**
 * Append a `rea.delegation_signal` audit record that counts as a real
 * delegation per `countsAsRealDelegation`. We use `delegation_tool:
 * 'Skill'` — every Skill signal counts, so we never need to also seed
 * a `.claude/agents/<name>.md` roster file. This gives the post-fix
 * scan something concrete to find on its second (or later) read.
 */
async function appendDelegationSignal(
  baseDir: string,
  sessionId: string,
  subagent: string = 'test-skill',
): Promise<void> {
  await appendAuditRecord(baseDir, {
    tool_name: DELEGATION_SIGNAL_TOOL_NAME,
    server_name: DELEGATION_SIGNAL_SERVER_NAME,
    session_id: sessionId,
    metadata: {
      schema_version: DELEGATION_SIGNAL_SCHEMA_VERSION,
      delegation_tool: 'Skill',
      subagent_type: subagent,
      session_id_observed: sessionId,
      parent_subagent_type: null,
      invocation_description_sha256:
        '0'.repeat(64), // valid hex sha256 length, content unused by reader
    } as unknown as Record<string, unknown>,
  });
}

/**
 * Build a hook stdin payload that mirrors what Claude Code's
 * PostToolUse runtime feeds the shim for a write-class tool call.
 */
function makePayload(sessionId: string, toolName: string = 'Bash'): string {
  return JSON.stringify({ tool_name: toolName, session_id: sessionId });
}

/** Default test policy: enabled, threshold 1 so we hit the audit scan immediately. */
function policy(threshold = 1) {
  return {
    enabled: true,
    threshold,
    exemptSubagents: ['general-purpose', 'Explore', 'Plan'],
  };
}

describe('computeDelegationAdvisory — 0.40.0 race: poll-and-backoff before firing', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const dir of cleanup.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('exports the canonical backoff schedule [50, 150, 300] ms', () => {
    // The schedule is part of the public contract — the test asserts
    // on the documented worst-case 500ms budget so any future
    // change has to update the docstring AND this test together.
    expect([...DELEGATION_POLL_BACKOFF_MS]).toEqual([50, 150, 300]);
    const total = DELEGATION_POLL_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBe(500);
  });

  it('fires on the FIRST scan when the audit chain is empty (no race to lose)', async () => {
    // Baseline: no producer ever appends a delegation signal. The
    // poll-and-backoff loop still runs to completion, then fires.
    // We verify by spying on the sleep schedule — it should match
    // the exported DELEGATION_POLL_BACKOFF_MS exactly.
    const repo = await makeRepo();
    cleanup.push(repo.dir);
    const sleeps: number[] = [];
    const result = await computeDelegationAdvisory({
      reaRoot: repo.dir,
      policyOverride: policy(1),
      stdinOverride: makePayload('session-empty'),
      sleepOverride: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.outcome).toBe('ran');
    expect(result.fired).toBe(true);
    // First scan is immediate; subsequent retries pay the schedule.
    expect(sleeps).toEqual([50, 150, 300]);
  });

  it('does NOT fire when the delegation signal IS present on the first scan (zero retries)', async () => {
    // Happy path: producer already wrote the signal before this
    // PostToolUse fired. The poll loop short-circuits on the very
    // first scan — zero sleeps are paid.
    const repo = await makeRepo();
    cleanup.push(repo.dir);
    await appendDelegationSignal(repo.dir, 'session-fast');
    const sleeps: number[] = [];
    const result = await computeDelegationAdvisory({
      reaRoot: repo.dir,
      policyOverride: policy(1),
      stdinOverride: makePayload('session-fast'),
      sleepOverride: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.outcome).toBe('ran');
    expect(result.fired).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it('does NOT fire when the signal lands during the FIRST backoff window', async () => {
    // Race shape: producer is still backgrounded when the first
    // scan runs (signal missing), but the audit append commits
    // during the first 50ms sleep. The second scan finds it. No
    // spurious nudge, no `.fired` sentinel.
    const repo = await makeRepo();
    cleanup.push(repo.dir);
    const sleeps: number[] = [];
    const result = await computeDelegationAdvisory({
      reaRoot: repo.dir,
      policyOverride: policy(1),
      stdinOverride: makePayload('session-race-1'),
      sleepOverride: async (ms) => {
        sleeps.push(ms);
        // During the first sleep, the producer's audit append commits.
        if (sleeps.length === 1) {
          await appendDelegationSignal(repo.dir, 'session-race-1');
        }
      },
    });
    expect(result.outcome).toBe('ran');
    expect(result.fired).toBe(false);
    // Exactly one sleep was paid — the loop found the signal on its
    // SECOND scan (after the first 50ms backoff) and returned.
    expect(sleeps).toEqual([50]);
  });

  it('does NOT fire when the signal lands during the SECOND backoff window', async () => {
    // Slightly slower race: producer commits only after two scans
    // have seen an empty chain. Verifies the loop keeps polling
    // through the schedule, not bailing after one retry.
    const repo = await makeRepo();
    cleanup.push(repo.dir);
    const sleeps: number[] = [];
    const result = await computeDelegationAdvisory({
      reaRoot: repo.dir,
      policyOverride: policy(1),
      stdinOverride: makePayload('session-race-2'),
      sleepOverride: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) {
          await appendDelegationSignal(repo.dir, 'session-race-2');
        }
      },
    });
    expect(result.outcome).toBe('ran');
    expect(result.fired).toBe(false);
    expect(sleeps).toEqual([50, 150]);
  });

  it('does NOT fire when the signal lands during the FINAL backoff window', async () => {
    // The tightest race we cover: producer's audit append commits
    // only after the third retry's sleep elapses. The fourth scan
    // (after 50+150+300 = 500ms) finds it. Still no spurious nudge.
    const repo = await makeRepo();
    cleanup.push(repo.dir);
    const sleeps: number[] = [];
    const result = await computeDelegationAdvisory({
      reaRoot: repo.dir,
      policyOverride: policy(1),
      stdinOverride: makePayload('session-race-3'),
      sleepOverride: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) {
          await appendDelegationSignal(repo.dir, 'session-race-3');
        }
      },
    });
    expect(result.outcome).toBe('ran');
    expect(result.fired).toBe(false);
    expect(sleeps).toEqual([50, 150, 300]);
  });

  it('FIRES (correctly) when the signal never lands within the 500ms budget', async () => {
    // Genuinely-undelegated session: even after the full backoff
    // schedule, no signal appears. The nudge is warranted. This
    // also pins the at-most-once contract — a follow-up
    // invocation in the same session should see the `.fired`
    // sentinel and stay silent without re-running the poll loop.
    const repo = await makeRepo();
    cleanup.push(repo.dir);
    const sleeps: number[] = [];
    const first = await computeDelegationAdvisory({
      reaRoot: repo.dir,
      policyOverride: policy(1),
      stdinOverride: makePayload('session-truly-none'),
      sleepOverride: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(first.outcome).toBe('ran');
    expect(first.fired).toBe(true);
    expect(sleeps).toEqual([50, 150, 300]);

    // Follow-up call: at-most-once contract — `.fired` sentinel
    // is present so the function returns early without sleeping.
    const sleepsSecond: number[] = [];
    const second = await computeDelegationAdvisory({
      reaRoot: repo.dir,
      policyOverride: policy(1),
      stdinOverride: makePayload('session-truly-none'),
      sleepOverride: async (ms) => {
        sleepsSecond.push(ms);
      },
    });
    expect(second.outcome).toBe('ran');
    expect(second.fired).toBe(false);
    expect(sleepsSecond).toEqual([]);
  });

  it('threads sessionId correctly — a signal under a DIFFERENT session does NOT silence the nudge', async () => {
    // Defense check: the poll loop must filter by session_id_observed.
    // A signal under session-A must NOT count as a delegation for
    // session-B's predicate. Pre-fix this was already correct (the
    // reader does the filter); we pin it here so a future refactor
    // that "improves" the loop doesn't accidentally widen the scope.
    const repo = await makeRepo();
    cleanup.push(repo.dir);
    await appendDelegationSignal(repo.dir, 'session-OTHER');
    const sleeps: number[] = [];
    const result = await computeDelegationAdvisory({
      reaRoot: repo.dir,
      policyOverride: policy(1),
      stdinOverride: makePayload('session-MINE'),
      sleepOverride: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.outcome).toBe('ran');
    expect(result.fired).toBe(true);
    // Full schedule was paid — the other session's signal does
    // not count.
    expect(sleeps).toEqual([50, 150, 300]);
  });
});
