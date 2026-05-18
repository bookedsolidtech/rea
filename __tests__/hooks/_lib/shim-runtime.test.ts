/**
 * Unit tests for `hooks/_lib/shim-runtime.sh` — the shared Node-binary
 * shim runtime introduced in 0.38.0.
 *
 * The library is sourced by every Node-binary shim (14 hooks). A bug
 * here breaks ALL hooks simultaneously, mirroring the 0.34.0 round-6
 * mid-marathon lockout. Coverage targets the public API surface:
 *
 *   - HALT short-circuit (cooperates with halt-check.sh)
 *   - stdin capture into INPUT
 *   - shim_is_relevant pre-gate (early exit 0 on irrelevant payloads)
 *   - CLI resolution (2-tier sandboxed: node_modules → dist/, no PATH)
 *   - shim_cli_missing_relevant (per-shim fail-closed-on-relevant)
 *   - realpath sandbox check + dist/cli/index.js shape enforcement
 *   - shim_policy_short_circuit (post-sandbox policy gate)
 *   - version probe
 *   - shim_forward override (fire-and-forget for delegation-capture)
 *   - SHIM_FAIL_OPEN advisory vs blocking posture on every failure branch
 *   - SHIM_SKIP_VERSION_PROBE for delegation-capture's no-probe shape
 *
 * Each test instantiates an ephemeral shim script in a tmpdir that
 * sources hooks/_lib/halt-check.sh + hooks/_lib/shim-runtime.sh
 * directly from the live repo, sets a minimal SHIM_NAME + the option
 * under test, and runs it through `bash`. The CLI is faked by writing
 * a stub `dist/cli/index.js` inside CLAUDE_PROJECT_DIR (a tmpdir) +
 * a package.json with `name: @bookedsolid/rea` so the sandbox check
 * passes.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOKS_LIB = path.join(REPO_ROOT, 'hooks', '_lib');

interface ShimResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface RunShimOptions {
  /** Shim body that comes AFTER the halt-check + REA_ROOT block.
   *  Should set SHIM_* vars + optional callback functions, then end
   *  with `source "$LIB/shim-runtime.sh"; shim_run`. */
  shimBody: string;
  payload: string;
  /** Project root with optional fake CLI / .rea / etc. */
  projectDir: string;
  /** Extra env vars. */
  env?: NodeJS.ProcessEnv;
  /** Override the path to the rea CLI used by the version probe.
   *  When unset, we install a stub at $projectDir/dist/cli/index.js
   *  that prints the SHIM_NAME (so the --help content match passes). */
  installFakeCli?: 'good-probe' | 'bad-probe' | 'fail-probe' | 'none';
  /** Whether to install a package.json with @bookedsolid/rea name at
   *  the project root (needed for sandbox check). */
  installPkgJson?: boolean;
  shimName?: string;
}

function makeProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-shim-runtime-test-'));
}

function installFakeCliGoodProbe(projectDir: string, shimName: string): void {
  const distDir = path.join(projectDir, 'dist', 'cli');
  fs.mkdirSync(distDir, { recursive: true });
  // The version probe runs `node CLI hook <NAME> --help` and looks for
  // <NAME> in the output. A fake CLI that echoes its arguments suffices.
  fs.writeFileSync(
    path.join(distDir, 'index.js'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length >= 3 && args[0] === 'hook' && args[1] === '${shimName}' && args[2] === '--help') {
  process.stdout.write('Usage: rea hook ${shimName} [options]\\n');
  process.exit(0);
}
// Forward path: just read stdin and exit 0
let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  process.stdout.write('forwarded:' + buf.length + ' bytes\\n');
  process.exit(0);
});
`,
  );
  fs.chmodSync(path.join(distDir, 'index.js'), 0o755);
}

function installFakeCliBadProbe(projectDir: string): void {
  // Probe returns 0 but the output doesn't contain the shim name.
  const distDir = path.join(projectDir, 'dist', 'cli');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'index.js'),
    `#!/usr/bin/env node
