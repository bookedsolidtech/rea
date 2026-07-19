/**
 * 0.53.0 GLOBAL-FIRST — `rea upgrade` end-to-end: pin default + UX inversion.
 *
 * Covers:
 *   - default upgrade does NOT re-pin a dep-free checkout (global-first);
 *   - `--pin` restores the hermetic local pin;
 *   - the non-interactive default applies all managed changes with ZERO
 *     prompts and REPORTS (does not clobber) an operator-modified managed
 *     file (drifted);
 *   - `--force` overwrites drift.
 *
 * The trusted-global-tier probe is injected via `trustedGlobalTierProbe` so
 * the test never needs a real `~/.rea`.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { runUpgrade } from './upgrade.js';
import { getPkgVersion } from './utils.js';
import { sha256OfBuffer } from './install/sha.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-upgrade-gf-')));
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
}

async function readPin(dir: string): Promise<string | undefined> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(dir, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  for (const block of ['dependencies', 'devDependencies']) {
    const b = pkg[block] as Record<string, unknown> | undefined;
    const v = b?.['@bookedsolid/rea'];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** A managed hook file present in every install we can drift for the test. */
function firstManagedHook(dir: string): string | null {
  const hooksDir = path.join(dir, '.claude', 'hooks');
  if (!fsSync.existsSync(hooksDir)) return null;
  const entries = fsSync.readdirSync(hooksDir).filter((n) => n.endsWith('.sh')).sort();
  return entries.length > 0 ? path.join('.claude', 'hooks', entries[0]!) : null;
}

describe('rea upgrade — 0.53.0 global-first pin default', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function scaffoldDepFree(dir: string): Promise<void> {
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    // init is global-first now → no pin written; already dep-free.
    await runInit({ yes: true, profile: 'minimal', codex: false });
  }

  it('DEFAULT dep-free upgrade → refreshes, still NO pin', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffoldDepFree(dir);
    const before = await fs.readFile(path.join(dir, 'package.json'), 'utf8');

    await expect(runUpgrade({ yes: true })).resolves.toBeUndefined();

    expect(await readPin(dir)).toBeUndefined();
    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('trusted probe dep-free upgrade → still NO pin (messaging only)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffoldDepFree(dir);

    await expect(
      runUpgrade({ yes: true, trustedGlobalTierProbe: () => true }),
    ).resolves.toBeUndefined();

    expect(await readPin(dir)).toBeUndefined();
  });

  it('--pin dep-free upgrade → dep IS pinned (hermetic opt-in)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffoldDepFree(dir);

    await expect(runUpgrade({ yes: true, pin: true })).resolves.toBeUndefined();

    expect(await readPin(dir)).toBe(`^${getPkgVersion()}`);
  });

  it('SAFETY: warns loudly when skipping the pin with NO usable global tier', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffoldDepFree(dir);

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    try {
      await expect(
        runUpgrade({ yes: true, trustedGlobalTierProbe: () => false }),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    expect(lines.join('\n')).toMatch(/no usable global rea CLI/);
    // global-first forced — no pin written despite the missing tier.
    expect(await readPin(dir)).toBeUndefined();
  });
});

describe('rea upgrade — 0.53.0 UX inversion (non-interactive apply-all)', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function scaffold(dir: string): Promise<void> {
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
  }

  it('an operator-modified managed file (drifted) is REPORTED, not clobbered, with NO prompt (default)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffold(dir);

    const hookRel = firstManagedHook(dir);
    expect(hookRel).not.toBeNull();
    const hookAbs = path.join(dir, hookRel!);
    const operatorEdit = '# operator hand-edit — do not clobber\n';
    await fs.appendFile(hookAbs, operatorEdit, 'utf8');
    const drifted = await fs.readFile(hookAbs, 'utf8');

    // No flags = non-interactive default. This must NOT hang on a prompt and
    // must preserve the operator's edit.
    await expect(runUpgrade({})).resolves.toBeUndefined();

    expect(await fs.readFile(hookAbs, 'utf8')).toBe(drifted);
  });

  it('--force overwrites a drifted managed file (operator opted in)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffold(dir);

    const hookRel = firstManagedHook(dir);
    expect(hookRel).not.toBeNull();
    const hookAbs = path.join(dir, hookRel!);
    const drifted = (await fs.readFile(hookAbs, 'utf8')) + '# drift\n';
    await fs.writeFile(hookAbs, drifted, 'utf8');

    await expect(runUpgrade({ force: true })).resolves.toBeUndefined();

    // Overwritten back to canonical — the drift marker is gone.
    expect(await fs.readFile(hookAbs, 'utf8')).not.toContain('# drift');
  });
});

