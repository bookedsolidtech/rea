/**
 * Tests for `hooks/delegation-capture.sh` (0.29.0).
 *
 * The shell hook is intentionally minimal: read stdin, pipe to
 * `rea hook delegation-signal --detach` (backgrounded + disowned),
 * exit 0. These tests pin:
 *
 *   - exit 0 on Agent payload
 *   - exit 0 on Skill payload
 *   - exit 0 on non-delegation payload (the hook is matcher-agnostic;
 *     filtering happens in the CLI subcommand)
 *   - exit 2 when HALT is active (kill-switch contract uniform with
 *     the rest of the hook tree)
 *   - exit 0 when no rea binary is in scope (signal dropped silently)
 *
 * Matcher routing is enforced by Claude Code via the `Agent|Skill`
 * matcher in `.claude/settings.json` — verified separately by the
 * settings-merge / contract tests.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'delegation-capture.sh');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the hook in a fresh tempdir as $CLAUDE_PROJECT_DIR so the
 * audit-write path is sandboxed. PATH is stripped down to the test's
 * minimum so the hook's "no rea binary in scope" branch can be
 * exercised by toggling whether node_modules/.bin/rea exists.
 */
function runHook(
  payload: string,
  options: { reaRoot: string; haltActive?: boolean; reaBinPresent?: boolean } = {
    reaRoot: '',
  },
): HookResult {
  // Inherit the parent PATH so `node` is available for the
  // realpath-sandbox check. We deliberately do NOT strip PATH —
  // the hook's threat model is "untrusted CLI path via $PATH" not
  // "untrusted node binary" (the latter is the system platform).
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    CLAUDE_PROJECT_DIR: options.reaRoot,
  };
  const res = spawnSync('bash', [HOOK_SRC], {
    cwd: options.reaRoot,
    env,
    input: payload,
    encoding: 'utf8',
    timeout: 5000,
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

function mkTempProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-deleg-hook-')));
  fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
  return dir;
}

describe('delegation-capture.sh — exit-fast contract', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkTempProject();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 0 on an Agent payload', () => {
    if (!jqExists()) return;
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'rea-orchestrator', description: 'plan' },
    });
    const res = runHook(payload, { reaRoot: projectDir });
    expect(res.status).toBe(0);
  });

  it('exits 0 on a Skill payload', () => {
    if (!jqExists()) return;
    const payload = JSON.stringify({
      tool_name: 'Skill',
      session_id: 's',
      tool_input: { skill: 'deep-dive', prompt: 'investigate' },
    });
    const res = runHook(payload, { reaRoot: projectDir });
    expect(res.status).toBe(0);
  });

  it('exits 0 on a non-delegation payload (Bash) — the hook is matcher-agnostic', () => {
    // Production filtering happens via the .claude/settings.json
    // matcher; the hook itself doesn't gate by tool_name. We still
    // pin exit 0 here so a misconfigured matcher can't cause a refuse
    // loop on every Bash command.
    if (!jqExists()) return;
    const payload = JSON.stringify({
      tool_name: 'Bash',
      session_id: 's',
      tool_input: { command: 'ls' },
    });
    const res = runHook(payload, { reaRoot: projectDir });
    expect(res.status).toBe(0);
  });

  it('exits 0 silently when no rea binary is in scope', () => {
    if (!jqExists()) return;
    // Stripped-down PATH; no node_modules/.bin/rea in projectDir.
    // The hook should drop the signal silently (no stderr noise).
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'agent-x', description: '' },
    });
    const res = runHook(payload, { reaRoot: projectDir });
    expect(res.status).toBe(0);
    // No stderr lines on the bootstrap-state silent-drop path.
    expect(res.stderr).toBe('');
  });
});

describe('delegation-capture.sh — trust-boundary (Codex round 3 P1)', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkTempProject();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('silently drops the signal when CLI is found via PATH only (no node_modules)', () => {
    // Pre-fix the hook would have used the PATH-found `rea` and
    // executed attacker-controlled code on every Agent/Skill dispatch
    // in a consumer repo with a forged `rea` binary on PATH. Post-fix
    // it requires CLI under $CLAUDE_PROJECT_DIR/node_modules/
    // @bookedsolid/rea/dist/cli/index.js OR
    // $CLAUDE_PROJECT_DIR/dist/cli/index.js with a matching
    // package.json ancestor. The tempdir has neither, so the hook
    // exits 0 silently.
    if (!jqExists()) return;
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'agent-x', description: '' },
    });
    const res = runHook(payload, { reaRoot: projectDir });
    expect(res.status).toBe(0);
    // No "skipped (sandbox check: ...)" — the silent-drop path
    // returns before the sandbox check fires because no REA_ARGV was
    // resolved.
    expect(res.stderr).toBe('');
  });

  it('refuses to invoke a forged dist/cli/index.js without matching package.json', () => {
    // Stage a tempdir that LOOKS like the rea dogfood (dist/cli/
    // index.js exists) but has NO ancestor package.json with the
    // protected name. The sandbox check fails on the
    // "no-rea-pkg-json" branch and the signal is dropped with a
    // stderr breadcrumb.
    if (!jqExists()) return;
    fs.mkdirSync(path.join(projectDir, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'dist', 'cli', 'index.js'),
      '#!/usr/bin/env node\nprocess.exit(0);\n',
    );
    // Note: NO package.json — the walk-up sandbox check refuses.
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'agent-x', description: '' },
    });
    const res = runHook(payload, { reaRoot: projectDir });
    expect(res.status).toBe(0);
    // Stderr surfaces the sandbox-refusal breadcrumb.
    expect(res.stderr).toContain('sandbox check');
  });
});

describe('delegation-capture.sh — HALT contract', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkTempProject();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 2 when .rea/HALT exists (kill-switch wins)', () => {
    fs.writeFileSync(path.join(projectDir, '.rea', 'HALT'), 'frozen for test\n');
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'agent-x', description: '' },
    });
    const res = runHook(payload, { reaRoot: projectDir });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('REA HALT');
  });
});
