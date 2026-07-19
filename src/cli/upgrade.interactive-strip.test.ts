/**
 * 0.53.0 CONVERGENCE FIX (P1 #2) — `rea upgrade --interactive` strip-offer must
 * go through the SAME brick-safety gate as `rea migrate --to-global`.
 *
 * The interactive "Strip the local dep?" prompt used to call `migrateToGlobal`
 * directly, bypassing the usable-global-tier refusal — it could brick a repo.
 * It now routes through `stripLocalDepGuarded`, which refuses when no usable
 * global tier would remain.
 *
 * We mock ONLY `@clack/prompts.confirm` (→ true) so the offer proceeds without a
 * TTY; every other clack export (spinner/log/isCancel) stays real. The
 * usable-global predicate is driven via the injectable `globalTierProbe` seam.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, confirm: vi.fn(async () => true) };
});

import { runInit } from './init.js';
import { runUpgrade } from './upgrade.js';
import { getPkgVersion } from './utils.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-upg-strip-')));
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
}

async function readDep(dir: string): Promise<string | undefined> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(dir, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const dev = (pkg['devDependencies'] as Record<string, unknown> | undefined) ?? {};
  const v = dev['@bookedsolid/rea'];
  return typeof v === 'string' ? v : undefined;
}

/** Scaffold a global-first install, then ADD a local dep (pin === current so the
 *  blocking-pin preflight passes and self-pin → skipped-same → the strip offer
 *  fires). */
async function scaffoldWithLocalDep(dir: string): Promise<void> {
  await gitInit(dir);
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }, null, 2) + '\n',
    'utf8',
  );
  process.chdir(dir);
  await runInit({ yes: true, profile: 'minimal', codex: false });
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, unknown>;
  pkg['devDependencies'] = { '@bookedsolid/rea': `^${getPkgVersion()}` };
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

describe('rea upgrade --interactive strip — 0.53.0 brick-safety gate', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    vi.clearAllMocks();
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('confirmed strip + NO usable global tier → does NOT strip (refuse + warn); dep preserved', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffoldWithLocalDep(dir);
    expect(await readDep(dir)).toBe(`^${getPkgVersion()}`);

    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warnings.push(a.map(String).join(' '));
    });
    try {
      await expect(
        runUpgrade({ interactive: true, globalTierProbe: () => false }),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    // Refused — dep still present, and an actionable warning was emitted.
    expect(await readDep(dir)).toBe(`^${getPkgVersion()}`);
    expect(warnings.join('\n')).toMatch(/cannot strip the local @bookedsolid\/rea dep/);
  });

  it('confirmed strip + USABLE global tier → strips the dep', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffoldWithLocalDep(dir);
    expect(await readDep(dir)).toBe(`^${getPkgVersion()}`);

    await expect(
      runUpgrade({ interactive: true, globalTierProbe: () => true }),
    ).resolves.toBeUndefined();

    expect(await readDep(dir)).toBeUndefined();
  });
});
