/**
 * R9-P1 (codex round 9 / 0.49.0) — `rea upgrade` blocking-pin pre-flight
 * atomicity test.
 *
 * # Background
 *
 * `rea init` / `rea upgrade` write 0.49 hooks and a `.rea/policy.yaml`
 * that carries the new `bootstrap_allowlist:` top-level key. The strict
 * `PolicySchema` in `src/policy/loader.ts:405` rejects this key when
 * parsed by an OLD CLI. If `package.json` still pins
 * `@bookedsolid/rea` to a version that does not admit the running CLI
 * version (workspace:*, file:.., git URLs, dist-tags, exact older
 * pins, cross-major caret), the consumer ends up with 0.49 hooks
 * resolving an old CLI from node_modules — every Bash payload then
 * refuses until the operator reconciles the pin.
 *
 * # The fix
 *
 * A read-only pre-flight (`checkUpgradeBlockingPin`) runs at the very
 * top of `runUpgrade`, AFTER the existing settings-validation
 * pre-flight (which is the same atomicity pattern) and BEFORE every
 * artifact-writing step:
 *   - migrateReviewPolicyFor0110 (rewrites .rea/policy.yaml)
 *   - the canonical file-write loop (hooks, agents, commands)
 *   - the dedicated `selfPinRea` call further down
 *   - .gitignore + prepare-commit-msg + manifest writes
 *
 * On `block`, `runUpgrade` THROWS with the operator-actionable reason
 * (multi-line). The CLI wrapper catches and `process.exit(1)`s. In
 * dry-run mode the same condition is described without throwing —
 * `rea upgrade --check` continues to show the preview.
 *
 * # What this file pins
 *
 * The atomicity guarantee: when the pre-flight refuses, NO canonical
 * file is mutated, NO .rea/policy.yaml.bak-* file is created, and the
 * existing package.json pin is left exactly as the operator wrote it.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { runUpgrade } from './upgrade.js';
import { getPkgVersion } from './utils.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-upgrade-r9-')));
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
}

async function setPin(dir: string, range: string): Promise<void> {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, unknown>;
  const devDeps = (pkg['devDependencies'] as Record<string, unknown> | undefined) ?? {};
  devDeps['@bookedsolid/rea'] = range;
  pkg['devDependencies'] = devDeps;
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

async function readPin(dir: string): Promise<string | undefined> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(dir, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const devDeps = (pkg['devDependencies'] as Record<string, unknown> | undefined) ?? {};
  const v = devDeps['@bookedsolid/rea'];
  return typeof v === 'string' ? v : undefined;
}

describe('rea upgrade — R9-P1 blocking-pin pre-flight atomicity', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('refuses + ZERO disk mutation when pin is workspace:*', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    // Need a package.json BEFORE init — otherwise init's own self-pin
    // writes one and our subsequent setPin operates on the just-
    // created devDep block.
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    // Replace whatever pin init wrote with the blocking shape.
    await setPin(dir, 'workspace:*');

    // Snapshot the policy.yaml bytes — if the pre-flight refuses, the
    // 0.11.0 migration must NOT have run.
    const policyPath = path.join(dir, '.rea', 'policy.yaml');
    const policyBefore = await fs.readFile(policyPath, 'utf8');
    const reaBakBefore = (await fs.readdir(path.join(dir, '.rea'))).filter((n) =>
      n.startsWith('policy.yaml.bak-'),
    );

    await expect(runUpgrade({ yes: true })).rejects.toThrow(/rea upgrade refusing/);

    // package.json pin unchanged.
    expect(await readPin(dir)).toBe('workspace:*');

    // .rea/policy.yaml bytes unchanged.
    const policyAfter = await fs.readFile(policyPath, 'utf8');
    expect(policyAfter).toBe(policyBefore);

    // No new policy.yaml.bak-* siblings (migration didn't run).
    const reaBakAfter = (await fs.readdir(path.join(dir, '.rea'))).filter((n) =>
      n.startsWith('policy.yaml.bak-'),
    );
    expect(reaBakAfter).toEqual(reaBakBefore);
  });

  it('refuses on file:../rea pin', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    await setPin(dir, 'file:../rea');

    await expect(runUpgrade({ yes: true })).rejects.toThrow(/rea upgrade refusing/);
    expect(await readPin(dir)).toBe('file:../rea');
  });

  it('refuses on git URL pin', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    await setPin(dir, 'github:bookedsolidtech/rea#main');

    await expect(runUpgrade({ yes: true })).rejects.toThrow(/rea upgrade refusing/);
    expect(await readPin(dir)).toBe('github:bookedsolidtech/rea#main');
  });

  it('refuses on dist-tag pin "next"', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    await setPin(dir, 'next');

    await expect(runUpgrade({ yes: true })).rejects.toThrow(/rea upgrade refusing/);
    expect(await readPin(dir)).toBe('next');
  });

  it('refuses on exact older version that does not admit current CLI', async () => {
    // Construct a version exact-pin that the running CLI cannot
    // satisfy. We don't hard-code a literal — derive a lower minor
    // from the running version so the test stays correct across
    // CLI version bumps.
    const cur = getPkgVersion();
    // Build a downward floor: same major, minor-1 if positive,
    // else patch-1. This is always less than `cur` and never
    // satisfies `cur`.
    const parts = cur.split('-')[0]!.split('.').map((p) => Number(p));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const patch = parts[2] ?? 0;
    let downMajor = major;
    let downMinor = minor;
    let downPatch = patch;
    if (minor > 0) downMinor = minor - 1;
    else if (patch > 0) downPatch = patch - 1;
    else if (major > 0) {
      downMajor = major - 1;
      downMinor = 0;
      downPatch = 0;
    } else {
      // 0.0.0 — can't construct a lower version; skip the test.
      return;
    }
    const older = `${downMajor}.${downMinor}.${downPatch}`;

    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    await setPin(dir, older); // EXACT older pin

    await expect(runUpgrade({ yes: true })).rejects.toThrow(/rea upgrade refusing/);
    expect(await readPin(dir)).toBe(older);
  });

  it('dry-run does NOT throw on a blocking pin — it describes the condition', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    await setPin(dir, 'workspace:*');

    // Dry-run completes WITHOUT throwing. Its job is to describe.
    await expect(runUpgrade({ yes: true, dryRun: true })).resolves.toBeUndefined();

    // package.json pin still unchanged.
    expect(await readPin(dir)).toBe('workspace:*');
  });

  it('proceeds normally when pin is the current managed caret (no-op self-pin path)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const cur = `^${getPkgVersion()}`;
    await setPin(dir, cur);

    // Should NOT throw — pin already matches the new CLI version.
    await expect(runUpgrade({ yes: true })).resolves.toBeUndefined();
    expect(await readPin(dir)).toBe(cur);
  });

  // R10-P2 (codex round 10): the pin pre-flight ALSO refuses when
  // package.json is a symlink (would write outside the project
  // tree). Mirrors R9-P1's atomicity guarantee.
  it('R10-P2: symlinked package.json → refuses, ZERO disk mutation', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });

    // Replace the regular package.json with a symlink to a manifest
    // OUTSIDE the project tree. (We deliberately use an external
    // dir for the symlink target — the security claim is "don't
    // mutate files outside the requested project tree", so the
    // target MUST be outside `dir`.)
    const externalDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-upgrade-r10-external-')),
    );
    cleanup.push(externalDir);
    const externalManifest = path.join(externalDir, 'package.json');
    const externalBytes =
      JSON.stringify({ name: 'external-victim', private: true }, null, 2) + '\n';
    await fs.writeFile(externalManifest, externalBytes, 'utf8');

    // Capture the bytes the symlink would replace.
    await fs.rm(path.join(dir, 'package.json'));
    await fs.symlink(externalManifest, path.join(dir, 'package.json'));

    // Snapshot the policy.yaml bytes — atomicity requires that
    // pre-flight refuses BEFORE the 0.11.0 migration runs.
    const policyPath = path.join(dir, '.rea', 'policy.yaml');
    const policyBefore = await fs.readFile(policyPath, 'utf8');

    await expect(runUpgrade({ yes: true })).rejects.toThrow(/refusing: .* is a symlink/);

    // Symlink target's bytes UNCHANGED.
    expect(await fs.readFile(externalManifest, 'utf8')).toBe(externalBytes);

    // .rea/policy.yaml bytes UNCHANGED (migration didn't run).
    expect(await fs.readFile(policyPath, 'utf8')).toBe(policyBefore);
  });

  it('R10-P2 dry-run: symlinked package.json → describes without throwing', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });

    const externalDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-upgrade-r10-external-')),
    );
    cleanup.push(externalDir);
    const externalManifest = path.join(externalDir, 'package.json');
    await fs.writeFile(
      externalManifest,
      JSON.stringify({ name: 'external-victim' }, null, 2) + '\n',
      'utf8',
    );

    await fs.rm(path.join(dir, 'package.json'));
    await fs.symlink(externalManifest, path.join(dir, 'package.json'));

    // Dry-run completes WITHOUT throwing — its job is to describe.
    await expect(runUpgrade({ yes: true, dryRun: true })).resolves.toBeUndefined();
  });
});
