/**
 * Regression pin — `rea upgrade --dry-run` must NOT touch the user-global
 * dashboard registry (`~/.rea/registry.json`).
 *
 * ## Why this test exists
 *
 * `rea upgrade --check` / `--dry-run` is a PREVIEW-ONLY contract: it prints the
 * plan and writes nothing. The self-registration into the global dashboard
 * registry (`registerProject`, upgrade.ts) is a state MUTATION that lives OUTSIDE
 * the project, so it must never fire during a preview.
 *
 * Today the contract is honored purely by ORDERING: `registerProject` sits at
 * upgrade.ts ~line 1067, strictly BELOW the unconditional dry-run early-return
 * at ~lines 1007-1020 (`if (dryRun) { …logs…; return; }`). It is therefore
 * provably unreachable when `dryRun === true`. Nothing PINS that ordering — a
 * future refactor that hoisted the registry write above the early-return would
 * silently break "preview = no mutations" with no failing test. This test is
 * that pin: it proves, via a spy AND via file-absence, that a dry-run upgrade
 * never registers the project.
 *
 * ## Isolation (leak-proof)
 *
 * The registry path resolves off `os.homedir()` (`defaultRegistryPath()` in
 * `src/registry/projects.ts`), and the upgrade call site uses that default — it
 * passes NO `registryPath` override. On POSIX, Node's `os.homedir()` honors
 * `process.env.HOME`; on Windows, `process.env.USERPROFILE`. We save, redirect
 * both to throwaway temp dirs in `beforeEach`, and restore in `afterEach`, so
 * the resolved registry path can NEVER be the operator's real `~/.rea/`. We also
 * use a SEPARATE fresh temp HOME for the dry-run phase than for the `runInit`
 * scaffolding phase (init self-registers, which legitimately creates a registry
 * under the init-phase HOME) — so a genuinely-absent registry file under the
 * upgrade-phase HOME is a clean, unconfounded proof that dry-run wrote nothing.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the registry self-registration without replacing its behavior: the
// default export set is preserved so every other consumer of this module
// (dash.js's reconcile/loadRegistry, etc.) keeps the real implementation.
vi.mock('../registry/projects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry/projects.js')>();
  return {
    ...actual,
    registerProject: vi.fn(actual.registerProject),
  };
});

import { registerProject } from '../registry/projects.js';
import { runInit } from './init.js';
import { runUpgrade } from './upgrade.js';

const execFileAsync = promisify(execFile);
const registerProjectSpy = vi.mocked(registerProject);

async function makeScratch(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

describe('rea upgrade — dry-run does not mutate the global dashboard registry', () => {
  let prevCwd: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    registerProjectSpy.mockClear();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    // Restore the real HOME/USERPROFILE so no later test (or the harness) sees
    // our temp redirection.
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('never calls registerProject and writes no registry.json during --dry-run', async () => {
    // --- Scaffold phase (HOME = init-phase temp home) -----------------------
    const initHome = await makeScratch('rea-dryrun-reg-inithome-');
    cleanup.push(initHome);
    process.env.HOME = initHome;
    process.env.USERPROFILE = initHome;

    const dir = await makeScratch('rea-dryrun-reg-proj-');
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);

    // init self-registers → legitimately writes a registry under initHome.
    await runInit({ yes: true, profile: 'minimal', codex: false });

    // --- Dry-run phase (fresh HOME with NO existing registry) ---------------
    // A distinct, empty temp home so an absent registry file here is an
    // unconfounded proof that the dry-run upgrade wrote nothing.
    const upgradeHome = await makeScratch('rea-dryrun-reg-upghome-');
    cleanup.push(upgradeHome);
    process.env.HOME = upgradeHome;
    process.env.USERPROFILE = upgradeHome;
    registerProjectSpy.mockClear();

    await runUpgrade({ yes: true, dryRun: true });

    // Direct proof of the invariant: the early-return guarded the call.
    expect(registerProjectSpy).not.toHaveBeenCalled();
    // Belt-and-suspenders: no registry file materialized under the dry-run HOME.
    const registryPath = path.join(upgradeHome, '.rea', 'registry.json');
    expect(existsSync(registryPath)).toBe(false);
  });
});