describe('rea upgrade — 0.53.0 removed-upstream data-loss + --yes + dry-run fixes', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function scaffold(dir: string, opts: { pin?: boolean } = {}): Promise<void> {
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false, pin: opts.pin === true });
  }

  const RETIRED_REL = '.claude/hooks/retired-legacy.sh';

  /**
   * Inject a "removed-upstream" file: on disk under `.claude/hooks/` (rea does
   * NOT ship it) plus a manifest entry. When `manifestContent === diskContent`
   * the on-disk hash matches the manifest hash (UNMODIFIED). Passing a different
   * `manifestContent` simulates an operator hand-edit (MODIFIED).
   */
  async function injectRetired(
    dir: string,
    diskContent: string,
    manifestContent: string = diskContent,
  ): Promise<void> {
    const abs = path.join(dir, RETIRED_REL);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, diskContent, 'utf8');

    const manifestPath = path.join(dir, '.rea', 'install-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      files: Array<{ path: string; sha256: string; source: string }>;
    };
    manifest.files.push({
      path: RETIRED_REL,
      sha256: sha256OfBuffer(manifestContent),
      source: 'hook',
    });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  function retiredExists(dir: string): boolean {
    return fsSync.existsSync(path.join(dir, RETIRED_REL));
  }

  it('P1: an UNMODIFIED removed-upstream file is auto-deleted by default (managed retirement)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffold(dir);
    await injectRetired(dir, '#!/bin/sh\n# retired\n');

    expect(retiredExists(dir)).toBe(true);
    await expect(runUpgrade({})).resolves.toBeUndefined();
    expect(retiredExists(dir)).toBe(false);
  });

  it('P1 DATA-LOSS: a locally-MODIFIED removed-upstream file is PRESERVED by default (edits not clobbered)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffold(dir);
    // Manifest records the canonical bytes; disk carries an operator edit.
    const edited = '#!/bin/sh\n# OPERATOR EDIT — keep me\n';
    await injectRetired(dir, edited, '#!/bin/sh\n# canonical\n');

    await expect(runUpgrade({})).resolves.toBeUndefined();

    // Preserved — file still present with the operator's exact bytes.
    expect(retiredExists(dir)).toBe(true);
    expect(await fs.readFile(path.join(dir, RETIRED_REL), 'utf8')).toBe(edited);
  });

  it('P1: --force deletes even a locally-MODIFIED removed-upstream file (operator opted in)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffold(dir);
    await injectRetired(dir, '#!/bin/sh\n# OPERATOR EDIT\n', '#!/bin/sh\n# canonical\n');

    await expect(runUpgrade({ force: true })).resolves.toBeUndefined();
    expect(retiredExists(dir)).toBe(false);
  });

  it('P2: --yes SKIPS removed-upstream (script-stable contract — never deletes)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await scaffold(dir);
    // UNMODIFIED — default would delete; `--yes` must skip.
    await injectRetired(dir, '#!/bin/sh\n# retired\n');

    await expect(runUpgrade({ yes: true })).resolves.toBeUndefined();
    expect(retiredExists(dir)).toBe(true);
  });

  it('P2: --dry-run --interactive with a local dep leaves package.json BYTE-UNCHANGED', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    // `--pin` at init gives us a local dep to tempt the strip-offer.
    await scaffold(dir, { pin: true });
    const before = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
    expect(before).toContain('@bookedsolid/rea');

    // A dry-run must never write — and must never hang on the interactive
    // strip prompt. package.json is byte-identical afterward.
    await expect(runUpgrade({ dryRun: true, interactive: true })).resolves.toBeUndefined();

    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });
});
