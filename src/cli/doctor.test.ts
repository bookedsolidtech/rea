/**
 * Unit tests for `rea doctor`'s conditional Codex-check behavior (G11.4).
 *
 * `collectChecks(baseDir)` is the testable seam — it returns the same
 * sequence of CheckResults that `runDoctor` prints. We drive it against
 * scratch repos with different `review.codex_required` settings and assert
 * on which checks are present and their status.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkCodexBinaryOnPath,
  checkDelegationRoundTrip,
  checkFingerprintStore,
  checkG1SpecGateCli,
  checkPolicyReaderJq,
  checkPolicyReaderTier1,
  checkPolicyReaderTier2,
  checkPolicyReaderTier3,
  checkPolicyReaderTierSummary,
  checkPrepareCommitMsgHook,
  checkSpineInstalled,
  checkTokenEconomy,
  checksFromProbeState,
  collectChecks,
  type CheckResult,
  type PolicyReaderProbes,
} from './doctor.js';

const execFileAsync = promisify(execFile);
import { FINGERPRINT_STORE_VERSION, saveFingerprintStore } from '../registry/fingerprints-store.js';
import { fingerprintServer } from '../registry/fingerprint.js';
import type { RegistryServer } from '../registry/types.js';
import type { CodexProbeState } from '../gateway/observability/codex-probe.js';
import type { PrePushDoctorState } from './install/pre-push.js';

interface ScratchRepo {
  dir: string;
}

/**
 * Minimal doctor-friendly scratch directory — creates `.rea/policy.yaml`,
 * `.rea/registry.yaml`, the `.claude/` skeleton, and a `.git/hooks/commit-msg`
 * so every non-Codex check can report `pass`. The caller supplies the value
 * of `review.codex_required` (or undefined to omit the field).
 */
async function makeScratchRepo(opts: { codexRequired: boolean | undefined }): Promise<ScratchRepo> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-test-')));

  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  const policyLines = [
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
  if (opts.codexRequired !== undefined) {
    policyLines.push('review:', `  codex_required: ${opts.codexRequired}`);
  }
  policyLines.push('');
  await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), policyLines.join('\n'));
  await fs.writeFile(
    path.join(dir, '.rea', 'registry.yaml'),
    ['version: "1"', 'servers: []', ''].join('\n'),
  );

  // Simulate a git repo so the non-git escape hatch does NOT kick in for
  // tests that are exercising the git-hook checks directly. Tests that want
  // to exercise the non-git path create a scratch dir without `.git/`.
  await fs.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });

  return { dir };
}

function findCheck(checks: CheckResult[], labelFragment: string): CheckResult | undefined {
  return checks.find((c) => c.label.includes(labelFragment));
}

describe('rea doctor — collectChecks (G11.4 codex_required)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('codex_required=false: Codex-specific checks are replaced by a single info line', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);

    const checks = collectChecks(repo.dir);

    // No Codex-specific checks.
    expect(findCheck(checks, 'codex-adversarial agent installed')).toBeUndefined();
    expect(findCheck(checks, '/codex-review command installed')).toBeUndefined();

    // Exactly one Codex info line. The 0.13.0 extension-fragments probe
    // (H) also emits an info line; filter the codex-only one for this
    // assertion.
    const codexInfoLines = checks.filter((c) => c.status === 'info' && c.label === 'codex');
    expect(codexInfoLines).toHaveLength(1);
    expect(codexInfoLines[0]?.detail).toMatch(/codex_required/);
    expect(codexInfoLines[0]?.detail).toMatch(/disabled via policy/);
  });

  it('codex_required=true: Codex-specific checks are present (regression)', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);

    const checks = collectChecks(repo.dir);

    // Both Codex-specific checks appear.
    expect(findCheck(checks, 'codex-adversarial agent installed')).toBeDefined();
    expect(findCheck(checks, '/codex-review command installed')).toBeDefined();

    // No `codex` info line — the codex-disabled short-circuit didn't fire.
    // (The extension-fragments probe (H) emits its own info line; that's
    // unrelated to codex configuration.)
    expect(checks.some((c) => c.status === 'info' && c.label === 'codex')).toBe(false);
  });

  it('review field absent: defaults to codex_required=true (regression)', async () => {
    const repo = await makeScratchRepo({ codexRequired: undefined });
    cleanup.push(repo.dir);

    const checks = collectChecks(repo.dir);

    expect(findCheck(checks, 'codex-adversarial agent installed')).toBeDefined();
    expect(findCheck(checks, '/codex-review command installed')).toBeDefined();
    expect(checks.some((c) => c.status === 'info' && c.label === 'codex')).toBe(false);
  });

  it('codex_required=true + probe responsive: adds cli_responsive pass + last_probe_at info', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const probeState: CodexProbeState = {
      cli_installed: true,
      cli_authenticated: true,
      cli_responsive: true,
      last_probe_at: '2026-04-18T12:00:00.000Z',
      version: 'codex 1.2.3',
    };
    const checks = collectChecks(repo.dir, probeState);
    const responsive = findCheck(checks, 'codex.cli_responsive');
    expect(responsive?.status).toBe('pass');
    expect(responsive?.detail).toMatch(/codex 1\.2\.3/);
    const lastProbe = findCheck(checks, 'codex.last_probe_at');
    expect(lastProbe?.status).toBe('info');
    expect(lastProbe?.detail).toBe('2026-04-18T12:00:00.000Z');
  });

  it('codex_required=true + probe failed: cli_responsive is warn with error detail', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const probeState: CodexProbeState = {
      cli_installed: false,
      cli_authenticated: false,
      cli_responsive: false,
      last_probe_at: '2026-04-18T12:00:00.000Z',
      last_error: 'codex --version: not installed (ENOENT)',
    };
    const checks = collectChecks(repo.dir, probeState);
    const responsive = findCheck(checks, 'codex.cli_responsive');
    expect(responsive?.status).toBe('warn');
    expect(responsive?.detail).toMatch(/ENOENT/);
  });

  it('codex_required=false + probe state provided: probe-derived fields are NOT added', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const probeState: CodexProbeState = {
      cli_installed: true,
      cli_authenticated: true,
      cli_responsive: true,
      last_probe_at: '2026-04-18T12:00:00.000Z',
    };
    const checks = collectChecks(repo.dir, probeState);
    // Probe-derived lines live under the codex-required branch; in no-
    // codex mode they must not leak through.
    expect(findCheck(checks, 'codex.cli_responsive')).toBeUndefined();
    expect(findCheck(checks, 'codex.last_probe_at')).toBeUndefined();
  });

  it('checksFromProbeState: pass row and info row', () => {
    const out = checksFromProbeState({
      cli_installed: true,
      cli_authenticated: true,
      cli_responsive: true,
      last_probe_at: '2026-04-18T12:00:00.000Z',
      version: 'codex 1.0.0',
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.status).toBe('pass');
    expect(out[1]?.status).toBe('info');
  });

  it('G6: pre-push state omitted → pre-push check is NOT present (back-compat)', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const checks = collectChecks(repo.dir);
    expect(findCheck(checks, 'pre-push hook installed')).toBeUndefined();
  });

  it('G6: pre-push state ok=true → pre-push check passes', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    const state: PrePushDoctorState = {
      ok: true,
      activeForeign: false,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: true,
          reaManaged: true,
          delegatesToGate: true,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('pass');
    expect(check?.detail).toMatch(/rea-managed/);
  });

  it('G6: pre-push state ok=false with file present but not executable → fail with detail', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    const state: PrePushDoctorState = {
      ok: false,
      activeForeign: false,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: false,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/not executable/);
  });

  it('G6: pre-push state ok=false with no candidates present → fail with install hint', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    const state: PrePushDoctorState = {
      ok: false,
      activeForeign: false,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: false,
          executable: false,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/no pre-push hook found/);
    expect(check?.detail).toMatch(/rea init/);
  });

  it('G6: executable-but-foreign active hook → fail, not pass', async () => {
    // Finding 1 from the Codex post-merge review: an executable pre-push
    // that does NOT reference the review gate used to pass doctor because
    // the check only looked at `exists + executable`. With the governance
    // requirement threaded through, this is now always a fail with guidance.
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    const state: PrePushDoctorState = {
      ok: false,
      activeForeign: true,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: true,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/silently bypassed/);
    expect(check?.detail).toMatch(/rea hook push-gate/);
  });

  it('G6: executable foreign hook that DOES delegate to the gate → pass', async () => {
    // Consumer wrote their own pre-push but called the shared gate. This
    // is a legitimate integration path — warn would be noise.
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    const state: PrePushDoctorState = {
      ok: true,
      activeForeign: false,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: true,
          reaManaged: false,
          delegatesToGate: true,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('pass');
    expect(check?.detail).toMatch(/delegates to `rea hook push-gate`/);
  });

  it('codex_required=false: absence of the codex agent does not fail the check', async () => {
    // With codex_required=false, the Codex-specific checks are skipped, so
    // missing `.claude/agents/codex-adversarial.md` produces no fail. This
    // is the user-facing "Doctor: OK" promise: disabling Codex should not
    // leave doctor stuck with a permanent fail.
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);

    // We never created .claude/agents/ — so the agent check (which runs for
    // the full 10-agent roster) would still fail on non-codex agents. We
    // only assert here that the CODEX-SPECIFIC checks are absent; the
    // broader "curated agents installed" check is orthogonal and handled
    // by `checkAgentsPresent`.
    const checks = collectChecks(repo.dir);
    const codexChecks = checks.filter((c) =>
      /codex-adversarial|codex-review command/.test(c.label),
    );
    expect(codexChecks).toHaveLength(0);
  });

  it('G6 strict=false (default): activeForeign yields fail (always)', async () => {
    // activeForeign is always a fail regardless of strict mode — a foreign hook
    // that bypasses the review gate is a governance gap, not just a warning.
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    const state: PrePushDoctorState = {
      ok: false,
      activeForeign: true,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: true,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/silently bypassed/);
  });

  it('G6: activeForeign + commitlint reference → fail with .d/ migration hint', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    await fs.writeFile(hookPath, '#!/bin/sh\nnpx --no-install commitlint --edit "$1"\nexit 0\n', {
      mode: 0o755,
    });
    const state: PrePushDoctorState = {
      ok: false,
      activeForeign: true,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: true,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/Detected prior tooling.*commitlint/);
    expect(check?.detail).toMatch(/\.husky\/pre-push\.d\//);
    expect(check?.detail).toMatch(/MIGRATING\.md/);
  });

  it('G6: activeForeign + multiple tools → all surfaced in hint', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    await fs.writeFile(
      hookPath,
      [
        '#!/bin/sh',
        '# pre-push gate',
        'pnpm lint-staged',
        './scripts/act-ci.sh',
        'gitleaks detect --redact',
      ].join('\n'),
      { mode: 0o755 },
    );
    const state: PrePushDoctorState = {
      ok: false,
      activeForeign: true,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: true,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/lint-staged/);
    expect(check?.detail).toMatch(/act-CI/);
    expect(check?.detail).toMatch(/gitleaks/);
  });

  it('G6: activeForeign with no recognized tools → fail without hint clutter', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    await fs.writeFile(hookPath, '#!/bin/sh\necho hi\nexit 0\n', { mode: 0o755 });
    const state: PrePushDoctorState = {
      ok: false,
      activeForeign: true,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: true,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).not.toMatch(/Detected prior tooling/);
  });

  it('G6 strict=true: activeForeign yields fail, not warn', async () => {
    // Finding 2 — strict mode: CI must exit non-zero when the active pre-push
    // hook does not invoke the review gate. This is the governance-absent
    // state the gate exists to prevent.
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    const state: PrePushDoctorState = {
      ok: false,
      activeForeign: true,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: true,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };
    const checks = collectChecks(repo.dir, undefined, state);
    const check = findCheck(checks, 'pre-push hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/silently bypassed/);
  });
});

