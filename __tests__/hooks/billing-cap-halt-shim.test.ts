/**
 * End-to-end tests for `hooks/billing-cap-halt.sh` — the PostToolUse Bash
 * shim's CLI-MISSING fail-closed path (0.51.0, spend-governance E1 seed).
 *
 * Why these exist (codex 0.51.0 round-2 P2): when the rea CLI is unbuilt
 * (the common "hooks upgraded before `pnpm build`" window), the shim
 * decides fail-closed on its own. The initial cut reused the BROAD
 * relevance keyword set (`insufficient`, `billing`, …), so a failed
 * `cat billing-report.txt` or an `insufficient permissions` stderr tripped
 * a FALSE billing HALT (exit 2). The fix routes the CLI-missing path
 * through a STRICT matcher (`_billing_kw_strict`) limited to unambiguous
 * billing-wall phrases; the broad set stays only on the CLI-present perf
 * gate (where an over-trigger merely spawns the CLI).
 *
 * These assert on the strict path: a real billing wall on the ERROR
 * channel of a FAILED command still fails closed; benign failures that
 * merely mention a broad keyword do not.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BILLING_RE } from '../../src/hooks/billing-cap-halt/index.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(REPO_ROOT, 'hooks', 'billing-cap-halt.sh');

/**
 * Canonical billing-wall phrases. The CLI's BILLING_RE and the shim's
 * CLI-missing `_billing_kw_strict` MUST BOTH recognize every one — the
 * shim's fail-closed posture cannot silently drop a wall the CLI would
 * catch (codex round-3 P1). Kept in one list so the parity test below
 * fails loudly if either matcher drifts.
 */
const CANONICAL_WALLS = [
  'spending cap exceeded',
  'prepayment credits are depleted',
  'credit balance is too low',
  'insufficient_quota',
];

/**
 * Benign strings that merely resemble a wall — neither matcher may fire.
 * Includes the round-7 P2 exclusions (ambiguous app/402/business-domain
 * phrases the narrowed BILLING_RE no longer treats as billing walls).
 */
const BENIGN_NEAR_MISSES = [
  'insufficient permissions',
  'cat: billing-report.txt: No such file or directory',
  '429 too many requests',
  'rate limit exceeded',
  'payment required',
  '402 payment required',
  'insufficient funds',
  'insufficient balance',
  // Generic subscription/billing-domain errors (round-14 P2): the bare
  // word "billing" is too broad without endpoint scoping.
  'billing limit for this account exceeded',
  'billing hard cap exceeded',
];

interface ShimResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** A PostToolUse Bash payload: failed command with `stderr`, non-zero exit. */
function failedPayload(command: string, stderr: string): string {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: '', stderr, exit_code: 1 },
  });
}

/** A benign SUCCESSFUL command whose stdout mentions a phrase. */
function okStdoutPayload(command: string, stdout: string): string {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', exit_code: 0 },
  });
}

// A present, HALT-mode policy so the CLI-missing tests exercise the
// fail-closed matcher rather than the missing-file short-circuit (round-10
// P3) or the seed default `warn` (round-12 — only explicit `halt` fails
// closed in the CLI-missing window). Pass `null` for the missing-file case.
const ENABLED_POLICY = [
  'version: "1"',
  'profile: "test"',
  'installed_by: "t"',
  'blocked_paths: []',
  'spend_governance:',
  '  enabled: true',
  '  billing_error_response: halt',
  '',
].join('\n');

