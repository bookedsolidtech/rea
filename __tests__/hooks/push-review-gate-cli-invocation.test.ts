/**
 * Regression test for 0.9.2: push-review cache CLI invocation.
 *
 * Bug (pre-0.9.2):
 *   hooks/_lib/push-review-core.sh resolved the rea CLI by testing
 *   `[[ -f "${REA_ROOT}/node_modules/.bin/rea" ]]` and, on match, invoking
 *   `node "${REA_ROOT}/node_modules/.bin/rea" cache check ...`.
 *
 *   node_modules/.bin/rea is NOT a plain JavaScript file. pnpm writes a POSIX
 *   shell-script shim there (`#!/bin/sh ... exec node .../dist/cli/index.js`);
 *   npm writes a symlink whose target has its own `#!/usr/bin/env node`
 *   shebang. Running `node` on a shell shim parses shell syntax as JS and
 *   throws `SyntaxError`. The hook's `|| echo '{"hit":false}'` fallback
 *   masked the error, but the cache lookup silently failed on every push —
 *   meaning a previously-approved push diff never hit the cache, section 9
 *   always blocked with "REVIEW REQUIRED", and consumers (especially
 *   pnpm-installed ones) saw every push blocked even after a passing Codex
 *   review.
 *
 * Fix (0.9.2):
 *   Guard on `-x` (executable) and execute the shim directly — no `node`
 *   prefix. The dogfood fallback (dist/cli/index.js) keeps the `node` prefix
 *   because it IS a plain JS module.
 *
 * This test drives the real push-review-gate.sh against a scratch repo with
 * a pnpm-style shell shim at node_modules/.bin/rea and a valid push-review
 * cache entry. Post-fix the hook must exit 0 (cache hit). Pre-fix it exited
 * 2 because `node <shim>` threw SyntaxError → cache miss → section 9 blocked.
 *
 * A second test covers the dogfood fallback path: no node_modules/.bin/rea,
 * only dist/cli/index.js — the `node` prefix MUST still be applied (the
 * dist entry is a real JS module, not a shim).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');
const DIST_CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');

/**
 * Mirror the installed topology: hook at `.claude/hooks/push-review-gate.sh`,
 * shared core at `.claude/hooks/_lib/push-review-core.sh`, policy at
 * `.rea/policy.yaml` so the hook's REA_ROOT anchor walk-up resolves here.
 */
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
  bareRemote: string;
}

/**
 * Scratch repo with a NON-protected-path diff (src/__test__.ts) so the
 * protected-path Codex-review gate (section 7 of push-review-core.sh)
 * passes and the push-review CACHE lookup (section 8) actually runs —
 * which is the code path this regression test targets. Links dist/audit,
 * dist/policy, and dist/cache so the hook's helpers are reachable.
 * Intentionally does NOT link dist/cli — each test case wires the CLI
 * under test (shim OR dist fallback) explicitly so the contrast between
 * the two paths is clear.
 */
async function makeScratchRepo(): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-cli-invoke-test-')),
  );

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '--initial-branch=main', '--quiet');
  git('config', 'user.email', 'cli-invoke@example.test');
  git('config', 'user.name', 'CLI Invoke');
  git('config', 'commit.gpgsign', 'false');

  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n');
  git('add', 'README.md');
  git('commit', '-m', 'baseline', '--quiet');
  const mergeBaseSha = git('rev-parse', 'HEAD');

  const bareRemote = path.join(dir, '..', path.basename(dir) + '.git');
  execFileSync(
    'git',
    ['init', '--bare', '--initial-branch=main', '--quiet', bareRemote],
    { encoding: 'utf8' },
  );
  git('remote', 'add', 'origin', bareRemote);
  git('push', 'origin', 'main', '--quiet');

  git('checkout', '-b', 'feature', '--quiet');
  // Touch a NON-protected path so section 7 (protected-paths Codex gate)
  // passes and section 8's cache lookup actually runs. The push-review
  // gate still fires on section 9 (general review required) — the cache
  // is the only way to reach exit 0, which is exactly what we are testing.
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src', '__test__.ts'),
    'export const scratch = 1;\n',
  );
  git('add', 'src/__test__.ts');
  git('commit', '-m', 'touch non-protected path', '--quiet');
  const headSha = git('rev-parse', 'HEAD');

  // Link the helpers the hook always needs: audit/append.js and the policy
  // loader. Leave dist/cli to the per-test wiring.
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.symlink(
    path.join(REPO_ROOT, 'dist', 'audit'),
    path.join(dir, 'dist', 'audit'),
  );
  await fs.symlink(
    path.join(REPO_ROOT, 'dist', 'policy'),
    path.join(dir, 'dist', 'policy'),
  );
  await fs.symlink(
    path.join(REPO_ROOT, 'dist', 'cache'),
    path.join(dir, 'dist', 'cache'),
  );

  await installPushHook(dir);

  return { dir, headSha, mergeBaseSha, bareRemote };
}

