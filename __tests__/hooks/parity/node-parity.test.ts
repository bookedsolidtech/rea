/**
 * 0.32.0 Phase 1 — Bash↔Node parity tests for the three pilot hooks.
 *
 * For each pilot we feed the SAME stdin payload to:
 *   (a) the pre-0.32.0 bash hook body (preserved verbatim under
 *       `__tests__/hooks/parity/baselines/<name>.sh.pre-0.32.0`),
 *       executed via `bash -c "..." <<< "$INPUT"`
 *   (b) the new Node-binary executor (`runPrIssueLinkGate`,
 *       `runAttributionAdvisory`, `runSecurityDisclosureGate`)
 *
 * The pair must produce equivalent verdicts:
 *   - same exit code (0 vs. 2)
 *   - same allow/block decision
 *   - same operator-visible reason class (substring check, not byte-
 *     for-byte, because the bash hooks emit slightly different stderr
 *     prologue strings vs. the Node ports — banner text changes were
 *     intentional and audited in pilot review).
 *
 * The corpus is intentionally small — these are smoke tests, not
 * exhaustive. The per-pilot unit suites under src/hooks/(NAME)/*.test.ts
 * carry the granular coverage. This file proves the high-level
 * "consumer sees the same outcome" invariant.
 *
 * Skipped on Windows runners (bash isn't reliably available there)
 * and when `SKIP_BASH_PARITY=1` is set (faster inner-loop tests).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPrIssueLinkGate } from '../../../src/hooks/pr-issue-link-gate/index.js';
import { runAttributionAdvisory } from '../../../src/hooks/attribution-advisory/index.js';
import { runSecurityDisclosureGate } from '../../../src/hooks/security-disclosure-gate/index.js';

const IS_WINDOWS = process.platform === 'win32';
const SKIP = process.env['SKIP_BASH_PARITY'] === '1' || IS_WINDOWS;

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BASELINES_DIR = path.join(__dirname, 'baselines');
const HOOKS_LIB = path.join(REPO_ROOT, 'hooks', '_lib');

/**
 * Run a baseline bash hook against a payload via `bash -c "<stdin>" |
 * <hookbody>`. The baseline scripts `source "$(dirname "$0")/_lib/...`
 * relative to themselves; we exec them in-place so the `_lib/` source
 * resolves correctly. CLAUDE_PROJECT_DIR is set to a tmpdir so HALT
 * checks don't pick up the rea repo's own (absent) HALT.
 */
async function runBaseline(
  baselineName: string,
  payload: string,
  reaRoot: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const baselinePath = path.join(BASELINES_DIR, baselineName);
  // Copy the baseline next to the live _lib so source-relative
  // resolution works. We use a tmpdir to avoid touching the live
  // hooks/ tree.
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-parity-stage-'));
  const stagedHookPath = path.join(stageDir, 'hook.sh');
  fs.copyFileSync(baselinePath, stagedHookPath);
  fs.chmodSync(stagedHookPath, 0o755);
  // Symlink _lib next to it.
  fs.symlinkSync(HOOKS_LIB, path.join(stageDir, '_lib'));
  try {
    const env = {
      ...process.env,
      ...extraEnv,
      CLAUDE_PROJECT_DIR: reaRoot,
    };
    return await new Promise<{ exitCode: number; stderr: string; stdout: string }>(
      (resolve) => {
        const child = spawn('bash', [stagedHookPath], { env });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('close', (code) => {
          resolve({ exitCode: code ?? 1, stdout, stderr });
        });
        child.on('error', () => {
          resolve({ exitCode: 1, stdout, stderr });
        });
        child.stdin.write(payload);
        child.stdin.end();
      },
    );
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function payload(cmd: string, toolName = 'Bash'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });
}

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-parity-root-'));
}

describe.runIf(!SKIP)('pr-issue-link-gate bash↔node parity', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('both pass through non-`gh pr create` commands silently', async () => {
    const input = payload('git status');
    const bash = await runBaseline('pr-issue-link-gate.sh.pre-0.32.0', input, root);
    const node = await runPrIssueLinkGate({ reaRoot: root, stdinOverride: input });
    expect(node.exitCode).toBe(0);
    expect(bash.exitCode).toBe(0);
    expect(node.stderr).toBe('');
    expect(bash.stderr).toBe('');
  });

  it('both pass through `gh pr create` WITH `closes #N`', async () => {
    const input = payload('gh pr create --body "closes #123"');
    const bash = await runBaseline('pr-issue-link-gate.sh.pre-0.32.0', input, root);
    const node = await runPrIssueLinkGate({ reaRoot: root, stdinOverride: input });
    expect(node.exitCode).toBe(0);
    expect(bash.exitCode).toBe(0);
    expect(node.stderr).toBe('');
    expect(bash.stderr).toBe('');
  });

  it('both emit advisory + exit 0 for `gh pr create` without issue link', async () => {
    const input = payload('gh pr create --title chore --body "no link"');
    const bash = await runBaseline('pr-issue-link-gate.sh.pre-0.32.0', input, root);
    const node = await runPrIssueLinkGate({ reaRoot: root, stdinOverride: input });
    expect(node.exitCode).toBe(0);
    expect(bash.exitCode).toBe(0);
    expect(node.stderr).toContain('PR ISSUE LINK ADVISORY');
    expect(bash.stderr).toContain('PR ISSUE LINK ADVISORY');
  });
});

