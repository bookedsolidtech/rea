/**
 * Tests for `src/cli/delegation-advisory.ts` (0.31.0) — the
 * delegation-nudge CLI logic behind `rea hook delegation-advisory`.
 *
 * `computeDelegationAdvisory` is the pure-ish core: it reads policy,
 * bumps a per-session counter, scans the audit log for real delegation
 * signals once the threshold is crossed, and fires a one-time stderr
 * advisory. All filesystem I/O is sandboxed in a tempdir; the policy
 * and stdin are injected through test seams so the tests never spawn
 * a process or mutate `process.env`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeDelegationAdvisory,
  sessionStateKey,
  advisoryMessage,
} from '../../src/cli/delegation-advisory.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../src/audit/append.js';
import {
  DELEGATION_SIGNAL_TOOL_NAME,
  DELEGATION_SIGNAL_SERVER_NAME,
  DELEGATION_SIGNAL_SCHEMA_VERSION,
  type DelegationSignalMetadata,
  type DelegationTool,
} from '../../src/audit/delegation-event.js';

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function mkTempBase(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-deleg-adv-')));
  fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
  return dir;
}

/** Emit a `rea.delegation_signal` audit record into the tempdir's chain. */
async function emitSignal(
  baseDir: string,
  args: { subagent: string; sessionId: string; tool?: DelegationTool },
): Promise<void> {
  const m: DelegationSignalMetadata = {
    schema_version: DELEGATION_SIGNAL_SCHEMA_VERSION,
    delegation_tool: args.tool ?? 'Agent',
    subagent_type: args.subagent,
    session_id_observed: args.sessionId,
    parent_subagent_type: null,
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

function writeAgent(baseDir: string, name: string): void {
  const agentsDir = path.join(baseDir, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, name), '# agent\n');
}

const ENABLED_POLICY = {
  enabled: true,
  threshold: 3,
  exemptSubagents: ['general-purpose', 'Explore', 'Plan'] as readonly string[],
};

function payload(sessionId: string, toolName = 'Write'): string {
  return JSON.stringify({ tool_name: toolName, session_id: sessionId });
}

describe('sessionStateKey', () => {
  // The `-<16-hex>` hash suffix shape, anchored to end-of-string.
  const HASH_SUFFIX = /-[0-9a-f]{16}$/;

  it('a clean id keeps a readable prefix and gains a hash suffix', () => {
    const key = sessionStateKey('sess-abc_123.4');
    expect(key).toMatch(/^sess-abc_123\.4-[0-9a-f]{16}$/);
  });

  it('replaces unsafe characters in the readable prefix', () => {
    const key = sessionStateKey('a/b\\c:d e');
    expect(key).toMatch(/^a_b_c_d_e-[0-9a-f]{16}$/);
  });

  it('collapses empty / non-string to the literal `unknown` (no hash)', () => {
    expect(sessionStateKey('')).toBe('unknown');
    expect(sessionStateKey(undefined)).toBe('unknown');
    expect(sessionStateKey(42)).toBe('unknown');
  });

  it('is COLLISION-FREE for ids that sanitize to the same prefix (round-3 P2)', () => {
    // `a/b` and `a:b` both sanitize to the readable prefix `a_b` — the
    // pre-fix bug shared `a_b.count` / `a_b.fired` between them. The
    // sha256 suffix is computed over the RAW id, so the full keys differ.
    const keyA = sessionStateKey('a/b');
    const keyB = sessionStateKey('a:b');
    expect(keyA).not.toBe(keyB);
    // Both still carry the same readable prefix...
    expect(keyA.startsWith('a_b-')).toBe(true);
    expect(keyB.startsWith('a_b-')).toBe(true);
    // ...but the hash halves diverge.
    expect(keyA).toMatch(HASH_SUFFIX);
    expect(keyB).toMatch(HASH_SUFFIX);
  });

  it('is deterministic — the same raw id always yields the same key', () => {
    expect(sessionStateKey('repeatable-id')).toBe(sessionStateKey('repeatable-id'));
  });

  it('neutralizes path-traversal basenames in the readable prefix', () => {
    // `.` / `..` would make the basename start with a traversal token;
    // the prefix is normalized to `session` while the hash still keeps
    // the keys distinct and unique.
    expect(sessionStateKey('.')).toMatch(/^session-[0-9a-f]{16}$/);
    expect(sessionStateKey('..')).toMatch(/^session-[0-9a-f]{16}$/);
    expect(sessionStateKey('.')).not.toBe(sessionStateKey('..'));
    // A traversal ATTEMPT with slashes: every slash becomes `_`, so the
    // prefix can never escape the state dir, and the key is a single
    // safe path segment.
    const key = sessionStateKey('../../etc/passwd');
    expect(key).toMatch(/^\.\._\.\._etc_passwd-[0-9a-f]{16}$/);
    expect(key.includes('/')).toBe(false);
  });

  it('caps the readable prefix at 64 characters (hash suffix excluded)', () => {
    const long = 'x'.repeat(500);
    const key = sessionStateKey(long);
    // `<64-char prefix>` + `-` + `<16-char hash>` = 81.
    expect(key).toHaveLength(64 + 1 + 16);
    expect(key.slice(0, 64)).toBe('x'.repeat(64));
  });
});

describe('advisoryMessage', () => {
  it('names the count, the threshold, and the off-switch', () => {
    const msg = advisoryMessage(25, 25);
    expect(msg).toContain('25 write-class tool calls');
    expect(msg).toContain('threshold of 25');
    expect(msg).toContain('policy.delegation_advisory.enabled: false');
    expect(msg).toContain('advisory only');
  });
});

describe('computeDelegationAdvisory — policy gating', () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkTempBase();
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('outcome=disabled when policy.delegation_advisory is off', async () => {
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: { enabled: false, threshold: 3, exemptSubagents: [] },
      stdinOverride: payload('s1'),
    });
    expect(r.outcome).toBe('disabled');
    // No state directory created when disabled.
    expect(fs.existsSync(path.join(baseDir, '.rea', '.delegation-advisory'))).toBe(false);
  });

  it('outcome=halt when .rea/HALT exists (kill-switch wins)', async () => {
    fs.writeFileSync(path.join(baseDir, '.rea', 'HALT'), 'frozen\n');
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(r.outcome).toBe('halt');
  });

  it('outcome=no-payload when stdin is empty', async () => {
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: '',
    });
    expect(r.outcome).toBe('no-payload');
  });

  it('outcome=no-payload when stdin is malformed JSON', async () => {
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: '{not json',
    });
    expect(r.outcome).toBe('no-payload');
  });
});

