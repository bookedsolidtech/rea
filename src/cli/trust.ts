/**
 * `rea trust [<path>]` / `rea untrust [<path>]` / `rea trust --list`
 *
 * Operator-facing management of the per-user global-CLI allow-list
 * `<home>/.rea/trusted-projects` (design §9). Blessing a project into this
 * registry is the A5 CONSENT gate that lets the opt-in global rea CLI tier
 * (`hooks/_lib/shim-runtime.sh`) govern that checkout without adding
 * `@bookedsolid/rea` to a shared `package.json`.
 *
 * The registry can only ever ENABLE enforcement, never DISABLE a gate — so
 * mutating it is a deliberate act of vouching for a checkout's policy, not a
 * privilege expansion. (The governed-session mutation guard is Phase 4.)
 *
 * TEST ISOLATION: `home` + `cwd` are injectable parameters that default to the
 * passwd home + `process.cwd()`. Tests inject a temp dir and never touch the
 * real `~/.rea/`. NO CLI FLAG exposes `home` — an env/flag-redirectable trust
 * root would re-open the N3 surface the tier closes.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertNotGovernedSession,
  checkReaDirSafety,
  checkRegistrySafety,
  deleteRegistry,
  isProjectTrusted,
  passwdHome,
  projectPathControlCharReason,
  readRegistry,
  registryPath,
  writeRegistry,
  type ProcReader,
  type SafetyFail,
} from './global-cli.js';
import { err, log } from './utils.js';

export interface TrustOptions {
  /** Project path to trust; defaults to `cwd`. */
  path?: string;
  /** Injected home dir (tests). Defaults to the passwd home. NOT a CLI flag. */
  home?: string;
  /** Injected cwd (tests). Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injected ancestry reader (tests). NOT a CLI flag. */
  procReader?: ProcReader;
}

export interface UntrustOptions {
  path?: string;
  home?: string;
  cwd?: string;
  /** Injected ancestry reader (tests). NOT a CLI flag. */
  procReader?: ProcReader;
}

export interface TrustListOptions {
  home?: string;
}

/** Resolve the injected-or-passwd home; err + non-zero on a passwd failure. */
function resolveHome(injected?: string): string | undefined {
  if (injected !== undefined) return injected;
  try {
    return passwdHome();
  } catch {
    return undefined;
  }
}

/** Print a safety refusal (reason + exact fix) to stderr. */
function printRefusal(fail: SafetyFail): void {
  err(fail.reason);
  err(`  fix: ${fail.remediation}`);
}

/**
 * `rea trust [<path>]`. Returns the process exit code.
 *   0 — trusted (or already trusted; idempotent)
 *   1 — `<home>/.rea` is unsafe (symlink/foreign/world-writable), the
 *       `trusted-projects` file is an unsafe shape (symlink/foreign/bad-mode/
 *       hardlinked), or no passwd
 *   2 — path does not exist / is not a directory / contains illegal bytes
 */
