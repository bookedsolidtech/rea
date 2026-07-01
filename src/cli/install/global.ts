/**
 * `rea install --global [--version <semver>] [--trust .] [--force]`
 *
 * Installs the rea CLI once, per-user, OUT of any project (design §9): a REAL
 * `npm install --prefix <home>/.rea/cli @bookedsolid/rea@<ver>` (never a
 * symlink), so the opt-in global shim tier can resolve a governed CLI for a
 * blessed checkout without touching that checkout's shared `package.json`.
 *
 * SAFETY (refuse BEFORE install):
 *   - `<home>/.rea` must not be a symlink / foreign-owned / group-or-world
 *     writable (reuses `checkReaDirSafety` → exact remediation strings).
 *   - `<home>/.rea` must NOT resolve inside the current git checkout (a config
 *     root inside the repo would make the global CLI a committable artifact) —
 *     mirrors openrouter-key-source's `isInsideReviewedCheckout`.
 *   - The requested version must exist in the npm registry (`npm view`
 *     pre-check — CLAUDE.md rule: never install an unverified package).
 *
 * TEST ISOLATION: `home` + `cwd` are injectable and default to the passwd home
 * + `process.cwd()`; the `npm view` / `npm install` shell-outs are injectable
 * `deps` so tests never hit the network or mutate the real `~/.rea/`.
 */

import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import {
  assertNotGovernedSession,
  checkGlobalCandidateSafety,
  checkReaDirSafety,
  globalRoot,
  installedGlobalCliVersion,
  isProjectTrusted,
  passwdHome,
  probeGlobalCliCapability,
  projectPathControlCharReason,
  readRegistry,
  reaDir,
  resolveGlobalCli,
  writeRegistry,
  type ProcReader,
  type SafetyFail,
} from '../global-cli.js';
import { REA_PACKAGE_NAME } from './self-pin.js';
import { err, getPkgVersion, log, warn } from '../utils.js';

/** Result of the `npm view <spec> version` pre-check. */
export interface NpmViewResult {
  ok: boolean;
  version?: string;
  stderr?: string;
}

/** Result of the `npm install --prefix <prefix> <spec>` run. */
export interface NpmInstallResult {
  ok: boolean;
  stderr?: string;
}

/** Result of the post-install `hook policy-get` capability probe. */
export interface CapabilityProbeResult {
  ok: boolean;
  stderr?: string;
}

/** Injectable shell-outs so tests never hit the network. */
export interface InstallGlobalDeps {
  npmView(spec: string): NpmViewResult;
  npmInstall(prefix: string, spec: string): NpmInstallResult;
  /**
   * Prove the installed CLI implements `rea hook policy-get` (the subcommand
   * the global-tier shim calls for the `allow_global_cli` veto). Spawns
   * `node <cliPath> hook policy-get --help`; a non-zero exit means the version
   * predates the floor and the global tier would silently fall back to no-CLI.
   */
  probeCapability(cliPath: string): CapabilityProbeResult;
}

export interface InstallGlobalOptions {
  /** Semver to install; defaults to the currently-running rea version. */
  version?: string;
  /** `--trust` value: `true`/`'.'` → trust cwd; a string → trust that path. */
  trust?: string | boolean;
  /** Re-install even when already present (perms are always re-asserted). */
  force?: boolean;
  /** Injected home dir (tests). Defaults to the passwd home. NOT a CLI flag. */
  home?: string;
  /** Injected cwd (tests). Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injected ancestry reader (tests). NOT a CLI flag. */
  procReader?: ProcReader;
}

/**
 * The version floor at which `rea hook policy-get` exists. The global-tier shim
 * calls it for the `allow_global_cli` veto, so installing anything below this
 * would leave a trusted checkout silently falling back to no-CLI while install
 * reported success. The capability probe is the robust backstop; this floor is
 * the cheaper fast-fail for an explicit `--version`.
 */
export const HOOK_POLICY_GET_FLOOR = '0.26.0';

// ---------------------------------------------------------------------------
// Real shell-outs (default deps)
// ---------------------------------------------------------------------------

