/**
 * 0.53.0 GLOBAL-FIRST — `selfPinRea` pin-default inversion + `migrateToGlobal`.
 *
 * `rea init` / `rea upgrade` NO LONGER self-pin by default: the global rea CLI
 * tier governs, so a no-pin checkout is the normal healthy state. `--pin`
 * (`options.pin`) is the explicit opt-in that restores the hermetic local
 * install. `trustedGlobalTier` is now purely a messaging signal (which
 * "skipped" action to report), not a pin gate.
 *
 * These are UNIT tests over the plain boolean options (fully hermetic — no
 * `~/.rea` needed). End-to-end caller wiring lives in the init/upgrade
 * global-first tests.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { selfPinRea, migrateToGlobal, REA_PACKAGE_NAME } from './self-pin.js';

const CLI = '0.53.0';
const CARET = `^${CLI}`;

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-selfpin-')));
  cleanup.push(d);
  return d;
}

async function writePkg(dir: string, pkg: Record<string, unknown>): Promise<string> {
  const raw = JSON.stringify(pkg, null, 2) + '\n';
  await fs.writeFile(path.join(dir, 'package.json'), raw, 'utf8');
  return raw;
}

async function readRaw(dir: string): Promise<string> {
  return fs.readFile(path.join(dir, 'package.json'), 'utf8');
}

async function readParsed(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readRaw(dir)) as Record<string, unknown>;
}

describe('selfPinRea — 0.53.0 global-first pin default', () => {
  it('DEFAULT (no pin, untrusted) + no existing pin → skipped-global-default, package.json byte-identical', async () => {
    const dir = await scratch();
    const before = await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });

    const result = await selfPinRea({ cwd: dir, cliVersion: CLI, mode: 'upgrade' });

    expect(result.action).toBe('skipped-global-default');
    expect(await readRaw(dir)).toBe(before);
    const parsed = await readParsed(dir);
    expect(parsed['devDependencies']).toBeUndefined();
    expect(parsed['dependencies']).toBeUndefined();
  });

  it('DEFAULT + trustedGlobalTier=true + no existing pin → skipped-global-tier-trusted, byte-identical', async () => {
    const dir = await scratch();
    const before = await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });

    const result = await selfPinRea({
      cwd: dir,
      cliVersion: CLI,
      mode: 'upgrade',
      trustedGlobalTier: true,
    });

    expect(result.action).toBe('skipped-global-tier-trusted');
    expect(result.message).toBe(
      'self-pin skipped — checkout is trusted in the global-tier registry; ' +
        'refreshing hooks/spine without re-adding the dep',
    );
    expect(await readRaw(dir)).toBe(before);
  });

  it('--pin opt-in + no existing pin → wrote (hermetic local install restored)', async () => {
    const dir = await scratch();
    await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });

    const result = await selfPinRea({ cwd: dir, cliVersion: CLI, mode: 'upgrade', pin: true });

    expect(result.action).toBe('wrote');
    const parsed = await readParsed(dir);
    expect((parsed['devDependencies'] as Record<string, string>)[REA_PACKAGE_NAME]).toBe(CARET);
  });

  it('--pin takes precedence over trustedGlobalTier (explicit opt-in wins)', async () => {
    const dir = await scratch();
    await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });

    const result = await selfPinRea({
      cwd: dir,
      cliVersion: CLI,
      mode: 'upgrade',
      pin: true,
      trustedGlobalTier: true,
    });

    expect(result.action).toBe('wrote');
  });

  it('existing DIFFERENT pin → skip-different regardless of global-first default (operator owns it)', async () => {
    const dir = await scratch();
    const before = await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      private: true,
      devDependencies: { [REA_PACKAGE_NAME]: 'workspace:*' },
    });

    const result = await selfPinRea({ cwd: dir, cliVersion: CLI, mode: 'upgrade' });

    expect(result.action).toBe('skipped-different');
    expect(result.existingRange).toBe('workspace:*');
    expect(await readRaw(dir)).toBe(before);
  });

  it('existing managed-caret that does NOT admit CLI → still BUMPS (skew-safety for a real local dep)', async () => {
    const dir = await scratch();
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      private: true,
      devDependencies: { [REA_PACKAGE_NAME]: '^0.52.0' },
    });

    const result = await selfPinRea({ cwd: dir, cliVersion: CLI, mode: 'upgrade' });

    expect(result.action).toBe('bumped');
    const parsed = await readParsed(dir);
    expect((parsed['devDependencies'] as Record<string, string>)[REA_PACKAGE_NAME]).toBe(CARET);
  });

  it('dogfood is unchanged even with --pin', async () => {
    const dir = await scratch();
    const before = await writePkg(dir, { name: REA_PACKAGE_NAME, version: '0.0.0', private: true });

    const result = await selfPinRea({ cwd: dir, cliVersion: CLI, mode: 'upgrade', pin: true });

    expect(result.action).toBe('skipped-dogfood');
    expect(await readRaw(dir)).toBe(before);
  });

  it('symlinked package.json still THROWS in live mode (security refusal preserved)', async () => {
    const dir = await scratch();
    const realDir = await scratch();
    await writePkg(realDir, { name: 'target', version: '0.0.0', private: true });
    fsSync.symlinkSync(path.join(realDir, 'package.json'), path.join(dir, 'package.json'));

    await expect(selfPinRea({ cwd: dir, cliVersion: CLI, mode: 'upgrade' })).rejects.toThrow(
      /is a symlink/,
    );
  });
});

describe('migrateToGlobal — 0.53.0 assisted removal', () => {
  it('removes the dep from devDependencies, preserves key order (byte-minimal)', async () => {
    const dir = await scratch();
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      private: true,
      devDependencies: { zzz: '^1.0.0', [REA_PACKAGE_NAME]: CARET, aaa: '^2.0.0' },
    });

    const result = await migrateToGlobal({ cwd: dir });

    expect(result.action).toBe('removed');
    expect(result.removedFrom).toEqual(['devDependencies']);
    const parsed = await readParsed(dir);
    // rea gone; other keys keep ORIGINAL order (zzz before aaa — not sorted).
    expect(Object.keys(parsed['devDependencies'] as Record<string, unknown>)).toEqual([
      'zzz',
      'aaa',
    ]);
    expect((parsed['devDependencies'] as Record<string, unknown>)[REA_PACKAGE_NAME]).toBeUndefined();
  });

  it('removes from BOTH dependencies and devDependencies; drops a now-empty block', async () => {
    const dir = await scratch();
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      dependencies: { [REA_PACKAGE_NAME]: CARET },
      devDependencies: { [REA_PACKAGE_NAME]: CARET, other: '^1.0.0' },
    });

    const result = await migrateToGlobal({ cwd: dir });

    expect(result.action).toBe('removed');
    expect(result.removedFrom).toEqual(['dependencies', 'devDependencies']);
    const parsed = await readParsed(dir);
    // `dependencies` had only rea → block dropped entirely.
    expect(parsed['dependencies']).toBeUndefined();
    expect(parsed['devDependencies']).toEqual({ other: '^1.0.0' });
  });

  it('idempotent — no rea dep → skipped-already-global, byte-identical', async () => {
    const dir = await scratch();
    const before = await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });

    const result = await migrateToGlobal({ cwd: dir });

    expect(result.action).toBe('skipped-already-global');
    expect(await readRaw(dir)).toBe(before);
  });

  it('dogfood-safe — pkg.name === @bookedsolid/rea → skipped-dogfood, byte-identical', async () => {
    const dir = await scratch();
    const before = await writePkg(dir, {
      name: REA_PACKAGE_NAME,
      version: '0.0.0',
      devDependencies: { [REA_PACKAGE_NAME]: CARET },
    });

    const result = await migrateToGlobal({ cwd: dir });

    expect(result.action).toBe('skipped-dogfood');
    expect(await readRaw(dir)).toBe(before);
  });

  it('dry-run — reports would-remove without writing', async () => {
    const dir = await scratch();
    const before = await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      devDependencies: { [REA_PACKAGE_NAME]: CARET },
    });

    const result = await migrateToGlobal({ cwd: dir, dryRun: true });

    expect(result.action).toBe('removed');
    expect(result.message).toMatch(/would remove/);
    expect(await readRaw(dir)).toBe(before);
  });

  it('symlinked package.json THROWS in live mode', async () => {
    const dir = await scratch();
    const realDir = await scratch();
    await writePkg(realDir, {
      name: 'target',
      version: '0.0.0',
      devDependencies: { [REA_PACKAGE_NAME]: CARET },
    });
    fsSync.symlinkSync(path.join(realDir, 'package.json'), path.join(dir, 'package.json'));

    await expect(migrateToGlobal({ cwd: dir })).rejects.toThrow(/is a symlink/);
  });
});
