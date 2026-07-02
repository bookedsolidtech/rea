/**
 * Hermetic tests for `rea install --global`.
 *
 * `npm view` / `npm install` are injected via `deps` so no test hits the
 * network; `home` + `cwd` are injected so the real `~/.rea/` is never mutated.
 * The install refusal paths (unsafe root, inside-a-checkout, version-not-in-
 * registry) are the security-load-bearing cases.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalRoot, reaDir, readRegistry, resolveGlobalCli, type ProcReader } from '../global-cli.js';
import { runInstallGlobal, HOOK_POLICY_GET_FLOOR, type InstallGlobalDeps } from './global.js';
import { REA_PACKAGE_NAME } from './self-pin.js';

// Real ancestry contains `claude`; happy/refusal paths inject a benign reader.
const noClaude: ProcReader = () => null;
const claudeAncestor: ProcReader = () => ({ ppid: 1, comm: '/usr/local/bin/claude' });

let home: string;
let cwd: string;
let logs: string[];
let errs: string[];
let savedCpd: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-install-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-install-cwd-'));
  logs = [];
  errs = [];
  // Clear the governed-session signal so happy-path installs run "as a human".
  savedCpd = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedCpd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedCpd;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

/**
 * A deps stub whose `npmInstall` materializes the npm-shape CLI file. The
 * capability probe defaults to PASS; pass `{ probeOk: false }` to simulate a
 * too-old CLI that lacks `hook policy-get`.
 */
function installingDeps(
  installHome: string,
  opts: { probeOk?: boolean } = {},
): InstallGlobalDeps & {
  viewCalls: string[];
  installCalls: Array<{ prefix: string; spec: string }>;
  probeCalls: string[];
} {
  const viewCalls: string[] = [];
  const installCalls: Array<{ prefix: string; spec: string }> = [];
  const probeCalls: string[] = [];
  const probeOk = opts.probeOk !== false;
  return {
    viewCalls,
    installCalls,
    probeCalls,
    npmView(spec: string) {
      viewCalls.push(spec);
      return { ok: true, version: '9.9.9' };
    },
    npmInstall(prefix: string, spec: string) {
      installCalls.push({ prefix, spec });
      // Materialize a SANDBOX-VALID npm-shape tree, matching what a real
      // `npm install --prefix` produces: the dist/cli/index.js entrypoint AND
      // the ancestor package.json with the rea name (A3). Without the
      // package.json, checkGlobalCandidateSafety would reject the tree.
      const pkgDir = path.join(globalRoot(installHome), 'node_modules', '@bookedsolid', 'rea');
      const cli = path.join(pkgDir, 'dist', 'cli', 'index.js');
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, '// installed cli', 'utf8');
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: REA_PACKAGE_NAME, version: '9.9.9' }),
        'utf8',
      );
      return { ok: true };
    },
    probeCapability(cliPath: string) {
      probeCalls.push(cliPath);
      return probeOk ? { ok: true } : { ok: false, stderr: 'unknown command: policy-get' };
    },
  };
}

describe('runInstallGlobal — happy path', () => {
  it('installs, re-asserts perms, prints "Installed", exit 0', () => {
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', home, cwd }, deps);
    expect(code).toBe(0);
    expect(deps.viewCalls).toEqual([`${REA_PACKAGE_NAME}@9.9.9`]);
    expect(deps.installCalls).toEqual([
      { prefix: globalRoot(home), spec: `${REA_PACKAGE_NAME}@9.9.9` },
    ]);
    expect(resolveGlobalCli(home)).not.toBeNull();
    expect(logs.some((l) => l.includes(`Installed ${REA_PACKAGE_NAME}@9.9.9`))).toBe(true);
    if (typeof process.getuid === 'function') {
      expect(fs.lstatSync(reaDir(home)).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(globalRoot(home)).mode & 0o777).toBe(0o700);
    }
  });

  it('--trust . also trusts the cwd after installing', () => {
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', trust: true, home, cwd }, deps);
    expect(code).toBe(0);
    expect(readRegistry(home)).toEqual([fs.realpathSync(cwd)]);
  });

  it('defaults the version to the running rea version', () => {
    const deps = installingDeps(home);
    runInstallGlobal({ procReader: noClaude, home, cwd }, deps);
    expect(deps.viewCalls[0]).toMatch(new RegExp(`^${REA_PACKAGE_NAME.replace('/', '\\/')}@`));
  });
});

