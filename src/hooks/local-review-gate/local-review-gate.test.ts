/**
 * Unit suite for the Node-binary local-review-gate port (0.34.0).
 *
 * Covers:
 *   - HALT
 *   - mode short-circuit (`off` exits 0 before anything else)
 *   - non-Bash / empty / non-trigger commands
 *   - refuse_at push|commit|both
 *   - process-env bypass (global)
 *   - inline-bypass: per-segment validation
 *   - quoted bypass values (double/single/ANSI-C)
 *   - laundering class: multi-trigger commands must validate each
 *   - leading-env-var prefix shapes (round-30 F1 sibling sweep)
 *   - comment-tail anchor safety (round-27 F1 fix)
 *   - empty bypass value MUST refuse
 *   - preflight refuse → exit 2 + banner
 *   - preflight allow → exit 0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLocalReviewGate, G3_TOOL_NAME, G3_SHADOW_TOOL_NAME } from './index.js';
import { invalidatePolicyCache } from '../../policy/loader.js';

const PAYLOAD = (cmd: string, toolName = 'Bash'): string =>
  JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });

/** True when `.rea/audit.jsonl` contains a record with the given tool_name. */
function auditContains(root: string, toolName: string): boolean {
  const p = path.join(root, '.rea', 'audit.jsonl');
  if (!fs.existsSync(p)) return false;
  return fs.readFileSync(p, 'utf8').includes(`"${toolName}"`);
}

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-local-review-'));
}

function writePolicy(
  root: string,
  body: string = `version: "1"
profile: "test"
installed_by: "test"
installed_at: "2026-05-15T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: false
blocked_paths: []
review:
  local_review:
    mode: enforced
    refuse_at: push
`,
): void {
  fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rea', 'policy.yaml'), body);
}

// Default preflight stub — refuses. Tests override per-case.
const refusePreflight = async (): Promise<{
  exitCode: 0 | 1 | 2;
  reason: string;
}> => ({ exitCode: 2, reason: 'no recent rea.local_review covering HEAD' });
const allowPreflight = async (): Promise<{
  exitCode: 0 | 1 | 2;
  reason: string;
}> => ({ exitCode: 0, reason: 'review chain current' });

describe('local-review-gate: HALT', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
    writePolicy(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 when .rea/HALT exists, even for non-git commands', async () => {
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'maintenance');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('ls'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('halt');
    expect(r.stderr).toContain('REA HALT: maintenance');
  });
});

describe('local-review-gate: mode short-circuit', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('mode: off → exit 0 silently for git push', async () => {
    writePolicy(
      root,
      `review:
  local_review:
    mode: off
`,
    );
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('mode-off');
    expect(r.stderr).toBe('');
  });

  it('missing policy file → defaults to enforced (refuses)', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
  });
});

describe('local-review-gate: trigger detection', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
    writePolicy(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('non-Bash tool → exit 0', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push', 'Write'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('non-bash');
  });

  it('empty command → exit 0', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(''),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('empty-cmd');
  });

  it('non-git command (ls) → exit 0', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('ls -la'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('no-trigger');
  });

  it('refuse_at=push fires on git push but NOT git commit', async () => {
    writePolicy(
      root,
      `review:
  local_review:
    mode: enforced
    refuse_at: push
`,
    );
    const push = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(push.exitCode).toBe(2);
    const commit = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git commit -m x'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(commit.exitCode).toBe(0);
    expect(commit.decision).toBe('no-trigger');
  });

  it('refuse_at=commit fires on commit but not push', async () => {
    writePolicy(
      root,
      `review:
  local_review:
    mode: enforced
    refuse_at: commit
`,
    );
    const push = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(push.exitCode).toBe(0);
    expect(push.decision).toBe('no-trigger');
    const commit = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git commit -m x'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(commit.exitCode).toBe(2);
  });

  it('refuse_at=both fires on both', async () => {
    writePolicy(
      root,
      `review:
  local_review:
    mode: enforced
    refuse_at: both
`,
    );
    const a = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(a.exitCode).toBe(2);
    const b = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git commit'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(b.exitCode).toBe(2);
  });

  it('echoed mention does NOT trigger', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(`echo "remember to git push later"`),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('no-trigger');
  });

  it('commit message mention does NOT trigger', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(`echo "remember git push"`),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
  });

  it('chained && git push (segment after &&) triggers', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('cd /tmp && git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
  });
});

