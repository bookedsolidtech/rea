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

import { spawnSync } from 'node:child_process';
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
  'insufficient funds',
  'insufficient credits',
  'insufficient balance',
  'insufficient_quota',
  'payment required',
  'billing hard limit exceeded',
  'billing cap reached',
];

/** Benign strings that merely resemble a wall — neither matcher may fire. */
const BENIGN_NEAR_MISSES = [
  'insufficient permissions',
  'cat: billing-report.txt: No such file or directory',
  '429 too many requests',
  'rate limit exceeded',
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

function runShimInUnbuiltDir(payload: string): ShimResult {
  // Simulate CLI-unreachable: point CLAUDE_PROJECT_DIR at a fresh dir with
  // no node_modules/@bookedsolid/rea AND no dist/cli/index.js, so the shim
  // takes its CLI-missing fail-closed path.
  const tmpdir = path.join(
    REPO_ROOT,
    '.claude',
    'tmp',
    `bch-shim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  spawnSync('mkdir', ['-p', tmpdir]);
  try {
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