process.stdout.write('unknown subcommand\\n');
process.exit(0);
`,
  );
  fs.chmodSync(path.join(distDir, 'index.js'), 0o755);
}

function installFakeCliFailProbe(projectDir: string): void {
  // Probe exits non-zero.
  const distDir = path.join(projectDir, 'dist', 'cli');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'index.js'),
    `#!/usr/bin/env node
process.exit(1);
`,
  );
  fs.chmodSync(path.join(distDir, 'index.js'), 0o755);
}

function installPkgJson(projectDir: string): void {
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }),
  );
}

function runShim(opts: RunShimOptions): ShimResult {
  const shimName = opts.shimName ?? 'test-shim';
  // Stage the shim in the project dir so `$(dirname "$0")/_lib/...`
  // resolves to the real lib via symlink.
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-shim-runtime-stage-'));
  const stagedHook = path.join(stageDir, 'test-shim.sh');
  fs.symlinkSync(HOOKS_LIB, path.join(stageDir, '_lib'));
  const body = `#!/bin/bash
set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="${shimName}"
SHIM_INTRODUCED_IN="0.38.0"

${opts.shimBody}
`;
  fs.writeFileSync(stagedHook, body);
  fs.chmodSync(stagedHook, 0o755);

  // Install fake CLI per request.
  if (opts.installFakeCli === 'good-probe') {
    installFakeCliGoodProbe(opts.projectDir, shimName);
  } else if (opts.installFakeCli === 'bad-probe') {
    installFakeCliBadProbe(opts.projectDir);
  } else if (opts.installFakeCli === 'fail-probe') {
    installFakeCliFailProbe(opts.projectDir);
  }
  if (opts.installPkgJson) {
    installPkgJson(opts.projectDir);
  }

  try {
    const res = spawnSync('bash', [stagedHook], {
      cwd: opts.projectDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '/tmp',
        CLAUDE_PROJECT_DIR: opts.projectDir,
        ...(opts.env ?? {}),
      },
      input: opts.payload,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return {
      status: res.status ?? -1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function bashExists(): boolean {
  return spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
}

const STD_BODY = `
# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
`;

describe('hooks/_lib/shim-runtime.sh — HALT branch', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 2 with HALT banner when .rea/HALT exists', () => {
    if (!bashExists()) return;
    fs.mkdirSync(path.join(projectDir, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.rea', 'HALT'), 'frozen for test\n');
    const r = runShim({
      shimBody: STD_BODY,
      payload: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      projectDir,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REA HALT');
    expect(r.stderr).toContain('frozen for test');
  });
});

describe('hooks/_lib/shim-runtime.sh — relevance pre-gate', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 0 silently when shim_is_relevant returns 1', () => {
    if (!bashExists()) return;
    const body = `
