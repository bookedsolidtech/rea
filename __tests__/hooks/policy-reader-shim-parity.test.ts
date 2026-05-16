/**
 * Per-shim integration tests for the 0.37.0 unified policy reader.
 *
 * Each test sets up a tmpdir with a FLOW-FORM policy.yaml (the form
 * pre-0.37.0 shim parsers silently missed), runs the shim WITHOUT
 * the rea CLI reachable, and asserts the new behavior:
 *
 *   - Tier 2 (python3) parses flow-form correctly when reachable
 *   - The shim's relevance pre-gate now honors flow-form entries
 *     where pre-0.37.0 it silently no-op'd
 *
 * If python3 + PyYAML aren't available the test falls back to
 * verifying Tier 3 (awk, block-form only) still works on
 * equivalent block-form input — so the suite is meaningful on every
 * CI runner.
 *
 * Skipped on Windows runners (bash isn't reliably available).
 */

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const IS_WINDOWS = process.platform === 'win32';
const SKIP = IS_WINDOWS;

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let pythonYamlAvailable = false;

beforeAll(() => {
  if (SKIP) return;
  try {
    execFileSync('python3', ['-c', 'import yaml'], { stdio: 'ignore' });
    pythonYamlAvailable = true;
  } catch {
    pythonYamlAvailable = false;
  }
});

interface ShimResult {
  status: number;
  stdout: string;
  stderr: string;
}

function makeProject(policyYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-shim-parity-'));
  fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.rea', 'policy.yaml'), policyYaml);
  return dir;
}

/**
 * Run a shim against a payload with the rea CLI explicitly UNAVAILABLE.
 * We accomplish that by setting CLAUDE_PROJECT_DIR to a tmpdir that
 * has no node_modules and no dist/cli/index.js — both ladder steps
 * the shims check return false → REA_ARGV stays empty → fallback
 * path runs.
 */
