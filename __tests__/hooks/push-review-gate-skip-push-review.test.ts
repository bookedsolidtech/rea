/**
 * Integration tests for the push-review-gate.sh WHOLE-GATE escape hatch
 * (REA_SKIP_PUSH_REVIEW — added in 0.5.0 as part of the BUG-009 fix).
 *
 * Distinct from REA_SKIP_CODEX_REVIEW: that one bypasses the Codex-audit
 * branch only; the rest of the gate (protected-path detection, cache check)
 * still runs. REA_SKIP_PUSH_REVIEW bypasses the ENTIRE gate. It exists to
 * unblock consumers when rea itself is broken — e.g. pre-0.5.0 consumers
 * deadlocked on a missing `rea cache` subcommand, or a corrupt policy file
 * that would otherwise refuse every push.
 *
 * These assertions:
 *   1. Exit 0 when REA_SKIP_PUSH_REVIEW is set (with a protected-path diff
 *      that would otherwise be blocked — the whole gate really is bypassed).
 *   2. Audit record carries tool_name="push.review.skipped", server_name
 *      "rea.escape_hatch", verdict "skipped", and the operator's reason.
 *   3. The skip record does NOT satisfy the Codex-review jq predicate —
 *      bypassing the whole gate does not retroactively count as a Codex
 *      review of the commits.
 *   4. Fail-closed paths (missing dist/audit/append.js, missing git identity).
 *   5. Empty-string value = treated as unset; gate still fires.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');
const DIST_AUDIT_PATH = path.join(REPO_ROOT, 'dist', 'audit', 'append.js');

// BUG-012 (0.6.2): hook anchors REA_ROOT via script-on-disk location.
// Install into `<repoDir>/.claude/hooks/` and invoke from there.
async function installPushHook(dir: string): Promise<string> {
  const destDir = path.join(dir, '.claude', 'hooks');
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, 'push-review-gate.sh');
  await fs.copyFile(HOOK_SRC, dest);
  await fs.chmod(dest, 0o755);
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
}

async function makeScratchRepo(opts: {
  userEmail?: string | null;
  userName?: string | null;
  linkDist?: boolean;
}): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-push-gate-skip-all-')),
  );

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '--initial-branch=main', '--quiet');

  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'REA Test');
  git('config', 'commit.gpgsign', 'false');

  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n');
  git('add', 'README.md');
  git('commit', '-m', 'baseline', '--quiet');
  const mergeBaseSha = git('rev-parse', 'HEAD');

  git('checkout', '-b', 'feature', '--quiet');
  await fs.mkdir(path.join(dir, 'hooks'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'hooks', '__test__.sh'),
    '#!/bin/bash\necho scratch\n',
  );
  git('add', 'hooks/__test__.sh');
  git('commit', '-m', 'touch protected path', '--quiet');
  const headSha = git('rev-parse', 'HEAD');

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

  if (opts.linkDist !== false) {
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'audit'),
      path.join(dir, 'dist', 'audit'),
    );
    // Also symlink dist/scripts so the hook can invoke read-policy-field.js
    // for the F2 CI-allow lookup.
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'scripts'),
      path.join(dir, 'dist', 'scripts'),
    );
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'policy'),
      path.join(dir, 'dist', 'policy'),
    );
  }

  await installPushHook(dir);

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

describe('push-review-gate.sh — REA_SKIP_PUSH_REVIEW whole-gate escape hatch', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanup.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('requires dist/audit/append.js to exist (fail-closed)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({ linkDist: false });
    cleanup.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_PUSH_REVIEW: 'ci-test',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REA_SKIP_PUSH_REVIEW requires rea to be built/);
  });

  it('requires a git identity (fail-closed)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: null,
      userName: null,
    });
    cleanup.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_PUSH_REVIEW: 'ci-test',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REA_SKIP_PUSH_REVIEW requires a git identity/);
  });

  it('bypasses the gate and writes a tool_name=push.review.skipped audit record', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'operator@example.test',
      userName: 'Operator',
    });
    cleanup.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_PUSH_REVIEW: 'rea-cache-subcommand-broken',
      PATH: process.env.PATH ?? '',
    });

    // Even though the feature branch touches a protected path (hooks/),
    // the whole-gate skip must short-circuit to exit 0.
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/PUSH REVIEW GATE SKIPPED/);
    expect(res.stderr).toContain('rea-cache-subcommand-broken');
    expect(res.stderr).toContain('operator@example.test');
    expect(res.stderr).toContain(repo.headSha);
    expect(res.stderr).toMatch(/gate weakening/);

    const lines = await readAuditLines(repo.dir);
    const skipRecords = lines.filter(
      (r) => r['tool_name'] === 'push.review.skipped',
    );
    expect(skipRecords).toHaveLength(1);
    const rec = skipRecords[0]!;
    expect(rec['server_name']).toBe('rea.escape_hatch');
    expect(rec['status']).toBe('allowed');
    expect(rec['tier']).toBe('read');

    const meta = rec['metadata'] as Record<string, unknown>;
    expect(meta['head_sha']).toBe(repo.headSha);
    expect(meta['reason']).toBe('rea-cache-subcommand-broken');
    expect(meta['actor']).toBe('operator@example.test');
    expect(meta['verdict']).toBe('skipped');
    expect(meta['branch']).toBe('feature');
  });

  it('reason is literally the env-var value (no default)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    cleanup.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_PUSH_REVIEW: '1',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(0);
    const lines = await readAuditLines(repo.dir);
    const meta = (
      lines.find((r) => r['tool_name'] === 'push.review.skipped')!
        .metadata as Record<string, unknown>
    );
    expect(meta['reason']).toBe('1');
  });

  it('skip record does NOT satisfy the hook jq predicate for codex.review', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    cleanup.push(repo.dir);

    runHook(repo, {
      REA_SKIP_PUSH_REVIEW: 'testing',
      PATH: process.env.PATH ?? '',
    });

    // A push-gate skip MUST NOT retroactively count as a Codex review. The
    // Codex-review jq predicate filters on tool_name=="codex.review" — a
    // skip record uses push.review.skipped, so the predicate must miss.
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
    expect(res.status).not.toBe(0);
  });

  it('empty-string value is treated as unset; gate fires normally', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    cleanup.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_PUSH_REVIEW: '',
      PATH: process.env.PATH ?? '',
    });

    // Protected-path diff + no Codex audit entry + skip empty → gate fires.
    expect(res.status).toBe(2);
    expect(res.stderr).not.toMatch(/PUSH REVIEW GATE SKIPPED/);
    expect(res.stderr).toMatch(/protected paths changed|PUSH REVIEW GATE/);
  });

  it('HALT beats REA_SKIP_PUSH_REVIEW — HALT file wins (regression for F1)', async () => {
    // The HALT check runs before the skip-hatch branch. A HALT file must
    // short-circuit the hook with exit 2 even when REA_SKIP_PUSH_REVIEW is
    // set — otherwise an attacker who can set env vars could push while the
    // project is ostensibly frozen. This test pins that ordering invariant
    // for the .claude/hooks/ path (Codex F1).
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    cleanup.push(repo.dir);

    await fs.mkdir(path.join(repo.dir, '.rea'), { recursive: true });
    await fs.writeFile(
      path.join(repo.dir, '.rea', 'HALT'),
      'frozen for test\n',
    );

    const res = runHook(repo, {
      REA_SKIP_PUSH_REVIEW: 'should-be-ignored',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REA HALT/);
    expect(res.stderr).not.toMatch(/PUSH REVIEW GATE SKIPPED/);

    // And the audit log must NOT have gained a push.review.skipped record —
    // a halted project cannot be bypassed.
    const auditFile = path.join(repo.dir, '.rea', 'audit.jsonl');
    const exists = await fs
      .access(auditFile)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const lines = await readAuditLines(repo.dir);
      expect(
        lines.find((r) => r['tool_name'] === 'push.review.skipped'),
      ).toBeUndefined();
    }
  });

  it('refuses REA_SKIP_PUSH_REVIEW in CI by default (regression for F2)', async () => {
    // When `CI` is set, the skip hatch must refuse with exit 2 unless the
    // policy explicitly authorizes it via review.allow_skip_in_ci=true.
    // This closes the ambient-env-var bypass surface on shared build agents.
    if (!jqExists()) return;

    const repo = await makeScratchRepo({});
    cleanup.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_PUSH_REVIEW: 'ci-attempted-skip',
      CI: '1',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/refused in CI context/);
    expect(res.stderr).not.toMatch(/PUSH REVIEW GATE SKIPPED/);
  });

  it('allows REA_SKIP_PUSH_REVIEW in CI when policy opts in (F2 positive case)', async () => {
    // With `review.allow_skip_in_ci: true` in .rea/policy.yaml, the CI
    // refusal branch is bypassed and the normal skip audit record is written.
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'ci-operator@example.test',
    });
    cleanup.push(repo.dir);

    await fs.mkdir(path.join(repo.dir, '.rea'), { recursive: true });
    const policyYaml = [
      'version: "1"',
      'profile: "bst-internal"',
      'installed_by: "test"',
      'installed_at: "2026-04-19T00:00:00Z"',
      'autonomy_level: L1',
      'max_autonomy_level: L2',
      'promotion_requires_human_approval: true',
      'block_ai_attribution: true',
      'blocked_paths: []',
      'notification_channel: ""',
      'review:',
      '  allow_skip_in_ci: true',
      '',
    ].join('\n');
    await fs.writeFile(path.join(repo.dir, '.rea', 'policy.yaml'), policyYaml);

    const res = runHook(repo, {
      REA_SKIP_PUSH_REVIEW: 'ci-opt-in-ok',
      CI: '1',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/PUSH REVIEW GATE SKIPPED/);

    const lines = await readAuditLines(repo.dir);
    const rec = lines.find((r) => r['tool_name'] === 'push.review.skipped');
    expect(rec).toBeDefined();
  });

  it('audit metadata includes OS identity (F2 richer actor)', async () => {
    // Codex F2: skip records must carry an os_identity block so downstream
    // auditors can distinguish a real operator from a forged git-config
    // actor. uid + whoami + hostname + pid + ppid are not forgeable from
    // inside the push process alone.
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'operator@example.test',
    });
    cleanup.push(repo.dir);

    const res = runHook(repo, {
      REA_SKIP_PUSH_REVIEW: 'audit-os-identity',
      PATH: process.env.PATH ?? '',
    });

    expect(res.status).toBe(0);

    const lines = await readAuditLines(repo.dir);
    const rec = lines.find((r) => r['tool_name'] === 'push.review.skipped')!;
    const meta = rec['metadata'] as Record<string, unknown>;
    const osIdentity = meta['os_identity'] as Record<string, unknown>;
    expect(osIdentity).toBeDefined();
    expect(typeof osIdentity['uid']).toBe('string');
    expect((osIdentity['uid'] as string).length).toBeGreaterThan(0);
    expect(typeof osIdentity['whoami']).toBe('string');
    expect((osIdentity['whoami'] as string).length).toBeGreaterThan(0);
    expect(typeof osIdentity['hostname']).toBe('string');
    expect((osIdentity['hostname'] as string).length).toBeGreaterThan(0);
    expect(typeof osIdentity['pid']).toBe('string');
    expect(typeof osIdentity['ppid']).toBe('string');
    expect('tty' in osIdentity).toBe(true);
    expect('ci' in osIdentity).toBe(true);
  });

  it('fires cleanly under the pre-push stdin contract too (argv+ref-list)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      userEmail: 'operator@example.test',
      userName: 'Operator',
    });
    cleanup.push(repo.dir);

    // Simulate git's native pre-push invocation: argv has remote+url, stdin
    // has refspec lines. BUG-008's self-detect synthesizes a CMD; the
    // skip hatch must fire regardless because it's checked BEFORE the CMD
    // branch takes over.
    const prepushLine = `refs/heads/feature ${repo.headSha} refs/heads/main ${repo.mergeBaseSha}\n`;
    const res = spawnSync(
      'bash',
      [installedHookPath(repo.dir), 'origin', 'git@example.test:foo/bar.git'],
      {
        cwd: repo.dir,
        env: {
          ...process.env,
          REA_SKIP_PUSH_REVIEW: 'native-pre-push-skip',
          CLAUDE_PROJECT_DIR: repo.dir,
          // GitHub Actions sets CI=true; spreading process.env would trip
          // the F2 CI-aware refusal branch. This test exercises the native
          // pre-push contract, not CI behavior — explicitly unset CI.
          CI: '',
        },
        input: prepushLine,
        encoding: 'utf8',
      },
    );

    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/PUSH REVIEW GATE SKIPPED/);

    const lines = await readAuditLines(repo.dir);
    const rec = lines.find((r) => r['tool_name'] === 'push.review.skipped');
    expect(rec).toBeDefined();
    const meta = rec!['metadata'] as Record<string, unknown>;
    expect(meta['reason']).toBe('native-pre-push-skip');
  });
});

describe('dist/audit/append.js presence (sanity)', () => {
  it('is built — tests will only be meaningful when the dist exists', async () => {
    const exists = await fs
      .access(DIST_AUDIT_PATH)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });
});
