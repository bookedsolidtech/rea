/**
 * Integration tests for the push-review-gate.sh Codex waiver
 * (REA_SKIP_CODEX_REVIEW).
 *
 * #85 (0.8.0) narrows REA_SKIP_CODEX_REVIEW from a full-gate bypass to a
 * Codex-only waiver. The skip audit record is still written and the
 * protected-path Codex-audit requirement (section 7) is satisfied without
 * a real `tool_name=codex.review` audit entry, but every other gate still
 * runs — HALT, cross-repo guard, ref-resolution, push-review cache, and
 * the general review-required block in section 9.
 *
 * These tests drive the real shell hook from a subprocess, against a scratch
 * git repo containing a protected-path diff (so the Codex-review gate fires).
 * We assert:
 *
 *   1. With the waiver AND a valid push-review cache entry, the hook exits 0.
 *   2. A record with tool_name="codex.review.skipped" is appended to
 *      .rea/audit.jsonl carrying the operator's reason, actor, head_sha,
 *      and target branch, even on gate paths that exit 2 downstream.
 *   3. The same audit record does NOT satisfy the `codex.review`
 *      jq predicate used by the hook — a skip is not a review.
 *   4. The waiver does NOT bypass HALT or the push-review cache miss —
 *      those gates still block.
 *
 * Fail-closed paths (missing dist/, missing git identity) are covered too.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');
const DIST_AUDIT_PATH = path.join(REPO_ROOT, 'dist', 'audit', 'append.js');

// BUG-012 (0.6.2): hook anchors REA_ROOT via script-on-disk location.
// Install into `<repoDir>/.claude/hooks/` and invoke from there. Codex
// review blocker (2026-04-20): the anchor walk-up requires
// `.rea/policy.yaml` to mark the install root — simulate a completed
// `rea init` by seeding a minimal policy alongside the hook.
async function installPushHook(dir: string): Promise<string> {
  const destDir = path.join(dir, '.claude', 'hooks');
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, 'push-review-gate.sh');
  await fs.copyFile(HOOK_SRC, dest);
  await fs.chmod(dest, 0o755);
  // BUG-008 cleanup (0.7.0): adapter sources `_lib/push-review-core.sh` —
  // copy the core next to the adapter to mirror the installed topology.
  const libDir = path.join(destDir, '_lib');
  await fs.mkdir(libDir, { recursive: true });
  const coreSrc = path.join(REPO_ROOT, 'hooks', '_lib', 'push-review-core.sh');
  const coreDest = path.join(libDir, 'push-review-core.sh');
  await fs.copyFile(coreSrc, coreDest);
  await fs.chmod(coreDest, 0o755);
  const policyDir = path.join(dir, '.rea');
  await fs.mkdir(policyDir, { recursive: true });
  const policyPath = path.join(policyDir, 'policy.yaml');
  try {
    await fs.access(policyPath);
  } catch {
    await fs.writeFile(policyPath, 'profile: minimal\nautonomy_level: L1\n');
  }
  return dest;
}

function installedHookPath(dir: string): string {
  return path.join(dir, '.claude', 'hooks', 'push-review-gate.sh');
}

/** Canonical stdin payload that the PreToolUse wrapper would deliver. */
function toolInput(command: string): string {
  return JSON.stringify({ tool_input: { command } });
}

interface ScratchRepo {
  dir: string;
  headSha: string;
  mergeBaseSha: string;
  /**
   * Bare-remote path (`origin`). Tracked on the record so `afterEach` can
   * clean it up — it lives as a sibling of `dir` (not inside it), so
   * removing `dir` alone would leak a `<dir>.git` directory per test run.
   */
  bareRemote: string;
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

