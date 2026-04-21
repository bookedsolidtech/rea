/**
 * Integration tests for `hooks/push-review-gate-git.sh` — the native git
 * `.husky/pre-push` adapter (task #50 follow-on to BUG-008 cleanup).
 *
 * The adapter is intentionally a near-clone of `push-review-gate.sh`; both
 * forward to `pr_core_run` in `_lib/push-review-core.sh`. These tests assert:
 *
 *   1. The adapter is wired to the shared core (finds `_lib/` next to it).
 *   2. Native git pre-push stdin (`<ref> <sha> <ref> <sha>`) triggers the
 *      same protected-path block as the generic adapter does via the
 *      BUG-008 sniff.
 *   3. Whole-gate escape hatch (`REA_SKIP_PUSH_REVIEW`) honors husky inputs.
 *   4. `push_review: false` policy is NOT a bypass under husky inputs
 *      (0.9.3 Defect B — the grep short-circuit was removed).
 *   5. Missing core library fails closed (exit 2) with a diagnostic — the
 *      adapter never silently degrades to a no-op pre-push gate.
 *   6. Parity matrix: the git adapter and the generic adapter produce the
 *      same exit code + same load-bearing stderr substring across every
 *      branch the core exposes (protected-path block, HALT, REA_SKIP_*,
 *      empty stdin, non-protected-path clean push). If these diverge, one
 *      adapter is drifting from the other.
 *   7. Byte-parity: `hooks/push-review-gate-git.sh` and
 *      `.claude/hooks/push-review-gate-git.sh` are byte-identical. The
 *      dogfood mirror is what `.husky/pre-push` actually invokes in this
 *      repo, so silent drift would ship a broken hook.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GIT_HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate-git.sh');
const GENERIC_HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');
const CORE_SRC = path.join(REPO_ROOT, 'hooks', '_lib', 'push-review-core.sh');

async function installHooks(dir: string): Promise<{
  gitHook: string;
  genericHook: string;
}> {
  const destDir = path.join(dir, '.claude', 'hooks');
  await fs.mkdir(destDir, { recursive: true });

  const gitDest = path.join(destDir, 'push-review-gate-git.sh');
  await fs.copyFile(GIT_HOOK_SRC, gitDest);
  await fs.chmod(gitDest, 0o755);

  const genericDest = path.join(destDir, 'push-review-gate.sh');
  await fs.copyFile(GENERIC_HOOK_SRC, genericDest);
  await fs.chmod(genericDest, 0o755);

  const libDir = path.join(destDir, '_lib');
  await fs.mkdir(libDir, { recursive: true });
  const coreDest = path.join(libDir, 'push-review-core.sh');
  await fs.copyFile(CORE_SRC, coreDest);
  await fs.chmod(coreDest, 0o755);

  const policyDir = path.join(dir, '.rea');
  await fs.mkdir(policyDir, { recursive: true });
  const policyPath = path.join(policyDir, 'policy.yaml');
  try {
    await fs.access(policyPath);
  } catch {
    await fs.writeFile(policyPath, 'profile: minimal\nautonomy_level: L1\n');
  }

  return { gitHook: gitDest, genericHook: genericDest };
}

interface ScratchRepo {
  dir: string;
  featureSha: string;
  cleanFeatureSha: string;
  mainSha: string;
  gitHook: string;
  genericHook: string;
}

async function makeRepo(): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-push-gate-git-')),
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

  // A second branch whose diff against main is non-empty but touches ONLY
  // non-protected paths. Lets the matrix test actually exercise the path-
  // filter branch (section 7a) instead of exiting early on empty diff.
  git('checkout', '-b', 'clean-feature', 'main', '--quiet');
  await fs.writeFile(
    path.join(dir, 'README.md'),
    '# scratch\n\nclean non-protected change\n',
  );
  git('add', 'README.md');
  git('commit', '-m', 'touch non-protected path', '--quiet');
  const cleanFeatureSha = git('rev-parse', 'HEAD');
  git('checkout', 'feature', '--quiet');

  await fs.mkdir(path.join(dir, '.git', 'refs', 'remotes', 'origin'), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'),
    `${mainSha}\n`,
  );

  // Symlink rea's built dist into the scratch repo so the hook can find
  // `dist/audit/append.js`, `dist/scripts/read-policy-field.js`, and
  // `dist/policy/*` when REA_ROOT anchors to this scratch dir. Matches the
  // convention used by push-review-gate-skip-push-review.test.ts.
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.symlink(
    path.join(REPO_ROOT, 'dist', 'audit'),
    path.join(dir, 'dist', 'audit'),
  );
  await fs.symlink(
    path.join(REPO_ROOT, 'dist', 'scripts'),
    path.join(dir, 'dist', 'scripts'),
  );
  await fs.symlink(
    path.join(REPO_ROOT, 'dist', 'policy'),
    path.join(dir, 'dist', 'policy'),
  );

  const { gitHook, genericHook } = await installHooks(dir);

  return { dir, featureSha, cleanFeatureSha, mainSha, gitHook, genericHook };
}

// Hard precondition: the core library shells out to `jq` for the Claude-Code
// JSON sniff. If it is missing, every test case below would be silently
// skipped via a `return`, which is exactly the failure mode that hid BUG-008
// for a full minor release cycle. Throwing at module load means CI fails
// loud and fast on a missing dependency. Local dev runs fail the same way.
// If CI is ever running on an image without jq, fix the image (e.g.
// `apt-get install -y jq` in the workflow), not this precondition.
(() => {
  const res = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(
      'push-review-gate-git-adapter.test.ts requires `jq` on PATH — ' +
        'the push-review core shells out to jq for the Claude-Code JSON ' +
        'sniff. Install jq (macOS: `brew install jq`; Debian/Ubuntu: ' +
        '`apt-get install jq`) or add it to the CI image.',
    );
  }
})();

describe('push-review-gate-git.sh — native git pre-push adapter (task #50)', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanup.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('blocks a push given git-native stdin + argv (husky install topology)', async () => {
    const repo = await makeRepo();
    cleanup.push(repo.dir);

    const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;

    const res = spawnSync(
      'bash',
      [repo.gitHook, 'origin', 'git@example.test:foo/bar.git'],
      {
        cwd: repo.dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
        input: prepushLine,
        encoding: 'utf8',
      },
    );

    // The `feature` branch diff touches `hooks/__test__.sh`, which matches
    // the section 7a protected-path awk regex. We require the adapter to hit
    // the dedicated protected-path banner AND NOT fall through to the
    // section 9 general-gate banner. If this ever loosens, the path-filter
    // branch is not doing its job — which is exactly what BUG-008 shipped as
    // through 0.5.0.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
    expect(res.stderr).not.toMatch(/PUSH REVIEW GATE: Review required/);
  });

  it('REA_SKIP_PUSH_REVIEW bypass fires from the git adapter (writes audit record)', async () => {
    const repo = await makeRepo();
    cleanup.push(repo.dir);

    const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;
    const res = spawnSync('bash', [repo.gitHook, 'origin'], {
      cwd: repo.dir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: repo.dir,
        REA_SKIP_PUSH_REVIEW: 'task50-adapter-smoke',
        // Codex F2: REA_SKIP_PUSH_REVIEW is refused in CI unless the policy
        // opts in. This test validates the non-CI bypass path, so clear any
        // inherited CI var from the test runner (GitHub Actions sets CI=true).
        CI: '',
        GITHUB_ACTIONS: '',
      },
      input: prepushLine,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);

    const auditPath = path.join(repo.dir, '.rea', 'audit.jsonl');
    const audit = await fs.readFile(auditPath, 'utf8').catch(() => '');
    expect(audit).toMatch(/"tool_name"\s*:\s*"push\.review\.skipped"/);
    expect(audit).toMatch(/task50-adapter-smoke/);
  });

  it('push_review: false policy does NOT short-circuit the git adapter (0.9.3 Defect B)', async () => {
    // Pre-0.9.3 the grep bypass in `push-review-core.sh` §5 would return
    // exit 0 on this policy content. The bypass was unauditable and the
    // only supported opt-out contract is `REA_SKIP_PUSH_REVIEW=<reason>`
    // which writes a skip audit record. This test pins the removal.
    const repo = await makeRepo();
    cleanup.push(repo.dir);

    await fs.writeFile(
      path.join(repo.dir, '.rea', 'policy.yaml'),
      'push_review: false\n',
    );

    const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;
    const res = spawnSync('bash', [repo.gitHook, 'origin'], {
      cwd: repo.dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
      input: prepushLine,
      encoding: 'utf8',
    });

    // Gate must run past the removed short-circuit. The feature branch in
    // `makeRepo()` touches `hooks/__test__.sh` — a protected path — so
    // the Codex protected-path banner fires as confirmation that control
    // reached the protected-path matcher and did not exit at the deleted
    // §5. A specific banner assertion (not just `not.toBe(0)`) blocks
    // future accidental regressions that would exit non-zero for an
    // unrelated reason.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
    expect(res.stderr).toMatch(/codex-review required/);
  });

  it('fails closed (exit 2) when the shared core library is missing', async () => {
    const repo = await makeRepo();
    cleanup.push(repo.dir);

    // Remove the core that installHooks placed next to the adapter.
    const installedCore = path.join(
      path.dirname(repo.gitHook),
      '_lib',
      'push-review-core.sh',
    );
    await fs.rm(installedCore, { force: true });

    const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;
    const res = spawnSync('bash', [repo.gitHook, 'origin'], {
      cwd: repo.dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
      input: prepushLine,
      encoding: 'utf8',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/push-review-core\.sh not found/);
  });

  it('parity: git adapter and generic adapter produce identical exit code + blocking stderr', async () => {
    const repo = await makeRepo();
    cleanup.push(repo.dir);

    const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;
    const runOpts = {
      cwd: repo.dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
      input: prepushLine,
      encoding: 'utf8' as const,
    };

    const viaGit = spawnSync('bash', [repo.gitHook, 'origin'], runOpts);
    const viaGeneric = spawnSync('bash', [repo.genericHook, 'origin'], runOpts);

    expect(viaGit.status).toBe(viaGeneric.status);
    expect(viaGit.status).toBe(2);

    // The `feature` branch diff touches `hooks/__test__.sh` (protected).
    // Both adapters must hit the dedicated protected-path banner and NOT
    // fall through to the section 9 general-gate banner — a loose
    // alternation would let either adapter silently regress to section 9
    // without the other noticing.
    expect(viaGit.stderr).toMatch(/protected paths changed/);
    expect(viaGeneric.stderr).toMatch(/protected paths changed/);
    expect(viaGit.stderr).not.toMatch(/PUSH REVIEW GATE: Review required/);
    expect(viaGeneric.stderr).not.toMatch(/PUSH REVIEW GATE: Review required/);
  });

  /**
   * Parity matrix. Each row runs identical input through BOTH adapters and
   * asserts same exit code + same load-bearing stderr signal. This is the
   * load-bearing anti-drift test for the two-adapter topology: if anyone
   * ever edits only one adapter, this fails.
   *
   * The cases exercise every branch `pr_core_run` exposes:
   *   - HALT wins over everything (exit 2, HALT banner)
   *   - REA_SKIP_PUSH_REVIEW bypass (exit 0, audit receipt)
   *   - REA_SKIP_CODEX_REVIEW waiver (writes `codex.review.skipped` audit
   *     receipt, satisfies the protected-path check only; HALT, ref-
   *     resolution, and push-review cache still run). Under #85 (0.8.0)
   *     the waiver narrowed from whole-gate bypass to Codex-only — exit 2
   *     on cache miss, exit 0 only when a valid push-review cache entry
   *     satisfies the general gate too.
   *   - Empty stdin + no argv (no pre-push shape, no JSON) → exit 0
   *   - Non-protected-path push → exit 0
   */
  describe('parity matrix: every core branch behaves identically across adapters', () => {
    async function runBoth(
      repo: ScratchRepo,
      opts: {
        input: string;
        args?: string[];
        env?: NodeJS.ProcessEnv;
      },
    ): Promise<{
      viaGit: ReturnType<typeof spawnSync>;
      viaGeneric: ReturnType<typeof spawnSync>;
    }> {
      const runOpts = {
        cwd: repo.dir,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: repo.dir,
          ...(opts.env ?? {}),
        },
        input: opts.input,
        encoding: 'utf8' as const,
      };
      const viaGit = spawnSync(
        'bash',
        [repo.gitHook, ...(opts.args ?? [])],
        runOpts,
      );
      const viaGeneric = spawnSync(
        'bash',
        [repo.genericHook, ...(opts.args ?? [])],
        runOpts,
      );
      return { viaGit, viaGeneric };
    }

    it('HALT wins over both hatches (exit 2, HALT banner, both adapters)', async () => {
      const repo = await makeRepo();
      cleanup.push(repo.dir);

      await fs.writeFile(path.join(repo.dir, '.rea', 'HALT'), 'parity-matrix');

      const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;
      const { viaGit, viaGeneric } = await runBoth(repo, {
        input: prepushLine,
        args: ['origin'],
        env: {
          REA_SKIP_PUSH_REVIEW: 'should-not-bypass-HALT',
          REA_SKIP_CODEX_REVIEW: 'should-not-bypass-HALT',
        },
      });

      expect(viaGit.status).toBe(viaGeneric.status);
      expect(viaGit.status).toBe(2);
      expect(viaGit.stderr).toMatch(/REA HALT|FROZEN/i);
      expect(viaGeneric.stderr).toMatch(/REA HALT|FROZEN/i);
    });

    it('REA_SKIP_PUSH_REVIEW bypass fires identically via both adapters', async () => {
      const repo = await makeRepo();
      cleanup.push(repo.dir);

      const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;
      const { viaGit, viaGeneric } = await runBoth(repo, {
        input: prepushLine,
        args: ['origin'],
        env: {
          REA_SKIP_PUSH_REVIEW: 'parity-matrix-skip-push',
          // Codex F2: clear inherited CI env so the non-CI bypass path runs.
          // GitHub Actions sets CI=true; without this, the shared core
          // refuses the skip unless policy opts in via allow_skip_in_ci.
          CI: '',
          GITHUB_ACTIONS: '',
        },
      });

      expect(viaGit.status).toBe(viaGeneric.status);
      expect(viaGit.status).toBe(0);
    });

    it('REA_SKIP_CODEX_REVIEW waiver fires identically via both adapters (#85)', async () => {
      const repo = await makeRepo();
      cleanup.push(repo.dir);

      const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;
      const { viaGit, viaGeneric } = await runBoth(repo, {
        input: prepushLine,
        args: ['origin'],
        env: { REA_SKIP_CODEX_REVIEW: 'parity-matrix-skip-codex' },
      });

      expect(viaGit.status).toBe(viaGeneric.status);
      // #85 (0.8.0): the waiver narrowed from whole-gate bypass to a
      // Codex-only waiver. Section 5c still writes the skip audit record
      // and prints the WAIVER banner (parity assertion), but ref-resolution
      // and the general review-required gate still run. With no cache
      // entry, section 9 blocks both adapters with exit 2.
      expect(viaGit.status).toBe(2);
      expect(viaGit.stderr).toMatch(/CODEX REVIEW WAIVER active/);
      expect(viaGeneric.stderr).toMatch(/CODEX REVIEW WAIVER active/);
      expect(viaGit.stderr).toMatch(/PUSH REVIEW GATE: Review required/);
      expect(viaGeneric.stderr).toMatch(/PUSH REVIEW GATE: Review required/);

      const audit = await fs
        .readFile(path.join(repo.dir, '.rea', 'audit.jsonl'), 'utf8')
        .catch(() => '');
      expect(audit).toMatch(/"tool_name"\s*:\s*"codex\.review\.skipped"/);
      expect(audit).toMatch(/parity-matrix-skip-codex/);
    });

    it('empty stdin + no argv is a no-op (exit 0) on both adapters', async () => {
      const repo = await makeRepo();
      cleanup.push(repo.dir);

      const { viaGit, viaGeneric } = await runBoth(repo, {
        input: '',
        args: [],
      });

      expect(viaGit.status).toBe(viaGeneric.status);
      expect(viaGit.status).toBe(0);
    });

    it('non-protected-path push routes to the general gate, NOT the protected-path gate (both adapters)', async () => {
      const repo = await makeRepo();
      cleanup.push(repo.dir);

      // `clean-feature` touches only README.md — a real, non-empty diff
      // against main that exercises the section 7a awk path filter (as
      // opposed to a same-SHA refspec which would exit early via the
      // section 6 empty-diff short-circuit). This is the F3' fix.
      //
      // With the default policy (CODEX_REQUIRED=true), the path filter
      // runs and correctly classifies the diff as non-protected. Section
      // 7a then falls through. Section 8's cache check misses (no cache
      // entry) and section 9 issues the general "PUSH REVIEW GATE" block.
      //
      // The load-bearing assertions are:
      //   (a) both adapters return exit 2 identically (parity)
      //   (b) NEITHER adapter prints the "protected paths changed" banner
      //       (would indicate the path filter mis-classified)
      //   (c) BOTH adapters print the general "PUSH REVIEW GATE" banner
      //       (confirms we reached section 9, not section 7a)
      const cleanLine = `refs/heads/clean-feature ${repo.cleanFeatureSha} refs/heads/main ${repo.mainSha}\n`;
      const { viaGit, viaGeneric } = await runBoth(repo, {
        input: cleanLine,
        args: ['origin'],
      });

      expect(viaGit.status).toBe(viaGeneric.status);
      expect(viaGit.status).toBe(2);
      expect(viaGit.stderr).not.toMatch(/protected paths changed/);
      expect(viaGeneric.stderr).not.toMatch(/protected paths changed/);
      expect(viaGit.stderr).toMatch(/PUSH REVIEW GATE: Review required/);
      expect(viaGeneric.stderr).toMatch(/PUSH REVIEW GATE: Review required/);
    });
  });

  /**
   * F2 follow-up: a byte-parity check between the source-of-truth adapter
   * at `hooks/push-review-gate-git.sh` and the dogfood mirror at
   * `.claude/hooks/push-review-gate-git.sh`. `.husky/pre-push` on this repo
   * calls the mirror — if they drift, rea itself silently ships a broken
   * hook. This test runs offline (no spawnSync), so it is cheap to keep.
   */
  /**
   * Byte + mode parity for every source↔mirror hook pair. Content equality
   * alone is not enough: the adapters are exec'd, so a missing `+x` on one
   * side would silently break the consumer install while CI reports green.
   * We compare the git-tracked mode (100644 vs 100755) via `ls-files
   * --stage` so the check matches what lands in the tarball, not what the
   * developer's local working tree happens to have.
   */
  async function expectPairParity(sourceRel: string, mirrorRel: string) {
    const source = await fs.readFile(path.join(REPO_ROOT, sourceRel));
    const mirror = await fs.readFile(path.join(REPO_ROOT, mirrorRel));
    expect(mirror.equals(source)).toBe(true);

    const stageOut = execFileSync(
      'git',
      ['ls-files', '--stage', sourceRel, mirrorRel],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const modes = new Map<string, string>();
    for (const line of stageOut.split('\n').filter(Boolean)) {
      const [mode, , , rest] = line.split(/\s+/, 4);
      const file = rest ?? line.split('\t')[1];
      modes.set(file, mode);
    }
    // Every shipped hook — adapter or core library — is exec'd directly by
    // husky or by the Claude-Code hook runner, so `100755` is the only
    // correct tracked mode. Asserting absolute equality here catches the
    // case where a developer `chmod -x`'d both sides symmetrically: equal-
    // to-each-other would pass but both-broken would ship a silently dead
    // hook. The git-tracked mode is what lands in the tarball, so this
    // check matches consumer-install reality, not the developer's working
    // tree.
    expect(modes.get(sourceRel)).toBe('100755');
    expect(modes.get(mirrorRel)).toBe('100755');
    expect(modes.get(sourceRel)).toBe(modes.get(mirrorRel));
  }

  /**
   * Codex 0.7.0 review — C1/C2 regression. The shared-core new-branch path
   * (remote_sha == ZERO_SHA) resolves the default branch by probing:
   *
   *     refs/remotes/<remote>/HEAD  →  refs/remotes/<remote>/main
   *                                →  refs/remotes/<remote>/master   (C1)
   *
   * Before 0.7.0 the fallback only tried `main`, so a first push of a
   * protected-path branch against a `master`-default fork would silently
   * fail-closed at merge-base resolution before the protected-path gate
   * even ran — operators would see a generic "could not resolve merge-
   * base" block instead of the specific "protected paths changed" banner,
   * and the zero-SHA code path went un-tested.
   *
   * This suite pushes a new branch (`remote_sha == ZERO_SHA`) against three
   * setups and asserts the protected-path gate fires in every one:
   *
   *   1. origin/HEAD symbolically points at origin/main (modern git default)
   *   2. origin/HEAD missing, origin/main present (mirror-clone shape)
   *   3. origin/HEAD missing, origin/main missing, origin/master present
   *      (the `master`-default fork path — C1 regression coverage)
   */
  describe('new-branch zero-SHA path (Codex 0.7.0 C1 + C2)', () => {
    async function setRemoteTrackingRef(
      repoDir: string,
      branch: string,
      sha: string,
    ): Promise<void> {
      await fs.mkdir(
        path.join(repoDir, '.git', 'refs', 'remotes', 'origin'),
        { recursive: true },
      );
      await fs.writeFile(
        path.join(repoDir, '.git', 'refs', 'remotes', 'origin', branch),
        `${sha}\n`,
      );
    }

    async function clearRemoteTrackingRef(
      repoDir: string,
      branch: string,
    ): Promise<void> {
      await fs
        .rm(path.join(repoDir, '.git', 'refs', 'remotes', 'origin', branch), {
          force: true,
        })
        .catch(() => undefined);
    }

    async function setOriginHead(repoDir: string, target: string): Promise<void> {
      await fs.writeFile(
        path.join(repoDir, '.git', 'refs', 'remotes', 'origin', 'HEAD'),
        `ref: refs/remotes/origin/${target}\n`,
      );
    }

    async function clearOriginHead(repoDir: string): Promise<void> {
      await fs
        .rm(path.join(repoDir, '.git', 'refs', 'remotes', 'origin', 'HEAD'), {
          force: true,
        })
        .catch(() => undefined);
    }

    const ZERO = '0000000000000000000000000000000000000000';

    it('origin/HEAD → origin/main: fires protected-path gate on new-branch push', async () => {
      const repo = await makeRepo();
      cleanup.push(repo.dir);

      // makeRepo seeds origin/main. Add origin/HEAD pointing at it so the
      // shared-core `git symbolic-ref refs/remotes/origin/HEAD` call succeeds
      // — this is the happy path (modern git default after `git clone`).
      await setOriginHead(repo.dir, 'main');

      const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/feature ${ZERO}\n`;
      const res = spawnSync('bash', [repo.gitHook, 'origin'], {
        cwd: repo.dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
        input: prepushLine,
        encoding: 'utf8',
      });

      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/protected paths changed/);
    });

    it('origin/HEAD missing, origin/main present: fallback still fires gate', async () => {
      const repo = await makeRepo();
      cleanup.push(repo.dir);

      // No origin/HEAD seeded — the shared-core symbolic-ref call fails and
      // the fallback probe must land on origin/main via `rev-parse --verify`.
      await clearOriginHead(repo.dir);

      const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/feature ${ZERO}\n`;
      const res = spawnSync('bash', [repo.gitHook, 'origin'], {
        cwd: repo.dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
        input: prepushLine,
        encoding: 'utf8',
      });

      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/protected paths changed/);
    });

    it('origin/HEAD missing, origin/main missing, origin/master present: C1 master fallback fires gate', async () => {
      const repo = await makeRepo();
      cleanup.push(repo.dir);

      // Rebuild the remote-tracking state so the ONLY available default is
      // master. Before C1 this would fall through to a bare `origin/main`
      // that git cannot resolve, producing an empty merge-base that (under
      // the shared-core fail-closed rule) blocks with a generic "could not
      // resolve" banner instead of the specific protected-path banner.
      await clearOriginHead(repo.dir);
      await setRemoteTrackingRef(repo.dir, 'master', repo.mainSha);
      await clearRemoteTrackingRef(repo.dir, 'main');

      const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/feature ${ZERO}\n`;
      const res = spawnSync('bash', [repo.gitHook, 'origin'], {
        cwd: repo.dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
        input: prepushLine,
        encoding: 'utf8',
      });

      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/protected paths changed/);
    });

    // Codex 0.7.0 pass-4 finding #3 — regression coverage for the shared
    // core's bootstrap fallback. All three remote-tracking refs absent
    // (HEAD + main + master) is the permutation fixed by pass-3 via the
    // empty-tree baseline at hooks/_lib/push-review-core.sh:800-803. The
    // husky-e2e suite already exercises this through .husky/pre-push, but
    // the shared-core adapter had no direct regression test — so a future
    // refactor could silently reintroduce the fail-open for operators
    // hitting the gate via push-review-gate-git.sh / push-review-gate.sh
    // and only husky-e2e would catch it.
    it('origin/HEAD + main + master all missing: empty-tree fallback fires gate (pass-3 regression)', async () => {
      const repo = await makeRepo();
      cleanup.push(repo.dir);

      // Strip every remote-tracking ref so neither symbolic-ref nor either
      // rev-parse probe can resolve a default branch. The shared core must
      // then fall through to the empty-tree baseline and still run the
      // protected-path check against the full refspec content.
      await clearOriginHead(repo.dir);
      await clearRemoteTrackingRef(repo.dir, 'main');
      await clearRemoteTrackingRef(repo.dir, 'master');

      const prepushLine = `refs/heads/feature ${repo.featureSha} refs/heads/feature ${ZERO}\n`;
      const res = spawnSync('bash', [repo.gitHook, 'origin'], {
        cwd: repo.dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
        input: prepushLine,
        encoding: 'utf8',
      });

      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/protected paths changed/);

      // Sanity: the REA_SKIP_CODEX_REVIEW waiver satisfies the
      // protected-path check but the general review-required gate still
      // blocks (cache miss). Proves the block above fired on the
      // protected-path gate (not a ref-resolution failure earlier) — if
      // ref-resolution were failing, the waiver wouldn't reach section 9
      // to print the general gate banner.
      const bypass = spawnSync('bash', [repo.gitHook, 'origin'], {
        cwd: repo.dir,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: repo.dir,
          REA_SKIP_CODEX_REVIEW: 'pass-4-regression-bootstrap',
        },
        input: prepushLine,
        encoding: 'utf8',
      });
      expect(bypass.status).toBe(2);
      expect(bypass.stderr).toMatch(/CODEX REVIEW WAIVER active/);
      expect(bypass.stderr).not.toMatch(/protected paths changed/);
      expect(bypass.stderr).toMatch(/PUSH REVIEW GATE: Review required/);
    });
  });

  // Codex 0.7.0 pass-4 finding #2 regression. Before pass-4 the
  // protected-path check ran once on the BEST_COUNT-selected refspec,
  // so a multi-refspec push where a SMALL protected-path refspec was
  // hidden behind a LARGER non-protected one would bypass the gate —
  // the non-protected refspec's larger diff won BEST_COUNT, and its
  // clean diff satisfied the single check. Pass-4 moved the protected-
  // path check inside the per-refspec loop, requiring the Codex audit
  // entry to match EACH protected refspec's own local_sha. This test
  // locks in that semantic — if a future refactor moves the check back
  // outside the loop or accidentally short-circuits after BEST, it will
  // fail loudly.
  it('multi-refspec: small protected refspec cannot hide behind a bigger non-protected one (Codex pass-4 finding #2 regression)', async () => {
    const repo = await makeRepo();
    cleanup.push(repo.dir);

    // Two refspecs in the same push:
    //   1. clean-feature → main  (non-protected, touches only README.md)
    //   2. feature       → main  (protected, touches hooks/)
    // Pre-pass-4 shared core would pick whichever refspec has the
    // larger rev-list count as BEST and only check that one; because
    // the clean refspec is at least as big as the feature refspec
    // (both descend from main), the BEST selection was non-
    // deterministic but protected-path coverage could be skipped.
    // The per-refspec loop now inspects BOTH — the protected-path
    // refspec's local_sha has no Codex audit, so the gate must fire.
    const prepushLines =
      `refs/heads/clean-feature ${repo.cleanFeatureSha} refs/heads/clean ${repo.mainSha}\n` +
      `refs/heads/feature ${repo.featureSha} refs/heads/main ${repo.mainSha}\n`;
    const res = spawnSync('bash', [repo.gitHook, 'origin'], {
      cwd: repo.dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo.dir },
      input: prepushLines,
      encoding: 'utf8',
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
    // The block must name the PROTECTED refspec's sha, not the clean
    // refspec's — proves the per-refspec check caught the right one.
    expect(res.stderr).toContain(repo.featureSha);
  });

  it('byte+mode parity: hooks/push-review-gate-git.sh matches .claude/hooks/push-review-gate-git.sh', async () => {
    await expectPairParity(
      'hooks/push-review-gate-git.sh',
      '.claude/hooks/push-review-gate-git.sh',
    );
  });

  it('byte+mode parity: hooks/push-review-gate.sh matches .claude/hooks/push-review-gate.sh', async () => {
    await expectPairParity(
      'hooks/push-review-gate.sh',
      '.claude/hooks/push-review-gate.sh',
    );
  });

  it('byte+mode parity: hooks/_lib/push-review-core.sh matches .claude/hooks/_lib/push-review-core.sh', async () => {
    await expectPairParity(
      'hooks/_lib/push-review-core.sh',
      '.claude/hooks/_lib/push-review-core.sh',
    );
  });
});
