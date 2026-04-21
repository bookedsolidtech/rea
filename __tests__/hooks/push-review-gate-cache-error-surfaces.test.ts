/**
 * Defect F (rea#78) regression test — distinguish cache-miss from cache-error.
 *
 * Background: hooks/_lib/push-review-core.sh ran:
 *
 *     CACHE_RESULT=$(... cache check ... 2>/dev/null || echo '{"hit":false}')
 *
 * This swallowed stderr and any non-zero exit, treating SyntaxError, missing
 * dist/, or jq failure identically to "cold cache miss". Defect A (0.9.2's
 * node-on-shim bug) was hidden for weeks by exactly this pattern.
 *
 * Fix: split stdout/stderr capture and surface a "CACHE CHECK FAILED" banner
 * on stderr when the CLI exits non-zero. The gate still falls through to
 * `hit:false` so pushes are not silently wedged, but errors are visible.
 *
 * Harness pattern mirrors push-review-gate-cli-invocation.test.ts:
 * scratch repo with a deliberately broken rea shim whose only job is to
 * exit 1 and emit a recognizable stderr line.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');

async function installPushHook(dir: string): Promise<string> {
  const destDir = path.join(dir, '.claude', 'hooks');
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, 'push-review-gate.sh');
  await fs.copyFile(HOOK_SRC, dest);
  await fs.chmod(dest, 0o755);

  const libDir = path.join(destDir, '_lib');
  await fs.mkdir(libDir, { recursive: true });
  const coreSrc = path.join(REPO_ROOT, 'hooks', '_lib', 'push-review-core.sh');
  const coreDest = path.join(libDir, 'push-review-core.sh');
  await fs.copyFile(coreSrc, coreDest);
  await fs.chmod(coreDest, 0o755);

  const policyDir = path.join(dir, '.rea');
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, 'policy.yaml'),
    'profile: minimal\nautonomy_level: L1\n',
  );
  return dest;
}

interface ScratchRepo {
  dir: string;
  bareRemote: string;
}

async function makeScratchRepo(): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-cache-err-test-')),
  );
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '--initial-branch=main', '--quiet');
  git('config', 'user.email', 'cache-err@example.test');
  git('config', 'user.name', 'Cache Err');
  git('config', 'commit.gpgsign', 'false');

  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n');
  git('add', 'README.md');
  git('commit', '-m', 'baseline', '--quiet');

  const bareRemote = path.join(dir, '..', path.basename(dir) + '.git');
  execFileSync(
    'git',
    ['init', '--bare', '--initial-branch=main', '--quiet', bareRemote],
    { encoding: 'utf8' },
  );
  git('remote', 'add', 'origin', bareRemote);
  git('push', 'origin', 'main', '--quiet');

  git('checkout', '-b', 'feature', '--quiet');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'x.ts'), 'export const y = 1;\n');
  git('add', 'src/x.ts');
  git('commit', '-m', 'touch non-protected path', '--quiet');

  // Link helpers the hook uses OTHER than cli.
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  for (const sub of ['audit', 'policy', 'cache']) {
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', sub),
      path.join(dir, 'dist', sub),
    );
  }

  await installPushHook(dir);
  return { dir, bareRemote };
}

async function installBrokenShim(repo: ScratchRepo, exitCode = 1): Promise<void> {
  const binDir = path.join(repo.dir, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'rea');
  const shim = [
    '#!/bin/sh',
    '# Deliberately broken rea shim — for Defect F regression test.',
    "echo 'rea: boom (simulated failure)' >&2",
    `exit ${exitCode}`,
    '',
  ].join('\n');
  await fs.writeFile(shimPath, shim);
  await fs.chmod(shimPath, 0o755);
}

function runHook(repo: ScratchRepo, env: NodeJS.ProcessEnv): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync('bash', [path.join(repo.dir, '.claude', 'hooks', 'push-review-gate.sh')], {
    cwd: repo.dir,
    env: { ...env, CLAUDE_PROJECT_DIR: repo.dir },
    input: JSON.stringify({ tool_input: { command: 'git push origin feature:main' } }),
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function jqExists(): boolean {
  return spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
}

describe('push-review-gate — cache-error surfaces distinctly from cache-miss (Defect F)', () => {
  let scratchPaths: string[] = [];

  beforeEach(() => {
    scratchPaths = [];
  });

  afterEach(async () => {
    await Promise.all(
      scratchPaths.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('prints CACHE CHECK FAILED on stderr when rea CLI exits non-zero', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo();
    scratchPaths.push(repo.dir);
    scratchPaths.push(repo.bareRemote);

    await installBrokenShim(repo, 1);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    // The gate must surface the failure on stderr.
    expect(res.stderr).toMatch(/CACHE CHECK FAILED/);
    // And preserve the original CLI stderr text so operators can diagnose.
    expect(res.stderr).toMatch(/rea: boom/);
  });

  it('does not print CACHE CHECK FAILED on a cold miss (distinct signals)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo();
    scratchPaths.push(repo.dir);
    scratchPaths.push(repo.bareRemote);

    // Install a shim that simulates a normal miss: exit 0, print {"hit":false}.
    const binDir = path.join(repo.dir, 'node_modules', '.bin');
    await fs.mkdir(binDir, { recursive: true });
    const shimPath = path.join(binDir, 'rea');
    await fs.writeFile(
      shimPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "cache" ] && [ "$2" = "check" ]; then',
        "  echo '{\"hit\":false}'",
        '  exit 0',
        'fi',
        '# Any other subcommand: exit success with no output.',
        'exit 0',
        '',
      ].join('\n'),
    );
    await fs.chmod(shimPath, 0o755);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    expect(res.stderr).not.toMatch(/CACHE CHECK FAILED/);
  });
});