describe('rea doctor — non-git escape hatch', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function makeNonGitScratch(): Promise<ScratchRepo> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-nongit-')));
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      [
        'version: "1"',
        'profile: "bst-internal"',
        'installed_by: "test"',
        'installed_at: "2026-04-19T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths:',
        '  - .env',
        'notification_channel: ""',
        'review:',
        '  codex_required: false',
        '',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(dir, '.rea', 'registry.yaml'),
      ['version: "1"', 'servers: []', ''].join('\n'),
    );
    // Deliberately no `.git/` directory — this is the non-git-repo path.
    return { dir };
  }

  it('no .git/ at baseDir: commit-msg + pre-push checks replaced by a single info line', async () => {
    const repo = await makeNonGitScratch();
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    const prePushState: PrePushDoctorState = {
      ok: false,
      activeForeign: false,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: false,
          executable: false,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };

    const checks = collectChecks(repo.dir, undefined, prePushState);

    // Neither git-hook check is present.
    expect(findCheck(checks, 'commit-msg hook installed')).toBeUndefined();
    expect(findCheck(checks, 'pre-push hook installed')).toBeUndefined();

    // Exactly one `git hooks` info line explains why.
    const gitInfo = findCheck(checks, 'git hooks');
    expect(gitInfo?.status).toBe('info');
    expect(gitInfo?.detail).toMatch(/not a git repo/);
  });

  it('no .git/: prePushState is never consulted, regardless of shape (F4)', async () => {
    // Property under test: when `isGitRepo(baseDir)` is false, `collectChecks`
    // short-circuits BEFORE touching `prePushState`. So passing a fabricated
    // state with `activeForeign: true` must NOT emit the "silently bypassed"
    // fail the git-repo path would emit for that same state. The state
    // object is physically impossible (foreign active hook in a non-git
    // dir) precisely to make the short-circuit property easy to assert.
    const repo = await makeNonGitScratch();
    cleanup.push(repo.dir);
    const hookPath = path.join(repo.dir, '.git', 'hooks', 'pre-push');
    const foreignState: PrePushDoctorState = {
      ok: false,
      activeForeign: true,
      activePath: hookPath,
      candidates: [
        {
          path: hookPath,
          exists: true,
          executable: true,
          reaManaged: false,
          delegatesToGate: false,
        },
      ],
    };

    const withState = collectChecks(repo.dir, undefined, foreignState);
    const withoutState = collectChecks(repo.dir, undefined, undefined);

    // The two calls produce identical check labels and statuses — the
    // short-circuit is total.
    const shape = (cs: CheckResult[]): Array<{ label: string; status: CheckResult['status'] }> =>
      cs.map((c) => ({ label: c.label, status: c.status }));
    expect(shape(withState)).toEqual(shape(withoutState));

    expect(findCheck(withState, 'pre-push hook installed')).toBeUndefined();
    expect(findCheck(withState, 'git hooks')?.status).toBe('info');
  });

  it('F4 mirror: git repo + undefined prePushState → commit-msg check present, pre-push check absent (back-compat)', async () => {
    // When `.git/` exists but the caller omits `prePushState`, the pre-push
    // check must NOT be emitted (back-compat for older call sites), but the
    // commit-msg check MUST still run. The non-git escape hatch changed the
    // branching structure, so lock this property in.
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);

    const checks = collectChecks(repo.dir, undefined, undefined);
    expect(findCheck(checks, 'commit-msg hook installed')).toBeDefined();
    expect(findCheck(checks, 'pre-push hook installed')).toBeUndefined();
    // And no non-git info line, because this IS a git repo.
    expect(findCheck(checks, 'git hooks')).toBeUndefined();
  });

  it('broken gitlink: `.git` is a file pointing at a non-existent gitdir → NOT a git repo (F1)', async () => {
    // A stale submodule or a linked worktree whose main repo was moved/
    // deleted leaves `.git` as a file with `gitdir: <stale-path>`. Git
    // itself reports "not a git repository" here; `rea doctor` must do
    // the same so the non-git escape hatch kicks in. A naive existence
    // check of `.git` would incorrectly return true and re-introduce the
    // exact hard-fail 0.5.1 is supposed to eliminate.
    const repo = await makeNonGitScratch();
    cleanup.push(repo.dir);
    const dotGit = path.join(repo.dir, '.git');
    await fs.writeFile(
      dotGit,
      'gitdir: /tmp/this/path/does/not/exist/rea-test-stale-gitlink\n',
      'utf8',
    );

    const checks = collectChecks(repo.dir);
    expect(findCheck(checks, 'commit-msg hook installed')).toBeUndefined();
    expect(findCheck(checks, 'git hooks')?.status).toBe('info');
  });

  it('broken gitlink with a RELATIVE target: still NOT a git repo (F1 relative branch)', async () => {
    // Exercises the `path.join(baseDir, targetPath)` resolution path for a
    // gitlink target that doesn't exist. The absolute-path version is
    // covered above; this one locks down the relative-path branch.
    const repo = await makeNonGitScratch();
    cleanup.push(repo.dir);
    await fs.writeFile(path.join(repo.dir, '.git'), 'gitdir: ./pruned-does-not-exist\n', 'utf8');

    const checks = collectChecks(repo.dir);
    expect(findCheck(checks, 'commit-msg hook installed')).toBeUndefined();
    expect(findCheck(checks, 'git hooks')?.status).toBe('info');
  });

  it('valid gitlink: `.git` is a file pointing at a real gitdir → treated as a git repo (F1)', async () => {
    // Positive counter-case: the gitlink parser must follow a valid
    // absolute or relative `gitdir:` reference and return true.
    const repo = await makeNonGitScratch();
    cleanup.push(repo.dir);
    const realGitDir = path.join(repo.dir, 'real-gitdir');
    await fs.mkdir(path.join(realGitDir, 'hooks'), { recursive: true });
    const dotGit = path.join(repo.dir, '.git');
    // Relative form — same as linked-worktree shape.
    await fs.writeFile(dotGit, 'gitdir: real-gitdir\n', 'utf8');

    const checks = collectChecks(repo.dir);
    // Git hooks branch fires; commit-msg check runs (and warns since we
    // haven't installed the hook).
    expect(findCheck(checks, 'git hooks')).toBeUndefined();
    expect(findCheck(checks, 'commit-msg hook installed')).toBeDefined();
  });

  it('`.git/` exists but `.git/hooks/` does not: commit-msg check warns, does not crash (F2)', async () => {
    // A partially-initialized repo (e.g. `git init --bare` in an unusual
    // place, or a manual checkout manipulation) can have `.git/` without
    // `.git/hooks/`. `isGitRepo` returns true for this shape, so the
    // git-hook checks run. They must degrade gracefully — not crash — and
    // report the missing hook as a warn. This matches the pre-0.5.1
    // behavior and is what consumers running `rea init` next would see.
    const repo = await makeNonGitScratch();
    cleanup.push(repo.dir);
    await fs.mkdir(path.join(repo.dir, '.git'), { recursive: true });
    // NO `.git/hooks/` directory.

    const checks = collectChecks(repo.dir);
    const commitMsg = findCheck(checks, 'commit-msg hook installed');
    expect(commitMsg?.status).toBe('warn');
    expect(commitMsg?.detail).toMatch(/missing/);
    // And the non-git info line is NOT emitted because `.git/` exists.
    expect(findCheck(checks, 'git hooks')).toBeUndefined();
  });
});

// ── 0.26.0 round-25 P3: doctor EXPECTED_HOOKS includes local-review-gate.sh ──
//
// The 0.26.0 local-first enforcement layer ships a new Bash-tier hook,
// `local-review-gate.sh`. Pre-fix doctor's EXPECTED_HOOKS list omitted it,
// so consumer installs upgrading to 0.26.0 with `local-review-gate.sh`
// missing-on-disk got `pass` from `rea doctor` — silently disabling the
// new guardrail. The smoke test below pins the EXPECTED_HOOKS set so a
// future drop of the hook from the list (or a regression in
// `checkHooksInstalled`) trips a hard failure here.
describe('rea doctor — EXPECTED_HOOKS coverage (round-25 P3)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('hooks-installed check fails with `missing local-review-gate.sh` when the hook is absent', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    // Populate every other shipped hook EXCEPT local-review-gate.sh — the
    // canonical-hook list pinned in `src/cli/doctor.ts` MUST include the
    // 0.26.0 entry, otherwise the absence of the file slides past doctor.
    const hooksDir = path.join(repo.dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const everyOtherHook = [
      'architecture-review-gate.sh',
      'attribution-advisory.sh',
      // 0.22.0 — round-27 F8 added to EXPECTED_HOOKS.
      'blocked-paths-bash-gate.sh',
      'blocked-paths-enforcer.sh',
      'changeset-security-gate.sh',
      'dangerous-bash-interceptor.sh',
      'dependency-audit-gate.sh',
      'env-file-protection.sh',
      'pr-issue-link-gate.sh',
      // 0.21.0 — round-27 F8 added to EXPECTED_HOOKS.
      'protected-paths-bash-gate.sh',
      'secret-scanner.sh',
      'security-disclosure-gate.sh',
      'settings-protection.sh',
    ];
    for (const name of everyOtherHook) {
      const p = path.join(hooksDir, name);
      await fs.writeFile(p, '#!/bin/bash\nexit 0\n');
      await fs.chmod(p, 0o755);
    }
    const checks = collectChecks(repo.dir);
    const hooksCheck = findCheck(checks, 'hooks installed + executable');
    expect(hooksCheck?.status).toBe('fail');
    // Detail must name the missing hook explicitly. If a future refactor
    // drops `local-review-gate.sh` from EXPECTED_HOOKS, this assertion
    // turns red — the canonical guard.
    expect(hooksCheck?.detail).toMatch(/missing local-review-gate\.sh/);
  });

  it('hooks-installed check passes when every canonical hook (including local-review-gate.sh) is present', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const hooksDir = path.join(repo.dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const allCanonical = [
      'architecture-review-gate.sh',
      'attribution-advisory.sh',
      // 0.51.0 — spend-governance E1 seed (billing→HALT reflex). Added to
      // EXPECTED_HOOKS at ship time (security-load-bearing + ships enabled
      // in every profile). Hook count is now 17 (was 16 in 0.36.0+).
      'billing-cap-halt.sh',
      'blocked-paths-bash-gate.sh',
      'blocked-paths-enforcer.sh',
      'changeset-security-gate.sh',
      'dangerous-bash-interceptor.sh',
      // 0.36.0 — `delegation-advisory.sh` PROMOTED into EXPECTED_HOOKS
      // (charter follow-through from 0.31.0). After 4 releases of
      // propagation (0.32/33/34/35), consumer installs that have run
      // `rea upgrade` since 0.31.0 already carry the hook, so the
      // upgrade-lag window holding it out has closed. Same ratchet
      // `delegation-capture.sh` went through 0.29.0 → 0.30.0. Hook
      // count is now 16 (was 15 in 0.31.0 → 0.35.0).
      'delegation-advisory.sh',
      // 0.29.0 — delegation-telemetry MVP. The Agent|Skill PreToolUse
      // capture hook.
      'delegation-capture.sh',
      'dependency-audit-gate.sh',
      'env-file-protection.sh',
      'local-review-gate.sh',
      'pr-issue-link-gate.sh',
      'protected-paths-bash-gate.sh',
      'secret-scanner.sh',
      'security-disclosure-gate.sh',
      'settings-protection.sh',
      // 0.54.0 — Artifact Gate G2 verification-gate (editor + Bash tiers).
      'verify-gate.sh',
      'verify-gate-bash-gate.sh',
    ];
    for (const name of allCanonical) {
      const p = path.join(hooksDir, name);
      await fs.writeFile(p, '#!/bin/bash\nexit 0\n');
      await fs.chmod(p, 0o755);
    }
    const checks = collectChecks(repo.dir);
    const hooksCheck = findCheck(checks, 'hooks installed + executable');
    expect(hooksCheck?.status).toBe('pass');
    // 0.54.0 — 19 shipped hooks (was 17 in 0.51.0). `verify-gate.sh` and
    // `verify-gate-bash-gate.sh` (Artifact Gate G2, editor + Bash tiers)
    // joined EXPECTED_HOOKS this release.
    expect(hooksCheck?.detail).toMatch(/19 hooks present/);
  });
});

