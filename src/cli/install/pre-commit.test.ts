/**
 * Unit tests for the G1 spec-gate pre-commit installer.
 *
 * Round-12 F1/F2 coverage:
 *   - active-hooks-path resolution (vanilla git → `.git/hooks/pre-commit`;
 *     `core.hooksPath=.husky` → `.husky/pre-commit`; foreign posture).
 *   - the generated body carries the `REA_CLI_ROOT` worktree fallback so a
 *     linked worktree resolves the primary checkout's CLI (F2).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  preCommitHookContent,
  isReaManagedPreCommit,
  classifyPreCommit,
  installPreCommitHook,
  resolveTargetHookPath,
  PRE_COMMIT_MARKER,
  PRE_COMMIT_BODY_MARKER,
} from './pre-commit.js';

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-precommit-')));
  await execFileAsync('git', ['-C', dir, 'init', '-q']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@test']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'test']);
  return dir;
}
async function setHooksPath(dir: string, hooksPath: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', hooksPath]);
}
function rm(d: string): void {
  fssync.rmSync(d, { recursive: true, force: true });
}

describe('pre-commit installer — content + markers', () => {
  it('content carries both markers and invokes `rea gate spec-check`', () => {
    const c = preCommitHookContent();
    expect(c.startsWith('#!/bin/sh\n')).toBe(true);
    expect(c.split('\n')[1]).toBe(PRE_COMMIT_MARKER);
    expect(c.split('\n')[2]).toBe(PRE_COMMIT_BODY_MARKER);
    expect(c).toContain('gate spec-check');
    expect(isReaManagedPreCommit(c)).toBe(true);
  });

  it('rejects a hook with the header marker but a stubbed-out body', () => {
    const stubbed = `#!/bin/sh\n${PRE_COMMIT_MARKER}\n# not the body marker\nexit 0\n`;
    expect(isReaManagedPreCommit(stubbed)).toBe(false);
  });

  // Round-12 F2 — the body must carry the pre-push v6 REA_CLI_ROOT worktree
  // fallback so a linked worktree (no local node_modules/dist) resolves the
  // primary checkout's CLI instead of falling through to fail-open exit 0.
  describe('F2 — REA_CLI_ROOT worktree fallback in the body', () => {
    const body = preCommitHookContent();
    it('seeds REA_CLI_ROOT from REA_ROOT then re-resolves via git-common-dir', () => {
      expect(body).toContain('REA_CLI_ROOT="$REA_ROOT"');
      expect(body).toMatch(/rev-parse --git-common-dir/);
      expect(body).toMatch(/git -C "\$REA_ROOT" worktree list --porcelain/);
    });
    it('dispatches `gate spec-check` from REA_CLI_ROOT across every tier', () => {
      expect(body).toMatch(/"\$\{REA_CLI_ROOT\}\/node_modules\/\.bin\/rea" gate spec-check/);
      expect(body).toMatch(/node "\$\{REA_CLI_ROOT\}\/dist\/cli\/index\.js" gate spec-check/);
      expect(body).toMatch(
        /grep -q '"name": \*"@bookedsolid\/rea"' "\$\{REA_CLI_ROOT\}\/package\.json"/,
      );
    });
    it('same-repository verification guards a foreign nested checkout', () => {
      expect(body).toContain('_rea_same_repo');
    });
    it('still fails OPEN (exit 0) when no CLI resolves (default-off gate)', () => {
      expect(body).toMatch(/else\n\s+# CLI unreachable — fail OPEN[\s\S]*exit 0\nfi/);
    });
  });
});

describe('pre-commit installer — active-hooks-path resolution (F1)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeRepo();
  });
  afterEach(() => rm(dir));

  it('vanilla git (no core.hooksPath) installs `.git/hooks/pre-commit`', async () => {
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('install');
    expect(res.written).toBe(path.join(dir, '.git', 'hooks', 'pre-commit'));
    // The .husky path is NOT written in vanilla-git — git would never fire it.
    expect(fssync.existsSync(path.join(dir, '.husky', 'pre-commit'))).toBe(false);
    const onDisk = fssync.readFileSync(res.written as string, 'utf8');
    expect(isReaManagedPreCommit(onDisk)).toBe(true);
    expect((fssync.statSync(res.written as string).mode & 0o111) !== 0).toBe(true);
  });

  it('core.hooksPath=.husky installs `.husky/pre-commit` (unchanged path)', async () => {
    await setHooksPath(dir, '.husky');
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('install');
    expect(res.written).toBe(path.join(dir, '.husky', 'pre-commit'));
    expect(fssync.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('installs then reclassifies as refresh (idempotent, byte-identical)', async () => {
    await setHooksPath(dir, '.husky');
    const first = await installPreCommitHook({ targetDir: dir });
    expect(first.decision.action).toBe('install');
    const onDisk = fssync.readFileSync(first.written as string, 'utf8');
    const second = await installPreCommitHook({ targetDir: dir });
    expect(second.decision.action).toBe('refresh');
    expect(fssync.readFileSync(second.written as string, 'utf8')).toBe(onDisk);
  });

  it('leaves a foreign pre-commit alone at the active path (skip)', async () => {
    await setHooksPath(dir, '.husky');
    fssync.mkdirSync(path.join(dir, '.husky'), { recursive: true });
    const foreign = '#!/bin/sh\necho custom\n';
    fssync.writeFileSync(path.join(dir, '.husky', 'pre-commit'), foreign);
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('skip');
    expect(fssync.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8')).toBe(foreign);
  });

  it('foreign posture applies to a vanilla-git `.git/hooks/pre-commit` too', async () => {
    const gitHook = path.join(dir, '.git', 'hooks', 'pre-commit');
    fssync.mkdirSync(path.dirname(gitHook), { recursive: true });
    fssync.writeFileSync(gitHook, '#!/bin/sh\nexit 0\n');
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('skip');
  });

  it('resolveTargetHookPath reports configured vs vanilla correctly', async () => {
    const vanilla = await resolveTargetHookPath(dir);
    expect(vanilla.hooksPathConfigured).toBe(false);
    expect(vanilla.hookPath).toBe(path.join(dir, '.git', 'hooks', 'pre-commit'));
    await setHooksPath(dir, '.husky');
    const husky = await resolveTargetHookPath(dir);
    expect(husky.hooksPathConfigured).toBe(true);
    expect(husky.hookPath).toBe(path.join(dir, '.husky', 'pre-commit'));
  });

  it('classifyPreCommit reports install → refresh across the active path', async () => {
    await setHooksPath(dir, '.husky');
    expect((await classifyPreCommit(dir)).action).toBe('install');
    await installPreCommitHook({ targetDir: dir });
    expect((await classifyPreCommit(dir)).action).toBe('refresh');
  });
});