describe('runInstallGlobal — idempotency', () => {
  // Pre-install a SANDBOX-VALID npm-shape CLI with a readable package.json
  // version (index.js + ancestor package.json with the rea name — A3).
  function preinstallVersion(v: string): void {
    const pkgDir = path.join(globalRoot(home), 'node_modules', '@bookedsolid', 'rea');
    fs.mkdirSync(path.join(pkgDir, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'cli', 'index.js'), '// pre', 'utf8');
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: REA_PACKAGE_NAME, version: v }),
      'utf8',
    );
  }

  it('already installed + no --force → skips npm, re-asserts perms, exit 0', () => {
    preinstallVersion('9.9.9'); // sandbox-valid tree
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', home, cwd }, deps);
    expect(code).toBe(0);
    expect(deps.viewCalls).toEqual([]); // no registry probe
    expect(deps.installCalls).toEqual([]); // no install
    expect(deps.probeCalls).toHaveLength(1); // sandbox passed → probe ran
    expect(logs.some((l) => l.includes('already installed'))).toBe(true);
  });

  it('--version DIFFERS from installed → reinstalls (npm view + install run)', () => {
    preinstallVersion('9.9.8');
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', home, cwd }, deps);
    expect(code).toBe(0);
    expect(deps.viewCalls).toEqual([`${REA_PACKAGE_NAME}@9.9.9`]);
    expect(deps.installCalls).toEqual([
      { prefix: globalRoot(home), spec: `${REA_PACKAGE_NAME}@9.9.9` },
    ]);
    expect(logs.some((l) => l.includes('installed but v9.9.9 requested — reinstalling'))).toBe(true);
  });

  it('--version EQUALS installed → no-op (no npm)', () => {
    preinstallVersion('9.9.9');
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', home, cwd }, deps);
    expect(code).toBe(0);
    expect(deps.viewCalls).toEqual([]);
    expect(deps.installCalls).toEqual([]);
    expect(logs.some((l) => l.includes('already installed (v9.9.9)'))).toBe(true);
  });

  it('no --version → no-op even when the installed version is older (unchanged)', () => {
    preinstallVersion('9.9.8');
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, home, cwd }, deps);
    expect(code).toBe(0);
    expect(deps.viewCalls).toEqual([]);
    expect(deps.installCalls).toEqual([]);
  });

  // P3 (codex): `install --global --trust <path-with-\r>` must refuse (exit 2)
  // and persist NOTHING — the same shared control-char guard `rea trust` uses.
  it.skipIf(process.platform === 'win32')(
    '--trust a path containing a carriage return → exit 2, no "Trusted:", registry unchanged',
    () => {
      // Pre-create a SANDBOX-VALID CLI so the fast idempotent path runs (no npm)
      // AND passes the candidate sandbox — so the flow reaches the addTrust
      // control-char refusal (exit 2), not the sandbox refusal (exit 1).
      preinstallValidTree(home);
      const crDir = path.join(cwd, 'has\rcr');
      fs.mkdirSync(crDir);

      const deps = installingDeps(home);
      const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', trust: crDir, home, cwd }, deps);
      expect(code).toBe(2);
      expect(errs.some((e) => e.includes('invalid path: contains control characters'))).toBe(true);
      expect(logs.some((l) => l.startsWith('[rea] Trusted:'))).toBe(false);
      expect(readRegistry(home)).toEqual([]);
    },
  );
});

