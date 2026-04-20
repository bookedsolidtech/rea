/**
 * End-to-end test for the husky → git push → pre-push hook → exit-code
 * propagation pipeline (task #81).
 *
 * Why this test exists: through 0.4.0 the gate silently exited 0 under
 * husky-driven pushes (BUG-008) because the hook only parsed Claude-Code
 * JSON stdin. Every other suite in `__tests__/hooks/` synthesizes the
 * husky stdin directly and invokes the hook with `spawnSync('bash', ...)`.
 * That validates the hook's parse logic but NOT the real plumbing:
 *
 *   - Does `git push` actually invoke `.husky/pre-push` when
 *     `core.hooksPath=.husky` is set?
 *   - Does the hook's non-zero exit actually abort the push?
 *   - Is the protected-path block observable in `git push` stderr?
 *
 * A pre-0.5 rea could pass every existing unit test and still fail this
 * one, because a hook that silently exits 0 would let `git push` succeed
 * — and the push-to-remote outcome is the only thing that matters for the
 * threat model. This is the plumbing-level regression guard.
 *
 * Implementation notes:
 *   - Uses a bare repo on disk as `origin` so `git push` has somewhere to
 *     go. No network. No auth.
 *   - Sets `core.hooksPath=.husky` (what `husky install` does) instead of
 *     installing husky itself — functionally equivalent for git's hook
 *     resolution, and avoids pulling a pnpm dependency into the test path.
 *   - Symlinks `dist/scripts/` and `dist/audit/` from the repo root, so
 *     the hook's `read-policy-field.js` fallback finds them. Mirrors the
 *     symlink dance already used by the no-codex push-gate integration
 *     tests.
 *   - `.husky/pre-push` is the SHIPPED file at the repo root — not a
 *     modified copy. If the shipped hook drifts into a silent-noop state,
 *     this test fails loudly.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIPPED_HUSKY_HOOK = path.join(REPO_ROOT, '.husky', 'pre-push');
const REPO_DIST_SCRIPTS = path.join(REPO_ROOT, 'dist', 'scripts');
const REPO_DIST_AUDIT = path.join(REPO_ROOT, 'dist', 'audit');
const REPO_DIST_POLICY = path.join(REPO_ROOT, 'dist', 'policy');
const NATIVE_GIT_ADAPTER = path.join(REPO_ROOT, 'hooks', 'push-review-gate-git.sh');
const SHARED_CORE = path.join(REPO_ROOT, 'hooks', '_lib', 'push-review-core.sh');

/**
 * Hard precondition. The shipped husky hook and the compiled
 * `dist/scripts/read-policy-field.js` + `dist/policy/` MUST be present —
 * the test is meaningless without them. `read-policy-field.js` imports
 * `../policy/loader.js`, so omitting `dist/policy/` would cause an
 * ERR_MODULE_NOT_FOUND at helper-import time. The hook swallows that
 * through `field_value=$(... || printf '')` and fail-closes to
 * CODEX_REQUIRED=true — observably identical to the EXIT_MISSING branch
 * the helper returns when `review.codex_required` is absent from policy.
 * The symlink is needed so preconditions of a complete build can be
 * trusted as signals and so the helper actually gets invoked (vs.
 * erroring at import); the helper-returns-`false` branch is separately
 * exercised by the "honors review.codex_required: false" test below.
 * Sync-throw at module load so a missing build surfaces as a clean
 * "test file failed to load" with a specific message, rather than
 * post-collection unhandled-rejection noise.
 */
try {
  fsSync.accessSync(
    SHIPPED_HUSKY_HOOK,
    fsSync.constants.R_OK | fsSync.constants.X_OK,
  );
} catch {
  throw new Error(
    `husky-e2e.test.ts requires shipped .husky/pre-push at ${SHIPPED_HUSKY_HOOK}`,
  );
}
try {
  fsSync.accessSync(path.join(REPO_DIST_SCRIPTS, 'read-policy-field.js'));
} catch {
  throw new Error(
    'husky-e2e.test.ts requires dist/scripts/read-policy-field.js — run `pnpm build` first',
  );
}
try {
  fsSync.accessSync(REPO_DIST_POLICY);
} catch {
  throw new Error(
    'husky-e2e.test.ts requires dist/policy/ — run `pnpm build` first',
  );
}