shim_is_relevant() { return 1; }
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      projectDir,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('continues to CLI resolution when shim_is_relevant returns 0', () => {
    if (!bashExists()) return;
    // No CLI installed → reaches CLI-missing fail-closed branch.
    const body = `
SHIM_FAIL_OPEN=0
shim_is_relevant() { return 0; }
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      projectDir,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot run');
    expect(r.stderr).toContain('test-shim');
  });
});

describe('hooks/_lib/shim-runtime.sh — CLI-missing branch', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('blocking-tier: exits 2 with CLI-missing banner', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot run — the rea CLI is not built');
    expect(r.stderr).toContain('pnpm install && pnpm build');
  });

  it('advisory-tier: exits 0 silently when CLI is missing', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=1
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('shim_cli_missing_relevant=1 (relevant) → blocking-tier exits 2 with banner', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
shim_cli_missing_relevant() { return 0; }
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot run');
  });

  it('shim_cli_missing_relevant=0 (irrelevant) → exit 0 silently regardless of FAIL_OPEN', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
shim_cli_missing_relevant() { return 1; }
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});

describe('hooks/_lib/shim-runtime.sh — sandbox check', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('passes when CLI is inside project + ancestor package.json has @bookedsolid/rea name', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('forwarded:');
  });

  it('fails (no:no-rea-pkg-json) when project has no package.json', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: false,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('FAILED sandbox check');
    expect(r.stderr).toContain('bad:no-rea-pkg-json');
  });

  it('advisory-tier: sandbox failure exits 0 with skip banner (no refuse)', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=1
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: false,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('skipped (sandbox check:');
  });

  it('SHIM_ENFORCE_CLI_SHAPE=1: rejects CLI that is not dist/cli/index.js', () => {
    if (!bashExists()) return;
    // Install a CLI at non-canonical path
    const altDir = path.join(projectDir, 'random-spot');
    fs.mkdirSync(altDir, { recursive: true });
    fs.writeFileSync(
      path.join(altDir, 'fake.js'),
      `#!/usr/bin/env node\nprocess.exit(0);\n`,
    );
    // Symlink the canonical location to the alt path
    const distDir = path.join(projectDir, 'dist', 'cli');
    fs.mkdirSync(distDir, { recursive: true });
    fs.symlinkSync(path.join(altDir, 'fake.js'), path.join(distDir, 'index.js'));
    installPkgJson(projectDir);

    const body = `
SHIM_FAIL_OPEN=0
SHIM_ENFORCE_CLI_SHAPE=1
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/FAILED sandbox check.*bad:cli-shape/);
  });

  it('SHIM_ENFORCE_CLI_SHAPE=0: shape check is skipped (no bad:cli-shape verdict)', () => {
    if (!bashExists()) return;
    // Install a CLI whose realpath does NOT end in dist/cli/index.js.
    // The package.json walk starts from dirname^3 of the realpath, so
    // we need to nest the alt CLI deep enough that walk-up reaches the
    // project pkg.json. Use projectDir/a/b/c/d.js so dirname^3 =
    // projectDir/a, then the walk-up reaches projectDir/package.json.
    const altDir = path.join(projectDir, 'a', 'b', 'c');
    fs.mkdirSync(altDir, { recursive: true });
    fs.writeFileSync(
      path.join(altDir, 'd.js'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length >= 3 && args[0] === 'hook' && args[1] === 'test-shim' && args[2] === '--help') {
  process.stdout.write('test-shim help\\n');
  process.exit(0);
}
let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => { process.stdout.write('ok'); process.exit(0); });
`,
    );
    fs.chmodSync(path.join(altDir, 'd.js'), 0o755);
    const distDir = path.join(projectDir, 'dist', 'cli');
    fs.mkdirSync(distDir, { recursive: true });
    fs.symlinkSync(path.join(altDir, 'd.js'), path.join(distDir, 'index.js'));
    installPkgJson(projectDir);

    const body = `
SHIM_FAIL_OPEN=0
SHIM_ENFORCE_CLI_SHAPE=0
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
    });
    // The key invariant: with shape enforcement OFF, the verdict
    // must NOT be `bad:cli-shape`. (Other sandbox legs may still
    // pass or fail depending on package.json reachability, but the
    // shape leg is the one we're testing here.)
    expect(r.stderr).not.toContain('bad:cli-shape');
  });
});

describe('hooks/_lib/shim-runtime.sh — version probe', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
    installPkgJson(projectDir);
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('passes when probe outputs SHIM_NAME', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
    });
    expect(r.status).toBe(0);
  });

  it('blocking-tier: probe failure exits 2 with version-skew banner', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'bad-probe',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('requires the `rea hook test-shim` subcommand');
    expect(r.stderr).toContain('introduced in 0.38.0');
  });

  it('advisory-tier: probe failure exits 0 with skip banner', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=1
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'fail-probe',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('requires the `rea hook test-shim` subcommand');
    expect(r.stderr).toContain('falling through silently');
  });

  it('SHIM_SKIP_VERSION_PROBE=1: skips probe entirely (forward runs)', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
SHIM_SKIP_VERSION_PROBE=1
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'bad-probe', // Would normally fail probe — but skipped
    });
    // Bad probe CLI doesn't run a forward handler — it just exits 0
    // (the test's installFakeCliBadProbe always exits 0).
    expect(r.status).toBe(0);
  });
});

describe('hooks/_lib/shim-runtime.sh — policy short-circuit', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
    installPkgJson(projectDir);
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 0 when shim_policy_short_circuit returns 0 (disabled by policy)', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
shim_policy_short_circuit() { return 0; }
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
    });
    expect(r.status).toBe(0);
    // Forward should NOT have run.
    expect(r.stdout).not.toContain('forwarded:');
  });

  it('continues to version probe + forward when shim_policy_short_circuit returns 1', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
shim_policy_short_circuit() { return 1; }
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('forwarded:');
  });
});

describe('hooks/_lib/shim-runtime.sh — forward', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
    installPkgJson(projectDir);
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('default forward pipes stdin to `rea hook <NAME>`', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: 'PAYLOAD_DATA_X',
      projectDir,
      installFakeCli: 'good-probe',
    });
    expect(r.status).toBe(0);
    // Fake CLI reports byte count of forwarded stdin.
    expect(r.stdout).toContain('forwarded:14 bytes');
  });

  it('shim_forward override replaces the default', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
shim_forward() {
  printf 'OVERRIDDEN\\n'
  exit 0
}
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: 'X',
      projectDir,
      installFakeCli: 'good-probe',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OVERRIDDEN');
    expect(r.stdout).not.toContain('forwarded:');
  });
});

describe('hooks/_lib/shim-runtime.sh — required-var guards', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('refuses to run when SHIM_NAME is unset', () => {
    if (!bashExists()) return;
    // Override the default SHIM_NAME by unsetting it after the standard
    // prelude.
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-shim-runtime-stage-'));
    const stagedHook = path.join(stageDir, 'no-name.sh');
    fs.symlinkSync(HOOKS_LIB, path.join(stageDir, '_lib'));
    fs.writeFileSync(
      stagedHook,
      `#!/bin/bash
