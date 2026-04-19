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
  checksFromProbeState,
  collectChecks,
  type CheckResult,
} from './doctor.js';
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

  it('G6: executable-but-foreign active hook → warn, not pass', async () => {
    // Finding 1 from the Codex post-merge review: an executable pre-push
    // that does NOT reference the review gate used to pass doctor because
    // the check only looked at `exists + executable`. With the governance
    // requirement threaded through, this is now a warn with guidance.
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
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/silently bypassed/);
    expect(check?.detail).toMatch(/push-review-gate\.sh/);
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
    expect(check?.detail).toMatch(/delegates to push-review-gate/);
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
});
