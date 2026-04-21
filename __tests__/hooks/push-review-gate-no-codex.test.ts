/**
 * Integration tests for the G11.4 no-Codex push-gate behavior.
 *
 * These tests drive `hooks/push-review-gate.sh` against a scratch repo whose
 * diff touches a protected path (`hooks/__test__.sh`). We toggle
 * `.rea/policy.yaml`'s `review.codex_required` field and assert:
 *
 *   1. When `codex_required: false` → the Codex audit-record requirement is
 *      skipped entirely, the push is NOT blocked by the protected-path gate,
 *      and NO `codex.review.skipped` audit record is written (the skip
 *      concept only applies when Codex is required).
 *   2. When `codex_required: true` or the field is absent → existing G11.1
 *      behavior is preserved (protected-path diff without a `codex.review`
 *      audit entry blocks the push).
 *   3. When `codex_required: false` AND `REA_SKIP_CODEX_REVIEW` is set → the
 *      env var is a no-op; no skip audit record is written.
 *   4. Malformed policy → fail closed (treat as `codex_required: true`).
 *
 * The tests only exercise the fail-closed / no-codex branches — the standard
 * "REVIEW REQUIRED" downstream gate (section 9 of the hook) still fires on
 * every diff. That is intentional: `codex_required: false` removes the
 * protected-path Codex audit requirement, not general push review.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');
const DIST_SCRIPT_PATH = path.join(
  REPO_ROOT,
  'dist',
  'scripts',
  'read-policy-field.js',
);

// BUG-012 (0.6.2): the hook anchors REA_ROOT to its own on-disk location
// (two levels up from `.claude/hooks/`). The test harness must mirror the
// installed topology — copy the hook into `<repoDir>/.claude/hooks/` and
// invoke it from there.
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
 * Create a scratch repo whose feature branch touches a protected path. The
 * hook's protected-path regex matches `hooks/` so this guarantees the Codex
 * branch would fire if `codex_required` is not set to false.
 *
 * Options:
 *   - `policyContent`: raw YAML to write to `.rea/policy.yaml`. Omit to skip
 *     the policy file entirely (field-absent path).
 *   - `linkDist`: when true (default) symlinks real `dist/audit` AND
 *     `dist/scripts` from the rea repo into the scratch repo so the hook can
 *     invoke both the audit helper and the read-policy-field helper.
 */