describe('runInstallGlobal — refusals (BEFORE install)', () => {
  it('refuses a world-writable <home>/.rea and never shells out', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    fs.mkdirSync(reaDir(home), { recursive: true });
    fs.chmodSync(reaDir(home), 0o777);
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', home, cwd }, deps);
    expect(code).toBe(1);
    expect(deps.viewCalls).toEqual([]);
    expect(deps.installCalls).toEqual([]);
    expect(errs.some((e) => e.includes(`chmod 700 ${reaDir(home)}`))).toBe(true);
  });

  it('refuses a symlinked <home>/.rea', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-install-symtgt-'));
    try {
      fs.symlinkSync(target, reaDir(home));
      const deps = installingDeps(home);
      const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', home, cwd }, deps);
      expect(code).toBe(1);
      expect(deps.installCalls).toEqual([]);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('refuses when <home>/.rea resolves inside the current git checkout', () => {
    // A real git repo used as BOTH home and cwd → <home>/.rea is inside it.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-install-repo-'));
    try {
      execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
      const deps = installingDeps(repo);
      const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', home: repo, cwd: repo }, deps);
      expect(code).toBe(1);
      expect(deps.viewCalls).toEqual([]);
      expect(deps.installCalls).toEqual([]);
      expect(errs.some((e) => e.includes('INSIDE the current git checkout'))).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses a version not in the npm registry and never installs', () => {
    const installCalls: Array<{ prefix: string; spec: string }> = [];
    const deps: InstallGlobalDeps = {
      npmView() {
        return { ok: false, stderr: 'npm ERR! 404 Not Found' };
      },
      npmInstall(prefix: string, spec: string) {
        installCalls.push({ prefix, spec });
        return { ok: true };
      },
      probeCapability() {
        return { ok: true };
      },
    };
    // A version >= the floor (so the cheap floor gate does NOT short-circuit)
    // that the npm-view mock reports as missing.
    const code = runInstallGlobal({ procReader: noClaude, version: '99.99.99', home, cwd }, deps);
    expect(code).toBe(1);
    expect(installCalls).toEqual([]);
    expect(errs.some((e) => e.includes('was not found in the npm registry'))).toBe(true);
  });

  it('exit 1 when npm install itself fails', () => {
    const deps: InstallGlobalDeps = {
      npmView() {
        return { ok: true, version: '9.9.9' };
      },
      npmInstall() {
        return { ok: false, stderr: 'ENOSPC' };
      },
      probeCapability() {
        return { ok: true };
      },
    };
    const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', home, cwd }, deps);
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('failed'))).toBe(true);
    expect(resolveGlobalCli(home)).toBeNull();
  });

  it('refuses under a governed agent session and never shells out or writes', () => {
    process.env.CLAUDE_PROJECT_DIR = '/some/agent/project';
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', trust: true, home, cwd }, deps);
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('This is a human action'))).toBe(true);
    expect(deps.viewCalls).toEqual([]);
    expect(deps.installCalls).toEqual([]);
    // No install, no trust write.
    expect(resolveGlobalCli(home)).toBeNull();
    expect(readRegistry(home)).toEqual([]);
  });

  it('refuses the CLAUDE_PROJECT_DIR bypass: unset var BUT a claude ancestor → exit 1, no npm', () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: claudeAncestor, version: '9.9.9', home, cwd }, deps);
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('a Claude Code process is an ancestor'))).toBe(true);
    expect(deps.viewCalls).toEqual([]);
    expect(deps.installCalls).toEqual([]);
    expect(resolveGlobalCli(home)).toBeNull();
  });
});

describe('runInstallGlobal — global-tier capability floor (P2)', () => {
  it('refuses an explicit --version below the hook policy-get floor (cheap gate, no npm)', () => {
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, version: '0.25.0', home, cwd }, deps);
    expect(code).toBe(1);
    expect(deps.viewCalls).toEqual([]); // short-circuits BEFORE npm view
    expect(deps.installCalls).toEqual([]);
    expect(errs.some((e) => e.includes(HOOK_POLICY_GET_FLOOR))).toBe(true);
    expect(errs.some((e) => e.includes('too old'))).toBe(true);
  });

  it('installs, then FAILS when the fresh CLI lacks hook policy-get (probe fails) — no trust write', () => {
    const deps = installingDeps(home, { probeOk: false });
    const code = runInstallGlobal(
      { procReader: noClaude, version: '9.9.9', trust: true, home, cwd },
      deps,
    );
    expect(code).toBe(1);
    expect(deps.installCalls).toHaveLength(1); // install DID run (version >= floor, exists)
    expect(deps.probeCalls).toHaveLength(1); // probe ran against the fresh CLI
    expect(errs.some((e) => e.includes('does not implement `rea hook policy-get`'))).toBe(true);
    // The broken CLI must NOT get a trusted project.
    expect(readRegistry(home)).toEqual([]);
  });

  it('a current version passes the capability probe and installs (probe was actually run)', () => {
    const deps = installingDeps(home); // probeOk defaults true
    const code = runInstallGlobal({ procReader: noClaude, version: '9.9.9', home, cwd }, deps);
    expect(code).toBe(0);
    expect(deps.probeCalls).toHaveLength(1);
    expect(resolveGlobalCli(home)).not.toBeNull();
  });

  it('fails a pre-existing too-old install on the idempotent path (probe fails, no npm)', () => {
    // Sandbox-VALID pre-existing tree, but the CLI is too old → the sandbox
    // passes and the capability probe (probeOk:false) is what refuses.
    preinstallValidTree(home);
    const deps = installingDeps(home, { probeOk: false });
    const code = runInstallGlobal({ procReader: noClaude, trust: true, home, cwd }, deps);
    expect(code).toBe(1);
    expect(deps.viewCalls).toEqual([]); // idempotent path never reaches npm
    expect(deps.installCalls).toEqual([]);
    expect(deps.probeCalls).toHaveLength(1); // sandbox passed, THEN probe refused
    expect(errs.some((e) => e.includes('does not implement `rea hook policy-get`'))).toBe(true);
    expect(readRegistry(home)).toEqual([]); // no trust on a broken CLI
  });
});

