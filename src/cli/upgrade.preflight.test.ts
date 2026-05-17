/**
 * 0.42.0 codex round 2 P2 correction (2026-05-16) — pre-flight
 * settings-validation atomicity test.
 *
 * Background: pre-correction, `runUpgrade` ran `safeInstallFile` /
 * `safeDeleteFile` over every canonical file FIRST, then called
 * `upgradeSettings` which validated the merged result and threw on
 * failure. This meant canonical hook + agent files had already been
 * written to disk before the validation refusal — `rea upgrade
 * --check` could honestly report "would refuse" but consumer files
 * would still be partially written if the real invocation was made.
 *
 * Correction: validation moved to a pre-flight block at the top of
 * `runUpgrade`, BEFORE any file mutations. If the merged settings
 * would fail validation, `runUpgrade` throws immediately with ZERO
 * disk writes — preserving the "preview = real" contract for
 * `upgrade --check` and giving the operator a clean retry surface.
 *
 * This file pins that atomicity guarantee: after a thrown pre-flight
 * refusal, NO canonical file should have been installed.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { runUpgrade } from './upgrade.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-upgrade-preflight-')));
}

describe('rea upgrade — pre-flight settings validation (0.42.0 codex round 2 P2)', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('refuses to start BEFORE any file writes when merged settings fail validation', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    // Delete a hook that the upgrade would normally re-install. If
    // pre-flight runs FIRST, this file must NOT be re-created.
    // Pick a hook that's unambiguously in every install (every
    // profile installs `secret-scanner.sh`).
    const hookPath = path.join(dir, '.claude', 'hooks', 'secret-scanner.sh');
    const hookExistedAtBaseline = await fs
      .stat(hookPath)
      .then(() => true)
      .catch(() => false);
    expect(hookExistedAtBaseline).toBe(true);
    await fs.rm(hookPath);
    // Sanity: file is gone before runUpgrade.
    const goneBefore = await fs
      .stat(hookPath)
      .then(() => true)
      .catch(() => false);
    expect(goneBefore).toBe(false);

    // Plant an invalid hook command in .claude/settings.json so the
    // merged result fails zod validation. Missing `type: 'command'`
    // on a hook is the same shape the upgrade-check test uses.
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const existingSettings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const hooks = (existingSettings.hooks as Record<string, unknown>) ?? {};
    hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ command: 'echo missing-type' }] }];
    existingSettings.hooks = hooks;
    await fs.writeFile(settingsPath, JSON.stringify(existingSettings, null, 2), 'utf8');

    // Snapshot .rea contents before — codex round 2 follow-up P2
    // requires that the 0.11.0 policy migration also be gated behind
    // pre-flight (the migration rewrites .rea/policy.yaml + creates a
    // policy.yaml.bak-* sibling). After a refused upgrade, NO new
    // policy.yaml.bak-* files should exist beyond what was there
    // before the call.
    const reaBefore = (await fs.readdir(path.join(dir, '.rea'))).filter((n) =>
      n.startsWith('policy.yaml.bak-'),
    );

    // Pre-flight should throw. Body must mention "refusing to start"
    // (the new wording) and reference the safety guardrail.
    await expect(runUpgrade({ yes: true })).rejects.toThrow(/refusing to start/);

    // Atomicity guarantee 1: the deleted hook MUST still be missing.
    // Pre-correction, runUpgrade would have re-installed it during
    // the file-write loop before the settings validation tripped.
    const goneAfter = await fs
      .stat(hookPath)
      .then(() => true)
      .catch(() => false);
    expect(goneAfter).toBe(false);

    // Atomicity guarantee 2 (codex round 2 follow-up P2): no new
    // policy.yaml.bak-* should have been created by
    // migrateReviewPolicyFor0110, because pre-flight now runs BEFORE
    // the migration.
    const reaAfter = (await fs.readdir(path.join(dir, '.rea'))).filter((n) =>
      n.startsWith('policy.yaml.bak-'),
    );
    expect(reaAfter).toEqual(reaBefore);
  });
});