// ── 0.26.0 round-27 F8: doctor EXPECTED_HOOKS includes the older Bash gates ──
//
// Pre-fix `EXPECTED_HOOKS` was missing two hooks that have shipped for
// multiple minors:
//   - protected-paths-bash-gate.sh (0.21.0+)
//   - blocked-paths-bash-gate.sh   (0.22.0+)
// Without them, doctor returned `pass` on consumer installs missing
// these security-load-bearing hooks. The two tests below pin each
// hook into EXPECTED_HOOKS — a regression dropping either entry from
// the list trips a hard failure here.
describe('rea doctor — EXPECTED_HOOKS coverage (round-27 F8)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('hooks-installed check fails with `missing protected-paths-bash-gate.sh` when the hook is absent', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const hooksDir = path.join(repo.dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    // Every canonical hook EXCEPT protected-paths-bash-gate.sh.
    const everyOtherHook = [
      'architecture-review-gate.sh',
      'attribution-advisory.sh',
      'blocked-paths-bash-gate.sh',
      'blocked-paths-enforcer.sh',
      'changeset-security-gate.sh',
      'dangerous-bash-interceptor.sh',
      'dependency-audit-gate.sh',
      'env-file-protection.sh',
      'local-review-gate.sh',
      'pr-issue-link-gate.sh',
      'secret-scanner.sh',
      'security-disclosure-gate.sh',
      'settings-protection.sh',
    ];
    for (const name of everyOtherHook) {
      const p = path.join(hooksDir, name);
      await fs.writeFile(p, '#!/bin/bash\nexit 0\n');
      await fs.chmod(p, 0o755);
    }
    const checks = collectChecks(repo.dir);
    const hooksCheck = findCheck(checks, 'hooks installed + executable');
    expect(hooksCheck?.status).toBe('fail');
    expect(hooksCheck?.detail).toMatch(/missing protected-paths-bash-gate\.sh/);
  });

  it('hooks-installed check fails with `missing blocked-paths-bash-gate.sh` when the hook is absent', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const hooksDir = path.join(repo.dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    // Every canonical hook EXCEPT blocked-paths-bash-gate.sh.
    const everyOtherHook = [
      'architecture-review-gate.sh',
      'attribution-advisory.sh',
      'blocked-paths-enforcer.sh',
      'changeset-security-gate.sh',
      'dangerous-bash-interceptor.sh',
      'dependency-audit-gate.sh',
      'env-file-protection.sh',
      'local-review-gate.sh',
      'pr-issue-link-gate.sh',
      'protected-paths-bash-gate.sh',
      'secret-scanner.sh',
      'security-disclosure-gate.sh',
      'settings-protection.sh',
    ];
    for (const name of everyOtherHook) {
      const p = path.join(hooksDir, name);
      await fs.writeFile(p, '#!/bin/bash\nexit 0\n');
      await fs.chmod(p, 0o755);
    }
    const checks = collectChecks(repo.dir);
    const hooksCheck = findCheck(checks, 'hooks installed + executable');
    expect(hooksCheck?.status).toBe('fail');
    expect(hooksCheck?.detail).toMatch(/missing blocked-paths-bash-gate\.sh/);
  });
});

describe('rea doctor — checkFingerprintStore (G7)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function scratchWithRegistry(servers: RegistryServer[]): Promise<ScratchRepo> {
    const repo = await makeScratchRepo({ codexRequired: false });
    const yaml = [
      'version: "1"',
      servers.length === 0 ? 'servers: []' : 'servers:',
      ...servers.flatMap((s) => [
        `  - name: ${s.name}`,
        `    command: ${s.command}`,
        `    args: ${JSON.stringify(s.args)}`,
      ]),
      '',
    ].join('\n');
    await fs.writeFile(path.join(repo.dir, '.rea', 'registry.yaml'), yaml);
    return repo;
  }

  function svr(name: string): RegistryServer {
    return { name, command: 'node', args: [], env: {}, enabled: true };
  }

  it('info when no enabled servers are declared', async () => {
    const repo = await scratchWithRegistry([]);
    cleanup.push(repo.dir);
    const r = await checkFingerprintStore(repo.dir);
    expect(r.status).toBe('info');
  });

  it('warn when the store is empty but servers are declared (first-seen ahead)', async () => {
    const repo = await scratchWithRegistry([svr('mock')]);
    cleanup.push(repo.dir);
    const r = await checkFingerprintStore(repo.dir);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/first-seen/);
  });

  it('pass when every server has a matching stored fingerprint', async () => {
    const s = svr('mock');
    const repo = await scratchWithRegistry([s]);
    cleanup.push(repo.dir);
    await saveFingerprintStore(repo.dir, {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: fingerprintServer(s) },
    });
    const r = await checkFingerprintStore(repo.dir);
    expect(r.status).toBe('pass');
  });

  it('warn when a server drifted from its stored fingerprint', async () => {
    const s = svr('mock');
    const repo = await scratchWithRegistry([s]);
    cleanup.push(repo.dir);
    // Store a different fingerprint to simulate drift.
    await saveFingerprintStore(repo.dir, {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: 'f'.repeat(64) },
    });
    const r = await checkFingerprintStore(repo.dir);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/drifted/);
  });

  it('fail when the fingerprint store is corrupt', async () => {
    const repo = await scratchWithRegistry([svr('mock')]);
    cleanup.push(repo.dir);
    await fs.writeFile(path.join(repo.dir, '.rea', 'fingerprints.json'), 'not { valid json');
    const r = await checkFingerprintStore(repo.dir);
    expect(r.status).toBe('fail');
  });
});

describe('rea doctor — checkCodexBinaryOnPath (Fix C / 0.12.0)', () => {
  const cleanup: string[] = [];
  const originalPath = process.env.PATH;

  afterEach(async () => {
    process.env.PATH = originalPath;
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('passes when a `codex` shim is on PATH', async () => {
    const tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-codex-pass-')),
    );
    cleanup.push(tmp);
    const shim = path.join(tmp, 'codex');
    await fs.writeFile(shim, '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
    process.env.PATH = `${tmp}${path.delimiter}${originalPath ?? ''}`;
    const r = checkCodexBinaryOnPath();
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/codex$/);
  });

  it('fails with actionable detail when codex is not on PATH', () => {
    // Restrict PATH to a directory that exists but contains no `codex`.
    process.env.PATH = '/var/empty';
    const r = checkCodexBinaryOnPath();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/codex not found on PATH/);
    expect(r.detail).toMatch(/codex_required: true/);
    expect(r.detail).toMatch(/codex_required: false/);
  });

  it('collectChecks includes codex CLI on PATH check when codex_required=true', async () => {
    const tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-cdx-collect-')),
    );
    cleanup.push(tmp);
    await fs.mkdir(path.join(tmp, '.rea'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.rea', 'policy.yaml'),
      [
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
        'review:',
        '  codex_required: true',
        '',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(tmp, '.rea', 'registry.yaml'),
      ['version: "1"', 'servers: []', ''].join('\n'),
    );
    await fs.mkdir(path.join(tmp, '.git', 'hooks'), { recursive: true });
    const checks = collectChecks(tmp);
    const cdx = checks.find((c) => c.label === 'codex CLI on PATH');
    expect(cdx).toBeDefined();
  });

  it('collectChecks omits codex CLI on PATH check when codex_required=false', async () => {
    const tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-cdx-collect-off-')),
    );
    cleanup.push(tmp);
    await fs.mkdir(path.join(tmp, '.rea'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.rea', 'policy.yaml'),
      [
        'version: "1"',
        'profile: "bst-internal-no-codex"',
        'installed_by: "test"',
        'installed_at: "2026-04-18T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths:',
        '  - .env',
        'notification_channel: ""',
        'review:',
        '  codex_required: false',
        '',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(tmp, '.rea', 'registry.yaml'),
      ['version: "1"', 'servers: []', ''].join('\n'),
    );
    await fs.mkdir(path.join(tmp, '.git', 'hooks'), { recursive: true });
    const checks = collectChecks(tmp);
    const cdx = checks.find((c) => c.label === 'codex CLI on PATH');
    expect(cdx).toBeUndefined();
  });
});

describe('rea doctor — checkExtensionFragments (Fix H / 0.13.0)', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('info "none" when no .husky/{commit-msg,pre-push}.d/ exists', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const checks = collectChecks(repo.dir);
    const ext = checks.find((c) => c.label === 'extension hook fragments');
    expect(ext).toBeDefined();
    expect(ext?.status).toBe('info');
    expect(ext?.detail).toMatch(/none/);
  });

  it('info with executable list when fragments exist', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const fragDir = path.join(repo.dir, '.husky', 'pre-push.d');
    await fs.mkdir(fragDir, { recursive: true });
    await fs.writeFile(path.join(fragDir, '10-foo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const checks = collectChecks(repo.dir);
    const ext = checks.find((c) => c.label === 'extension hook fragments');
    expect(ext?.status).toBe('info');
    expect(ext?.detail).toMatch(/1 executable/);
    expect(ext?.detail).toMatch(/pre-push\.d\/10-foo/);
  });

  it('warns when a non-executable file sits in the fragment dir (silently skipped)', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const fragDir = path.join(repo.dir, '.husky', 'commit-msg.d');
    await fs.mkdir(fragDir, { recursive: true });
    await fs.writeFile(path.join(fragDir, '10-noexec'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const checks = collectChecks(repo.dir);
    const ext = checks.find((c) => c.label === 'extension hook fragments');
    expect(ext?.status).toBe('warn');
    expect(ext?.detail).toMatch(/non-executable/);
    expect(ext?.detail).toMatch(/commit-msg\.d\/10-noexec/);
  });

  it('lists fragments from BOTH directories', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const cmDir = path.join(repo.dir, '.husky', 'commit-msg.d');
    const ppDir = path.join(repo.dir, '.husky', 'pre-push.d');
    await fs.mkdir(cmDir, { recursive: true });
    await fs.mkdir(ppDir, { recursive: true });
    await fs.writeFile(path.join(cmDir, '10-cm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(path.join(ppDir, '20-pp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const checks = collectChecks(repo.dir);
    const ext = checks.find((c) => c.label === 'extension hook fragments');
    expect(ext?.status).toBe('info');
    expect(ext?.detail).toMatch(/commit-msg\.d\/10-cm/);
    expect(ext?.detail).toMatch(/pre-push\.d\/20-pp/);
  });
});

/**
 * delegation-capture hook registration check.
 *
 * 0.29.0 shipped this as `warn` (advisory) — the `Agent|Skill`
 * matcher was a brand-new `defaultDesiredHooks()` entry and consumer
 * installs needed an upgrade cycle to catch up. 0.31.0 makes good on
 * the long-promised promotion: the matcher has been in the desired
 * set for multiple minors, so a still-missing registration is now a
 * hard `fail` — a consumer who skipped `rea upgrade` sees the
 * governance gap loudly. The three pre-fix `warn` cases below are now
 * `fail`.
 */
describe('rea doctor — delegation-capture hook registered (0.31.0: warn → fail)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function writeSettings(repoDir: string, settings: unknown): Promise<void> {
    await fs.mkdir(path.join(repoDir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, '.claude', 'settings.json'),
      JSON.stringify(settings, null, 2),
    );
  }

  it('fails when .claude/settings.json is missing', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-capture hook registered');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/missing|rea upgrade|rea init/);
  });

  it('fails when no Agent|Skill matcher group is registered', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    await writeSettings(repo.dir, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh' },
            ],
          },
        ],
      },
    });
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-capture hook registered');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/Agent\|Skill/);
  });

  it('fails when Agent|Skill matcher exists but no delegation-capture.sh command is present', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    await writeSettings(repo.dir, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Agent|Skill',
            hooks: [
              { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/other.sh' },
            ],
          },
        ],
      },
    });
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-capture hook registered');
    expect(check?.status).toBe('fail');
  });

  it('passes when Agent|Skill matcher references delegation-capture.sh', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    await writeSettings(repo.dir, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Agent|Skill',
            hooks: [
              {
                type: 'command',
                command:
                  '$CLAUDE_PROJECT_DIR/.claude/hooks/delegation-capture.sh',
              },
            ],
          },
        ],
      },
    });
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-capture hook registered');
    expect(check?.status).toBe('pass');
  });
});

