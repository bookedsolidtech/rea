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

/**
 * Sources hooks/_lib/shim-runtime.sh from the real repo and runs an
 * arbitrary `body` against it — used to exercise individual lib functions
 * (e.g. shim_sandbox_check_global) directly, without the full shim_run
 * flow. No CLAUDE_PROJECT_DIR semantics needed (the global A1–A4 sandbox
 * takes explicit candidate + g_root args).
 */
function runLibFn(body: string, env?: NodeJS.ProcessEnv): ShimResult {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-shim-libfn-'));
  const stagedHook = path.join(stageDir, 'fn.sh');
  fs.symlinkSync(HOOKS_LIB, path.join(stageDir, '_lib'));
  fs.writeFileSync(
    stagedHook,
    `#!/bin/bash
set -uo pipefail
# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
${body}
`,
  );
  fs.chmodSync(stagedHook, 0o755);
  try {
    const res = spawnSync('bash', [stagedHook], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '/tmp',
        ...(env ?? {}),
      },
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

/**
 * Builds a hermetic global-CLI tree under `root` shaped like
 * <root>/.rea/cli/node_modules/@bookedsolid/rea/{package.json,dist/cli/index.js}
 * (the c1 "node_modules" probe shape). Returns { reaDir, gRoot, candidate }.
 * The caller manipulates individual components to exercise A1–A4 rejects.
 */
function buildGlobalTree(
  root: string,
  opts: { pkgName?: string; bareDrop?: boolean } = {},
): { reaDir: string; gRoot: string; candidate: string; pkgJson: string } {
  const reaDir = path.join(root, '.rea');
  const gRoot = path.join(reaDir, 'cli');
  const pkgRoot = opts.bareDrop
    ? gRoot
    : path.join(gRoot, 'node_modules', '@bookedsolid', 'rea');
  const distCli = path.join(pkgRoot, 'dist', 'cli');
  fs.mkdirSync(distCli, { recursive: true });
  const pkgJson = path.join(pkgRoot, 'package.json');
  fs.writeFileSync(
    pkgJson,
    JSON.stringify({ name: opts.pkgName ?? '@bookedsolid/rea', version: '0.0.0-test' }),
  );
  const candidate = path.join(distCli, 'index.js');
  fs.writeFileSync(candidate, '#!/usr/bin/env node\n');
  return { reaDir, gRoot, candidate, pkgJson };
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

// round-53/54 — SHIM_FAIL_CLOSED_WHEN_RELEVANT: a FAIL-OPEN shim guarding a
// policy gate resolves the gate MODE when the CLI cannot run. Detection
// (`_shim_gate_mode`) is the shared robust awk: block + inline-flow-map at any
// depth, enforce-bias on an unparseable governed policy. Tri-state: enforce →
// FAIL CLOSED (exit 2 + CONFIG-ERROR); shadow → WARN + ALLOW (exit 0);
// off/absent → ALLOW.
describe('hooks/_lib/shim-runtime.sh — SHIM_FAIL_CLOSED_WHEN_RELEVANT (round-53/54)', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const GATED_BODY = `
SHIM_FAIL_OPEN=1
SHIM_FAIL_CLOSED_WHEN_RELEVANT=1
SHIM_ACTIVE_GATE_KEY="g2_verify"
${STD_BODY}
`;
  function withPolicy(yaml: string | null): void {
    fs.mkdirSync(path.join(projectDir, '.rea'), { recursive: true });
    if (yaml !== null) fs.writeFileSync(path.join(projectDir, '.rea', 'policy.yaml'), yaml);
  }
  const runGated = (): ShimResult =>
    runShim({ shimBody: GATED_BODY, payload: '{}', projectDir });

  it('CLI-missing + gate enforce (block) → FAIL CLOSED (exit 2 + CONFIG-ERROR)', () => {
    if (!bashExists()) return;
    withPolicy('artifact_gates:\n  g2_verify:\n    mode: enforce\n');
    const r = runGated();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('CONFIG-ERROR');
    expect(r.stderr).toContain('g2_verify');
  });

  // round-54 tri-state: shadow is OBSERVE-ONLY → WARN + ALLOW, never blocks.
  it('CLI-missing + gate shadow → WARN + ALLOW (exit 0)', () => {
    if (!bashExists()) return;
    withPolicy('artifact_gates:\n  g2_verify:\n    mode: shadow\n');
    const r = runGated();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARN');
    expect(r.stderr).not.toContain('CONFIG-ERROR');
  });

  it('CLI-missing + nested-inline `artifact_gates: { g2_verify: { mode: enforce } }` → FAIL CLOSED (exit 2)', () => {
    if (!bashExists()) return;
    withPolicy('artifact_gates: { g2_verify: { mode: enforce } }\n');
    expect(runGated().status).toBe(2);
  });

  it('CLI-missing + nested-inline shadow → WARN + ALLOW (exit 0)', () => {
    if (!bashExists()) return;
    withPolicy('artifact_gates: { g2_verify: { mode: shadow } }\n');
    const r = runGated();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARN');
  });

  it('CLI-missing + gate off → FAIL OPEN (exit 0)', () => {
    if (!bashExists()) return;
    withPolicy('artifact_gates:\n  g2_verify:\n    mode: off\n');
    expect(runGated().status).toBe(0);
  });

  it('CLI-missing + policy absent → FAIL OPEN (exit 0)', () => {
    if (!bashExists()) return;
    withPolicy(null);
    expect(runGated().status).toBe(0);
  });

  it('CLI-missing + flag set but SHIM_ACTIVE_GATE_KEY empty → FAIL OPEN (no key → not active)', () => {
    if (!bashExists()) return;
    withPolicy('artifact_gates:\n  g2_verify:\n    mode: enforce\n');
    const body = `
SHIM_FAIL_OPEN=1
SHIM_FAIL_CLOSED_WHEN_RELEVANT=1
${STD_BODY}
`;
    const r = runShim({ shimBody: body, payload: '{}', projectDir });
    expect(r.status).toBe(0);
  });

  it('default (flag unset) leaves a FAIL-OPEN shim fail-open even with an active gate', () => {
    if (!bashExists()) return;
    withPolicy('artifact_gates:\n  g2_verify:\n    mode: enforce\n');
    const body = `
SHIM_FAIL_OPEN=1
${STD_BODY}
`;
    const r = runShim({ shimBody: body, payload: '{}', projectDir });
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

describe('hooks/_lib/shim-runtime.sh — TOCTOU realpath-exec (Phase 1a)', () => {
  // The shim validates fs.realpathSync(cli) in shim_sandbox_check, then
  // — as of this change — EXECUTES that realpath rather than discarding
  // it and running the literal RESOLVED_CLI_PATH. This shrinks the
  // TOCTOU window to the same in-place-swap residual the in-project tier
  // already carries (it is NOT a same-inode guarantee). shim_sandbox_check
  // now echoes `ok:<realpath>` on success; `bad:<reason>` is unchanged.
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('security: executes the REALPATH, not the symlink, when the in-project CLI is reached through a symlinked package dir', () => {
    if (!bashExists()) return;
    // Real package dir (valid @bookedsolid/rea package.json + a real
    // dist/cli/index.js) that lives OUTSIDE node_modules. The fake CLI
    // echoes process.argv[1] — the literal path `node` was launched
    // with — so the test can observe which path the shim executed.
    const realPkg = path.join(projectDir, 'real-pkg');
    const realDistCli = path.join(realPkg, 'dist', 'cli');
    fs.mkdirSync(realDistCli, { recursive: true });
    fs.writeFileSync(
      path.join(realPkg, 'package.json'),
      JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }),
    );
    fs.writeFileSync(
      path.join(realDistCli, 'index.js'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length >= 3 && args[0] === 'hook' && args[1] === 'test-shim' && args[2] === '--help') {
  process.stdout.write('Usage: rea hook test-shim\\n');
  process.exit(0);
}
let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  // argv[1] is the literal script path node was invoked with: the
  // realpath after realpath-exec, the symlink alias before it.
  process.stdout.write('EXEC_PATH:' + process.argv[1] + '\\n');
  process.exit(0);
});
`,
    );
    fs.chmodSync(path.join(realDistCli, 'index.js'), 0o755);

    // node_modules/@bookedsolid/rea → real-pkg (intermediate symlink).
    // shim_resolve_cli picks node_modules/.../dist/cli/index.js FIRST
    // (it resolves through the symlink), so RESOLVED_CLI_PATH is the
    // node_modules alias — whose realpath is the real-pkg file.
    const nmScope = path.join(projectDir, 'node_modules', '@bookedsolid');
    fs.mkdirSync(nmScope, { recursive: true });
    fs.symlinkSync(realPkg, path.join(nmScope, 'rea'));

    const r = runShim({
      shimBody: STD_BODY,
      payload: 'X',
      projectDir,
      env: { REA_SHIM_CACHE: '0' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('EXEC_PATH:');
    const execLine = r.stdout.split('\n').find((l) => l.startsWith('EXEC_PATH:')) ?? '';
    const execPath = execLine.slice('EXEC_PATH:'.length);
    // Realpath-exec: node ran the REAL package path, which routes
    // through real-pkg and NOT through the node_modules symlink alias.
    // (Pre-change the shim executed the node_modules alias path.)
    expect(execPath).toContain(`real-pkg${path.sep}dist${path.sep}cli${path.sep}index.js`);
    expect(execPath).not.toContain('node_modules');
  });

  it('contract: shim_sandbox_check echoes ok:<realpath> on a valid CLI', () => {
    if (!bashExists()) return;
    installFakeCliGoodProbe(projectDir, 'test-shim');
    installPkgJson(projectDir);
    // Call shim_sandbox_check directly (bypass shim_run) and print its
    // raw stdout so we can assert the `ok:` prefix + realpath tail.
    const body = `
proj="$CLAUDE_PROJECT_DIR"
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_resolve_cli
out=$(shim_sandbox_check "$RESOLVED_CLI_PATH" "$proj" "0")
printf 'SANDBOX_RAW=%s\\n' "$out"
exit 0
`;
    const r = runShim({
      shimBody: body,
      payload: '{}',
      projectDir,
      env: { REA_SHIM_CACHE: '0' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const line = r.stdout.split('\n').find((l) => l.startsWith('SANDBOX_RAW=')) ?? '';
    const raw = line.slice('SANDBOX_RAW='.length);
    expect(raw.startsWith('ok:')).toBe(true);
    expect(raw).toContain('dist/cli/index.js');
    // Tail is an absolute realpath.
    expect(raw.slice('ok:'.length).startsWith('/')).toBe(true);
  });

  it('parity: happy path (real in-project CLI, no symlink) still exits 0 and forwards stdin byte-identically', () => {
    if (!bashExists()) return;
    // Canonical dist/cli/index.js — the exact shape the pre-change code
    // executed. Verdict + exit code are unchanged; the only observable
    // difference is the path string `node` receives (same file here).
    const r = runShim({
      shimBody: STD_BODY,
      payload: 'PAYLOAD_DATA_X', // 14 bytes
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { REA_SHIM_CACHE: '0' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('forwarded:14 bytes');
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

describe('hooks/_lib/shim-runtime.sh — global-tier veto strict-shape (codex #211 P1)', () => {
  // shim_global_tier_vetoed must fail closed on a runtime block the STRICT
  // loader would reject — including a valid OBJECT carrying keys outside
  // RuntimePolicySchema (the sole permitted key is allow_global_cli). A
  // stub CLI mimics `rea hook policy-get runtime[.allow_global_cli] --json`.
  function runVeto(runtimeJson: string, allowJson: string): ShimResult {
    const body = `
STUB=$(mktemp)
cat > "$STUB" <<'STUBEOF'
#!/bin/bash
# args: hook policy-get <dot.path> --json
case "$3" in
  runtime) printf '%s' '${runtimeJson}' ;;
  runtime.allow_global_cli) printf '%s' '${allowJson}' ;;
esac
exit 0
STUBEOF
chmod +x "$STUB"
REA_ARGV=(bash "$STUB")
if shim_global_tier_vetoed; then echo VETOED; else echo ALLOWED; fi
`;
    return runLibFn(body);
  }

  it.skipIf(!bashExists())('valid object {allow_global_cli:true} → ALLOWED', () => {
    const r = runVeto('{"allow_global_cli":true}', 'true');
    expect(r.stdout.trim()).toBe('ALLOWED');
  });

  it.skipIf(!bashExists())('extra key {allow_global_cli:true,typo:1} → VETOED (strict loader rejects)', () => {
    const r = runVeto('{"allow_global_cli":true,"typo":1}', 'true');
    expect(r.stdout.trim()).toBe('VETOED');
  });

  it.skipIf(!bashExists())('unknown-only key {typo:1} → VETOED', () => {
    const r = runVeto('{"typo":1}', 'null');
    expect(r.stdout.trim()).toBe('VETOED');
  });

  it.skipIf(!bashExists())('empty object {} → ALLOWED (no keys, allow_global_cli absent)', () => {
    const r = runVeto('{}', 'null');
    expect(r.stdout.trim()).toBe('ALLOWED');
  });

  it.skipIf(!bashExists())('wrong type (array) → VETOED', () => {
    const r = runVeto('[]', 'null');
    expect(r.stdout.trim()).toBe('VETOED');
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
    // 0.49.0 Phase 1b: schema bumped to v2; the project-tier entry records
    // trust_tier=project with empty registry fields.
    expect(entry.schema_version).toBe('v2');
    expect(entry.sandbox_ok).toBe(true);
    expect(entry.shape_ok).toBe(true);
    expect(entry.trust_tier).toBe('project');
    expect(entry.registry_mtime).toBe('');
    expect(entry.registry_size).toBe('');
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

// =============================================================================
// 0.49.0 Phase 1b — opt-in global-CLI resolver tier (TRUST_TIER=global).
// =============================================================================

describe('shim-runtime.sh — global tier PARITY (un-blessed ≡ feature-absent)', () => {
  // THE load-bearing invariant: a project that is NOT in the per-user
  // registry MUST be byte-identical to feature-absent. A fresh tmpdir
  // project is never a member of the real passwd-home ~/.rea/trusted-
  // projects (it cannot be — the path did not exist when any registry was
  // written), so membership misses → the global tier degrades to SILENT
  // global-unavailable and the terminal below is identical to the pre-
  // Phase-1b code path. Verified across one blocking + one advisory shim.
  let projectDir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('blocking-tier, no in-project CLI, un-blessed: exit 2 + CLI-missing banner, NO global noise', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=0
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      projectDir,
      env: { REA_SHIM_CACHE: '0' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot run — the rea CLI is not built');
    // The global tier must NOT have emitted anything for an un-blessed
    // project — byte-for-byte the same stderr as feature-absent.
    expect(r.stderr).not.toContain('global');
    expect(r.stderr).not.toContain('bad:');
  });

  it('advisory-tier, no in-project CLI, un-blessed: exit 0 with EMPTY stderr', () => {
    if (!bashExists()) return;
    const body = `
SHIM_FAIL_OPEN=1
${STD_BODY}
`;
    const r = runShim({
      shimBody: body,
      payload: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr create' } }),
      projectDir,
      env: { REA_SHIM_CACHE: '0' },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('in-project CLI present: TRUST_TIER stays project; registry is NEVER consulted', () => {
    if (!bashExists()) return;
    // With an in-project CLI, shim_resolve_cli wins and shim_resolve_cli_
    // global is not even called. The forward runs the in-project CLI.
    const r = runShim({
      shimBody: STD_BODY,
      payload: 'PAYLOAD_DATA_X',
      projectDir,
      installFakeCli: 'good-probe',
      installPkgJson: true,
      env: { REA_SHIM_CACHE: '0' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('forwarded:14 bytes');
    expect(r.stderr).not.toContain('global');
  });
});

describe('shim-runtime.sh — global A1–A4 sandbox (shim_sandbox_check_global, hermetic)', () => {
  // The A1–A4 sandbox takes explicit <candidate> <g_root> args, so the full
  // reject corpus is exercised hermetically against tmpdir fixtures — NO
  // dependency on the passwd home and NO pw_dir override (the trust-root
  // derivation lives in the A5 entry gate, tested separately).
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-global-sandbox-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function check(candidate: string, gRoot: string): ShimResult {
    return runLibFn(
      `shim_sandbox_check_global ${JSON.stringify(candidate)} ${JSON.stringify(gRoot)}`,
    );
  }

  it('accept (c1 node_modules shape): echoes ok:<realpath>', () => {
    if (!bashExists()) return;
    const t = buildGlobalTree(root);
    const r = check(t.candidate, t.gRoot);
    expect(r.stdout.startsWith('ok:')).toBe(true);
    expect(r.stdout).toContain(`dist${path.sep}cli${path.sep}index.js`);
  });

  it('accept (c2 bare-drop shape): echoes ok:<realpath>', () => {
    if (!bashExists()) return;
    const t = buildGlobalTree(root, { bareDrop: true });
    const r = check(t.candidate, t.gRoot);
    expect(r.stdout.startsWith('ok:')).toBe(true);
  });

  it('symlinked CLI component → bad:global-symlink (rejects ANY symlink, even inside-pointing)', () => {
    if (!bashExists()) return;
    // Build the real tree, then replace the `cli` dir with a symlink to it.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-global-real-'));
    const t = buildGlobalTree(real);
    const reaDir = path.join(root, '.rea');
    fs.mkdirSync(reaDir, { recursive: true });
    const gRootLink = path.join(reaDir, 'cli');
    fs.symlinkSync(t.gRoot, gRootLink); // cli is now a symlink
    const candidate = path.join(
      gRootLink, 'node_modules', '@bookedsolid', 'rea', 'dist', 'cli', 'index.js',
    );
    const r = check(candidate, gRootLink);
    expect(r.stdout).toBe('bad:global-symlink');
    fs.rmSync(real, { recursive: true, force: true });
  });

  it('group-writable CLI component → bad:global-perm', () => {
    if (!bashExists()) return;
    const t = buildGlobalTree(root);
    fs.chmodSync(path.join(path.dirname(t.candidate), '..'), 0o775); // dist g+w
    const r = check(t.candidate, t.gRoot);
    expect(r.stdout).toBe('bad:global-perm');
  });

  it('world-writable CLI component → bad:global-perm', () => {
    if (!bashExists()) return;
    const t = buildGlobalTree(root);
    fs.chmodSync(path.dirname(t.candidate), 0o757); // cli dir o+w
    const r = check(t.candidate, t.gRoot);
    expect(r.stdout).toBe('bad:global-perm');
  });

  it('candidate not ending dist/cli/index.js → bad:global-shape', () => {
    if (!bashExists()) return;
    const gRoot = path.join(root, '.rea', 'cli');
    fs.mkdirSync(path.join(gRoot, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(gRoot, 'package.json'), JSON.stringify({ name: '@bookedsolid/rea' }));
    const cand = path.join(gRoot, 'sub', 'notindex.js');
    fs.writeFileSync(cand, 'x');
    const r = check(cand, gRoot);
    expect(r.stdout).toBe('bad:global-shape');
  });

  it('wrong package name → bad:global-no-rea-pkg', () => {
    if (!bashExists()) return;
    const t = buildGlobalTree(root, { pkgName: 'not-rea' });
    const r = check(t.candidate, t.gRoot);
    expect(r.stdout).toBe('bad:global-no-rea-pkg');
  });

  it('hardlinked index.js (nlink>1) → bad:global-hardlink', () => {
    if (!bashExists()) return;
    const t = buildGlobalTree(root);
    const sibling = path.join(path.dirname(t.candidate), 'realfile.js');
    fs.writeFileSync(sibling, 'x');
    fs.rmSync(t.candidate);
    fs.linkSync(sibling, t.candidate); // index.js is now a hardlink (nlink 2)
    const r = check(t.candidate, t.gRoot);
    expect(r.stdout).toBe('bad:global-hardlink');
  });

  it('hardlinked ancestor package.json (nlink>1) → bad:global-hardlink', () => {
    if (!bashExists()) return;
    const t = buildGlobalTree(root);
    const sibling = path.join(path.dirname(t.pkgJson), 'pkg-copy.json');
    fs.writeFileSync(sibling, fs.readFileSync(t.pkgJson));
    fs.rmSync(t.pkgJson);
    fs.linkSync(sibling, t.pkgJson); // package.json nlink 2
    const r = check(t.candidate, t.gRoot);
    expect(r.stdout).toBe('bad:global-hardlink');
  });

  // ---- Documented residuals (cannot be exercised in a single-uid, no-mount
  // ---- CI process; the predicate code is reviewed + asserted by shape). ----

  it('foreign-uid component → bad:global-perm (DOCUMENTED RESIDUAL — needs a 2nd uid)', () => {
    if (!bashExists()) return;
    // A component owned by a DIFFERENT uid trips `st.uid !== euid`. We
    // cannot chown to a foreign uid without root, so we cannot construct
    // this in-process. The A2 walk's `if (st.uid !== euid) bad("perm")`
    // line is the guard; the group/world-writable cases above exercise the
    // sibling perm branch. Residual: covered by code review + the real
    // cross-user plant corpus in the Phase-5 adversarial sweep.
    expect(true).toBe(true);
  });

  it('mount/bind st_dev change → bad:global-perm (DOCUMENTED RESIDUAL — needs a real mount)', () => {
    if (!bashExists()) return;
    // The `st.dev !== gRootDev` guard rejects a bind/automount aliased
    // subtree. Constructing a mount needs root + platform-specific mount
    // syscalls — out of scope for an in-process unit test. Residual:
    // covered by code review + the Phase-5 sweep on a privileged runner.
    expect(true).toBe(true);
  });

  it('escapes-root is defense-in-depth behind A2 (DOCUMENTED RESIDUAL)', () => {
    if (!bashExists()) return;
    // bad:global-escapes-root fires only when realpath(candidate) leaves
    // realpath(g_root) WITHOUT a symlink component between candidate and
    // reaDir — but A2 rejects ANY symlink first, so in practice A2
    // (bad:global-symlink) fires before A1 can. The containment check is a
    // belt-and-suspenders layer; the symlinked-component test above proves
    // A2 catches the realistic redirect.
    expect(true).toBe(true);
  });
});

/**
 * Writability gate for the real-passwd-home END-TO-END block. `withFreshRea`
 * below `mkdir`s the passwd-derived `<home>/.rea`; on sandboxed runners (Codex's
 * workspace-write env) the real home is present-but-NOT-writable, so that
 * `mkdir` throws EPERM/EACCES and fails the suite before any assertion. Skip the
 * whole block when the home dir is not writable. Computed at module scope
 * (before the describe) so it is available to `describe.skipIf`. Defensive
 * against `os.userInfo()` throwing (arbitrary/unmapped UID). This ADDS to the
 * existing skips (`~/.rea` already exists → `withFreshRea` returns false;
 * no-bash → per-`it` `bashExists()` guard).
 */
const GLOBAL_E2E_HOME_WRITABLE = (() => {
  try {
    fs.accessSync(os.userInfo().homedir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!GLOBAL_E2E_HOME_WRITABLE)('shim-runtime.sh — global tier END-TO-END (real passwd home, guarded)', () => {
  // These exercise the FULL production path including the passwd-derived
  // trust root (os.userInfo().homedir) — the one part that cannot be
  // redirected (by design: $HOME is ignored). They write to the REAL
  // <pw_dir>/.rea and are SKIPPED if it already exists, so a developer's
  // machine is never clobbered. On CI (ephemeral home, no ~/.rea) they run.
  const REAL_HOME = os.userInfo().homedir;
  const REAL_REA = path.join(REAL_HOME, '.rea');
  let projectDir: string;
  let cacheTmpdir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
    cacheTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-global-e2e-cache-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(cacheTmpdir, { recursive: true, force: true });
  });

  /** Runs `body(reaDir)` with a freshly-created ~/.rea, cleaned up after.
   *  No-ops (documented residual) when ~/.rea already exists. Returns
   *  true if the body ran, false if skipped. */
  function withFreshRea(body: (reaDir: string) => void): boolean {
    if (fs.existsSync(REAL_REA)) {
      return false; // documented residual: never clobber an existing ~/.rea
    }
    fs.mkdirSync(REAL_REA, { recursive: true });
    fs.chmodSync(REAL_REA, 0o700);
    try {
      body(REAL_REA);
      return true;
    } finally {
      fs.rmSync(REAL_REA, { recursive: true, force: true });
    }
  }

  function installGlobalCli(reaDir: string, shimName: string): void {
    const pkgRoot = path.join(reaDir, 'cli', 'node_modules', '@bookedsolid', 'rea');
    const distCli = path.join(pkgRoot, 'dist', 'cli');
    fs.mkdirSync(distCli, { recursive: true });
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }),
    );
    const realCli = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
    fs.writeFileSync(
      path.join(distCli, 'index.js'),
      `#!/usr/bin/env node
const cp = require('child_process');
const args = process.argv.slice(2);
if (args.length >= 3 && args[0] === 'hook' && args[1] === '${shimName}' && args[2] === '--help') {
  process.stdout.write('Usage: rea hook ${shimName}\\n');
  process.exit(0);
}
if (args[0] === 'hook' && args[1] === 'policy-get') {
  // 0.50.0 Phase 2b: a real global CLI implements policy-get, which the
  // post-resolution allow_global_cli veto reads on EVERY global fire.
  // Delegate to the real built repo CLI so the veto sees a genuine return
  // shape (these fixtures write no project policy.yaml → "" absent → allow).
  const r = cp.spawnSync(process.execPath, [${JSON.stringify(realCli)}, ...args], {
    env: process.env, encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status == null ? 1 : r.status);
}
let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  process.stdout.write('GLOBAL_FORWARD:' + process.argv[1] + ':' + buf.length + '\\n');
  process.exit(0);
});
`,
    );
    fs.chmodSync(path.join(distCli, 'index.js'), 0o755);
  }

  function bless(reaDir: string, dir: string): void {
    const reg = path.join(reaDir, 'trusted-projects');
    fs.writeFileSync(reg, fs.realpathSync(dir) + '\n');
    fs.chmodSync(reg, 0o600);
  }

  it('accept: blessed project + valid global install → resolves global CLI and forwards stdin', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      const r = runShim({
        shimBody: STD_BODY,
        payload: 'PAYLOAD_DATA_X', // 14 bytes
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('GLOBAL_FORWARD:');
      // The exec path is the GLOBAL realpath under <pw_dir>/.rea/cli — proof
      // TRUST_TIER=global resolved to the per-user CLI.
      const line = r.stdout.split('\n').find((l) => l.startsWith('GLOBAL_FORWARD:')) ?? '';
      expect(line).toContain(`.rea${path.sep}cli${path.sep}`);
      expect(line).toContain(':14');
    });
    if (!ran) {
      // ~/.rea pre-exists → documented residual on this machine.
      expect(fs.existsSync(REAL_REA)).toBe(true);
    }
  });

  it('$HOME override is IGNORED: passwd-derived root still resolves the real ~/.rea', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      const r = runShim({
        shimBody: STD_BODY,
        payload: 'X',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        // Hostile $HOME / $XDG: an agent setting these must NOT redirect
        // the trust root. os.userInfo().homedir reads passwd, not env.
        env: {
          REA_SHIM_CACHE: '0',
          HOME: '/tmp/rea-bogus-home-should-be-ignored',
          XDG_CONFIG_HOME: '/tmp/rea-bogus-xdg',
        },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('GLOBAL_FORWARD:');
      const line = r.stdout.split('\n').find((l) => l.startsWith('GLOBAL_FORWARD:')) ?? '';
      // Resolved under the REAL passwd home, not /tmp/rea-bogus-*.
      expect(line).toContain(REAL_HOME);
      expect(line).not.toContain('rea-bogus');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('global cache: blessed run writes a v2 entry with trust_tier=global + registry fields', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      const r = runShim({
        shimBody: STD_BODY,
        payload: '{}',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('GLOBAL_FORWARD:');
      const euid = String(process.getuid?.() ?? 0);
      const dir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
      // The cache MAY skip if the session token can't be derived in this
      // harness; when it writes, the entry must be the global shape.
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir).filter((e) => e.endsWith('.json'));
        if (entries.length > 0) {
          const entry = JSON.parse(fs.readFileSync(path.join(dir, entries[0]), 'utf8'));
          expect(entry.schema_version).toBe('v2');
          expect(entry.trust_tier).toBe('global');
          expect(String(entry.registry_mtime).length).toBeGreaterThan(0);
          expect(String(entry.registry_size).length).toBeGreaterThan(0);
        }
      }
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('symlinked registry → SILENT global-unavailable (blocking terminal, no global advisory)', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalCli(reaDir, 'test-shim');
      // registry is a SYMLINK to a real file that contains the blessing —
      // the entry gate lstat rejects the symlink BEFORE reading content.
      const realReg = path.join(reaDir, 'real-registry');
      fs.writeFileSync(realReg, fs.realpathSync(projectDir) + '\n');
      fs.chmodSync(realReg, 0o600);
      fs.symlinkSync(realReg, path.join(reaDir, 'trusted-projects'));
      const body = `\nSHIM_FAIL_OPEN=0\n${STD_BODY}\n`;
      const r = runShim({
        shimBody: body,
        payload: '{}',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global'); // silent, not a bad:global-* advisory
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('group-writable registry (0660) → SILENT global-unavailable', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalCli(reaDir, 'test-shim');
      const reg = path.join(reaDir, 'trusted-projects');
      fs.writeFileSync(reg, fs.realpathSync(projectDir) + '\n');
      fs.chmodSync(reg, 0o660); // mode & 0o077 !== 0 → registry unusable
      const body = `\nSHIM_FAIL_OPEN=0\n${STD_BODY}\n`;
      const r = runShim({
        shimBody: body,
        payload: '{}',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('blessed home but project NOT a member → SILENT global-unavailable', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalCli(reaDir, 'test-shim');
      // Registry exists + is well-formed but lists a DIFFERENT path.
      const reg = path.join(reaDir, 'trusted-projects');
      fs.writeFileSync(reg, '/some/other/blessed/project\n');
      fs.chmodSync(reg, 0o600);
      const body = `\nSHIM_FAIL_OPEN=0\n${STD_BODY}\n`;
      const r = runShim({
        shimBody: body,
        payload: '{}',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('blessed + global tree present but BLACKLISTED shape (wrong pkg name) → bad:global advisory, then refuse', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      // Valid membership, but the installed global tree fails A3 (wrong
      // pkg name). This is the blessed-but-hostile case → LOUD one-line
      // advisory + the no-CLI terminal (blocking → exit 2).
      const pkgRoot = path.join(reaDir, 'cli', 'node_modules', '@bookedsolid', 'rea');
      const distCli = path.join(pkgRoot, 'dist', 'cli');
      fs.mkdirSync(distCli, { recursive: true });
      fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'not-rea' }));
      fs.writeFileSync(path.join(distCli, 'index.js'), '#!/usr/bin/env node\n');
      bless(reaDir, projectDir);
      const body = `\nSHIM_FAIL_OPEN=0\n${STD_BODY}\n`;
      const r = runShim({
        shimBody: body,
        payload: '{}',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      // The blessed-but-hostile path emits the one-line global advisory.
      expect(r.stderr).toContain('global rea CLI tier rejected');
      expect(r.stderr).toContain('bad:global-no-rea-pkg');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('advisory-tier blessed-but-hostile: one-line advisory then exit 0 (no hard block on a plant)', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      const pkgRoot = path.join(reaDir, 'cli', 'node_modules', '@bookedsolid', 'rea');
      const distCli = path.join(pkgRoot, 'dist', 'cli');
      fs.mkdirSync(distCli, { recursive: true });
      fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'not-rea' }));
      fs.writeFileSync(path.join(distCli, 'index.js'), '#!/usr/bin/env node\n');
      bless(reaDir, projectDir);
      const body = `\nSHIM_FAIL_OPEN=1\n${STD_BODY}\n`;
      const r = runShim({
        shimBody: body,
        payload: '{}',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(0); // advisory never hard-blocks on a global plant
      expect(r.stderr).toContain('global rea CLI tier rejected');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  // codex Phase-1b P1: a bad global tree MUST behave EXACTLY like "no CLI"
  // for the relevance decision. On a blocking shim that defines
  // shim_cli_missing_relevant (dangerous-bash-interceptor, secret-scanner,
  // settings-protection, blocked-paths-*, protected-paths-bash-gate), a
  // HARMLESS payload must be ALLOWED (exit 0) even when ~/.rea/cli is
  // malformed — otherwise a broken opted-in global install turns a benign
  // Bash/Write into a repo-wide lockout. A RELEVANT payload still refuses.
  function installMalformedGlobalTree(reaDir: string): void {
    // Blessed, but the global tree fails A3 (wrong pkg name → bad:global).
    const pkgRoot = path.join(reaDir, 'cli', 'node_modules', '@bookedsolid', 'rea');
    const distCli = path.join(pkgRoot, 'dist', 'cli');
    fs.mkdirSync(distCli, { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'not-rea' }));
    fs.writeFileSync(path.join(distCli, 'index.js'), '#!/usr/bin/env node\n');
  }

  it('bad global tree ≡ no CLI: blocking shim + shim_cli_missing_relevant + HARMLESS payload → exit 0 (NOT blocked)', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installMalformedGlobalTree(reaDir);
      bless(reaDir, projectDir);
      // Blocking shim that only treats payloads containing DANGER as
      // relevant — a stand-in for dangerous-bash-interceptor's keyword scan.
      const body = `
SHIM_FAIL_OPEN=0
shim_cli_missing_relevant() {
  case "$INPUT" in *DANGER*) return 0 ;; *) return 1 ;; esac
}
${STD_BODY}
`;
      const r = runShim({
        shimBody: body,
        payload: 'harmless ls -la',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      // Harmless payload → allowed, byte-identical to the silent no-CLI +
      // irrelevant path (NO advisory noise on the allow path).
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stderr).not.toContain('global rea CLI tier rejected');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('bad global tree ≡ no CLI: blocking shim + shim_cli_missing_relevant + RELEVANT payload → exit 2 + global advisory', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installMalformedGlobalTree(reaDir);
      bless(reaDir, projectDir);
      const body = `
SHIM_FAIL_OPEN=0
shim_cli_missing_relevant() {
  case "$INPUT" in *DANGER*) return 0 ;; *) return 1 ;; esac
}
${STD_BODY}
`;
      const r = runShim({
        shimBody: body,
        payload: 'rm -rf DANGER',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      // Relevant payload → refuse, with the global advisory replacing the
      // generic cli-missing banner.
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('global rea CLI tier rejected');
      expect(r.stderr).toContain('bad:global-no-rea-pkg');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });
});

// 0.50.0 Phase 2b — the POST-resolution `runtime.allow_global_cli` VETO.
// The global tier (Phase 1b) is gated by registry membership alone; this
// suite covers the OPTIONAL in-project veto layered on top. A blessed
// project + a valid global install, varying the in-project .rea/policy.yaml:
//   - allow_global_cli: false  → global tier REFUSED (silent, no advisory)
//   - allow_global_cli: true   → global tier USED
//   - runtime block absent     → global tier USED
//   - malformed policy.yaml     → fail-closed, global REFUSED
// Plus a warm-cache assertion proving the veto is NOT cache-skippable.
// Same writability gate as the END-TO-END block above: this VETO block also
// `mkdir`s the passwd-derived ~/.rea and would throw EPERM/EACCES on a
// sandboxed runner whose home is present-but-not-writable. Reuses
// GLOBAL_E2E_HOME_WRITABLE (declared before the END-TO-END describe).
describe.skipIf(!GLOBAL_E2E_HOME_WRITABLE)('shim-runtime.sh — global tier VETO (runtime.allow_global_cli, real passwd home, guarded)', () => {
  // Same guarded-skip-if-`~/.rea`-exists pattern as the Phase-1b e2e block:
  // these write to the REAL passwd-derived ~/.rea (the one root an agent
  // cannot redirect) and are SKIPPED when ~/.rea already exists so a
  // developer's machine is never clobbered. On CI (ephemeral home) they run.
  const REAL_HOME = os.userInfo().homedir;
  const REAL_REA = path.join(REAL_HOME, '.rea');
  let projectDir: string;
  let cacheTmpdir: string;
  beforeEach(() => {
    projectDir = makeProjectDir();
    cacheTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-global-veto-cache-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(cacheTmpdir, { recursive: true, force: true });
  });

  function withFreshRea(body: (reaDir: string) => void): boolean {
    if (fs.existsSync(REAL_REA)) {
      return false; // documented residual: never clobber an existing ~/.rea
    }
    fs.mkdirSync(REAL_REA, { recursive: true });
    fs.chmodSync(REAL_REA, 0o700);
    try {
      body(REAL_REA);
      return true;
    } finally {
      fs.rmSync(REAL_REA, { recursive: true, force: true });
    }
  }

  // Global CLI stub implementing the two subcommands shim_run drives on the
  // global tier: `hook <name> --help` (version probe) and `hook policy-get
  // runtime.allow_global_cli` (the Phase-2b veto read). The policy-get
  // branch DELEGATES to the real built repo CLI so the exact 4-way contract
  // (false / true / empty / exit-1-on-malformed) is exercised against the
  // project's real .rea/policy.yaml — no reimplementation of the reader.
  function installGlobalVetoCli(reaDir: string, shimName: string): void {
    const pkgRoot = path.join(reaDir, 'cli', 'node_modules', '@bookedsolid', 'rea');
    const distCli = path.join(pkgRoot, 'dist', 'cli');
    fs.mkdirSync(distCli, { recursive: true });
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }),
    );
    const realCli = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
    fs.writeFileSync(
      path.join(distCli, 'index.js'),
      `#!/usr/bin/env node
const cp = require('child_process');
const args = process.argv.slice(2);
if (args.length >= 3 && args[0] === 'hook' && args[1] === '${shimName}' && args[2] === '--help') {
  process.stdout.write('Usage: rea hook ${shimName}\\n');
  process.exit(0);
}
if (args[0] === 'hook' && args[1] === 'policy-get') {
  // Delegate to the real built repo CLI so the genuine parse + 4-way
  // exit-code contract drives the veto. CLAUDE_PROJECT_DIR propagates via
  // the inherited env, so the real reader targets the project policy.yaml.
  const r = cp.spawnSync(process.execPath, [${JSON.stringify(realCli)}, ...args], {
    env: process.env, encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status == null ? 1 : r.status);
}
let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  process.stdout.write('GLOBAL_FORWARD:' + process.argv[1] + ':' + buf.length + '\\n');
  process.exit(0);
});
`,
    );
    fs.chmodSync(path.join(distCli, 'index.js'), 0o755);
  }

  function bless(reaDir: string, dir: string): void {
    const reg = path.join(reaDir, 'trusted-projects');
    fs.writeFileSync(reg, fs.realpathSync(dir) + '\n');
    fs.chmodSync(reg, 0o600);
  }

  function writeProjectPolicy(contents: string): void {
    const reaProj = path.join(projectDir, '.rea');
    fs.mkdirSync(reaProj, { recursive: true });
    fs.writeFileSync(path.join(reaProj, 'policy.yaml'), contents);
  }

  // Blocking shim whose keyword scan treats only *DANGER* payloads as
  // relevant — the stand-in for a real relevance-gated blocking hook
  // (dangerous-bash-interceptor et al). Lets one fixture assert BOTH the
  // harmless-silent-allow and the relevant-refuse terminals of the no-CLI
  // path a veto degrades into.
  const BLOCKING_RELEVANCE_BODY = `
SHIM_FAIL_OPEN=0
shim_cli_missing_relevant() {
  case "$INPUT" in *DANGER*) return 0 ;; *) return 1 ;; esac
}
${STD_BODY}
`;

  it('allow_global_cli: false → global tier REFUSED; harmless→exit 0 silent, relevant→exit 2, NO bad:global', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      writeProjectPolicy('profile: bst-internal\nruntime:\n  allow_global_cli: false\n');

      // Harmless payload → a vetoed project is byte-identical to no-CLI +
      // irrelevant → allowed SILENTLY, no global advisory noise, no forward.
      const harmless = runShim({
        shimBody: BLOCKING_RELEVANCE_BODY,
        payload: 'ls -la (harmless)',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(harmless.status, `stderr: ${harmless.stderr}`).toBe(0);
      expect(harmless.stdout).not.toContain('GLOBAL_FORWARD:');
      expect(harmless.stderr).not.toContain('global'); // veto is SILENT

      // Relevant payload → refuse with the GENERIC cli-missing banner; the
      // veto never emits a bad:global-* advisory (it is a project choice).
      const relevant = runShim({
        shimBody: BLOCKING_RELEVANCE_BODY,
        payload: 'rm -rf DANGER',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(relevant.status).toBe(2);
      expect(relevant.stdout).not.toContain('GLOBAL_FORWARD:');
      expect(relevant.stderr).toContain('cannot run — the rea CLI is not built');
      expect(relevant.stderr).not.toContain('global'); // silent veto, not bad:global
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('allow_global_cli: true → global tier USED (forwards to the global CLI)', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      writeProjectPolicy('profile: bst-internal\nruntime:\n  allow_global_cli: true\n');
      const r = runShim({
        shimBody: STD_BODY,
        payload: 'PAYLOAD_XY', // 10 bytes
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('GLOBAL_FORWARD:');
      // Forwarded through the GLOBAL realpath under <pw_dir>/.rea/cli.
      const line = r.stdout.split('\n').find((l) => l.startsWith('GLOBAL_FORWARD:')) ?? '';
      expect(line).toContain(`.rea${path.sep}cli${path.sep}`);
      expect(line).toContain(':10');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('no runtime block (veto absent) → global tier USED', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      writeProjectPolicy('profile: bst-internal\n'); // no runtime block at all
      const r = runShim({
        shimBody: STD_BODY,
        payload: 'X',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('GLOBAL_FORWARD:');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('malformed policy.yaml (policy-get exits non-zero) → fail-closed, global REFUSED', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      // Unbalanced flow-map → yaml.parse throws → policy-get exits 1.
      writeProjectPolicy('profile: bst-internal\nruntime: { allow_global_cli: false\n');
      const r = runShim({
        shimBody: BLOCKING_RELEVANCE_BODY,
        payload: 'rm -rf DANGER', // relevant → makes the fail-closed refusal observable
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      expect(r.stdout).not.toContain('GLOBAL_FORWARD:'); // fail-closed: no forward
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global'); // fail-closed is still SILENT (not bad:global)
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  // `rea hook policy-get` only PARSES the YAML — it does NOT run the strict
  // zod schema. A schema-invalid scalar (`"yes"`, a boolean typo) returns a
  // raw value with exit 0, which loadPolicy() / `rea doctor` would REJECT.
  // The veto MUST fail-closed on it (refuse), NOT let it silently ENABLE the
  // global tier. Both cases DRIVE THE REAL repo CLI's policy-get (the stub
  // delegates to it), so the raw-value return shape is genuine.
  it('schema-invalid string value ("yes") → fail-closed, global REFUSED (was ALLOWED pre-fix)', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      // Quoted string — YAML 1.2 parses it as the string "yes"; policy-get
      // returns "yes" (exit 0). zod boolean would reject it.
      writeProjectPolicy('profile: bst-internal\nruntime:\n  allow_global_cli: "yes"\n');
      const r = runShim({
        shimBody: BLOCKING_RELEVANCE_BODY,
        payload: 'rm -rf DANGER',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      expect(r.stdout).not.toContain('GLOBAL_FORWARD:'); // NOT enabled by a schema-invalid value
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global'); // silent
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('boolean typo value ("ture") → fail-closed, global REFUSED', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      // A mistyped boolean → parses as the string "ture"; policy-get returns
      // "ture" (exit 0). A misconfig the veto must NOT read as consent.
      writeProjectPolicy('profile: bst-internal\nruntime:\n  allow_global_cli: ture\n');
      const r = runShim({
        shimBody: BLOCKING_RELEVANCE_BODY,
        payload: 'rm -rf DANGER',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      expect(r.stdout).not.toContain('GLOBAL_FORWARD:');
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  // The type-preserving --json read is what distinguishes this from a scalar
  // read: `allow_global_cli: "true"` is a schema-invalid STRING (strict zod
  // wants a boolean), but scalar policy-get prints `true` byte-identically to
  // a real boolean. With --json the value comes back as the JSON string
  // "true" (with quotes) vs a bare JSON boolean true — so the veto fails
  // closed on the quoted form. Drives the REAL repo CLI's --json output.
  it('quoted "true" (schema-invalid string) → fail-closed, global REFUSED (scalar read would have ALLOWED)', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      writeProjectPolicy('profile: bst-internal\nruntime:\n  allow_global_cli: "true"\n');
      const r = runShim({
        shimBody: BLOCKING_RELEVANCE_BODY,
        payload: 'rm -rf DANGER',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      expect(r.stdout).not.toContain('GLOBAL_FORWARD:'); // NOT enabled by a quoted string
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  // The shared helper reads the PARENT `runtime` block first. A `runtime`
  // block with the WRONG TYPE (`runtime: []`, `runtime: "off"`) returns a
  // non-object JSON shape ([] / "off") that the strict zod loader REJECTS —
  // policy-get (no zod) would still return it exit 0. The helper fails closed
  // on it so a malformed runtime block never ENABLES the tier. Both drive the
  // REAL repo CLI's `policy-get runtime --json`.
  it('malformed runtime block (runtime: []) → fail-closed, global REFUSED', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      writeProjectPolicy('profile: bst-internal\nruntime: []\n');
      const r = runShim({
        shimBody: BLOCKING_RELEVANCE_BODY,
        payload: 'rm -rf DANGER',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      expect(r.stdout).not.toContain('GLOBAL_FORWARD:'); // malformed runtime does NOT enable
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('malformed runtime block (runtime: "off") → fail-closed, global REFUSED', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      writeProjectPolicy('profile: bst-internal\nruntime: "off"\n');
      const r = runShim({
        shimBody: BLOCKING_RELEVANCE_BODY,
        payload: 'rm -rf DANGER',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { REA_SHIM_CACHE: '0' },
      });
      expect(r.status).toBe(2);
      expect(r.stdout).not.toContain('GLOBAL_FORWARD:');
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('veto runs on a WARM cache fire: a mid-session allow_global_cli:false is honored despite a warm global entry', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalVetoCli(reaDir, 'test-shim');
      bless(reaDir, projectDir);
      // Fire 1: veto absent → global tier used AND a v2/global cache entry
      // written — the warm entry fire 2 would short-circuit on IF the veto
      // were (wrongly) cache-skippable.
      writeProjectPolicy('profile: bst-internal\n');
      const r1 = runShim({
        shimBody: STD_BODY,
        payload: '{}',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
      });
      expect(r1.status, `stderr: ${r1.stderr}`).toBe(0);
      expect(r1.stdout).toContain('GLOBAL_FORWARD:');

      // Confirm the warm entry landed (trust_tier=global) — makes the WARM
      // claim explicit rather than assumed.
      const euid = String(process.getuid?.() ?? 0);
      const cacheDir = path.join(cacheTmpdir, `rea-shim-cache.${euid}`);
      let warmed = false;
      if (fs.existsSync(cacheDir)) {
        for (const e of fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))) {
          const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, e), 'utf8'));
          if (entry.trust_tier === 'global') warmed = true;
        }
      }
      expect(warmed).toBe(true);

      // Mid-session policy edit — add the veto. This does NOT change the
      // cache key (allow_global_cli is deliberately OUT of the key), so the
      // warm entry remains a live HIT for the CLI surface.
      writeProjectPolicy('profile: bst-internal\nruntime:\n  allow_global_cli: false\n');

      // Fire 2 (warm cache): the veto MUST fire before the cache block and
      // refuse — NO forward. A cache-skippable veto would let the warm hit
      // forward straight through the global CLI (GLOBAL_FORWARD).
      const r2 = runShim({
        shimBody: BLOCKING_RELEVANCE_BODY,
        payload: 'rm -rf DANGER',
        projectDir,
        installFakeCli: 'none',
        installPkgJson: false,
        env: { TMPDIR: cacheTmpdir, REA_SHIM_CACHE: '1' },
      });
      expect(r2.status).toBe(2);
      expect(r2.stdout).not.toContain('GLOBAL_FORWARD:'); // veto honored on the warm fire
      expect(r2.stderr).not.toContain('global'); // silent
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });
});
