/**
 * UPGRADE-JOURNEY harness (Layer 1, in-process).
 *
 * Shared helpers for the fixture-based upgrade-journey suite. The point of the
 * suite is to exercise what `rea init` / `rea upgrade` DO to a checkout that is
 * ALREADY in a given prior-install shape — the systemic gap that let a
 * global-tier self-pin bug reach a consumer despite 50+ diff reviews. Diff
 * review and isolated unit tests can't answer "what does upgrade do to a user
 * on an old install shape"; only running the end-to-end journey against a real
 * prior-install fixture does.
 *
 * Design:
 *   - Each fixture under `fixtures/<name>/` carries the DEFINING artifact for a
 *     prior-install shape — a `package.json` whose rea-dep presence/pin IS the
 *     shape under test.
 *   - `materializePriorInstall` copies that fixture into a FRESH temp dir (the
 *     fixture is never mutated), lays down a complete, realistic rea install
 *     with `runInit`, then overlays the fixture's authoritative manifest and
 *     any shape-specific "downgrade" (older manifest version, dep removal) so
 *     the temp dir faithfully represents the prior shape a real user would have
 *     on disk.
 *   - The journey under test (`runInit` / `runUpgrade`) then runs against the
 *     temp dir, and the test asserts END-STATE INVARIANTS (present / absent /
 *     version / doctor status) — NOT brittle full-file snapshots.
 *
 * `runInit` / `runUpgrade` both read `process.cwd()` (carried from the original
 * wizard), so callers switch `process.cwd()` into the temp dir for the duration
 * of the scaffolder call and restore it afterwards — mirroring
 * `src/cli/init.test.ts` and `src/cli/upgrade.settings-migration.test.ts`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectChecks, type CheckResult, EXPECTED_HOOKS } from '../../../src/cli/doctor.js';
import { REA_PACKAGE_NAME } from '../../../src/cli/install/self-pin.js';
import { writeRegistry } from '../../../src/cli/global-cli.js';
import { getPkgVersion } from '../../../src/cli/utils.js';

const execFileAsync = promisify(execFile);

export const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));

/** The rea version the running CLI would install/pin — the "current" target. */
export const CURRENT_VERSION = getPkgVersion();
/** The managed-caret range `rea init` / `rea upgrade` self-pins to. */
export const CURRENT_PIN = `^${CURRENT_VERSION}`;

// ---------------------------------------------------------------------------
// Temp-dir + git lifecycle
// ---------------------------------------------------------------------------

/** Realpathed mkdtemp so the canonical path matches what the scaffolder + the
 *  trust registry (keyed on realpath) resolve internally (/private/var on macOS). */
export async function makeTempDir(prefix = 'rea-journey-'): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'journey@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'journey']);
}

/** Run `fn` with `process.cwd()` temporarily switched into `dir`, always
 *  restoring the previous cwd (the scaffolder reads cwd internally). */
export async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

// ---------------------------------------------------------------------------
// Fixture materialization
// ---------------------------------------------------------------------------

export interface MaterializeOptions {
  /** Run a full `rea init` first so the temp dir has a realistic install spine
   *  (hooks, settings, spine skills, policy, manifest). Default true. Set false
   *  for the `no-rea-at-all` shape whose journey IS the init. */
  scaffold?: boolean;
  /** Overlay the fixture's authoritative package.json AFTER init (so the rea-dep
   *  presence/pin reflects the prior shape, not init's self-pin). Default true. */
  overlayPackageJson?: boolean;
  /** Rewrite `.rea/install-manifest.json` `version` to this value to simulate an
   *  install laid down by an OLDER rea. No-op when scaffold is false. */
  manifestVersion?: string;
}

/**
 * Build a temp dir that faithfully represents fixture `name`'s prior-install
 * shape, then return its path. The fixture directory itself is never mutated.
 */
export async function materializePriorInstall(
  name: string,
  opts: MaterializeOptions = {},
): Promise<string> {
  const { scaffold = true, overlayPackageJson = true, manifestVersion } = opts;
  const dir = await makeTempDir(`rea-journey-${name}-`);
  await gitInit(dir);

  // Seed the fixture's package.json first so init sees a real manifest.
  await copyFixturePackageJson(name, dir);

  if (scaffold) {
    // Lazy import so a non-scaffold journey doesn't pay for init's module graph.
    const { runInit } = await import('../../../src/cli/init.js');
    await inDir(dir, () =>
      runInit({ yes: true, profile: 'minimal', codex: false }),
    );
    // init self-pins the rea dep + writes a current manifest. Re-overlay the
    // fixture manifest so the rea-dep presence/pin reflects the PRIOR shape.
    if (overlayPackageJson) await copyFixturePackageJson(name, dir);
    if (manifestVersion !== undefined) await setManifestVersion(dir, manifestVersion);
  }

  return dir;
}

/** Copy `fixtures/<name>/package.json` into `dir` (fixture never mutated). */
export async function copyFixturePackageJson(name: string, dir: string): Promise<void> {
  const src = path.join(FIXTURES_DIR, name, 'package.json');
  await fsp.copyFile(src, path.join(dir, 'package.json'));
}

// ---------------------------------------------------------------------------
// Install-shape readers (invariant probes)
// ---------------------------------------------------------------------------

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [k: string]: unknown;
}

export async function readPackageJson(dir: string): Promise<PackageJson> {
  return JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')) as PackageJson;
}

/** The declared `@bookedsolid/rea` range (deps wins over devDeps), or undefined
 *  when the dep is absent entirely. */