/**
 * 0.31.0 — delegation-advisory hook registration check
 * (`checkDelegationAdvisoryHookRegistered`). Originally `warn`
 * (advisory) for 0.31.0 — the PostToolUse
 * `Bash|Edit|Write|MultiEdit|NotebookEdit` group was a brand-new
 * `defaultDesiredHooks()` entry, the exact upgrade-lag situation
 * `checkDelegationHookRegistered` faced in 0.29.0.
 *
 * 0.36.0 — PROMOTED warn → fail (charter follow-through). After 4
 * releases of upgrade-lag propagation (0.32 / 0.33 / 0.34 / 0.35),
 * consumer installs that have run `rea upgrade` since 0.31.0 already
 * carry the PostToolUse group. Same ratchet `checkDelegationHookRegistered`
 * went through 0.29.0 → 0.30.0.
 */
describe('rea doctor — delegation-advisory hook registered (0.31.0 advisory → 0.36.0 hard)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function writeSettings(repoDir: string, settings: unknown): Promise<void> {
    await fs.mkdir(path.join(repoDir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, '.claude', 'settings.json'),
      JSON.stringify(settings, null, 2),
    );
  }

  /** Lay down a stub `.claude/hooks/delegation-advisory.sh` so the
   * file-presence half of the check (round-2 P2) is satisfied. */
  async function writeAdvisoryHookFile(repoDir: string): Promise<void> {
    const hooksDir = path.join(repoDir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const p = path.join(hooksDir, 'delegation-advisory.sh');
    await fs.writeFile(p, '#!/bin/bash\nexit 0\n');
    await fs.chmod(p, 0o755);
  }

  it('fails (0.36.0 hard) when .claude/settings.json is missing', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-advisory hook registered');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/missing|rea upgrade|rea init/);
  });

  it('fails (0.36.0 hard) when no Bash|Edit|Write|MultiEdit|NotebookEdit PostToolUse group is registered', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    await writeSettings(repo.dir, {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit',
            hooks: [
              {
                type: 'command',
                command: '$CLAUDE_PROJECT_DIR/.claude/hooks/architecture-review-gate.sh',
              },
            ],
          },
        ],
      },
    });
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-advisory hook registered');
    expect(check?.status).toBe('fail');
    // Detail must name the matcher AND call out the Bash inclusion —
    // the nudge counts every write-class tool call, not just edits.
    expect(check?.detail).toMatch(/Bash\|Edit\|Write\|MultiEdit\|NotebookEdit/);
    expect(check?.detail).toMatch(/Bash/);
  });

  it('fails (0.36.0 hard) when the matcher group exists but no delegation-advisory.sh command is present', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    await writeSettings(repo.dir, {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit',
            hooks: [
              { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/other.sh' },
            ],
          },
        ],
      },
    });
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-advisory hook registered');
    expect(check?.status).toBe('fail');
  });

  it('passes when the matcher group references delegation-advisory.sh AND the hook file exists', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    await writeSettings(repo.dir, {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit',
            hooks: [
              {
                type: 'command',
                command: '$CLAUDE_PROJECT_DIR/.claude/hooks/delegation-advisory.sh',
              },
            ],
          },
        ],
      },
    });
    await writeAdvisoryHookFile(repo.dir);
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-advisory hook registered');
    expect(check?.status).toBe('pass');
  });

  it('fails (0.36.0 hard) when settings.json registers the hook but the .sh file is missing (round-2 P2)', async () => {
    // Regression pin: this registration check is one of two doctor
    // signals for the hook (0.36.0 also added it to EXPECTED_HOOKS for
    // hard-fail file-presence coverage from `checkHooksInstalled`).
    // The defense-in-depth file-presence check kept here lets the
    // failure message name the exact remediation rather than the
    // generic "missing X" enumeration `checkHooksInstalled` produces.
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    await writeSettings(repo.dir, {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit',
            hooks: [
              {
                type: 'command',
                command: '$CLAUDE_PROJECT_DIR/.claude/hooks/delegation-advisory.sh',
              },
            ],
          },
        ],
      },
    });
    // Deliberately do NOT call writeAdvisoryHookFile — the file is missing.
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-advisory hook registered');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/hook file is missing/);
    expect(check?.detail).toMatch(/delegation-advisory\.sh/);
  });

  it('fails (0.36.0 hard) when the hook file exists but is not executable (round-3 P2)', async () => {
    // Regression pin: a script copied without its mode bits (manual
    // `cp`, archive extracted without `+x` preservation) cannot be
    // launched by Claude Code from settings.json. `checkHooksInstalled`
    // does this `0o111` check for every `EXPECTED_HOOKS` entry too
    // (0.36.0 added `delegation-advisory.sh` there); this
    // registration check keeps the same `0o111` check as
    // defense-in-depth so the failure message can be specific.
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);
    await writeSettings(repo.dir, {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit',
            hooks: [
              {
                type: 'command',
                command: '$CLAUDE_PROJECT_DIR/.claude/hooks/delegation-advisory.sh',
              },
            ],
          },
        ],
      },
    });
    // Lay the file down but strip the executable bits (mode 0o644).
    const hooksDir = path.join(repo.dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'delegation-advisory.sh');
    await fs.writeFile(hookPath, '#!/bin/bash\nexit 0\n');
    await fs.chmod(hookPath, 0o644);
    const checks = collectChecks(repo.dir);
    const check = findCheck(checks, 'delegation-advisory hook registered');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/not executable/);
    expect(check?.detail).toMatch(/mode=644/);
  });
});

describe('rea doctor — checkPrepareCommitMsgHook hooks-dir resolution (0.30.1 round-5 P2)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function initRepo(): Promise<string> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-pcm-')));
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'test']);
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      ['version: "1"', 'profile: "minimal"', 'installed_by: "t"', ''].join('\n'),
    );
    return dir;
  }

  // 0.30.1 round-5 P2: resolveHooksDirSync now consults
  // `git rev-parse --git-path hooks` between the core.hooksPath check
  // and the `.git/hooks` literal fallback. In a vanilla repo that
  // resolves to `.git/hooks`; the value matters for worktrees /
  // submodules where `.git` is a pointer file, not a directory.
  it('resolves the canonical hooks dir in a vanilla git repo (no core.hooksPath)', async () => {
    const dir = await initRepo();
    // No attribution policy → enabled is false → check should be pass
    // ("disabled, no hook installed — vanilla state"), proving the
    // resolver returned a real directory and did not throw.
    const result = checkPrepareCommitMsgHook(dir);
    expect(result.status).toBe('pass');
    expect(result.label).toMatch(/prepare-commit-msg/);
  });

  it('resolves through core.hooksPath when explicitly set', async () => {
    const dir = await initRepo();
    const customHooks = path.join(dir, '.husky', '_');
    await fs.mkdir(customHooks, { recursive: true });
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky/_']);
    // Still no policy → still pass, but the resolution path went
    // through the core.hooksPath branch rather than git-path/default.
    const result = checkPrepareCommitMsgHook(dir);
    expect(result.status).toBe('pass');
  });

  it('does not throw when run outside a git repo (resolver falls through to literal default)', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-nogit-')));
    cleanup.push(dir);
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      ['version: "1"', 'profile: "minimal"', 'installed_by: "t"', ''].join('\n'),
    );
    expect(() => checkPrepareCommitMsgHook(dir)).not.toThrow();
  });

  // checkCommitMsgHook shares the same resolver. Pre-fix it hardcoded
  // `.git/hooks/commit-msg`, so a repo wired through `core.hooksPath=.husky`
  // (husky's classic install — git runs `.husky/commit-msg`, the attribution
  // gate IS active) warned "missing" on every single doctor run. The rea
  // dogfood repo itself hit this permanently. These pin the fix.
  it('commit-msg check passes when the hook lives at core.hooksPath (husky layout)', async () => {
    const dir = await initRepo();
    const husky = path.join(dir, '.husky');
    await fs.mkdir(husky, { recursive: true });
    await fs.writeFile(path.join(husky, 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky']);

    const checks = collectChecks(dir);
    const check = findCheck(checks, 'commit-msg hook installed');
    expect(check?.status).toBe('pass');
  });

  it('commit-msg check still warns when core.hooksPath is set but the hook is absent there', async () => {
    const dir = await initRepo();
    const husky = path.join(dir, '.husky');
    await fs.mkdir(husky, { recursive: true });
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky']);
    // A commit-msg at the DEFAULT location is dead weight once hooksPath
    // points elsewhere — git never runs it, so it must NOT satisfy the check.
    await fs.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(dir, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 0\n');

    const checks = collectChecks(dir);
    const check = findCheck(checks, 'commit-msg hook installed');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/missing/);
  });

  it('commit-msg check keeps resolving .git/hooks in a vanilla repo (no hooksPath)', async () => {
    const dir = await initRepo();
    await fs.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(dir, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });

    const checks = collectChecks(dir);
    const check = findCheck(checks, 'commit-msg hook installed');
    expect(check?.status).toBe('pass');
  });

  // Git silently SKIPS a hook without an exec bit, so a 0644 commit-msg
  // means block_ai_attribution is disabled — doctor must fail, not pass
  // (codex P2 on the second iteration of this fix).
  it('commit-msg check fails when the active hook is not executable', async () => {
    const dir = await initRepo();
    const husky = path.join(dir, '.husky');
    await fs.mkdir(husky, { recursive: true });
    await fs.writeFile(path.join(husky, 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky']);

    const checks = collectChecks(dir);
    const check = findCheck(checks, 'commit-msg hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/not executable/);
  });

  // Husky 9 layout: core.hooksPath=.husky/_ holds an auto-generated
  // `. "${0%/*}/h"` stub that dispatches to the canonical `.husky/commit-msg`.
  // The check must classify the CANONICAL body, not the stub — a non-empty
  // stub with no canonical body is not an installed gate (codex P2 on the
  // initial fix).
  it('commit-msg check follows a husky 9 stub to the canonical body (pass)', async () => {
    const dir = await initRepo();
    const stubDir = path.join(dir, '.husky', '_');
    await fs.mkdir(stubDir, { recursive: true });
    await fs.writeFile(path.join(stubDir, 'commit-msg'), '#!/usr/bin/env sh\n. "${0%/*}/h"\n', {
      mode: 0o755,
    });
    await fs.writeFile(path.join(stubDir, 'h'), '#!/usr/bin/env sh\n# husky runner\n');
    await fs.writeFile(path.join(dir, '.husky', 'commit-msg'), '#!/bin/sh\nexit 0\n');
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky/_']);

    const checks = collectChecks(dir);
    const check = findCheck(checks, 'commit-msg hook installed');
    expect(check?.status).toBe('pass');
  });

  it('commit-msg check warns when the husky 9 runner (h) is missing', async () => {
    const dir = await initRepo();
    const stubDir = path.join(dir, '.husky', '_');
    await fs.mkdir(stubDir, { recursive: true });
    await fs.writeFile(path.join(stubDir, 'commit-msg'), '#!/usr/bin/env sh\n. "${0%/*}/h"\n', {
      mode: 0o755,
    });
    // Canonical body present, but NO `.husky/_/h` runner — the stub
    // sources it first, so `git commit` fails before the body runs.
    await fs.writeFile(path.join(dir, '.husky', 'commit-msg'), '#!/bin/sh\nexit 0\n');
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky/_']);

    const checks = collectChecks(dir);
    const check = findCheck(checks, 'commit-msg hook installed');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/missing or unreadable/);
  });

  it('commit-msg check warns when a husky 9 stub has no canonical body', async () => {
    const dir = await initRepo();
    const stubDir = path.join(dir, '.husky', '_');
    await fs.mkdir(stubDir, { recursive: true });
    await fs.writeFile(path.join(stubDir, 'commit-msg'), '#!/usr/bin/env sh\n. "${0%/*}/h"\n', {
      mode: 0o755,
    });
    await fs.writeFile(path.join(stubDir, 'h'), '#!/usr/bin/env sh\n# husky runner\n');
    // NO .husky/commit-msg canonical body.
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky/_']);

    const checks = collectChecks(dir);
    const check = findCheck(checks, 'commit-msg hook installed');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/no canonical body/);
  });

  it('commit-msg check fails when the husky 9 canonical body is a directory', async () => {
    const dir = await initRepo();
    const stubDir = path.join(dir, '.husky', '_');
    await fs.mkdir(stubDir, { recursive: true });
    await fs.writeFile(path.join(stubDir, 'commit-msg'), '#!/usr/bin/env sh\n. "${0%/*}/h"\n', {
      mode: 0o755,
    });
    await fs.writeFile(path.join(stubDir, 'h'), '#!/usr/bin/env sh\n# husky runner\n');
    // Bad-migration shape: a DIRECTORY where the canonical body should be.
    await fs.mkdir(path.join(dir, '.husky', 'commit-msg'), { recursive: true });
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky/_']);

    const checks = collectChecks(dir);
    const check = findCheck(checks, 'commit-msg hook installed');
    expect(check?.status).toBe('fail');
  });

  it('commit-msg check fails when the husky 9 canonical body is empty', async () => {
    const dir = await initRepo();
    const stubDir = path.join(dir, '.husky', '_');
    await fs.mkdir(stubDir, { recursive: true });
    await fs.writeFile(path.join(stubDir, 'commit-msg'), '#!/usr/bin/env sh\n. "${0%/*}/h"\n', {
      mode: 0o755,
    });
    await fs.writeFile(path.join(stubDir, 'h'), '#!/usr/bin/env sh\n# husky runner\n');
    await fs.writeFile(path.join(dir, '.husky', 'commit-msg'), '');
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky/_']);

    const checks = collectChecks(dir);
    const check = findCheck(checks, 'commit-msg hook installed');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/empty/);
  });
});

