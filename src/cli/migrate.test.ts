/**
 * 0.53.0 — `rea migrate --to-global` CLI (runMigrate).
 *
 * Unit-level coverage of the migrateToGlobal manifest edit lives in
 * install/self-pin.test.ts; this drives the CLI wrapper end-to-end in a
 * scratch dir and asserts the dep is removed / the idempotent path is a
 * no-op / the target-required guard fires.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrate, stripLocalDepGuarded } from './migrate.js';

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-migrate-')));
}

async function writePkg(dir: string, pkg: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

async function readParsed(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('rea migrate --to-global (runMigrate)', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    vi.restoreAllMocks();
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('strips the local dep and reports the follow-up', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      devDependencies: { '@bookedsolid/rea': '^0.52.0', keep: '^1.0.0' },
    });
    process.chdir(dir);

    // Usable global tier → the strip proceeds (safety gate satisfied).
    await expect(runMigrate({ toGlobal: true, globalTierProbe: () => true })).resolves.toBeUndefined();

    const parsed = await readParsed(dir);
    expect(parsed['devDependencies']).toEqual({ keep: '^1.0.0' });
  });

  it('SAFETY: refuses (exit 1, package.json untouched) when NO usable global tier', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      devDependencies: { '@bookedsolid/rea': '^0.52.0', keep: '^1.0.0' },
    });
    process.chdir(dir);
    const before = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    // No global fallback → stripping the only resolvable CLI would brick the
    // repo. Live run must refuse HARD and NOT touch package.json.
    await expect(runMigrate({ toGlobal: true, globalTierProbe: () => false })).rejects.toThrow(
      'process.exit',
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('SAFETY: dry-run + NO usable global tier previews the refusal (no exit, no mutation)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      devDependencies: { '@bookedsolid/rea': '^0.52.0' },
    });
    process.chdir(dir);
    const before = await fs.readFile(path.join(dir, 'package.json'), 'utf8');

    // Preview must NOT exit non-zero and must NOT write.
    await expect(
      runMigrate({ toGlobal: true, dryRun: true, globalTierProbe: () => false }),
    ).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('idempotent — a second run is a no-op (already global-first)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });
    process.chdir(dir);
    const before = await fs.readFile(path.join(dir, 'package.json'), 'utf8');

    await expect(runMigrate({ toGlobal: true })).resolves.toBeUndefined();

    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('refuses without a target (--to-global required)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await expect(runMigrate({})).rejects.toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('dry-run does not mutate package.json', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      devDependencies: { '@bookedsolid/rea': '^0.52.0' },
    });
    process.chdir(dir);
    const before = await fs.readFile(path.join(dir, 'package.json'), 'utf8');

    // Usable global tier → dry-run of a real strip; still writes nothing.
    await expect(
      runMigrate({ toGlobal: true, dryRun: true, globalTierProbe: () => true }),
    ).resolves.toBeUndefined();

    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });
});

describe('stripLocalDepGuarded — the shared brick-safety gate', () => {
  const cleanup: string[] = [];
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
  });
  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('local dep + USABLE global tier → strips (this is the common path the in-project-first bug broke)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      devDependencies: { '@bookedsolid/rea': '^0.52.0' },
    });

    const outcome = await stripLocalDepGuarded({ cwd: dir, globalTierProbe: () => true });

    expect(outcome.kind).toBe('stripped');
    const parsed = await readParsed(dir);
    expect(parsed['devDependencies']).toBeUndefined();
  });

  it('local dep + NO usable global tier → refused-no-global, package.json untouched', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      devDependencies: { '@bookedsolid/rea': '^0.52.0' },
    });
    const before = await fs.readFile(path.join(dir, 'package.json'), 'utf8');

    const outcome = await stripLocalDepGuarded({ cwd: dir, globalTierProbe: () => false });

    expect(outcome.kind).toBe('refused-no-global');
    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('no dep → nothing (already-global); global-tier probe not even consulted', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });
    let probed = false;

    const outcome = await stripLocalDepGuarded({
      cwd: dir,
      globalTierProbe: () => {
        probed = true;
        return false;
      },
    });

    expect(outcome.kind).toBe('nothing');
    expect(probed).toBe(false);
  });
});
