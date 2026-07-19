/**
 * 0.53.0 GLOBAL-FIRST — `rea init` end-to-end.
 *
 * `rea init` no longer self-pins by default: a fresh install leaves
 * `package.json` untouched (the global rea CLI tier governs). `--pin`
 * (`options.pin === true`) opts back in to the hermetic local install.
 *
 * The trusted-global-tier probe is driven via the injectable
 * `trustedGlobalTierProbe` option seam so the test never needs a real
 * `~/.rea/trusted-projects`; under global-first it only affects messaging,
 * not whether a pin is written.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { getPkgVersion } from './utils.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-init-gf-')));
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
}

async function writeBarePkg(dir: string): Promise<string> {
  const raw = JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }, null, 2) + '\n';
  await fs.writeFile(path.join(dir, 'package.json'), raw, 'utf8');
  return raw;
}

async function readPin(dir: string): Promise<string | undefined> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(dir, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const devDeps = (pkg['devDependencies'] as Record<string, unknown> | undefined) ?? {};
  const v = devDeps['@bookedsolid/rea'];
  return typeof v === 'string' ? v : undefined;
}

describe('rea init — 0.53.0 global-first (no pin by default)', () => {
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

  /** Capture every `console.warn` line emitted during `fn`. */
  async function captureWarnings(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

  it('SAFETY: warns loudly when skipping the pin with NO usable global tier', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writeBarePkg(dir);
    process.chdir(dir);

    const warnings = await captureWarnings(() =>
      runInit({ yes: true, profile: 'minimal', codex: false, trustedGlobalTierProbe: () => false }),
    );

    expect(warnings).toMatch(/no usable global rea CLI/);
    expect(warnings).toMatch(/--pin/);
    // global-first is FORCED — still no pin (we warn, we do not fall back).
    expect(await readPin(dir)).toBeUndefined();
  });

  it('SAFETY: silent (no brick warning) when the global tier IS usable', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writeBarePkg(dir);
    process.chdir(dir);

    const warnings = await captureWarnings(() =>
      runInit({ yes: true, profile: 'minimal', codex: false, trustedGlobalTierProbe: () => true }),
    );

    expect(warnings).not.toMatch(/no usable global rea CLI/);
    expect(await readPin(dir)).toBeUndefined();
  });

  it('DEFAULT → init completes, package.json byte-identical, NO dep added', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    const before = await writeBarePkg(dir);
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false }),
    ).resolves.toBeUndefined();

    expect(await readPin(dir)).toBeUndefined();
    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('DEFAULT + trusted probe → still no dep (trust is messaging-only under global-first)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    const before = await writeBarePkg(dir);
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false, trustedGlobalTierProbe: () => true }),
    ).resolves.toBeUndefined();

    expect(await readPin(dir)).toBeUndefined();
    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('--pin → dep IS added (hermetic local install opt-in)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writeBarePkg(dir);
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false, pin: true }),
    ).resolves.toBeUndefined();

    expect(await readPin(dir)).toBe(`^${getPkgVersion()}`);
  });
});
