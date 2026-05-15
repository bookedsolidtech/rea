/**
 * Tests for `hooks/delegation-advisory.sh` (0.31.0).
 *
 * The shell hook is a thin PostToolUse shim: read stdin, resolve +
 * sandbox-check the rea CLI, pipe the payload to
 * `rea hook delegation-advisory` SYNCHRONOUSLY (the advisory text must
 * reach stderr before the hook returns), exit with the CLI's code.
 *
 * These tests pin the shim's contract — exit codes, the silent-drop
 * bootstrap path, the sandbox-refusal breadcrumb, and the HALT
 * kill-switch. The advisory-firing LOGIC is covered exhaustively by
 * `__tests__/cli/delegation-advisory.test.ts`; here we only verify the
 * shell shim wires stdin → CLI → exit code correctly.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'delegation-advisory.sh');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(payload: string, reaRoot: string): HookResult {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    CLAUDE_PROJECT_DIR: reaRoot,
  };
  const res = spawnSync('bash', [HOOK_SRC], {
    cwd: reaRoot,
    env,
    input: payload,
    encoding: 'utf8',
    timeout: 8000,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function mkTempProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-deleg-adv-hook-')));
  fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
  return dir;
}

describe('delegation-advisory.sh — exit-fast contract', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkTempProject();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 0 on a write-class payload when no rea binary is in scope (silent bootstrap drop)', () => {
    // Tempdir has no node_modules/@bookedsolid/rea and no dist/cli/
    // index.js — the shim cannot resolve a sandboxed CLI and drops the
    // advisory silently. No stderr noise on this expected path.
    const payload = JSON.stringify({ tool_name: 'Write', session_id: 's1' });
    const res = runHook(payload, projectDir);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('exits 0 on a Bash payload when no rea binary is in scope', () => {
    // The matcher includes Bash — the nudge counts every write-class
    // tool call. The shim is matcher-agnostic; it never refuses.
    const payload = JSON.stringify({ tool_name: 'Bash', session_id: 's1' });
    const res = runHook(payload, projectDir);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('exits 0 on empty stdin', () => {
    const res = runHook('', projectDir);
    expect(res.status).toBe(0);
  });
});

describe('delegation-advisory.sh — trust boundary', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkTempProject();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('refuses to invoke a forged dist/cli/index.js without a matching package.json', () => {
    // Stage a tempdir that LOOKS like the rea dogfood (dist/cli/
    // index.js exists) but has NO ancestor package.json declaring
    // @bookedsolid/rea. The sandbox check fails and the advisory is
    // dropped with a stderr breadcrumb — exit 0 (advisory, never
    // gating).
    fs.mkdirSync(path.join(projectDir, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'dist', 'cli', 'index.js'),
      '#!/usr/bin/env node\nprocess.exit(0);\n',
    );
    const payload = JSON.stringify({ tool_name: 'Write', session_id: 's1' });
    const res = runHook(payload, projectDir);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('sandbox check');
  });
});

describe('delegation-advisory.sh — HALT contract', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkTempProject();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 2 when .rea/HALT exists (kill-switch wins, uniform with the hook tree)', () => {
    fs.writeFileSync(path.join(projectDir, '.rea', 'HALT'), 'frozen for test\n');
    const payload = JSON.stringify({ tool_name: 'Write', session_id: 's1' });
    const res = runHook(payload, projectDir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('REA HALT');
  });
});

describe('delegation-advisory.sh — full chain against the rea dogfood CLI', () => {
  // The shim resolves the rea CLI via `<proj>/dist/cli/index.js` when
  // `proj` IS the rea repo (the dogfood case). We exercise that by
  // pointing CLAUDE_PROJECT_DIR at the repo root itself — the same
  // path the rea repo's own install hits. The .rea/ state writes land
  // in a tempdir copy so the real .rea/audit.jsonl is never touched:
  // we run with `proj` = a tempdir that has a real dist/cli/index.js
  // copied in plus a package.json declaring @bookedsolid/rea, so the
  // sandbox check (realpath stays inside proj + ancestor package.json)
  // passes legitimately.
  const distCli = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkTempProject();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  /**
   * Stage a self-contained "rea dogfood" inside `projectDir`: copy the
   * built dist/ tree in and write a package.json named
   * `@bookedsolid/rea`. The shim's sandbox check then passes because
   * realpath(cli) stays inside realpath(projectDir) AND an ancestor
   * package.json declares the protected name — no symlink-out.
   */
  function stageDogfoodCli(): boolean {
    if (!fs.existsSync(distCli)) return false; // build not present — skip
    // Copy the built dist/ tree in so realpath(cli) stays inside
    // realpath(projectDir) — the sandbox check's first gate.
    fs.cpSync(path.join(REPO_ROOT, 'dist'), path.join(projectDir, 'dist'), {
      recursive: true,
    });
    // Symlink node_modules so the staged CLI can `require('yaml')`.
    // The sandbox check realpath-gates the CLI FILE path only, not
    // node_modules — a symlinked node_modules is fine and keeps the
    // stage cheap (no multi-hundred-MB copy).
    fs.symlinkSync(
      path.join(REPO_ROOT, 'node_modules'),
      path.join(projectDir, 'node_modules'),
      'dir',
    );
    // package.json declaring the protected name — the sandbox check's
    // second gate (ancestor package.json with name @bookedsolid/rea).
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }),
    );
    return true;
  }

  it('drives the real CLI: disabled policy → exit 0, no advisory, no state dir', () => {
    if (!stageDogfoodCli()) return;
    // No .rea/policy.yaml → CLI resolves policy as disabled → exits 0,
    // writes no state.
    const payload = JSON.stringify({ tool_name: 'Write', session_id: 'chain-test' });
    const res = runHook(payload, projectDir);
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(projectDir, '.rea', '.delegation-advisory'))).toBe(false);
  });

  it('drives the real CLI: enabled policy below threshold → exit 0, counter written', () => {
    if (!stageDogfoodCli()) return;
    fs.writeFileSync(
      path.join(projectDir, '.rea', 'policy.yaml'),
      'delegation_advisory:\n  enabled: true\n  threshold: 5\n',
    );
    const payload = JSON.stringify({ tool_name: 'Write', session_id: 'chain-test' });
    const res = runHook(payload, projectDir);
    expect(res.status).toBe(0);
    // The counter file exists with value 1 — the shim resolved +
    // sandbox-checked the CLI, and the CLI bumped the counter. The
    // basename is `sessionStateKey('chain-test')` = a readable prefix
    // plus a sha256 hash suffix; rather than recompute the hash here we
    // assert on the single `.count` file the state dir contains.
    const stateDir = path.join(projectDir, '.rea', '.delegation-advisory');
    expect(fs.existsSync(stateDir)).toBe(true);
    const countFiles = fs.readdirSync(stateDir).filter((n) => n.endsWith('.count'));
    expect(countFiles).toHaveLength(1);
    // The readable prefix half is still glanceable in the basename.
    expect(countFiles[0]).toMatch(/^chain-test-[0-9a-f]{16}\.count$/);
    expect(fs.readFileSync(path.join(stateDir, countFiles[0]!), 'utf8').trim()).toBe('1');
  });
});
