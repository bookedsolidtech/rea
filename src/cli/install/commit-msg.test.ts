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
import {
  classifyCommitMsgHook,
  COMMIT_MSG_MARKER,
  installCommitMsgHook,
} from './commit-msg.js';

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

describe('COMMIT_MSG_MARKER + classifyCommitMsgHook (Fix H / 0.13.0)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-cm-cls-')));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('COMMIT_MSG_MARKER is the v1 marker', () => {
    expect(COMMIT_MSG_MARKER).toBe('# rea:commit-msg v1');
  });

  it('classifies absent hook as { kind: absent }', async () => {
    const res = await classifyCommitMsgHook(path.join(tmp, 'no-such-file'));
    expect(res.kind).toBe('absent');
  });

  it('classifies a v1-marked rea hook as rea-managed', async () => {
    const hp = path.join(tmp, 'commit-msg');
    await fs.writeFile(
      hp,
      `#!/bin/sh\n${COMMIT_MSG_MARKER}\necho hi\n`,
      { mode: 0o755 },
    );
    const res = await classifyCommitMsgHook(hp);
    expect(res.kind).toBe('rea-managed');
    if (res.kind === 'rea-managed') expect(res.version).toBe('v1');
  });

  it('classifies a marker-only-as-substring hook as foreign (anchored on line 2)', async () => {
    const hp = path.join(tmp, 'commit-msg');
    await fs.writeFile(
      hp,
      `#!/bin/sh\n# header line\n${COMMIT_MSG_MARKER}\necho hi\n`,
      { mode: 0o755 },
    );
    const res = await classifyCommitMsgHook(hp);
    // Marker on line 3, not line 2 — must NOT be classified as managed.
    expect(res.kind).toBe('foreign');
  });

  it('classifies a pre-marker (0.12.x) rea body as unmarked (upgrade target)', async () => {
    const hp = path.join(tmp, 'commit-msg');
    // The 0.12.x body had no marker but always referenced `block_ai_attribution`
    // and emitted "AI attribution detected" on block.
    await fs.writeFile(
      hp,
      `#!/bin/sh\nset -e\nif grep -q block_ai_attribution .rea/policy.yaml; then\n  echo "AI attribution detected"; exit 1\nfi\n`,
      { mode: 0o755 },
    );
    const res = await classifyCommitMsgHook(hp);
    expect(res.kind).toBe('unmarked');
  });

  it('classifies a foreign user-authored hook as foreign', async () => {
    const hp = path.join(tmp, 'commit-msg');
    await fs.writeFile(hp, `#!/bin/sh\nexec commitlint --edit "$1"\n`, { mode: 0o755 });
    const res = await classifyCommitMsgHook(hp);
    expect(res.kind).toBe('foreign');
  });

  it('rejects a directory at the hook path as foreign/is-directory', async () => {
    const hp = path.join(tmp, 'commit-msg');
    await fs.mkdir(hp);
    const res = await classifyCommitMsgHook(hp);
    expect(res.kind).toBe('foreign');
    if (res.kind === 'foreign') expect(res.reason).toBe('is-directory');
  });

  it('rejects a symlink as foreign/is-symlink', async () => {
    const hp = path.join(tmp, 'commit-msg');
    const real = path.join(tmp, 'target');
    await fs.writeFile(real, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
    await fs.symlink(real, hp);
    const res = await classifyCommitMsgHook(hp);
    expect(res.kind).toBe('foreign');
    if (res.kind === 'foreign') expect(res.reason).toBe('is-symlink');
  });
});