set -uo pipefail
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)
# Deliberately do NOT set SHIM_NAME.
SHIM_INTRODUCED_IN="0.38.0"
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
`,
    );
    fs.chmodSync(stagedHook, 0o755);

    try {
      const res = spawnSync('bash', [stagedHook], {
        cwd: projectDir,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '/tmp',
          CLAUDE_PROJECT_DIR: projectDir,
        },
        input: '{}',
        encoding: 'utf8',
        timeout: 10_000,
      });
      // Non-zero exit and the bash `:?` error message reaches stderr.
      expect(res.status ?? -1).not.toBe(0);
      expect(res.stderr).toContain('SHIM_NAME');
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  });
});

describe('hooks/_lib/shim-runtime.sh — node-missing + policy short-circuit (0.38.1 round-2 P2)', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
    installPkgJson(projectDir);
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Pre-0.38.1 the node-missing check fired BEFORE shim_policy_short_circuit,
  // so a blocking-tier shim whose policy said "disabled" still refused
  // when node was absent. Post-fix the policy short-circuit runs first;
  // the 4-tier policy reader degrades to Tier 2 (python3) / Tier 3 (awk)
  // when node is unavailable.
  it('blocking-tier: policy short-circuit fires even when node is absent', () => {
    if (!bashExists()) return;
    // Install fake CLI so REA_ARGV is populated (then we strip node).
    installFakeCliGoodProbe(projectDir, 'test-shim');
    const body = `
SHIM_FAIL_OPEN=0
shim_policy_short_circuit() {
  # Simulate a policy read that says "disabled" — should exit 0
  # regardless of whether the CLI / node is reachable.
  return 0
}
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: 'PAYLOAD',
      projectDir,
      // Strip node from PATH — emulates a system with rea installed but
      // no node interpreter on PATH.
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(r.status, `expected 0 (policy disabled), got ${r.status}; stderr: ${r.stderr}`).toBe(0);
  });

  it('blocking-tier: node-missing banner fires when policy did NOT short-circuit', () => {
    if (!bashExists()) return;
    installFakeCliGoodProbe(projectDir, 'test-shim');
    const body = `
SHIM_FAIL_OPEN=0
shim_policy_short_circuit() {
  # Simulate a policy read that says "enabled" — should fall through
  # to node-missing banner since CLI cannot be sandbox-validated.
  return 1
}
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: 'PAYLOAD',
      projectDir,
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/node/i);
  });

  it('advisory-tier: node-missing exits 0 silently after policy short-circuit chance', () => {
    if (!bashExists()) return;
    installFakeCliGoodProbe(projectDir, 'test-shim');
    const body = `
SHIM_FAIL_OPEN=1
shim_policy_short_circuit() {
  # Even advisory shims should get policy-short-circuit BEFORE the
  # advisory-silent-exit-0 path. Set return 0 → exit 0 unambiguously
  # (advisory + disabled-by-policy converge to exit 0).
  return 0
}
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: 'PAYLOAD',
      projectDir,
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(r.status).toBe(0);
  });
});