/**
 * 0.31.0 — `checkDelegationRoundTrip` now drives the REAL
 * `.claude/hooks/delegation-capture.sh` shell hook end-to-end (it used
 * to spawn `rea hook delegation-signal` directly). These tests pin:
 *   - graceful `warn` degradation when a prerequisite is missing
 *     (no shell hook installed; no sandboxed CLI in scope)
 *   - a `pass` when the full chain is wired: the shim resolves +
 *     sandbox-checks the CLI, the CLI writes the probe record, and
 *     chain integrity holds
 */
describe('rea doctor — checkDelegationRoundTrip drives the shell hook (0.31.0)', () => {
  const cleanup: string[] = [];
  const REPO_ROOT = path.resolve(__dirname, '..', '..');

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function mkBase(): Promise<string> {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-deleg-roundtrip-')),
    );
    cleanup.push(dir);
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    return dir;
  }

  it('warns when the delegation-capture.sh shell hook is not installed', async () => {
    const dir = await mkBase();
    // No .claude/hooks/delegation-capture.sh.
    const result = await checkDelegationRoundTrip(dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/shell hook not installed|rea init|rea upgrade/);
  });

  it('warns when the shell hook is present but no sandboxed rea CLI is in scope', async () => {
    const dir = await mkBase();
    // Install the shell hook from the repo source, but DON'T stage a
    // CLI — neither node_modules/@bookedsolid/rea nor <dir>/dist.
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.copyFile(
      path.join(REPO_ROOT, 'hooks', 'delegation-capture.sh'),
      path.join(hooksDir, 'delegation-capture.sh'),
    );
    await fs.chmod(path.join(hooksDir, 'delegation-capture.sh'), 0o755);
    const result = await checkDelegationRoundTrip(dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/no sandboxed rea CLI|pnpm build|pnpm i/);
  });

  it('passes the full chain when the shell hook + a sandboxed CLI are staged', async () => {
    const distCli = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
    // Build not present — skip rather than fail (CI builds before test).
    try {
      await fs.access(distCli);
    } catch {
      return;
    }
    const dir = await mkBase();
    // 1. Install the shell hook (consumer install path).
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    // The shim sources _lib/halt-check.sh — copy the whole hooks tree.
    await fs.cp(path.join(REPO_ROOT, 'hooks'), hooksDir, { recursive: true });
    // 2. Stage a sandboxed dogfood CLI INSIDE the tempdir: copy dist/,
    //    symlink node_modules (so `require` resolves), write a
    //    package.json declaring @bookedsolid/rea. The shim's sandbox
    //    check then passes legitimately — realpath(cli) stays inside
    //    realpath(dir) AND an ancestor package.json declares the name.
    await fs.cp(path.join(REPO_ROOT, 'dist'), path.join(dir, 'dist'), { recursive: true });
    await fs.symlink(
      path.join(REPO_ROOT, 'node_modules'),
      path.join(dir, 'node_modules'),
      'dir',
    );
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }),
    );
    const result = await checkDelegationRoundTrip(dir);
    // The probe record landed via the real shell-hook → CLI chain and
    // chain integrity verified.
    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/delegation-capture\.sh shell hook/);
  });
});

/**
 * 0.39.0 — policy-reader tier visibility. Operators currently have no
 * way to see which tier of the 4-tier `hooks/_lib/policy-reader.sh`
 * ladder their shims will hit when the rea CLI is unreachable. These
 * tests exercise the new per-tier checks (and the summary roll-up)
 * across every combination of tier availability, using probe-function
 * injection so we don't have to manipulate PATH or stage real
 * binaries.
 */
