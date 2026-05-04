/**
 * Init flow tests focused on the G11.4 `--codex` / `--no-codex` plumbing.
 *
 * `runInit` uses `process.cwd()` internally (carried from the original
 * wizard), so these tests run in an isolated tmpdir per case, switching
 * `process.cwd()` only for the duration of the `runInit` call and
 * restoring it afterwards.
 *
 * We exercise the non-interactive path exclusively (`--yes`). The
 * interactive wizard is driven by `@clack/prompts` which we don't stub;
 * the non-interactive path is the production CI path and is the seam
 * with the new flag semantics.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { FALLBACK_MARKER } from './install/pre-push.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-init-test-')));
}

async function readPolicy(dir: string): Promise<string> {
  return fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
}

describe('rea init — G11.4 codex flags', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('--yes --no-codex writes review.codex_required: false', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({
      yes: true,
      profile: 'minimal',
      codex: false,
    });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/review:\s*\n\s+codex_required:\s+false/);
    expect(policy).not.toMatch(/codex_required:\s+true/);
  });

  it('--yes --codex writes review.codex_required: true', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({
      yes: true,
      profile: 'minimal',
      codex: true,
    });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/review:\s*\n\s+codex_required:\s+true/);
  });

  it('--yes with no codex flag: default is derived from profile name', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // Plain `minimal` profile → codex_required defaults to true.
    await runInit({ yes: true, profile: 'minimal' });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/codex_required:\s+true/);
  });

  it('--yes --profile bst-internal-no-codex defaults to codex_required: false', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'bst-internal-no-codex' });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/codex_required:\s+false/);
  });

  it('--yes --profile bst-internal-no-codex --codex overrides the profile default', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // Explicit --codex wins over the profile default. Unusual but permitted:
    // the operator has picked a no-codex profile for its other settings but
    // wants to keep Codex review in the loop.
    await runInit({
      yes: true,
      profile: 'bst-internal-no-codex',
      codex: true,
    });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/codex_required:\s+true/);
  });

  it('--yes --profile open-source-no-codex defaults to codex_required: false', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'open-source-no-codex' });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/codex_required:\s+false/);
  });

  it('G6: installs fallback pre-push in a vanilla git repo', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const prePushPath = path.join(dir, '.git', 'hooks', 'pre-push');
    const content = await fs.readFile(prePushPath, 'utf8');
    expect(content).toContain(FALLBACK_MARKER);
    expect(content).toContain('hook push-gate');

    const stat = await fs.stat(prePushPath);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('G6: re-running init does not duplicate or corrupt the fallback', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    // Second invocation: --force so the policy overwrite path is taken.
    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });

    // Still exactly one pre-push, still carries our marker, still executable.
    const hooksDir = path.join(dir, '.git', 'hooks');
    const entries = await fs.readdir(hooksDir);
    const prePushEntries = entries.filter((e) => e === 'pre-push');
    expect(prePushEntries).toEqual(['pre-push']);

    const content = await fs.readFile(path.join(hooksDir, 'pre-push'), 'utf8');
    expect(content).toContain(FALLBACK_MARKER);
  });

  it('written policy parses via the loader round-trip', async () => {
    // Smoke test: the field we emit must be accepted by the strict policy
    // loader. A typo in the YAML key would escape the other tests because
    // they read the raw string — this closes that gap.
    const { loadPolicy } = await import('../policy/loader.js');
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const policy = loadPolicy(dir);
    expect(policy.review?.codex_required).toBe(false);
  });

  it('BUG-010: init scaffolds .gitignore entries for every .rea runtime artifact', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gi).toContain('.rea/fingerprints.json');
    expect(gi).toContain('.rea/last-review.json');
    expect(gi).toContain('.rea/audit.jsonl');
    expect(gi).toContain('.rea/audit-*.jsonl');
    expect(gi).toContain('.rea/HALT');
    expect(gi).toContain('.rea/metrics.jsonl');
    expect(gi).toContain('.rea/serve.pid');
    expect(gi).toContain('.rea/serve.state.json');
    // Marker present so re-running init recognizes its own block.
    expect(gi).toContain('# === rea managed');
  });

  it('BUG-010: re-running init is idempotent — no duplicate gitignore entries', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    const first = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');

    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });
    const second = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');

    expect(second).toBe(first);
    // Exactly one managed block.
    const openMarkers = (second.match(/# === rea managed — do not edit between markers ===/g) ?? [])
      .length;
    const closeMarkers = (second.match(/# === end rea managed ===/g) ?? []).length;
    expect(openMarkers).toBe(1);
    expect(closeMarkers).toBe(1);
  });

  it('0.21.1 idempotency: re-running rea init preserves manually-edited autonomy_level', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // First init — profile default L1.
    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(raw).toMatch(/^autonomy_level:\s*L1\s*$/m);

    // Operator manually escalates to L2.
    raw = raw.replace(/^autonomy_level:\s*L1\s*$/m, 'autonomy_level: L2');
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    // Re-init — must preserve L2.
    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/^autonomy_level:\s*L2\s*$/m);
  });

  it('0.21.1 idempotency: re-running rea init preserves manually-edited blocked_paths', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    // Operator adds .secrets to the blocked list.
    raw = raw.replace(/^blocked_paths:\s*\n((?:\s+-\s+.*\n)+)/m, (_m, body: string) => {
      return `blocked_paths:\n${body}  - ".secrets"\n`;
    });
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/-\s+["']?\.secrets["']?/);
  });

  it('0.21.1 idempotency: re-running rea init preserves block_ai_attribution = false', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    raw = raw.replace(/^block_ai_attribution:\s*true\s*$/m, 'block_ai_attribution: false');
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/^block_ai_attribution:\s*false\s*$/m);
  });

  it('0.17.0 idempotency: re-running rea init preserves installed_at in policy.yaml', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    const first = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    const firstStamp = first.match(/^installed_at:\s*"([^"]+)"/m)?.[1];
    expect(firstStamp).toBeDefined();

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    const secondStamp = second.match(/^installed_at:\s*"([^"]+)"/m)?.[1];

    expect(secondStamp).toBe(firstStamp);
  });

  it('0.17.0 idempotency: re-running rea init preserves installed_at in install-manifest.json', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    const firstRaw = await fs.readFile(path.join(dir, '.rea', 'install-manifest.json'), 'utf8');
    const firstStamp = (JSON.parse(firstRaw) as { installed_at: string }).installed_at;

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const secondRaw = await fs.readFile(path.join(dir, '.rea', 'install-manifest.json'), 'utf8');
    const secondStamp = (JSON.parse(secondRaw) as { installed_at: string }).installed_at;

    expect(secondStamp).toBe(firstStamp);
  });

  it('BUG-010: init preserves existing .gitignore content when adding managed block', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // Consumer has their own .gitignore before running rea init.
    const existing = ['node_modules', 'dist', '.env', ''].join('\n');
    await fs.writeFile(path.join(dir, '.gitignore'), existing, 'utf8');

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    // Consumer lines preserved.
    expect(gi).toContain('node_modules');
    expect(gi).toContain('dist');
    expect(gi).toContain('.env');
    // Managed block appended after.
    expect(gi).toContain('# === rea managed');
    expect(gi).toContain('.rea/fingerprints.json');
    // Consumer content comes before the managed block.
    const userIdx = gi.indexOf('node_modules');
    const markerIdx = gi.indexOf('# === rea managed');
    expect(userIdx).toBeLessThan(markerIdx);
  });
});