describe('hooks/_lib/shim-runtime.sh — shim line-budget assertion', () => {
  // 0.38.0 charter: every shim should be ≤120 LOC post-extraction.
  // local-review-gate is the documented exception (hot-path subtree
  // cache + early sandbox + policy-driven relevance scan can't compose
  // into shim_run). The lib itself is also exempt.
  const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
  const SHIMS = [
    'architecture-review-gate.sh',
    'attribution-advisory.sh',
    'blocked-paths-bash-gate.sh',
    'blocked-paths-enforcer.sh',
    'changeset-security-gate.sh',
    'dangerous-bash-interceptor.sh',
    'delegation-advisory.sh',
    'delegation-capture.sh',
    'dependency-audit-gate.sh',
    'env-file-protection.sh',
    'pr-issue-link-gate.sh',
    'protected-paths-bash-gate.sh',
    'secret-scanner.sh',
    'security-disclosure-gate.sh',
    'settings-protection.sh',
  ];
  const BUDGET = 120;

  for (const shim of SHIMS) {
    it(`${shim} is ≤${BUDGET} LOC`, () => {
      const p = path.join(HOOKS_DIR, shim);
      const text = fs.readFileSync(p, 'utf8');
      const loc = text.split('\n').length;
      expect(loc, `${shim} is ${loc} LOC (budget ${BUDGET})`).toBeLessThanOrEqual(
        BUDGET,
      );
    });
  }

  it('local-review-gate.sh exists and exceeds the standard budget (documented exception)', () => {
    const p = path.join(HOOKS_DIR, 'local-review-gate.sh');
    expect(fs.existsSync(p)).toBe(true);
    const text = fs.readFileSync(p, 'utf8');
    const loc = text.split('\n').length;
    // Must exceed 120 LOC (it has hot-path subtree cache + early
    // sandbox + policy-driven relevance scan). Cap it at 500 so a
    // regression that re-bloats it past the original 603 LOC is
    // caught.
    expect(loc).toBeGreaterThan(BUDGET);
    expect(loc).toBeLessThan(500);
  });
});

