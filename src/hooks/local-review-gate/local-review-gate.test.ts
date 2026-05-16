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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLocalReviewGate } from './index.js';

const PAYLOAD = (cmd: string, toolName = 'Bash'): string =>
  JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });

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
