/**
 * 0.53.0 GLOBAL-FIRST — `rea doctor` self-pin diagnostic inversion.
 *
 * Pre-0.53.0 doctor FAILED when hook shims were present but no
 * `@bookedsolid/rea` pin was declared (the local-model brick detector).
 * Under global-first that is the NORMAL healthy state, so:
 *   - missing pin  → PASS
 *   - present pin  → WARN (non-fatal) recommending `rea migrate --to-global`
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkSelfPinDeclaredCheck,
  isGlobalTierUsableIgnoringLocal,
  resolveGlobalCliTier,
} from './doctor.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-gf-')));
  cleanup.push(d);
  return d;
}

/** Lay a `.claude/hooks/` dir with one hook so the check is not N/A. */
async function withHooks(dir: string): Promise<void> {
  const hooksDir = path.join(dir, '.claude', 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(path.join(hooksDir, 'dangerous-bash-interceptor.sh'), '#!/bin/sh\n', 'utf8');
}

async function writePkg(dir: string, pkg: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

describe('rea doctor — 0.53.0 global-first self-pin diagnostic + safety layer', () => {
  it('hooks present + NO local pin + USABLE global tier → PASS', async () => {
    const dir = await scratch();
    await withHooks(dir);
    await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });

    const result = checkSelfPinDeclaredCheck(dir, { globalTierProbe: () => true });

    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/global-first/i);
  });

  it('SAFETY LAYER: hooks present + NO local pin + NO usable global tier → FAIL (true brick)', async () => {
    const dir = await scratch();
    await withHooks(dir);
    await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });

    const result = checkSelfPinDeclaredCheck(dir, { globalTierProbe: () => false });

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no usable global rea CLI/);
    expect(result.detail).toMatch(/hooks cannot resolve any CLI/);
    // Actionable: install-the-global-CLI OR --pin.
    expect(result.detail).toMatch(/install the global CLI/);
    expect(result.detail).toMatch(/--pin/);
  });

  it('SAFETY LAYER: no package.json + NO usable global tier → FAIL (no pin possible, no fallback)', async () => {
    const dir = await scratch();
    await withHooks(dir);
    // No package.json at all.

    const result = checkSelfPinDeclaredCheck(dir, { globalTierProbe: () => false });

    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no usable global rea CLI/);
  });

  it('hooks present + local pin present → WARN recommending migrate (non-fatal)', async () => {
    const dir = await scratch();
    await withHooks(dir);
    await writePkg(dir, {
      name: 'consumer',
      version: '0.0.0',
      devDependencies: { '@bookedsolid/rea': '^0.52.0' },
    });

    const result = checkSelfPinDeclaredCheck(dir);

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/rea migrate --to-global/);
    expect(result.detail).toMatch(/local .*install detected/i);
  });

  it('no .claude/hooks/ → PASS (N/A)', async () => {
    const dir = await scratch();
    await writePkg(dir, { name: 'consumer', version: '0.0.0', private: true });

    const result = checkSelfPinDeclaredCheck(dir);
    expect(result.status).toBe('pass');
  });
});

describe('resolveGlobalCliTier — 0.53.0 ignoreInProject convergence fix', () => {
  const fakeProbe = (): { ok: boolean } => ({ ok: true });

  it('ignoreInProject SKIPS the in-project short-circuit and evaluates the GLOBAL tier', async () => {
    // A repo with a local in-project CLI present — exactly the case `rea migrate`
    // / the interactive strip are FOR (the dep is about to be removed).
    const dir = await scratch();
    const cliDir = path.join(dir, 'node_modules', '@bookedsolid', 'rea', 'dist', 'cli');
    await fs.mkdir(cliDir, { recursive: true });
    await fs.writeFile(path.join(cliDir, 'index.js'), '// cli\n', 'utf8');

    // Temp home with a global ROOT dir present (so the short-circuit reason is
    // the discriminating `in-project-wins`), but no CLI under it.
    const home = await scratch();
    await fs.mkdir(path.join(home, '.rea', 'cli'), { recursive: true });
    await fs.chmod(path.join(home, '.rea'), 0o700);

    // Default (in-project-first): short-circuits — the exact bug that made
    // `isGlobalTierUsable` answer FALSE whenever the local dep existed.
    const def = resolveGlobalCliTier(dir, home, fakeProbe);
    expect(def.tier).toBe('in-project');
    expect(def.reason).toBe('in-project-wins');

    // ignoreInProject: short-circuit skipped → the GLOBAL branch is actually
    // evaluated (here it resolves to unavailable because no CLI lives under the
    // root — the point is it got PAST the local install to ask the real question).
    const ign = resolveGlobalCliTier(dir, home, fakeProbe, { ignoreInProject: true });
    expect(ign.reason).not.toBe('in-project-wins');
    expect(ign.reason).toBe('global-unresolvable');

    // The wrapper the safety gates use returns false here (no usable global).
    expect(isGlobalTierUsableIgnoringLocal(dir, home, fakeProbe)).toBe(false);
  });
});