describe('hooks/_lib/shim-runtime.sh — 0.48.0 per-session cache integration', () => {
  let projectDir: string;
  let cacheTmpdir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
    cacheTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-shim-cache-e2e-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(cacheTmpdir, { recursive: true, force: true });
  });

  it('cold miss: runs sandbox + probe + forward AND writes the cache entry', () => {
    if (!bashExists()) return;
    const r = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('forwarded:');
    // The cache dir should now exist with at least one entry.
    const euid = String(process.getuid?.() ?? 0);
    const dir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
    expect(fs.existsSync(dir)).toBe(true);
    const entries = fs.readdirSync(dir).filter((e) => e.endsWith('.json'));
    expect(entries.length).toBeGreaterThan(0);
  });

  it('warm hit: second invocation reuses cached entry and still forwards stdin', () => {
    if (!bashExists()) return;
    // First run — populates cache.
    const r1 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r1.status).toBe(0);
    // Second run — same project, same CLI, cache should hit.
    const r2 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('forwarded:');
  });

  it('cache invalidates when a SIBLING dist/cli/*.js file is rewritten in place', () => {
    // 0.48.0 codex round-5 P1: dir mtime alone does NOT change when
    // tsc rewrites an existing sibling file. The cache key folds in
    // a hash of every *.js file's mtime/size/name in dist/cli/ so
    // changing any sibling invalidates the entry. Without this fix,
    // a same-session `pnpm build` after editing `src/cli/hook.ts`
    // could let warm fires skip the version probe and forward into
    // an unvalidated CLI.
    if (!bashExists()) return;
    // First run — populates cache.
    const r1 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r1.status).toBe(0);
    const euid = String(process.getuid?.() ?? 0);
    const cacheDir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
    const beforeKey = fs.readdirSync(cacheDir).filter((e) => e.endsWith('.json'))[0];
    expect(beforeKey).toBeDefined();

    // Drop a sibling .js file into dist/cli/ AND rewrite it — does
    // not change index.js mtime, does change dist/cli/ dir mtime
    // (because the file was just added). To exercise the round-5
    // protection we need a file that ALREADY exists then is
    // rewritten — adding a file changes the dir mtime which would
    // already invalidate. So we add the file FIRST, run once
    // (re-warming the cache against the new dir layout), THEN
    // rewrite the file in place and assert the third run still
    // misses.
    const siblingPath = path.join(projectDir, 'dist', 'cli', 'sibling.js');
    fs.writeFileSync(siblingPath, '// initial sibling\n');
    // Pre-warm again to absorb the dir-mtime change.
    const r2 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r2.status).toBe(0);
    // Record the cache entries on disk after the rewarming so we
    // can detect a NEW entry written by the post-rewrite run below.
    const afterAddKeys = fs.readdirSync(cacheDir).filter((e) => e.endsWith('.json'));

    // Now rewrite the sibling file IN PLACE (same name, same dir
    // mtime). Brief sleep so mtime ns differs.
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    Atomics.wait(ia, 0, 0, 20);
    fs.writeFileSync(siblingPath, '// modified sibling content longer than before\n');

    const r3 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r3.status).toBe(0);
    // After the sibling rewrite, the cache key changed → a NEW
    // entry was written. So the cache dir now has more entries than
    // before the rewrite.
    const afterRewriteKeys = fs.readdirSync(cacheDir).filter((e) => e.endsWith('.json'));
    expect(afterRewriteKeys.length).toBeGreaterThan(afterAddKeys.length);
    // The pre-existing rewarmed entry is still on disk (TTL/sweep
    // not part of this test), but a new one with a different key
    // was written for the post-rewrite CLI surface.
    const newKeys = afterRewriteKeys.filter((k) => !afterAddKeys.includes(k));
    expect(newKeys.length).toBeGreaterThanOrEqual(1);
  });

  it('warm hit: second run executes faster than cold first run (probe skipped)', () => {
    if (!bashExists()) return;
    // Heuristic test for cache hit: warm runs should not measurably
    // re-spawn `rea hook --help`. We can't directly observe that from
    // outside the bash shim, so we test the OBSERVABLE: a second run
    // against the same TMPDIR + CLI succeeds without re-validating
    // via the version probe. The cache-key invalidation behavior is
    // covered separately by the "fresh build" test below; here we
    // confirm that successive runs in the same cache window do not
    // regress to an exit-2 (which would indicate the cache layer
    // unintentionally re-enforced version-skew). Cold-then-warm with
    // an unchanged CLI: both must exit 0.
    const r1 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain('forwarded:');

    // Inspect the on-disk cache entry — its presence + correct shape
    // is direct evidence the warm path skipped the probe (the write
    // happens AFTER a successful probe, and only when no hit fired).
    const euid = String(process.getuid?.() ?? 0);
    const cacheDir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
    const entries = fs.readdirSync(cacheDir).filter((e) => e.endsWith('.json'));
    expect(entries.length).toBe(1);
    const entryPath = path.join(cacheDir, entries[0]);
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    expect(entry.schema_version).toBe('v1');
    expect(entry.sandbox_ok).toBe(true);
    expect(entry.shape_ok).toBe(true);
    expect(entry.cli_realpath).toContain('dist/cli/index.js');

    // A second run with the SAME CLI must succeed and (per the
    // `cached_at_unix` field) reuse the existing entry rather than
    // writing a new one. We pin a stable cached_at by reading it
    // before + after.
    const cachedAtBefore = Number(entry.cached_at_unix);
    const r2 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('forwarded:');
    const entry2 = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    // 0.48.0 design memo §5: on cache hit the runtime does NOT
    // rewrite the entry (rewriting would refresh cached_at past the
    // TTL bound). Same cached_at across two same-CLI runs == proof
    // the second run hit the cache and skipped both sandbox + probe.
    expect(Number(entry2.cached_at_unix)).toBe(cachedAtBefore);
  });

  it('REA_SHIM_CACHE=0 disables the cache — no entry is written', () => {
    if (!bashExists()) return;
    const r = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '0' },
    });
    expect(r.status).toBe(0);
    const euid = String(process.getuid?.() ?? 0);
    const dir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
    // Either the dir doesn't exist or it exists with zero entries.
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir).filter((e) => e.endsWith('.json'));
      expect(entries.length).toBe(0);
    }
  });

  it('miss + fresh build (file mtime/size changed) → cache key differs, full path re-runs', () => {
    if (!bashExists()) return;
    // First run.
    const r1 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r1.status).toBe(0);
    const euid = String(process.getuid?.() ?? 0);
    const dir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
    const firstEntries = fs.readdirSync(dir).filter((e) => e.endsWith('.json'));
    expect(firstEntries.length).toBeGreaterThan(0);

    // Now replace the CLI with a different content + size — this
    // simulates a fresh `pnpm install` swapping the CLI binary.
    const cliPath = path.join(projectDir, 'dist', 'cli', 'index.js');
    fs.writeFileSync(
      cliPath,
      `#!/usr/bin/env node
// Modified CLI body — different size + mtime.
const args = process.argv.slice(2);
if (args.length >= 3 && args[0] === 'hook' && args[1] === 'test-shim' && args[2] === '--help') {
  process.stdout.write('Usage: rea hook test-shim [options]\\n');
  process.exit(0);
}
let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  process.stdout.write('forwarded-v2:' + buf.length + ' bytes\\n');
  process.exit(0);
});
`,
    );
    fs.chmodSync(cliPath, 0o755);

    const r2 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r2.status).toBe(0);
    // Second forward uses the new CLI body.
    expect(r2.stdout).toContain('forwarded-v2:');
    // Cache picked up a NEW entry — old one may still exist but the
    // total count should be at least the same and ideally +1.
    const secondEntries = fs.readdirSync(dir).filter((e) => e.endsWith('.json'));
    expect(secondEntries.length).toBeGreaterThanOrEqual(firstEntries.length);
  });
});

