/**
 * Unit tests for `rea doctor`'s conditional Codex-check behavior (G11.4).
 *
 * `collectChecks(baseDir)` is the testable seam — it returns the same
 * sequence of CheckResults that `runDoctor` prints. We drive it against
 * scratch repos with different `review.codex_required` settings and assert
 * on which checks are present and their status.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkCodexBinaryOnPath,
  checkFingerprintStore,
  checksFromProbeState,
  collectChecks,
  type CheckResult,
} from './doctor.js';
import {
  FINGERPRINT_STORE_VERSION,
  saveFingerprintStore,
} from '../registry/fingerprints-store.js';
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
async function makeScratchRepo(opts: {
  codexRequired: boolean | undefined;
}): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-test-')),
  );

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
  await fs.writeFile(
    path.join(dir, '.rea', 'policy.yaml'),
    policyLines.join('\n'),
  );
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

function findCheck(
  checks: CheckResult[],
  labelFragment: string,
): CheckResult | undefined {
  return checks.find((c) => c.label.includes(labelFragment));
}

describe('rea doctor — collectChecks (G11.4 codex_required)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('codex_required=false: Codex-specific checks are replaced by a single info line', async () => {
    const repo = await makeScratchRepo({ codexRequired: false });
    cleanup.push(repo.dir);

    const checks = collectChecks(repo.dir);

    // No Codex-specific checks.
    expect(findCheck(checks, 'codex-adversarial agent installed')).toBeUndefined();
    expect(findCheck(checks, '/codex-review command installed')).toBeUndefined();

    // Exactly one info line with the expected body.
    const infoLines = checks.filter((c) => c.status === 'info');
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]?.label).toBe('codex');
    expect(infoLines[0]?.detail).toMatch(/codex_required/);
    expect(infoLines[0]?.detail).toMatch(/disabled via policy/);
  });

  it('codex_required=true: Codex-specific checks are present (regression)', async () => {
    const repo = await makeScratchRepo({ codexRequired: true });
    cleanup.push(repo.dir);

    const checks = collectChecks(repo.dir);

    // Both Codex-specific checks appear.
    expect(findCheck(checks, 'codex-adversarial agent installed')).toBeDefined();
    expect(findCheck(checks, '/codex-review command installed')).toBeDefined();

    // No info line.
    expect(checks.some((c) => c.status === 'info')).toBe(false);
  });

  it('review field absent: defaults to codex_required=true (regression)', async () => {
    const repo = await makeScratchRepo({ codexRequired: undefined });
    cleanup.push(repo.dir);

    const checks = collectChecks(repo.dir);

    expect(findCheck(checks, 'codex-adversarial agent installed')).toBeDefined();
    expect(findCheck(checks, '/codex-review command installed')).toBeDefined();
    expect(checks.some((c) => c.status === 'info')).toBe(false);
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
    await Promise.all(
      cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  async function makeNonGitScratch(): Promise<ScratchRepo> {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-nongit-')),
    );
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
    await fs.writeFile(
      path.join(repo.dir, '.git'),
      'gitdir: ./pruned-does-not-exist\n',
      'utf8',
    );

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

describe('rea doctor — checkFingerprintStore (G7)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  async function scratchWithRegistry(
    servers: RegistryServer[],
  ): Promise<ScratchRepo> {
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
    await fs.writeFile(
      path.join(repo.dir, '.rea', 'fingerprints.json'),
      'not { valid json',
    );
    const r = await checkFingerprintStore(repo.dir);
    expect(r.status).toBe('fail');
  });
});

describe('rea doctor — checkCodexBinaryOnPath (Fix C / 0.12.0)', () => {
  const cleanup: string[] = [];
  const originalPath = process.env.PATH;

  afterEach(async () => {
    process.env.PATH = originalPath;
    await Promise.all(
      cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
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