interface E2ERepo {
  /** Working copy — where `git push` runs from. */
  workDir: string;
  /** Bare remote — what `origin` points at. */
  remoteDir: string;
  /** The commit on main that both refs share. */
  mainSha: string;
  /** Head of the feature branch, protected-path variant. */
  protectedFeatureSha: string;
  /** Head of the feature branch, clean variant (docs-only). */
  cleanFeatureSha: string;
  /** Head of the feature branch that touches `.claude/hooks/`. */
  claudeHooksFeatureSha: string;
}

async function makeE2ERepo(): Promise<E2ERepo> {
  const baseTmp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-husky-e2e-')),
  );
  const workDir = path.join(baseTmp, 'work');
  const remoteDir = path.join(baseTmp, 'remote.git');

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(remoteDir, { recursive: true });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  // Bare remote. `git push origin ...` from workDir goes here.
  git(remoteDir, 'init', '--bare', '--initial-branch=main', '--quiet');

  // Working copy, husky-style: `.husky/` as hooksPath.
  git(workDir, 'init', '--initial-branch=main', '--quiet');
  git(workDir, 'config', 'user.email', 'test@example.test');
  git(workDir, 'config', 'user.name', 'REA Test');
  git(workDir, 'config', 'commit.gpgsign', 'false');
  git(workDir, 'config', 'core.hooksPath', '.husky');
  git(workDir, 'remote', 'add', 'origin', remoteDir);

  // Install the SHIPPED hook. This is load-bearing — we are testing the
  // exact file `.husky/pre-push` that lands in consumer checkouts.
  const huskyDir = path.join(workDir, '.husky');
  await fs.mkdir(huskyDir, { recursive: true });
  const dest = path.join(huskyDir, 'pre-push');
  await fs.copyFile(SHIPPED_HUSKY_HOOK, dest);
  await fs.chmod(dest, 0o755);

  // Mirror the repo's compiled dist/ into the scratch repo via symlink.
  // The hook looks at `${REA_ROOT}/dist/scripts/read-policy-field.js` —
  // REA_ROOT resolves from `git rev-parse --show-toplevel`, which is the
  // scratch work dir, so dist/ must be visible there. `dist/policy` is
  // load-bearing too: `read-policy-field.js` imports `../policy/loader.js`,
  // and without the symlink the helper fail-closes to CODEX_REQUIRED=true,
  // which would make the "blocks" test pass through the wrong code path
  // (fail-closed rather than helper-returned-true). Symlink all three so
  // the gate's helper-succeeds branch is genuinely exercised.
  const scratchDist = path.join(workDir, 'dist');
  await fs.mkdir(scratchDist, { recursive: true });
  await fs.symlink(REPO_DIST_SCRIPTS, path.join(scratchDist, 'scripts'), 'dir');
  await fs.symlink(REPO_DIST_AUDIT, path.join(scratchDist, 'audit'), 'dir');
  await fs.symlink(REPO_DIST_POLICY, path.join(scratchDist, 'policy'), 'dir');

  // Policy: minimal profile, nothing fancy. Protected-path gate still fires
  // because `review.codex_required` is not explicitly false.
  const reaDir = path.join(workDir, '.rea');
  await fs.mkdir(reaDir, { recursive: true });
  await fs.writeFile(
    path.join(reaDir, 'policy.yaml'),
    'profile: minimal\nautonomy_level: L1\n',
  );

  // Baseline commit on main.
  await fs.writeFile(path.join(workDir, 'README.md'), '# e2e\n');
  git(workDir, 'add', 'README.md');
  git(workDir, 'commit', '-m', 'baseline', '--quiet');
  const mainSha = git(workDir, 'rev-parse', 'HEAD');

  // Push main to the bare remote so feature→main diffs have a base.
  git(workDir, 'push', 'origin', 'main', '--quiet');

  // Feature branch 1: protected path change. `hooks/__protected__.sh`
  // matches `^hooks/` in the PROTECTED_RE inside .husky/pre-push.
  git(workDir, 'checkout', '-b', 'feature-protected', '--quiet');
  const protectedDir = path.join(workDir, 'hooks');
  await fs.mkdir(protectedDir, { recursive: true });
  await fs.writeFile(
    path.join(protectedDir, '__protected__.sh'),
    '#!/bin/sh\necho protected path change\n',
  );
  git(workDir, 'add', 'hooks/__protected__.sh');
  git(workDir, 'commit', '-m', 'touch protected path', '--quiet');
  const protectedFeatureSha = git(workDir, 'rev-parse', 'HEAD');

  // Feature branch 2: docs-only change, no protected paths touched.
  git(workDir, 'checkout', 'main', '--quiet');
  git(workDir, 'checkout', '-b', 'feature-clean', '--quiet');
  await fs.writeFile(path.join(workDir, 'NOTES.md'), '# notes\n');
  git(workDir, 'add', 'NOTES.md');
  git(workDir, 'commit', '-m', 'docs only', '--quiet');
  const cleanFeatureSha = git(workDir, 'rev-parse', 'HEAD');

  // Feature branch 3: .claude/hooks/ change. This alternative of the
  // anchored PROTECTED_RE exists specifically because the consumer-install
  // copy of a hook is just as security-relevant as the source copy under
  // `hooks/` — a tampered `.claude/hooks/push-review-gate.sh` disables
  // the gate. Without this branch, the `^[.]claude/hooks/` anchor in the
  // shared core / .husky/pre-push has no e2e coverage.
  git(workDir, 'checkout', 'main', '--quiet');
  git(workDir, 'checkout', '-b', 'feature-claude-hooks', '--quiet');
  const scratchClaudeHooks = path.join(workDir, '.claude', 'hooks');
  await fs.mkdir(scratchClaudeHooks, { recursive: true });
  await fs.writeFile(
    path.join(scratchClaudeHooks, '__protected__.sh'),
    '#!/bin/sh\necho claude hooks path change\n',
  );
  git(workDir, 'add', '.claude/hooks/__protected__.sh');
  git(workDir, 'commit', '-m', 'touch .claude/hooks/', '--quiet');
  const claudeHooksFeatureSha = git(workDir, 'rev-parse', 'HEAD');

  return {
    workDir,
    remoteDir,
    mainSha,
    protectedFeatureSha,
    cleanFeatureSha,
    claudeHooksFeatureSha,
  };
}