describe('local-review-gate: process-env bypass', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
    writePolicy(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('non-empty env value bypasses globally', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: { REA_SKIP_LOCAL_REVIEW: 'urgent fix' },
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-process-env');
  });

  it('empty env value does NOT bypass', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: { REA_SKIP_LOCAL_REVIEW: '' },
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
  });

  it('process-env bypass covers all trigger segments uniformly', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        'git push fake --dry-run; git push origin main',
      ),
      envOverride: { REA_SKIP_LOCAL_REVIEW: 'reason' },
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-process-env');
  });

  it('custom bypass_env_var name from policy', async () => {
    writePolicy(
      root,
      `review:
  local_review:
    mode: enforced
    refuse_at: push
    bypass_env_var: MY_BYPASS
`,
    );
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: { MY_BYPASS: 'reason' },
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-process-env');
  });
});

describe('local-review-gate: inline bypass', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
    writePolicy(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('inline unquoted bypass: VAR=value git push', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('REA_SKIP_LOCAL_REVIEW=urgent git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-inline');
  });

  it('inline double-quoted bypass', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        `REA_SKIP_LOCAL_REVIEW="urgent fix" git push origin main`,
      ),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-inline');
  });

  it('inline single-quoted bypass', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        `REA_SKIP_LOCAL_REVIEW='urgent fix' git push origin main`,
      ),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-inline');
  });

  it('inline ANSI-C-quoted bypass (round-5 P2 regression)', async () => {
    // Pre-round-5-P2: buildInlineBypassRegex only accepted
    // double-quoted, single-quoted, and bare values. ANSI-C shapes
    // like `REA_SKIP_LOCAL_REVIEW=$'urgent fix' git push` (which the
    // bash hook + raw trigger regex both accepted) silently fell
    // through to "no bypass detected" → preflight refused valid
    // operator overrides.
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        `REA_SKIP_LOCAL_REVIEW=$'urgent fix' git push origin main`,
      ),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-inline');
  });

  it('empty inline bypass value MUST refuse', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('REA_SKIP_LOCAL_REVIEW="" git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
  });

  it('multi-trigger laundering: bypass on seg1, real push on seg2 REFUSES', async () => {
    // Pre-fix round-25 P1-B PoC: bypass honored on segment 1, real
    // push on segment 2 went through ungated. The fix REQUIRES every
    // trigger segment to authorize bypass independently.
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        'REA_SKIP_LOCAL_REVIEW=fake git push fake --dry-run; git push origin main',
      ),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
  });

  it('multi-trigger with bypass on BOTH segments → allow', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        'REA_SKIP_LOCAL_REVIEW=fake git push fake --dry-run; REA_SKIP_LOCAL_REVIEW=ok git push origin main',
      ),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-inline');
  });

  it('round-30 F1: leading env-var prefix before bypass works', async () => {
    // POSIX-legal: `GIT_TRACE=1 REA_SKIP_LOCAL_REVIEW="reason" git push`
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        `GIT_TRACE=1 REA_SKIP_LOCAL_REVIEW="reason" git push origin main`,
      ),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-inline');
  });

  it('round-27 F1: comment-tail bypass does NOT authorize', async () => {
    // PoC: bypass shape appearing in a `#` comment-tail must NOT
    // authorize. The comment is not at segment start.
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        `git push origin main # see PR — REA_SKIP_LOCAL_REVIEW=fake git push`,
      ),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
  });
});