const realDeps: InstallGlobalDeps = {
  npmView(spec: string): NpmViewResult {
    const r = spawnSync('npm', ['view', spec, 'version'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim().length > 0) {
      return { ok: true, version: r.stdout.trim() };
    }
    return { ok: false, stderr: (r.stderr ?? '').toString().trim() };
  },
  npmInstall(prefix: string, spec: string): NpmInstallResult {
    const r = spawnSync('npm', ['install', '--prefix', prefix, spec], {
      encoding: 'utf8',
      timeout: 300_000,
    });
    if (r.status === 0) return { ok: true };
    return { ok: false, stderr: (r.stderr ?? '').toString().trim() };
  },
  // Share ONE capability-probe implementation with `rea doctor` (0.51.x): the
  // spawn logic lives in global-cli.ts::probeGlobalCliCapability so the install
  // backstop and the doctor global-tier floor can never drift.
  probeCapability(cliPath: string): CapabilityProbeResult {
    return probeGlobalCliCapability(cliPath);
  },
};

// ---------------------------------------------------------------------------
// isInsideReviewedCheckout — mirror of openrouter-key-source (codex round-19 P1)
// ---------------------------------------------------------------------------

/**
 * Realpath the NEAREST EXISTING ancestor of `p`, then re-append the
 * not-yet-created suffix — so a first-time install (dir absent) still resolves
 * symlinks like macOS `/var`→`/private/var` consistently on both sides.
 */
function realResolve(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length > 0
        ? path.join(fs.realpathSync(cur), ...tail.reverse())
        : fs.realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Is `dir` inside the SAME git checkout as `cwd`? Used to REFUSE installing the
 * per-user CLI into the repo being worked on (a committable artifact) when
 * home/`.rea` points inside it. Dotfiles-as-git is NOT flagged — it compares
 * against `cwd`'s toplevel specifically, not any git repo. Never throws; a
 * non-git `cwd` returns false.
 */
export function isInsideReviewedCheckout(dir: string, cwd: string): boolean {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return false;
  const top = r.stdout.trim();
  if (top.length === 0) return false;
  const topReal = realResolve(top);
  const dirReal = realResolve(dir);
  return dirReal === topReal || dirReal.startsWith(topReal + path.sep);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function resolveHome(injected?: string): string | undefined {
  if (injected !== undefined) return injected;
  try {
    return passwdHome();
  } catch {
    return undefined;
  }
}

function printRefusal(fail: SafetyFail): void {
  err(fail.reason);
  err(`  fix: ${fail.remediation}`);
}

/** Best-effort chmod 0700 (some filesystems reject chmod). */
function chmod700(target: string): void {
  try {
    fs.chmodSync(target, 0o700);
  } catch {
    /* best-effort */
  }
}

/**
 * Post-install capability probe (P2): the installed CLI MUST implement
 * `rea hook policy-get` (the global-tier shim calls it for the veto). A
 * non-zero probe → the version is too old and the tier would silently fall back
 * to no-CLI. Returns the refusal exit code (`1`) after emitting a clear message,
 * or `null` when the probe passes. `cliPath` is the resolved entrypoint.
 */
function assertCapableCli(cliPath: string, deps: InstallGlobalDeps): number | null {
  const probe = deps.probeCapability(cliPath);
  if (!probe.ok) {
    err(
      `the installed global rea CLI at ${cliPath} does not implement \`rea hook policy-get\` ` +
        `(needs ${HOOK_POLICY_GET_FLOOR}+). The global tier would silently fall back to no-CLI. ` +
        `Reinstall with a newer --version (\`rea install --global --version <${HOOK_POLICY_GET_FLOOR}-or-newer> --force\`).`,
    );
    if (probe.stderr !== undefined && probe.stderr.length > 0) {
      err(`  probe: ${probe.stderr}`);
    }
    return 1;
  }
  return null;
}

/**
 * Sandbox a resolved global CLI candidate (A1–A4, `checkGlobalCandidateSafety`)
 * BEFORE anything executes it. `resolveGlobalCli` is only an EXISTENCE probe, so
 * on the idempotent path a tampered / symlinked / hostile pre-existing
 * `~/.rea/cli` would otherwise be spawned by the capability probe before any
 * safety validation. A failure REFUSES (exit 1) with the safety reason +
 * remediation — the candidate is NEVER executed. Returns `null` only for a
 * sandbox-validated candidate.
 */
function assertCandidateSandboxed(candidate: string, home: string): number | null {
  const gRoot = globalRoot(home);
  const safety = checkGlobalCandidateSafety(candidate, gRoot, home);
  if (!safety.ok) {
    err(
      `the global rea CLI at ${candidate} failed the sandbox check (${safety.code}): ${safety.reason}. ` +
        `Refusing to run it. Inspect ${gRoot}; remove or repair the tampered tree, then re-run ` +
        `\`rea install --global --force\`.`,
    );
    return 1;
  }
  return null;
}

/** Normalize the `--trust` value into a path (or undefined = no trust). */
function trustTarget(trust: string | boolean | undefined, cwd: string): string | undefined {
  if (trust === undefined || trust === false) return undefined;
  if (trust === true || trust === '.') return cwd;
  return path.resolve(cwd, trust);
}

/**
 * Add `projReal` to the registry when not already a member (idempotent).
 * Returns a process exit code: `0` = trusted / already-trusted / skipped
 * (non-fatal), `2` = the resolved path carries a control character (CR/LF/…)
 * that writeRegistry would silently drop — a hard refusal BEFORE any success
 * message, mirroring `rea trust`.
 */
function addTrust(projPath: string, home: string, cwd: string): number {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(cwd, projPath));
  } catch {
    warn(`--trust path does not exist; skipping trust: ${projPath}`);
    return 0;
  }
  // Shared control-char rejection — refuse (exit 2) BEFORE reporting success so
  // `install --global --trust <path-with-\r>` never prints a lie.
  const ctrl = projectPathControlCharReason(real);
  if (ctrl !== null) {
    err(`invalid path: ${ctrl}: ${JSON.stringify(real)}`);
    return 2;
  }
  const safety = checkReaDirSafety(home);
  if (!safety.ok) {
    // Should not happen (we validated earlier), but never write through an
    // unsafe root.
    printRefusal(safety);
    return 0;
  }
  if (isProjectTrusted(real, home)) {
    log(`Already trusted: ${real}`);
    return 0;
  }
  const members = readRegistry(home);
  members.push(real);
  writeRegistry(members, home);
  log(`Trusted: ${real}`);
  return 0;
}

/**
 * `rea install --global`. Returns the process exit code.
 *   0 — installed (or already installed; perms re-asserted)
 *   1 — unsafe root / inside-checkout / version-not-in-registry / install failed
 */
export function runInstallGlobal(
  options: InstallGlobalOptions = {},
  deps: InstallGlobalDeps = realDeps,
): number {
  const home = resolveHome(options.home);
  if (home === undefined) {
    err('cannot determine your home directory from the password database — refusing');
    return 1;
  }
  // Refuse under a governed agent session BEFORE any path resolution / FS work
  // or npm shell-out. `install --global` is a human action (dual-consent).
  const governed = assertNotGovernedSession(
    'install --global',
    home,
    options.procReader !== undefined ? { procReader: options.procReader } : {},
  );
  if (governed !== null) return governed;

  const cwd = options.cwd ?? process.cwd();
  const version = options.version ?? getPkgVersion();
  const spec = `${REA_PACKAGE_NAME}@${version}`;
  const dir = reaDir(home);
  const gRoot = globalRoot(home);

  // Cheaper fast-fail (P2): an explicit `--version` below the global-tier floor
  // (`rea hook policy-get`, ~0.26.0+) is refused up front. A range / dist-tag
  // (`latest`, `^0.30`) is not a plain version — skip here and let the
  // post-install capability probe be the authoritative backstop.
  if (options.version !== undefined) {
    const v = semver.valid(options.version);
    if (v !== null && semver.lt(v, HOOK_POLICY_GET_FLOOR)) {
      err(
        `refusing to install ${spec}: the global tier requires \`rea hook policy-get\` ` +
          `(introduced in ${HOOK_POLICY_GET_FLOOR}); v${options.version} is too old and a ` +
          `trusted checkout would silently fall back to no-CLI.`,
      );
      return 1;
    }
  }

  // 1. Refuse BEFORE install: unsafe `<home>/.rea`.
  const safety = checkReaDirSafety(home);
  if (!safety.ok) {
    printRefusal(safety);
    return 1;
  }

  // 2. Refuse a config root INSIDE the current git checkout (committable CLI).
  if (isInsideReviewedCheckout(dir, cwd)) {
    err(
      `refusing to install the global rea CLI at ${dir} — it is INSIDE the current git checkout ` +
        `(the CLI would be a committable artifact). Run this from OUTSIDE the repo, or use the ` +
        `in-project install (\`pnpm add -D ${REA_PACKAGE_NAME}\`).`,
    );
    return 1;
  }

  // 3. Idempotency: already installed + no --force → re-assert perms + trust.
  //    EXCEPTION: an explicit `--version` that DIFFERS from the installed
  //    version must NOT no-op (pre-fix it silently left the old CLI in place
  //    and reported success). Only skip the reinstall when no `--version` was
  //    passed OR the requested version matches what is already on disk. When
  //    the installed version can't be read, we cannot prove a mismatch, so we
  //    preserve the idempotent no-op rather than churn.
  const existing = resolveGlobalCli(home);
  if (existing !== null && options.force !== true) {
    const installedVersion = installedGlobalCliVersion(home);
    const versionMismatch =
      options.version !== undefined &&
      installedVersion !== null &&
      installedVersion !== options.version;
    if (!versionMismatch) {
      // Sandbox the PRE-EXISTING candidate (A1–A4) BEFORE the capability probe
      // executes it. This idempotent path is the exact remediation flow an
      // operator runs against a possibly-tampered ~/.rea/cli, and
      // resolveGlobalCli only proved existence — a symlinked / foreign / hostile
      // tree must be refused, never spawned. checkReaDirSafety already ran at
      // step 1; this is the candidate-tree half.
      const sandboxed = assertCandidateSandboxed(existing, home);
      if (sandboxed !== null) return sandboxed;
      // Probe the EXISTING CLI before reporting success — a pre-existing too-old
      // install must fail loudly, not be silently blessed (and trusted).
      const capable = assertCapableCli(existing, deps);
      if (capable !== null) return capable;
      const vTag = installedVersion !== null ? ` (v${installedVersion})` : '';
      log(`rea CLI already installed${vTag} at ${existing} (use --force to reinstall)`);
      chmod700(dir);
      chmod700(gRoot);
      const trustPath = trustTarget(options.trust, cwd);
      if (trustPath !== undefined) {
        const t = addTrust(trustPath, home, cwd);
        if (t !== 0) return t;
      }
      return 0;
    }
    log(
      `rea CLI v${installedVersion ?? '?'} installed but v${options.version} requested — reinstalling`,
    );
  }

  // 4. Registry pre-check (CLAUDE.md rule): the version MUST exist on npm.
  const view = deps.npmView(spec);
  if (!view.ok) {
    err(`${spec} was not found in the npm registry — refusing to install.`);
    if (view.stderr !== undefined && view.stderr.length > 0) {
      err(`  npm view: ${view.stderr}`);
    }
    return 1;
  }

  // 5. Create the config root (0700) + prefix, then real install.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmod700(dir);
  fs.mkdirSync(gRoot, { recursive: true, mode: 0o700 });
  chmod700(gRoot);

  const install = deps.npmInstall(gRoot, spec);
  if (!install.ok) {
    err(`\`npm install --prefix ${gRoot} ${spec}\` failed — the global CLI was not installed.`);
    if (install.stderr !== undefined && install.stderr.length > 0) {
      err(`  npm install: ${install.stderr}`);
    }
    return 1;
  }

  // 6. Re-assert perms (npm may have relaxed the prefix dir mode).
  chmod700(dir);
  chmod700(gRoot);

  // 6b. Capability probe (P2): prove the freshly-installed CLI implements
  //     `rea hook policy-get` BEFORE reporting success or trusting anything. A
  //     version that passed `npm view` (exists) but predates the floor would
  //     otherwise leave a silently-broken global CLI. Do NOT trust on failure.
  const freshCli = resolveGlobalCli(home);
  if (freshCli === null) {
    err(`\`npm install\` reported success but no global CLI entrypoint resolved under ${gRoot}.`);
    return 1;
  }
  // Belt-and-suspenders: sandbox the freshly-placed candidate too before the
  // capability probe executes it (defends against a symlink race / hostile
  // prefix that slipped a bad tree in during the install window).
  const freshSandboxed = assertCandidateSandboxed(freshCli, home);
  if (freshSandboxed !== null) return freshSandboxed;
  const capable = assertCapableCli(freshCli, deps);
  if (capable !== null) return capable;

  // 7. Optional trust of the current (or named) project.
  const trustPath = trustTarget(options.trust, cwd);
  if (trustPath !== undefined) {
    const t = addTrust(trustPath, home, cwd);
    if (t !== 0) return t;
  }

  log(`Installed ${spec} to ${gRoot}`);
  log(`Global rea CLI entrypoint: ${freshCli}`);
  return 0;
}

/**
 * Register `rea install [--global] [--version <semver>] [--trust [path]]
 * [--force]`. In this phase `--global` is the only mode; without it we refuse
 * with a hint rather than silently doing a per-user install.
 */
export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description(
      'Install the rea CLI per-user, out-of-project (<home>/.rea/cli), so the opt-in global shim tier can govern a blessed checkout without touching its package.json.',
    )
    .option('--global', 'install to <home>/.rea/cli (currently the only supported mode)')
    .option('--version <semver>', 'version to install (default: the running rea version)')
    .option('--trust [path]', 'also trust a project (default: cwd) after installing')
    .option('--force', 'reinstall even if a global CLI is already present')
    .action(
      (opts: { global?: boolean; version?: string; trust?: string | boolean; force?: boolean }) => {
        if (opts.global !== true) {
          err('`rea install` requires `--global` (per-user install). No other mode is supported.');
          process.exit(2);
        }
        const runOpts: InstallGlobalOptions = {
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          ...(opts.trust !== undefined ? { trust: opts.trust } : {}),
          ...(opts.force === true ? { force: true } : {}),
        };
        const code = runInstallGlobal(runOpts);
        process.exit(code);
      },
    );
}