export function runTrust(options: TrustOptions = {}): number {
  const home = resolveHome(options.home);
  if (home === undefined) {
    err('cannot determine your home directory from the password database — refusing');
    return 1;
  }
  // Refuse under a governed agent session BEFORE any path resolution / FS work.
  const governed = assertNotGovernedSession(
    'trust',
    home,
    options.procReader !== undefined ? { procReader: options.procReader } : {},
  );
  if (governed !== null) return governed;

  const cwd = options.cwd ?? process.cwd();
  const rawTarget = options.path ?? cwd;
  const abs = path.resolve(cwd, rawTarget);

  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    err(`path does not exist: ${abs}`);
    return 2;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    err(`path does not exist: ${abs}`);
    return 2;
  }
  if (!st.isDirectory()) {
    err(`not a directory: ${abs}`);
    return 2;
  }
  // Reject ANY control character (CR/LF/NUL/tab/…) BEFORE reporting success:
  // writeRegistry would silently drop such a line as malformed, so a
  // success message without persistence would be a lie. Shared validator so
  // `rea install --global --trust` refuses identically.
  const ctrl = projectPathControlCharReason(real);
  if (ctrl !== null) {
    err(`invalid path: ${ctrl}: ${JSON.stringify(real)}`);
    return 2;
  }

  const safety = checkReaDirSafety(home);
  if (!safety.ok) {
    printRefusal(safety);
    return 1;
  }
  // Refuse an unsafe `trusted-projects` file BEFORE any read-through: both the
  // isProjectTrusted probe below AND readRegistry() open the file, so a FIFO /
  // device / symlink / hardlinked / mode-wrong registry must be rejected here,
  // ahead of both reads (an ABSENT registry is safe — first-trust bootstrap).
  const regSafety = checkRegistrySafety(home);
  if (!regSafety.ok) {
    printRefusal(regSafety);
    return 1;
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
 * `rea untrust [<path>]`. Removes the exact-match line for both the resolved
 * absolute path AND its realpath (when resolvable), so a since-moved or
 * symlinked project can still be untrusted. Empties → delete the file.
 *   0 — removed, or nothing to remove (idempotent)
 *   1 — `<home>/.rea` is unsafe, the `trusted-projects` file is an unsafe shape
 *       (symlink/foreign/bad-mode/hardlinked), or no passwd
 */
export function runUntrust(options: UntrustOptions = {}): number {
  const home = resolveHome(options.home);
  if (home === undefined) {
    err('cannot determine your home directory from the password database — refusing');
    return 1;
  }
  // Refuse under a governed agent session BEFORE any path resolution / FS work.
  const governed = assertNotGovernedSession(
    'untrust',
    home,
    options.procReader !== undefined ? { procReader: options.procReader } : {},
  );
  if (governed !== null) return governed;

  const cwd = options.cwd ?? process.cwd();
  const rawTarget = options.path ?? cwd;
  const abs = path.resolve(cwd, rawTarget);

  // Remove both the raw absolute form AND the realpath (design §6): a member was
  // stored as realpath, but the operator may pass either form. Display the
  // realpath when resolvable (symmetry with `trust`), else the raw abs form
  // (the project may have moved/been deleted).
  const candidates = new Set<string>();
  candidates.add(abs);
  let display = abs;
  try {
    const real = fs.realpathSync(abs);
    candidates.add(real);
    display = real;
  } catch {
    /* not resolvable (project moved/deleted) — the abs form still matches */
  }

  const safety = checkReaDirSafety(home);
  if (!safety.ok) {
    printRefusal(safety);
    return 1;
  }
  // Refuse an unsafe `trusted-projects` file BEFORE readRegistry() reads
  // through it (a FIFO / device / symlink / hardlinked / mode-wrong registry
  // is a tamper primitive). An ABSENT registry is safe — nothing to remove.
  const regSafety = checkRegistrySafety(home);
  if (!regSafety.ok) {
    printRefusal(regSafety);
    return 1;
  }

  const members = readRegistry(home);
  const kept = members.filter((m) => !candidates.has(m));
  const removed = members.length - kept.length;

  if (removed === 0) {
    log(`Not trusted; nothing to remove: ${display}`);
    return 0;
  }
  if (kept.length === 0) {
    deleteRegistry(home);
    log(`Untrusted: ${display}`);
    log('trusted-projects is now empty; removed the registry file');
    return 0;
  }
  writeRegistry(kept, home);
  log(`Untrusted: ${display}`);
  return 0;
}

/**
 * `rea trust --list`. Prints the registry members one per line to stdout
 * (pipe-friendly). Perm-gated: a tampered `<home>/.rea` or registry file →
 * exit 1 with remediation.
 *   0 — printed (possibly "No trusted projects.")
 *   1 — tampered root, or no passwd
 */
export function runTrustList(options: TrustListOptions = {}): number {
  const home = resolveHome(options.home);
  if (home === undefined) {
    err('cannot determine your home directory from the password database — refusing');
    return 1;
  }

  const dirSafety = checkReaDirSafety(home);
  if (!dirSafety.ok) {
    printRefusal(dirSafety);
    return 1;
  }
  const regSafety = checkRegistrySafety(home);
  if (!regSafety.ok) {
    printRefusal(regSafety);
    return 1;
  }
  // Absent registry OR present-but-empty → same friendly line.
  if (regSafety.absent) {
    log('No trusted projects.');
    return 0;
  }
  const members = readRegistry(home);
  if (members.length === 0) {
    log('No trusted projects.');
    return 0;
  }
  for (const m of members) {
    process.stdout.write(`${m}\n`);
  }
  return 0;
}

/**
 * Register `rea trust [path]` (with `--list`) and `rea untrust [path]`.
 * The thin action wrappers translate the run functions' exit codes into
 * `process.exit`. `registryPath` is imported only to keep the module's public
 * surface discoverable for doctor (Phase 3b) — no behavior here.
 */
export function registerTrustCommands(program: Command): void {
  void registryPath; // referenced for tree-shake stability / doctor cohesion

  program
    .command('trust [path]')
    .description(
      'Bless a project into the per-user global-CLI allow-list (<home>/.rea/trusted-projects). Default path = cwd. `--list` prints the current registry.',
    )
    .option('--list', 'print the trusted-projects registry instead of adding a path')
    .action((pathArg: string | undefined, opts: { list?: boolean }) => {
      const code =
        opts.list === true
          ? runTrustList({})
          : runTrust(pathArg !== undefined ? { path: pathArg } : {});
      process.exit(code);
    });

  program
    .command('untrust [path]')
    .description(
      'Remove a project from the per-user global-CLI allow-list. Default path = cwd. Empties the registry file when the last entry is removed.',
    )
    .action((pathArg: string | undefined) => {
      const code = runUntrust(pathArg !== undefined ? { path: pathArg } : {});
      process.exit(code);
    });
}