describe('local-review-gate: preflight integration', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
    writePolicy(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preflight allow → exit 0', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: allowPreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('preflight-allow');
  });

  it('preflight refuse → exit 2 + banner', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BASH BLOCKED');
    expect(r.stderr).toContain('local-first review required');
    expect(r.stderr).toContain('rea preflight refused');
    expect(r.stderr).toContain('REA_SKIP_LOCAL_REVIEW');
  });

  it('preflight throw is treated as refuse', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: async () => {
        throw new Error('preflight machine on fire');
      },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('preflight machine on fire');
  });

  it('banner names the configured bypass var', async () => {
    writePolicy(
      root,
      `review:
  local_review:
    mode: enforced
    refuse_at: push
    bypass_env_var: TEAM_SKIP_REVIEW
`,
    );
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('TEAM_SKIP_REVIEW');
  });
});

describe('local-review-gate: payload errors', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
    writePolicy(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('malformed JSON → exit 2', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: '{not json',
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('malformed-payload');
  });

  it('type-mismatched tool_input → exit 2', async () => {
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: { not: 'a string' } },
      }),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// G3 (Artifact Gate) — the review gate's artifact-gates face.
//
// ARCHITECTURE: the gate resolves the EFFECTIVE mode via the SHARED
// `resolveEffectiveReviewMode` (src/cli/preflight.ts) and applies ONLY the
// `off` short-circuit. The shadow-vs-enforce COVERAGE decision AND its
// `rea.gate.g3[.shadow]` audit emission are owned by `computePreflight`, so
// stub-`preflightImpl` tests here cover the gate's off-precedence + its
// delegation (honor the exit code); the REAL coverage-engine tri-state is
// exercised in the `integration (real computePreflight)` block below and in
// src/cli/preflight.g3.test.ts. This is what keeps the Bash-hook path and
// the husky/CLI path from diverging.
// ---------------------------------------------------------------------------

/** Tolerant policy body carrying an artifact_gates.g3_review.mode tier. */
function g3Body(mode: 'off' | 'shadow' | 'enforce', localReviewMode = 'enforced'): string {
  return `review:
  local_review:
    mode: ${localReviewMode}
    refuse_at: push
artifact_gates:
  g3_review:
    mode: ${mode}
`;
}

/** A preflight stub that MUST NOT be reached (asserts a short-circuit). */
const unreachablePreflight = async (): Promise<{ exitCode: 0 | 1 | 2; reason: string }> => {
  throw new Error('preflight must not be called — gate should have short-circuited');
};

