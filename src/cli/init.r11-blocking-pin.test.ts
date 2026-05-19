/**
 * R11-P1 (codex round 11 / 0.49.0) — `rea init` blocking-pin pre-flight
 * atomicity test.
 *
 * # Background
 *
 * R9-P1 added a blocking-pin pre-flight to `runUpgrade`: if
 * `package.json` already pins `@bookedsolid/rea` to a version that
 * does not admit the installed CLI version, the upgrade aborts BEFORE
 * any 0.49 hooks/policy artifacts hit disk. Without the pre-flight,
 * the consumer ends up with 0.49 hooks resolving an old CLI from
 * node_modules whose strict policy loader rejects the new
 * `bootstrap_allowlist:` top-level key.
 *
 * R11-P1 closes the same gap for `runInit`. Operators frequently
 * re-run `rea init` against an existing install (the "reinstall"
 * pattern). Pre-R11 the same skew could land on init too — codex
 * flagged this as a P1 BLOCKING gap.
 *
 * # What this file pins
 *
 * The atomicity guarantee: when the init pre-flight refuses, NO
 * `.rea/` directory is created, NO hooks or policy.yaml hit disk,
 * and the existing package.json pin is unchanged.
 *
 * The pre-flight runs at line ~1693 of `runInit` (right before
 * `mkdirSync(reaDir)` — the first artifact write).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-init-r11-')));
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
}

async function writePkgJsonWithPin(dir: string, range: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'consumer',
        version: '0.0.0',
        private: true,
        devDependencies: { '@bookedsolid/rea': range },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

async function readPin(dir: string): Promise<string | undefined> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(dir, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const devDeps = (pkg['devDependencies'] as Record<string, unknown> | undefined) ?? {};
  const v = devDeps['@bookedsolid/rea'];
  return typeof v === 'string' ? v : undefined;
}

describe('rea init — R11-P1 blocking-pin pre-flight atomicity', () => {
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
    await writePkgJsonWithPin(dir, 'workspace:*');
    process.chdir(dir);

    // Snapshot pre-init state: no .rea/ should exist BEFORE
    // because there's no install yet.
    expect(fsSync.existsSync(path.join(dir, '.rea'))).toBe(false);

    await expect(runInit({ yes: true, profile: 'minimal', codex: false })).rejects.toThrow(
      /rea init refusing/,
    );

    // package.json pin unchanged.
    expect(await readPin(dir)).toBe('workspace:*');

    // .rea/ should STILL not exist — pre-flight ran before mkdir.
    expect(fsSync.existsSync(path.join(dir, '.rea'))).toBe(false);

    // .claude/ should STILL not exist.
    expect(fsSync.existsSync(path.join(dir, '.claude'))).toBe(false);
  });

  it('refuses on file:../rea pin', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, 'file:../rea');
    process.chdir(dir);

    await expect(runInit({ yes: true, profile: 'minimal', codex: false })).rejects.toThrow(
      /rea init refusing/,
    );
    expect(await readPin(dir)).toBe('file:../rea');
    expect(fsSync.existsSync(path.join(dir, '.rea'))).toBe(false);
  });

  it('refuses on git URL pin', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, 'github:bookedsolidtech/rea#main');
    process.chdir(dir);

    await expect(runInit({ yes: true, profile: 'minimal', codex: false })).rejects.toThrow(
      /rea init refusing/,
    );
    expect(await readPin(dir)).toBe('github:bookedsolidtech/rea#main');
    expect(fsSync.existsSync(path.join(dir, '.rea'))).toBe(false);
  });

  it('refuses on dist-tag pin "next"', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, 'next');
    process.chdir(dir);

    await expect(runInit({ yes: true, profile: 'minimal', codex: false })).rejects.toThrow(
      /rea init refusing/,
    );
    expect(await readPin(dir)).toBe('next');
    expect(fsSync.existsSync(path.join(dir, '.rea'))).toBe(false);
  });

  it('refuses on exact older pin that does not admit current CLI', async () => {
    // We construct a downward exact pin so the test stays valid
    // across CLI version bumps. Mirrors the pattern from
    // upgrade.r9-blocking-pin.test.ts.
    const { getPkgVersion } = await import('./utils.js');
    const cur = getPkgVersion();
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
      return; // 0.0.0 — can't construct lower
    }
    const older = `${downMajor}.${downMinor}.${downPatch}`;

    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, older);
    process.chdir(dir);

    await expect(runInit({ yes: true, profile: 'minimal', codex: false })).rejects.toThrow(
      /rea init refusing/,
    );
    expect(await readPin(dir)).toBe(older);
    expect(fsSync.existsSync(path.join(dir, '.rea'))).toBe(false);
  });

  it('proceeds on fresh repo (no existing pin)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    // No package.json at all — fresh init flow.
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false }),
    ).resolves.toBeUndefined();
    // .rea/ created by the canonical init flow.
    expect(fsSync.existsSync(path.join(dir, '.rea'))).toBe(true);
  });

  it('proceeds on repo with current managed-caret pin (admits running CLI)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    const { getPkgVersion } = await import('./utils.js');
    await writePkgJsonWithPin(dir, `^${getPkgVersion()}`);
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false }),
    ).resolves.toBeUndefined();
    expect(fsSync.existsSync(path.join(dir, '.rea'))).toBe(true);
  });

  it('error message mentions "rea init" (not "rea upgrade") — R11-P1 mode parameter', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, 'workspace:*');
    process.chdir(dir);

    let thrown: Error | null = null;
    try {
      await runInit({ yes: true, profile: 'minimal', codex: false });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/rea init refusing/);
    // And the recovery hint says re-run `rea init`, not `rea upgrade`.
    expect(thrown!.message).toMatch(/Then re-run: rea init/);
  });
});
