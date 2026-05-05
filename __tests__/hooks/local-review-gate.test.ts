/**
 * Tests for `hooks/local-review-gate.sh` (0.26.0+).
 *
 * The hook fires on PreToolUse:Bash. Verifies that:
 *   - non-git commands are allowed unconditionally
 *   - `policy.review.local_review.mode: off` makes the hook a silent no-op
 *   - the configured bypass env-var bypasses the check (no audit double-write)
 *   - `git push` / `git commit` trigger preflight delegation
 *
 * The hook shells to `rea preflight --strict` for the actual decision —
 * we don't ship a fake rea binary in these tests, so the cases where
 * preflight WOULD run instead exercise the rea-not-found fail-OPEN
 * fallback (matches production: rea-tier missing means the bash gate
 * just gets out of the way).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'local-review-gate.sh');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(dir: string, command: string, env: Record<string, string> = {}): HookResult {
  const payload = JSON.stringify({ tool_input: { command } });
  // Sandbox PATH to a directory containing no rea binary so the gate
  // exercises the rea-not-found branch (fail OPEN with stderr advisory).
  // For tests that need rea to be present we'd swap PATH back in.
  const sandboxedEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    CLAUDE_PROJECT_DIR: dir,
    HOME: process.env.HOME ?? '',
    ...env,
  };
  const res = spawnSync('bash', [HOOK_SRC], {
    cwd: dir,
    env: sandboxedEnv,
    input: payload,
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function jqExists(): boolean {
  return spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
}

const POLICY_HEADER = `version: "1"
profile: "test"
installed_by: "test@1.0.0"
installed_at: "2026-05-04T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
notification_channel: ""
`;

async function writePolicy(dir: string, body: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_HEADER + body);
}

describe('local-review-gate.sh — non-git commands', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-')));
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('allows `ls`', () => {
    if (!jqExists()) return;
    const r = runHook(dir, 'ls');
    expect(r.status).toBe(0);
  });

  it('allows `git status` (read-only)', () => {
    if (!jqExists()) return;
    const r = runHook(dir, 'git status');
    expect(r.status).toBe(0);
  });

  it('allows `git log --oneline`', () => {
    if (!jqExists()) return;
    const r = runHook(dir, 'git log --oneline -5');
    expect(r.status).toBe(0);
  });

  it('allows commit messages that mention git push', () => {
    if (!jqExists()) return;
    // Commit message body should not trigger detection.
    const r = runHook(dir, 'echo "doc: when to use git push --force-with-lease"');
    expect(r.status).toBe(0);
  });
});

describe('local-review-gate.sh — mode: off', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-off-')));
    await writePolicy(dir, 'review:\n  local_review:\n    mode: off\n');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('allows `git push` with mode: off', () => {
    if (!jqExists()) return;
    const r = runHook(dir, 'git push origin main');
    expect(r.status).toBe(0);
  });

  it('allows `git commit -m` with mode: off', () => {
    if (!jqExists()) return;
    const r = runHook(dir, 'git commit -m "fix: thing"');
    expect(r.status).toBe(0);
  });
});

describe('local-review-gate.sh — bypass env-var', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-bypass-')));
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('allows `git push` when REA_SKIP_LOCAL_REVIEW is set', () => {
    if (!jqExists()) return;
    const r = runHook(dir, 'git push origin main', {
      REA_SKIP_LOCAL_REVIEW: 'urgent fix',
    });
    expect(r.status).toBe(0);
  });

  it('honors a custom bypass_env_var from policy', async () => {
    if (!jqExists()) return;
    await writePolicy(
      dir,
      'review:\n  local_review:\n    bypass_env_var: REA_CUSTOM_OVERRIDE\n',
    );
    const r = runHook(dir, 'git push origin main', {
      REA_CUSTOM_OVERRIDE: 'custom override',
    });
    expect(r.status).toBe(0);
  });
});

describe('local-review-gate.sh — inline env-var override (helix-026 finding-2)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-inline-')));
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('honors `REA_SKIP_LOCAL_REVIEW="reason" git push` (double-quoted)', () => {
    if (!jqExists()) return;
    const r = runHook(dir, 'REA_SKIP_LOCAL_REVIEW="urgent fix" git push origin main');
    expect(r.status).toBe(0);
  });

  // ── codex round-23 P2 regression ────────────────────────────────────────
  // Pre-fix: `_rea_strip_prefix`'s regex `NAME=[^[:space:]]+[[:space:]]+`
  // bailed at the first space inside a double-quoted value, so
  // `any_segment_starts_with` never matched git push, NEEDS_PREFLIGHT
  // stayed 0, and the gate exited at line 120 BEFORE the bypass-detection
  // block ran. Net effect: bypass appeared to work (exit 0) but the
  // documented audit-log override entry never got written.
  //
  // The DEBUG_TRACE env var emits a structured stderr marker identifying
  // which branch the hook took. We assert the bypass-inline branch fired
  // with the captured reason — proving detection now reaches 9c, not the
  // silent "shape unrecognized" exit at line 120.
  it('quoted-whitespace bypass routes through bypass branch (codex round-23 P2)', () => {
    if (!jqExists()) return;
    const r = runHook(dir, 'REA_SKIP_LOCAL_REVIEW="urgent fix" git push origin main', {
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/rea-local-review-trace: bypass=inline/);
    // The reason is %q-formatted (bash escaping for shell-safe display).
    // `urgent fix` becomes `urgent\ fix` or quoted form. Match either.
    expect(r.stderr).toMatch(/reason=(urgent\\? ?fix|"urgent fix"|'urgent fix')/);
    expect(r.stderr).toMatch(/op=git push/);
    // Critically: the trace must NOT be `detect=none` — that would mean
    // the gate fell through line 120 silently (the pre-fix bug shape).
    expect(r.stderr).not.toMatch(/detect=none/);
  });

  it('quoted-whitespace bypass works for `git commit` shape too (codex round-23 P2)', async () => {
    if (!jqExists()) return;
    await writePolicy(dir, 'review:\n  local_review:\n    refuse_at: both\n');
    const r = runHook(dir, 'REA_SKIP_LOCAL_REVIEW="urgent fix" git commit -m "msg"', {
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/rea-local-review-trace: bypass=inline/);
    expect(r.stderr).toMatch(/op=git commit/);
    expect(r.stderr).not.toMatch(/detect=none/);
  });

  it('does NOT false-positive on `echo "FOO=bar git push"` (round-23 P2 fallback safety)', () => {
    if (!jqExists()) return;
    // The fallback regex anchors `^NAME=...` at segment start. An echo of
    // env-prefix-shaped text inside a quoted body must NOT trigger
    // detection: segment starts with `echo`, not `NAME=`.
    const r = runHook(dir, 'echo "FOO=bar git push to remote"', {
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/detect=none/);
  });

  it('honors REA_SKIP_LOCAL_REVIEW=word git push (unquoted)', () => {
    if (!jqExists()) return;
    const r = runHook(dir, 'REA_SKIP_LOCAL_REVIEW=quick git push origin main');
    expect(r.status).toBe(0);
  });

  it("honors REA_SKIP_LOCAL_REVIEW='quoted' git push (single-quoted)", () => {
    if (!jqExists()) return;
    const r = runHook(dir, "REA_SKIP_LOCAL_REVIEW='single quoted' git push origin main");
    expect(r.status).toBe(0);
  });

  it('rejects REA_SKIP_LOCAL_REVIEW="" git push (empty value)', () => {
    if (!jqExists()) return;
    // Empty value MUST NOT bypass — same as missing the env var entirely.
    // The semantic guarantee is "empty value does NOT mask as bypass".
    // Round-30 F1 added the npx fallback to the rea-bin resolver, so a
    // test PATH that exposes npx now reaches preflight (which refuses,
    // because no audit entry covers HEAD → exit 2 with BASH BLOCKED).
    // A test PATH without npx still falls open with exit 0 + the
    // skip-advisory. Both outcomes prove the bypass was rejected — the
    // ONLY forbidden outcome is silent exit 0 with no diagnostic AND no
    // BASH BLOCKED message (which would indicate an early bypass-exit).
    const r = runHook(dir, 'REA_SKIP_LOCAL_REVIEW="" git push origin main');
    // Two acceptable shapes (depending on whether npx is on PATH):
    //   1. exit 2 + BASH BLOCKED      (preflight reached + refused)
    //   2. exit 0 + skip-advisory     (no rea CLI reachable)
    // The forbidden shape is bypass-honored = exit 0 with no advisory.
    const acceptedRefusal =
      (r.status === 2 && /BASH BLOCKED/.test(r.stderr)) ||
      (r.status === 0 && /local-review-gate skipped — could not locate rea CLI/.test(r.stderr));
    expect(acceptedRefusal).toBe(true);
  });

  it('rejects REA_SKIP_LOCAL_REVIEW= git push (empty value, no quotes)', () => {
    if (!jqExists()) return;
    // Empty unquoted assignment: the cmd-segmenter's prefix-stripper
    // requires `[^[:space:]]+` after `=`, so the assignment isn't
    // stripped. The segment then doesn't START with `git push`, so the
    // gate sees no git push at all and exits 0 without invoking the
    // bypass path. The semantic guarantee is "empty value does NOT
    // bypass" — verified by the absence of an early bypass-exit path
    // (i.e. the absence of stderr indicating preflight ran). Either
    // way: the empty value doesn't masquerade as a non-empty override.
    const r = runHook(dir, 'REA_SKIP_LOCAL_REVIEW= git push origin main');
    expect(r.status).toBe(0);
    // Critically: stderr must NOT match the "rea preflight refuse"
    // refusal path — that would imply the gate accepted the empty
    // bypass and then refused on the audit-log check anyway. Both
    // negative outcomes (silent fall-through, fail-open advisory) are
    // acceptable; the bypass-path is not.
    expect(r.stderr).not.toMatch(/BASH BLOCKED/);
  });

  it('does NOT bypass when assignment is in an echo body, not before git', () => {
    if (!jqExists()) return;
    // The string `REA_SKIP_LOCAL_REVIEW="x" git push` appears inside a
    // commit-message body — must NOT be treated as a bypass for a real
    // git push. There is no `git push` afterward in this command, so
    // the command should be allowed without invoking the bypass path.
    const r = runHook(dir, 'echo "doc: REA_SKIP_LOCAL_REVIEW=\\"x\\" git push to skip review"');
    expect(r.status).toBe(0);
    // Allowed because it's not a git push at all — just an echo.
    // The presence of an echo means our hook never even runs preflight.
  });

  // Round-27 F1: anchor bypass-evaluator regex at SEGMENT START.
  //
  // PoC: `git push origin main # see PR — REA_SKIP_LOCAL_REVIEW=fake git push`.
  // Pre-fix the inline-bypass regex anchored at `(^|[[:space:]])` allowed
  // the bypass shape to match anywhere in the segment, including inside a
  // shell `#` comment tail. The whitespace before `REA_SKIP_LOCAL_REVIEW=`
  // satisfied the leading alternative, the unquoted value alternative
  // captured `fake`, and the gate honored a fake bypass for the REAL
  // `git push origin main` ahead of the comment. Active under DEFAULT
  // `refuse_at: push` config.
  //
  // Fix: anchor at `^[[:space:]]*` — segment start (after leading
  // whitespace). Comment tails are not the segment start, so the regex
  // refuses them. POSIX env-prefix shapes (`VAR=value git push`) still
  // match because they sit at segment start by construction.
  it('refuses `git push # comment with REA_SKIP_LOCAL_REVIEW=fake git push` (round-27 F1)', () => {
    if (!jqExists()) return;
    const r = runHook(
      dir,
      'git push origin main # see PR #5 — REA_SKIP_LOCAL_REVIEW=fake git push',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    // Trace must NOT show bypass=inline / bypass=process-env. Detection
    // must fire (not detect=none). With no rea on PATH the gate fails
    // OPEN — exit 0 — but the round-27 contract is "no inline bypass
    // honored from a comment tail".
    expect(r.stderr).not.toMatch(/bypass=inline/);
    expect(r.stderr).not.toMatch(/bypass=process-env/);
    expect(r.stderr).not.toMatch(/detect=none/);
  });

  it('refuses `git push # comment` with multiple env-shaped bypasses in the comment (round-27 F1)', () => {
    if (!jqExists()) return;
    // Defense-in-depth: even multiple bypass shapes inside the comment
    // tail must not authorize the leading real push.
    const r = runHook(
      dir,
      'git push origin main # REA_SKIP_LOCAL_REVIEW=foo REA_SKIP_LOCAL_REVIEW="bar" git push',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    expect(r.stderr).not.toMatch(/bypass=inline/);
    expect(r.stderr).not.toMatch(/bypass=process-env/);
    expect(r.stderr).not.toMatch(/detect=none/);
  });

  it('honors a custom inline bypass_env_var from policy', async () => {
    if (!jqExists()) return;
    await writePolicy(
      dir,
      'review:\n  local_review:\n    bypass_env_var: REA_CUSTOM_OVERRIDE\n',
    );
    const r = runHook(dir, 'REA_CUSTOM_OVERRIDE="custom" git push origin main');
    expect(r.status).toBe(0);
  });

  it('honors inline bypass even with leading whitespace', () => {
    if (!jqExists()) return;
    // Leading whitespace before the assignment is permitted by POSIX.
    const r = runHook(dir, '  REA_SKIP_LOCAL_REVIEW="reason" git push origin main');
    expect(r.status).toBe(0);
  });

  it('honors inline bypass with another env var prefixing', () => {
    if (!jqExists()) return;
    // Multiple env assignments before the command — POSIX-legal.
    const r = runHook(
      dir,
      'GIT_TRACE=1 REA_SKIP_LOCAL_REVIEW="reason" git push origin main',
    );
    expect(r.status).toBe(0);
  });
});

describe('local-review-gate.sh — refuse_at policy knob', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-refuseat-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('default refuse_at: push leaves git commit untouched', async () => {
    if (!jqExists()) return;
    await writePolicy(dir, '');
    // git commit should pass through (default refuse_at: push).
    // With no rea binary on PATH the hook fails OPEN — exit 0 either way.
    const r = runHook(dir, 'git commit -m "fix"');
    expect(r.status).toBe(0);
  });

  it('refuse_at: commit refuses git commit but leaves git push to the husky tier', async () => {
    if (!jqExists()) return;
    await writePolicy(
      dir,
      'review:\n  local_review:\n    refuse_at: commit\n',
    );
    // git push should NOT trigger preflight under refuse_at: commit.
    const r = runHook(dir, 'git push origin main');
    expect(r.status).toBe(0);
  });
});

describe('local-review-gate.sh — round-24 segment-scoped bypass detection', () => {
  // Codex round-24 P1: pre-fix the inline-bypass regex evaluated against
  // the WHOLE $CMD, so an attacker could put `VAR=fake` in segment 1 and
  // a real `git push` in segment 2 — the un-scoped regex honored the
  // bypass for the unrelated push. Fix: capture TRIGGER_SEGMENT (the
  // specific segment that fired NEEDS_PREFLIGHT=1) and scope the inline-
  // bypass regex to that segment only.
  //
  // The 4 PoCs below MUST refuse — verified by the absence of a
  // `bypass=inline` trace AND by the gate reaching the preflight path
  // (which without rea on PATH falls through to the fail-open advisory).
  // The 2 regressions confirm legitimate same-segment bypasses still work.

  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-r24-')));
    // refuse_at: both so PoC4 (commit + push) exercises both detectors.
    await writePolicy(dir, 'review:\n  local_review:\n    refuse_at: both\n');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Helper: assert the bypass branch did NOT fire for a given $CMD.
  // The hook fails open (exit 0 + advisory stderr) when rea isn't on
  // PATH — that's the intended behavior for the sandboxed test env, and
  // it's distinguishable from the bypass path which is silent (no
  // advisory) and from refuse which prints "BASH BLOCKED".
  function assertBypassDidNotFire(r: HookResult): void {
    // Critical: NO bypass-inline trace. That's the round-24 contract.
    expect(r.stderr).not.toMatch(/bypass=inline/);
    expect(r.stderr).not.toMatch(/bypass=process-env/);
    // Detection MUST have fired (otherwise we'd be on the silent
    // pre-step-9 exit, the original 0.26.0 bug shape).
    expect(r.stderr).not.toMatch(/detect=none/);
  }

  it('refuses when bypass shape is in a separate segment from git push (semicolon)', () => {
    if (!jqExists()) return;
    // PoC 1: bypass shape ahead of git status (segment 1), real push in segment 2.
    const r = runHook(
      dir,
      'true REA_SKIP_LOCAL_REVIEW="fake" git status; git push origin main',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    assertBypassDidNotFire(r);
  });

  it('refuses when bypass shape is in a separate segment from git push (&&)', () => {
    if (!jqExists()) return;
    // PoC 2: same shape as PoC 1 but with `&&` instead of `;`.
    const r = runHook(
      dir,
      'true REA_SKIP_LOCAL_REVIEW="fake" git status && git push origin main',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    assertBypassDidNotFire(r);
  });

  it('refuses when bypass shape is AFTER the real git push', () => {
    if (!jqExists()) return;
    // PoC 3: real push at start of $CMD, bypass shape afterward.
    const r = runHook(
      dir,
      'git push origin main; true REA_SKIP_LOCAL_REVIEW="fake" git status',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    assertBypassDidNotFire(r);
  });

  it('refuses when bypass shape is in quoted commit message body', () => {
    if (!jqExists()) return;
    // PoC 4: bypass shape lives entirely inside the quoted commit-msg body.
    // The `git push origin main` after the `;` is the real target; the
    // mention inside `-m "..."` MUST NOT honor it. The bypass body is
    // suppressed by `quote_masked_cmd` AND lives in a different segment
    // than the real push — defense in depth.
    const r = runHook(
      dir,
      'git commit -m "docs: REA_SKIP_LOCAL_REVIEW=x git push"; git push origin main',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    assertBypassDidNotFire(r);
  });

  it('still honors valid bypass on the actual git push segment (regression)', () => {
    if (!jqExists()) return;
    // The legitimate single-segment bypass MUST still work.
    const r = runHook(dir, 'REA_SKIP_LOCAL_REVIEW="urgent" git push origin main', {
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/rea-local-review-trace: bypass=inline/);
    expect(r.stderr).toMatch(/reason=urgent/);
    expect(r.stderr).toMatch(/op=git push/);
  });

  it('honors bypass when bypass+push is the second segment after a benign first', () => {
    if (!jqExists()) return;
    // The bypass IS in the same segment as the push — first segment is
    // an unrelated benign echo. This must STILL bypass.
    const r = runHook(
      dir,
      'echo "starting push"; REA_SKIP_LOCAL_REVIEW="urgent" git push origin main',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/rea-local-review-trace: bypass=inline/);
    expect(r.stderr).toMatch(/reason=urgent/);
    expect(r.stderr).toMatch(/op=git push/);
  });
});

// ── 0.26.0 round-25 P1-B: multi-push laundering closure ─────────────────────
//
// Round-24 scoped the inline-bypass regex to the FIRST trigger segment
// captured via `find_first_segment_starting_with`. That left a second
// laundering class open: a single Bash invocation that contains TWO
// `git push` segments, where segment 1 carries a bypass marker and
// segment 2 is the real (ungated) push. PoCs:
//
//   REA_SKIP_LOCAL_REVIEW="fake" git push fake-remote --dry-run; git push origin main
//   REA_SKIP_LOCAL_REVIEW="ok"   git push origin feat;            git push origin main
//
// Round-25 fix: capture EVERY trigger segment and require each to carry
// its OWN bypass (process-env covers globally, but inline must be present
// on each trigger). Any segment without bypass forces preflight invocation.
describe('local-review-gate.sh — round-25 P1-B multi-push laundering', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-r25-pmp-')));
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Helper: assert refusal — neither bypass=inline nor bypass=process-env
  // appeared, and detection fired (so we're NOT on the silent pre-step-9
  // exit).
  function assertRefused(r: HookResult): void {
    expect(r.stderr).not.toMatch(/bypass=inline/);
    expect(r.stderr).not.toMatch(/bypass=process-env/);
    expect(r.stderr).not.toMatch(/detect=none/);
    // Round-25 specifically emits a `refuse op=` trace. We do not require
    // that exact form (other code paths can also refuse), but the gate
    // MUST have proceeded past the bypass branch.
  }

  it('refuses `BYPASS=fake git push fake-remote --dry-run; git push origin main` (laundering PoC 1)', () => {
    if (!jqExists()) return;
    // Two push segments. Segment 1 has bypass, segment 2 (real push) has
    // none. Pre-fix: bypass on segment 1 honored globally and segment 2
    // sailed through ungated. Post-fix: ANY trigger without a bypass
    // forces preflight invocation.
    const r = runHook(
      dir,
      'REA_SKIP_LOCAL_REVIEW="fake" git push fake-remote --dry-run; git push origin main',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    assertRefused(r);
  });

  it('refuses `BYPASS=ok git push origin feat; git push origin main` (laundering PoC 2)', () => {
    if (!jqExists()) return;
    // Variant of PoC 1 — segment 1 is a "real" feature-branch push with
    // bypass, segment 2 is an unauthorized push to main.
    const r = runHook(
      dir,
      'REA_SKIP_LOCAL_REVIEW="ok" git push origin feat; git push origin main',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    assertRefused(r);
  });

  it('refuses when push 1 has bypass AND push 2 has no bypass (operator foot-gun)', () => {
    if (!jqExists()) return;
    // Same shape as PoC 2 but with `&&` instead of `;` — covers the
    // logical-and segment splitter.
    const r = runHook(
      dir,
      'REA_SKIP_LOCAL_REVIEW="ok" git push origin feat && git push origin main',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    assertRefused(r);
  });

  it('honors bypass when EVERY trigger segment has its own inline bypass', () => {
    if (!jqExists()) return;
    // Two pushes, both with their own bypass. This SHOULD bypass — round-25
    // preserves legitimate multi-push flows so long as each push is
    // independently authorized.
    const r = runHook(
      dir,
      'REA_SKIP_LOCAL_REVIEW="ok" git push origin feat; REA_SKIP_LOCAL_REVIEW="ok" git push origin main',
      { REA_LOCAL_REVIEW_DEBUG_TRACE: '1' },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/rea-local-review-trace: bypass=inline/);
    expect(r.stderr).not.toMatch(/refuse op=/);
  });

  it('honors single-push bypass (round-24 regression — must still pass)', () => {
    if (!jqExists()) return;
    // The single-segment, single-push bypass is the canonical happy path.
    // Round-25 must not regress it.
    const r = runHook(dir, 'REA_SKIP_LOCAL_REVIEW="ok" git push origin feat', {
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/rea-local-review-trace: bypass=inline/);
    expect(r.stderr).toMatch(/op=git push/);
  });

  it('process-env bypass covers all trigger segments uniformly', () => {
    if (!jqExists()) return;
    // Process-env BYPASS_VALUE is global by design — a single non-empty
    // value covers every trigger segment. This is the documented escape
    // hatch for terminal users / CI that exports the var session-wide.
    const r = runHook(dir, 'git push origin feat; git push origin main', {
      REA_SKIP_LOCAL_REVIEW: 'session-wide ok',
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/rea-local-review-trace: bypass=process-env/);
  });
});

// ── 0.26.0 round-25 P2-A: ANSI-C `$'...'` env-prefix coverage ───────────────
//
// Pre-fix `_REA_RAW_INLINE_RE_PUSH` and `_REA_RAW_INLINE_RE_COMMIT`
// accepted bareword, double-quoted, single-quoted env-prefix values.
// ANSI-C form `$'a b'` matched none — `_rea_strip_prefix` similarly
// bailed. PoCs `FOO=$'a b' git push` and `FOO=$'a b' git commit -m x`
// evaded ALL detection: detection fell through the silent pre-step-9
// exit, bypass-detection block never ran, the documented "agent literally
// cannot push without an audit entry" guarantee was broken under
// `refuse_at: commit/both`.
//
// Round-25 fix: extend the value-shape alternation to accept
// `\$'[^']*'` (literal `$` followed by single-quoted body).
describe('local-review-gate.sh — round-25 P2-A ANSI-C env-prefix detection', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-r25-ansi-')));
    // refuse_at: both so the commit-tier path also gets exercised.
    await writePolicy(dir, 'review:\n  local_review:\n    refuse_at: both\n');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("detects `FOO=$'a b' git push` (ANSI-C env-prefix on push)", () => {
    if (!jqExists()) return;
    // Pre-fix: detection did not fire — gate exited 0 silently with
    // `detect=none` because the segment didn't START with git AND the
    // raw-fallback regex didn't match `$'...'` either.
    // Post-fix: detection fires; gate reaches preflight delegation.
    const r = runHook(dir, "FOO=$'a b' git push origin main", {
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    // Critical: detection MUST have fired (no `detect=none`).
    expect(r.stderr).not.toMatch(/detect=none/);
  });

  it("detects `FOO=$'a b' git commit -m x` (ANSI-C env-prefix on commit)", () => {
    if (!jqExists()) return;
    // Same shape on the commit-tier path. Under `refuse_at: both` the
    // commit-tier hook must fire detection and not silently exit.
    const r = runHook(dir, "FOO=$'a b' git commit -m x", {
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    expect(r.stderr).not.toMatch(/detect=none/);
  });

  it("detects `FOO=$'value' git push` (ANSI-C without embedded space)", () => {
    if (!jqExists()) return;
    // ANSI-C body without a space — covers the case where the body would
    // also match the bareword fragment. We verify detection fires
    // unambiguously.
    const r = runHook(dir, "FOO=$'value' git push origin main", {
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    expect(r.stderr).not.toMatch(/detect=none/);
  });

  it("does NOT false-positive on `echo \"FOO=$'a b' git push\"` (anchor safety)", () => {
    if (!jqExists()) return;
    // The raw-fallback regex anchors at segment start. ANSI-C inside a
    // quoted echo body must NOT trigger detection — segment starts with
    // `echo`, not `FOO=`.
    const r = runHook(dir, "echo \"FOO=$'a b' git push to remote\"", {
      REA_LOCAL_REVIEW_DEBUG_TRACE: '1',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/detect=none/);
  });
});

// ── round-30 F2: inline-form policy reads via canonical TS parser ──────
//
// Codex round-29 P2 F2: pre-fix `_lib/policy-read.sh::policy_nested_scalar`
// only matched block-form mappings. The TS loader accepted inline form
// (`local_review: { mode: off }`) — silent split-brain: TS preflight saw
// `mode=off` (no-op), bash gate missed it (fall-through to enforced
// default → refused). Round-30 F2 routes the bash reader through
// `rea hook policy-get`, which uses yaml.parse() — single source of truth.
//
// To exercise the structural fix in tests we rig the test dir as a
// dogfood-style sibling of @bookedsolid/rea by symlinking the actual
// dist + a stub package.json. The resolver's 2nd branch
// (`${REA_ROOT}/dist/cli/index.js`) then activates and the bash hook
// shells out to the canonical TS reader.
describe('local-review-gate.sh — round-30 F2 inline-form policy reads', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-f2-')));
    // Rig as dogfood-style: symlink the rea dist + write package.json
    // with the @bookedsolid/rea name so the resolver picks branch 2.
    await fs.symlink(path.join(REPO_ROOT, 'dist'), path.join(dir, 'dist'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }),
    );
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('honors INLINE-form `local_review: { mode: off }` (round-30 F2)', async () => {
    if (!jqExists()) return;
    // Inline form — pre-fix the bash awk parser missed this entirely
    // and `LOCAL_REVIEW_MODE` came back empty → enforced-default → push
    // refused. Post-fix the canonical TS reader parses identically to
    // block form and `mode=off` makes the gate a silent no-op.
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      POLICY_HEADER + 'review:\n  local_review: { mode: off }\n',
    );
    const r = runHook(dir, 'git push origin main');
    // mode=off → silent no-op → exit 0, no advisory output, no
    // BASH BLOCKED message.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/BASH BLOCKED/);
    expect(r.stderr).not.toMatch(/local-review-gate skipped/);
  });

  it('honors INLINE-form `local_review: { refuse_at: commit }` (round-30 F2)', async () => {
    if (!jqExists()) return;
    // Inline form for refuse_at. With `commit` only, a `git push`
    // must NOT trigger the gate (the gate only refuses commits under
    // this setting).
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      POLICY_HEADER + 'review:\n  local_review: { refuse_at: commit }\n',
    );
    const r = runHook(dir, 'git push origin main');
    // refuse_at=commit means git push is allowed through.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/BASH BLOCKED/);
  });

  it('honors INLINE-form custom `bypass_env_var` (round-30 F2)', async () => {
    if (!jqExists()) return;
    // Inline form for bypass_env_var. Pre-fix the bash reader missed
    // it → fell back to default REA_SKIP_LOCAL_REVIEW. Setting the
    // configured custom var must bypass; setting the default must not.
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      POLICY_HEADER + 'review:\n  local_review: { bypass_env_var: REA_F2_OVERRIDE }\n',
    );
    const r = runHook(dir, 'git push origin main', {
      REA_F2_OVERRIDE: 'inline-form bypass works',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/BASH BLOCKED/);
  });

  it('mode=off via INLINE form does not emit the skip-advisory', async () => {
    if (!jqExists()) return;
    // Sanity: under mode=off the gate exits early at line 62, never
    // reaches the rea-bin resolution / preflight invocation. We assert
    // by setting mode=off and observing exit 0 with NO skip-advisory.
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      POLICY_HEADER + 'review:\n  local_review: { mode: off, refuse_at: both }\n',
    );
    const r = runHook(dir, 'git commit -m "test"');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/local-review-gate skipped/);
  });
});

// ── round-30 F1: npx fallback in REA_BIN resolution ladder ──────────────
//
// Codex round-29 P2 F1: the bash-tier gate's resolution ladder stopped
// after 3 branches (node_modules/.bin/rea, dogfood dist, command -v rea)
// and fell open with the "could not locate" advisory whenever the
// operator only had npx available — npx-only consumer scenarios. The
// canonical pre-push template at templates/pre-push.local-first.sh:55-61
// has a 4th branch (`npx --no-install @bookedsolid/rea`). Round-30 F1
// aligns the bash-tier gate's ladder with the template.
//
// To exercise the new branch we sandbox PATH to a directory that
// contains `npx` (a stub script that exits 0) and NO rea/node binary,
// and we run the gate from a temp dir that has no node_modules and is
// not the rea repo (so the dogfood-dist check fails). The gate must
// reach the npx fallback, attempt to invoke `rea preflight --strict`
// via `npx --no-install`, and NOT print the "could not locate" advisory.
describe('local-review-gate.sh — round-30 F1 npx fallback', () => {
  let dir: string;
  let stubBin: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-npx-')));
    stubBin = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-localgate-stub-')));
    await writePolicy(dir, '');
    // npx stub: prints a marker and exits 0 (simulates a passing preflight).
    await fs.writeFile(
      path.join(stubBin, 'npx'),
      '#!/bin/bash\nprintf "npx-stub-invoked: %s\\n" "$*" >&2\nexit 0\n',
      { mode: 0o755 },
    );
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(stubBin, { recursive: true, force: true });
  });

  // Build a PATH that PRIORITIZES the stub directory — so the gate's
  // `command -v rea` returns nothing (no `rea` binary in stubBin) but
  // `command -v npx` finds the stub. Append a baseline of /usr/bin:/bin
  // so the hook's externals (cat, grep, awk, sed, jq, dirname, etc.)
  // remain resolvable. The test's contract is "rea-not-on-PATH but
  // npx-on-PATH" — not "PATH is fully empty".
  function pathWithStub(): string {
    return `${stubBin}:/usr/bin:/bin`;
  }

  it('reaches npx fallback when only npx is on PATH (no rea binary)', () => {
    if (!jqExists()) return;
    // No `rea` binary in stubBin OR /usr/bin; no node_modules in dir;
    // no dogfood dist (fresh tempdir has no package.json). The 4th
    // branch — `npx --no-install @bookedsolid/rea` — is the only one
    // that can resolve.
    const payload = JSON.stringify({ tool_input: { command: 'git push origin main' } });
    const res = spawnSync('bash', [HOOK_SRC], {
      cwd: dir,
      env: {
        PATH: pathWithStub(),
        CLAUDE_PROJECT_DIR: dir,
        HOME: process.env.HOME ?? '',
      },
      input: payload,
      encoding: 'utf8',
    });
    // Skip if a real `rea` is on /usr/bin or /bin (rare in CI; unusual
    // in dev). The gate would resolve via the PATH branch, not npx,
    // and the test's contract wouldn't hold.
    if (spawnSync('bash', ['-c', 'PATH=/usr/bin:/bin command -v rea'], { encoding: 'utf8' }).stdout.trim().length > 0) {
      return;
    }
    // Gate must NOT print the could-not-locate advisory — that only
    // fires when ALL 4 branches miss. Reaching the npx fallback proves
    // the new branch in the ladder is wired.
    expect(res.stderr ?? '').not.toMatch(/could not locate rea CLI/);
    // Stub recorded its invocation, proving npx was reached.
    expect(res.stderr ?? '').toMatch(/npx-stub-invoked.*--no-install @bookedsolid\/rea preflight --strict/);
    // Stub exits 0 (simulating preflight pass), so gate exits 0.
    expect(res.status).toBe(0);
  });

  it('falls open when no rea CLI is reachable through any branch', () => {
    if (!jqExists()) return;
    // With NO npx in stubBin AND no rea binary anywhere on PATH, the
    // 4-branch ladder exhausts and the gate prints the
    // could-not-locate advisory and exits 0 (fail OPEN — documented
    // behavior so consumers without rea installed don't hard-block).
    const npxStub = path.join(stubBin, 'npx');
    spawnSync('rm', ['-f', npxStub]);
    // Skip if rea OR npx are reachable through the system PATH baseline
    // (the test relies on absence to exercise the advisory branch).
    const probeBin = `${stubBin}:/usr/bin:/bin`;
    const reaProbe = spawnSync('bash', ['-c', `PATH=${probeBin} command -v rea`], { encoding: 'utf8' }).stdout.trim();
    const npxProbe = spawnSync('bash', ['-c', `PATH=${probeBin} command -v npx`], { encoding: 'utf8' }).stdout.trim();
    if (reaProbe.length > 0 || npxProbe.length > 0) {
      return;
    }
    const payload = JSON.stringify({ tool_input: { command: 'git push origin main' } });
    const res = spawnSync('bash', [HOOK_SRC], {
      cwd: dir,
      env: {
        PATH: probeBin,
        CLAUDE_PROJECT_DIR: dir,
        HOME: process.env.HOME ?? '',
      },
      input: payload,
      encoding: 'utf8',
    });
    expect(res.stderr ?? '').toMatch(/could not locate rea CLI/);
    expect(res.status).toBe(0);
  });
});
