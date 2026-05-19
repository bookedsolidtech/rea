/**
 * R12-P1 (codex round 12 / 0.49.0) — `bootstrap_allowlist` preservation
 * across `rea init` re-runs.
 *
 * # Background
 *
 * The 0.49.0 series added `bootstrap_allowlist` as a top-level
 * policy.yaml key with an opt-out flag (`enabled: false`). The
 * opt-out is the documented escape valve for teams that don't want
 * the CLI-missing bootstrap recovery path. R12-P1 closed the drop
 * class: pre-fix, `rea init` re-runs silently dropped the
 * `bootstrap_allowlist` block — an operator who set
 * `enabled: false` got re-enabled on every re-init.
 *
 * # Contract
 *
 *   1. Existing on-disk `bootstrap_allowlist.enabled` wins (preserves
 *      explicit opt-out).
 *   2. Layered profile's `bootstrap_allowlist.enabled` next (e.g.
 *      `bst-internal` pins `enabled: true` explicitly).
 *   3. Neither set → block omitted from emitted policy.yaml.
 *
 * # What this file pins
 *
 * Round-trip preservation: write a policy.yaml with a known
 * `bootstrap_allowlist.enabled` value, run `rea init --yes --force`,
 * and assert the emitted policy.yaml carries the SAME value.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-init-r12-')));
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
}

async function readBootstrapAllowlistEnabled(dir: string): Promise<boolean | undefined> {
  const raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
  const parsed = parseYaml(raw) as Record<string, unknown> | null;
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const ba = parsed['bootstrap_allowlist'] as Record<string, unknown> | undefined;
  if (ba === undefined || typeof ba !== 'object') return undefined;
  const enabled = (ba as Record<string, unknown>)['enabled'];
  return typeof enabled === 'boolean' ? enabled : undefined;
}

async function hasBootstrapAllowlistBlock(dir: string): Promise<boolean> {
  const raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
  return /^bootstrap_allowlist:/m.test(raw);
}

describe('rea init — R12-P1 bootstrap_allowlist preservation', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('R12.1 — `enabled: false` in existing policy.yaml is preserved across re-init', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    process.chdir(dir);

    // Initial install (fresh, no opt-out).
    await runInit({ yes: true, profile: 'minimal', codex: false });

    // Operator manually opts out by editing policy.yaml.
    const policyPath = path.join(dir, '.rea', 'policy.yaml');
    const orig = await fs.readFile(policyPath, 'utf8');
    await fs.writeFile(
      policyPath,
      orig.replace(/\n*$/, '\n') + 'bootstrap_allowlist:\n  enabled: false\n',
      'utf8',
    );

    // Confirm pre-state: opt-out exists.
    expect(await readBootstrapAllowlistEnabled(dir)).toBe(false);

    // Re-run init with --force to overwrite. Pre-R12 this silently
    // dropped the opt-out; post-R12 it's preserved.
    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });

    expect(await readBootstrapAllowlistEnabled(dir)).toBe(false);
  });

  it('R12.2 — `enabled: true` in existing policy.yaml is preserved across re-init', async () => {
    // Symmetric coverage: an explicit `enabled: true` should also
    // round-trip (the operator made an explicit choice; we honor it
    // verbatim rather than dropping it back to schema-default).
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const policyPath = path.join(dir, '.rea', 'policy.yaml');
    const orig = await fs.readFile(policyPath, 'utf8');
    await fs.writeFile(
      policyPath,
      orig.replace(/\n*$/, '\n') + 'bootstrap_allowlist:\n  enabled: true\n',
      'utf8',
    );

    expect(await readBootstrapAllowlistEnabled(dir)).toBe(true);

    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });

    expect(await readBootstrapAllowlistEnabled(dir)).toBe(true);
  });

  it('R12.3 — profile `bst-internal` (which pins enabled: true) emits the block on fresh install', async () => {
    // The `bst-internal` profile pins `bootstrap_allowlist.enabled: true`
    // explicitly. Fresh install with that profile should emit the
    // block (not omit it on the schema-default fallback).
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'bst-internal', codex: false });

    expect(await hasBootstrapAllowlistBlock(dir)).toBe(true);
    expect(await readBootstrapAllowlistEnabled(dir)).toBe(true);
  });

  it('R12.4 — profile `minimal` (no explicit pin) does NOT emit the block on fresh install', async () => {
    // The `minimal` profile doesn't pin `bootstrap_allowlist` —
    // consumers fall through to the zod schema default at policy-
    // load time. The policy.yaml should NOT carry the block, keeping
    // the file diff-clean for the common case.
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    expect(await hasBootstrapAllowlistBlock(dir)).toBe(false);
  });

  it('R12.5 — operator-set `enabled: false` on `bst-internal` survives re-init (existing wins over profile)', async () => {
    // bst-internal pins `enabled: true` at the profile layer.
    // Operator overrides to `enabled: false`. Re-init must preserve
    // the operator's choice — existing on-disk policy wins over
    // profile default.
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'bst-internal', codex: false });
    expect(await readBootstrapAllowlistEnabled(dir)).toBe(true);

    // Operator overrides.
    const policyPath = path.join(dir, '.rea', 'policy.yaml');
    const after = await fs.readFile(policyPath, 'utf8');
    await fs.writeFile(
      policyPath,
      after.replace(/^( *)enabled: true$/m, '$1enabled: false'),
      'utf8',
    );
    expect(await readBootstrapAllowlistEnabled(dir)).toBe(false);

    // Re-init preserves the override.
    await runInit({ yes: true, profile: 'bst-internal', codex: false, force: true });

    expect(await readBootstrapAllowlistEnabled(dir)).toBe(false);
  });

  it('R12.6 — inline form `bootstrap_allowlist: { enabled: false }` is recognized (parser folds both)', async () => {
    // The preservation reader uses yaml.parse, which folds inline
    // and block forms to the same parsed object. Verify operators
    // who wrote the inline form get their opt-out preserved too.
    const dir = await makeScratch();
    cleanup.push(dir);
    await gitInit(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const policyPath = path.join(dir, '.rea', 'policy.yaml');
    const orig = await fs.readFile(policyPath, 'utf8');
    await fs.writeFile(
      policyPath,
      orig.replace(/\n*$/, '\n') + 'bootstrap_allowlist: { enabled: false }\n',
      'utf8',
    );

    expect(await readBootstrapAllowlistEnabled(dir)).toBe(false);

    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });

    expect(await readBootstrapAllowlistEnabled(dir)).toBe(false);
  });
});
