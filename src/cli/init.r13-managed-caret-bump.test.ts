/**
 * R13-P1 (codex round 13 / 0.49.0) — `rea init` must bump a managed
 * caret pin that does NOT admit the running CLI version.
 *
 * # Background
 *
 * R2-P1-1 added managed-caret bumping to `rea upgrade`. `rea init`
 * kept the warn-and-skip posture (the assumption was "init is a
 * fresh install, the operator's pin is authoritative"). R11-P1 added
 * a blocking-pin preflight to init that ABORTS when the pin won't
 * admit the new CLI — except for the managed-caret case, where it
 * assumes the bump will happen. But pre-R13 `selfPinRea` was called
 * in default `mode: 'init'`, which warn-skipped instead of bumping.
 *
 * Result: `rea init` on a `^0.49.0` pin with CLI 0.50.0 wrote new
 * hooks/policy but left the manifest pinned to the old CLI. Skew.
 *
 * # Fix
 *
 * Pass `mode: 'upgrade'` to `selfPinRea` from the init call site
 * (src/cli/init.ts:1894). The R11-P1 preflight already filters out
 * non-managed-caret cases, so the only thing reaching `selfPinRea`
 * is either a fresh write OR a managed-caret bump — and `mode:
 * 'upgrade'` is the right semantics for both.
 *
 * # What this file pins
 *
 * The managed-caret bump on the init path. Pairs with
 * `init.r11-blocking-pin.test.ts` which covers the abort path for
 * non-managed-caret cases.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-init-r13-')));
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

describe('rea init — R13-P1 managed-caret bump on the init path', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('R13.1 — same-major caret that does NOT admit the CLI → BUMPS in place', async () => {
    // Construct a starting caret pin that does NOT admit the current
    // CLI version. We derive a lower-minor version dynamically so
    // the test stays correct across CLI version bumps.
    const { getPkgVersion } = await import('./utils.js');
    const cur = getPkgVersion();
    const parts = cur.split('-')[0]!.split('.').map((p) => Number(p));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    let downMinor = minor;
    if (minor > 0) downMinor = minor - 1;
    else return; // can't construct lower if minor is 0
    const olderCaret = `^${major}.${downMinor}.0`;
    const expectedNewCaret = `^${cur}`;

    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, olderCaret);
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false }),
    ).resolves.toBeUndefined();

    // The pin should have been bumped — `^X.Y-1.0` → `^X.Y.Z` (current).
    expect(await readPin(dir)).toBe(expectedNewCaret);
  });

  it('R13.2 — caret that admits the CLI → no-op (pin unchanged)', async () => {
    // `^X.Y.0` admits `X.Y.Z` for any patch Z — no bump needed.
    const { getPkgVersion } = await import('./utils.js');
    const cur = getPkgVersion();
    const parts = cur.split('-')[0]!.split('.').map((p) => Number(p));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const sameMajorMinorFloor = `^${major}.${minor}.0`;

    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, sameMajorMinorFloor);
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false }),
    ).resolves.toBeUndefined();

    // Pin unchanged — range admitted the current CLI; no bump fired.
    expect(await readPin(dir)).toBe(sameMajorMinorFloor);
  });

  it('R13.3 — caret already at the current CLI version → no-op', async () => {
    const { getPkgVersion } = await import('./utils.js');
    const cur = `^${getPkgVersion()}`;

    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, cur);
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false }),
    ).resolves.toBeUndefined();

    expect(await readPin(dir)).toBe(cur);
  });

  it('R13.4 — no existing pin → fresh write (current CLI caret)', async () => {
    const { getPkgVersion } = await import('./utils.js');
    const expectedNewCaret = `^${getPkgVersion()}`;

    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false }),
    ).resolves.toBeUndefined();

    expect(await readPin(dir)).toBe(expectedNewCaret);
  });

  it('R13.5 — cross-major caret (`^1.0.0` + CLI 0.x) → R11-P1 preflight aborts (NOT bumped)', async () => {
    // R11-P1's preflight rejects cross-major pins regardless of
    // whether the pin shape would technically be bumpable. The R13
    // bump path is REACHABLE only when same-major; cross-major
    // never reaches `selfPinRea`. Verify the abort still fires.
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, '^1.0.0');
    process.chdir(dir);

    await expect(
      runInit({ yes: true, profile: 'minimal', codex: false }),
    ).rejects.toThrow(/rea init refusing/);

    // Pin unchanged — preflight refused before any write.
    expect(await readPin(dir)).toBe('^1.0.0');
  });

  it('R18-P2 — bumped action surfaces in stdout success summary', async () => {
    // R18-P2 (codex round 18): pre-R18 the init result-reporting
    // ladder had no `'bumped'` arm. R13-P1 wired init through
    // `mode: 'upgrade'`, so a managed-caret bump on init was a live
    // path — but the success summary printed no line about the
    // mutation. R18 adds an explicit arm mirroring `rea upgrade`'s
    // format. This test pins the operator-facing output so a
    // future refactor cannot silently drop the line again.
    const { getPkgVersion } = await import('./utils.js');
    const cur = getPkgVersion();
    const parts = cur.split('-')[0]!.split('.').map((p) => Number(p));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    let downMinor = minor;
    if (minor > 0) downMinor = minor - 1;
    else return; // skip on cliVersion x.0.z — can't construct an older caret
    const olderCaret = `^${major}.${downMinor}.0`;
    const expectedNewCaret = `^${cur}`;

    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    await writePkgJsonWithPin(dir, olderCaret);
    process.chdir(dir);

    // Capture console.log output. The bumped arm uses console.log
    // (not the @clack/prompts log helpers) so a plain spy works.
    const stdoutLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    try {
      await runInit({ yes: true, profile: 'minimal', codex: false });
    } finally {
      console.log = originalLog;
    }

    // Pin was bumped to the current CLI's caret.
    expect(await readPin(dir)).toBe(expectedNewCaret);

    // The success summary contains a single line describing the
    // bump with both ranges. We assert the substrings that codex
    // R18 called out as missing — operator must SEE the mutation.
    const joined = stdoutLines.join('\n');
    expect(joined).toMatch(/self-pin: bumped @bookedsolid\/rea/);
    expect(joined).toContain(olderCaret);
    expect(joined).toContain(expectedNewCaret);
  });
});