function runShimInUnbuiltDir(
  payload: string,
  policyYaml: string | null | undefined = undefined,
): ShimResult {
  // Simulate CLI-unreachable: point CLAUDE_PROJECT_DIR at a fresh dir with
  // no node_modules/@bookedsolid/rea AND no dist/cli/index.js, so the shim
  // takes its CLI-missing fail-closed path. Seeds an ENABLING .rea/policy.yaml
  // by default; pass an explicit string for a different policy, or `null` for
  // NO policy file (the missing-file / disabled case).
  const toWrite = policyYaml === undefined ? ENABLED_POLICY : policyYaml;
  const tmpdir = path.join(
    REPO_ROOT,
    '.claude',
    'tmp',
    `bch-shim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  spawnSync('mkdir', ['-p', tmpdir]);
  try {
    if (toWrite !== null) {
      spawnSync('mkdir', ['-p', path.join(tmpdir, '.rea')]);
      fs.writeFileSync(path.join(tmpdir, '.rea', 'policy.yaml'), toWrite);
    }
    const res = spawnSync('bash', [SHIM], {
      cwd: tmpdir,
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: tmpdir,
        HOME: process.env.HOME ?? '/tmp',
      },
      input: payload,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    spawnSync('rm', ['-rf', tmpdir]);
  }
}

const OPT_OUT_POLICY = [
  'version: "1"',
  'profile: "test"',
  'installed_by: "t"',
  'blocked_paths: []',
  'spend_governance:',
  '  enabled: false',
  '',
].join('\n');

const MODE_OFF_POLICY = [
  'version: "1"',
  'profile: "test"',
  'installed_by: "t"',
  'blocked_paths: []',
  'spend_governance:',
  '  billing_error_response: off',
  '',
].join('\n');

function bashExists(): boolean {
  return spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
}

describe('hooks/billing-cap-halt.sh — CLI-missing strict fail-closed (round-2 P2)', () => {
  it.skipIf(!bashExists())(
    'fails CLOSED (exit 2) on a genuine "spending cap" wall on stderr of a failed command',
    () => {
      const r = runShimInUnbuiltDir(failedPayload('node tts.mjs', 'Error: spending cap exceeded'));
      expect(r.status).toBe(2);
    },
  );

  it.skipIf(!bashExists())('fails CLOSED on "insufficient_quota" (machine code) on stderr', () => {
    const r = runShimInUnbuiltDir(failedPayload('node call.mjs', '{"code":"insufficient_quota"}'));
    expect(r.status).toBe(2);
  });

  it.skipIf(!bashExists())(
    'does NOT false-block on "insufficient permissions" (broad keyword, not a billing wall)',
    () => {
      const r = runShimInUnbuiltDir(failedPayload('cat /root/x', 'cat: /root/x: insufficient permissions'));
      expect(r.status).toBe(0);
    },
  );

  it.skipIf(!bashExists())(
    'does NOT false-block on a failed `cat billing-report.txt` (filename mentions "billing")',
    () => {
      const r = runShimInUnbuiltDir(
        failedPayload('cat billing-report.txt', 'cat: billing-report.txt: No such file or directory'),
      );
      expect(r.status).toBe(0);
    },
  );

  it.skipIf(!bashExists())(
    'does NOT scan a SUCCESSFUL command stdout that merely prints "spending cap"',
    () => {
      const r = runShimInUnbuiltDir(okStdoutPayload('cat THREAT_MODEL.md', 'the spending cap wall …'));
      expect(r.status).toBe(0);
    },
  );

  it.skipIf(!bashExists())(
    'does NOT fail closed when a FAILED command prints billing text to STDOUT with benign stderr (round-4 P1 grep case)',
    () => {
      const payload = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'grep -R "spending cap" docs missing_dir' },
        tool_response: {
          stdout: 'docs/THREAT_MODEL.md: the spending cap wall',
          stderr: 'grep: missing_dir: No such file or directory',
          exit_code: 2,
        },
      });
      const r = runShimInUnbuiltDir(payload);
      expect(r.status).toBe(0);
    },
  );

  it.skipIf(!bashExists())(
    'does NOT fail closed when a SUCCESSFUL command logs a billing phrase to stderr (round-7 P1/P3)',
    () => {
      const payload = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'node print-example.mjs' },
        tool_response: {
          stdout: '',
          stderr: 'example provider response: spending cap exceeded',
          exit_code: 0,
        },
      });
      const r = runShimInUnbuiltDir(payload);
      expect(r.status).toBe(0);
    },
  );
});

describe('billing-cap-halt CLI-missing opt-out (round-8 P2)', () => {
  // The CLI-missing fail-closed path must honor an explicit opt-out via the
  // Tier 2/3 policy reader (no CLI needed). A real billing wall on a failed
  // command's stderr that WOULD fail closed must exit 0 when the policy
  // opted out.
  it.skipIf(!bashExists())('enabled:false → no fail-closed refusal even on a real wall', () => {
    const r = runShimInUnbuiltDir(
      failedPayload('node tts.mjs', 'FATAL: spending cap exceeded'),
      OPT_OUT_POLICY,
    );
    expect(r.status).toBe(0);
  });

  it.skipIf(!bashExists())('billing_error_response:off → no fail-closed refusal', () => {
    const r = runShimInUnbuiltDir(
      failedPayload('node tts.mjs', 'FATAL: spending cap exceeded'),
      MODE_OFF_POLICY,
    );
    expect(r.status).toBe(0);
  });

  it.skipIf(!bashExists())(
    'no block (no positive opt-out) → fail-closed refuse in the CLI-missing window (round-13 P1)',
    () => {
      // A present policy with no spend_governance block is NOT a positive
      // opt-out. The shim can't deliver `warn` without the CLI, so it errs
      // toward protection: a transient exit-2 refuse until the CLI is built.
      const withBlockAbsent = [
        'version: "1"',
        'profile: "test"',
        'installed_by: "t"',
        'blocked_paths: []',
        '',
      ].join('\n');
      const r = runShimInUnbuiltDir(
        failedPayload('node tts.mjs', 'FATAL: spending cap exceeded'),
        withBlockAbsent,
      );
      expect(r.status).toBe(2);
    },
  );

  it.skipIf(!bashExists())(
    'unreadable/flow-form mode (no positive opt-out) → still fails closed (round-13 P1)',
    () => {
      // Flow-form block the Tier-3 awk fallback can't parse: the mode is
      // unreadable, but it is NOT a positive opt-out, so fail-closed is
      // preserved rather than silently dropped.
      const flowForm = [
        'version: "1"',
        'profile: "test"',
        'installed_by: "t"',
        'blocked_paths: []',
        'spend_governance: { enabled: true, billing_error_response: halt }',
        '',
      ].join('\n');
      const r = runShimInUnbuiltDir(
        failedPayload('node tts.mjs', 'FATAL: spending cap exceeded'),
        flowForm,
      );
      expect(r.status).toBe(2);
    },
  );

  it.skipIf(!bashExists())(
    'MISSING policy file → disabled (no refusal), matching readSpendGovernance (round-10 P3)',
    () => {
      const r = runShimInUnbuiltDir(
        failedPayload('node tts.mjs', 'FATAL: spending cap exceeded'),
        null, // no .rea/policy.yaml at all
      );
      expect(r.status).toBe(0);
    },
  );

  it.skipIf(!bashExists())(
    'recognizes success:false (Claude Code Bash failure signal) on the CLI-missing path (round-10 P1)',
    () => {
      const payload = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'node tts.mjs' },
        tool_response: { stdout: '', stderr: 'FATAL: spending cap exceeded', success: false },
      });
      const r = runShimInUnbuiltDir(payload);
      expect(r.status).toBe(2);
    },
  );

  it.skipIf(!bashExists())('success:true with a billing phrase on stderr → no refusal', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'node print-example.mjs' },
      tool_response: { stdout: '', stderr: 'example: spending cap exceeded', success: true },
    });
    const r = runShimInUnbuiltDir(payload);
    expect(r.status).toBe(0);
  });
});

describe('billing-cap-halt matcher parity — shim strict set ⇔ CLI BILLING_RE (round-3 P1)', () => {
  // Every canonical wall must be caught by BOTH matchers. This is the sync
  // guard the shim comment references: if BILLING_RE or _billing_kw_strict
  // drifts so a documented wall stops failing closed in the no-CLI window,
  // one of these assertions breaks.
  for (const phrase of CANONICAL_WALLS) {
    it(`BILLING_RE matches "${phrase}"`, () => {
      expect(BILLING_RE.test(phrase)).toBe(true);
    });
    it.skipIf(!bashExists())(`shim fails closed (CLI-missing) on "${phrase}"`, () => {
      const r = runShimInUnbuiltDir(failedPayload('node call.mjs', `Error: ${phrase}`));
      expect(r.status).toBe(2);
    });
  }

  for (const phrase of BENIGN_NEAR_MISSES) {
    it(`BILLING_RE does NOT match "${phrase}"`, () => {
      expect(BILLING_RE.test(phrase)).toBe(false);
    });
    it.skipIf(!bashExists())(`shim does NOT fail closed (CLI-missing) on "${phrase}"`, () => {
      const r = runShimInUnbuiltDir(failedPayload('cmd', phrase));
      expect(r.status).toBe(0);
    });
  }
});

/**
 * codex round-25 F1 — the shim's PRE-CLI policy reads must follow the
 * POST-HANDOFF `REA_ROOT` (the payload worktree), NOT `CLAUDE_PROJECT_DIR`
 * (the primary checkout). `shim_run` runs `shim_worktree_handoff` (step 2b)
 * BEFORE both the `shim_is_relevant` gate (`_turn_budget_configured`, step 3)
 * and the CLI-missing `shim_policy_short_circuit` (billing opt-out) read —
 * so in a linked-worktree session those reads must hit the worktree's own
 * `.rea/policy.yaml`, matching where the node hook's `readSpendGovernance`
 * resolves (payload cwd → worktree).
 *
 * OBSERVABILITY NOTE: only the billing opt-out read is DISTINGUISHABLE in the
 * CLI-missing harness. `_turn_budget_configured`'s sole effect is to force the
 * relevance gate to PROCEED to the CLI; with no billing keyword + no CLI, both
 * "proceed" and "skip" terminate at exit 0, so its root choice is not
 * independently observable here. It uses the IDENTICAL `${REA_ROOT}` read
 * under the same handoff-then-read ordering, so this test (which proves the
 * ordering + REA_ROOT selection via the billing read) stands in for both.
 * A fully observable turn-budget-counts assertion needs a CLI-PRESENT
 * worktree e2e, out of scope for this CLI-missing shim harness.
 */
function gitExists(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

/** Run the shim inside a REAL linked git worktree whose `.rea/policy.yaml`
 *  differs from the primary checkout's. CLI is missing (tmp tree has no dist /
 *  node_modules), so the CLI-missing path exercises the pre-CLI policy read. */
function runShimInWorktree(opts: {
  primaryPolicy: string | null;
  worktreePolicy: string | null;
  payloadStderr: string;
}): ShimResult {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-wt-'));
  const primary = path.join(base, 'primary');
  const worktree = path.join(base, 'wt');
  const git = (args: string[]): void => {
    execFileSync('git', args, { stdio: 'ignore' });
  };
  try {
    fs.mkdirSync(primary, { recursive: true });
    git(['init', '-q', primary]);
    git(['-C', primary, 'config', 'user.email', 't@t']);
    git(['-C', primary, 'config', 'user.name', 't']);
    git(['-C', primary, 'config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(primary, 'seed'), 'x');
    git(['-C', primary, 'add', '.']);
    git(['-C', primary, 'commit', '-qm', 'init']);
    fs.mkdirSync(path.join(primary, '.rea'), { recursive: true });
    if (opts.primaryPolicy !== null) {
      fs.writeFileSync(path.join(primary, '.rea', 'policy.yaml'), opts.primaryPolicy);
    }
    // Linked worktree of `primary` (shares its git common dir → the handoff's
    // same-repo guard is satisfied and REA_ROOT hands over to the worktree).
    git(['-C', primary, 'worktree', 'add', '-q', worktree]);
    fs.mkdirSync(path.join(worktree, '.rea'), { recursive: true });
    if (opts.worktreePolicy !== null) {
      fs.writeFileSync(path.join(worktree, '.rea', 'policy.yaml'), opts.worktreePolicy);
    }
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'node metered-call.mjs' },
      tool_response: { stdout: '', stderr: opts.payloadStderr, exit_code: 1 },
      // Top-level cwd = the linked worktree → drives shim_worktree_handoff.
      cwd: worktree,
    });
    const res = spawnSync('bash', [SHIM], {
      cwd: worktree,
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: primary,
        HOME: process.env.HOME ?? '/tmp',
      },
      input: payload,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    // `git worktree add` leaves an administrative link; rm -rf the whole base.
    fs.rmSync(base, { recursive: true, force: true });
  }
}

describe('hooks/billing-cap-halt.sh — worktree handoff pre-CLI policy read (round-25 F1)', () => {
  const HALT_POLICY = [
    'version: "1"',
    'profile: "test"',
    'installed_by: "t"',
    'blocked_paths: []',
    'spend_governance:',
    '  enabled: true',
    '  billing_error_response: halt',
    '',
  ].join('\n');
  const OPT_OUT = [
    'version: "1"',
    'profile: "test"',
    'installed_by: "t"',
    'blocked_paths: []',
    'spend_governance:',
    '  enabled: false',
    '',
  ].join('\n');

  it.skipIf(!bashExists() || !gitExists())(
    'reads the WORKTREE policy (fail-closed halt) even when the PRIMARY has NO policy — proves REA_ROOT, not CLAUDE_PROJECT_DIR',
    () => {
      // Before the fix the existence check probed CLAUDE_PROJECT_DIR (primary,
      // no policy.yaml) → treated as disabled → exit 0. After the fix it probes
      // the post-handoff REA_ROOT (worktree, halt policy) → reader reads halt →
      // fail-closed on the billing wall → exit 2.
      const r = runShimInWorktree({
        primaryPolicy: null,
        worktreePolicy: HALT_POLICY,
        payloadStderr: 'Error: spending cap exceeded',
      });
      expect(r.status).toBe(2);
    },
  );

  it.skipIf(!bashExists() || !gitExists())(
    'honors a WORKTREE opt-out (enabled:false) even when the PRIMARY policy would fail closed',
    () => {
      // The worktree explicitly opted out; a billing wall must NOT fail closed,
      // regardless of the primary checkout's stricter policy.
      const r = runShimInWorktree({
        primaryPolicy: HALT_POLICY,
        worktreePolicy: OPT_OUT,
        payloadStderr: 'Error: spending cap exceeded',
      });
      expect(r.status).toBe(0);
    },
  );
});

/**
 * codex round-30 — turn-budget shim wiring. Two P1s:
 *   F1: turn-budget must not go silently dead when billing is opted out — the
 *       billing opt-out short-circuit must NOT fire when a `turn_budget` is
 *       configured AND the CLI is resolvable (proceed → the TS hook counts).
 *   F2: an OPT-IN counter must never BRICK a no-CLI session — the turn-budget
 *       relevance-force fails OPEN (exit 0) when `rea` can't be resolved, while
 *       a real billing keyword keeps its fail-closed posture.
 */
const TB_HALT_POLICY = (billingEnabled: boolean, mode = 'warn'): string =>
  [
    'version: "1"',
    'profile: "test"',
    'installed_by: "t"',
    'blocked_paths: []',
    'spend_governance:',
    `  enabled: ${billingEnabled ? 'true' : 'false'}`,
    `  billing_error_response: ${mode}`,
    '  turn_budget:',
    '    warn_turns: 5',
    '    halt_turns: 10',
    '',
  ].join('\n');
const NO_TB_OPTOUT_POLICY = [
  'version: "1"',
  'profile: "test"',
  'installed_by: "t"',
  'blocked_paths: []',
  'spend_governance:',
  '  enabled: false',
  '',
].join('\n');

/**
 * F1 harness — CLI PRESENT via a FAKE `dist/cli/index.js` that records the
 * forward (writes $MARKER when invoked as `hook billing-cap-halt`) and answers
 * the `--help` version probe. An ancestor package.json named `@bookedsolid/rea`
 * + a real (non-symlink) CLI file passes the shim sandbox. `forwarded === true`
 * means the shim PROCEEDED to the CLI (did not short-circuit). Policy reads are
 * pinned to Tier-3 awk so the fake CLI is only ever hit for the probe + forward.
 */
function runShimFakeCli(policy: string, payload: string): { status: number; forwarded: boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-cli-'));
  try {
    fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"@bookedsolid/rea"}\n');
    fs.writeFileSync(path.join(dir, '.rea', 'policy.yaml'), policy);
    const fake =
      [
        '#!/usr/bin/env node',
        'const fs=require("fs");const a=process.argv.slice(2);',
        'if(a.includes("--help")){process.stdout.write("billing-cap-halt\\n");process.exit(0);}',
        'if(a[0]==="hook"&&a[1]==="billing-cap-halt"){if(process.env.MARKER)fs.writeFileSync(process.env.MARKER,"x");process.exit(0);}',
        'process.exit(0);',
      ].join('\n') + '\n';
    const cli = path.join(dir, 'dist', 'cli', 'index.js');
    fs.writeFileSync(cli, fake);
    fs.chmodSync(cli, 0o755);
    const marker = path.join(dir, 'FORWARDED');
    const res = spawnSync('bash', [SHIM], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: dir,
        HOME: process.env.HOME ?? '/tmp',
        MARKER: marker,
        POLICY_READER_FORCE_TIER: 'awk',
      },
      input: payload,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: res.status ?? -1, forwarded: fs.existsSync(marker) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * F2 harness — the CLI RESOLVES but FAILS the sandbox (a `dist/cli/index.js`
 * symlink escaping the project), which clears REA_ARGV + sets sandbox_failed.
 * This is a genuine no-CLI BRICK path: shim-runtime step 7 exits 2 on
 * sandbox_failed BEFORE the billing relevance check, so a turn-budget-forced
 * benign payload would lock out without the F2 fail-open.
 */
function runShimSandboxEscape(policy: string, payload: string): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-esc-'));
  try {
    fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.rea', 'policy.yaml'), policy);
    fs.symlinkSync('/etc/hostname', path.join(dir, 'dist', 'cli', 'index.js'));
    const res = spawnSync('bash', [SHIM], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: dir,
        HOME: process.env.HOME ?? '/tmp',
      },
      input: payload,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return res.status ?? -1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BENIGN_READ = JSON.stringify({
  tool_name: 'Read',
  tool_input: { file_path: '/x' },
  tool_response: { type: 'text' },
});

describe('hooks/billing-cap-halt.sh — turn-budget shim wiring (round-30 F1/F2)', () => {
  it.skipIf(!bashExists())(
    'F1: billing enabled:false + turn_budget + CLI present → PROCEEDS to the CLI (counter runs, not short-circuited)',
    () => {
      const r = runShimFakeCli(TB_HALT_POLICY(false), BENIGN_READ);
      expect(r.forwarded).toBe(true);
    },
  );

  it.skipIf(!bashExists())(
    'F1: billing_error_response:off + turn_budget + CLI present → PROCEEDS to the CLI',
    () => {
      const r = runShimFakeCli(TB_HALT_POLICY(true, 'off'), BENIGN_READ);
      expect(r.forwarded).toBe(true);
    },
  );

  it.skipIf(!bashExists())(
    'F1 control: billing opted out + NO turn_budget → short-circuits (does NOT forward to the CLI)',
    () => {
      const wall = failedPayload('meter', 'Error: spending cap exceeded');
      const r = runShimFakeCli(NO_TB_OPTOUT_POLICY, wall);
      expect(r.forwarded).toBe(false);
    },
  );

  it.skipIf(!bashExists())(
    'F2: turn_budget + CLI missing (unbuilt) + benign → exit 0 (fail open, no lockout on the first call)',
    () => {
      const r = runShimInUnbuiltDir(BENIGN_READ, TB_HALT_POLICY(true));
      expect(r.status).toBe(0);
    },
  );

  it.skipIf(!bashExists())(
    'F2: turn_budget + CLI sandbox-FAILS + benign → exit 0 (fail open on the brick path, not the step-7 refusal)',
    () => {
      expect(runShimSandboxEscape(TB_HALT_POLICY(true), BENIGN_READ)).toBe(0);
    },
  );

  it.skipIf(!bashExists())(
    'F2 billing path UNCHANGED: a real billing wall + turn_budget + no CLI still fails closed (exit 2)',
    () => {
      const wall = failedPayload('meter', 'Error: spending cap exceeded');
      // Even with a turn_budget configured, a genuine wall keeps the
      // fail-closed posture — the fail-open only covers turn-budget-ONLY force.
      expect(runShimSandboxEscape(TB_HALT_POLICY(true, 'halt'), wall)).toBe(2);
    },
  );

  it.skipIf(!bashExists())(
    'F2 billing path UNCHANGED: a real billing wall + no turn_budget + no CLI still fails closed (exit 2)',
    () => {
      const wall = failedPayload('meter', 'Error: spending cap exceeded');
      expect(runShimSandboxEscape(NO_TB_OPTOUT_POLICY.replace('enabled: false', 'enabled: true\n  billing_error_response: halt'), wall)).toBe(2);
    },
  );
});