/**
 * Compute the push-review cache key the same way the hook does:
 *   DIFF_FULL=$(git diff "${MERGE_BASE}..${SOURCE_SHA}")
 *   PUSH_SHA=$(printf '%s' "$DIFF_FULL" | shasum -a 256 | cut -d' ' -f1)
 * Bash's `$(...)` strips trailing newlines, so we do the same.
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
 * Seed `.rea/review-cache.jsonl` with a `pass` entry keyed on the
 * scratch repo's diff. This matches the serialization
 * {@link import('../../src/cache/review-cache.ts')} uses.
 */
async function populatePushReviewCache(repo: ScratchRepo): Promise<string> {
  const sha = computeDiffSha(repo);
  const entry = {
    sha,
    branch: 'feature',
    base: 'main',
    result: 'pass',
    recorded_at: new Date().toISOString(),
  };
  const cacheFile = path.join(repo.dir, '.rea', 'review-cache.jsonl');
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(entry) + '\n');
  return sha;
}

/**
 * Install a pnpm-style POSIX shell shim at `node_modules/.bin/rea` that
 * exec's the real dist CLI. This is the exact shape pnpm writes in a real
 * consumer install (see node_modules/.bin/tsc in this very repo). Running
 * `node` on this file would parse shell syntax as JavaScript and throw
 * SyntaxError — the bug. Running it directly works.
 *
 * We use a shell wrapper (rather than symlinking straight to index.js)
 * because that IS the pnpm-shaped artifact we are testing against.
 */
async function installPnpmStyleShim(repo: ScratchRepo): Promise<string> {
  const binDir = path.join(repo.dir, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'rea');
  const shim = [
    '#!/bin/sh',
    '# pnpm-style launcher shim — bug repro: `node <this-file>` SyntaxError\'s.',
    `exec node ${JSON.stringify(DIST_CLI_PATH)} "$@"`,
    '',
  ].join('\n');
  await fs.writeFile(shimPath, shim);
  await fs.chmod(shimPath, 0o755);
  return shimPath;
}

/**
 * Install an npm-style symlink at `node_modules/.bin/rea` pointing at a
 * real JS file with its own `#!/usr/bin/env node` shebang. This is the
 * exact shape npm writes in a real consumer install: an executable
 * symlink whose target is loader JS, NOT a shell shim.
 *
 * The npm shape happens to tolerate the OLD `node <file>` form (node
 * treats the shebang line as a comment). It does NOT tolerate the old
 * `-f` guard if the execute bit has been stripped from the target —
 * the new `-x` guard resolves across the symlink to the target file.
 * We pin this as a positive-path test to prove the fix is uniform
 * across both package-manager shapes.
 */
