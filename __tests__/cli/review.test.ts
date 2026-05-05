/**
 * Tests for `rea review` (0.26.0) — narrow surface verifications.
 *
 * The end-to-end `rea review` flow shells to codex, which is hard to fake
 * in a unit test without bringing the whole codex-runner dependency
 * injection mechanism into the CLI. Instead these tests verify the
 * BRANCHING — when codex is missing, behavior depends on the
 * `policy.review.local_review.mode` setting.
 *
 * The codex-available codepath is exercised by the existing
 * `codex-runner.test.ts` (against `runCodexReview` directly) and
 * end-to-end smoke is left to the manual upgrade-and-push test plan
 * in docs/migration/0.26.0.md.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReview } from '../../src/cli/review.js';
import { computeTreeToken } from '../../src/audit/content-token.js';

const POLICY_HEADER = `version: "1"
profile: "test"
installed_by: "test@1.0.0"
installed_at: "2026-05-04T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
notification_channel: ""
`;

interface CapturedIo {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureIo(): CapturedIo {
  const captured = { stdout: '', stderr: '' };
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stdout += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stderr += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    captured.stdout += args.map(String).join(' ') + '\n';
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    captured.stderr += args.map(String).join(' ') + '\n';
  });
  return {
    get stdout() {
      return captured.stdout;
    },
    get stderr() {
      return captured.stderr;
    },
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  } as CapturedIo;
}

async function runReviewCapturingExit(
  options: Parameters<typeof runReview>[0],
): Promise<{ exitCode: number | null; io: CapturedIo }> {
  let exitCode: number | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__${exitCode}`);
  }) as never);
  const io = captureIo();
  try {
    await runReview(options);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
  } finally {
    exitSpy.mockRestore();
  }
  return { exitCode, io };
}

async function setupRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-review-cli-')));
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
  return dir;
}

/**
 * Run a callback with PATH stripped of codex so the availability probe
 * fails. Restores PATH after.
 */
async function withCodexUnavailable<T>(fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  // Sandbox PATH to a directory that has no codex binary.
  const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-review-nocodex-'));
  process.env.PATH = sandboxPath;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(sandboxPath, { recursive: true, force: true });
  }
}

describe('runReview — codex unavailable + mode: off', () => {
  let dir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await setupRepo();
    previousCwd = process.cwd();
    process.chdir(dir);
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      POLICY_HEADER + 'review:\n  local_review:\n    mode: off\n',
    );
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exits 0 silently and writes a skipped_unavailable audit entry', async () => {
    const { exitCode } = await withCodexUnavailable(async () => {
      return runReviewCapturingExit({});
    });
    expect(exitCode).toBe(0);
    const audit = await fs.readFile(path.join(dir, '.rea', 'audit.jsonl'), 'utf8');
    expect(audit).toMatch(/rea\.local_review\.skipped_unavailable/);
    expect(audit).toMatch(/codex-not-installed/);
  });
});

describe('computeTreeToken — content fingerprinting (helix-026 finding-1)', () => {
  let dir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await setupRepo();
    previousCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns a 40-char hex tree SHA for a normal repo', () => {
    const token = computeTreeToken(dir);
    expect(token).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is deterministic across invocations on a quiescent tree', () => {
    const t1 = computeTreeToken(dir);
    const t2 = computeTreeToken(dir);
    expect(t1).toBe(t2);
    expect(t1.length).toBeGreaterThan(0);
  });

  it('is stable across a content-equivalent --amend (same tree → same token)', () => {
    const t1 = computeTreeToken(dir);
    // New message → new commit SHA. Same tree → same token.
    spawnSync(
      'git',
      ['commit', '--amend', '-m', 'init (amended)', '-q', '--no-gpg-sign'],
      { cwd: dir },
    );
    const t2 = computeTreeToken(dir);
    expect(t2).toBe(t1);
  });

  it('changes when content changes (different tree → different token)', async () => {
    const t1 = computeTreeToken(dir);
    await fs.writeFile(path.join(dir, 'NEW.md'), '# new\n');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'add new', '--no-gpg-sign'], { cwd: dir });
    const t2 = computeTreeToken(dir);
    expect(t2).not.toBe(t1);
    expect(t2).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns empty string on a non-git directory', async () => {
    const nonGitDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-content-token-nogit-')),
    );
    try {
      const token = computeTreeToken(nonGitDir);
      expect(token).toBe('');
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });
});