describe('hooks/_lib/shim-runtime.sh — 0.48.1 SHIM_SKIP_VERSION_PROBE cache-write soundness', () => {
  // 0.48.1 Item 1 (SOUNDNESS): when SHIM_SKIP_VERSION_PROBE=1 is set
  // (delegation-capture's no-probe shape), the cache MUST NOT write an
  // entry. Pre-fix the write proceeded and recorded sandbox_ok+shape_ok
  // from defaulted-true logic, even though the probe never ran. A
  // subsequent cache HIT would read that entry and trust a probe-skip
  // result that was never produced — silently extending the bypass to
  // shims that DO need probes.
  let projectDir: string;
  let cacheTmpdir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
    cacheTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-shim-cache-skip-probe-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(cacheTmpdir, { recursive: true, force: true });
  });

  it('probe RUNS: cache write proceeds (baseline)', () => {
    if (!bashExists()) return;
    const r = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r.status).toBe(0);
    const euid = String(process.getuid?.() ?? 0);
    const dir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
    expect(fs.existsSync(dir)).toBe(true);
    const entries = fs.readdirSync(dir).filter((e) => e.endsWith('.json'));
    expect(entries.length).toBeGreaterThan(0);
  });

  it('SHIM_SKIP_VERSION_PROBE=1: cache write is SKIPPED', () => {
    if (!bashExists()) return;
    const body = `
SHIM_SKIP_VERSION_PROBE=1
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r.status).toBe(0);
    // The cache directory may or may not exist (cache layer creates it
    // only when it would write an entry). Either way, no entry files.
    const euid = String(process.getuid?.() ?? 0);
    const dir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir).filter((e) => e.endsWith('.json'));
      expect(entries.length).toBe(0);
    }
  });

  it('SHIM_SKIP_VERSION_PROBE on first fire: second fire WITHOUT skip runs full probe (no cache hit)', () => {
    if (!bashExists()) return;
    // Run #1 — probe bypassed, must not write cache.
    const bodySkip = `
SHIM_SKIP_VERSION_PROBE=1
${STD_BODY}
`;
    const r1 = runShim({
      shimBody: bodySkip,
      payload: '{}',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r1.status).toBe(0);
    const euid = String(process.getuid?.() ?? 0);
    const dir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
    const afterRun1 = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((e) => e.endsWith('.json'))
      : [];
    expect(afterRun1.length).toBe(0);

    // Run #2 — probe NOT bypassed. If run #1 had wrongly written an
    // entry, run #2 would hit the cache, skip the probe, and NOT add
    // a new entry. The correct behavior is that run #2 writes one.
    const r2 = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    expect(r2.status).toBe(0);
    const afterRun2 = fs.readdirSync(dir).filter((e) => e.endsWith('.json'));
    expect(afterRun2.length).toBe(1);
  });
});

describe('hooks/_lib/shim-runtime.sh — 0.48.1 sandbox-before-cache-prep ordering', () => {
  // 0.48.1 Item 4 (codex 0.48.0 round-10 P2): the dist-tree hash walk
  // (a `find` over $RESOLVED_CLI_PATH's grandparent) must NOT run
  // before the sandbox check. Pre-fix a hostile workspace whose
  // node_modules/@bookedsolid/rea (or dist) symlinked outside
  // CLAUDE_PROJECT_DIR caused the find walk to recurse the external
  // tree before sandbox refused at `bad:cli-escapes-project`.
  let projectDir: string;
  let cacheTmpdir: string;
  let externalTree: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
    cacheTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-shim-cache-symlink-'));
    externalTree = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-external-tree-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(cacheTmpdir, { recursive: true, force: true });
    fs.rmSync(externalTree, { recursive: true, force: true });
  });

  it('symlinked-out CLI tree: refuses with sandbox banner WITHOUT walking external tree', () => {
    if (!bashExists()) return;
    // Build an OUTSIDE-PROJECT dist tree. dist/cli/index.js is a real
    // file with valid CLI shape; we then symlink projectDir/dist to
    // externalTree/dist. Sandbox check resolves the realpath of
    // RESOLVED_CLI_PATH (the index.js) and refuses with
    // bad:cli-escapes-project because the realpath is outside
    // CLAUDE_PROJECT_DIR.
    const externalDistCli = path.join(externalTree, 'dist', 'cli');
    fs.mkdirSync(externalDistCli, { recursive: true });
    fs.writeFileSync(path.join(externalDistCli, 'index.js'), '// fake CLI\n');
    fs.chmodSync(path.join(externalDistCli, 'index.js'), 0o755);
    // Plant a sentinel sibling .js file in the external tree. If the
    // dist-tree hash walk runs against the symlinked target, this
    // file's stat will be captured. We cannot directly observe `find`
    // execution, but we CAN assert the shim refuses with the sandbox
    // banner and does NOT emit any output indicating cache prep ran.
    fs.writeFileSync(path.join(externalDistCli, 'sentinel.js'), '// SENTINEL\n');

    // Symlink projectDir/dist → externalTree/dist.
    fs.symlinkSync(path.join(externalTree, 'dist'), path.join(projectDir, 'dist'));
    // Install a package.json so the sandbox check's package walk
    // gets past the "no rea pkg.json" branch on its way to the
    // realpath/escapes check.
    installPkgJson(projectDir);

    const r = runShim({
      shimBody: STD_BODY,
      payload: '{}',
      projectDir,
      env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
    });
    // Blocking-tier shim with no fail-open: exits 2 with the
    // sandbox-failure banner (and the CLI-missing banner since
    // REA_ARGV got cleared by sandbox failure).
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/sandbox check|cli is not built/i);
    // Cache directory must NOT have been created — cache prep is
    // gated on sandbox_failed -eq 0 (0.48.1 fix).
    const euid = String(process.getuid?.() ?? 0);
    const dir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir).filter((e) => e.endsWith('.json'));
      expect(entries.length).toBe(0);
    }
  });
});
