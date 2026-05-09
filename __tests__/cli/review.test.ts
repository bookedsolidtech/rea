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
import { runReview, type ReviewOutcome } from '../../src/cli/review.js';
import { computeTreeToken } from '../../src/audit/content-token.js';
import type { Finding } from '../../src/hooks/push-gate/findings.js';

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
  deps?: Parameters<typeof runReview>[1],
): Promise<{ exitCode: number | null; io: CapturedIo }> {
  let exitCode: number | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__${exitCode}`);
  }) as never);
  const io = captureIo();
  try {
    await runReview(options, deps);
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

// ───────────────────────────────────────────────────────────────────────────
// 0.28.1 defect-V — `rea review` must surface findings, not just counts.
//
// Pre-fix `executeCodexReview` returned `{verdict, findingCount, ...}` and
// dropped the structured findings + reviewText on the floor. `runReview`
// never wrote `.rea/last-review.json`, only the push-gate did. Net effect:
// agents could not remediate blocking verdicts because findings were
// unreadable through any documented surface.
// ───────────────────────────────────────────────────────────────────────────

async function withCodexAvailable<T>(fn: (sandboxPath: string) => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-review-fakecodex-'));
  const codexPath = path.join(sandboxPath, 'codex');
  await fs.writeFile(codexPath, '#!/bin/sh\necho "codex 0.0.0-fake"\n', { mode: 0o755 });
  process.env.PATH = sandboxPath;
  try {
    return await fn(sandboxPath);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(sandboxPath, { recursive: true, force: true });
  }
}

function makeFakeOutcome(overrides: Partial<ReviewOutcome> = {}): ReviewOutcome {
  const base: ReviewOutcome = {
    verdict: 'pass',
    findingCount: 0,
    baseRef: 'origin/main',
    headSha: 'a'.repeat(40),
    contentToken: 'b'.repeat(40),
    durationSeconds: 1.23,
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    findings: [],
    reviewText: '',
    eventCount: 0,
  };
  return { ...base, ...overrides };
}

const SAMPLE_FINDINGS: Finding[] = [
  {
    severity: 'P1',
    title: 'unsafe shell exec',
    file: 'src/exec.ts',
    line: 42,
    body: '- [P1] unsafe shell exec — src/exec.ts:42\n  detail line about the issue',
  },
  {
    severity: 'P2',
    title: 'missing null guard',
    file: 'src/util.ts',
    line: 17,
    body: '- [P2] missing null guard — src/util.ts:17',
  },
  {
    severity: 'P3',
    title: 'consider rename',
    body: '- [P3] consider rename',
  },
];

describe('runReview — 0.28.1 defect-V finding-text surface', () => {
  let dir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await setupRepo();
    previousCwd = process.cwd();
    process.chdir(dir);
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_HEADER);
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('writes .rea/last-review.json on every successful verdict', () => {
    const cases: Array<{
      verdict: ReviewOutcome['verdict'];
      findings: Finding[];
      expectedExit: number;
    }> = [
      { verdict: 'pass', findings: [], expectedExit: 0 },
      { verdict: 'concerns', findings: [SAMPLE_FINDINGS[1]!], expectedExit: 0 },
      { verdict: 'blocking', findings: SAMPLE_FINDINGS, expectedExit: 2 },
    ];
    for (const { verdict, findings, expectedExit } of cases) {
      it(`verdict=${verdict} → last-review.json present, findings ${findings.length}`, async () => {
        const outcome = makeFakeOutcome({
          verdict,
          findings,
          findingCount: findings.length,
          reviewText: findings.map((f) => f.body).join('\n\n'),
          eventCount: findings.length + 1,
        });
        const { exitCode } = await withCodexAvailable(() =>
          runReviewCapturingExit(
            {},
            { executeCodexReview: async () => outcome },
          ),
        );
        expect(exitCode).toBe(expectedExit);
        const lastReviewPath = path.join(dir, '.rea', 'last-review.json');
        const raw = await fs.readFile(lastReviewPath, 'utf8');
        const payload = JSON.parse(raw) as {
          schema_version: number;
          verdict: string;
          findings: Finding[];
          finding_count: number;
          review_text: string;
        };
        expect(payload.schema_version).toBe(1);
        expect(payload.verdict).toBe(verdict);
        expect(payload.finding_count).toBe(findings.length);
        expect(payload.findings).toHaveLength(findings.length);
        for (let i = 0; i < findings.length; i += 1) {
          expect(payload.findings[i]?.severity).toBe(findings[i]?.severity);
          expect(payload.findings[i]?.title).toBe(findings[i]?.title);
        }
      });
    }

    it('overwrites a stale snapshot from a previous run (Ava-reported staleness)', async () => {
      const lastReviewPath = path.join(dir, '.rea', 'last-review.json');
      const stalePayload = {
        schema_version: 1,
        generated_at: '2026-05-08T00:00:00.000Z',
        verdict: 'blocking',
        base_ref: 'origin/main',
        head_sha: 'STALEHEADFROMYESTERDAY' + '0'.repeat(18),
        finding_count: 99,
        findings: [{ severity: 'P1', title: 'stale finding', body: 'STALE BODY' }],
        review_text: 'STALE REVIEW TEXT',
        event_count: 0,
        duration_seconds: 0,
      };
      await fs.writeFile(lastReviewPath, JSON.stringify(stalePayload, null, 2));

      const outcome = makeFakeOutcome({
        verdict: 'pass',
        findings: [],
        findingCount: 0,
        reviewText: 'fresh review',
        headSha: 'f'.repeat(40),
      });
      const { exitCode } = await withCodexAvailable(() =>
        runReviewCapturingExit(
          {},
          { executeCodexReview: async () => outcome },
        ),
      );
      expect(exitCode).toBe(0);
      const raw = await fs.readFile(lastReviewPath, 'utf8');
      const payload = JSON.parse(raw) as { head_sha: string; review_text: string };
      expect(payload.head_sha).not.toMatch(/STALE/);
      expect(payload.head_sha).toBe('f'.repeat(40));
      expect(payload.review_text).not.toMatch(/STALE/);
      expect(payload.review_text).toBe('fresh review');
    });
  });

  describe('--with-findings', () => {
    it('prints findings grouped by severity (P1 → P2 → P3) to stdout', async () => {
      const outcome = makeFakeOutcome({
        verdict: 'blocking',
        findings: SAMPLE_FINDINGS,
        findingCount: SAMPLE_FINDINGS.length,
      });
      const { exitCode, io } = await withCodexAvailable(() =>
        runReviewCapturingExit(
          { withFindings: true },
          { executeCodexReview: async () => outcome },
        ),
      );
      expect(exitCode).toBe(2);
      expect(io.stdout).toMatch(/local review: blocking/);
      expect(io.stdout).toMatch(/\[P1\] unsafe shell exec — src\/exec\.ts:42/);
      expect(io.stdout).toMatch(/\[P2\] missing null guard — src\/util\.ts:17/);
      expect(io.stdout).toMatch(/\[P3\] consider rename/);
      const p1Idx = io.stdout.indexOf('[P1]');
      const p2Idx = io.stdout.indexOf('[P2]');
      const p3Idx = io.stdout.indexOf('[P3]');
      expect(p1Idx).toBeGreaterThan(0);
      expect(p1Idx).toBeLessThan(p2Idx);
      expect(p2Idx).toBeLessThan(p3Idx);
      expect(io.stdout).toMatch(/last-review\.json/);
    });

    it('default (no --with-findings) emits single summary line — back-compat regression', async () => {
      const outcome = makeFakeOutcome({
        verdict: 'concerns',
        findings: [SAMPLE_FINDINGS[1]!],
        findingCount: 1,
      });
      const { exitCode, io } = await withCodexAvailable(() =>
        runReviewCapturingExit(
          {},
          { executeCodexReview: async () => outcome },
        ),
      );
      expect(exitCode).toBe(0);
      expect(io.stdout).toMatch(/local review: concerns/);
      expect(io.stdout).not.toMatch(/\[P2\] missing null guard/);
    });
  });

  describe('--json', () => {
    it('emits last_review_path always (even without --with-findings)', async () => {
      const outcome = makeFakeOutcome({
        verdict: 'concerns',
        findings: [SAMPLE_FINDINGS[1]!],
        findingCount: 1,
      });
      const { io } = await withCodexAvailable(() =>
        runReviewCapturingExit(
          { json: true },
          { executeCodexReview: async () => outcome },
        ),
      );
      const line = io.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '';
      const payload = JSON.parse(line) as Record<string, unknown>;
      expect(payload.status).toBe('concerns');
      expect(payload.finding_count).toBe(1);
      expect(payload.head_sha).toBeDefined();
      expect(payload.base_ref).toBe('origin/main');
      expect(payload.provider).toBe('codex');
      expect(payload.model).toBe('gpt-5.4');
      expect(payload.reasoning_effort).toBe('high');
      expect(payload.duration_seconds).toBeDefined();
      expect(payload.exit_code).toBe(0);
      expect(payload.last_review_path).toBe('.rea/last-review.json');
      expect(payload.findings).toBeUndefined();
    });

    it('--json --with-findings includes findings array', async () => {
      const outcome = makeFakeOutcome({
        verdict: 'blocking',
        findings: SAMPLE_FINDINGS,
        findingCount: SAMPLE_FINDINGS.length,
      });
      const { io } = await withCodexAvailable(() =>
        runReviewCapturingExit(
          { json: true, withFindings: true },
          { executeCodexReview: async () => outcome },
        ),
      );
      const line = io.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '';
      const payload = JSON.parse(line) as { findings?: Finding[] };
      expect(Array.isArray(payload.findings)).toBe(true);
      expect(payload.findings).toHaveLength(SAMPLE_FINDINGS.length);
      expect(payload.findings?.[0]?.severity).toBe('P1');
      expect(payload.findings?.[0]?.file).toBe('src/exec.ts');
      expect(payload.findings?.[0]?.line).toBe(42);
    });
  });

  describe('does not write last-review.json on skipped/error paths', () => {
    it('codex unavailable + mode:off → no last-review.json', async () => {
      await fs.writeFile(
        path.join(dir, '.rea', 'policy.yaml'),
        POLICY_HEADER + 'review:\n  local_review:\n    mode: off\n',
      );
      const lastReviewPath = path.join(dir, '.rea', 'last-review.json');
      await expect(fs.access(lastReviewPath)).rejects.toThrow();
      const { exitCode } = await withCodexUnavailable(() => runReviewCapturingExit({}));
      expect(exitCode).toBe(0);
      await expect(fs.access(lastReviewPath)).rejects.toThrow();
    });

    it('codex throws (executor error) → no last-review.json', async () => {
      const lastReviewPath = path.join(dir, '.rea', 'last-review.json');
      await expect(fs.access(lastReviewPath)).rejects.toThrow();
      const { exitCode } = await withCodexAvailable(() =>
        runReviewCapturingExit(
          {},
          {
            executeCodexReview: async () => {
              throw new Error('synthetic codex failure');
            },
          },
        ),
      );
      expect(exitCode).toBe(2);
      await expect(fs.access(lastReviewPath)).rejects.toThrow();
    });
  });

  // ── round-1 P2-1 + P2-2: writeLastReview-failure surface ─────────────────
  describe('writeLastReview failure path (round-1 P2 fixes)', () => {
    /**
     * Inject a writer failure by patching the function temporarily. The
     * cleanest seam is dynamic-import-replace, but for this narrow test
     * we simulate it by making `.rea/` read-only — `writeLastReview`
     * fails inside `fs.openSync` on the tmp file. macOS honours chmod 0o500
     * for non-root users.
     */
    async function withReadOnlyReaDir<T>(fn: () => Promise<T>): Promise<T> {
      const reaDir = path.join(dir, '.rea');
      const originalMode = (await fs.stat(reaDir)).mode & 0o777;
      // Read+execute only — writer cannot create the .tmp file.
      await fs.chmod(reaDir, 0o500);
      try {
        return await fn();
      } finally {
        await fs.chmod(reaDir, originalMode);
      }
    }

    it('JSON: last_review_path is null + last_review_error: write_failed when write fails', async () => {
      const outcome = makeFakeOutcome({
        verdict: 'concerns',
        findings: [SAMPLE_FINDINGS[1]!],
        findingCount: 1,
      });
      const { io } = await withCodexAvailable(() =>
        withReadOnlyReaDir(() =>
          runReviewCapturingExit(
            { json: true },
            { executeCodexReview: async () => outcome },
          ),
        ),
      );
      const line = io.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '';
      const payload = JSON.parse(line) as Record<string, unknown>;
      expect(payload.last_review_path).toBeNull();
      expect(payload.last_review_error).toBe('write_failed');
      // stderr surfaces the underlying error so operators can correlate.
      expect(io.stderr).toMatch(/last-review\.json write failed/);
    });

    it('--json --with-findings: findings are redacted when writer fails', async () => {
      // Synthetic AWS-shape access key, assembled from constants so naive
      // grep scanners see "AKIA" + a separate string. This is the round-1
      // P2-1 contract: writer-failure must NOT leak unredacted secrets to
      // the new stdout/JSON surface.
      const FAKE_KEY = 'AKIA' + 'EXAMPLEFAKE12345';
      const leaked: Finding = {
        severity: 'P1',
        title: 'leaked key in body',
        body: `secret in body: ${FAKE_KEY}`,
      };
      const outcome = makeFakeOutcome({
        verdict: 'blocking',
        findings: [leaked],
        findingCount: 1,
        reviewText: `body had ${FAKE_KEY}`,
      });
      const { io } = await withCodexAvailable(() =>
        withReadOnlyReaDir(() =>
          runReviewCapturingExit(
            { json: true, withFindings: true },
            { executeCodexReview: async () => outcome },
          ),
        ),
      );
      const line = io.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '';
      // Literal key MUST NOT appear in the JSON output, even though the
      // file write failed and we fell back to in-memory findings.
      expect(line).not.toContain(FAKE_KEY);
      expect(line).toMatch(/REDACTED/);
    });

    it('--with-findings stdout: findings are redacted when writer fails', async () => {
      const FAKE_KEY = 'AKIA' + 'EXAMPLEFAKE12345';
      const leaked: Finding = {
        severity: 'P1',
        title: 'leaked key in body',
        body: `secret in body: ${FAKE_KEY}`,
      };
      const outcome = makeFakeOutcome({
        verdict: 'blocking',
        findings: [leaked],
        findingCount: 1,
      });
      const { io } = await withCodexAvailable(() =>
        withReadOnlyReaDir(() =>
          runReviewCapturingExit(
            { withFindings: true },
            { executeCodexReview: async () => outcome },
          ),
        ),
      );
      // Stdout must not contain the literal key. (Title doesn't carry it
      // in this fixture; we just verify the contract holds end-to-end.)
      expect(io.stdout).not.toContain(FAKE_KEY);
      // The writer-failure stderr signal is still emitted.
      expect(io.stderr).toMatch(/last-review\.json write failed/);
    });

    it('--with-findings stdout: does NOT point at last-review.json when writer failed (round-2 P2)', async () => {
      // Round-2 P2: the human-readable banner used to read
      //   "findings (see .rea/last-review.json for full bodies):"
      // unconditionally. If the writer failed (read-only fs, race),
      // following that pointer would either ENOENT or read a stale
      // snapshot from days ago. Banner must signal the failure mode.
      const outcome = makeFakeOutcome({
        verdict: 'blocking',
        findings: SAMPLE_FINDINGS,
        findingCount: SAMPLE_FINDINGS.length,
      });
      const { io } = await withCodexAvailable(() =>
        withReadOnlyReaDir(() =>
          runReviewCapturingExit(
            { withFindings: true },
            { executeCodexReview: async () => outcome },
          ),
        ),
      );
      // Banner does NOT use the success-path "see <path> for full bodies"
      // pointer (which would direct a human to a stale/missing file).
      expect(io.stdout).not.toMatch(/see \.rea\/last-review\.json for full bodies/);
      // Banner explicitly names the failure so consumers don't go reading
      // a stale snapshot.
      expect(io.stdout).toMatch(/last-review\.json write FAILED/);
      // Findings are still rendered inline so the surface remains usable.
      expect(io.stdout).toMatch(/\[P1\] unsafe shell exec/);
    });

    it('--with-findings stdout: prints finding bodies inline when writer failed (round-3 P2)', async () => {
      // Round-3 P2: the failure-mode banner promised "bodies shown
      // inline below" but the renderer only printed title + location.
      // With no on-disk surface to fall back to, the body is the
      // remediation content; it must appear inline in the failure mode.
      const distinctiveBody = 'distinctive-round3-body-line-must-show-up-somewhere';
      const outcome = makeFakeOutcome({
        verdict: 'blocking',
        findings: [
          {
            severity: 'P1',
            title: 'distinctive title',
            file: 'src/foo.ts',
            line: 7,
            body: `- [P1] distinctive title — src/foo.ts:7\n  ${distinctiveBody}`,
          },
        ],
        findingCount: 1,
      });
      const { io } = await withCodexAvailable(() =>
        withReadOnlyReaDir(() =>
          runReviewCapturingExit(
            { withFindings: true },
            { executeCodexReview: async () => outcome },
          ),
        ),
      );
      expect(io.stdout).toMatch(/last-review\.json write FAILED/);
      expect(io.stdout).toMatch(/\[P1\] distinctive title/);
      // The body line MUST appear inline because there is no on-disk
      // surface for the agent to read.
      expect(io.stdout).toContain(distinctiveBody);
    });

    it('--with-findings stdout: success path does NOT print bodies inline (regression)', async () => {
      // Counterpart: on the writer-success path, bodies stay in
      // last-review.json. Stdout stays scannable for humans triaging a
      // long list of findings; the banner already names the file.
      const distinctiveBody = 'distinctive-success-body-MUST-NOT-show-on-stdout';
      const outcome = makeFakeOutcome({
        verdict: 'blocking',
        findings: [
          {
            severity: 'P1',
            title: 'distinctive title',
            file: 'src/foo.ts',
            line: 7,
            body: `- [P1] distinctive title — src/foo.ts:7\n  ${distinctiveBody}`,
          },
        ],
        findingCount: 1,
      });
      const { io } = await withCodexAvailable(() =>
        runReviewCapturingExit(
          { withFindings: true },
          { executeCodexReview: async () => outcome },
        ),
      );
      expect(io.stdout).toMatch(/\[P1\] distinctive title/);
      expect(io.stdout).not.toContain(distinctiveBody);
      expect(io.stdout).toMatch(/see \.rea\/last-review\.json for full bodies/);
    });

    it('--with-findings stdout: DOES point at last-review.json on writer success (round-2 regression)', async () => {
      // Counterpart to the round-2 P2 test above — the success path must
      // still emit the original "see <path>" pointer so the documented
      // remediation surface is discoverable in the common case.
      const outcome = makeFakeOutcome({
        verdict: 'blocking',
        findings: SAMPLE_FINDINGS,
        findingCount: SAMPLE_FINDINGS.length,
      });
      const { io } = await withCodexAvailable(() =>
        runReviewCapturingExit(
          { withFindings: true },
          { executeCodexReview: async () => outcome },
        ),
      );
      expect(io.stdout).toMatch(/see \.rea\/last-review\.json for full bodies/);
      expect(io.stdout).not.toMatch(/last-review\.json write FAILED/);
    });
  });

  it('runs secret redaction on findings written to last-review.json', async () => {
    // Synthetic AWS-shape access key (AKIA + 16 base32 chars). Matches the
    // `AWS Access Key` pattern in src/gateway/middleware/redact.ts. The
    // contract: literal secret never reaches disk via this writer. Push-gate
    // covers the same writer with its own test (report.test.ts) — this test
    // pins that the rea-review path goes through the SAME writer rather than
    // an inline copy that could drift.
    //
    // Constructed from constants so naive grep scanners see "AKIA" and a
    // separate string, not a single literal.
    const FAKE_KEY = 'AKIA' + 'EXAMPLEFAKE12345';
    const leakedFinding: Finding = {
      severity: 'P1',
      title: 'do not leak the key',
      file: 'src/auth.ts',
      line: 9,
      body: `body containing ${FAKE_KEY} inline`,
    };
    const outcome = makeFakeOutcome({
      verdict: 'blocking',
      findings: [leakedFinding],
      findingCount: 1,
      reviewText: `reviewer noticed ${FAKE_KEY} in auth.ts`,
    });
    await withCodexAvailable(() =>
      runReviewCapturingExit(
        {},
        { executeCodexReview: async () => outcome },
      ),
    );
    const raw = await fs.readFile(path.join(dir, '.rea', 'last-review.json'), 'utf8');
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).toMatch(/REDACTED/);
  });
});