async function makeScratchRepo(opts: {
  policyContent?: string;
  linkDist?: boolean;
}): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-no-codex-test-')),
  );

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '--initial-branch=main', '--quiet');
  git('config', 'user.email', 'nocodex@example.test');
  git('config', 'user.name', 'No Codex');
  git('config', 'commit.gpgsign', 'false');

  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n');
  git('add', 'README.md');
  git('commit', '-m', 'baseline', '--quiet');
  const mergeBaseSha = git('rev-parse', 'HEAD');

  // Add a bare remote as `origin` and push `main` so `refs/remotes/origin/main`
  // exists in the local ref DB. The gate's new-branch merge-base resolution
  // (shared core) anchors on the remote-tracking ref to close the pusher-
  // controlled-local-main bypass, so a scratch repo without origin/main
  // fails-closed at merge-base resolution before any protected-path check
  // runs. Setting up origin makes the test repo a realistic consumer shape.
  const bareRemote = path.join(dir, '..', path.basename(dir) + '.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', bareRemote], {
    encoding: 'utf8',
  });
  git('remote', 'add', 'origin', bareRemote);
  git('push', 'origin', 'main', '--quiet');

  git('checkout', '-b', 'feature', '--quiet');
  await fs.mkdir(path.join(dir, 'hooks'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'hooks', '__test__.sh'),
    '#!/bin/bash\necho scratch\n',
  );
  git('add', 'hooks/__test__.sh');
  git('commit', '-m', 'touch protected path', '--quiet');
  const headSha = git('rev-parse', 'HEAD');

  if (opts.linkDist !== false) {
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'audit'),
      path.join(dir, 'dist', 'audit'),
    );
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'scripts'),
      path.join(dir, 'dist', 'scripts'),
    );
    // loadPolicy also pulls in the policy loader module, which lives under
    // dist/policy/. Link the whole dist tree is overkill; individual symlinks
    // keep intent obvious.
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'policy'),
      path.join(dir, 'dist', 'policy'),
    );
  }

  if (opts.policyContent !== undefined) {
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      opts.policyContent,
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
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
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
 * Minimal valid policy YAML with `review.codex_required` set to the given
 * value. `codexRequired === undefined` omits the field entirely (absent
 * case).
 */
function policyYaml(codexRequired: boolean | undefined): string {
  const base = [
    'version: "1"',
    'profile: "bst-internal"',
    'installed_by: "test"',
    'installed_at: "2026-04-18T00:00:00Z"',
    'autonomy_level: L1',
    'max_autonomy_level: L2',
    'promotion_requires_human_approval: true',
    'block_ai_attribution: true',
    'blocked_paths:',
    '  - .env',
    'notification_channel: ""',
  ];
  if (codexRequired !== undefined) {
    base.push('review:', `  codex_required: ${codexRequired}`);
  }
  base.push('');
  return base.join('\n');
}

describe('push-review-gate.sh — G11.4 review.codex_required honored', () => {
  const scratchPaths: string[] = [];

  beforeEach(() => {
    scratchPaths.length = 0;
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

  it('dist/scripts/read-policy-field.js is built (sanity)', async () => {
    const exists = await fs
      .access(DIST_SCRIPT_PATH)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it('codex_required=false: protected path + no Codex record → push NOT blocked by Codex gate', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      policyContent: policyYaml(false),
    });
    track(repo);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    // The protected-path Codex gate must not fire. The downstream generic
    // "REVIEW REQUIRED" gate (section 9) still blocks the push, but the
    // message is DISTINCT from the Codex-required banner.
    expect(res.stderr).not.toMatch(/protected paths changed/);
    expect(res.stderr).not.toMatch(/\/codex-review required/);
    expect(res.stderr).not.toMatch(/CODEX REVIEW (SKIPPED|WAIVER)/);

    // And no audit skip record was written — a skip is only meaningful when
    // Codex is required.
    const lines = await readAuditLines(repo.dir);
    expect(
      lines.some((r) => r['tool_name'] === 'codex.review.skipped'),
    ).toBe(false);
  });

  it('codex_required=false + REA_SKIP_CODEX_REVIEW set → env var is a no-op (no skip record)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      policyContent: policyYaml(false),
    });
    track(repo);

    const res = runHook(repo, {
      REA_SKIP_CODEX_REVIEW: 'should-be-ignored',
      PATH: process.env.PATH ?? '',
    });

    // No Codex banner, no skip banner.
    expect(res.stderr).not.toMatch(/CODEX REVIEW (SKIPPED|WAIVER)/);
    expect(res.stderr).not.toMatch(/protected paths changed/);

    // No skip audit record.
    const lines = await readAuditLines(repo.dir);
    expect(
      lines.some((r) => r['tool_name'] === 'codex.review.skipped'),
    ).toBe(false);
  });

  it('codex_required=true: regression — existing behavior unchanged (protected path blocks push)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      policyContent: policyYaml(true),
    });
    track(repo);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
    expect(res.stderr).toMatch(/codex-review required/);
  });

  it('review field absent: regression — defaults to codex_required=true (protected path blocks push)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      policyContent: policyYaml(undefined),
    });
    track(repo);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
  });

  it('no policy file at all: regression — defaults to codex_required=true', async () => {
    if (!jqExists()) return;

    // Omit policyContent entirely — .rea/policy.yaml does not exist. The
    // helper exits 1 (missing) and the shell treats this as the default
    // (codex required).
    const repo = await makeScratchRepo({});
    track(repo);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
  });

  it('malformed policy: fail closed (treat as codex_required=true)', async () => {
    if (!jqExists()) return;

    // Policy YAML with an invalid review.codex_required value (string, not
    // boolean) — zod strict schema rejects, helper exits 2, shell logs a
    // warning and falls through to codex_required=true.
    const malformed = policyYaml(true).replace(
      'codex_required: true',
      'codex_required: "yes"',
    );

    const repo = await makeScratchRepo({ policyContent: malformed });
    track(repo);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    // Fail-closed: Codex gate fires.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
    // And we logged a warning about the malformed helper invocation.
    expect(res.stderr).toMatch(/review\.codex_required|read-policy-field/);
  });
});