describe('rea doctor — policy-reader tier checks (0.39.0)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  // Probe factories — each returns a `PolicyReaderProbes` shape that
  // simulates a specific environment. Keeps test bodies one-liners.
  // 0.39.0 codex round-1 P2: `cliInvokable` is the CLI-invocation
  // probe that mirrors `_pr_load_full_json` in policy-reader.sh —
  // dist-present + invokable BOTH need to be true for Tier 1 to count.
  const probes = {
    /** Every tier reachable (the happy path on a typical dev machine). */
    all: (): PolicyReaderProbes => ({
      cliDistExists: () => true,
      cliInvokable: () => true,
      python3OnPath: () => '/usr/bin/python3',
      python3PyYamlReachable: () => true,
      awkOnPath: () => '/usr/bin/awk',
      jqOnPath: () => '/usr/bin/jq',
    }),
    /** Tier 1 missing but Tier 2 + 3 + jq reachable. */
    noTier1: (): PolicyReaderProbes => ({
      cliDistExists: () => false,
      cliInvokable: () => false,
      python3OnPath: () => '/usr/bin/python3',
      python3PyYamlReachable: () => true,
      awkOnPath: () => '/usr/bin/awk',
      jqOnPath: () => '/usr/bin/jq',
    }),
    /** Tier 1 dist exists but CLI is broken (stale build) — codex round-1 P2 shape. */
    tier1Broken: (): PolicyReaderProbes => ({
      cliDistExists: () => true,
      cliInvokable: () => false,
      python3OnPath: () => '/usr/bin/python3',
      python3PyYamlReachable: () => true,
      awkOnPath: () => '/usr/bin/awk',
      jqOnPath: () => '/usr/bin/jq',
    }),
    /** Tier 1 + Tier 2 missing — only awk reachable (the silent-noop risk shape). */
    onlyTier3: (): PolicyReaderProbes => ({
      cliDistExists: () => false,
      cliInvokable: () => false,
      python3OnPath: () => null,
      python3PyYamlReachable: () => false,
      awkOnPath: () => '/usr/bin/awk',
      jqOnPath: () => null,
    }),
    /** python3 present but PyYAML missing — Tier 2 degraded to Tier 3 floor. */
    python3NoPyYaml: (): PolicyReaderProbes => ({
      cliDistExists: () => false,
      cliInvokable: () => false,
      python3OnPath: () => '/usr/bin/python3',
      python3PyYamlReachable: () => false,
      awkOnPath: () => '/usr/bin/awk',
      jqOnPath: () => '/usr/bin/jq',
    }),
    /** No tiers reachable (catastrophic — practically impossible without losing awk). */
    none: (): PolicyReaderProbes => ({
      cliDistExists: () => false,
      cliInvokable: () => false,
      python3OnPath: () => null,
      python3PyYamlReachable: () => false,
      awkOnPath: () => null,
      jqOnPath: () => null,
    }),
    /** jq absent but every tier reachable — exercises the jq-warn case. */
    noJq: (): PolicyReaderProbes => ({
      cliDistExists: () => true,
      cliInvokable: () => true,
      python3OnPath: () => '/usr/bin/python3',
      python3PyYamlReachable: () => true,
      awkOnPath: () => '/usr/bin/awk',
      jqOnPath: () => null,
    }),
    /**
     * Codex round-1 P2 shape: Tier 1 reachable but neither jq nor
     * python3 on PATH. flow-form SCALARS work via the CLI's JSON
     * output, but `policy_reader_get_list` cannot iterate the
     * resulting JSON arrays — flow-form `blocked_paths: [.env, ...]`
     * silently no-ops via Tier 3 awk fallthrough.
     */
    tier1NoListWalker: (): PolicyReaderProbes => ({
      cliDistExists: () => true,
      cliInvokable: () => true,
      python3OnPath: () => null,
      python3PyYamlReachable: () => false,
      awkOnPath: () => '/usr/bin/awk',
      jqOnPath: () => null,
    }),
  };

  describe('checkPolicyReaderTier1 — rea CLI dist reachable + invokable', () => {
    it('passes when the CLI dist exists AND responds to `hook policy-get version --json`', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-tier1-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTier1(dir, probes.all());
      expect(result.status).toBe('pass');
      expect(result.detail).toMatch(/responds to .hook policy-get/);
      expect(result.detail).toMatch(/canonical loader fully wired/);
    });

    it('warns when the CLI dist is absent (not installed) — Tier 2/3 still work', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-tier1-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTier1(dir, probes.noTier1());
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/rea CLI dist not found/);
      expect(result.detail).toMatch(/node_modules\/@bookedsolid\/rea\/dist\/cli\/index\.js/);
      expect(result.detail).toMatch(/<baseDir>\/dist\/cli\/index\.js/);
      expect(result.detail).toMatch(/pnpm i @bookedsolid\/rea/);
      expect(result.detail).toMatch(/pnpm build/);
    });

    it('codex round-1 P2: warns when dist is present but CLI invocation fails (stale build)', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-tier1-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTier1(dir, probes.tier1Broken());
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/dist exists but .* failed/);
      expect(result.detail).toMatch(/stale or broken/);
      expect(result.detail).toMatch(/skip Tier 1 and fall through/);
      expect(result.detail).toMatch(/pnpm build|rea upgrade/);
    });

    it('default probe: warns when neither layout is present', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-tier1-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTier1(dir);
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/rea CLI dist not found/);
    });

    it('default probe: warns when the dogfood dist/cli/index.js is present but unrunnable', async () => {
      // Codex round-1 P2 default-probe coverage. Stage a file at the
      // canonical dogfood path that throws on import (bash script
      // pretending to be node) — the default `cliInvokable` probe
      // should see exit non-zero and report `warn` (stale/broken),
      // NOT `pass` from the file-existence probe alone.
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-tier1-')));
      cleanup.push(dir);
      await fs.mkdir(path.join(dir, 'dist', 'cli'), { recursive: true });
      // A node script that throws immediately — `node <path> hook
      // policy-get version --json` will exit non-zero.
      await fs.writeFile(
        path.join(dir, 'dist', 'cli', 'index.js'),
        'throw new Error("simulated broken dist");\n',
      );
      const result = checkPolicyReaderTier1(dir);
      expect(result.status).toBe('warn');
      // We assert on the "stale or broken" branch specifically — the
      // file-existence probe found the dist but the invocation failed.
      expect(result.detail).toMatch(/stale or broken/);
    });

    it('codex round-2 P1: refuses a dist/cli/index.js that lacks a @bookedsolid/rea package.json ancestor', async () => {
      // Stage a CLI body at the canonical dogfood path BUT without
      // any ancestor package.json whose `name === "@bookedsolid/rea"`.
      // The shim ladder's sandbox check (hooks/_lib/shim-runtime.sh
      // ::shim_sandbox_check) refuses this layout — the doctor probe
      // MUST refuse identically so it cannot be tricked into
      // executing a forged dist by reporting `pass`.
      //
      // The forged dist below would print `{"version":"1"}` to stdout
      // if executed — that is the EXACT shape that satisfies the
      // invokable predicate (exit 0 + non-empty stdout). If the
      // sandbox check is missing or bypassed, this test will report
      // `pass` instead of `warn`, catching any regression that
      // removes the sandbox gate or weakens it to a no-op.
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sbox-')));
      cleanup.push(dir);
      await fs.mkdir(path.join(dir, 'dist', 'cli'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'dist', 'cli', 'index.js'),
        // A node script that PRETENDS to be a healthy rea CLI — exits
        // 0 with the JSON payload that defaultCliInvokable's content
        // probe would otherwise accept. Sandbox refusal MUST short-
        // circuit before this code runs.
        'process.stdout.write(\'{"version":"1"}\'); process.exit(0);\n',
      );
      // DELIBERATELY no package.json at any ancestor — this is the
      // "forged dist in a non-rea repo" attack shape.
      const result = checkPolicyReaderTier1(dir);
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/stale or broken/);
    });

    it('codex round-2 P1: refuses a dist/cli/index.js reached via a symlink that escapes the project realpath', async () => {
      // Plant a real CLI body in an out-of-tree directory and link
      // it into the in-tree `dist/cli/index.js` location. The
      // symlink resolves to a path OUTSIDE realpath(baseDir), so the
      // sandbox check's prefix-containment branch MUST reject it.
      //
      // Same defensive shape as the previous test: the out-of-tree
      // CLI prints the JSON payload that satisfies the content
      // probe, so a missing sandbox check would mis-report `pass`.
      const outside = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sbox-out-')),
      );
      cleanup.push(outside);
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sbox-in-')));
      cleanup.push(dir);

      // Stage the forged CLI OUTSIDE the project. Give the out-of-
      // tree directory its own @bookedsolid/rea package.json so the
      // ancestor walk would have succeeded if the prefix check were
      // missing — this test then isolates the symlink-out failure
      // path specifically.
      await fs.writeFile(
        path.join(outside, 'package.json'),
        JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-forged' }),
      );
      await fs.mkdir(path.join(outside, 'dist', 'cli'), { recursive: true });
      const forgedCli = path.join(outside, 'dist', 'cli', 'index.js');
      await fs.writeFile(
        forgedCli,
        'process.stdout.write(\'{"version":"1"}\'); process.exit(0);\n',
      );

      // Inside the project: create the dist/cli directory and
      // symlink index.js to the out-of-tree forged CLI. resolveCliDistPath
      // will find the symlink via existsSync; realpathSync will then
      // resolve it to the out-of-tree real path, which the sandbox
      // prefix check rejects.
      await fs.mkdir(path.join(dir, 'dist', 'cli'), { recursive: true });
      await fs.symlink(forgedCli, path.join(dir, 'dist', 'cli', 'index.js'));

      const result = checkPolicyReaderTier1(dir);
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/stale or broken/);
    });

    it('codex round-2 P1: accepts a dist/cli/index.js whose ancestor package.json names @bookedsolid/rea', async () => {
      // Positive control for the sandbox check: when the layout
      // mirrors a real install (CLI inside realpath(baseDir), an
      // ancestor package.json names @bookedsolid/rea), the probe
      // should run the CLI and — assuming it responds with non-
      // empty JSON — report `pass`. This protects against an
      // over-aggressive sandbox check that would refuse legitimate
      // layouts and break the happy-path Tier 1 check on every
      // consumer machine.
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sbox-ok-')));
      cleanup.push(dir);
      // Mirror a consumer install:
      //   <dir>/node_modules/@bookedsolid/rea/package.json (name=@bookedsolid/rea)
      //   <dir>/node_modules/@bookedsolid/rea/dist/cli/index.js (healthy CLI)
      const pkgRoot = path.join(dir, 'node_modules', '@bookedsolid', 'rea');
      await fs.mkdir(path.join(pkgRoot, 'dist', 'cli'), { recursive: true });
      await fs.writeFile(
        path.join(pkgRoot, 'package.json'),
        JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }),
      );
      await fs.writeFile(
        path.join(pkgRoot, 'dist', 'cli', 'index.js'),
        'process.stdout.write(\'{"version":"1"}\'); process.exit(0);\n',
      );
      const result = checkPolicyReaderTier1(dir);
      expect(result.status).toBe('pass');
    });
  });

  describe('checkPolicyReaderTier2 — python3 + PyYAML', () => {
    it('passes when python3 and PyYAML are both reachable', () => {
      const result = checkPolicyReaderTier2('/baseDir-irrelevant-for-stub', probes.all());
      expect(result.status).toBe('pass');
      expect(result.detail).toMatch(/flow-form policy parses correctly/);
    });

    it('warns when python3 is absent', () => {
      const result = checkPolicyReaderTier2('/baseDir-irrelevant-for-stub', {
        ...probes.all(),
        python3OnPath: () => null,
      });
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/python3 not on PATH/);
      expect(result.detail).toMatch(/silently no-op/);
    });

    it('warns when python3 is present but PyYAML import fails', () => {
      const result = checkPolicyReaderTier2(
        '/baseDir-irrelevant-for-stub',
        probes.python3NoPyYaml(),
      );
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/import yaml.*failed/);
      expect(result.detail).toMatch(/pip3 install pyyaml/);
    });

    // 0.40.0 charter item 3 — probes receive the consumer's baseDir
    // so they can thread it as cwd to the spawned python3.
    it('0.40.0: threads baseDir into the python3PyYamlReachable probe', () => {
      const observed: string[] = [];
      const result = checkPolicyReaderTier2('/explicit/consumer/dir', {
        ...probes.all(),
        python3PyYamlReachable: (baseDir) => {
          observed.push(baseDir);
          return true;
        },
      });
      expect(result.status).toBe('pass');
      expect(observed).toEqual(['/explicit/consumer/dir']);
    });
  });

  describe('checkPolicyReaderTier3 — awk', () => {
    it('passes when awk is on PATH', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', probes.all());
      expect(result.status).toBe('pass');
      expect(result.detail).toMatch(/awk at \/usr\/bin\/awk/);
    });

    it('fails (hard) when awk is absent AND no other tier reachable', () => {
      // 0.40.0 — verdict is `fail` ONLY in the catastrophic shape
      // where awk is gone AND neither Tier 1 nor Tier 2 covers.
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', probes.none());
      expect(result.status).toBe('fail');
      expect(result.detail).toMatch(/awk not on PATH/);
      expect(result.detail).toMatch(/no fallback tier/);
    });

    // 0.40.0 charter item 2 — conditional downgrade, refined by
    // codex round 1 P2. Tier 1 reachable + jq present (list walker
    // available even without python3) is the warn shape.
    it('0.40.0: warns (not fails) when awk absent but Tier 1 reachable AND jq present', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => null,
        python3PyYamlReachable: () => false,
        awkOnPath: () => null,
        jqOnPath: () => '/usr/bin/jq',
      });
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/Tier 3 \(block-form fallback\) unreachable/);
      expect(result.detail).toMatch(/Tier 1 \(rea CLI\)/);
      expect(result.detail).toMatch(/still cover/);
      expect(result.detail).toMatch(/mawk.*gawk.*nawk/);
    });

    // 0.40.0 codex round 1 P2 (text-updated 0.42.0 round 2 correction):
    // Tier 1 reachable but NO list walker (no jq AND no python3) AND
    // awk absent is the concrete shape where list-valued policy reads
    // silently fail-closed even though scalar reads work. Doctor must
    // NOT exit 0 on this install — keep the `fail` verdict, with a
    // list-walker-specific remediation message. PyYAML reference
    // dropped per the corrected listWalker = jq || python3 semantic.
    it('codex round 1 P2: fails when Tier 1 reachable but no list walker AND awk absent', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => null,
        python3PyYamlReachable: () => false,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('fail');
      expect(result.detail).toMatch(/python3 is not on PATH/);
      expect(result.detail).toMatch(/policy_reader_get_list/);
      expect(result.detail).toMatch(/blocked_paths/);
      expect(result.detail).toMatch(/silently stop enforcing/);
      expect(result.detail).toMatch(/Install awk OR jq OR python3/);
    });

    // 0.42.0 codex round 2 P2 (CORRECTED 2026-05-16): the
    // pre-correction version of this test pinned the WRONG semantic.
    // `policy_reader_get_list` walks the already-parsed JSON array via
    // jq OR python3; the python3 branch imports `json` from STDLIB
    // ONLY — PyYAML is NOT required for list iteration (it's only
    // needed for Tier 2's YAML PARSING step). Gating the doctor on
    // PyYAML produces a false-fail regression for slim CI runners +
    // Windows machines where python3 is on PATH but pip extensions
    // aren't installed. Concrete shape: Tier 1 reachable + python3
    // present + PyYAML ABSENT + jq absent + awk absent → MUST be
    // `warn` (Tier 1 reachable + python3 walks the list correctly).
    it('codex round 2 P2 corrected: warns (not fails) when Tier 1 reachable + python3 present (no PyYAML, no jq, no awk)', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => '/usr/bin/python3',
        python3PyYamlReachable: () => false,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/Tier 3 \(block-form fallback\) unreachable/);
      expect(result.detail).toMatch(/Tier 1 \(rea CLI\)/);
      expect(result.detail).toMatch(/still cover/);
      expect(result.detail).toMatch(/mawk.*gawk.*nawk/);
    });

    // 0.42.0 codex round 2 P2 — positive control. Tier 1 reachable +
    // python3 present + PyYAML PRESENT + jq absent + awk absent must
    // remain `warn` (Tier 2 itself is reachable, which subsumes the
    // list-walker requirement).
    it('codex round 2 P2: warns (not fails) when Tier 2 reachable even if jq + awk are absent', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => '/usr/bin/python3',
        python3PyYamlReachable: () => true,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/Tier 1 \(rea CLI\) and Tier 2 \(python3\+PyYAML\)/);
    });

    // 0.42.0 codex round 2 P2 — positive control. jq remains a
    // sufficient list walker on its own; Tier 1 + jq (no python3) is
    // still `warn` because the JSON output from the CLI can be walked
    // by jq alone.
    it('codex round 2 P2: warns when Tier 1 reachable + jq present (no python3, no PyYAML, no awk)', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => null,
        python3PyYamlReachable: () => false,
        awkOnPath: () => null,
        jqOnPath: () => '/usr/bin/jq',
      });
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/Tier 1 \(rea CLI\)/);
      expect(result.detail).not.toMatch(/Tier 2 \(python3\+PyYAML\)/);
    });

    // 0.42.0 codex round 5 P2 (2026-05-16): the python3 leg of the
    // list-walker predicate uses an EXECUTION probe, not just
    // python3OnPath. When `python3OnPath` returns a path BUT
    // `python3ListWalkerReachable` returns false (broken pyenv/asdf
    // shim, dangling symlink, sandboxed interpreter that fails to
    // start), the doctor must NOT downgrade to `warn` — the shim's
    // list walker would actually fail and the operator needs to
    // know.
    it('codex round 5 P2: fails when python3 resolves on PATH but execution probe fails (broken shim) + no jq + no awk', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => '/usr/local/bin/python3-broken-shim',
        python3PyYamlReachable: () => false,
        // The new execution probe says "no" — interpreter cannot start.
        python3ListWalkerReachable: () => false,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('fail');
      expect(result.detail).toMatch(/policy_reader_get_list/);
      expect(result.detail).toMatch(/silently stop enforcing/);
      // Codex round 6 P3 (2026-05-16): the diagnostic message must
      // distinguish "python3 absent" from "python3 present but
      // broken" so the operator chases the right remediation. The
      // resolved path appears verbatim so the operator can grep for
      // it on the filesystem.
      expect(result.detail).toMatch(
        /python3 at \/usr\/local\/bin\/python3-broken-shim cannot execute/,
      );
      expect(result.detail).toMatch(/broken pyenv\/asdf shim/);
      expect(result.detail).toMatch(/repair the python3 interpreter/);
      // Must NOT report "python3 is not on PATH" — it is on PATH.
      expect(result.detail).not.toMatch(/python3 is not on PATH/);
    });

    // Positive control for round 5 P2: python3 resolves AND the
    // execution probe succeeds — still `warn` (list walker reachable).
    it('codex round 5 P2: warns when python3 resolves AND execution probe succeeds (no jq, no awk)', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => '/usr/bin/python3',
        python3PyYamlReachable: () => false,
        python3ListWalkerReachable: () => true,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/Tier 3 \(block-form fallback\) unreachable/);
    });

    // 0.42.0 codex round 2 P2 corrected — explicit fail case. With
    // listWalker = jq OR python3, the only "fail when Tier 1 reachable"
    // shape is: no jq AND no python3 AND no awk. The diagnostic
    // message should name all three (no PyYAML reference — PyYAML is
    // irrelevant to list iteration).
    it('codex round 2 P2 corrected: fails when Tier 1 reachable + NO jq + NO python3 + NO awk', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => null,
        python3PyYamlReachable: () => false,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('fail');
      expect(result.detail).toMatch(/awk not on PATH AND jq is not on PATH AND python3 is not on PATH/);
      expect(result.detail).toMatch(/policy_reader_get_list/);
      expect(result.detail).toMatch(/blocked_paths/);
      expect(result.detail).toMatch(/silently stop enforcing/);
      expect(result.detail).toMatch(/Install awk OR jq OR python3/);
      // Must NOT mention PyYAML — irrelevant to list iteration.
      expect(result.detail).not.toMatch(/PyYAML/);
    });

    it('0.40.0: warns (not fails) when awk absent but Tier 2 is reachable', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => false,
        cliInvokable: () => false,
        python3OnPath: () => '/usr/bin/python3',
        python3PyYamlReachable: () => true,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/Tier 2 \(python3\+PyYAML\)/);
      expect(result.detail).not.toMatch(/Tier 1/);
    });

    it('0.40.0: warns (not fails) when awk absent but BOTH Tier 1 and Tier 2 reachable', () => {
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => '/usr/bin/python3',
        python3PyYamlReachable: () => true,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/Tier 1 \(rea CLI\) and Tier 2 \(python3\+PyYAML\)/);
    });

    it('0.40.0: treats Tier 1 dist-present-but-broken as Tier 1 unreachable for the verdict', () => {
      // Mirror the summary check's posture: a stale dist that
      // fails the invokable probe is NOT a usable Tier 1, so if
      // Tier 2 is also unreachable the verdict must be `fail`
      // (not `warn`), even though `cliDistExists` returns true.
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => true,
        cliInvokable: () => false,
        python3OnPath: () => null,
        python3PyYamlReachable: () => false,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('fail');
      expect(result.detail).toMatch(/no fallback tier/);
    });

    it('0.40.0: passes pass-through when awk reachable regardless of other tiers', () => {
      // Sanity: even with every other tier missing, awk-present
      // is still `pass` — the conditional downgrade only matters
      // when awk is absent.
      const result = checkPolicyReaderTier3('/baseDir-irrelevant-for-stub', {
        cliDistExists: () => false,
        cliInvokable: () => false,
        python3OnPath: () => null,
        python3PyYamlReachable: () => false,
        awkOnPath: () => '/usr/bin/awk',
        jqOnPath: () => null,
      });
      expect(result.status).toBe('pass');
    });
  });

  describe('checkPolicyReaderJq — JSON accelerator', () => {
    it('passes when jq is on PATH', () => {
      const result = checkPolicyReaderJq(probes.all());
      expect(result.status).toBe('pass');
      expect(result.detail).toMatch(/jq at \/usr\/bin\/jq/);
    });

    it('warns when jq is absent — python3 fallback still works', () => {
      const result = checkPolicyReaderJq(probes.noJq());
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/jq not on PATH/);
      expect(result.detail).toMatch(/python3 JSON walker/);
    });
  });

  describe('checkPolicyReaderTierSummary — effective floor', () => {
    it('passes when Tier 1 is reachable (Tier 1 + 2 + 3)', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sum-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTierSummary(dir, probes.all());
      expect(result.status).toBe('pass');
      expect(result.detail).toMatch(/Tier 1 \(CLI\)/);
      expect(result.detail).toMatch(/Tier 2 \(python3\+PyYAML\)/);
      expect(result.detail).toMatch(/Tier 3 \(awk\)/);
      expect(result.detail).toMatch(/flow-form policy parses correctly/);
    });

    it('passes when Tier 1 is absent but Tier 2 is reachable', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sum-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTierSummary(dir, probes.noTier1());
      expect(result.status).toBe('pass');
      expect(result.detail).not.toMatch(/Tier 1 \(CLI\)/);
      expect(result.detail).toMatch(/Tier 2 \(python3\+PyYAML\)/);
      expect(result.detail).toMatch(/Tier 3 \(awk\)/);
    });

    it('warns when only Tier 3 (awk) is reachable — flow-form silent no-op', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sum-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTierSummary(dir, probes.onlyTier3());
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/only Tier 3/);
      expect(result.detail).toMatch(/silently\s+no-ops/);
      expect(result.detail).toMatch(/Restore Tier 1.*or Tier 2/);
    });

    it('warns when python3 is present but PyYAML is missing — still only Tier 3 effective', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sum-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTierSummary(dir, probes.python3NoPyYaml());
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/only Tier 3/);
    });

    it('fails when no tiers are reachable — every shim policy lookup fails closed', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sum-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTierSummary(dir, probes.none());
      expect(result.status).toBe('fail');
      expect(result.detail).toMatch(/no policy-reader tier reachable/);
      expect(result.detail).toMatch(/fails closed/);
    });

    it('codex round-1 P2: warns when Tier 1 reachable but no list walker (no jq, no python3)', async () => {
      // Tier 1 is reachable so flow-form SCALARS work. But
      // `policy_reader_get_list` needs jq OR python3 to iterate JSON
      // arrays — without either, flow-form `blocked_paths: [.env, ...]`
      // silently falls through to Tier 3 awk which only handles block
      // form. Pre-fix the summary returned `pass`; now it returns
      // `warn` with a precise remediation.
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sum-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTierSummary(dir, probes.tier1NoListWalker());
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/Tier 1 \(CLI\)/);
      expect(result.detail).toMatch(/flow-form scalars parse via Tier 1/);
      expect(result.detail).toMatch(/neither jq nor python3 is on PATH/);
      expect(result.detail).toMatch(/policy_reader_get_list/);
      expect(result.detail).toMatch(/blocked_paths: \[\.env, \.\.\.\]/);
      expect(result.detail).toMatch(/brew install jq|apt-get install jq/);
    });

    it('codex round-1 P2: treats Tier 1 dist-present-but-broken as Tier 1 unreachable', async () => {
      // Mirror Tier 1's own probe: a dist that fails the CLI
      // invocation probe is "Tier 1 unreachable" for the summary, even
      // though `cliDistExists` returns true. With Tier 2 + Tier 3
      // reachable in this stub, the verdict should still pass because
      // Tier 2 is the effective floor — but the reachable list must
      // NOT claim Tier 1.
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sum-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTierSummary(dir, probes.tier1Broken());
      expect(result.status).toBe('pass');
      expect(result.detail).not.toMatch(/Tier 1 \(CLI\)/);
      expect(result.detail).toMatch(/Tier 2 \(python3\+PyYAML\)/);
    });

    // 0.43.0 codex round-7 P3 (2026-05-17): mirror the round-6 P3 fix
    // from `checkPolicyReaderTier3` into the summary check's
    // `flow-form-lists-degraded` branch. Pre-fix the summary always
    // said "neither jq nor python3 is on PATH" even when python3
    // WAS on PATH but the execution probe failed (broken pyenv/asdf
    // shim, sandboxed interpreter). The diagnostic now distinguishes
    // "python3 absent" from "python3 present but broken", surfaces
    // the resolved path so the operator can grep for it, and
    // suggests the right remediation (repair vs install).
    it('codex round-7 P3: distinguishes broken-shim from python3-absent in summary diagnostic', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sum-')));
      cleanup.push(dir);
      // Tier 1 reachable; python3 IS on PATH but the execution probe
      // fails (broken shim shape). No jq, no awk.
      const result = checkPolicyReaderTierSummary(dir, {
        cliDistExists: () => true,
        cliInvokable: () => true,
        python3OnPath: () => '/usr/local/bin/python3-broken-shim',
        python3PyYamlReachable: () => false,
        python3ListWalkerReachable: () => false,
        awkOnPath: () => null,
        jqOnPath: () => null,
      });
      expect(result.status).toBe('warn');
      // The resolved python3 path must appear verbatim so the
      // operator can locate and repair (or remove) the broken shim.
      expect(result.detail).toMatch(
        /python3 at \/usr\/local\/bin\/python3-broken-shim cannot execute/,
      );
      expect(result.detail).toMatch(/broken pyenv\/asdf shim/);
      expect(result.detail).toMatch(/repair the python3 interpreter/);
      // Must NOT report "neither jq nor python3 is on PATH" — python3
      // IS on PATH; the round-6 → round-7 P3 fix is specifically
      // about not steering the operator toward `apt-get install
      // python3` when the binary is already there.
      expect(result.detail).not.toMatch(/neither jq nor python3 is on PATH/);
    });

    // Round-7 P3 positive control: when python3 is genuinely absent
    // (path probe returns null), the legacy "neither jq nor python3"
    // wording is correct and must stay.
    it('codex round-7 P3: keeps the "absent" diagnostic when python3 is genuinely off PATH', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pr-sum-')));
      cleanup.push(dir);
      const result = checkPolicyReaderTierSummary(dir, probes.tier1NoListWalker());
      expect(result.status).toBe('warn');
      expect(result.detail).toMatch(/neither jq nor python3 is on PATH/);
      // Must NOT mention the broken-shim remediation in this shape —
      // the operator's problem is genuinely "install python3 or jq".
      expect(result.detail).not.toMatch(/broken pyenv\/asdf shim/);
      expect(result.detail).not.toMatch(/repair the python3 interpreter/);
    });
  });

  describe('collectChecks wiring — tier checks appear when policy.yaml exists', () => {
    it('includes all five tier checks in the standard collectChecks output', async () => {
      const repo = await makeScratchRepo({ codexRequired: false });
      cleanup.push(repo.dir);
      const checks = collectChecks(repo.dir);
      expect(findCheck(checks, 'policy-reader Tier 1 (rea CLI)')).toBeDefined();
      expect(findCheck(checks, 'policy-reader Tier 2 (python3 + PyYAML)')).toBeDefined();
      expect(findCheck(checks, 'policy-reader Tier 3 (awk)')).toBeDefined();
      expect(findCheck(checks, 'policy-reader jq (JSON accelerator)')).toBeDefined();
      expect(findCheck(checks, 'policy-reader effective floor')).toBeDefined();
    });

    it('omits tier checks when policy.yaml is absent (policy-parse fail dominates)', async () => {
      // Bare scratch directory — no .rea/policy.yaml. checkPolicyParses
      // already reports a fail; tier checks add no value in that state
      // (and would render confusing pass-rows next to the missing policy).
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-no-policy-')));
      cleanup.push(dir);
      await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
      // No policy.yaml written.
      const checks = collectChecks(dir);
      expect(findCheck(checks, 'policy-reader Tier 1 (rea CLI)')).toBeUndefined();
      expect(findCheck(checks, 'policy-reader effective floor')).toBeUndefined();
    });

    it('codex round-3 P2: omits tier checks when policy.yaml is present but malformed', async () => {
      // Stage a policy.yaml that exists but does NOT parse (invalid
      // YAML / zod-rejected shape). Pre-fix `collectChecks` ran the
      // tier probes anyway because the gate only tested file
      // existence — operators saw a policy-parse FAIL row PLUS
      // unrelated tier WARN rows about the CLI being "stale or
      // broken" / the ladder being "degraded", which misattributed a
      // config bug to a runtime/install problem.
      //
      // Post-fix the gate checks `checkPolicyParses(...).status ===
      // "pass"`, so a malformed policy emits exactly ONE failure
      // (the parse error) and skips every tier probe. This test
      // pins that behavior so any future regression that loosens
      // the gate back to `existsSync` will fail loudly.
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-bad-policy-')));
      cleanup.push(dir);
      await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
      // Intentionally invalid YAML — unterminated string in a way
      // that even the most permissive parser will reject. This must
      // fail `loadPolicy` regardless of any schema-shape leniency.
      await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), 'version: "1\nthis-is-not: valid\n');
      const checks = collectChecks(dir);

      // Sanity: the parse failure IS surfaced.
      const parsesRow = findCheck(checks, 'policy.yaml parses');
      expect(parsesRow).toBeDefined();
      expect(parsesRow?.status).toBe('fail');

      // The five tier rows MUST be absent — they would misattribute
      // a config-file bug to a runtime/install problem and crowd
      // out the parse-failure row that the operator actually needs
      // to fix.
      expect(findCheck(checks, 'policy-reader Tier 1 (rea CLI)')).toBeUndefined();
      expect(findCheck(checks, 'policy-reader Tier 2 (python3 + PyYAML)')).toBeUndefined();
      expect(findCheck(checks, 'policy-reader Tier 3 (awk)')).toBeUndefined();
      expect(findCheck(checks, 'policy-reader jq (JSON accelerator)')).toBeUndefined();
      expect(findCheck(checks, 'policy-reader effective floor')).toBeUndefined();
    });
  });
});