async function installNpmStyleSymlink(repo: ScratchRepo): Promise<string> {
  const binDir = path.join(repo.dir, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  // npm-style: symlink from .bin/rea → a relative path inside the package.
  // We create a sibling target that mirrors the shape (JS with node shebang)
  // and symlink to it, so the executable-target resolution mirrors npm's.
  const pkgDir = path.join(repo.dir, 'node_modules', '@bookedsolid', 'rea', 'dist', 'cli');
  await fs.mkdir(pkgDir, { recursive: true });
  const targetJs = path.join(pkgDir, 'index.js');
  // Minimal faithful stand-in: delegates to the real dist CLI. The hook
  // execs this directly; the shebang line ensures it runs under node.
  const loader = [
    '#!/usr/bin/env node',
    `import(${JSON.stringify(DIST_CLI_PATH)});`,
    '',
  ].join('\n');
  await fs.writeFile(targetJs, loader);
  await fs.chmod(targetJs, 0o755);

  const shimPath = path.join(binDir, 'rea');
  // Use a RELATIVE symlink — npm writes relative paths so node_modules
  // can be moved or mounted. `-x` on a symlink checks the target's
  // executable bit, so the chmod above is the one that matters.
  const relTarget = path.relative(binDir, targetJs);
  await fs.symlink(relTarget, shimPath);
  return shimPath;
}

/**
 * Install the dogfood fallback: no node_modules/.bin/rea, only
 * `dist/cli/index.js`. Symlink to the real one so the node invocation
 * actually executes.
 */
async function installDistFallback(repo: ScratchRepo): Promise<void> {
  // dist/ already exists from makeScratchRepo; symlink cli/ in.
  await fs.symlink(
    path.join(REPO_ROOT, 'dist', 'cli'),
    path.join(repo.dir, 'dist', 'cli'),
  );
  // Ensure node_modules/.bin/rea is ABSENT so the shim branch is skipped.
  const maybeShim = path.join(repo.dir, 'node_modules', '.bin', 'rea');
  try {
    await fs.rm(maybeShim);
  } catch {
    /* already absent */
  }
}

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(repo: ScratchRepo, env: NodeJS.ProcessEnv): HookResult {
  const res = spawnSync('bash', [installedHookPath(repo.dir)], {
    cwd: repo.dir,
    env: { ...env, CLAUDE_PROJECT_DIR: repo.dir },
    input: toolInput('git push origin feature:main'),
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function jqExists(): boolean {
  const res = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

describe('push-review-gate.sh — rea CLI invocation (0.9.2 regression)', () => {
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

  it('pnpm-style shell shim at node_modules/.bin/rea is executed directly (no `node` prefix) and the cache lookup succeeds', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo();
    track(repo);

    await installPnpmStyleShim(repo);
    await populatePushReviewCache(repo);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    // Pre-fix: hook exited 2 because `node <shim>` threw SyntaxError,
    // the `|| echo '{"hit":false}'` fallback kicked in, and section 9
    // blocked with "REVIEW REQUIRED". Post-fix: the shim is exec'd
    // directly, cache hit is detected, the hook exits 0.
    expect(res.status).toBe(0);

    // Belt-and-braces: if the bug ever regresses in a subtler form (e.g.
    // the shim executes but the output is polluted by `SyntaxError: ...`
    // text on stderr that leaks into the caller), catch it here. The
    // gate writes a "REVIEW REQUIRED" banner to stderr on block; a
    // clean pass never does.
    expect(res.stderr).not.toMatch(/SyntaxError/);
    expect(res.stderr).not.toMatch(/REVIEW REQUIRED/);
  });

  it('dogfood fallback — no node_modules/.bin/rea, only dist/cli/index.js — is invoked with the `node` prefix and still resolves', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo();
    track(repo);

    await installDistFallback(repo);
    await populatePushReviewCache(repo);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    // Same contract as the shim path: cache hit → exit 0. The difference
    // is purely which branch of the `if [[ -x ... ]] / elif [[ -f ... ]]`
    // ladder fires.
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/REVIEW REQUIRED/);
  });

  it('npm-style symlink at node_modules/.bin/rea resolves via the same `-x` branch and cache lookup succeeds', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo();
    track(repo);

    await installNpmStyleSymlink(repo);
    await populatePushReviewCache(repo);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    // npm symlinks point at a JS file with `#!/usr/bin/env node`. The old
    // `node <symlink>` form would technically work for this shape (node
    // ignores the shebang), but the new direct-exec form works too — and
    // is the uniform path we want for both pnpm and npm shapes. Verify
    // the cache hit fires.
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/REVIEW REQUIRED/);
  });

  it('non-executable node_modules/.bin/rea is NOT invoked (guards against the old -f check)', async () => {
    // The old code used `-f` (regular file) — which would match a shim
    // whose execute bit had been clobbered by a careless `chmod`. That
    // invocation would then fail inside `"${REA_CLI_ARGS[@]}"` with a
    // "permission denied" error. The new `-x` guard skips the shim in
    // that case and falls through to the dist branch, so the cache
    // lookup still works. This test pins that behavior.
    if (!jqExists()) return;

    const repo = await makeScratchRepo();
    track(repo);

    // Install a non-executable shim, then also install the dist fallback
    // so the elif branch has something to resolve to.
    const shimPath = await installPnpmStyleShim(repo);
    await fs.chmod(shimPath, 0o644); // strip execute bit
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', 'cli'),
      path.join(repo.dir, 'dist', 'cli'),
    );
    await populatePushReviewCache(repo);

    const res = runHook(repo, { PATH: process.env.PATH ?? '' });

    // The dist fallback should resolve; cache hit; exit 0. If the hook
    // had tried to exec the non-executable shim (old `-f` check), we
    // would get an EACCES-flavoured failure surfaced via the fallback
    // to `{hit:false}` and ultimately a status 2.
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/permission denied/i);
    expect(res.stderr).not.toMatch(/REVIEW REQUIRED/);
  });
});