function runShimNoCli(opts: {
  shimRelPath: string;
  payload: string;
  projectDir: string;
}): ShimResult {
  // Copy the shim into a tmpdir that ALSO contains hooks/_lib so the
  // shim's `source "$(dirname "$0")/_lib/..."` resolves. We accomplish
  // that by symlinking the real hooks dir tree into the tmpdir.
  const shimsRoot = path.join(opts.projectDir, '.claude', 'hooks');
  fs.mkdirSync(shimsRoot, { recursive: true });
  // Copy the entire hooks/ tree into the project (real files, not
  // symlinks — Claude Code itself copies them at install time).
  const realHooks = path.join(REPO_ROOT, 'hooks');
  copyDir(realHooks, shimsRoot);
  const shim = path.join(shimsRoot, path.basename(opts.shimRelPath));
  const r = spawnSync('bash', [shim], {
    cwd: opts.projectDir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      CLAUDE_PROJECT_DIR: opts.projectDir,
    },
    input: opts.payload,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function copyDir(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDir(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
    }
  }
}

// Flow-form policy that pre-0.37.0 shim parsers would silently miss.
const FLOW_POLICY = `version: "1"
profile: "open-source"
autonomy_level: L1
max_autonomy_level: L2
block_ai_attribution: true
blocked_paths: [.env, .env.*, src/secrets/, .rea/HALT]
protected_writes: [src/sacred-flow.ts, src/sacred-flow-2.ts]
review:
  codex_required: false
  local_review: { mode: off }
`;

describe('0.37.0 unified policy reader — per-shim flow-form parity', () => {
  let projectDir = '';
  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    projectDir = '';
  });

  describe('blocked-paths-bash-gate.sh', () => {
    it.skipIf(SKIP)(
      'flow-form blocked_paths + no CLI: relevance pre-gate triggers fail-closed (was silent-pass pre-0.37.0)',
      () => {
        if (!pythonYamlAvailable) {
          console.warn(
            '[shim-parity] python3 PyYAML missing — skipping flow-form Tier 2 assertion',
          );
          return;
        }
        projectDir = makeProject(FLOW_POLICY);
        // A Bash command mentioning a flow-form blocked path. Pre-0.37.0
        // the awk parser missed the flow-form array entirely → empty
        // blocked_paths list → relevance pre-gate found nothing → exit 0
        // (silent pass). Now Tier 2 reads the flow-form correctly →
        // relevance fires → fail-closed exit 2 with the unbuilt-CLI
        // banner.
        const r = runShimNoCli({
          shimRelPath: 'blocked-paths-bash-gate.sh',
          payload: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'cat src/secrets/api.txt' },
          }),
          projectDir,
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('blocked-paths-bash-gate');
        expect(r.stderr).toContain('not built');
      },
    );

    it.skipIf(SKIP)(
      'non-relevant Bash + flow-form policy: still exits 0 (no over-trigger)',
      () => {
        projectDir = makeProject(FLOW_POLICY);
        const r = runShimNoCli({
          shimRelPath: 'blocked-paths-bash-gate.sh',
          payload: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'ls -la /tmp' },
          }),
          projectDir,
        });
        expect(r.status).toBe(0);
      },
    );
  });

  describe('blocked-paths-enforcer.sh (Write-tier)', () => {
    it.skipIf(SKIP)(
      'flow-form blocked_paths + no CLI: Write to flow-form entry triggers fail-closed',
      () => {
        if (!pythonYamlAvailable) return;
        projectDir = makeProject(FLOW_POLICY);
        const r = runShimNoCli({
          shimRelPath: 'blocked-paths-enforcer.sh',
          payload: JSON.stringify({
            tool_name: 'Write',
            tool_input: { file_path: '/tmp/some/src/secrets/api.txt', content: 'x' },
          }),
          projectDir,
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('blocked-paths-enforcer');
      },
    );

    it.skipIf(SKIP)('non-relevant Write + flow-form policy: exits 0', () => {
      projectDir = makeProject(FLOW_POLICY);
      const r = runShimNoCli({
        shimRelPath: 'blocked-paths-enforcer.sh',
        payload: JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/some/innocuous-file.ts', content: 'x' },
        }),
        projectDir,
      });
      expect(r.status).toBe(0);
    });
  });

  describe('protected-paths-bash-gate.sh', () => {
    it.skipIf(SKIP)(
      'flow-form protected_writes + no CLI: relevance pre-gate triggers',
      () => {
        if (!pythonYamlAvailable) return;
        projectDir = makeProject(FLOW_POLICY);
        const r = runShimNoCli({
          shimRelPath: 'protected-paths-bash-gate.sh',
          payload: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'rm src/sacred-flow.ts' },
          }),
          projectDir,
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('protected-paths-bash-gate');
      },
    );
  });

  describe('settings-protection.sh', () => {
    it.skipIf(SKIP)(
      'flow-form protected_writes + no CLI: Write to flow-form entry triggers',
      () => {
        if (!pythonYamlAvailable) return;
        projectDir = makeProject(FLOW_POLICY);
        const r = runShimNoCli({
          shimRelPath: 'settings-protection.sh',
          payload: JSON.stringify({
            tool_name: 'Write',
            tool_input: { file_path: '/tmp/some/src/sacred-flow-2.ts', content: 'x' },
          }),
          projectDir,
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('settings-protection');
      },
    );
  });

  describe('attribution-advisory.sh', () => {
    it.skipIf(SKIP)(
      'flow-form policy with block_ai_attribution: true + irrelevant Bash → exits 0',
      () => {
        // attribution-advisory only matters on git commit / gh pr
        // create-or-edit. Irrelevant Bash should exit 0 even when
        // attribution policy is enabled.
        projectDir = makeProject(FLOW_POLICY);
        const r = runShimNoCli({
          shimRelPath: 'attribution-advisory.sh',
          payload: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'ls -la' },
          }),
          projectDir,
        });
        expect(r.status).toBe(0);
      },
    );

    it.skipIf(SKIP)(
      'block-form block_ai_attribution: true + git commit + no CLI → fail-closed',
      () => {
        // attribution-advisory short-circuits when block_ai_attribution
        // is unreadable / false. We verify here that when the policy
        // reader successfully reports `true` (block-form on Tier 3, or
        // flow-form on Tier 2), the shim proceeds to the no-CLI
        // fail-closed branch on a git-commit Bash call.
        projectDir = makeProject(FLOW_POLICY);
        const r = runShimNoCli({
          shimRelPath: 'attribution-advisory.sh',
          payload: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "wip"' },
          }),
          projectDir,
        });
        if (pythonYamlAvailable) {
          // Tier 2 reads `block_ai_attribution: true` from flow-form.
          // The shim then enters its no-CLI fail-closed branch.
          expect(r.status).toBe(2);
          expect(r.stderr).toContain('attribution-advisory');
        } else {
          // Tier 3 falls back to awk; `block_ai_attribution: true` is
          // a top-level scalar (block-form even in our "flow" sample
          // since `block_ai_attribution: true` is a single line). The
          // attribution gate still fires.
          expect(r.status).toBe(2);
        }
      },
    );

    it.skipIf(SKIP)(
      'block_ai_attribution: false + git commit + no CLI → exits 0 (no over-block)',
      () => {
        const POLICY_DISABLED = `version: "1"
profile: "open-source"
autonomy_level: L1
max_autonomy_level: L2
block_ai_attribution: false
`;
        projectDir = makeProject(POLICY_DISABLED);
        const r = runShimNoCli({
          shimRelPath: 'attribution-advisory.sh',
          payload: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "wip"' },
          }),
          projectDir,
        });
        expect(r.status).toBe(0);
      },
    );

    /**
     * Codex round 2 P1 (2026-05-16): the sandbox check MUST run BEFORE
     * the policy read. Pre-round-2, `policy_reader_get
     * block_ai_attribution` invoked the resolved CLI through Tier 1 of
     * the unified reader BEFORE the sandbox guard had a chance to fire.
     * An attacker who placed a hostile binary at
     * `$proj/dist/cli/index.js` (or symlinked node_modules out of the
     * project) would have their code executed during policy lookup.
     *
     * This test installs a hostile CLI that would touch a sentinel
     * file if executed, then runs the shim. Post-fix:
     *   - sandbox check yields `bad:no-rea-pkg-json` (no ancestor
     *     package.json declares @bookedsolid/rea in our tmpdir)
     *   - REA_ARGV is cleared
     *   - policy reader degrades to Tier 2/3 (file-parse only)
     *   - shim fails closed with the sandbox-failure forensic message
     *   - sentinel file is NEVER touched
     */
    it.skipIf(SKIP)(
      'sandbox check runs BEFORE policy read (hostile CLI never invoked)',
      () => {
        projectDir = makeProject(FLOW_POLICY);
        const sentinel = path.join(projectDir, '.rea', 'sentinel-attacker-ran');
        // Install a hostile CLI at $proj/dist/cli/index.js. If the shim
        // calls into it (e.g. via policy_reader_get → Tier 1 →
        // `rea hook policy-get block_ai_attribution`), the script will
        // touch the sentinel BEFORE printing anything, proving the CLI
        // ran. Post-fix, the sandbox check refuses this CLI (no
        // ancestor package.json declaring @bookedsolid/rea) and clears
        // REA_ARGV before the policy read.
        const cliDir = path.join(projectDir, 'dist', 'cli');
        fs.mkdirSync(cliDir, { recursive: true });
        const hostileCli = path.join(cliDir, 'index.js');
        fs.writeFileSync(
          hostileCli,
          `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.writeFileSync(${JSON.stringify(sentinel)}, 'attacker-ran');
// Print 'true' so a naive shim believes the policy reader succeeded.
process.stdout.write('true');
process.exit(0);
`,
        );
        fs.chmodSync(hostileCli, 0o755);
        // NOTE: we deliberately do NOT create a package.json declaring
        // @bookedsolid/rea — the sandbox walker will fail to find one
        // in any ancestor and refuse the CLI.
        const r = runShimNoCli({
          shimRelPath: 'attribution-advisory.sh',
          payload: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "wip"' },
          }),
          projectDir,
        });
        // The sentinel MUST NOT exist — the hostile CLI must never run.
        // This is the core security claim of the round-2 P1 fix.
        expect(fs.existsSync(sentinel)).toBe(false);
        // The shim should refuse explicitly with a forensic message
        // mentioning the sandbox failure.
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('sandbox');
      },
    );
  });

  describe('local-review-gate.sh', () => {
    it.skipIf(SKIP)(
      'flow-form `local_review: { mode: off }` + no CLI → silent short-circuit (was silent-fail-closed pre-0.37.0)',
      () => {
        if (!pythonYamlAvailable) return;
        projectDir = makeProject(FLOW_POLICY);
        // A `git push` payload that pre-0.37.0 would have:
        //   - bash awk parser missed flow-form `mode: off`
        //   - shim fell through to enforcement → no recent audit entry
        //     → preflight refusal → exit 2
        // Now Tier 2 reads `mode: off` → shim short-circuits → exit 0.
        const r = runShimNoCli({
          shimRelPath: 'local-review-gate.sh',
          payload: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'git push origin main' },
          }),
          projectDir,
        });
        // Mode-off should short-circuit cleanly. Exit 0 means the
        // 4-tier ladder successfully read `mode: off` and the shim
        // honored it. Pre-fix this would have been a non-zero exit.
        expect(r.status).toBe(0);
      },
    );

    it.skipIf(SKIP)(
      'block-form mode: off works equivalently via Tier 3 (no python3 needed)',
      () => {
        const BLOCK_OFF = `version: "1"
profile: "open-source"
autonomy_level: L1
max_autonomy_level: L2
review:
  codex_required: false
  local_review:
    mode: off
`;
        projectDir = makeProject(BLOCK_OFF);
        const r = runShimNoCli({
          shimRelPath: 'local-review-gate.sh',
          payload: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'git push origin main' },
          }),
          projectDir,
        });
        // Tier 2 or Tier 3 — either parses block-form `mode: off`.
        expect(r.status).toBe(0);
      },
    );
  });
});