describe.runIf(!SKIP)('attribution-advisory bash↔node parity', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
    // Both bash + node need policy.yaml with the block flag on.
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.rea', 'policy.yaml'),
      'block_ai_attribution: true\n',
    );
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('both block on Co-Authored-By with anthropic noreply', async () => {
    const input = payload(
      'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
    );
    const bash = await runBaseline(
      'attribution-advisory.sh.pre-0.32.0',
      input,
      root,
    );
    const node = await runAttributionAdvisory({ reaRoot: root, stdinOverride: input });
    expect(node.exitCode).toBe(2);
    expect(bash.exitCode).toBe(2);
    expect(node.stderr).toContain('BLOCKED: AI attribution');
    expect(bash.stderr).toContain('BLOCKED: AI attribution');
  });

  it('both pass clean commit messages', async () => {
    const input = payload('git commit -m "feat: clean message"');
    const bash = await runBaseline(
      'attribution-advisory.sh.pre-0.32.0',
      input,
      root,
    );
    const node = await runAttributionAdvisory({ reaRoot: root, stdinOverride: input });
    expect(node.exitCode).toBe(0);
    expect(bash.exitCode).toBe(0);
  });

  it('both allow GitHub per-user noreply form', async () => {
    const input = payload(
      'git commit -m "x\n\nCo-Authored-By: Real <real@users.noreply.github.com>"',
    );
    const bash = await runBaseline(
      'attribution-advisory.sh.pre-0.32.0',
      input,
      root,
    );
    const node = await runAttributionAdvisory({ reaRoot: root, stdinOverride: input });
    expect(node.exitCode).toBe(0);
    expect(bash.exitCode).toBe(0);
  });

  it('both no-op when policy is off', async () => {
    fs.writeFileSync(
      path.join(root, '.rea', 'policy.yaml'),
      'block_ai_attribution: false\n',
    );
    const input = payload(
      'git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
    );
    const bash = await runBaseline(
      'attribution-advisory.sh.pre-0.32.0',
      input,
      root,
    );
    const node = await runAttributionAdvisory({ reaRoot: root, stdinOverride: input });
    expect(node.exitCode).toBe(0);
    expect(bash.exitCode).toBe(0);
  });
});

describe.runIf(!SKIP)('security-disclosure-gate bash↔node parity', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('both pass through irrelevant commands silently', async () => {
    const input = payload('git status');
    const bash = await runBaseline(
      'security-disclosure-gate.sh.pre-0.32.0',
      input,
      root,
    );
    const node = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: input,
      cwdOverride: root,
    });
    expect(node.exitCode).toBe(0);
    expect(bash.exitCode).toBe(0);
  });

  it('both block on `gh issue create` with bypass keyword (advisory mode)', async () => {
    const input = payload('gh issue create --title "Found a HALT bypass"');
    const bash = await runBaseline(
      'security-disclosure-gate.sh.pre-0.32.0',
      input,
      root,
    );
    const node = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: input,
      cwdOverride: root,
    });
    expect(node.exitCode).toBe(2);
    expect(bash.exitCode).toBe(2);
    // Both should reference 'security-advisories' in their block
    // reason output (bash via stdout JSON, node via stdout JSON).
    const bashOutput = bash.stdout + bash.stderr;
    const nodeOutput = node.stdout + node.stderr;
    expect(bashOutput).toContain('security-advisories');
    expect(nodeOutput).toContain('security-advisories');
  });

  it('both pass on clean `gh issue create`', async () => {
    const input = payload('gh issue create --title "docs typo"');
    const bash = await runBaseline(
      'security-disclosure-gate.sh.pre-0.32.0',
      input,
      root,
    );
    const node = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: input,
      cwdOverride: root,
    });
    expect(node.exitCode).toBe(0);
    expect(bash.exitCode).toBe(0);
  });

  it('both no-op when REA_DISCLOSURE_MODE=disabled', async () => {
    const input = payload('gh issue create --title "exploit found"');
    const bash = await runBaseline(
      'security-disclosure-gate.sh.pre-0.32.0',
      input,
      root,
      { REA_DISCLOSURE_MODE: 'disabled' },
    );
    const node = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: input,
      cwdOverride: root,
      disclosureModeOverride: 'disabled',
    });
    expect(node.exitCode).toBe(0);
    expect(bash.exitCode).toBe(0);
  });
});
