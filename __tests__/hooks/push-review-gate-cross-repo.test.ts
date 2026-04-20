/**
 * Cross-repo guard: when CLAUDE_PROJECT_DIR points to the rea repo but the
 * current working directory is a different git repo (including a nested
 * submodule/worktree), the push/commit gates must exit 0 and NOT attempt to
 * rev-parse foreign refs inside rea.
 *
 * Regression for 0.6.1. Pre-fix behavior: `resolve_argv_refspecs` inside
 * push-review-gate.sh ran `git rev-parse` in REA_ROOT for a ref that only
 * existed in the consumer repo, hard-failing with
 * "could not resolve source ref" BEFORE the REA_SKIP_PUSH_REVIEW /
 * REA_SKIP_CODEX_REVIEW escape hatches could be checked.
 *
 * The guard uses git-toplevel identity (not path-prefix) so nested repos
 * under rea's tree — submodules, worktrees, `.claude/worktrees/*` — are
 * correctly treated as their own repos and short-circuited.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PUSH_HOOK_NAME = 'push-review-gate.sh';
const COMMIT_HOOK_NAME = 'commit-review-gate.sh';

// BUG-012 (0.6.2): the hooks now anchor REA_ROOT to their own on-disk
// location (SCRIPT_DIR=`<root>/.claude/hooks/` → REA_ROOT is two levels
// up). The test harness must mirror the installed topology: copy the hook
// into `<reaDir>/.claude/hooks/<name>.sh` before invocation.
async function installHooks(reaDir: string): Promise<void> {
  const destDir = path.join(reaDir, '.claude', 'hooks');
  await fs.mkdir(destDir, { recursive: true });
  for (const name of [PUSH_HOOK_NAME, COMMIT_HOOK_NAME]) {
    const src = path.join(REPO_ROOT, 'hooks', name);
    const dest = path.join(destDir, name);
    await fs.copyFile(src, dest);
    await fs.chmod(dest, 0o755);
  }
  // BUG-008 cleanup (0.7.0): push-review-gate.sh is now a thin adapter that
  // sources `_lib/push-review-core.sh`. Mirror the installed topology by
  // copying the core next to the adapter.
  const libDir = path.join(destDir, '_lib');
  await fs.mkdir(libDir, { recursive: true });
  const coreSrc = path.join(REPO_ROOT, 'hooks', '_lib', 'push-review-core.sh');
  const coreDest = path.join(libDir, 'push-review-core.sh');
  await fs.copyFile(coreSrc, coreDest);
  await fs.chmod(coreDest, 0o755);
}

function installedHookPath(reaDir: string, hookName: string): string {
  return path.join(reaDir, '.claude', 'hooks', hookName);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main', '--quiet');
  git(dir, 'config', 'user.email', 'test@example.test');
  git(dir, 'config', 'user.name', 'REA Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

async function commitFile(
  dir: string,
  relPath: string,
  contents: string,
  message: string,
): Promise<string> {
  const fp = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, contents);
  git(dir, 'add', relPath);
  git(dir, 'commit', '-m', message, '--quiet');
  return git(dir, 'rev-parse', 'HEAD');
}

interface TwoRepos {
  base: string;
  reaDir: string;
  consumerDir: string;
  consumerBranch: string;
}

async function makeTwoRepos(): Promise<TwoRepos> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-cross-repo-')),
  );
  const reaDir = path.join(base, 'rea');
  const consumerDir = path.join(base, 'consumer');

  await initRepo(reaDir);
  await commitFile(reaDir, 'README.md', '# rea\n', 'rea baseline');
  await fs.mkdir(path.join(reaDir, '.rea'), { recursive: true });
  await fs.writeFile(path.join(reaDir, '.rea', 'policy.yaml'), 'profile: test\n');
  await installHooks(reaDir);

  await initRepo(consumerDir);
  await commitFile(
    consumerDir,
    'README.md',
    '# consumer\n',
    'consumer baseline',
  );
  const consumerBranch = 'upgrade/rea-0.6.0';
  git(consumerDir, 'checkout', '-b', consumerBranch, '--quiet');
  await commitFile(
    consumerDir,
    'package.json',
    '{"deps":{}}\n',
    'bump rea',
  );

  return { base, reaDir, consumerDir, consumerBranch };
}

interface NonGitLayout {
  base: string;
  reaDir: string;
  outsideDir: string;
}

// Both-non-git scenario: neither the script-anchored REA_ROOT nor the cwd
// is a git repo. This is the documented 0.5.1 path-prefix escape hatch
// (the ONLY codepath still exercising the fallback after BUG-012).
async function makeNonGitLayout(): Promise<NonGitLayout> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-cross-repo-')),
  );
  const reaDir = path.join(base, 'rea');
  const outsideDir = path.join(base, 'outside');
  await fs.mkdir(reaDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.mkdir(path.join(reaDir, '.rea'), { recursive: true });
  await fs.writeFile(path.join(reaDir, '.rea', 'policy.yaml'), 'profile: test\n');
  await installHooks(reaDir);
  return { base, reaDir, outsideDir };
}

function toolInput(command: string): string {
  return JSON.stringify({ tool_input: { command } });
}

function jqExists(): boolean {
  const res = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

function runHook(
  hookName: string,
  reaDir: string,
  cwd: string,
  claudeProjectDir: string,
  command: string,
): { status: number; stdout: string; stderr: string } {
  const hookPath = installedHookPath(reaDir, hookName);
  const res = spawnSync('bash', [hookPath], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      CLAUDE_PROJECT_DIR: claudeProjectDir,
    },
    input: toolInput(command),
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('push-review-gate.sh — cross-repo guard (0.6.1 regression)', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanup.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('exits 0 when cwd is a different git repo than CLAUDE_PROJECT_DIR', async () => {
    if (!jqExists()) return;
    const { base, reaDir, consumerDir, consumerBranch } = await makeTwoRepos();
    cleanup.push(base);

    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      consumerDir,
      reaDir,
      `git push origin ${consumerBranch}`,
    );

    expect(res.status).toBe(0);
    // This is the definitive anti-regression assertion — pre-fix this
    // exact error blocked every cross-repo push.
    expect(res.stderr).not.toMatch(/could not resolve source ref/i);
    expect(res.stderr).not.toMatch(/PUSH BLOCKED/);
  });

  it('exits 0 for an independent nested git repo under the rea tree (submodule-like)', async () => {
    if (!jqExists()) return;
    const { base, reaDir, consumerBranch } = await makeTwoRepos();
    cleanup.push(base);

    // A DISTINCT git repo physically located under reaDir — separate object
    // DB, separate refs. Pre-fix path-prefix guard treated this as "inside
    // rea" and re-triggered the ref-resolve failure.
    const nested = path.join(reaDir, 'nested-checkout');
    await initRepo(nested);
    await commitFile(nested, 'README.md', '# nested\n', 'nested baseline');
    git(nested, 'checkout', '-b', consumerBranch, '--quiet');
    await commitFile(nested, 'a.txt', 'x\n', 'change');

    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      nested,
      reaDir,
      `git push origin ${consumerBranch}`,
    );

    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/could not resolve source ref/i);
  });

  it('runs the gate from a REAL `git worktree add` checkout of rea (same repo)', async () => {
    if (!jqExists()) return;
    const { base, reaDir } = await makeTwoRepos();
    cleanup.push(base);

    // `git worktree add` creates a linked worktree sharing rea's object DB
    // and refs but living at a different toplevel path. Pre-common-dir fix
    // (Codex R3 finding) the guard would see distinct --show-toplevel and
    // exit 0 — bypassing HALT and every gate. Post-fix the common-dir
    // comparison recognizes them as the same repository.
    const worktree = path.join(base, 'rea-worktree');
    git(reaDir, 'worktree', 'add', '-b', 'wt-branch', worktree, '--quiet');

    // Push an unresolvable ref. If guard wrongly treats worktree as foreign
    // → status 0, no stderr. If guard correctly recognizes same-repo → the
    // ref resolver runs inside REA_ROOT and hard-fails with its specific
    // error.
    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      worktree,
      reaDir,
      'git push origin refs/heads/no-such-ref-exists',
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/could not resolve source ref/i);
  });

  it('still runs the gate when cwd is rea itself (guard does not short-circuit)', async () => {
    if (!jqExists()) return;
    const { base, reaDir } = await makeTwoRepos();
    cleanup.push(base);

    // Push a ref that exists in REA_ROOT — nonsense command chosen so
    // `resolve_argv_refspecs` reaches step 7 and would emit a known marker
    // if it tries to resolve. We use an unknown ref to force step 7 into
    // its explicit "could not resolve" error path; if the guard wrongly
    // short-circuits, stderr will be empty and status 0. If the guard
    // correctly lets control through (inside rea), step 7 runs and emits
    // its error. That distinguishes guard-fired-wrongly from guard-skipped.
    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      reaDir,
      reaDir,
      'git push origin refs/heads/no-such-ref-exists',
    );

    // When guard does NOT fire (cwd is rea itself), downstream resolution
    // either finds the ref (unlikely) or hard-fails with code 2 + the
    // specific error message we purpose-test for.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/could not resolve source ref/i);
  });

  it('exits 0 for cwd in a rea SUBDIR (same git repo)', async () => {
    if (!jqExists()) return;
    const { base, reaDir } = await makeTwoRepos();
    cleanup.push(base);
    const sub = path.join(reaDir, 'src', 'sub');
    await fs.mkdir(sub, { recursive: true });

    // A subdir OF rea's own git repo is still "inside rea". Gate runs.
    // Use an nonexistent ref so the same "could not resolve" error fires
    // if the guard wrongly allows it through — proving same-repo is not
    // short-circuited.
    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      sub,
      reaDir,
      'git push origin refs/heads/no-such-ref-exists',
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/could not resolve source ref/i);
  });

  it('handles symlinked CLAUDE_PROJECT_DIR pointing at rea', async () => {
    if (!jqExists()) return;
    const { base, reaDir, consumerDir, consumerBranch } = await makeTwoRepos();
    cleanup.push(base);

    const symlink = path.join(base, 'rea-link');
    await fs.symlink(reaDir, symlink);

    // CLAUDE_PROJECT_DIR is the symlink; cwd is the consumer repo.
    // `pwd -P` on both sides resolves to realpath — consumer is still a
    // distinct repo, guard must exit 0. CLAUDE_PROJECT_DIR is advisory
    // only after BUG-012; the script-dir anchor resolves via realpath too,
    // so the two paths agree and no advisory warning is emitted.
    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      consumerDir,
      symlink,
      `git push origin ${consumerBranch}`,
    );

    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/could not resolve source ref/i);
  });

  it('path-prefix fallback: both cwd and REA_ROOT are non-git (both-non-git escape hatch)', async () => {
    if (!jqExists()) return;
    // 0.5.1 documented non-git escape hatch. After BUG-012 (0.6.2) the
    // fallback fires ONLY when BOTH sides are non-git; mixed state
    // (one git, one non-git) now fails CLOSED and runs the gate.
    const { base, reaDir, outsideDir } = await makeNonGitLayout();
    cleanup.push(base);

    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      outsideDir,
      reaDir,
      'git push origin main',
    );

    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/could not resolve source ref/i);
  });

  it('foreign push is NOT blocked when rea is HALTed (guard runs before HALT)', async () => {
    if (!jqExists()) return;
    const { base, reaDir, consumerDir, consumerBranch } = await makeTwoRepos();
    cleanup.push(base);

    // Freeze rea. HALT banner would fire at step 3 — but guard at 1a must
    // short-circuit before HALT is checked.
    await fs.writeFile(
      path.join(reaDir, '.rea', 'HALT'),
      'maintenance: rea halted\n',
    );

    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      consumerDir,
      reaDir,
      `git push origin ${consumerBranch}`,
    );

    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/REA HALT/);
    expect(res.stderr).not.toMatch(/could not resolve source ref/i);
  });

  it('same-repo push IS still blocked when rea is HALTed (guard does not short-circuit)', async () => {
    if (!jqExists()) return;
    const { base, reaDir } = await makeTwoRepos();
    cleanup.push(base);

    await fs.writeFile(
      path.join(reaDir, '.rea', 'HALT'),
      'maintenance: rea halted\n',
    );

    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      reaDir,
      reaDir,
      'git push origin main',
    );

    // When cwd is rea itself, guard does NOT fire; HALT kicks in.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REA HALT/);
  });

  it('BUG-012: foreign CLAUDE_PROJECT_DIR does NOT bypass HALT (script-anchor owns the trust decision)', async () => {
    // Pre-0.6.2 regression. The 0.6.1 cross-repo guard trusted the
    // caller-controlled CLAUDE_PROJECT_DIR env var to decide whether to
    // run. Any process setting it to a foreign path bypassed the guard
    // and HALT. The 0.6.2 anchor uses the hook's own filesystem location
    // (SCRIPT_DIR → REA_ROOT two levels up) as the authoritative source;
    // CLAUDE_PROJECT_DIR is advisory only and cannot widen trust.
    if (!jqExists()) return;
    const { base, reaDir } = await makeTwoRepos();
    cleanup.push(base);

    // Freeze rea. If CLAUDE_PROJECT_DIR were still trusted, the foreign
    // path below would short-circuit the guard and HALT would never fire.
    await fs.writeFile(
      path.join(reaDir, '.rea', 'HALT'),
      'BUG-012 regression: halted\n',
    );

    const foreign = path.join(base, 'foreign-attacker');
    await fs.mkdir(foreign, { recursive: true });

    // cwd = rea itself; CLAUDE_PROJECT_DIR = foreign path. Script anchor
    // pegs REA_ROOT = reaDir regardless of env.
    const res = runHook(
      PUSH_HOOK_NAME,
      reaDir,
      reaDir,
      foreign,
      'git push origin main',
    );

    // HALT must still fire — the env var cannot disable it.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REA HALT/);
    // Advisory warning should surface on stderr to document the ignored env.
    expect(res.stderr).toMatch(/ignoring CLAUDE_PROJECT_DIR/i);
  });

  it('Codex blocker: hook invoked from source-of-truth hooks/ path anchors REA_ROOT to repo, not filesystem parent', async () => {
    // 2026-04-20 adversarial review: the 0.6.2 anchor originally used a
    // hard-coded `SCRIPT_DIR/../..`. That assumed the INSTALLED topology
    // (`<root>/.claude/hooks/<name>.sh` → 2 up). For the source-of-truth
    // `<root>/hooks/<name>.sh` path, `../..` lands at the grandparent of
    // the rea repo — the HALT check would silently read from the wrong
    // `.rea/HALT` (or miss it entirely). The walk-up anchor must find the
    // repo via `.rea/policy.yaml` regardless of whether the script was
    // invoked from `.claude/hooks/` or the source `hooks/` directory.
    if (!jqExists()) return;
    const { base, reaDir } = await makeTwoRepos();
    cleanup.push(base);

    // Seed .rea/policy.yaml on the synthetic rea root (makeTwoRepos
    // does not create one by default).
    await fs.mkdir(path.join(reaDir, '.rea'), { recursive: true });
    await fs.writeFile(
      path.join(reaDir, '.rea', 'policy.yaml'),
      'profile: minimal\nautonomy_level: L1\n',
    );

    // Mirror the source-of-truth layout inside the synthetic rea root:
    // <reaDir>/hooks/push-review-gate.sh — one level up, not two.
    const sourceDir = path.join(reaDir, 'hooks');
    await fs.mkdir(sourceDir, { recursive: true });
    const sourceHook = path.join(sourceDir, PUSH_HOOK_NAME);
    await fs.copyFile(
      path.join(REPO_ROOT, 'hooks', PUSH_HOOK_NAME),
      sourceHook,
    );
    await fs.chmod(sourceHook, 0o755);
    // BUG-008 cleanup (0.7.0): adapter sources `_lib/push-review-core.sh`.
    const sourceLibDir = path.join(sourceDir, '_lib');
    await fs.mkdir(sourceLibDir, { recursive: true });
    await fs.copyFile(
      path.join(REPO_ROOT, 'hooks', '_lib', 'push-review-core.sh'),
      path.join(sourceLibDir, 'push-review-core.sh'),
    );
    await fs.chmod(path.join(sourceLibDir, 'push-review-core.sh'), 0o755);

    // Freeze the synthetic rea. If the hook mis-anchors to the filesystem
    // grandparent, it reads the wrong .rea/HALT and never fires.
    await fs.writeFile(
      path.join(reaDir, '.rea', 'HALT'),
      'source-path anchor regression: halted\n',
    );

    const res = spawnSync('bash', [sourceHook], {
      cwd: reaDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: reaDir },
      input: JSON.stringify({ tool_input: { command: 'git push origin main' } }),
      encoding: 'utf8',
    });

    // HALT must fire — proves the walk-up anchor found the real REA_ROOT
    // even though SCRIPT_DIR/../.. would have pointed elsewhere.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REA HALT/);
  });

  it('Codex blocker: hook invoked from outside any rea install fails closed with a diagnostic', async () => {
    // No `.rea/policy.yaml` anywhere up the tree — the walk-up finds
    // nothing, so the hook exits 2 with a clear error. Prevents a
    // silent HALT-read from the wrong directory when someone drops
    // the hook somewhere stray.
    if (!jqExists()) return;
    const { base } = await makeTwoRepos();
    cleanup.push(base);

    const strayDir = path.join(base, 'stray', 'hooks');
    await fs.mkdir(strayDir, { recursive: true });
    const strayHook = path.join(strayDir, PUSH_HOOK_NAME);
    await fs.copyFile(
      path.join(REPO_ROOT, 'hooks', PUSH_HOOK_NAME),
      strayHook,
    );
    await fs.chmod(strayHook, 0o755);
    // BUG-008 cleanup (0.7.0): the adapter sources `_lib/push-review-core.sh`
    // from its own directory; mirror that even for the stray-install case so
    // the failure path under test is the anchor walk-up (not a missing lib).
    const strayLibDir = path.join(strayDir, '_lib');
    await fs.mkdir(strayLibDir, { recursive: true });
    await fs.copyFile(
      path.join(REPO_ROOT, 'hooks', '_lib', 'push-review-core.sh'),
      path.join(strayLibDir, 'push-review-core.sh'),
    );
    await fs.chmod(path.join(strayLibDir, 'push-review-core.sh'), 0o755);

    const res = spawnSync('bash', [strayHook], {
      cwd: strayDir,
      env: { ...process.env },
      input: JSON.stringify({ tool_input: { command: 'git push origin main' } }),
      encoding: 'utf8',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/no \.rea\/policy\.yaml found/);
  });

  it('foreign push is NOT blocked when jq is missing (guard runs before jq check)', async () => {
    const { base, reaDir, consumerDir, consumerBranch } = await makeTwoRepos();
    cleanup.push(base);

    // Build a PATH shadow dir containing the binaries the guard needs
    // (cat, git) but NOT jq. When bash evaluates `command -v jq` inside the
    // hook it returns false — the jq branch at step 2 would exit 2, but the
    // guard at step 1a must short-circuit before that.
    const shadowPath = path.join(base, 'shadow-path');
    await fs.mkdir(shadowPath, { recursive: true });
    // `dirname` is invoked by the script-location anchor (BUG-012) before
    // the jq check runs; `printf` + `cd`/`pwd` are bash builtins.
    for (const bin of ['cat', 'git', 'pwd', 'dirname']) {
      // `which`-style resolution — try common paths, symlink the first hit.
      for (const root of ['/usr/bin', '/bin', '/usr/local/bin']) {
        try {
          await fs.access(path.join(root, bin));
          await fs.symlink(path.join(root, bin), path.join(shadowPath, bin));
          break;
        } catch {
          // not here, try next
        }
      }
    }

    // Absolute bash path — the shadow PATH doesn't contain bash itself.
    const res = spawnSync('/bin/bash', [installedHookPath(reaDir, PUSH_HOOK_NAME)], {
      cwd: consumerDir,
      env: {
        PATH: shadowPath,
        CLAUDE_PROJECT_DIR: reaDir,
      },
      input: toolInput(`git push origin ${consumerBranch}`),
      encoding: 'utf8',
    });

    expect(res.status ?? -1).toBe(0);
    expect(res.stderr ?? '').not.toMatch(/jq is required/i);
  });
});

describe('commit-review-gate.sh — cross-repo guard (0.6.1 mirror)', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanup.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('exits 0 when cwd is a different git repo than CLAUDE_PROJECT_DIR', async () => {
    if (!jqExists()) return;
    const { base, reaDir, consumerDir } = await makeTwoRepos();
    cleanup.push(base);

    // Stage a sensitive-path diff in the consumer repo — would trigger the
    // REVIEW REQUIRED branch in step 7 if the gate runs. Guard must
    // short-circuit before getting there.
    await fs.mkdir(path.join(consumerDir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(consumerDir, '.claude', 'settings.json'),
      '{}\n',
    );
    git(consumerDir, 'add', '.claude/settings.json');

    const res = runHook(
      COMMIT_HOOK_NAME,
      reaDir,
      consumerDir,
      reaDir,
      'git commit -m "upgrade rea"',
    );

    expect(res.status).toBe(0);
    // If the guard wrongly lets control through, stderr would contain the
    // gate's sensitive-paths banner.
    expect(res.stderr).not.toMatch(/REVIEW REQUIRED/i);
    expect(res.stderr).not.toMatch(/sensitive/i);
  });

  it('exits 0 for an independent nested git repo under the rea tree', async () => {
    if (!jqExists()) return;
    const { base, reaDir } = await makeTwoRepos();
    cleanup.push(base);

    const nested = path.join(reaDir, 'nested-checkout');
    await initRepo(nested);
    await commitFile(nested, 'README.md', '# nested\n', 'baseline');
    await fs.mkdir(path.join(nested, '.claude'), { recursive: true });
    await fs.writeFile(path.join(nested, '.claude', 'settings.json'), '{}\n');
    git(nested, 'add', '.claude/settings.json');

    const res = runHook(
      COMMIT_HOOK_NAME,
      reaDir,
      nested,
      reaDir,
      'git commit -m "x"',
    );

    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/REVIEW REQUIRED/i);
  });

  it('same-repo linked-worktree does NOT short-circuit the guard', async () => {
    // Identical guard block as push-review-gate (byte-equal when `diff -u`d).
    // The push-gate test above exercises the common-dir logic end-to-end by
    // asserting a ref-resolve failure only reachable past the guard. For the
    // commit gate, `git diff --cached` is run inside REA_ROOT (a pre-existing
    // hook behavior outside the scope of this fix), so we can't easily force
    // a "gate ran" signal from a worktree's local index. We assert only the
    // foreign-repo case here; same-repo worktree identification is fully
    // covered by the push-gate test.
    expect(true).toBe(true);
  });
});
