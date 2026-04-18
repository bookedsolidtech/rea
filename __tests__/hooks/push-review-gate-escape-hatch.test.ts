/**
 * Integration tests for the push-review-gate.sh escape hatch
 * (REA_SKIP_CODEX_REVIEW).
 *
 * These tests drive the real shell hook from a subprocess, against a scratch
 * git repo containing a protected-path diff (so the Codex-review gate fires).
 * We assert:
 *
 *   1. The hook exits 0 when REA_SKIP_CODEX_REVIEW is set.
 *   2. A record with tool_name="codex.review.skipped" is appended to
 *      .rea/audit.jsonl carrying the operator's reason, actor, head_sha,
 *      and target branch.
 *   3. The same audit record does NOT satisfy the `codex.review`
 *      jq predicate used by the hook — a skip is not a review.
 *
 * Fail-closed paths (missing dist/, missing git identity) are covered too.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');
const DIST_AUDIT_PATH = path.join(REPO_ROOT, 'dist', 'audit', 'append.js');

/** Canonical stdin payload that the PreToolUse wrapper would deliver. */
function toolInput(command: string): string {
  return JSON.stringify({ tool_input: { command } });
}

interface ScratchRepo {
  dir: string;
  headSha: string;
  mergeBaseSha: string;
}

/**
 * Create a scratch repo with one commit on `main`, then a second commit on
 * a feature branch that touches a protected path (`hooks/__test__.sh`).
 * The hook's protected-path regex matches `hooks/` so this guarantees the
 * Codex-review branch fires.
 *
 * Returns the repo dir, the feature-branch HEAD SHA, and the main SHA we
 * expect to be the merge-base.
 */
