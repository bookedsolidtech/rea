/**
 * `rea migrate --to-global` (0.53.0) — assisted removal of the local
 * `@bookedsolid/rea` dep so the checkout adopts the global-first model.
 *
 * Global-first (Jake's foundational 0.53.0 call) makes the global rea CLI
 * tier (`<home>/.rea/cli`, gated by `<home>/.rea/trusted-projects`) the
 * default resolution path. A local `@bookedsolid/rea` dep is no longer
 * needed and is flagged as non-recommended by `rea doctor`. This command
 * strips it (byte-minimal edit, preserving key order) and prints the
 * lockfile follow-up the operator must run to prune node_modules.
 *
 * The manifest edit lives in `migrateToGlobal` (self-pin.ts) so it reuses
 * the exact read/shape/symlink/dogfood posture as the self-pin write path.
 */

import fs from 'node:fs';
import path from 'node:path';

import { migrateToGlobal, type MigrateToGlobalResult } from './install/self-pin.js';
import { GLOBAL_CLI_INSTALL_HINT, isGlobalTierUsableIgnoringLocal } from './doctor.js';
import { err, log, warn } from './utils.js';

export interface MigrateCliOptions {
  /** The migration target. Only `--to-global` is supported in 0.53.0. */
  toGlobal?: boolean | undefined;
  dryRun?: boolean | undefined;
  /**
   * Test seam — override the "usable global tier (ignoring local)" predicate so
   * the safety refusal can be exercised without a real `~/.rea`. Production
   * NEVER sets this; the default consults `isGlobalTierUsableIgnoringLocal`.
   */
  globalTierProbe?: ((baseDir: string) => boolean) | undefined;
}

export interface StripLocalDepOptions {
  cwd: string;
  dryRun?: boolean | undefined;
  globalTierProbe?: ((baseDir: string) => boolean) | undefined;
}

/**
 * Discriminated outcome of the GUARDED strip. `stripLocalDepGuarded` is the ONE
 * place the brick-safety gate lives, so `rea migrate --to-global` (CLI) and the
 * `rea upgrade --interactive` strip-offer share it and can never diverge.
 */
export type GuardedStripOutcome =
  /** A strip was needed AND a usable global tier exists — dep removed (or,
   *  under dry-run, previewed). `result.action === 'removed'`. */
  | { kind: 'stripped'; result: MigrateToGlobalResult }
  /** A strip was needed but NO usable global tier exists — REFUSED. package.json
   *  untouched. The caller decides how to surface it (hard-exit vs warn). */
  | { kind: 'refused-no-global' }
  /** Nothing to strip / safe no-op (already-global, dogfood). */
  | { kind: 'nothing'; result: MigrateToGlobalResult }
  /** Refuse-to-touch state (no package.json, malformed, symlink). */
  | { kind: 'error'; result: MigrateToGlobalResult };

/**
 * The shared brick-safety gate. PREVIEW (dry-run, no write) first to learn
 * whether a strip would actually happen; only THEN gate on a usable GLOBAL tier
 * (ignoring the local install that is about to be removed — `resolveGlobalCliTier`
 * is in-project-first and would otherwise answer FALSE whenever the local dep is
 * present, i.e. exactly the case a strip is FOR). Never calls `process.exit` or
 * prints — pure decision + (on the safe path) the real mutation.
 */
export async function stripLocalDepGuarded(
  opts: StripLocalDepOptions,
): Promise<GuardedStripOutcome> {
  const dryRun = opts.dryRun === true;
  const preview = await migrateToGlobal({ cwd: opts.cwd, dryRun: true });
  if (preview.action === 'removed') {
    const globalUsable = (opts.globalTierProbe ?? isGlobalTierUsableIgnoringLocal)(opts.cwd);
    if (!globalUsable) return { kind: 'refused-no-global' };
    const result = await migrateToGlobal({ cwd: opts.cwd, dryRun });
    return { kind: 'stripped', result };
  }
  if (
    preview.action === 'skipped-symlink-package-json' ||
    preview.action === 'skipped-no-package-json' ||
    preview.action === 'skipped-malformed-package-json'
  ) {
    // Use the dry-run preview (which returns the skip-shape) rather than a live
    // call — a live symlink strip THROWS; the preview surfaces the same message.
    return { kind: 'error', result: preview };
  }
  // skipped-already-global / skipped-dogfood — safe no-ops, no brick risk.
  return { kind: 'nothing', result: preview };
}

/** The operator-facing refusal reason, shared by CLI + upgrade surfaces. */
export const STRIP_REFUSAL_REASON =
  `stripping the local @bookedsolid/rea dep would leave NO resolvable rea CLI ` +
  `(no usable global tier). To adopt global-first safely, ${GLOBAL_CLI_INSTALL_HINT}, ` +
  `then re-run \`rea migrate --to-global\`. package.json was NOT modified.`;

/**
 * Detect the package manager for the follow-up hint from the lockfile
 * present in `dir`. Falls back to `pnpm` (this repo's manager) when none is
 * found — the hint is advisory, not load-bearing.
 */
function detectPackageManager(dir: string): 'pnpm' | 'npm' | 'yarn' {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  return 'pnpm';
}

export async function runMigrate(options: MigrateCliOptions): Promise<void> {
  if (options.toGlobal !== true) {
    err('rea migrate: specify a target — the only supported migration is `--to-global`.');
    process.exit(2);
  }

  const baseDir = process.cwd();
  const dryRun = options.dryRun === true;

  // SAFETY GATE (0.53.0): stripping the local dep must NEVER leave a repo where
  // neither a local pin NOR a usable global tier can run the hooks. The gate is
  // the shared `stripLocalDepGuarded` (which probes the GLOBAL tier IGNORING the
  // local install about to be removed — the convergence fix).
  const outcome = await stripLocalDepGuarded({
    cwd: baseDir,
    dryRun,
    globalTierProbe: options.globalTierProbe,
  });
  if (outcome.kind === 'refused-no-global') {
    err(`rea migrate --to-global refuses: ${STRIP_REFUSAL_REASON}`);
    // Dry-run previews the refusal without a non-zero exit (a preview never
    // needs to fail); a live run refuses HARD.
    if (dryRun) return;
    process.exit(1);
    return;
  }

  const result = outcome.result;

  switch (result.action) {
    case 'removed': {
      const rel =
        result.packageJsonPath !== null ? path.relative(baseDir, result.packageJsonPath) : 'package.json';
      log(
        `${dryRun ? '[dry-run] would strip' : 'stripped'} @bookedsolid/rea from ` +
          `${result.removedFrom.join(' + ')} in ${rel} — this checkout is now global-first.`,
      );
      if (!dryRun) {
        const pm = detectPackageManager(baseDir);
        const install =
          pm === 'pnpm' ? 'pnpm install' : pm === 'yarn' ? 'yarn install' : 'npm install';
        console.log('');
        console.log('Next step — prune node_modules + lockfile so the local copy is gone:');
        console.log(`  ${install}`);
        console.log('');
        console.log(
          'Then verify: `rea doctor` should report the global tier as the active resolver',
        );
        console.log('(and no longer flag a local install). Ensure the checkout is trusted:');
        console.log('  rea trust        # run in a plain shell OUTSIDE the agent session');
      }
      break;
    }
    case 'skipped-already-global':
      log('already global-first — no local @bookedsolid/rea dep to remove. Nothing to do.');
      break;
    case 'skipped-dogfood':
      warn(result.message);
      break;
    case 'skipped-no-package-json':
    case 'skipped-malformed-package-json':
    case 'skipped-symlink-package-json':
      err(result.message);
      process.exit(1);
      break;
  }
}
