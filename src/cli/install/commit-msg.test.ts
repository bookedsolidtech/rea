/**
 * Tests for `installCommitMsgHook` — specifically finding #9.
 *
 * The old implementation read `.git/config` with a regex, which was
 * section-blind: any `hooksPath = …` line in `[worktree]`, `[alias]`,
 * `[includeIf]`, or an included file would win over the real `[core]` entry.
 * The fix shells out to `git config --get core.hooksPath`, which is the only
 * way to consult git config correctly.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommitMsgHook } from './commit-msg.js';

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  // Keep tests hermetic: no user-level git config leaks in.
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'test']);
}

describe('installCommitMsgHook — core.hooksPath resolution (finding #9)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-commit-msg-'));
    dir = await fs.realpath(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('installs to .git/hooks/ when core.hooksPath is unset', async () => {
    await initGitRepo(dir);
    const result = await installCommitMsgHook(dir);
    expect(result.gitHook).toBe(path.join(dir, '.git', 'hooks', 'commit-msg'));
    const stat = await fs.stat(result.gitHook!);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('honors core.hooksPath when explicitly set in the [core] section', async () => {
    await initGitRepo(dir);
    const customHooks = path.join(dir, 'my-hooks');
    await fs.mkdir(customHooks, { recursive: true });
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', customHooks]);

    const result = await installCommitMsgHook(dir);
    expect(result.gitHook).toBe(path.join(customHooks, 'commit-msg'));
    expect(result.warnings.some((w) => w.includes('core.hooksPath is set'))).toBe(true);
  });

  it('ignores an unrelated hooksPath key in a non-[core] section', async () => {
    // This is the crux of finding #9. Stick a `hooksPath = /bogus` key inside
    // an unrelated section (`[alias]`). A naive regex would match it and
    // target `/bogus`; `git config --get core.hooksPath` correctly reports
    // "unset" because no `[core] hooksPath` exists.
    await initGitRepo(dir);
    const cfgPath = path.join(dir, '.git', 'config');
    const existing = await fs.readFile(cfgPath, 'utf8');
    await fs.writeFile(
      cfgPath,
      existing +
        '\n[alias]\n\thooksPath = /bogus/should-not-be-used\n',
      'utf8',
    );

    const result = await installCommitMsgHook(dir);
    // Must fall back to the default location, NOT /bogus/…
    expect(result.gitHook).toBe(path.join(dir, '.git', 'hooks', 'commit-msg'));
    expect(result.warnings.some((w) => w.includes('core.hooksPath is set'))).toBe(false);
    // And the bogus path should never be created.
    await expect(fs.stat('/bogus/should-not-be-used')).rejects.toThrow();
  });
});
