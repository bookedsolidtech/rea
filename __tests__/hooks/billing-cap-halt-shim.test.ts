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

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(REPO_ROOT, 'hooks', 'billing-cap-halt.sh');

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
