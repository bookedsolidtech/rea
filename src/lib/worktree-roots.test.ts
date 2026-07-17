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
  it('accepts the payload cwd when no rea-rooted session anchor exists', () => {
    // Round-7 P1 semantics: a payload repo is accepted outright only
    // when the session anchor (CLAUDE_PROJECT_DIR / cwd) is not itself
    // a rea root — then the payload IS the session repo.
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const stray = path.join(scratch, 'no-anchor');
    fs.mkdirSync(stray, { recursive: true });
    const prevEnv = process.env['CLAUDE_PROJECT_DIR'];
    const prevCwd = process.cwd();
    delete process.env['CLAUDE_PROJECT_DIR'];
    process.chdir(stray);
    try {
      const roots = resolveHookRoots(repo);
      expect(roots.localRoot).toBe(repo);
    } finally {
      process.chdir(prevCwd);
      if (prevEnv !== undefined) process.env['CLAUDE_PROJECT_DIR'] = prevEnv;
    }
  });

  it('REJECTS a payload cwd whose root has no .rea/ and falls to the env candidate', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const stray = path.join(scratch, 'stray');
    fs.mkdirSync(stray, { recursive: true });
    const prev = process.env['CLAUDE_PROJECT_DIR'];
    const prevCwd = process.cwd();
    process.env['CLAUDE_PROJECT_DIR'] = repo;
    process.chdir(repo); // live-session shape: hook cwd = project dir
    try {
      const roots = resolveHookRoots(stray);
      expect(roots.localRoot).toBe(repo); // the agent's `cd /tmp` did not drag the gate along
    } finally {
      process.chdir(prevCwd);
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

  it('FOREIGN-repo payload cwd is pinned back to the session anchor (round-7 P1)', () => {
    // Two independent rea-managed repos. The session anchor is repo A;
    // the agent cd'ed into repo B before the tool call. Accepting B
    // would load B's policy and turn writes into A into "outside root".
    const repoA = path.join(scratch, 'repo-a');
    const repoB = path.join(scratch, 'repo-b');
    makeRepo(repoA);
    makeRepo(repoB);
    const prev = process.env['CLAUDE_PROJECT_DIR'];
    const prevCwd = process.cwd();
    process.env['CLAUDE_PROJECT_DIR'] = repoA;
    process.chdir(repoA); // live-session shape: hook cwd = project dir
    try {
      const roots = resolveHookRoots(repoB);
      expect(roots.localRoot).toBe(repoA); // pinned to the session repo
    } finally {
      process.chdir(prevCwd);
      if (prev === undefined) delete process.env['CLAUDE_PROJECT_DIR'];
      else process.env['CLAUDE_PROJECT_DIR'] = prev;
    }
  });

  it('STALE env anchor: cwd + payload agree on a DIFFERENT repo → hand over (round-18 P1)', () => {
    // A shell still exports repo A's CLAUDE_PROJECT_DIR but the process
    // is physically running in repo B (live sessions run hooks with
    // cwd = the project dir, so env/cwd disagreement means staleness).
    const repoA = path.join(scratch, 'stale-a');
    const repoB = path.join(scratch, 'stale-b');
    makeRepo(repoA);
    makeRepo(repoB);
    const prev = process.env['CLAUDE_PROJECT_DIR'];
    const prevCwd = process.cwd();
    process.env['CLAUDE_PROJECT_DIR'] = repoA;
    process.chdir(repoB);
    try {
      // With a payload naming repo B: B wins.
      expect(resolveHookRoots(repoB).localRoot).toBe(repoB);
      // With NO payload (direct CLI invocation): the physical cwd wins.
      expect(resolveHookRoots(undefined).localRoot).toBe(repoB);
      // …but a payload that matches the ENV repo proves the env anchor
      // is live after all — it wins the tie.
      expect(resolveHookRoots(repoA).localRoot).toBe(repoA);
    } finally {
      process.chdir(prevCwd);
      if (prev === undefined) delete process.env['CLAUDE_PROJECT_DIR'];
      else process.env['CLAUDE_PROJECT_DIR'] = prev;
    }
  });

  it('a SAME-repo worktree payload cwd still wins over the primary anchor', () => {
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const wt = path.join(scratch, 'wt-pin');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-pin-branch');
    const prev = process.env['CLAUDE_PROJECT_DIR'];
    process.env['CLAUDE_PROJECT_DIR'] = repo;
    try {
      const roots = resolveHookRoots(wt);
      expect(roots.localRoot).toBe(wt); // same commonRoot → worktree-local wins
      expect(roots.commonRoot).toBe(repo);
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_PROJECT_DIR'];
      else process.env['CLAUDE_PROJECT_DIR'] = prev;
    }
  });

  it('SAME-repo payload worktree wins over ANY same-repo anchor (round-19 P1)', () => {
    // Supersedes the round-9 sibling pin: relative paths resolve
    // against the worktree the command physically runs in, so the
    // payload worktree must carry enforcement; the anchor worktree's
    // own governed state stays protected via sibling cross-root
    // coverage in the scanners.
    const repo = path.join(scratch, 'repo');
    makeRepo(repo);
    const wtA = path.join(scratch, 'wt-anchor');
    const wtB = path.join(scratch, 'wt-sibling');
    git(repo, 'worktree', 'add', '-q', wtA, '-b', 'anchor-branch');
    git(repo, 'worktree', 'add', '-q', wtB, '-b', 'sibling-branch');
    const prev = process.env['CLAUDE_PROJECT_DIR'];
    process.env['CLAUDE_PROJECT_DIR'] = wtA; // session anchored IN worktree A
    try {
      const roots = resolveHookRoots(wtB); // payload names sibling B
      expect(roots.localRoot).toBe(wtB); // payload worktree carries enforcement
      expect(roots.commonRoot).toBe(repo);
      // …and a PRIMARY-checkout anchor hands over identically (the
      // Claude worktree-session shape):
      process.env['CLAUDE_PROJECT_DIR'] = repo;
      const roots2 = resolveHookRoots(wtB);
      expect(roots2.localRoot).toBe(wtB);
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_PROJECT_DIR'];
      else process.env['CLAUDE_PROJECT_DIR'] = prev;
    }
  });

  it('explicitRoot in a plain temp dir behaves exactly like today (degenerate)', () => {
    const dir = path.join(scratch, 'tmp-seam');
    fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
    const roots = resolveHookRoots(undefined, dir);
    expect(roots).toEqual({ localRoot: dir, commonRoot: dir, isLinkedWorktree: false });
  });
});
