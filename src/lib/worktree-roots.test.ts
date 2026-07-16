/**
 * Worktree-roots resolver tests — the resolution matrix from the plan:
 * plain repo, nested cwd, linked worktree, bare-ish edge, non-git dir,
 * the zero-spawn discriminator, and the hook ladder's `.rea/` guard.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveCommonRoot,
  resolveHookRoots,
  resolveLocalRoot,
  resolveReaRoots,
} from './worktree-roots.js';

let scratch: string;
beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-wtroots-')));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Init a repo with one commit and a `.rea/` dir. */
function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.rea', 'policy.yaml'), 'version: "1"\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init', '--no-gpg-sign');
}

describe('resolveLocalRoot', () => {
  it('returns the git toplevel from a nested cwd', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const nested = path.join(repo, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveLocalRoot(nested)).toBe(repo);
  });

  it('falls back to the nearest-.rea walk outside git', () => {
    const root = path.join(scratch, 'nogit');
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    const nested = path.join(root, 'x', 'y');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveLocalRoot(nested)).toBe(root);
  });

  it('returns startDir verbatim when nothing resolves', () => {
    const bare = path.join(scratch, 'plain');
    fs.mkdirSync(bare, { recursive: true });
    expect(resolveLocalRoot(bare)).toBe(bare);
  });
});

describe('resolveCommonRoot — the .git discriminator', () => {
  it('primary checkout (.git is a directory) → degenerate, zero spawns', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const r = resolveCommonRoot(repo);
    expect(r).toEqual({ commonRoot: repo, isLinkedWorktree: false });
  });

  it('non-git dir → degenerate', () => {
    const dir = path.join(scratch, 'nogit2');
    fs.mkdirSync(dir, { recursive: true });
    expect(resolveCommonRoot(dir)).toEqual({ commonRoot: dir, isLinkedWorktree: false });
  });

  it('linked worktree (.git is a file) → primary checkout root', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const wt = path.join(scratch, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
    const r = resolveCommonRoot(wt);
    expect(r.isLinkedWorktree).toBe(true);
    expect(r.commonRoot).toBe(repo);
  });

  it('resolveReaRoots composes: worktree local + primary common', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const wt = path.join(scratch, 'wt2');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch-2');
    const nested = path.join(wt, 'sub');
    fs.mkdirSync(nested);
    const roots = resolveReaRoots(nested);
    expect(roots.localRoot).toBe(wt);
    expect(roots.commonRoot).toBe(repo);
    expect(roots.isLinkedWorktree).toBe(true);
  });

  it('plain repo: local === common (the load-bearing degenerate invariant)', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const roots = resolveReaRoots(repo);
    expect(roots.localRoot).toBe(repo);
    expect(roots.commonRoot).toBe(repo);
    expect(roots.isLinkedWorktree).toBe(false);
  });

  it('bare-host edge: common parent without a checkout → degenerate + advisory', () => {
    // A worktree of a BARE repo: git init --bare, then worktree add.
    const bare = path.join(scratch, 'store.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf8' });
    // Bare repos need an initial commit to add a worktree; do it via a temp clone.
    const seed = path.join(scratch, 'seed');
    makeRepo(seed);
    git(seed, 'push', '-q', bare, 'HEAD:refs/heads/main');
    const wt = path.join(scratch, 'bare-wt');
    git(scratch, '-C', bare, 'worktree', 'add', '-q', wt, 'main');
    const advisories: string[] = [];
    const r = resolveCommonRoot(wt, (s) => advisories.push(s));
    // dirname(common dir) = scratch — no .rea/, no .git/ → degenerate.
    expect(r.isLinkedWorktree).toBe(false);
    expect(r.commonRoot).toBe(wt);
    expect(advisories.join('')).toMatch(/bare repository/);
  });
});

describe('resolveHookRoots — guarded candidate ladder', () => {
  it('accepts the payload cwd when its root has .rea/', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const roots = resolveHookRoots(path.join(repo));
    expect(roots.localRoot).toBe(repo);
  });

  it('REJECTS a payload cwd whose root has no .rea/ and falls to the env candidate', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const stray = path.join(scratch, 'stray');
    fs.mkdirSync(stray, { recursive: true });
    const prev = process.env['CLAUDE_PROJECT_DIR'];
    process.env['CLAUDE_PROJECT_DIR'] = repo;
    try {
      const roots = resolveHookRoots(stray);
      expect(roots.localRoot).toBe(repo); // the agent's `cd /tmp` did not drag the gate along
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_PROJECT_DIR'];
      else process.env['CLAUDE_PROJECT_DIR'] = prev;
    }
  });

  it('no qualifying candidate → historical first-candidate behavior', () => {
    const stray = path.join(scratch, 'stray2');
    fs.mkdirSync(stray, { recursive: true });
    const prevEnv = process.env['CLAUDE_PROJECT_DIR'];
    const prevCwd = process.cwd();
    delete process.env['CLAUDE_PROJECT_DIR'];
    process.chdir(stray); // otherwise process.cwd() (this repo) qualifies via its .rea/
    try {
      const roots = resolveHookRoots(stray);
      expect(roots.localRoot).toBe(stray);
    } finally {
      process.chdir(prevCwd);
      if (prevEnv !== undefined) process.env['CLAUDE_PROJECT_DIR'] = prevEnv;
    }
  });

  it('explicitRoot (test seam) short-circuits the ladder and still resolves common', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const wt = path.join(scratch, 'wt3');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch-3');
    const roots = resolveHookRoots('/does/not/matter', wt);
    expect(roots.localRoot).toBe(wt);
    expect(roots.commonRoot).toBe(repo);
    expect(roots.isLinkedWorktree).toBe(true);
  });

  it('explicitRoot in a plain temp dir behaves exactly like today (degenerate)', () => {
    const dir = path.join(scratch, 'tmp-seam');
    fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
    const roots = resolveHookRoots(undefined, dir);
    expect(roots).toEqual({ localRoot: dir, commonRoot: dir, isLinkedWorktree: false });
  });
});