describe('computeDelegationAdvisory — the per-session counter', () => {
  let baseDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    baseDir = mkTempBase();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('increments the counter on each invocation', async () => {
    const r1 = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(r1.count).toBe(1);
    expect(r1.fired).toBe(false);
    const r2 = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(r2.count).toBe(2);
    expect(r2.fired).toBe(false);
  });

  it('keeps separate counters per session id', async () => {
    await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('session-A'),
    });
    await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('session-A'),
    });
    const rB = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('session-B'),
    });
    // session-B's first call — counter is 1, independent of session-A.
    expect(rB.count).toBe(1);
  });

  it('does NOT scan the audit log or fire below the threshold', async () => {
    // threshold is 3 — calls 1 and 2 must not fire.
    for (let i = 1; i <= 2; i += 1) {
      const r = await computeDelegationAdvisory({
        reaRoot: baseDir,
        policyOverride: ENABLED_POLICY,
        stdinOverride: payload('s1'),
      });
      expect(r.fired).toBe(false);
    }
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('computeDelegationAdvisory — firing at the threshold', () => {
  let baseDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    baseDir = mkTempBase();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  async function bump(sessionId: string, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await computeDelegationAdvisory({
        reaRoot: baseDir,
        policyOverride: ENABLED_POLICY,
        stdinOverride: payload(sessionId),
      });
    }
  }

  it('fires exactly once at the threshold when the session never delegated', async () => {
    await bump('s1', 2); // counter = 2, below threshold 3
    const atThreshold = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(atThreshold.count).toBe(3);
    expect(atThreshold.fired).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
    // The `.fired` sentinel was written under the computed state key
    // (`sessionStateKey('s1')` — readable prefix + hash suffix).
    expect(
      fs.existsSync(
        path.join(
          baseDir,
          '.rea',
          '.delegation-advisory',
          `${sessionStateKey('s1')}.fired`,
        ),
      ),
    ).toBe(true);

    // A 4th call (past threshold) must NOT fire again — at-most-once.
    stderrSpy.mockClear();
    const past = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(past.count).toBe(4);
    expect(past.fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire when the session delegated to a curated specialist (Agent)', async () => {
    // Roster contains rea-orchestrator; the session delegated to it.
    writeAgent(baseDir, 'rea-orchestrator.md');
    await emitSignal(baseDir, { subagent: 'rea-orchestrator', sessionId: 's1', tool: 'Agent' });
    await bump('s1', 2);
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(r.count).toBe(3);
    expect(r.fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
    // No `.fired` sentinel — the predicate may need re-evaluation later.
    expect(
      fs.existsSync(
        path.join(
          baseDir,
          '.rea',
          '.delegation-advisory',
          `${sessionStateKey('s1')}.fired`,
        ),
      ),
    ).toBe(false);
  });

  it('does NOT fire when the session invoked a Skill', async () => {
    // Skill signals always count as real delegation — no roster needed.
    await emitSignal(baseDir, { subagent: 'deep-dive', sessionId: 's1', tool: 'Skill' });
    await bump('s1', 2);
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(r.fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('STILL fires when the session only delegated to an exempt built-in helper', async () => {
    // A delegation to `general-purpose` is NOT a real specialist
    // delegation — the nudge should still fire.
    writeAgent(baseDir, 'rea-orchestrator.md');
    await emitSignal(baseDir, { subagent: 'general-purpose', sessionId: 's1', tool: 'Agent' });
    await bump('s1', 2);
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(r.fired).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('re-evaluates the predicate each call past threshold when not yet fired', async () => {
    // The session has NOT delegated. Reach threshold — fires once.
    await bump('s1', 2);
    const firstAtThreshold = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(firstAtThreshold.fired).toBe(true);
  });

  it('only counts a delegation signal from the SAME session', async () => {
    // A real delegation in a DIFFERENT session must not suppress the
    // nudge for this session.
    writeAgent(baseDir, 'rea-orchestrator.md');
    await emitSignal(baseDir, {
      subagent: 'rea-orchestrator',
      sessionId: 'other-session',
      tool: 'Agent',
    });
    await bump('s1', 2);
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(r.fired).toBe(true);
  });
});

describe('computeDelegationAdvisory — raw session id audit matching (round-2 P3)', () => {
  // Regression pin: the audit-log query MUST use the RAW session id, not
  // the sanitized filesystem form. `delegation-capture.sh` records the
  // untrusted `session_id` verbatim into `session_id_observed`; if the
  // advisory queried `loadDelegationRecords` with the sanitized form, a
  // real session id containing `/` or `:` would never match its own
  // delegation records and the session would get a false-positive nudge.
  let baseDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    baseDir = mkTempBase();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  async function bump(sessionId: string, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await computeDelegationAdvisory({
        reaRoot: baseDir,
        policyOverride: ENABLED_POLICY,
        stdinOverride: payload(sessionId),
      });
    }
  }

  it('a session id containing `/` still matches its delegation records (no false-positive nudge)', async () => {
    const rawId = 'team/project/run-42';
    writeAgent(baseDir, 'rea-orchestrator.md');
    // The audit record stores the RAW id verbatim.
    await emitSignal(baseDir, { subagent: 'rea-orchestrator', sessionId: rawId, tool: 'Agent' });
    await bump(rawId, 2); // counter = 2, below threshold 3
    const atThreshold = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload(rawId),
    });
    expect(atThreshold.count).toBe(3);
    // The session DID delegate — the predicate must find the record
    // despite `/` being flattened to `_` in the filesystem counter key.
    expect(atThreshold.fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
    // The filesystem counter path used the COLLISION-FREE state key
    // (`team_project_run-42` readable prefix + sha256 hash suffix), NOT
    // the raw id — the result's `sessionId` field carries that key.
    expect(atThreshold.sessionId).toMatch(/^team_project_run-42-[0-9a-f]{16}$/);
    expect(
      fs.existsSync(
        path.join(
          baseDir,
          '.rea',
          '.delegation-advisory',
          `${sessionStateKey(rawId)}.count`,
        ),
      ),
    ).toBe(true);
  });

  it('a session id containing `:` still matches its delegation records', async () => {
    const rawId = 'host:8080:session';
    await emitSignal(baseDir, { subagent: 'deep-dive', sessionId: rawId, tool: 'Skill' });
    await bump(rawId, 2);
    const atThreshold = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload(rawId),
    });
    expect(atThreshold.count).toBe(3);
    expect(atThreshold.fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('an UNTAGGED session that delegated matches its `unknown` records (no false-positive nudge)', async () => {
    // Round-2 P2: when Claude omits / empties `session_id`, the capture
    // hook (`runHookDelegationSignal`) records the delegation under the
    // literal `session_id_observed: 'unknown'`. The advisory's audit
    // query MUST use the same `'unknown'` fallback — querying with a
    // bare `''` would never match, and every untagged session that DID
    // delegate would still get a false-positive nudge.
    writeAgent(baseDir, 'rea-orchestrator.md');
    // Delegation recorded under the `unknown` session id (what the
    // capture hook writes for an untagged session).
    await emitSignal(baseDir, { subagent: 'rea-orchestrator', sessionId: 'unknown', tool: 'Agent' });
    // The advisory hook receives a payload with NO session_id field.
    const noSessionPayload = JSON.stringify({ tool_name: 'Write' });
    for (let i = 0; i < 2; i += 1) {
      await computeDelegationAdvisory({
        reaRoot: baseDir,
        policyOverride: ENABLED_POLICY,
        stdinOverride: noSessionPayload,
      });
    }
    const atThreshold = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: noSessionPayload,
    });
    expect(atThreshold.count).toBe(3);
    expect(atThreshold.sessionId).toBe('unknown');
    // The session DID delegate (under `unknown`) — no nudge.
    expect(atThreshold.fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('an UNTAGGED session that did NOT delegate still fires (control for the P2 fix)', async () => {
    // Symmetry check: the `unknown` fallback must not over-suppress —
    // an untagged session with no delegation at all still gets nudged.
    const noSessionPayload = JSON.stringify({ tool_name: 'Bash' });
    for (let i = 0; i < 2; i += 1) {
      await computeDelegationAdvisory({
        reaRoot: baseDir,
        policyOverride: ENABLED_POLICY,
        stdinOverride: noSessionPayload,
      });
    }
    const atThreshold = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: noSessionPayload,
    });
    expect(atThreshold.count).toBe(3);
    expect(atThreshold.fired).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
  });
});

describe('computeDelegationAdvisory — rotated audit segments (round-2 P3)', () => {
  // Regression pin: the "did this session delegate" scan MUST walk
  // rotated audit segments, not just the current `.rea/audit.jsonl`. A
  // long session can outlive an audit rotation — its delegation signal
  // lands in a rotated file while later write-class calls land in the
  // current file. Scanning only the current file would miss the
  // delegation and fire a false-positive nudge.
  let baseDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    baseDir = mkTempBase();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  async function bump(sessionId: string, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await computeDelegationAdvisory({
        reaRoot: baseDir,
        policyOverride: ENABLED_POLICY,
        stdinOverride: payload(sessionId),
      });
    }
  }

  it('a delegation recorded in a rotated segment is still found', async () => {
    writeAgent(baseDir, 'rea-orchestrator.md');
    // Emit the delegation signal into the current audit.jsonl, then
    // rotate it out of the way by renaming to the canonical rotated
    // filename shape (`audit-YYYYMMDD-HHMMSS.jsonl`).
    await emitSignal(baseDir, { subagent: 'rea-orchestrator', sessionId: 's1', tool: 'Agent' });
    const auditPath = path.join(baseDir, '.rea', 'audit.jsonl');
    const rotatedPath = path.join(baseDir, '.rea', 'audit-20260101-120000.jsonl');
    fs.renameSync(auditPath, rotatedPath);
    // The current audit.jsonl no longer exists; the delegation lives
    // ONLY in the rotated segment.
    expect(fs.existsSync(auditPath)).toBe(false);
    expect(fs.existsSync(rotatedPath)).toBe(true);

    await bump('s1', 2); // counter = 2
    const atThreshold = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(atThreshold.count).toBe(3);
    // The scan walked the rotated segment and found the delegation —
    // no nudge.
    expect(atThreshold.fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('still fires when NO segment (current or rotated) holds a real delegation', async () => {
    // Control: a rotated segment exists but holds a delegation for a
    // DIFFERENT session — the nudge must still fire for s1.
    writeAgent(baseDir, 'rea-orchestrator.md');
    await emitSignal(baseDir, {
      subagent: 'rea-orchestrator',
      sessionId: 'other-session',
      tool: 'Agent',
    });
    fs.renameSync(
      path.join(baseDir, '.rea', 'audit.jsonl'),
      path.join(baseDir, '.rea', 'audit-20260101-120000.jsonl'),
    );
    await bump('s1', 2);
    const atThreshold = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('s1'),
    });
    expect(atThreshold.count).toBe(3);
    expect(atThreshold.fired).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
  });
});

describe('computeDelegationAdvisory — per-session state isolation (round-3 P2)', () => {
  // Regression pin: two distinct session ids that flatten to the same
  // sanitized prefix (`a/b` and `a:b` both -> `a_b`) MUST keep separate
  // `.count` / `.fired` state files. The pre-fix key was the bare
  // sanitized id, so the two sessions collided — one could inherit the
  // other's counter or have its advisory suppressed by the other's
  // `.fired` sentinel. `sessionStateKey` appends a sha256-of-raw-id
  // suffix, making the key collision-free.
  let baseDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    baseDir = mkTempBase();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('does NOT leak the counter between two ids that share a sanitized prefix', async () => {
    // Session `a/b` runs 2 write-class calls.
    await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('a/b'),
    });
    await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('a/b'),
    });
    // Session `a:b` — sanitizes to the same `a_b` prefix — runs its
    // FIRST call. With the pre-fix shared key it would read `a/b`'s
    // counter and land at 3 (threshold). With the collision-free key
    // it is an independent session at count 1.
    const firstForColliding = await computeDelegationAdvisory({
      reaRoot: baseDir,
      policyOverride: ENABLED_POLICY,
      stdinOverride: payload('a:b'),
    });
    expect(firstForColliding.count).toBe(1);
    expect(firstForColliding.fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
    // The two sessions produced two DISTINCT state keys / files.
    expect(sessionStateKey('a/b')).not.toBe(sessionStateKey('a:b'));
    const stateDir = path.join(baseDir, '.rea', '.delegation-advisory');
    expect(fs.existsSync(path.join(stateDir, `${sessionStateKey('a/b')}.count`))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, `${sessionStateKey('a:b')}.count`))).toBe(true);
  });

  it('does NOT leak the `.fired` sentinel between colliding-prefix ids', async () => {
    // Session `x y` (sanitizes to `x_y`) reaches threshold and fires.
    for (let i = 0; i < 3; i += 1) {
      await computeDelegationAdvisory({
        reaRoot: baseDir,
        policyOverride: ENABLED_POLICY,
        stdinOverride: payload('x y'),
      });
    }
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockClear();
    // Session `x/y` ALSO sanitizes to `x_y`. With a shared key its
    // first call past threshold would see the other session's `.fired`
    // sentinel and stay silent. With the collision-free key it is an
    // independent session that fires on its own threshold crossing.
    for (let i = 0; i < 3; i += 1) {
      await computeDelegationAdvisory({
        reaRoot: baseDir,
        policyOverride: ENABLED_POLICY,
        stdinOverride: payload('x/y'),
      });
    }
    expect(stderrSpy).toHaveBeenCalled();
  });
});

describe('computeDelegationAdvisory — real policy file read', () => {
  let baseDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    baseDir = mkTempBase();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('resolves enabled+threshold from a real .rea/policy.yaml', async () => {
    fs.writeFileSync(
      path.join(baseDir, '.rea', 'policy.yaml'),
      'delegation_advisory:\n  enabled: true\n  threshold: 2\n',
    );
    // First call — counter 1, below threshold 2.
    const r1 = await computeDelegationAdvisory({
      reaRoot: baseDir,
      stdinOverride: payload('s1'),
    });
    expect(r1.outcome).toBe('ran');
    expect(r1.fired).toBe(false);
    // Second call — counter 2, at threshold, no delegation → fires.
    const r2 = await computeDelegationAdvisory({
      reaRoot: baseDir,
      stdinOverride: payload('s1'),
    });
    expect(r2.fired).toBe(true);
  });

  it('treats a missing policy file as disabled', async () => {
    // No .rea/policy.yaml written.
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      stdinOverride: payload('s1'),
    });
    expect(r.outcome).toBe('disabled');
  });

  it('treats a policy file with no delegation_advisory block as disabled', async () => {
    fs.writeFileSync(
      path.join(baseDir, '.rea', 'policy.yaml'),
      'autonomy_level: L1\nblocked_paths: []\n',
    );
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      stdinOverride: payload('s1'),
    });
    expect(r.outcome).toBe('disabled');
  });

  it('treats enabled:false in the policy file as disabled', async () => {
    fs.writeFileSync(
      path.join(baseDir, '.rea', 'policy.yaml'),
      'delegation_advisory:\n  enabled: false\n  threshold: 3\n',
    );
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      stdinOverride: payload('s1'),
    });
    expect(r.outcome).toBe('disabled');
  });

  it('falls back to the default threshold (25) when the key is omitted', async () => {
    fs.writeFileSync(
      path.join(baseDir, '.rea', 'policy.yaml'),
      'delegation_advisory:\n  enabled: true\n',
    );
    // 24 bumps stay below the default threshold of 25.
    let last = await computeDelegationAdvisory({
      reaRoot: baseDir,
      stdinOverride: payload('s1'),
    });
    for (let i = 2; i <= 24; i += 1) {
      last = await computeDelegationAdvisory({
        reaRoot: baseDir,
        stdinOverride: payload('s1'),
      });
    }
    expect(last.count).toBe(24);
    expect(last.fired).toBe(false);
    // The 25th call hits the default threshold.
    const atDefault = await computeDelegationAdvisory({
      reaRoot: baseDir,
      stdinOverride: payload('s1'),
    });
    expect(atDefault.count).toBe(25);
    expect(atDefault.fired).toBe(true);
  });

  it('treats unparseable policy YAML as disabled (advisory hook never fails loud)', async () => {
    fs.writeFileSync(path.join(baseDir, '.rea', 'policy.yaml'), '{[: not yaml at all');
    const r = await computeDelegationAdvisory({
      reaRoot: baseDir,
      stdinOverride: payload('s1'),
    });
    expect(r.outcome).toBe('disabled');
  });
});