// ── 0.26.0 round-25 P1-A: working-tree token via `git stash create` ────────
//
// Pre-fix `computeTreeToken` returned `git rev-parse HEAD^{tree}` — the
// LAST COMMIT's tree. The documented happy path is
// `edit working tree → rea review → fix → commit → push`. After commit
// HEAD changes; preflight's token did not match the audit entry's token.
// The gate REFUSED the very flow it documents.
//
// Fix: compute the WORKING-TREE token using `git stash create` (which
// returns the SHA of a synthetic commit object whose tree is the
// working tree + index merged). Falls back to HEAD^{tree} when the
// working tree is clean (the trees are identical by definition).
describe('computeTreeToken — round-25 P1-A working-tree fingerprinting', () => {
  let dir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await setupRepo();
    previousCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('working tree dirty (modified tracked file) → token differs from HEAD^{tree}', async () => {
    // Capture HEAD^{tree} explicitly via raw git call.
    const headTreeRes = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(headTreeRes.status).toBe(0);
    const headTree = (headTreeRes.stdout ?? '').toString().trim();
    expect(headTree).toMatch(/^[0-9a-f]{40}$/);

    // Modify a tracked file (don't commit).
    await fs.writeFile(path.join(dir, 'README.md'), '# test\n\nmore content\n');

    const wtToken = computeTreeToken(dir);
    expect(wtToken).toMatch(/^[0-9a-f]{40}$/);
    // The dirty working-tree token MUST differ from HEAD^{tree}.
    expect(wtToken).not.toBe(headTree);
  });

  it('working tree clean → token equals HEAD^{tree}', () => {
    const headTreeRes = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: dir,
      encoding: 'utf8',
    });
    const headTree = (headTreeRes.stdout ?? '').toString().trim();
    const token = computeTreeToken(dir);
    expect(token).toBe(headTree);
  });

  it('happy path: dirty → review → commit (no further edits) → preflight token MATCHES', async () => {
    // Step 1: edit working tree.
    await fs.writeFile(path.join(dir, 'README.md'), '# test\n\nedit\n');
    // Step 2: capture token at "review time" (working tree dirty).
    const reviewToken = computeTreeToken(dir);
    expect(reviewToken).toMatch(/^[0-9a-f]{40}$/);
    // Step 3: stage + commit (no further edits).
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'edit', '--no-gpg-sign'], { cwd: dir });
    // Step 4: preflight time — working tree clean now.
    const preflightToken = computeTreeToken(dir);
    // The two tokens MUST match — content is identical.
    expect(preflightToken).toBe(reviewToken);
  });

  it('untracked-only changes → token equals HEAD^{tree} (documented limitation)', async () => {
    const headTreeRes = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: dir,
      encoding: 'utf8',
    });
    const headTree = (headTreeRes.stdout ?? '').toString().trim();
    // Untracked file — `git stash create` does NOT include it.
    await fs.writeFile(path.join(dir, 'UNTRACKED.md'), '# new\n');
    const token = computeTreeToken(dir);
    // Token reflects what would be pushed (which is HEAD's tree, since
    // untracked content cannot be pushed).
    expect(token).toBe(headTree);
  });

  it('empty repo (no HEAD) → returns empty string', async () => {
    const emptyDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-content-token-empty-')),
    );
    try {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: emptyDir });
      // No commits → no HEAD. `git stash create` should fail/empty,
      // `HEAD^{tree}` should fail. Token must be empty string.
      const token = computeTreeToken(emptyDir);
      expect(token).toBe('');
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});

// ── 0.26.0 round-25 P2-B: rea review on empty HEAD ─────────────────────────
//
// Pre-fix runReview() threw "could not resolve HEAD sha — is this a valid
// git repo?" on an unborn HEAD. Under refuse_at: commit/both this caused
// a bootstrap deadlock for create-helix-app-style scaffolding: the
// commit-tier hook refused commits without an audit entry, but rea
// review refused without HEAD.
//
// Fix: when HEAD is unborn, use git's empty-tree SHA as the synthetic
// head_sha for the audit record. computeTreeToken returns empty cleanly
// in this state (round-25 P1-A path); preflight's content-token match
// handles either case.
describe('runReview — round-25 P2-B empty repo bootstrap', () => {
  let dir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-review-empty-')));
    previousCwd = process.cwd();
    process.chdir(dir);
    // Init empty repo — no commits, unborn HEAD.
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    // Default policy (enforced) so the deadlock-prone path is exercised.
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_HEADER);
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exits cleanly without throwing on an unborn HEAD when codex is unavailable', async () => {
    // Use `mode: off` so the codex-not-installed path is the silent one
    // — we want to verify HEAD-resolution doesn't throw, not that
    // codex-enforcement triggers. The HEAD-unborn safety is independent
    // of codex availability.
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      POLICY_HEADER + 'review:\n  local_review:\n    mode: off\n',
    );
    const { exitCode } = await withCodexUnavailable(async () => {
      return runReviewCapturingExit({});
    });
    // mode:off + codex-unavailable → exit 0 + skipped audit. We are
    // verifying that the empty-HEAD path does NOT throw on the way
    // through.
    expect(exitCode).toBe(0);
    const audit = await fs.readFile(path.join(dir, '.rea', 'audit.jsonl'), 'utf8');
    expect(audit).toMatch(/rea\.local_review\.skipped_unavailable/);
  });
});

describe('runReview — codex unavailable + mode: enforced', () => {
  let dir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await setupRepo();
    previousCwd = process.cwd();
    process.chdir(dir);
    // Default policy (no local_review block) is enforced.
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_HEADER);
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exits 2 with helpful message when codex is missing', async () => {
    const { exitCode, io } = await withCodexUnavailable(async () => {
      return runReviewCapturingExit({});
    });
    expect(exitCode).toBe(2);
    expect(io.stderr).toMatch(/codex CLI not found/);
    expect(io.stderr).toMatch(/local_review/);
    expect(io.stderr).toMatch(/mode:\s*off/);
  });
});