describe('local-review-gate G3: effective-mode off short-circuit (precedence)', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('g3_review.mode: off → silent mode-off exit 0 (probe never called)', async () => {
    writePolicy(root, g3Body('off'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('mode-off');
    expect(r.stderr).toBe('');
  });

  it('g3 off is AUTHORITATIVE over legacy local_review.mode: enforced', async () => {
    // Precedence: g3 present → g3 wins. Legacy enforced would refuse, but
    // g3 off silences the gate before the probe.
    writePolicy(root, g3Body('off', 'enforced'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('mode-off');
  });

  it('present g3_review block with omitted mode → off (schema default), not legacy (round-14 P2)', async () => {
    // `artifact_gates.g3_review: {}` validates as mode:off under the strict
    // schema (.default). The tolerant reader must resolve the SAME off — not
    // fall back to legacy review.local_review, which would keep enforcing.
    const body = `review:
  local_review:
    mode: enforced
    refuse_at: push
artifact_gates:
  g3_review: {}
`;
    writePolicy(root, body);
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('mode-off');
  });

  const malformedBody = (localReviewMode: 'enforced' | 'off'): string => `review:
  local_review:
    mode: ${localReviewMode}
    refuse_at: push
artifact_gates:
  g3_review:
    mode: bogus
`;

  it('MALFORMED g3_review.mode + legacy enforced → refuses, matching preflight (round-26 P2)', async () => {
    // A typo'd mode is REJECTED by the strict schema, so `rea preflight`
    // strict-load-fails → enforced default. This Bash hook must agree and
    // delegate (→ refuse), NOT silently allow via `off`.
    writePolicy(root, malformedBody('enforced'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
  });

  it('MALFORMED g3_review.mode + legacy OFF → does NOT short-circuit allow; delegates → refuse (round-38 P2)', async () => {
    // The divergence codex round-38 caught: malformed → `extractG3Mode` used to
    // return undefined → legacy off → gate short-circuited to `mode-off` and
    // ALLOWED, while `computePreflight` strict-fails the WHOLE policy to the
    // enforced default and REFUSES. The fix signals `'malformed' → enforce` so
    // the gate delegates. `preflight-refuse` (NOT `mode-off`) proves no
    // off short-circuit fired.
    writePolicy(root, malformedBody('off'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
  });

  it('MALFORMED g3_review.mode + legacy OFF → reaches the probe (proves no mode-off short-circuit)', async () => {
    // Same policy, but with an ALLOW stub: if the gate wrongly short-circuited
    // to `off` it would return decision `mode-off`; delegating yields
    // `preflight-allow`. Distinguishes "short-circuited" from "delegated".
    writePolicy(root, malformedBody('off'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: allowPreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('preflight-allow');
    expect(r.decision).not.toBe('mode-off');
  });

  // Round-41 P2: a wrong-TYPE OUTER block (artifact_gates / g3_review given as
  // a string/number/array/null) is ALSO malformed — the strict loadPolicy
  // rejects the whole policy and computePreflight enforces. The Bash gate must
  // NOT short-circuit to `off` via legacy on these.
  const wrongTypeArtifactGates = `review:
  local_review:
    mode: off
    refuse_at: push
artifact_gates: "not-an-object"
`;
  const wrongTypeG3Review = `review:
  local_review:
    mode: off
    refuse_at: push
artifact_gates:
  g3_review: 42
`;

  it('WRONG-TYPE artifact_gates block + legacy OFF → delegates (no mode-off short-circuit)', async () => {
    writePolicy(root, wrongTypeArtifactGates);
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
  });

  it('WRONG-TYPE g3_review block + legacy OFF → delegates (no mode-off short-circuit)', async () => {
    writePolicy(root, wrongTypeG3Review);
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
  });

  it('WRONG-TYPE artifact_gates + legacy OFF + ALLOW stub → delegates (proves NOT mode-off)', async () => {
    // If the gate wrongly resolved undefined→legacy off it would short-circuit
    // to `mode-off`; delegating to the (allow) probe yields `preflight-allow`.
    writePolicy(root, wrongTypeArtifactGates);
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: allowPreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('preflight-allow');
    expect(r.decision).not.toBe('mode-off');
  });

  it('ABSENT artifact_gates block → byte-identical legacy (off short-circuits)', async () => {
    // The invariant that must survive the wrong-type fix: a genuinely ABSENT
    // block still routes to legacy, so legacy off silences the gate.
    writePolicy(root, `review:
  local_review:
    mode: off
    refuse_at: push
`);
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('mode-off');
  });

  it('g3 shadow does NOT short-circuit off — gate proceeds to the probe', async () => {
    writePolicy(root, g3Body('shadow'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      // Real preflight resolves shadow to a clean exit 0; the stub stands in.
      preflightImpl: allowPreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('preflight-allow');
  });

  it('g3 enforce + legacy off does NOT short-circuit — legacy off no longer neuters (upgrade path)', async () => {
    // The exact operator migration: moving from the old knob to the new tier
    // while the stale `local_review.mode: off` lingers. The gate must NOT
    // treat that as mode-off; it proceeds, and (real) preflight enforces.
    writePolicy(root, g3Body('enforce', 'off'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
  });
});

describe('local-review-gate G3: delegates coverage verdict to preflight', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('honors a preflight ALLOW (exit 0) → allow', async () => {
    writePolicy(root, g3Body('enforce'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: allowPreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('preflight-allow');
  });

  it('honors a preflight REFUSE (exit 2) → refuse + Bash-tier banner', async () => {
    writePolicy(root, g3Body('enforce'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
    expect(r.stderr).toContain('BASH BLOCKED');
    expect(r.stderr).toContain('local-first review required');
  });

  it('probe throw is fail-closed at the Bash tier (refuse)', async () => {
    writePolicy(root, g3Body('enforce'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: async () => {
        throw new Error('probe on fire');
      },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('probe on fire');
  });

  it('bypass short-circuits BEFORE the probe (enforce tier)', async () => {
    writePolicy(root, g3Body('enforce'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('REA_SKIP_LOCAL_REVIEW=urgent git push origin main'),
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('bypass-inline');
  });
});

describe('local-review-gate G3: legacy invariant (g3_review absent)', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('enforce refuse behaves byte-identically (no artifact_gates block)', async () => {
    writePolicy(root); // legacy review.local_review path only
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: refusePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
  });
});

describe('local-review-gate G3: HALT still wins', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('HALT wins over g3 enforce (exit 2, decision halt, probe never called)', async () => {
    writePolicy(root, g3Body('enforce'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'maintenance');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('halt');
    expect(r.stderr).toContain('REA HALT: maintenance');
  });

  it('HALT wins over g3 shadow (exit 2, decision halt)', async () => {
    writePolicy(root, g3Body('shadow'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'maintenance');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('halt');
  });
});

// ---------------------------------------------------------------------------
// Integration: gate → REAL computePreflight → real audit. Proves the whole
// chain (Bash hook path) end-to-end: preflight owns the tri-state coverage
// decision + emission, the gate honors the exit code, and a stale legacy
// `local_review.mode: off` no longer neuters an active G3.
// ---------------------------------------------------------------------------

/** Strict-loadable full policy with an artifact_gates.g3_review tier. */
function writeFullPolicy(
  root: string,
  g3: 'off' | 'shadow' | 'enforce' | 'absent',
  localReviewMode: 'enforced' | 'off' = 'enforced',
): void {
  const lines = [
    'version: "0.54.0"',
    'profile: open-source-no-codex',
    'installed_by: t',
    'installed_at: "2026-07-18T00:00:00Z"',
    'autonomy_level: L1',
    'max_autonomy_level: L2',
    'promotion_requires_human_approval: true',
    'block_ai_attribution: true',
    'blocked_paths: []',
    'protected_paths_relax: []',
    'notification_channel: ""',
    'review:',
    '  local_review:',
    `    mode: ${localReviewMode}`,
    '    refuse_at: push',
  ];
  if (g3 !== 'absent') {
    lines.push('artifact_gates:', '  g3_review:', `    mode: ${g3}`);
  }
  lines.push('');
  fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rea', 'policy.yaml'), lines.join('\n'));
  invalidatePolicyCache(root);
  invalidatePolicyCache();
}

describe('local-review-gate G3: integration (real computePreflight)', () => {
  let root: string;
  const gitc = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-g3-int-'));
    gitc(['init', '-q']);
    gitc(['config', 'user.email', 'g3@test.test']);
    gitc(['config', 'user.name', 'G3']);
    gitc(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const x = 1;\n');
    gitc(['add', 'app.ts']);
    gitc(['commit', '-qm', 'baseline']);
  });
  afterEach(() => {
    invalidatePolicyCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('g3 shadow, no coverage → gate ALLOWS + preflight logs rea.gate.g3.shadow', async () => {
    writeFullPolicy(root, 'shadow');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('preflight-allow');
    expect(auditContains(root, G3_SHADOW_TOOL_NAME)).toBe(true);
    expect(auditContains(root, G3_TOOL_NAME)).toBe(false);
  });

  it('g3 enforce, no coverage → gate REFUSES + preflight logs rea.gate.g3', async () => {
    writeFullPolicy(root, 'enforce');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
    expect(r.stderr).toContain('BASH BLOCKED');
    expect(auditContains(root, G3_TOOL_NAME)).toBe(true);
    expect(auditContains(root, G3_SHADOW_TOOL_NAME)).toBe(false);
  });

  it('g3 off + legacy enforced → gate mode-off exit 0, NO gate audit', async () => {
    writeFullPolicy(root, 'off', 'enforced');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('mode-off');
    expect(auditContains(root, G3_TOOL_NAME)).toBe(false);
    expect(auditContains(root, G3_SHADOW_TOOL_NAME)).toBe(false);
  });

  it('UPGRADE PATH: g3 enforce + legacy off → still REFUSES + logs rea.gate.g3 (F2 fix)', async () => {
    writeFullPolicy(root, 'enforce', 'off');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
    expect(auditContains(root, G3_TOOL_NAME)).toBe(true);
  });

  it('g3 shadow is AUTHORITATIVE over legacy enforced — logs, does NOT refuse', async () => {
    writeFullPolicy(root, 'shadow', 'enforced');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('preflight-allow');
    expect(auditContains(root, G3_SHADOW_TOOL_NAME)).toBe(true);
  });

  it('LEGACY INVARIANT: g3 absent + legacy enforced, no coverage → refuse, NO gate audit', async () => {
    writeFullPolicy(root, 'absent', 'enforced');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('preflight-refuse');
    // The load-bearing invariant: absent g3 emits NO gate records.
    expect(auditContains(root, G3_TOOL_NAME)).toBe(false);
    expect(auditContains(root, G3_SHADOW_TOOL_NAME)).toBe(false);
  });

  it('g3 absent + legacy off → gate mode-off exit 0', async () => {
    writeFullPolicy(root, 'absent', 'off');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: PAYLOAD('git push origin main'),
      envOverride: {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('mode-off');
  });
});

// ---------------------------------------------------------------------------
// Malformed-payload verdict is RISK-CALIBRATED by the effective gate mode
// (codex round-47 P2 — fail-closed-when-off regression fix).
//
// The gate parses stdin BEFORE resolving policy (worktree cwd extraction),
// but the MODE comes from POLICY, not the payload — so an unparseable payload
// is still resolvable against the effective mode:
//   - off     → silent no-op exit 0 (THE FIX: previously a hard block)
//   - shadow  → no-op exit 0 (shadow never blocks)
//   - enforce → fail-closed exit 2 "refusing on uncertainty"
//   - HALT    → exit 2 (kill switch wins over EVERY mode, incl. off)
// ---------------------------------------------------------------------------
describe('local-review-gate: malformed payload × effective mode', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const MALFORMED = '{not json';

  it('mode off (g3_review.mode: off) + malformed → silent no-op exit 0', async () => {
    writePolicy(root, g3Body('off'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: MALFORMED,
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('mode-off');
    expect(r.stderr).toBe('');
  });

  it('mode off (legacy local_review.mode: off) + malformed → silent no-op exit 0', async () => {
    writePolicy(
      root,
      `review:
  local_review:
    mode: off
    refuse_at: push
`,
    );
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: MALFORMED,
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('mode-off');
    expect(r.stderr).toBe('');
  });

  it('mode shadow + malformed → no-op exit 0 (shadow never blocks)', async () => {
    writePolicy(root, g3Body('shadow'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: MALFORMED,
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('malformed-payload');
    expect(r.stderr).toBe('');
  });

  it('mode enforce (g3_review.mode: enforce) + malformed → fail-closed exit 2', async () => {
    writePolicy(root, g3Body('enforce'));
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: MALFORMED,
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('malformed-payload');
    expect(r.stderr).toContain('refusing on uncertainty');
  });

  it('mode enforce (legacy enforced, no g3) + malformed → fail-closed exit 2', async () => {
    writePolicy(root); // default body: legacy mode: enforced, no artifact_gates
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: MALFORMED,
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('malformed-payload');
    expect(r.stderr).toContain('refusing on uncertainty');
  });

  it('HALT set + malformed (mode off) → exit 2, HALT WINS over off', async () => {
    writePolicy(root, g3Body('off'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'maintenance');
    const r = await runLocalReviewGate({
      reaRoot: root,
      stdinOverride: MALFORMED,
      envOverride: {},
      preflightImpl: unreachablePreflight,
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe('halt');
    expect(r.stderr).toContain('REA HALT: maintenance');
  });
});
