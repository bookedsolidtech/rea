/**
 * UPGRADE-JOURNEY suite (Layer 1, in-process — runs in `pnpm test`).
 *
 * For each FIXTURE representing a real prior-install shape, this suite:
 *   1. Copies the fixture into a fresh temp dir (the fixture is never mutated).
 *   2. Runs the ACTUAL scaffolder (`rea init` / `rea upgrade`) against it.
 *   3. Asserts END-STATE INVARIANTS — the journey's OUTCOME, not the diff.
 *
 * WHY THIS EXISTS: a global-tier self-pin bug reached a consumer despite 50+
 * diff reviews. Diff review and isolated unit tests cannot answer "what does
 * `rea upgrade` DO to a user already on an old install shape" — only exercising
 * the end-to-end journey against a real prior-install fixture does. See
 * ./README.md for the harness design and the Layer-2 (Docker clean-env) sketch.
 *
 * Invariants are kept on present/absent/version/doctor-status — NOT brittle
 * full-file snapshots.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../../../src/cli/init.js';
import { runUpgrade } from '../../../src/cli/upgrade.js';
import {
  brickDiagnostic,
  brickDiagnosticFires,
  CURRENT_PIN,
  CURRENT_VERSION,
  doctorFailures,
  hookInstalledAndRegistered,
  inDir,
  manifestVersion,
  materializePriorInstall,
  presentHookFiles,
  reaDepRange,
  readPackageJsonRaw,
  spineSkillFiles,
} from './harness.js';

const cleanup: string[] = [];
function track(dir: string): string {
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

// A representative critical hook that must be present AND registered after any
// successful init/upgrade — the bash-gate that refuses destructive commands.
const CRITICAL_HOOK = 'dangerous-bash-interceptor.sh';

// ===========================================================================
// no-rea-at-all — the normal path still works
// ===========================================================================
describe('journey: no-rea-at-all → rea init', () => {
  it('GLOBAL-FIRST default: installs+registers hooks, lays the spine, doctor-clean, and does NOT pin', async () => {
    const dir = track(await materializePriorInstall('no-rea-at-all', { scaffold: false }));

    await inDir(dir, () => runInit({ yes: true, profile: 'minimal', codex: false }));

    // 0.53.0: no local pin by default — the global rea CLI tier governs.
    expect(await reaDepRange(dir)).toBeUndefined();
    // Hooks present AND registered (two-way invariant).
    expect(hookInstalledAndRegistered(dir, CRITICAL_HOOK)).toBe(true);
    expect(presentHookFiles(dir).length).toBeGreaterThan(0);
    // Process spine installed.
    expect(spineSkillFiles(dir).length).toBeGreaterThan(0);
    // Manifest stamped at the current version.
    expect(await manifestVersion(dir)).toBe(CURRENT_VERSION);
    // Doctor-clean: a missing local pin is healthy under global-first ONLY when
    // a usable global tier can run the hooks — assert that world (probe → true),
    // which is the machine an operator adopting global-first is expected to have.
    expect(
      doctorFailures(dir, undefined, () => true).map((c) => `${c.label}: ${c.detail ?? ''}`),
    ).toEqual([]);
  });

  it('--pin opt-in: adds the dep back for a hermetic local install', async () => {
    const dir = track(await materializePriorInstall('no-rea-at-all', { scaffold: false }));

    await inDir(dir, () => runInit({ yes: true, profile: 'minimal', codex: false, pin: true }));

    expect(await reaDepRange(dir)).toBe(CURRENT_PIN);
    expect(hookInstalledAndRegistered(dir, CRITICAL_HOOK)).toBe(true);
  });
});

// ===========================================================================
// pinned-0.49 — managed-caret bump, no brick
// ===========================================================================
describe('journey: pinned-0.49 → rea upgrade', () => {
  it('managed-caret-bumps the dep to the current minor without bricking', async () => {
    const dir = track(
      await materializePriorInstall('pinned-0.49', { manifestVersion: '0.49.0' }),
    );

    // Precondition: the prior shape really is pinned to ^0.49.0.
    expect(await reaDepRange(dir)).toBe('^0.49.0');

    await inDir(dir, () => runUpgrade({ yes: true }));

    // Bumped to the current managed caret (hooks are never newer than the CLI
    // the pin admits → no brick).
    expect(await reaDepRange(dir)).toBe(CURRENT_PIN);
    expect(hookInstalledAndRegistered(dir, CRITICAL_HOOK)).toBe(true);
    // The brick diagnostic must NOT fire — the pin now admits the CLI.
    expect(brickDiagnosticFires(dir)).toBe(false);
  });
});

// ===========================================================================
// already-current — upgrade is idempotent / byte-stable
// ===========================================================================
describe('journey: already-current → rea upgrade (idempotent)', () => {
  it('a second upgrade leaves package.json + manifest version byte/semantically stable', async () => {
    // Start from a fully-current install (init self-pins current; keep it).
    const dir = track(
      await materializePriorInstall('pinned-0.49', { overlayPackageJson: false }),
    );

    // First upgrade brings everything to current.
    await inDir(dir, () => runUpgrade({ yes: true }));
    const pkgAfterFirst = await readPackageJsonRaw(dir);
    const manifestAfterFirst = await manifestVersion(dir);
    expect(await reaDepRange(dir)).toBe(CURRENT_PIN);

    // Second upgrade must be a no-op on the manifest version + package.json.
    await inDir(dir, () => runUpgrade({ yes: true }));
    expect(await readPackageJsonRaw(dir)).toBe(pkgAfterFirst);
    expect(await manifestVersion(dir)).toBe(manifestAfterFirst);
    expect(await reaDepRange(dir)).toBe(CURRENT_PIN);
    expect(brickDiagnosticFires(dir)).toBe(false);
  });
});

// ===========================================================================
// committed-hooks vs untracked-hooks — the brick diagnostic false-positive
// ===========================================================================
describe('journey: brick diagnostic — committed vs untracked hooks', () => {
  /** Build a dep-free install whose `.claude/hooks/` exist on disk, then either
   *  git-track them (committed shape) or gitignore them (untracked shape). The
   *  git-tracking is the ONLY thing this pair varies — it is what a future
   *  git-aware brick detector keys on (a fresh clone carries tracked files, not
   *  ignored ones). We stage (`git add`) rather than commit so the temp repo's
   *  own commit-msg/DCO hooks never run (no `--no-verify` needed); `git ls-files`
   *  and `git check-ignore` both see staged paths. */
  async function depFreeInstall(mode: 'committed' | 'untracked'): Promise<string> {
    const dir = track(await materializePriorInstall('global-tier-dep-free-trusted'));
    const run = promisify(execFile);
    if (mode === 'untracked') {
      await fsp.writeFile(path.join(dir, '.gitignore'), '.claude/\n.rea/\n', 'utf8');
      await run('git', ['-C', dir, 'add', '.gitignore']);
    } else {
      // Track the installed hooks so a fresh clone would carry them.
      await run('git', ['-C', dir, 'add', '.claude', '.rea']);
    }
    return dir;
  }

  it('SAFETY LAYER: dep-free + NO usable global tier → doctor FAILS (the true brick)', async () => {
    const dir = await depFreeInstall('committed');
    // Sanity: hooks are on disk and the dep is absent.
    expect(fs.existsSync(path.join(dir, '.claude', 'hooks', CRITICAL_HOOK))).toBe(true);
    expect(await reaDepRange(dir)).toBeUndefined();

    // 0.53.0 safety layer: no local pin AND no usable global tier = a real
    // brick (hooks resolve no CLI). Doctor must FAIL with actionable guidance.
    const diag = brickDiagnostic(dir, undefined, () => false);
    expect(diag?.status).toBe('fail');
    expect(diag?.detail ?? '').toMatch(/no usable global rea CLI/);
    expect(diag?.detail ?? '').toMatch(/--pin|install the global CLI/);
  });

  it('SAFETY LAYER: dep-free + USABLE global tier → doctor passes (healthy global-first)', async () => {
    const dir = await depFreeInstall('committed');
    expect(await reaDepRange(dir)).toBeUndefined();

    // With a usable global tier the same dep-free checkout is healthy.
    const diag = brickDiagnostic(dir, undefined, () => true);
    expect(diag?.status).toBe('pass');
    expect(brickDiagnosticFires(dir, undefined, () => true)).toBe(false);
  });
});