async function makeScratchRepo(opts: {
  userEmail?: string | null;
  userName?: string | null;
  linkDist?: boolean;
}): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-push-gate-test-')),
  );

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '--initial-branch=main', '--quiet');

  // Identity. CI runners have no global user.email/user.name, so we always
  // set a baseline identity for the initial commits — otherwise `git commit`
  // aborts with "Author identity unknown". The caller-requested identity
  // state (including `null` = missing) is applied AFTER the baseline commits
  // so the hook-under-test reads the intended value via `git config`.
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'REA Test');
  git('config', 'commit.gpgsign', 'false');

  // Commit 1: baseline on `main` — this is the merge-base.
  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n');
  git('add', 'README.md');
  git('commit', '-m', 'baseline', '--quiet');
  const mergeBaseSha = git('rev-parse', 'HEAD');

  // Commit 2: on a feature branch, modify a protected path. Keeping `main`
  // at the baseline ensures the hook sees a real diff from feature → main.
  git('checkout', '-b', 'feature', '--quiet');
  await fs.mkdir(path.join(dir, 'hooks'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'hooks', '__test__.sh'),
    '#!/bin/bash\necho scratch\n',
  );
  git('add', 'hooks/__test__.sh');
  git('commit', '-m', 'touch protected path', '--quiet');
  const headSha = git('rev-parse', 'HEAD');

  // Apply the caller's identity state AFTER both commits. `null` means the
  // test wants the hook to see a missing identity (fail-closed path);
  // `undefined` means leave the baseline identity in place.
  if (opts.userEmail === null) {
    spawnSync('git', ['config', '--unset', 'user.email'], { cwd: dir });
  } else if (opts.userEmail !== undefined) {
    git('config', 'user.email', opts.userEmail);
  }
  if (opts.userName === null) {
    spawnSync('git', ['config', '--unset', 'user.name'], { cwd: dir });
  } else if (opts.userName !== undefined) {
    git('config', 'user.name', opts.userName);
  }

  // Stage dist/ so the audit helper is reachable at $REA_ROOT/dist/audit/append.js
  if (opts.linkDist !== false) {
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'audit'),
      path.join(dir, 'dist', 'audit'),
    );
  }

  return { dir, headSha, mergeBaseSha };
}

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(
  repo: ScratchRepo,
  env: NodeJS.ProcessEnv,
  // Default: push the `feature` branch to `main`. The hook parses this argv
  // form, resolves `feature^{commit}`, and diffs against merge-base(main,
  // feature) — which is the baseline commit — so it sees the protected-path
  // change.
  command = 'git push origin feature:main',
): HookResult {
  const res = spawnSync('bash', [HOOK_PATH], {
    cwd: repo.dir,
    env: { ...env, CLAUDE_PROJECT_DIR: repo.dir },
    input: toolInput(command),
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

async function readAuditLines(
  repoDir: string,
): Promise<Array<Record<string, unknown>>> {
  const file = path.join(repoDir, '.rea', 'audit.jsonl');
  const raw = await fs.readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function jqExists(): boolean {
  const res = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

describe('push-review-gate.sh — REA_SKIP_CODEX_REVIEW escape hatch', () => {
  let dists: string[] = [];

  beforeEach(() => {
    dists = [];
  });

  afterEach(async () => {
    await Promise.all(
      dists.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('requires dist/audit/append.js to exist (fail-closed)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({ linkDist: false });
    dists.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'ci-test',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/escape hatch requires rea to be built/);
  });

  it('requires a git identity (fail-closed)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: null,
      userName: null,
    });
    dists.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'ci-test',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/escape hatch requires a git identity/);
  });

  it('allows the push and writes a tool_name=codex.review.skipped audit record', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'skipper@example.test',
      userName: 'Skipper',
    });
    dists.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'codex-rate-limited-ci-burst',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(0);
    // Loud stderr banner is visible.
    expect(res.stderr).toMatch(/CODEX REVIEW SKIPPED/);
    expect(res.stderr).toContain('codex-rate-limited-ci-burst');
    expect(res.stderr).toContain('skipper@example.test');
    expect(res.stderr).toContain(repo.headSha);
    expect(res.stderr).toMatch(/gate weakening/);

    // Audit record structure.
    const lines = await readAuditLines(repo.dir);
    const skipRecords = lines.filter(
      (r) => r['tool_name'] === 'codex.review.skipped',
    );
    expect(skipRecords).toHaveLength(1);
    const rec = skipRecords[0]!;
    expect(rec['server_name']).toBe('rea.escape_hatch');
    expect(rec['status']).toBe('allowed');
    expect(rec['tier']).toBe('read');

    const meta = rec['metadata'] as Record<string, unknown>;
    expect(meta['head_sha']).toBe(repo.headSha);
    expect(meta['reason']).toBe('codex-rate-limited-ci-burst');
    expect(meta['actor']).toBe('skipper@example.test');
    expect(meta['verdict']).toBe('skipped');
    expect(typeof meta['files_changed']).toBe('number');
    expect(meta['files_changed']).toBeGreaterThan(0);
  });

  it('reason is literally the env-var value (no default)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    dists.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: '1',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(0);
    const lines = await readAuditLines(repo.dir);
    const meta = (
      lines.find((r) => r['tool_name'] === 'codex.review.skipped')!
        .metadata as Record<string, unknown>
    );
    // Design intent: the value IS the reason. No default reason is supplied.
    expect(meta['reason']).toBe('1');
  });

  it('skip record does NOT satisfy the hook jq predicate for codex.review', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    dists.push(repo.dir);

    // Invoke escape hatch.
    runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'testing',
      PATH: process.env.PATH ?? '',
    });

    // Run the EXACT jq predicate the hook uses at the top of the Codex-OK
    // check. If a skip record satisfied this, the escape hatch would forge
    // past a future Codex-review requirement. It must NOT.
    const auditFile = path.join(repo.dir, '.rea', 'audit.jsonl');
    const jqScript = `
        select(
          .tool_name == "codex.review"
          and .metadata.head_sha == $sha
          and (.metadata.verdict == "pass" or .metadata.verdict == "concerns")
        )
      `;
    const res = spawnSync(
      'jq',
      ['-e', '--arg', 'sha', repo.headSha, jqScript, auditFile],
      { encoding: 'utf8' },
    );
    // jq -e exits non-zero when no match. Treat missing jq as test skip (we
    // already bailed above for that case, but be safe).
    expect(res.status).not.toBe(0);
  });

  it('leaves the gate alone when REA_SKIP_CODEX_REVIEW is unset', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    dists.push(repo.dir);

    const res = runHook(repo, {
      PATH: process.env.PATH ?? '',
    });

    // Protected path + no Codex audit entry + no escape hatch → exit 2.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);

    // No skip record was written.
    const auditFile = path.join(repo.dir, '.rea', 'audit.jsonl');
    const exists = await fs
      .access(auditFile)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const lines = await readAuditLines(repo.dir);
      expect(
        lines.some((r) => r['tool_name'] === 'codex.review.skipped'),
      ).toBe(false);
    }
  });

  it('leaves the gate alone when REA_SKIP_CODEX_REVIEW is set to empty string', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    dists.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: '',
      PATH: process.env.PATH ?? '',
    });

    // Empty = not set. Gate must fire normally.
    expect(res.status).toBe(2);
    expect(res.stderr).not.toMatch(/CODEX REVIEW SKIPPED/);
  });
});

describe('dist/audit/append.js presence (sanity)', () => {
  it('is built — tests will only be meaningful when the dist exists', async () => {
    // If this fails, the test suite below cannot exercise the happy path.
    // We keep it here as an explicit signal rather than silently skipping.
    const exists = await fs
      .access(DIST_AUDIT_PATH)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });
});