export async function reaDepRange(dir: string): Promise<string | undefined> {
  const pkg = await readPackageJson(dir);
  return pkg.dependencies?.[REA_PACKAGE_NAME] ?? pkg.devDependencies?.[REA_PACKAGE_NAME];
}

/** Raw bytes of package.json — for byte-stability / "dep still absent" asserts. */
export async function readPackageJsonRaw(dir: string): Promise<string> {
  return fsp.readFile(path.join(dir, 'package.json'), 'utf8');
}

export async function manifestVersion(dir: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, '.rea', 'install-manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

async function setManifestVersion(dir: string, version: string): Promise<void> {
  const manifestPath = path.join(dir, '.rea', 'install-manifest.json');
  const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  parsed['version'] = version;
  await fsp.writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/** Names of the rea-shipped hook files present on disk under `.claude/hooks/`. */
export function presentHookFiles(dir: string): string[] {
  const hooksDir = path.join(dir, '.claude', 'hooks');
  return EXPECTED_HOOKS.filter((h) => fs.existsSync(path.join(hooksDir, h)));
}

/** Every hook `command` string registered across all matcher groups in
 *  `.claude/settings.json` (PreToolUse + PostToolUse). */
export function registeredHookCommands(dir: string): string[] {
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  };
  const out: string[] = [];
  for (const groups of Object.values(s.hooks ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) if (typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}

/** Is a given hook file BOTH present on disk AND referenced by a registered
 *  command in settings.json? (the two-way invariant a real install must hold). */
export function hookInstalledAndRegistered(dir: string, hookFile: string): boolean {
  if (!fs.existsSync(path.join(dir, '.claude', 'hooks', hookFile))) return false;
  return registeredHookCommands(dir).some((cmd) => cmd.includes(hookFile));
}

/** Process-spine skills present under `.claude/skills/rea/` (excluding the
 *  README index, which is not a skill). */
export function spineSkillFiles(dir: string): string[] {
  const skillsDir = path.join(dir, '.claude', 'skills', 'rea');
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
}

// ---------------------------------------------------------------------------
// Doctor probes
// ---------------------------------------------------------------------------

/** The full doctor check set for `dir`. `globalHome` points the global-CLI
 *  tier resolver at a temp home so we never read the real `~/.rea`.
 *  `globalTierProbe` (0.53.0 safety layer) forces the "usable global tier"
 *  predicate so the self-pin brick row can be exercised without a real global
 *  install — the same injectable seam the scaffolders use. */
export function doctorChecks(
  dir: string,
  globalHome?: string,
  globalTierProbe?: (baseDir: string) => boolean,
): CheckResult[] {
  return collectChecks(dir, undefined, undefined, {
    ...(globalHome ? { globalHome } : {}),
    ...(globalTierProbe ? { globalTierProbe } : {}),
  });
}

/** Doctor checks whose status is a hard `fail` — the "not doctor-clean" set.
 *  `warn`/`info` are advisory (e.g. absent OpenRouter key) and do not count. */
export function doctorFailures(
  dir: string,
  globalHome?: string,
  globalTierProbe?: (baseDir: string) => boolean,
): CheckResult[] {
  return doctorChecks(dir, globalHome, globalTierProbe).filter((c) => c.status === 'fail');
}

// 0.53.0 GLOBAL-FIRST: the doctor self-pin row was relabeled and inverted. It
// is no longer a "brick" row — a missing local pin is now the healthy default
// (`pass`); a PRESENT local dep is `warn` (recommend `rea migrate --to-global`).
// The label constant tracks the new row so the journey probes still find it.
export const BRICK_CHECK_LABEL = `rea CLI resolution model (global-first)`;

/** The rea-CLI-resolution-model doctor row (formerly the brick-state row). */
export function brickDiagnostic(
  dir: string,
  globalHome?: string,
  globalTierProbe?: (baseDir: string) => boolean,
): CheckResult | undefined {
  return doctorChecks(dir, globalHome, globalTierProbe).find((c) => c.label === BRICK_CHECK_LABEL);
}

/** True only when that row is a HARD fail. Under global-first + the 0.53.0
 *  safety layer, a dep-free checkout fails ONLY when no usable global tier is
 *  available (true brick); with a usable tier it passes. */
export function brickDiagnosticFires(
  dir: string,
  globalHome?: string,
  globalTierProbe?: (baseDir: string) => boolean,
): boolean {
  return brickDiagnostic(dir, globalHome, globalTierProbe)?.status === 'fail';
}

// ---------------------------------------------------------------------------
// Trusted-marking SEAM
// ---------------------------------------------------------------------------

/**
 * Mark `projDir` as a TRUSTED global-tier checkout by writing its realpath into
 * `<home>/.rea/trusted-projects` — the per-user allow-list the global CLI shim
 * (and `rea doctor`'s `resolveGlobalCliTier`) consult.
 *
 * This is the SINGLE seam the trusted fixture depends on. It writes to a
 * caller-provided TEMP home (never the real `~/.rea`), using the same env-immune
 * `home`-parameter injection point the shim/doctor already expose. When the
 * parallel devex-architect fix lands a matching `home`/trusted seam on
 * `runUpgrade` + a `skipped-global-tier-trusted` self-pin action, the trusted
 * journey below flips from `it.skip` to live by pointing `runUpgrade` at this
 * same temp home. Keep this the ONLY place that knows how trust is recorded.
 */
export function markProjectTrusted(projRealpath: string, home: string): void {
  writeRegistry([projRealpath], home);
}