/** A sandbox-valid npm-shape tree at `<home>/.rea/cli` (index.js + package.json). */
function preinstallValidTree(installHome: string): string {
  const pkgDir = path.join(globalRoot(installHome), 'node_modules', '@bookedsolid', 'rea');
  fs.mkdirSync(path.join(pkgDir, 'dist', 'cli'), { recursive: true });
  const cli = path.join(pkgDir, 'dist', 'cli', 'index.js');
  fs.writeFileSync(cli, '// pre', 'utf8');
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: REA_PACKAGE_NAME, version: '9.9.9' }),
    'utf8',
  );
  return cli;
}

describe('runInstallGlobal — sandbox the pre-existing candidate before probing (P2)', () => {
  it('refuses a SYMLINKED pre-existing candidate BEFORE any probe spawn (no --force)', () => {
    // Build a valid-looking tree, then replace index.js with a symlink to a
    // decoy — a same-uid repoint primitive the A2 lstat walk must reject.
    const pkgDir = path.join(globalRoot(home), 'node_modules', '@bookedsolid', 'rea');
    fs.mkdirSync(path.join(pkgDir, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: REA_PACKAGE_NAME, version: '9.9.9' }),
      'utf8',
    );
    const decoy = path.join(home, 'decoy.js');
    fs.writeFileSync(decoy, '// hostile', 'utf8');
    fs.symlinkSync(decoy, path.join(pkgDir, 'dist', 'cli', 'index.js'));

    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, trust: true, home, cwd }, deps);
    expect(code).toBe(1);
    expect(deps.probeCalls).toEqual([]); // NEVER spawned the candidate
    expect(deps.viewCalls).toEqual([]);
    expect(deps.installCalls).toEqual([]);
    expect(errs.some((e) => e.includes('failed the sandbox check'))).toBe(true);
    expect(readRegistry(home)).toEqual([]); // no trust on a rejected CLI
  });

  it('refuses a pre-existing candidate with no rea package.json (A3) BEFORE any probe spawn', () => {
    // index.js present but no ancestor @bookedsolid/rea package.json → A3 fails.
    const cliDir = path.join(globalRoot(home), 'node_modules', '@bookedsolid', 'rea', 'dist', 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'index.js'), '// no pkg', 'utf8');

    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, home, cwd }, deps);
    expect(code).toBe(1);
    expect(deps.probeCalls).toEqual([]); // NEVER spawned
    expect(errs.some((e) => e.includes('failed the sandbox check'))).toBe(true);
  });

  it('a SAFE pre-existing candidate passes the sandbox → probes + idempotent no-op', () => {
    preinstallValidTree(home);
    const deps = installingDeps(home);
    const code = runInstallGlobal({ procReader: noClaude, home, cwd }, deps);
    expect(code).toBe(0);
    expect(deps.probeCalls).toHaveLength(1); // sandbox passed, THEN probe ran
    expect(deps.installCalls).toEqual([]); // idempotent no-op
    expect(logs.some((l) => l.includes('already installed'))).toBe(true);
  });
});