async function writeHalt(dir: string, reason: string): Promise<void> {
  await fs.writeFile(path.join(dir, '.rea', 'HALT'), `${reason}\n`);
}

/**
 * Emit a schema-valid policy YAML. The `loadPolicy` call inside
 * `read-policy-field.js` runs zod strict validation — a minimal
 * `profile: minimal\nautonomy_level: L1\n` fails schema and forces the
 * helper into EXIT_MALFORMED. For the 4 tests that exercise the
 * fail-closed path that collapses to empty stdout anyway (same observable
 * as malformed), minimal YAML is fine. For the test that needs the
 * helper to actually return a scalar, we must emit every required field.
 */
function validPolicyYaml(codexRequired: boolean | undefined): string {
  const base = [
    'version: "1"',
    'profile: "bst-internal"',
    'installed_by: "husky-e2e-test"',
    'installed_at: "2026-04-20T00:00:00Z"',
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

describe('husky e2e — real git push → .husky/pre-push → exit propagation', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanup.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('blocks a real `git push` when protected paths change and no codex audit exists', async () => {
    const repo = await makeE2ERepo();
    cleanup.push(path.dirname(repo.workDir));

    // Checkout the protected-path branch so push includes hooks/__protected__.sh.
    execFileSync('git', ['checkout', 'feature-protected', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    const res = spawnSync(
      'git',
      ['push', 'origin', 'feature-protected:feature-protected'],
      {
        cwd: repo.workDir,
        encoding: 'utf8',
      },
    );

    // The shipped .husky/pre-push exits 1 on a protected-path block. git
    // maps a non-zero pre-push exit to a push failure, propagating some
    // non-zero status. We assert non-zero (not a hard "=== 1") because
    // different git versions have surfaced both 1 and 128 for hook-blocked
    // pushes. What matters is `status !== 0`.
    expect(res.status).not.toBe(0);

    // The block banner MUST appear in stderr — this is the load-bearing
    // check. A BUG-008-class regression (silent exit 0) would pass the
    // "status !== 0" check if git itself failed for an unrelated reason,
    // so the banner check is what proves the hook actually fired.
    expect(res.stderr).toMatch(/PUSH BLOCKED: protected paths changed/);

    // The remote must NOT have advanced past the baseline for this ref.
    // If the hook had silently exited 0, `git push` would have updated
    // refs/heads/feature-protected on the bare remote.
    const lsRemote = execFileSync(
      'git',
      ['ls-remote', 'origin', 'feature-protected'],
      { cwd: repo.workDir, encoding: 'utf8' },
    ).trim();
    expect(lsRemote).toBe('');
  }, 15_000);

  it('allows a real `git push` when only non-protected paths change', async () => {
    const repo = await makeE2ERepo();
    cleanup.push(path.dirname(repo.workDir));

    execFileSync('git', ['checkout', 'feature-clean', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    const res = spawnSync(
      'git',
      ['push', 'origin', 'feature-clean:feature-clean'],
      {
        cwd: repo.workDir,
        encoding: 'utf8',
      },
    );

    // Clean path: hook exits 0, push succeeds.
    expect(res.status).toBe(0);

    // The remote ref must now exist and point at the feature head.
    const lsRemote = execFileSync(
      'git',
      ['ls-remote', 'origin', 'feature-clean'],
      { cwd: repo.workDir, encoding: 'utf8' },
    ).trim();
    expect(lsRemote).toMatch(new RegExp(`^${repo.cleanFeatureSha}\\s`));
  }, 15_000);

  it('blocks under `.rea/HALT` before any protected-path check runs', async () => {
    const repo = await makeE2ERepo();
    cleanup.push(path.dirname(repo.workDir));

    await writeHalt(repo.workDir, 'husky-e2e-halt');

    // Even the clean branch must be blocked — HALT short-circuits the gate.
    execFileSync('git', ['checkout', 'feature-clean', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    const res = spawnSync(
      'git',
      ['push', 'origin', 'feature-clean:feature-clean'],
      {
        cwd: repo.workDir,
        encoding: 'utf8',
      },
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/REA HALT: husky-e2e-halt/);
    expect(res.stderr).toMatch(/rea unfreeze/);
  }, 15_000);

  it('honors REA_SKIP_CODEX_REVIEW to let a protected-path push through', async () => {
    const repo = await makeE2ERepo();
    cleanup.push(path.dirname(repo.workDir));

    execFileSync('git', ['checkout', 'feature-protected', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    const res = spawnSync(
      'git',
      ['push', 'origin', 'feature-protected:feature-protected'],
      {
        cwd: repo.workDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          REA_SKIP_CODEX_REVIEW: 'e2e-test-waiver',
        },
      },
    );

    // Skip record lets the push through. Exit 0.
    expect(res.status).toBe(0);

    // And the waiver message surfaces in stderr so the operator knows a
    // gate was bypassed.
    expect(res.stderr).toMatch(/REA_SKIP_CODEX_REVIEW set \(e2e-test-waiver\)/);

    const lsRemote = execFileSync(
      'git',
      ['ls-remote', 'origin', 'feature-protected'],
      { cwd: repo.workDir, encoding: 'utf8' },
    ).trim();
    expect(lsRemote).toMatch(new RegExp(`^${repo.protectedFeatureSha}\\s`));
  }, 15_000);

  it('honors review.codex_required: false in policy (helper-returns-scalar branch)', async () => {
    // This is the ONLY test that actually proves the read-policy-field.js
    // helper's success-with-value branch works end-to-end. Every other test
    // in this suite has policy without `review.codex_required`, so the
    // helper exits EXIT_MISSING → empty stdout → fail-closed CODEX_REQUIRED=true
    // (observably identical to the helper failing to import at all). Here
    // we write `review.codex_required: false`, which makes the helper print
    // `"false"`, which makes the hook skip the Codex audit check entirely.
    // A regression in the helper (e.g. returning `true` unconditionally, or
    // mis-parsing the YAML) would flip this test from exit 0 to exit 1.
    const repo = await makeE2ERepo();
    cleanup.push(path.dirname(repo.workDir));

    // Override the default scratch policy with a SCHEMA-VALID YAML that
    // sets the scalar. A minimal YAML fails zod validation in loadPolicy
    // → helper exits EXIT_MALFORMED → observable collapses to the same
    // fail-closed path as the other tests, which defeats the point of
    // this test. The full YAML lets the helper actually run its scalar
    // branch.
    await fs.writeFile(
      path.join(repo.workDir, '.rea', 'policy.yaml'),
      validPolicyYaml(false),
    );

    execFileSync('git', ['checkout', 'feature-protected', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    // Explicitly strip REA_SKIP_CODEX_REVIEW from the child env so this
    // test cannot spuriously pass via the waiver path if a developer or
    // CI has the variable set in their shell. The waiver path is covered
    // separately by the test above; we want this one to succeed ONLY via
    // the helper-returns-"false" branch.
    const childEnv = { ...process.env };
    delete childEnv.REA_SKIP_CODEX_REVIEW;

    const res = spawnSync(
      'git',
      ['push', 'origin', 'feature-protected:feature-protected'],
      {
        cwd: repo.workDir,
        encoding: 'utf8',
        env: childEnv,
      },
    );

    // Policy opts out of Codex. No audit entry required. Push succeeds.
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/PUSH BLOCKED/);

    const lsRemote = execFileSync(
      'git',
      ['ls-remote', 'origin', 'feature-protected'],
      { cwd: repo.workDir, encoding: 'utf8' },
    ).trim();
    expect(lsRemote).toMatch(new RegExp(`^${repo.protectedFeatureSha}\\s`));
  }, 15_000);

  it('blocks a real `git push` for a manual native-adapter wrapper (shape-guard for future installer path)', async () => {
    // Task #50 shipped `hooks/push-review-gate-git.sh` — a thin adapter
    // that sources `hooks/_lib/push-review-core.sh`. The recommended
    // MANUAL install is a small `.husky/pre-push` wrapper that execs the
    // adapter directly rather than going through the generic JSON-parsing
    // `push-review-gate.sh`. That path has unit coverage
    // (`push-review-gate-git-adapter.test.ts`) but synthesizes stdin via
    // spawnSync — no real `git push`. This test closes the e2e gap.
    //
    // IMPORTANT: `rea init` does NOT currently emit this wrapper — today
    // the installer writes the full in-line gate as `.husky/pre-push`
    // (see `src/cli/install/pre-push.ts`). This test exists as a
    // shape-guard for (a) consumers who manually configure the wrapper
    // and (b) a future installer revision that may switch to the
    // wrapper-plus-adapter topology. If the adapter, the shared core, or
    // the install wiring regresses, a REAL push goes through instead of
    // being blocked and this test flips red.
    const repo = await makeE2ERepo();
    cleanup.push(path.dirname(repo.workDir));

    // Overwrite `.husky/pre-push` with the recommended adapter wrapper.
    // The adapter and its shared core live under `.claude/hooks/` to
    // mirror the consumer install topology (copied in by `rea init`).
    const claudeHooks = path.join(repo.workDir, '.claude', 'hooks');
    await fs.mkdir(path.join(claudeHooks, '_lib'), { recursive: true });
    const adapterDest = path.join(claudeHooks, 'push-review-gate-git.sh');
    await fs.copyFile(NATIVE_GIT_ADAPTER, adapterDest);
    await fs.chmod(adapterDest, 0o755);
    const coreDest = path.join(claudeHooks, '_lib', 'push-review-core.sh');
    await fs.copyFile(SHARED_CORE, coreDest);
    await fs.chmod(coreDest, 0o755);

    const wrapper = [
      '#!/bin/sh',
      'REA_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)',
      'exec "$REA_ROOT/.claude/hooks/push-review-gate-git.sh" "$@"',
      '',
    ].join('\n');
    const huskyHook = path.join(repo.workDir, '.husky', 'pre-push');
    await fs.writeFile(huskyHook, wrapper);
    await fs.chmod(huskyHook, 0o755);

    execFileSync('git', ['checkout', 'feature-protected', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    const res = spawnSync(
      'git',
      ['push', 'origin', 'feature-protected:feature-protected'],
      {
        cwd: repo.workDir,
        encoding: 'utf8',
      },
    );

    // Adapter routes through the shared core, which emits the same
    // "PUSH BLOCKED: protected paths changed" banner as the standalone
    // husky hook does. Non-zero exit + remote ref not advanced.
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/PUSH BLOCKED: protected paths changed/);

    const lsRemote = execFileSync(
      'git',
      ['ls-remote', 'origin', 'feature-protected'],
      { cwd: repo.workDir, encoding: 'utf8' },
    ).trim();
    expect(lsRemote).toBe('');
  }, 15_000);

  it('regression: BUG-008 — a pre-push hook that silently exits 0 would fail THIS test', async () => {
    // Sanity check — prove the above "blocks" assertion is load-bearing by
    // installing a deliberately-broken noop hook and showing the bare
    // push-succeeded outcome. If someone ever reintroduces a silent-exit-0
    // bug into `.husky/pre-push`, the blocking test above will flip the
    // same way this counterfactual does here.
    const repo = await makeE2ERepo();
    cleanup.push(path.dirname(repo.workDir));

    // Overwrite the shipped hook with a silent-exit-0 stub.
    const noopHook = '#!/bin/sh\nexit 0\n';
    const dest = path.join(repo.workDir, '.husky', 'pre-push');
    await fs.writeFile(dest, noopHook);
    await fs.chmod(dest, 0o755);

    execFileSync('git', ['checkout', 'feature-protected', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    const res = spawnSync(
      'git',
      ['push', 'origin', 'feature-protected:feature-protected'],
      {
        cwd: repo.workDir,
        encoding: 'utf8',
      },
    );

    // With a noop hook, the push succeeds. If the real-hook test above ever
    // also shows status=0, it means the shipped hook regressed into this
    // silent-noop state.
    expect(res.status).toBe(0);
    const lsRemote = execFileSync(
      'git',
      ['ls-remote', 'origin', 'feature-protected'],
      { cwd: repo.workDir, encoding: 'utf8' },
    ).trim();
    expect(lsRemote).toMatch(new RegExp(`^${repo.protectedFeatureSha}\\s`));
  }, 15_000);

  it('blocks a real `git push` that touches `.claude/hooks/` (PROTECTED_RE `^[.]claude/hooks/` alternative)', async () => {
    // Codex review #3 (2026-04-20) pointed out that the anchored
    // PROTECTED_RE in the shared core and in the standalone .husky/pre-push
    // has five alternatives but only three were e2e-covered before this
    // test: `^hooks/` (feature-protected), docs paths in the negative
    // sense (feature-clean), and the codex-required=false opt-out. The
    // `^[.]claude/hooks/` alternative — which exists specifically because
    // the consumer-install copy of a hook is as security-relevant as the
    // source under `hooks/` — had no real-push coverage. A regex that
    // anchored the other alternatives but not this one (e.g. dropping the
    // `^` in front of `[.]claude/hooks/`) would now match foreign paths
    // like `src/[.]claude/hooks/...` while missing the intended surface,
    // and nothing in this suite would flip. This test closes that gap.
    const repo = await makeE2ERepo();
    cleanup.push(path.dirname(repo.workDir));

    execFileSync('git', ['checkout', 'feature-claude-hooks', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    const res = spawnSync(
      'git',
      ['push', 'origin', 'feature-claude-hooks:feature-claude-hooks'],
      {
        cwd: repo.workDir,
        encoding: 'utf8',
      },
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/PUSH BLOCKED: protected paths changed/);

    const lsRemote = execFileSync(
      'git',
      ['ls-remote', 'origin', 'feature-claude-hooks'],
      { cwd: repo.workDir, encoding: 'utf8' },
    ).trim();
    expect(lsRemote).toBe('');
  }, 15_000);

  it('blocks a bootstrap push of protected paths to a remote with no tracking refs (Codex 0.7.0 pass-2 finding 1)', async () => {
    // Regression for the HIGH finding from the second Codex adversarial
    // review pass on this branch: the bootstrap-scenario `continue` in
    // `.husky/pre-push` was a real fail-open. An operator whose first push
    // touched a protected path — and whose remote had no resolved tracking
    // ref yet (no `origin/HEAD`, no `origin/main`, no `origin/master`) —
    // would have the gate silently skip the refspec and `exit 0`, letting
    // the push ship without a `codex.review` receipt. The fix uses the
    // well-known empty-tree SHA (`4b825dc642cb...`) as the baseline so the
    // protected-path diff runs over the FULL change set of the push.
    //
    // This test builds a scratch repo that mirrors the bootstrap shape:
    // a bare remote with NO refs of any kind, and a local that has never
    // pushed to it. The first push targets `feature-protected` (which
    // touches `hooks/__protected__.sh`). Before the fix, this push
    // silently succeeded. After the fix, it MUST block.
    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'rea-husky-e2e-bootstrap-'),
    );
    cleanup.push(tmpRoot);

    const workDir = path.join(tmpRoot, 'work');
    const remoteDir = path.join(tmpRoot, 'remote.git');

    await fs.mkdir(workDir, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main', '--quiet', workDir], {
      encoding: 'utf8',
    });
    execFileSync('git', ['init', '--bare', '--quiet', remoteDir], {
      encoding: 'utf8',
    });

    // Local-only config to avoid polluting $HOME. No hook setup beyond
    // `.husky/` + `core.hooksPath` — the hook is the shipped file.
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(workDir, 'config', 'user.email', 'e2e-bootstrap@rea.test');
    git(workDir, 'config', 'user.name', 'REA Husky E2E Bootstrap');
    git(workDir, 'config', 'commit.gpgsign', 'false');
    git(workDir, 'config', 'core.hooksPath', '.husky');
    git(workDir, 'remote', 'add', 'origin', remoteDir);

    // Install the SHIPPED hook byte-for-byte.
    const huskyDir = path.join(workDir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    const dest = path.join(huskyDir, 'pre-push');
    await fs.copyFile(SHIPPED_HUSKY_HOOK, dest);
    await fs.chmod(dest, 0o755);

    // Mirror dist/ so the policy-field helper resolves.
    const scratchDist = path.join(workDir, 'dist');
    await fs.mkdir(scratchDist, { recursive: true });
    await fs.symlink(REPO_DIST_SCRIPTS, path.join(scratchDist, 'scripts'), 'dir');
    await fs.symlink(REPO_DIST_AUDIT, path.join(scratchDist, 'audit'), 'dir');
    await fs.symlink(REPO_DIST_POLICY, path.join(scratchDist, 'policy'), 'dir');

    // Minimal policy: codex_required defaults to true (absent field).
    const reaDir = path.join(workDir, '.rea');
    await fs.mkdir(reaDir, { recursive: true });
    await fs.writeFile(
      path.join(reaDir, 'policy.yaml'),
      'profile: minimal\nautonomy_level: L1\n',
    );

    // Baseline commit on main, plus a feature commit that touches a
    // protected path. CRUCIALLY, we do NOT push main first. The bare
    // remote stays empty, so origin/HEAD, origin/main, origin/master
    // all fail to resolve when the hook tries them.
    await fs.writeFile(path.join(workDir, 'README.md'), '# bootstrap e2e\n');
    git(workDir, 'add', 'README.md');
    git(workDir, 'commit', '-m', 'baseline', '--quiet');

    git(workDir, 'checkout', '-b', 'feature-protected', '--quiet');
    const protectedDir = path.join(workDir, 'hooks');
    await fs.mkdir(protectedDir, { recursive: true });
    await fs.writeFile(
      path.join(protectedDir, '__protected__.sh'),
      '#!/bin/sh\necho bootstrap-protected\n',
    );
    git(workDir, 'add', 'hooks/__protected__.sh');
    git(workDir, 'commit', '-m', 'touch protected path', '--quiet');
    const featureSha = git(workDir, 'rev-parse', 'HEAD');

    // Confirm the remote truly has no refs of any kind — if this assert
    // fails, the test's premise is broken and the block below could pass
    // for the wrong reason (e.g. origin/main resolved after all).
    const remoteRefs = execFileSync('git', ['ls-remote', 'origin'], {
      cwd: workDir,
      encoding: 'utf8',
    }).trim();
    expect(remoteRefs).toBe('');

    // First push of a protected-path branch to the empty remote. Before
    // the fix, the hook `continue`d in the bootstrap path and the push
    // silently succeeded. After the fix, the empty-tree baseline produces
    // a diff containing `hooks/__protected__.sh` and the protected-path
    // check fires — exit 1, push blocked.
    const res = spawnSync(
      'git',
      ['push', 'origin', 'feature-protected:feature-protected'],
      { cwd: workDir, encoding: 'utf8' },
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/PUSH BLOCKED: protected paths changed/);

    // The bare remote must still have no refs — the push did not land.
    const postRemoteRefs = execFileSync('git', ['ls-remote', 'origin'], {
      cwd: workDir,
      encoding: 'utf8',
    }).trim();
    expect(postRemoteRefs).toBe('');

    // Sanity: with REA_SKIP_CODEX_REVIEW set, the same bootstrap push is
    // allowed through. Proves the fix blocks on the INTENDED gate (the
    // codex-audit requirement), not on a collateral breakage of the
    // bootstrap path.
    const skipRes = spawnSync(
      'git',
      ['push', 'origin', 'feature-protected:feature-protected'],
      {
        cwd: workDir,
        encoding: 'utf8',
        env: { ...process.env, REA_SKIP_CODEX_REVIEW: 'bootstrap-e2e-sanity' },
      },
    );
    expect(skipRes.status).toBe(0);
    const lsRemote = execFileSync(
      'git',
      ['ls-remote', 'origin', 'feature-protected'],
      { cwd: workDir, encoding: 'utf8' },
    ).trim();
    expect(lsRemote).toMatch(new RegExp(`^${featureSha}\\s`));
  }, 20_000);

  it('uses the $1 remote name (not hardcoded origin) for the fallback probe (Codex 0.7.0 pass-2 finding 2)', async () => {
    // Regression for the MEDIUM finding from the second Codex adversarial
    // review: `.husky/pre-push` previously hardcoded `refs/remotes/origin/*`
    // in the fallback probe chain, but git passes the remote name as $1 to
    // pre-push. A `git push upstream feature` would probe stale or missing
    // `origin/*` refs even when `upstream/main` existed and would have
    // given a valid baseline. Combined with finding 1, this could silently
    // skip a gated push.
    //
    // This test creates a repo with `upstream` as the push target and NO
    // `origin` remote at all. `origin/main` cannot resolve because `origin`
    // doesn't exist. Pre-fix, the hook probed `origin/*`, found nothing,
    // and either failed-open (pre-finding-1 fix) or blocked on a refspec
    // that resolved incorrectly. Post-fix, the hook reads `$1=upstream`
    // and successfully anchors on `upstream/main`, producing a correct
    // diff for the protected-path check.
    const repo = await makeE2ERepo();
    cleanup.push(path.dirname(repo.workDir));

    // Rename `origin` to `upstream` so the hook must honor $1.
    execFileSync('git', ['remote', 'rename', 'origin', 'upstream'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });
    // Force a fetch so `upstream/main` is a real remote-tracking ref (the
    // rename preserves it, but be explicit).
    execFileSync('git', ['fetch', 'upstream', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    execFileSync('git', ['checkout', 'feature-protected', '--quiet'], {
      cwd: repo.workDir,
      encoding: 'utf8',
    });

    const res = spawnSync(
      'git',
      ['push', 'upstream', 'feature-protected:feature-protected'],
      {
        cwd: repo.workDir,
        encoding: 'utf8',
      },
    );

    // The gate must fire with `upstream/*` as the anchor. Absent the $1
    // parameterization, the fallback would probe non-existent `origin/*`
    // and (pre-finding-1 fix) fail-open via bootstrap skip. Post-fix,
    // `upstream/main` exists → merge-base resolves → diff contains the
    // protected file → gate blocks.
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/PUSH BLOCKED: protected paths changed/);
  }, 15_000);
});