// ── Spine distribution (spec §4): checkSpineInstalled ───────────────────────
//
// The process-spine skills payload (`spine/*.md` → `.claude/skills/`) is
// version-pinned to the rea release. checkSpineInstalled mirrors
// checkAgentsPresent/checkHooksInstalled and adds the drift dimension the
// spec requires — the refuse-and-report surface for locally-modified spine
// files. Advisory: warn on absence/drift, never a hard fail.
import { PKG_ROOT } from './utils.js';

const SPINE_DIR = path.join(PKG_ROOT, 'spine');

async function spinePayloadNames(): Promise<string[]> {
  const names = (await fs.readdir(SPINE_DIR)).filter((n) => n.endsWith('.md'));
  names.sort();
  return names;
}

async function layDownSpine(baseDir: string): Promise<void> {
  const dst = path.join(baseDir, '.claude', 'skills');
  await fs.mkdir(dst, { recursive: true });
  for (const name of await spinePayloadNames()) {
    await fs.copyFile(path.join(SPINE_DIR, name), path.join(dst, name));
  }
}

describe('rea doctor — checkSpineInstalled (spec §4 spine distribution)', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('warns (not fails) when .claude/skills/ is absent — upgrade-lag signal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-spine-'));
    cleanup.push(dir);
    const r = checkSpineInstalled(dir);
    expect(r.status).toBe('warn');
    // Names the inspected path AND the next step.
    expect(r.detail).toContain(path.join(dir, '.claude', 'skills'));
    expect(r.detail).toMatch(/rea upgrade/);
  });

  it('passes when every payload file is present and byte-identical', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-spine-'));
    cleanup.push(dir);
    await layDownSpine(dir);
    const r = checkSpineInstalled(dir);
    expect(r.status).toBe('pass');
    const count = (await spinePayloadNames()).length;
    expect(r.detail).toContain(`${count} spine skills present`);
  });

  it('warns and names the drifted file when an installed spine file is locally modified', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-spine-'));
    cleanup.push(dir);
    await layDownSpine(dir);
    const names = await spinePayloadNames();
    const victim = names.find((n) => n === 'grill.md') ?? names[0]!;
    await fs.writeFile(path.join(dir, '.claude', 'skills', victim), '# local edit\n', 'utf8');
    const r = checkSpineInstalled(dir);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain(victim);
    expect(r.detail).toMatch(/locally modified/);
    expect(r.detail).toMatch(/rea upgrade/);
  });

  it('warns and names the missing file when a payload file is absent on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-spine-'));
    cleanup.push(dir);
    await layDownSpine(dir);
    const names = await spinePayloadNames();
    const victim = names[0]!;
    await fs.rm(path.join(dir, '.claude', 'skills', victim));
    const r = checkSpineInstalled(dir);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain(victim);
    expect(r.detail).toMatch(/missing/);
  });

  it('never returns fail (advisory only — must not block install/CI)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-spine-'));
    cleanup.push(dir);
    // absent case
    expect(checkSpineInstalled(dir).status).not.toBe('fail');
    await layDownSpine(dir);
    expect(checkSpineInstalled(dir).status).not.toBe('fail');
  });
});

