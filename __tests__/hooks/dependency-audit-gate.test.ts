/**
 * Tests for `hooks/dependency-audit-gate.sh`.
 *
 * 0.15.0 fix: pre-0.15.0 the parser ran a single grep against the entire
 * bash command string with no segment boundary anchor. A heredoc body or
 * commit-message containing `pnpm install` (e.g. inside
 * `git commit -m "$(cat <<EOF ... pnpm install ... EOF)"`) matched the
 * grep, the `.*` in the sed stripped up to that occurrence, and the rest
 * of the command (`chore:`, `&&`, `||`, etc.) was passed to `npm view
 * <token> name` and reported as missing packages — refusing the commit.
 *
 * These tests pin the new segment-anchored parser. The full network-bound
 * `npm view` lookup is exercised by the integration smoke test; here we
 * focus on parser behavior — exit 0 on commands that should NOT trigger
 * the audit at all.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'dependency-audit-gate.sh');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(command: string): HookResult {
  const payload = JSON.stringify({ tool_input: { command } });
  const res = spawnSync('bash', [HOOK_SRC], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: REPO_ROOT },
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

describe('dependency-audit-gate.sh — segment anchoring (0.15.0 fix)', () => {
  it('does NOT match `pnpm install` inside a heredoc body', () => {
    if (!jqExists()) return;
    // Pre-fix: the greedy regex matched anywhere; sed stripped to the
    // heredoc occurrence; the remaining "EOF" / commit-message chunks
    // were treated as packages and the hook refused the commit.
    const cmd =
      'git commit -m "$(cat <<\'EOF\'\nchore: bump deps\n\nThis fix lands pnpm install behavior in the hook tests.\n\n- Co-authored-by: bot\nEOF\n)"';
    const res = runHook(cmd);
    expect(res.status).toBe(0);
  });

  it('does NOT match `npm install` inside a single-line commit message', () => {
    if (!jqExists()) return;
    const cmd = 'git commit -m "fix: prevent npm install from running on CI"';
    const res = runHook(cmd);
    expect(res.status).toBe(0);
  });

  it('does NOT match `yarn add` mentioned in an echo / printf statement', () => {
    if (!jqExists()) return;
    const cmd = 'echo "Use yarn add for legacy projects" > docs/install.md';
    const res = runHook(cmd);
    expect(res.status).toBe(0);
  });

  it('does NOT match install commands inside a `--message` argument across `&&`', () => {
    if (!jqExists()) return;
    const cmd =
      'git status && git diff --stat && git commit -m "doc: explain why pnpm install fails on the offline runner"';
    const res = runHook(cmd);
    expect(res.status).toBe(0);
  });

  it('passes through bare `npm install` (no new packages — no audit needed)', () => {
    if (!jqExists()) return;
    // No tokens after "install" → nothing to audit → exit 0.
    const res = runHook('npm install');
    expect(res.status).toBe(0);
  });

  it('passes through `npm ci` (not an install with new packages)', () => {
    if (!jqExists()) return;
    const res = runHook('npm ci');
    expect(res.status).toBe(0);
  });

  it('passes through `pnpm install` (lockfile install — no new packages)', () => {
    if (!jqExists()) return;
    const res = runHook('pnpm install');
    expect(res.status).toBe(0);
  });

  it('skips workspace: / link: / file: prefixed deps (not npm registry)', () => {
    if (!jqExists()) return;
    // These are workspace protocols / local paths — they're not npm
    // registry packages and `npm view` would fail-loud on them. Skipping
    // them prevents false-fail on legitimate workspace adds.
    const res = runHook('pnpm add workspace:my-pkg link:../local file:./tarball.tgz');
    expect(res.status).toBe(0);
  });

  it('skips relative-path arguments (./local, /abs, ../up)', () => {
    if (!jqExists()) return;
    const res = runHook('npm install ./local-tarball.tgz /tmp/foo ../sibling');
    expect(res.status).toBe(0);
  });

  it('skips flag arguments (--save-dev, -D, --workspace)', () => {
    if (!jqExists()) return;
    const res = runHook('npm install --save-dev --workspace=app -D');
    expect(res.status).toBe(0);
  });
});

describe('dependency-audit-gate.sh — positive-path detection (codex P1+P3 regression)', () => {
  // The 0.15.0 codex round-1 review caught two gaps:
  //   P1-1: `pnpm i <pkg>` was not recognized — `i` alias for `install`
  //         missing from the pnpm alternation. Real packages went
  //         unaudited.
  //   P3-2: the original test suite asserted only false-positive
  //         prevention; never asserted that real installs ARE
  //         detected. P1-1 slipped through review because of P3-2.
  //
  // These tests pin the positive path. We exercise the parser by
  // pointing it at a registry-typo-squat that does not exist and
  // asserting status != 0 — the only way the hook fails on a
  // non-existent package is if it ACTUALLY ran the audit.
  //
  // The package name `@bookedsolid-typosquat-test/does-not-exist-on-npm`
  // is namespaced under our org so a malicious squatter cannot register
  // it later and turn this test green falsely. The npm view will
  // network out; we accept that as a real network requirement for
  // these regression tests (skip when offline).
  const FAKE_PKG = '@bookedsolid-typosquat-test/does-not-exist-on-npm';

  function networkAvailable(): boolean {
    const res = spawnSync(
      'curl',
      ['-fsS', '--max-time', '5', 'https://registry.npmjs.org/-/ping'],
      {
        encoding: 'utf8',
      },
    );
    return res.status === 0;
  }

  it('detects npm install <pkg>', () => {
    if (!jqExists() || !networkAvailable()) return;
    const res = runHook(`npm install ${FAKE_PKG}`);
    expect(res.status).not.toBe(0);
  });

  it('detects npm i <pkg>', () => {
    if (!jqExists() || !networkAvailable()) return;
    const res = runHook(`npm i ${FAKE_PKG}`);
    expect(res.status).not.toBe(0);
  });

  it('detects pnpm add <pkg>', () => {
    if (!jqExists() || !networkAvailable()) return;
    const res = runHook(`pnpm add ${FAKE_PKG}`);
    expect(res.status).not.toBe(0);
  });

  it('detects pnpm install <pkg>', () => {
    if (!jqExists() || !networkAvailable()) return;
    const res = runHook(`pnpm install ${FAKE_PKG}`);
    expect(res.status).not.toBe(0);
  });

  it('detects pnpm i <pkg> (codex P1-1 regression — was bypassed pre-0.15.0)', () => {
    if (!jqExists() || !networkAvailable()) return;
    // Pre-fix: `pnpm i` did not match the install regex (only `add` and
    // `install` were in the pnpm alternation). The package went
    // unaudited — silent supply-chain bypass.
    const res = runHook(`pnpm i ${FAKE_PKG}`);
    expect(res.status).not.toBe(0);
  });

  it('detects yarn add <pkg>', () => {
    if (!jqExists() || !networkAvailable()) return;
    const res = runHook(`yarn add ${FAKE_PKG}`);
    expect(res.status).not.toBe(0);
  });
});
