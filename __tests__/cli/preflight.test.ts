/**
 * Tests for `rea preflight` (0.26.0).
 *
 * The CLI tests drive `computePreflight` directly so we don't need to
 * spawn `rea preflight` for every case — `runPreflight` is a thin wrapper
 * that exits via `process.exit` based on `computePreflight`'s outcome.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computePreflight, findRecentLocalReview } from '../../src/cli/preflight.js';
import { appendAuditRecord } from '../../src/audit/append.js';
import { LOCAL_REVIEW_TOOL_NAME } from '../../src/audit/local-review-event.js';
import { CODEX_REVIEW_TOOL_NAME } from '../../src/audit/codex-event.js';
import { Tier, InvocationStatus } from '../../src/policy/types.js';

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

async function setupRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-preflight-')));
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  // git init so HEAD resolves.
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
  return dir;
}

async function writePolicy(dir: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_HEADER + body);
}

function readHeadSha(dir: string): string {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return (r.stdout ?? '').toString().trim();
}

describe('computePreflight — mode off', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exits 0 when policy.review.local_review.mode is off', async () => {
    await writePolicy(dir, 'review:\n  local_review:\n    mode: off\n');
    const { outcome } = await computePreflight(dir, {});
    expect(outcome.status).toBe('clean');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.reason).toMatch(/mode is off/);
  });
});

describe('computePreflight — bypass env-var', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exits 0 when REA_SKIP_LOCAL_REVIEW is set to a non-empty value', async () => {
    const env = { ...process.env, REA_SKIP_LOCAL_REVIEW: 'urgent fix #42' };
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('clean');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.reason).toMatch(/REA_SKIP_LOCAL_REVIEW/);
  });

  it('writes an audit entry recording the override reason', async () => {
    const env = { ...process.env, REA_SKIP_LOCAL_REVIEW: 'incident-12345' };
    await computePreflight(dir, {}, env);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const raw = await fs.readFile(auditPath, 'utf8');
    expect(raw).toMatch(/rea\.local_review\.skipped_override/);
    expect(raw).toMatch(/incident-12345/);
  });

  it('honors a custom bypass_env_var from policy', async () => {
    await writePolicy(
      dir,
      'review:\n  local_review:\n    bypass_env_var: REA_CUSTOM_OVERRIDE\n',
    );
    const env = { ...process.env, REA_CUSTOM_OVERRIDE: 'custom override' };
    // Strip the default env var so we test the custom one in isolation.
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('clean');
    expect(outcome.details.bypass_env_var).toBe('REA_CUSTOM_OVERRIDE');
  });
});

describe('computePreflight — audit-log lookup', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses (exit 2) with no audit entry covering HEAD', async () => {
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('refuse');
    expect(outcome.exitCode).toBe(2);
    expect(outcome.reason).toMatch(/no recent local-review/);
  });

  it('passes (exit 0) with a fresh rea.local_review entry covering HEAD', async () => {
    const headSha = readHeadSha(dir);
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('clean');
    expect(outcome.exitCode).toBe(0);
  });

  it('accepts back-compat codex.review entries', async () => {
    const headSha = readHeadSha(dir);
    await appendAuditRecord(dir, {
      tool_name: CODEX_REVIEW_TOOL_NAME,
      server_name: 'codex',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headSha,
        target: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('clean');
  });

  it('rejects an entry whose verdict is blocking', async () => {
    const headSha = readHeadSha(dir);
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Denied,
      metadata: {
        head_sha: headSha,
        base_ref: 'origin/main',
        verdict: 'blocking',
        finding_count: 3,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('refuse');
    expect(outcome.exitCode).toBe(2);
  });

  it('rejects an entry whose head_sha does not match', async () => {
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: '0000000000000000000000000000000000000000',
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('refuse');
  });
});

describe('findRecentLocalReview — max_age_seconds enforcement', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects an entry older than max_age_seconds', async () => {
    const headSha = readHeadSha(dir);
    // Synthesize an audit entry with a stale timestamp.
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      timestamp: oneWeekAgo,
      metadata: {
        head_sha: headSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });

    // Default max age is 24h; the entry is 7d old → no match.
    const r = findRecentLocalReview(dir, headSha, 86_400);
    expect(r.found).toBe(false);
  });

  it('accepts an entry within max_age_seconds', async () => {
    const headSha = readHeadSha(dir);
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    const r = findRecentLocalReview(dir, headSha, 86_400);
    expect(r.found).toBe(true);
    expect(r.metadata?.head_sha).toBe(headSha);
  });
});

describe('computePreflight — content_token coverage (helix-026 finding-1)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function readTreeSha(d: string): string {
    const r = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: d,
      encoding: 'utf8',
    });
    return (r.stdout ?? '').toString().trim();
  }

  it('matches a recent review by content_token even when HEAD has moved', async () => {
    // Simulate: review at commit C0 (with content_token T0), then a
    // content-equivalent amend that produces commit C1 (HEAD moves but
    // tree SHA is unchanged → token preserved). Preflight should pass.
    const treeSha = readTreeSha(dir);
    const oldHeadSha = readHeadSha(dir);
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: oldHeadSha,
        content_token: treeSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    // Move HEAD via a content-equivalent amend (NEW message → new SHA,
    // SAME tree). This simulates the local-first flow: review at C0,
    // then amend with a polished commit message before push.
    spawnSync(
      'git',
      ['commit', '--amend', '-m', 'init (amended)', '-q', '--no-gpg-sign'],
      { cwd: dir },
    );
    expect(readHeadSha(dir)).not.toBe(oldHeadSha);
    expect(readTreeSha(dir)).toBe(treeSha);

    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('clean');
    expect(outcome.exitCode).toBe(0);
  });

  it('refuses when content changes (token differs) even though a review exists', async () => {
    const treeShaT0 = readTreeSha(dir);
    const headShaT0 = readHeadSha(dir);
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headShaT0,
        content_token: treeShaT0,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    // Add real content — token changes, head_sha changes.
    await fs.writeFile(path.join(dir, 'NEW.md'), '# new\n');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'add new', '--no-gpg-sign'], { cwd: dir });

    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('refuse');
    expect(outcome.exitCode).toBe(2);
  });

  it('falls back to head_sha for legacy entries without content_token', async () => {
    // Legacy `codex.review` entries (pre-0.26.0) and the original
    // `rea.local_review` shape both omit content_token. Preflight must
    // still accept them so the upgrade doesn't require a fresh review.
    const headSha = readHeadSha(dir);
    await appendAuditRecord(dir, {
      tool_name: CODEX_REVIEW_TOOL_NAME,
      server_name: 'codex',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        // NO content_token — legacy shape.
        head_sha: headSha,
        target: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('clean');
  });

  it('reports match_kind on findRecentLocalReview for forensics', () => {
    const treeSha = readTreeSha(dir);
    const headSha = readHeadSha(dir);
    // Token-matched entry.
    void appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headSha,
        content_token: treeSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    return appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headSha,
        content_token: treeSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    }).then(() => {
      const r = findRecentLocalReview(dir, headSha, 86_400, new Date(), treeSha);
      expect(r.found).toBe(true);
      expect(r.match_kind).toBe('content_token');
    });
  });

  it('falls back to head_sha match when caller has no content_token', async () => {
    const treeSha = readTreeSha(dir);
    const headSha = readHeadSha(dir);
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headSha,
        content_token: treeSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    // Caller with no content_token (e.g. preflight on a non-git path).
    const r = findRecentLocalReview(dir, headSha, 86_400, new Date(), '');
    expect(r.found).toBe(true);
    expect(r.match_kind).toBe('head_sha');
  });

  it('rejects when both content_token and head_sha are empty', () => {
    const r = findRecentLocalReview(dir, '', 86_400, new Date(), '');
    expect(r.found).toBe(false);
  });
});

describe('computePreflight — commit-count base ordering (helix-026 finding-3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeOriginAndTrack(
    repoDir: string,
    branch: string = 'feature',
  ): { originDir: string } {
    // Create a bare-ish "origin" repo so origin/HEAD and origin/main resolve.
    const originDir = path.join(repoDir, '..', `origin-${path.basename(repoDir)}`);
    spawnSync('git', ['clone', '--bare', '-q', repoDir, originDir]);
    spawnSync('git', ['remote', 'add', 'origin', originDir], { cwd: repoDir });
    spawnSync('git', ['fetch', '-q', 'origin'], { cwd: repoDir });
    // Set origin/HEAD -> origin/main symbolic ref so resolveRef finds it.
    spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], {
      cwd: repoDir,
    });
    // Create a feature branch and 7 commits ahead of main.
    spawnSync('git', ['checkout', '-q', '-b', branch], { cwd: repoDir });
    return { originDir };
  }

  async function commitN(repoDir: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await fs.writeFile(path.join(repoDir, `f${i}.txt`), `content ${i}\n`);
      spawnSync('git', ['add', '.'], { cwd: repoDir });
      spawnSync('git', ['commit', '-q', '-m', `commit ${i}`, '--no-gpg-sign'], {
        cwd: repoDir,
      });
    }
  }

  it('refuses when commit count > refuse_at_commits even if @{upstream} tracks the feature branch', async () => {
    const { originDir } = makeOriginAndTrack(dir);
    await commitN(dir, 7);
    // Push the feature branch with -u so @{upstream} = origin/feature.
    spawnSync('git', ['push', '-q', '-u', 'origin', 'feature'], { cwd: dir });

    await writePolicy(
      dir,
      'commit_hygiene:\n  warn_at_commits: 1\n  refuse_at_commits: 5\n',
    );
    // Add a fresh review so step 4 passes; finding-3 is about step 5.
    const treeSha = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .stdout.toString()
      .trim();
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: readHeadSha(dir),
        content_token: treeSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, { strict: true }, env);
    // Pre-fix this would have read @{upstream}=origin/feature → count=0
    // → CLEAN. Post-fix, origin/HEAD wins → count=7 → REFUSE.
    expect(outcome.status).toBe('refuse');
    expect(outcome.exitCode).toBe(2);
    expect(outcome.details.commit_count).toBe(7);
    await fs.rm(originDir, { recursive: true, force: true });
  });

  it('warns (exit 1) without --strict when commit count > warn_at_commits', async () => {
    const { originDir } = makeOriginAndTrack(dir);
    await commitN(dir, 3);
    spawnSync('git', ['push', '-q', '-u', 'origin', 'feature'], { cwd: dir });
    await writePolicy(
      dir,
      'commit_hygiene:\n  warn_at_commits: 1\n  refuse_at_commits: 100\n',
    );
    const treeSha = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .stdout.toString()
      .trim();
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: readHeadSha(dir),
        content_token: treeSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, { strict: false }, env);
    expect(outcome.status).toBe('warn');
    expect(outcome.exitCode).toBe(1);
    await fs.rm(originDir, { recursive: true, force: true });
  });

  it('still refuses on untracked branch (no upstream) via origin/HEAD fallback', async () => {
    const { originDir } = makeOriginAndTrack(dir);
    await commitN(dir, 7);
    // Do NOT push -u. @{upstream} is unresolved; origin/HEAD wins.
    await writePolicy(
      dir,
      'commit_hygiene:\n  warn_at_commits: 1\n  refuse_at_commits: 5\n',
    );
    const treeSha = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .stdout.toString()
      .trim();
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: readHeadSha(dir),
        content_token: treeSha,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 12,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, { strict: true }, env);
    expect(outcome.status).toBe('refuse');
    expect(outcome.details.commit_count).toBe(7);
    await fs.rm(originDir, { recursive: true, force: true });
  });
});

describe('computePreflight — --no-review-check escape hatch', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('skips the audit-log check and audits the skip', async () => {
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, { noReviewCheck: true }, env);
    expect(outcome.status).toBe('clean');
    expect(outcome.exitCode).toBe(0);

    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const raw = await fs.readFile(auditPath, 'utf8');
    expect(raw).toMatch(/rea\.preflight\.review_skipped/);
  });
});

// ── round-27 F2: unborn-HEAD bootstrap is symmetric (writer + reader) ──
describe('computePreflight — unborn-HEAD bootstrap (round-27 F2)', () => {
  let dir: string;
  beforeEach(async () => {
    // Build a repo with `git init` but NO commits — HEAD is unborn.
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-preflight-unborn-')));
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    await writePolicy(dir, 'review:\n  local_review:\n    refuse_at: both\n');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('approves preflight when an audit entry was written with the EMPTY_TREE_SHA fallback', async () => {
    // Simulate `rea review` writing an audit entry on unborn HEAD —
    // its `headSha` falls back to git's empty-tree SHA. `rea preflight`
    // (reader) must use the SAME constant so the head-sha fallback path
    // matches the entry. Pre-fix the reader returned '' and the
    // both-empty guard rejected the entry, deadlocking bootstrap.
    const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: EMPTY_TREE_SHA,
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 1,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('clean');
    expect(outcome.exitCode).toBe(0);
  });
});

// ── round-27 F3: token-mismatch is authoritative; no head_sha fallback ──
describe('computePreflight — token mismatch authority (round-27 F3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
    await writePolicy(dir, '');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses when audit-entry token differs from current tree token (no head_sha fallback)', async () => {
    const headSha = readHeadSha(dir);
    // Write an audit entry whose head_sha matches HEAD (so head_sha fallback
    // WOULD have approved, pre-fix) but whose content_token is intentionally
    // wrong for the current tree. Real-world shape: rea review wrote T1,
    // operator then edited a tracked file, didn't commit. HEAD unchanged,
    // tree has changed.
    await appendAuditRecord(dir, {
      tool_name: LOCAL_REVIEW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headSha,
        // Intentionally wrong token — anything != computeTreeToken(dir).
        content_token: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        base_ref: 'origin/main',
        verdict: 'pass',
        finding_count: 0,
        provider: 'codex',
        duration_seconds: 1,
      },
    });
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).REA_SKIP_LOCAL_REVIEW;
    const { outcome } = await computePreflight(dir, {}, env);
    // Token mismatch is authoritative — entry is stale, no fallback.
    expect(outcome.status).toBe('refuse');
    expect(outcome.exitCode).toBe(2);
  });
});

// ── round-27 F4: HALT enforced inside `rea preflight` ──
describe('computePreflight — HALT enforcement (round-27 F4)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses (exit 2) regardless of mode when .rea/HALT exists', async () => {
    // Even mode=off must refuse — HALT is the kill-switch and overrides
    // every other policy path. Pre-fix preflight short-circuited on
    // mode=off BEFORE checking HALT, leaving the kill-switch unenforced.
    await writePolicy(dir, 'review:\n  local_review:\n    mode: off\n');
    await fs.writeFile(path.join(dir, '.rea', 'HALT'), 'security incident — investigating\n');
    const { outcome } = await computePreflight(dir, {});
    expect(outcome.status).toBe('refuse');
    expect(outcome.exitCode).toBe(2);
    expect(outcome.reason).toMatch(/REA HALT:/);
    expect(outcome.reason).toMatch(/security incident/);
  });

  it('refuses with reason `unknown` when HALT is empty', async () => {
    await writePolicy(dir, '');
    await fs.writeFile(path.join(dir, '.rea', 'HALT'), '');
    const { outcome } = await computePreflight(dir, {});
    expect(outcome.status).toBe('refuse');
    expect(outcome.exitCode).toBe(2);
    expect(outcome.reason).toMatch(/REA HALT:/);
  });

  it('approves normally when HALT is absent', async () => {
    // Sanity: HALT path must not regress the happy path. Bypass via
    // env-var so we don't have to seed an audit entry here.
    await writePolicy(dir, '');
    const env = { ...process.env, REA_SKIP_LOCAL_REVIEW: 'tests' };
    const { outcome } = await computePreflight(dir, {}, env);
    expect(outcome.status).toBe('clean');
    expect(outcome.exitCode).toBe(0);
  });
});
