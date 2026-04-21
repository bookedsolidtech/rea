/**
 * Integration tests for BUG-008: `hooks/push-review-gate.sh` self-detects
 * git's native pre-push stdin contract.
 *
 * Background: through 0.4.0, the hook only parsed Claude-Code JSON stdin
 * (`.tool_input.command`). When wired into `.husky/pre-push`, git sends
 * ref-list lines as stdin and positional remote/url as argv. The jq parse
 * produced an empty CMD, `if [[ -z "$CMD" ]]; then exit 0; fi` fired, and
 * the gate silently became a no-op. Every consumer that ran `rea init` on
 * 0.3.x/0.4.0 had a broken pre-push gate.
 *
 * 0.5.0 adds a sniff: when jq returns empty AND the first non-blank stdin
 * line matches the pre-push `<ref> <sha> <ref> <sha>` shape, CMD is
 * synthesized as `git push <argv $1>` and the existing step-6 pre-push
 * parser handles the rest. This test asserts the sniff activates, the
 * existing argv flow still works (regression guard), and random stdin
 * still exits 0.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');

// BUG-012 (0.6.2): hook anchors REA_ROOT via script-on-disk location.
// Install into `<repoDir>/.claude/hooks/` and invoke from there.
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

interface ScratchRepo {
  dir: string;
  featureSha: string;
  mainSha: string;
}

/**
 * A scratch repo with two commits: baseline on `main`, and a second
 * commit on `feature` touching `hooks/__test__.sh` (a protected path).
 */
async function makeRepo(): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-push-gate-prepush-')),
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
  const mainSha = git('rev-parse', 'HEAD');

  git('checkout', '-b', 'feature', '--quiet');
  await fs.mkdir(path.join(dir, 'hooks'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'hooks', '__test__.sh'),
    '#!/bin/bash\necho scratch\n',
  );
  git('add', 'hooks/__test__.sh');
  git('commit', '-m', 'touch protected path', '--quiet');
  const featureSha = git('rev-parse', 'HEAD');

  // A fake remote ref so merge-base resolves against something other than
  // HEAD. We simulate git's ref-list by writing to refs/remotes/origin/main.
  await fs.mkdir(path.join(dir, '.git', 'refs', 'remotes', 'origin'), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'),
    `${mainSha}\n`,
  );

  await installPushHook(dir);

  return { dir, featureSha, mainSha };
}

function jqExists(): boolean {
  const res = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

describe('push-review-gate.sh — BUG-008 pre-push stdin self-detect', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanup.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('blocks a push when invoked with git-native pre-push stdin + argv', async () => {
    if (!jqExists()) return;

    const repo = await makeRepo();
    cleanup.push(repo.dir);

    // Synthesize git's pre-push stdin contract:
    //   `<local_ref> <local_sha> <remote_ref> <remote_sha>`
    const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;

    const res = spawnSync('bash', [installedHookPath(repo.dir), 'origin', 'git@example.test:foo/bar.git'], {
      cwd: repo.dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
      input: prepushLine,
      encoding: 'utf8',
    });

    // With a protected-path diff and no Codex record, the gate must block.
    // That proves the stdin was picked up — a pre-BUG-008 script would have
    // exited 0 on the empty-jq-parse early return.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed|PUSH REVIEW GATE/);
  });

  it('falls through to exit 0 on unrelated stdin (no jq match, no pre-push shape)', async () => {
    if (!jqExists()) return;

    const repo = await makeRepo();
    cleanup.push(repo.dir);

    const res = spawnSync('bash', [installedHookPath(repo.dir)], {
      cwd: repo.dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
      input: 'not-a-tool-call\nnot-pre-push-format\n',
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
  });

  it('regression: Claude-Code JSON stdin path still works (tool_input.command)', async () => {
    if (!jqExists()) return;

    const repo = await makeRepo();
    cleanup.push(repo.dir);

    const json = JSON.stringify({ tool_input: { command: 'git push origin feature:main' } });
    const res = spawnSync('bash', [installedHookPath(repo.dir)], {
      cwd: repo.dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
      input: json,
      encoding: 'utf8',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed|PUSH REVIEW GATE/);
  });

  it('regression: non-git-push JSON command still exits 0', async () => {
    if (!jqExists()) return;

    const repo = await makeRepo();
    cleanup.push(repo.dir);

    const json = JSON.stringify({ tool_input: { command: 'ls -la' } });
    const res = spawnSync('bash', [installedHookPath(repo.dir)], {
      cwd: repo.dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
      input: json,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
  });

  it('push_review: false policy does NOT bypass the gate under pre-push stdin (0.9.3 Defect B)', async () => {
    if (!jqExists()) return;

    // Pre-0.9.3 this policy line short-circuited the gate to exit 0. The
    // bypass was unauditable — any process able to write `.rea/policy.yaml`
    // could silence the gate. Post-0.9.3 the grep bypass is removed; the
    // only supported escape hatch is the env-var `REA_SKIP_PUSH_REVIEW`
    // which writes a `push.review.skipped` audit record.
    const repo = await makeRepo();
    cleanup.push(repo.dir);

    await fs.mkdir(path.join(repo.dir, '.rea'), { recursive: true });
    await fs.writeFile(
      path.join(repo.dir, '.rea', 'policy.yaml'),
      'push_review: false\n',
    );

    const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;
    const res = spawnSync('bash', [installedHookPath(repo.dir), 'origin'], {
      cwd: repo.dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
      input: prepushLine,
      encoding: 'utf8',
    });

    // The gate must run past the (now-removed) grep short-circuit. The
    // feature diff in this fixture touches a protected path (under
    // `hooks/`), so the Codex protected-path banner fires — confirmation
    // that control reached the protected-path matcher, not the deleted §5
    // exit. A specific banner assertion (not just `not.toBe(0)`) blocks
    // future accidental regressions that would exit non-zero for an
    // unrelated reason.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
    expect(res.stderr).toMatch(/codex-review required/);
  });
});
