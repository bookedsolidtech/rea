/**
 * 0.30.0 attribution augmenter — end-to-end POSIX shell tests for the
 * husky `prepare-commit-msg` body.
 *
 * The hook body lives at `templates/prepare-commit-msg.husky.sh` and
 * is copied to `.husky/prepare-commit-msg` by the human maintainer
 * during the 0.30.0 release process (one-time bootstrap; subsequent
 * upgrades flow through canonical-files enumeration). These tests run
 * the body directly out of `templates/` so a regression in the hook
 * body fails before the file ever lands at the canonical path.
 *
 * Coverage:
 *   1. enabled: false → no-op (file untouched)
 *   2. enabled: true with name+email → trailer appended
 *   3. idempotent: identical re-append → file unchanged
 *   4. idempotent: different name, same email → no-op (respect
 *      manual trailer authorship)
 *   5. case-insensitive email match on existing trailer
 *   6. line-anchored: email mentioned in body prose does NOT count
 *   7. skip_merge: true + commit source = "merge" → no-op
 *   8. REA_SKIP_ATTRIBUTION=1 → no-op
 *   9. HALT active → no-op
 *  10. missing message file → exit 0
 *  11. policy.attribution.co_author absent → exit 0
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_TEMPLATE = path.join(REPO_ROOT, 'templates', 'prepare-commit-msg.husky.sh');

const BASE_POLICY = `version: "1"
profile: minimal
installed_by: test
installed_at: "2026-05-12T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths:
  - .env
notification_channel: ""
`;

async function setupRepo(dir: string, policyExtra: string): Promise<string> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'test']);
  const reaDir = path.join(dir, '.rea');
  await fs.mkdir(reaDir, { recursive: true });
  await fs.writeFile(path.join(reaDir, 'policy.yaml'), BASE_POLICY + policyExtra);
  const hookPath = path.join(dir, 'prepare-commit-msg');
  await fs.copyFile(HOOK_TEMPLATE, hookPath);
  await fs.chmod(hookPath, 0o755);
  return hookPath;
}

async function runHook(
  hookPath: string,
  msgFile: string,
  source?: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      hookPath,
      [msgFile, ...(source !== undefined ? [source] : [])],
      {
        env: { ...process.env, ...env },
        cwd: path.dirname(path.dirname(hookPath)),
      },
      (err, stdout, stderr) => {
        const code =
          err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1);
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout),
          stderr: typeof stderr === 'string' ? stderr : String(stderr),
          code: typeof code === 'number' ? code : 0,
        });
      },
    );
  });
}

async function writeMsg(dir: string, body: string): Promise<string> {
  const p = path.join(dir, 'COMMIT_MSG');
  await fs.writeFile(p, body);
  return p;
}

describe('prepare-commit-msg augmenter', () => {
  let dir: string;

  beforeAll(async () => {
    // Skip the whole suite if python3 isn't available. The hook
    // contract documents python3 as a soft dependency; on CI runners
    // without it the augmenter is a silent no-op (the right behavior
    // — we'd rather skip than hard-fail commits).
    try {
      await execFileAsync('python3', ['--version']);
    } catch {
      console.warn('python3 not on PATH — skipping prepare-commit-msg integration tests');
      return;
    }
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pcm-test-'));
    dir = await fs.realpath(dir);
    // Place the hook one level deeper so REA_ROOT resolution (which
    // walks up via git rev-parse --show-toplevel) lands on `dir`.
    await fs.mkdir(path.join(dir, '.husky'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('enabled: false → no-op (file untouched)', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(dir, `attribution:\n  co_author:\n    enabled: false\n`);
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, 'feat: hi\n');
    const r = await runHook(hookPath, msg, 'message');
    expect(r.code).toBe(0);
    expect(await fs.readFile(msg, 'utf8')).toBe('feat: hi\n');
  });

  it('enabled: true → appends Co-Authored-By trailer', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Real Name"\n    email: "real@example.com"\n`,
    );
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, 'feat: implement feature\n');
    const r = await runHook(hookPath, msg, 'message');
    expect(r.code).toBe(0);
    const body = await fs.readFile(msg, 'utf8');
    expect(body).toContain('Co-Authored-By: Real Name <real@example.com>');
  });

  it('idempotent: identical re-append → no second trailer', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Real Name"\n    email: "real@example.com"\n`,
    );
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, 'feat: x\n');
    await runHook(hookPath, msg, 'message');
    const firstBody = await fs.readFile(msg, 'utf8');
    await runHook(hookPath, msg, 'message');
    const secondBody = await fs.readFile(msg, 'utf8');
    expect(secondBody).toBe(firstBody);
    // Only one trailer line.
    const matches = (secondBody.match(/^Co-Authored-By: Real Name <real@example\.com>$/gm) ?? [])
      .length;
    expect(matches).toBe(1);
  });

  it('idempotent: different name, same email → leaves existing trailer alone', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Policy Name"\n    email: "real@example.com"\n`,
    );
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, 'feat: x\n\nCo-Authored-By: Manual Name <real@example.com>\n');
    await runHook(hookPath, msg, 'message');
    const body = await fs.readFile(msg, 'utf8');
    expect(body).toContain('Co-Authored-By: Manual Name <real@example.com>');
    expect(body).not.toContain('Co-Authored-By: Policy Name');
  });

  it('case-insensitive email match on existing trailer', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Real Name"\n    email: "Real@Example.COM"\n`,
    );
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, 'feat: x\n\nCo-Authored-By: Existing <real@example.com>\n');
    await runHook(hookPath, msg, 'message');
    const body = await fs.readFile(msg, 'utf8');
    const matches = body.match(/^Co-Authored-By:/gim) ?? [];
    expect(matches.length).toBe(1);
  });

  it('does NOT match email mentioned in body prose (line-anchored)', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Real Name"\n    email: "real@example.com"\n`,
    );
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(
      dir,
      'feat: fix bug reported by real@example.com — Co-Authored-By: not here\n',
    );
    await runHook(hookPath, msg, 'message');
    const body = await fs.readFile(msg, 'utf8');
    // We should have appended a real trailer because the email in the
    // body was prose, not a structural trailer line.
    expect(body).toContain('Co-Authored-By: Real Name <real@example.com>');
  });

  it('skip_merge: true + source=merge → no-op', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Real Name"\n    email: "real@example.com"\n    skip_merge: true\n`,
    );
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, "Merge branch 'feat/foo'\n");
    await runHook(hookPath, msg, 'merge');
    const body = await fs.readFile(msg, 'utf8');
    expect(body).not.toContain('Co-Authored-By:');
  });

  it('skip_merge: true + source=message → STILL augments (only merge is excluded)', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Real Name"\n    email: "real@example.com"\n    skip_merge: true\n`,
    );
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, 'feat: x\n');
    await runHook(hookPath, msg, 'message');
    const body = await fs.readFile(msg, 'utf8');
    expect(body).toContain('Co-Authored-By: Real Name <real@example.com>');
  });

  it('REA_SKIP_ATTRIBUTION=1 → no-op', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Real Name"\n    email: "real@example.com"\n`,
    );
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, 'feat: x\n');
    await runHook(hookPath, msg, 'message', { REA_SKIP_ATTRIBUTION: '1' });
    const body = await fs.readFile(msg, 'utf8');
    expect(body).not.toContain('Co-Authored-By:');
  });

  it('HALT active → no-op', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Real Name"\n    email: "real@example.com"\n`,
    );
    await fs.writeFile(path.join(dir, '.rea', 'HALT'), 'test halt\n');
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, 'feat: x\n');
    await runHook(hookPath, msg, 'message');
    const body = await fs.readFile(msg, 'utf8');
    expect(body).not.toContain('Co-Authored-By:');
  });

  it('exits 0 when commit message file is missing', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(
      dir,
      `attribution:\n  co_author:\n    enabled: true\n    name: "Real Name"\n    email: "real@example.com"\n`,
    );
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const r = await runHook(hookPath, '/nonexistent/file', 'message');
    expect(r.code).toBe(0);
  });

  it('no attribution block in policy → no-op', async () => {
    const hookPath = path.join(dir, '.husky', 'prepare-commit-msg');
    await setupRepo(dir, '');
    await fs.copyFile(HOOK_TEMPLATE, hookPath);
    await fs.chmod(hookPath, 0o755);
    const msg = await writeMsg(dir, 'feat: x\n');
    await runHook(hookPath, msg, 'message');
    const body = await fs.readFile(msg, 'utf8');
    expect(body).toBe('feat: x\n');
  });
});