describe('commit-msg fragment chaining (Fix H / 0.13.0)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-cm-frag-')));
    await execFileAsync('git', ['-C', repo, 'init', '--quiet']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 't']);
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  async function installInstalledHook(): Promise<string> {
    // Install into the scratch repo using the real installer.
    const result = await installCommitMsgHook(repo);
    if (result.gitHook === undefined) throw new Error('install failed');
    return result.gitHook;
  }

  async function writeMsg(text: string): Promise<string> {
    const f = path.join(repo, 'msg.txt');
    await fs.writeFile(f, text, 'utf8');
    return f;
  }

  it('chains executable fragments in lex order on a passing commit', async () => {
    const hookPath = await installInstalledHook();
    const fragDir = path.join(repo, '.husky', 'commit-msg.d');
    await fs.mkdir(fragDir, { recursive: true });
    const log = path.join(repo, 'order.log');
    await fs.writeFile(
      path.join(fragDir, '20-second'),
      `#!/bin/sh\nprintf 'second\\n' >> "${log}"\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(fragDir, '10-first'),
      `#!/bin/sh\nprintf 'first\\n' >> "${log}"\n`,
      { mode: 0o755 },
    );
    const msg = await writeMsg('feat: a clean commit message\n');
    await execFileAsync(hookPath, [msg], { cwd: repo });
    const order = (await fs.readFile(log, 'utf8')).trim().split('\n');
    expect(order).toEqual(['first', 'second']);
  });

  it('skips fragments without exec bit', async () => {
    const hookPath = await installInstalledHook();
    const fragDir = path.join(repo, '.husky', 'commit-msg.d');
    await fs.mkdir(fragDir, { recursive: true });
    const log = path.join(repo, 'order.log');
    await fs.writeFile(
      path.join(fragDir, '10-noexec'),
      `#!/bin/sh\nprintf 'should-not-run\\n' >> "${log}"\n`,
      { mode: 0o644 },
    );
    await fs.writeFile(
      path.join(fragDir, '20-runs'),
      `#!/bin/sh\nprintf 'runs\\n' >> "${log}"\n`,
      { mode: 0o755 },
    );
    const msg = await writeMsg('chore: trigger fragments\n');
    await execFileAsync(hookPath, [msg], { cwd: repo });
    const order = (await fs.readFile(log, 'utf8')).trim().split('\n');
    expect(order).toEqual(['runs']);
  });

  it('non-zero fragment fails the commit', async () => {
    const hookPath = await installInstalledHook();
    const fragDir = path.join(repo, '.husky', 'commit-msg.d');
    await fs.mkdir(fragDir, { recursive: true });
    await fs.writeFile(
      path.join(fragDir, '50-fail'),
      `#!/bin/sh\necho "fragment-said-no" >&2\nexit 4\n`,
      { mode: 0o755 },
    );
    const msg = await writeMsg('chore: this passes attribution\n');
    const r = await execFileAsync(hookPath, [msg], { cwd: repo }).catch(
      (e: { code?: number; stderr?: string }) => e,
    );
    expect((r as { code?: number }).code ?? 0).not.toBe(0);
    expect((r as { stderr?: string }).stderr ?? '').toContain('fragment-said-no');
  });

  it('missing `.husky/commit-msg.d/` is a no-op (backward compat)', async () => {
    const hookPath = await installInstalledHook();
    const msg = await writeMsg('chore: no fragments dir\n');
    const r = await execFileAsync(hookPath, [msg], { cwd: repo });
    expect(r.stderr).toBe('');
  });

  it('fragments still run when block_ai_attribution is disabled (or policy missing)', async () => {
    const hookPath = await installInstalledHook();
    // Ensure policy is missing → the early-exit branch must still chain.
    // (default scratch repo has no .rea/ at all)
    const fragDir = path.join(repo, '.husky', 'commit-msg.d');
    await fs.mkdir(fragDir, { recursive: true });
    const log = path.join(repo, 'order.log');
    await fs.writeFile(
      path.join(fragDir, '10-runs'),
      `#!/bin/sh\nprintf 'fired\\n' >> "${log}"\n`,
      { mode: 0o755 },
    );
    const msg = await writeMsg('feat: ordinary message\n');
    await execFileAsync(hookPath, [msg], { cwd: repo });
    const order = (await fs.readFile(log, 'utf8')).trim().split('\n');
    expect(order).toEqual(['fired']);
  });
});