  // Add a bare origin and push main so `refs/remotes/origin/main` exists.
  // The gate's new-branch merge-base resolution anchors on remote-tracking
  // refs (to close the pusher-controlled-local-main bypass); a scratch
  // repo without origin/main fails-closed before any protected-path check
  // runs. See shared core `pr_core_run` new-branch branch for the anchor.
  const bareRemote = path.join(dir, '..', path.basename(dir) + '.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', bareRemote], {
    encoding: 'utf8',
  });
  git('remote', 'add', 'origin', bareRemote);
  git('push', 'origin', 'main', '--quiet');

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
  // and the CLI (needed by section 8's cache check) at dist/cli/index.js.
  // Without dist/cli, REA_CLI_ARGS stays empty and section 8 silently skips
  // the cache lookup — section 9 then blocks the push even with a valid
  // cache entry on disk. #85 test setups depend on the cache hit firing.
  if (opts.linkDist !== false) {
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'audit'),
      path.join(dir, 'dist', 'audit'),
    );
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'cli'),
      path.join(dir, 'dist', 'cli'),
    );
  }

  await installPushHook(dir);

  return { dir, headSha, mergeBaseSha, bareRemote };
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
  const res = spawnSync('bash', [installedHookPath(repo.dir)], {
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

/**
 * Compute the SHA-256 used as the push-review cache key. Must match exactly
 * what the hook computes: `git diff merge_base..source_sha`, with trailing
 * newlines stripped (bash's `$(...)` strips them), then hashed. The hook's
 * line is:
 *
 *   DIFF_FULL=$(git diff "${MERGE_BASE}..${SOURCE_SHA}")
 *   PUSH_SHA=$(printf '%s' "$DIFF_FULL" | shasum -a 256 | cut -d' ' -f1)
 *
 * So we replicate both the trim and the hash here.
 */
function computeDiffSha(repo: ScratchRepo): string {
  const raw = execFileSync(
    'git',
    ['diff', `${repo.mergeBaseSha}..${repo.headSha}`],
    { cwd: repo.dir, encoding: 'utf8' },
  );
  const stripped = raw.replace(/\n+$/, '');
  return createHash('sha256').update(stripped).digest('hex');
}

/**
 * Seed the push-review cache with a `pass` verdict for the scratch repo's
 * protected-path diff. Needed for #85 tests because the Codex waiver no
 * longer exit-0's the hook on its own — the general review-required gate
 * (section 9) will still fire on a cache miss.
 */
async function populatePushReviewCache(
  repo: ScratchRepo,
  opts: { branch?: string; base?: string; result?: 'pass' | 'fail' } = {},
): Promise<{ sha: string }> {
  const sha = computeDiffSha(repo);
  const entry = {
    sha,
    branch: opts.branch ?? 'feature',
    base: opts.base ?? 'main',
    result: opts.result ?? 'pass',
    recorded_at: new Date().toISOString(),
  };
  const cacheFile = path.join(repo.dir, '.rea', 'review-cache.jsonl');
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(entry) + '\n');
  return { sha };
}

describe('push-review-gate.sh — REA_SKIP_CODEX_REVIEW escape hatch', () => {
  let scratchPaths: string[] = [];

  beforeEach(() => {
    scratchPaths = [];
  });

  afterEach(async () => {
    await Promise.all(
      scratchPaths.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  function track(repo: ScratchRepo): void {
    scratchPaths.push(repo.dir);
    scratchPaths.push(repo.bareRemote);
  }

  it('requires dist/audit/append.js to exist (fail-closed)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({ linkDist: false });
    track(repo);

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
    track(repo);

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
    track(repo);

    // #85 (0.8.0): the waiver narrows to Codex-only. The push-review cache
    // must still have a `pass` entry for the general gate to allow the push.
    await populatePushReviewCache(repo);

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'codex-rate-limited-ci-burst',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(0);
    // Loud stderr banner is visible.
    expect(res.stderr).toMatch(/CODEX REVIEW WAIVER active/);
    expect(res.stderr).toContain('codex-rate-limited-ci-burst');
    expect(res.stderr).toContain('skipper@example.test');
    expect(res.stderr).toContain(repo.headSha);
    expect(res.stderr).toMatch(/gate weakening/);
    // The banner must spell out the narrower scope so the operator is not
    // misled into thinking this is a full-gate bypass.
    expect(res.stderr).toMatch(/REA_SKIP_PUSH_REVIEW/);

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
    // files_changed is intentionally null for skip records — section 5c
    // runs before ref-resolution (section 6), so there is no authoritative
    // push window to count against at the point of audit-append. Recording
    // a local proxy here would mislead auditors correlating skips to
    // actual pushed commits.
    expect(meta['files_changed']).toBeNull();
    // metadata_source documents whether head_sha/target came from the
    // pre-push stdin contract (authoritative) or a local HEAD fallback
    // (PreToolUse Bash-wrapper invocation — stdin carries tool_input JSON,
    // not refspec lines).
    expect(['prepush-stdin', 'local-fallback']).toContain(meta['metadata_source']);
  });

  it('reason is literally the env-var value (no default)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    track(repo);

    await populatePushReviewCache(repo);

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
    track(repo);

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
    track(repo);

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

  // #77 (0.7.0) wrote a skip audit record even when ref-resolution would
  // have blocked the push. #85 (0.8.0) narrows the waiver: section 5c still
  // runs BEFORE section 6's ref-resolution, so the skip audit is still
  // recorded (the operator's commitment to waive is durable), but the hook
  // now exits 2 instead of 0 when the push itself is unresolvable. The
  // operator gets the receipt AND the actual blocker.
  it('writes the skip audit even when ref-resolution would fail — but still blocks the push', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'stale@example.test',
      userName: 'Stale',
    });
    track(repo);

    // Build a pre-push stdin payload whose remote_sha is a plausibly-shaped
    // 40-hex that is NOT in the local object DB. Section 6 will exit 2
    // after section 5c has already written the skip audit.
    const BOGUS_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const prepushStdin = `refs/heads/feature ${repo.headSha} refs/heads/main ${BOGUS_SHA}\n`;

    const res = spawnSync('bash', [installedHookPath(repo.dir), 'origin'], {
      cwd: repo.dir,
      env: {
        REA_SKIP_CODEX_REVIEW: 'stale-checkout-unblock',
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: repo.dir,
      },
      input: prepushStdin,
      encoding: 'utf8',
    });

    // #85 semantic: ref-resolution still runs after the waiver fires.
    expect(res.status).toBe(2);
    // Waiver banner is still printed (section 5c runs BEFORE section 6).
    expect(res.stderr).toMatch(/CODEX REVIEW WAIVER active/);
    expect(res.stderr).toContain('stale-checkout-unblock');

    const lines = await readAuditLines(repo.dir);
    const skip = lines.find((r) => r['tool_name'] === 'codex.review.skipped');
    expect(skip).toBeDefined();
    const meta = skip!['metadata'] as Record<string, unknown>;
    expect(meta['reason']).toBe('stale-checkout-unblock');
    expect(meta['verdict']).toBe('skipped');

    // Finding #1 regression (preserved under #85): skip metadata must
    // describe the PUSH, not the checkout. head_sha must equal the
    // local_sha from the pre-push stdin, target must equal the remote_ref
    // minus `refs/heads/`, and metadata_source tags the parse path.
    expect(meta['head_sha']).toBe(repo.headSha);
    expect(meta['target']).toBe('main');
    expect(meta['metadata_source']).toBe('prepush-stdin');
    expect(meta['files_changed']).toBeNull();
  });

  it('Finding #1 regression: skip metadata reflects the pushed ref, not the checkout', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'hotfix@example.test',
      userName: 'Hotfix Operator',
    });
    track(repo);

    // Simulate `git push origin hotfix:release/2026-q2` from a `feature`
    // checkout. The checkout's HEAD is repo.headSha ("feature" branch), but
    // the pushed commit is a DIFFERENT SHA — we stand in a fake one that
    // wouldn't resolve locally (the whole point: the skip records what the
    // push claims, not what the working tree has).
    const PUSHED_SHA = 'cafebabecafebabecafebabecafebabecafebabe';
    const REMOTE_SHA = '1234567812345678123456781234567812345678';
    const prepushStdin = `refs/heads/hotfix ${PUSHED_SHA} refs/heads/release/2026-q2 ${REMOTE_SHA}\n`;

    const res = spawnSync('bash', [installedHookPath(repo.dir), 'origin'], {
      cwd: repo.dir,
      env: {
        REA_SKIP_CODEX_REVIEW: 'verified-by-other-channel',
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: repo.dir,
      },
      input: prepushStdin,
      encoding: 'utf8',
    });

    // #85: bogus local_sha is unresolvable → section 6 exits 2 AFTER 5c
    // writes the skip audit. The audit receipt is what this test asserts
    // on; the block itself is asserted by the test above.
    expect(res.status).toBe(2);

    const lines = await readAuditLines(repo.dir);
    const skip = lines.find((r) => r['tool_name'] === 'codex.review.skipped');
    expect(skip).toBeDefined();
    const meta = skip!['metadata'] as Record<string, unknown>;

    // The key assertion: head_sha is the LOCAL_SHA from pre-push stdin
    // (the "what is actually being pushed" SHA), NOT repo.headSha (the
    // working-tree HEAD, which would be misleading in a push-from-other-ref
    // scenario).
    expect(meta['head_sha']).toBe(PUSHED_SHA);
    expect(meta['head_sha']).not.toBe(repo.headSha);
    // target is the remote_ref with refs/heads/ stripped — so release/2026-q2
    // (not "main" and not the upstream of the current branch).
    expect(meta['target']).toBe('release/2026-q2');
    expect(meta['metadata_source']).toBe('prepush-stdin');
  });

  it('leaves the gate alone when REA_SKIP_CODEX_REVIEW is set to empty string', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    track(repo);

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: '',
      PATH: process.env.PATH ?? '',
    });

    // Empty = not set. Gate must fire normally.
    expect(res.status).toBe(2);
    expect(res.stderr).not.toMatch(/CODEX REVIEW WAIVER active/);
  });

  // #85 (0.8.0) — narrowing regression tests. The waiver must NOT bypass
  // any gate other than the protected-path Codex-audit requirement.

  it('#85: waiver does NOT bypass HALT', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'halted@example.test',
      userName: 'Halted',
    });
    track(repo);

    await populatePushReviewCache(repo);

    // Freeze the repo AFTER install so the hook encounters HALT at section 3.
    await fs.writeFile(
      path.join(repo.dir, '.rea', 'HALT'),
      'test: #85 regression — waiver must not bypass HALT\n',
    );

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'attempt-to-bypass-halt',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REA HALT:/);
    // HALT fires at section 3, BEFORE section 5c writes the skip audit.
    // No skip record should be present.
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

  it('#85: waiver does NOT bypass a push-review cache MISS (general gate still blocks)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'nocache@example.test',
      userName: 'NoCache',
    });
    track(repo);

    // Note: NO populatePushReviewCache() call — the cache is empty.
    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'waiver-without-cache',
      PATH: process.env.PATH ?? '',
    });

    // Waiver satisfies the Codex-audit requirement (section 7), but the
    // general review-required gate (section 9) still blocks on the cache
    // miss.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/PUSH REVIEW GATE: Review required/);
    // The protected-path "codex-review required" banner must NOT appear —
    // that's the gate the waiver does satisfy.
    expect(res.stderr).not.toMatch(/protected paths changed/);

    // Skip audit IS written (section 5c ran) — the operator's commitment
    // to waive is recorded even when the push is blocked downstream.
    const lines = await readAuditLines(repo.dir);
    const skip = lines.find((r) => r['tool_name'] === 'codex.review.skipped');
    expect(skip).toBeDefined();
    const meta = skip!['metadata'] as Record<string, unknown>;
    expect(meta['reason']).toBe('waiver-without-cache');
  });

  it('#85: waiver + cache hit → exit 0 (composition: Codex waived, general gate satisfied)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'composed@example.test',
      userName: 'Composed',
    });
    track(repo);

    await populatePushReviewCache(repo);

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'codex-waived-general-reviewed',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(0);
    // Banner + skip audit both present.
    expect(res.stderr).toMatch(/CODEX REVIEW WAIVER active/);
    const lines = await readAuditLines(repo.dir);
    const skip = lines.find((r) => r['tool_name'] === 'codex.review.skipped');
    expect(skip).toBeDefined();
    // No codex.review audit entry needs to exist — the waiver satisfies
    // the protected-path check on its own.
    expect(
      lines.some((r) => r['tool_name'] === 'codex.review'),
    ).toBe(false);
  });

  it('Codex 0.8.0 pass-2 #2 regression: cache key uses PUSHED ref, not checkout — hotfix:main from feature checkout', async () => {
    // `git push origin hotfix:main` from a `feature` checkout must look up
    // a cache entry keyed on `hotfix`, not `feature`. Previously the cache
    // check used `git branch --show-current` which silently mis-keyed the
    // lookup under this workflow. Under #85 the cache is load-bearing for
    // waiver users, so a mis-keyed lookup would force every hotfix push to
    // fail the general gate even after an earlier pass was cached.
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'hotfix@example.test',
      userName: 'HotfixPusher',
    });
    track(repo);

    const gitIn = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8' }).trim();

    // Build a `hotfix` branch off main with a DIFFERENT protected-path change.
    // `hooks/` only exists on `feature` — checkout main removes it — so
    // recreate it before writing the hotfix file.
    gitIn('checkout', 'main', '--quiet');
    gitIn('checkout', '-b', 'hotfix', '--quiet');
    await fs.mkdir(path.join(repo.dir, 'hooks'), { recursive: true });
    await fs.writeFile(
      path.join(repo.dir, 'hooks', '__hotfix__.sh'),
      '#!/bin/bash\necho hotfix\n',
    );
    gitIn('add', 'hooks/__hotfix__.sh');
    gitIn('commit', '-m', 'hotfix protected path', '--quiet');
    const hotfixSha = gitIn('rev-parse', 'HEAD');

    // Switch back to `feature` — the intentional workflow mismatch: checkout
    // is `feature`, but the push is `hotfix:main`.
    gitIn('checkout', 'feature', '--quiet');

    // Seed cache keyed on `hotfix` + `main` with the hotfix diff SHA.
    const rawDiff = execFileSync(
      'git',
      ['diff', `${repo.mergeBaseSha}..${hotfixSha}`],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    const hotfixDiffSha = createHash('sha256')
      .update(rawDiff.replace(/\n+$/, ''))
      .digest('hex');
    const cacheEntry = {
      sha: hotfixDiffSha,
      branch: 'hotfix',
      base: 'main',
      result: 'pass',
      recorded_at: new Date().toISOString(),
    };
    const cacheFile = path.join(repo.dir, '.rea', 'review-cache.jsonl');
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(cacheEntry) + '\n');

    const res = runHook(
      repo,
      {
        REA_SKIP_CODEX_REVIEW: 'hotfix-keyed-cache',
        PATH: process.env.PATH ?? '',
      },
      'git push origin hotfix:main',
    );

    // Cache hit keyed on pushed ref → exit 0 even though checkout != pushed.
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/CODEX REVIEW WAIVER active/);
  });

  it('Codex 0.8.0 pass-3 #1 regression: bare `git push` keys cache on checkout branch, not literal "HEAD"', async () => {
    // `pr_resolve_argv_refspecs` emits local_ref="HEAD" for a bare `git push`
    // (no refspec). Without the HEAD-literal fallback in section 8, the cache
    // lookup would be keyed on "HEAD", which never matches a real cache entry.
    // The fallback to CURRENT_BRANCH restores the normal workflow.
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'barepush@example.test',
      userName: 'BarePush',
    });
    track(repo);

    const gitIn = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8' }).trim();

    // Push feature to origin to establish upstream, THEN add a new protected
    // path commit. Bare `git push` then sees a diff between origin/feature
    // (pre-second-commit) and current HEAD (post-second-commit). Without this
    // setup the diff would be empty and section 8 would be unreachable.
    gitIn('push', '-u', 'origin', 'feature', '--quiet');
    await fs.writeFile(
      path.join(repo.dir, 'hooks', '__bare__.sh'),
      '#!/bin/bash\necho bare\n',
    );
    gitIn('add', 'hooks/__bare__.sh');
    gitIn('commit', '-m', 'bare push commit', '--quiet');
    const postSha = gitIn('rev-parse', 'HEAD');

    // Seed cache keyed on feature/feature (bare push target = upstream =
    // feature). The hook computes merge-base against `origin/HEAD` (which
    // points at origin/main after the initial `rea init`-style setup), so
    // the diff it hashes is `mergeBaseSha..postSha` — NOT `headSha..postSha`
    // as a naive reading of the upstream would suggest.
    const rawDiff = execFileSync(
      'git',
      ['diff', `${repo.mergeBaseSha}..${postSha}`],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    const diffSha = createHash('sha256')
      .update(rawDiff.replace(/\n+$/, ''))
      .digest('hex');
    const cacheEntry = {
      sha: diffSha,
      branch: 'feature',
      base: 'feature',
      result: 'pass',
      recorded_at: new Date().toISOString(),
    };
    const cacheFile = path.join(repo.dir, '.rea', 'review-cache.jsonl');
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(cacheEntry) + '\n');

    const res = runHook(
      repo,
      {
        REA_SKIP_CODEX_REVIEW: 'bare-push-waiver',
        PATH: process.env.PATH ?? '',
      },
      'git push',
    );

    // Cache hit keyed on checkout branch (fallback from "HEAD") → exit 0.
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/CODEX REVIEW WAIVER active/);
  });

  it('Codex 0.8.0 pass-2 #1 regression: waiver + cache entry with result=fail MUST block (exit 2)', async () => {
    // The cache-hit jq predicate must require `.result == "pass"`, not just
    // `.hit == true`. A cached `fail` verdict (e.g. from a prior reviewer
    // run that found issues) that happens to match the current diff SHA
    // must NOT satisfy the gate — the permissive predicate was a real
    // security regression under the #85 narrowed waiver semantic, because
    // the cache is the only path to exit 0 for a waiver-using operator.
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'failcache@example.test',
      userName: 'FailCache',
    });
    track(repo);

    await populatePushReviewCache(repo, { result: 'fail' });

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'waiver-with-fail-cache',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(2);
    // The WAIVER banner still prints (waiver fired and audit receipt was
    // written) — the block comes from section 9 after the cache lookup
    // rejects the `fail` verdict.
    expect(res.stderr).toMatch(/CODEX REVIEW WAIVER active/);
    expect(res.stderr).toMatch(/PUSH REVIEW GATE: Review required/);
    // Confirm the waiver audit record was written regardless.
    const lines = await readAuditLines(repo.dir);
    expect(
      lines.some((r) => r['tool_name'] === 'codex.review.skipped'),
    ).toBe(true);
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