// ── D5 token-economy lint: checkTokenEconomy (advisory-only) ────────────────
describe('rea doctor — checkTokenEconomy (D5 advisory budget)', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function writeSkill(dir: string, name: string, description: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const body = `---\nname: ${name}\ndescription: "${description}"\n---\n\nbody\n`;
    await fs.writeFile(path.join(dir, `${name}.md`), body, 'utf8');
  }

  it('info + counts skills across BOTH .claude/skills and .claude/commands', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tok-'));
    cleanup.push(dir);
    await writeSkill(path.join(dir, '.claude', 'skills'), 'a', 'x');
    await writeSkill(path.join(dir, '.claude', 'skills'), 'b', 'x');
    await writeSkill(path.join(dir, '.claude', 'commands'), 'c', 'x');
    const r = checkTokenEconomy(dir);
    expect(r.status).toBe('info');
    expect(r.detail).toContain('3/15 user-invoked skills');
  });

  it('does NOT count files without a description front-matter (e.g. README)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tok-'));
    cleanup.push(dir);
    const skillsDir = path.join(dir, '.claude', 'skills');
    await writeSkill(skillsDir, 'real', 'x');
    await fs.writeFile(path.join(skillsDir, 'README.md'), '# index\n\nno front-matter\n', 'utf8');
    const r = checkTokenEconomy(dir);
    expect(r.detail).toContain('1/15 user-invoked skills');
  });

  it('warns and flags the prune ritual when the skill count exceeds 15', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tok-'));
    cleanup.push(dir);
    const skillsDir = path.join(dir, '.claude', 'skills');
    for (let i = 0; i < 16; i++) await writeSkill(skillsDir, `s${i}`, 'x');
    const r = checkTokenEconomy(dir);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/16 skills \(cap 15\)/);
    expect(r.detail).toMatch(/quarterly prune ritual/);
  });

  it('warns when description tokens exceed 1000 (estimate = chars ÷ 4)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tok-'));
    cleanup.push(dir);
    const skillsDir = path.join(dir, '.claude', 'skills');
    // 5 skills × 900 chars = 4500 chars → ~1125 tokens > 1000, but only 5 skills.
    const longDesc = 'z'.repeat(900);
    for (let i = 0; i < 5; i++) await writeSkill(skillsDir, `s${i}`, longDesc);
    const r = checkTokenEconomy(dir);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/description tokens \(cap 1000\)/);
  });

  it('never returns fail (advisory only — must not affect exit code)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tok-'));
    cleanup.push(dir);
    const skillsDir = path.join(dir, '.claude', 'skills');
    for (let i = 0; i < 20; i++) await writeSkill(skillsDir, `s${i}`, 'z'.repeat(500));
    expect(checkTokenEconomy(dir).status).not.toBe('fail');
  });
});

// ── Round-23 F1 — G1 spec-gate CLI advisory ──────────────────────────────
// The hot commit path FAILS OPEN (round-15); doctor surfaces enforce-without-
// CLI as an advisory WARN (never a hard fail).
describe('rea doctor — checkG1SpecGateCli (round-23 F1)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  });

  async function repoWithG1(mode: 'off' | 'shadow' | 'enforce' | 'absent'): Promise<string> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-g1cli-')));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    const gates =
      mode === 'absent' ? '' : `artifact_gates:\n  g1_spec:\n    mode: ${mode}\n`;
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      [
        'version: "0.54.0"',
        'profile: bst-internal',
        'installed_by: test',
        'installed_at: "2026-01-01T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'blocked_paths: []',
        gates,
      ].join('\n'),
    );
    return dir;
  }

  // An env whose PATH contains no `rea` binary (deterministic no-global-CLI).
  const noReaEnv: NodeJS.ProcessEnv = { PATH: path.join(os.tmpdir(), 'rea-empty-nonexistent-bin') };

  it('mode off → no row emitted (null; zero noise for the default)', async () => {
    const dir = await repoWithG1('off');
    expect(checkG1SpecGateCli(dir, noReaEnv)).toBeNull();
  });

  it('absent artifact_gates → null', async () => {
    const dir = await repoWithG1('absent');
    expect(checkG1SpecGateCli(dir, noReaEnv)).toBeNull();
  });

  it('mode enforce + NO CLI anywhere → WARN (never fail)', async () => {
    const dir = await repoWithG1('enforce');
    const r = checkG1SpecGateCli(dir, noReaEnv);
    expect(r?.status).toBe('warn');
    expect(r?.detail).toMatch(/FAILS OPEN/);
    expect(r?.detail).toMatch(/g1_spec\.mode: enforce/);
  });

  it('mode shadow + NO CLI → WARN', async () => {
    const dir = await repoWithG1('shadow');
    expect(checkG1SpecGateCli(dir, noReaEnv)?.status).toBe('warn');
  });

  it('mode enforce + in-project node_modules/.bin/rea → PASS (gate is live)', async () => {
    const dir = await repoWithG1('enforce');
    const bin = path.join(dir, 'node_modules', '.bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'rea'), '#!/bin/sh\n', { mode: 0o755 });
    const r = checkG1SpecGateCli(dir, noReaEnv);
    expect(r?.status).toBe('pass');
  });

  it('mode enforce + global rea on PATH → PASS', async () => {
    const dir = await repoWithG1('enforce');
    const bin = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-gbin-')));
    dirs.push(bin);
    await fs.writeFile(path.join(bin, 'rea'), '#!/bin/sh\n', { mode: 0o755 });
    const r = checkG1SpecGateCli(dir, { PATH: bin });
    expect(r?.status).toBe('pass');
  });

  it('never emits a `fail` (advisory only)', async () => {
    const dir = await repoWithG1('enforce');
    expect(checkG1SpecGateCli(dir, noReaEnv)?.status).not.toBe('fail');
  });
});