// ===========================================================================
// global-tier-dep-free-trusted — the exact bug (TODO-gated on the devex seam)
// ===========================================================================
describe('journey: global-tier-dep-free-trusted → rea upgrade', () => {
  // This is the exact bug that reached a consumer. A checkout that resolves the
  // rea CLI through the TRUSTED global tier declares NO `@bookedsolid/rea` dep on
  // purpose. Pre-0.53.0 `rea upgrade` → `selfPinRea` returned `action: 'wrote'`
  // for a dep-free package.json and INJECTED the dep back (the brick-avoidance
  // self-pin had no notion of "trusted global tier").
  //
  // The fix (0.53.0) adds a trusted-global-tier gate keyed on
  // `<home>/.rea/trusted-projects` (via `resolveGlobalCliTier`), surfaced as a
  // new `skipped-global-tier-trusted` self-pin action. The intended TEST seam is
  // the injectable `trustedGlobalTierProbe` on `UpgradeOptions` — it lets the
  // journey assert the trusted-checkout outcome WITHOUT constructing a real
  // global-CLI install under a temp home. (`harness.markProjectTrusted` remains
  // the temp-home trust-registry seam for driving the doctor-side `globalHome`
  // path against `resolveGlobalCliTier` directly.)
  it('refreshes hooks/spine to current but leaves the dep ABSENT (trusted global tier)', async () => {
    const dir = track(await materializePriorInstall('global-tier-dep-free-trusted'));

    // Precondition: the dep is genuinely absent in the prior shape.
    const pkgBefore = await readPackageJsonRaw(dir);
    expect(await reaDepRange(dir)).toBeUndefined();

    // Drive the trusted-global-tier predicate through the shipped injectable
    // probe — no real ~/.rea, no global-CLI install required.
    await inDir(dir, () =>
      runUpgrade({ yes: true, trustedGlobalTierProbe: () => true }),
    );

    // INVARIANT 1 — the exact bug: the dep is STILL absent and package.json is
    // byte-unchanged w.r.t. the rea dep.
    expect(await reaDepRange(dir)).toBeUndefined();
    expect(await readPackageJsonRaw(dir)).toBe(pkgBefore);
    // INVARIANT 2 — hooks + spine still refreshed to current despite the skip.
    expect(hookInstalledAndRegistered(dir, CRITICAL_HOOK)).toBe(true);
    expect(await manifestVersion(dir)).toBe(CURRENT_VERSION);
  });

  it('GLOBAL-FIRST: UNtrusted dep-free checkout ALSO stays dep-free (no pin by default)', async () => {
    // 0.53.0 foundational change: trust is now messaging-only. A dep-free
    // checkout stays dep-free whether trusted or not — the default never
    // pins. (Pre-0.53.0 an untrusted dep-free upgrade re-injected the dep.)
    const dir = track(await materializePriorInstall('global-tier-dep-free-trusted'));
    const pkgBefore = await readPackageJsonRaw(dir);
    expect(await reaDepRange(dir)).toBeUndefined();

    await inDir(dir, () =>
      runUpgrade({ yes: true, trustedGlobalTierProbe: () => false }),
    );

    expect(await reaDepRange(dir)).toBeUndefined();
    expect(await readPackageJsonRaw(dir)).toBe(pkgBefore);
  });

  it('--pin control: a dep-free checkout DOES get pinned when the operator opts in', async () => {
    // Proves the hermetic-local path still works — the pin is now an explicit
    // opt-in, not the default.
    const dir = track(await materializePriorInstall('global-tier-dep-free-trusted'));
    expect(await reaDepRange(dir)).toBeUndefined();

    await inDir(dir, () => runUpgrade({ yes: true, pin: true }));

    expect(await reaDepRange(dir)).toBe(CURRENT_PIN);
  });
});
