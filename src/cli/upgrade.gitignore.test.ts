/**
 * BUG-010 — `rea upgrade` `.gitignore` backfill.
 *
 * Verifies the upgrade path surface for the 0.5.0 fix. The scenario the user
 * is actually hitting:
 *
 *   1. Ran `rea init` on 0.3.x / 0.4.0 (which never scaffolded `.gitignore`).
 *   2. Started `rea serve` — G7 wrote `.rea/fingerprints.json`.
 *   3. `git status` now lists `fingerprints.json` as untracked.
 *   4. Runs `rea upgrade` to pick up 0.5.0 — upgrade MUST backfill the
 *      managed `.gitignore` block so the untracked-file noise disappears.
 *
 * We simulate the "no managed block yet" starting state by writing a
 * `.gitignore` with only operator content before calling `runUpgrade`.
 *
 * Build gate: this test imports `runUpgrade` which calls
 * `enumerateCanonicalFiles()` against the built artifacts under
 * `hooks/`, `agents/`, `commands/`, `.husky/`. Those are source files
 * (not `dist/`), so the test runs in source mode without a prior build.
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
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-upgrade-gi-')));
}

describe('rea upgrade — BUG-010 gitignore backfill', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(
      cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('backfills .gitignore managed block on upgrade when consumer has no block', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    // Simulate the 0.4.0 state: strip the managed block that init just
    // wrote, leaving only consumer content. This is what every existing
    // 0.3.x/0.4.0 consumer's .gitignore looks like today.
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\ndist\n', 'utf8');

    await runUpgrade({ yes: true });

    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gi).toContain('node_modules');
    expect(gi).toContain('dist');
    expect(gi).toContain('# === rea managed');
    expect(gi).toContain('.rea/fingerprints.json');
    expect(gi).toContain('.rea/review-cache.jsonl');
    expect(gi).toContain('.rea/audit.jsonl');
  });

  it('upgrade is a no-op on .gitignore when managed block is already complete', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    const first = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');

    await runUpgrade({ yes: true });
    const second = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');

    expect(second).toBe(first);
  });

  it('upgrade --dry-run does not touch .gitignore', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    // Simulate pre-0.5.0 state (no managed block).
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\n', 'utf8');

    await runUpgrade({ yes: true, dryRun: true });

    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gi).toBe('node_modules\n');
    expect(gi).not.toContain('# === rea managed');
  });
});
