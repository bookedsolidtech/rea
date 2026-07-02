/**
 * 0.50.0 Phase 3b — F1 doctor↔shim PARITY test for the global rea CLI tier.
 *
 * Two layers:
 *
 *   1. HERMETIC TS matrix (always runs). Drives `resolveGlobalCliTier` +
 *      `checkGlobalCli` against injected temp-home fixtures across the full
 *      scenario matrix. `home` is a parameter (the passwd home is env-immune),
 *      so this layer never reads or writes the real `~/.rea`.
 *
 *   2. doctor↔shim PARITY (guarded-skip). Sources the REAL production
 *      `hooks/_lib/shim-runtime.sh` in a bash subprocess and runs the SAME
 *      resolver sequence as `shim_run()` steps 4 / 4-global / 4-global-veto,
 *      then asserts the bash shim's resolved tier + CLI realpath EQUALS what
 *      the TS predicate `resolveGlobalCliTier` returns for the SAME fixture —
 *      so `rea doctor` can never claim a tier the shim wouldn't.
 *
 *      The bash global resolver derives its trust root from
 *      `os.userInfo().homedir` (passwd-derived, env-IMMUNE by design). There
 *      is no seam to point it at a temp home, so the global scenarios are
 *      driven against the REAL passwd-home `~/.rea` — and the whole layer is
 *      GUARDED-SKIPPED when `~/.rea` already exists (never clobber a real
 *      global install), on Windows, or when bash is unavailable. Every
 *      scenario cleans up in a `finally`. This mirrors the Phase-1b/2b
 *      "guarded-skip where a real passwd-home write is unavoidable" pattern.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGlobalCli, resolveGlobalCliTier } from './doctor.js';
import { globalRoot, passwdHome, reaDir, registryPath } from './global-cli.js';

const SHIM_LIB = fileURLToPath(new URL('../../hooks/_lib/shim-runtime.sh', import.meta.url));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkTemp(prefix: string): string {
  // realpath so the path is canonical (/private/var on macOS): the shim
  // resolves realpaths internally, and the trust registry is keyed on
  // realpath(proj), so a canonical fixture keeps both sides byte-aligned.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

/** Drop an in-project CLI (bare-drop shape) so `shim_resolve_cli` resolves it. */
function installInProjectCli(proj: string): string {
  const cli = path.join(proj, 'dist', 'cli', 'index.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'process.exit(0)\n');
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"@bookedsolid/rea"}\n');
  return cli;
}

const BASE_POLICY = [
  'version: "1"',
  'profile: "test"',
  'installed_by: "test"',
  'installed_at: "2026-05-15T00:00:00Z"',
  'autonomy_level: L1',
  'max_autonomy_level: L2',
  'promotion_requires_human_approval: true',
  'block_ai_attribution: false',
  'blocked_paths: []',
  '',
].join('\n');

/** Write a valid policy.yaml at `proj`, optionally carrying the veto. */
function writePolicy(proj: string, opts: { veto?: boolean } = {}): void {
  fs.mkdirSync(path.join(proj, '.rea'), { recursive: true });
  const body = opts.veto === true ? `${BASE_POLICY}runtime:\n  allow_global_cli: false\n` : BASE_POLICY;
  fs.writeFileSync(path.join(proj, '.rea', 'policy.yaml'), body);
}

/**
 * Build a `<home>/.rea/cli` global fixture. The stub CLI answers exactly one
 * subcommand — `hook policy-get runtime.allow_global_cli` — echoing `false`
 * when `REA_TEST_VETO=1` so the bash shim's step-4-global-veto path can be
 * exercised without a full rea build. Everything else is a real
 * single-link file tree that satisfies the shim's A1–A5 sandbox.
 */
const CLI_STUB = [
  'const a = process.argv.slice(2);',
  "if (a[0] === 'hook' && a[1] === 'policy-get' && a[2] === 'runtime.allow_global_cli') {",
  "  process.stdout.write(process.env.REA_TEST_VETO === '1' ? 'false' : 'true');",
  '  process.exit(0);',
  '}',
  'process.exit(0);',
  '',
].join('\n');

// A CLI that predates `hook policy-get`: it exits NON-ZERO for any
// `hook policy-get …` invocation (both the shim's veto read and doctor's
// `--help` capability probe), so the real shim fail-closes to no-CLI at the
// veto step and doctor's probe reports the tier NOT active.
const CLI_STUB_INCAPABLE = [
  'const a = process.argv.slice(2);',
  "if (a[0] === 'hook' && a[1] === 'policy-get') { process.exit(1); }",
  'process.exit(0);',
  '',
].join('\n');

function buildGlobalFixture(
  home: string,
  opts: {
    installCli?: boolean;
    worldWritable?: boolean;
    trustProjReal?: string | null;
    /** index.js is a symlink to a sibling real file → A2 must refuse. */
    symlinkCli?: boolean;
    /** package.json name is NOT @bookedsolid/rea → A3 must refuse. */
    badPkgName?: boolean;
    /** trusted-projects registry mode (default 0o600). 0o644 → A5.3b refuses. */
    registryMode?: number;
    /** replace trusted-projects with a symlink → A5.3b must refuse. */
    symlinkRegistry?: boolean;
    /** install a CLI that predates `hook policy-get` (exits non-zero on it). */
    incapableCli?: boolean;
  } = {},
): { gRoot: string; cliRealpath: string | null } {
  const installCli = opts.installCli !== false;
  const dir = reaDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const gRoot = globalRoot(home);
  let cliRealpath: string | null = null;
  if (installCli) {
    const cliDir = path.join(gRoot, 'dist', 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    const cli = path.join(cliDir, 'index.js');
    const body = opts.incapableCli === true ? CLI_STUB_INCAPABLE : CLI_STUB;
    if (opts.symlinkCli === true) {
      // Real body at a sibling name; index.js symlinks to it (existsSync
      // follows the link so resolveGlobalCli still returns index.js).
      const target = path.join(cliDir, 'real-index.js');
      fs.writeFileSync(target, body);
      fs.symlinkSync('real-index.js', cli);
    } else {
      fs.writeFileSync(cli, body);
      cliRealpath = fs.realpathSync(cli);
    }
    const pkgName = opts.badPkgName === true ? 'not-rea' : '@bookedsolid/rea';
    fs.writeFileSync(path.join(gRoot, 'package.json'), `{"name":"${pkgName}"}\n`);
  } else {
    // Root dir exists but no resolvable CLI under it.
    fs.mkdirSync(gRoot, { recursive: true });
  }
  const reg = registryPath(home);
  const lines = ['# rea trusted-projects (v1) — managed by rea trust/untrust'];
  if (opts.trustProjReal) lines.push(opts.trustProjReal);
  if (opts.symlinkRegistry === true) {
    // Real body at a sibling name; the registry path is a symlink to it.
    const target = path.join(dir, 'trusted-projects.real');
    fs.writeFileSync(target, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    fs.symlinkSync('trusted-projects.real', reg);
  } else {
    fs.writeFileSync(reg, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(reg, opts.registryMode ?? 0o600);
  }
  // Apply the world-writable perms LAST so the CLI writes above succeed.
  if (opts.worldWritable === true) fs.chmodSync(dir, 0o777);
  return { gRoot, cliRealpath };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ===========================================================================
// Layer 1 — hermetic TS matrix (always runs; injected temp home)
// ===========================================================================

describe('resolveGlobalCliTier — hermetic TS matrix', () => {
  let home: string;
  beforeEach(() => {
    home = mkTemp('rea-parity-home-');
  });

  it('global root absent → in-project (feature unused)', () => {
    const proj = mkTemp('rea-parity-proj-');
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'in-project', reason: 'global-root-absent', cliRealpath: null });

    const rows = checkGlobalCli(proj, home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('info');
    expect(rows[0]?.label).toBe('global rea CLI');
    expect(rows[0]?.detail).toBe(
      'not installed — in-project resolution active; see `rea install --global`',
    );
  });

  it('in-project CLI present + global installed → in-project wins (single benign info row)', () => {
    const proj = mkTemp('rea-parity-proj-');
    const inProj = fs.realpathSync(installInProjectCli(proj));
    buildGlobalFixture(home, { trustProjReal: proj });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'in-project', reason: 'in-project-wins', cliRealpath: inProj });
    // The global tree is deliberately NOT consulted when in-project wins.
    expect(t.globalCliRealpath).toBeNull();

    const rows = checkGlobalCli(proj, home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('info');
    expect(rows[0]?.detail).toContain('unused');
    expect(rows[0]?.detail).toContain(inProj);
    expect(rows.some((r) => r.status === 'fail')).toBe(false);
  });

  // P2-a — in-project resolution MUST short-circuit BEFORE any global-root
  // safety/resolvability check. A broken/unsafe ~/.rea/cli must NOT produce a
  // [fail]/[warn] when the checkout runs the in-project CLI.
  it('in-project CLI present + BROKEN global root (world-writable) → in-project, no fail/warn', () => {
    const proj = mkTemp('rea-parity-proj-');
    const inProj = fs.realpathSync(installInProjectCli(proj));
    buildGlobalFixture(home, { trustProjReal: proj, worldWritable: true });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'in-project', reason: 'in-project-wins', cliRealpath: inProj });

    const rows = checkGlobalCli(proj, home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('info');
    expect(rows.some((r) => r.status === 'fail' || r.status === 'warn')).toBe(false);
  });

  it('in-project CLI present + UNSAFE global candidate (symlinked) → in-project, no fail', () => {
    const proj = mkTemp('rea-parity-proj-');
    const inProj = fs.realpathSync(installInProjectCli(proj));
    buildGlobalFixture(home, { trustProjReal: proj, symlinkCli: true });
    const t = resolveGlobalCliTier(proj, home);
    // Short-circuit means the candidate sandbox never runs → NOT candidate-unsafe.
    expect(t).toMatchObject({ tier: 'in-project', reason: 'in-project-wins', cliRealpath: inProj });
    expect(checkGlobalCli(proj, home).some((r) => r.status === 'fail')).toBe(false);
  });

  // P2-b — a MISSING policy file is veto-ABSENT (allow), not veto.
  it('global installed + trusted + NO policy.yaml → global (allowed, not policy-veto)', () => {
    const proj = mkTemp('rea-parity-proj-');
    // Deliberately NO writePolicy(proj): .rea/policy.yaml is absent.
    const { cliRealpath } = buildGlobalFixture(home, { trustProjReal: proj });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'global', reason: 'trusted', cliRealpath });

    const rows = checkGlobalCli(proj, home);
    expect(rows.map((r) => r.status)).toEqual(['pass', 'pass', 'info']);
  });

  // P2-b — a PRESENT but malformed policy is fail-closed (veto), matching the
  // shim's non-zero `policy-get` branch.
  it('global installed + trusted + MALFORMED policy.yaml → policy-veto (fail-closed)', () => {
    const proj = mkTemp('rea-parity-proj-');
    fs.mkdirSync(path.join(proj, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.rea', 'policy.yaml'), 'this: [is not: valid yaml\n');
    buildGlobalFixture(home, { trustProjReal: proj });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'in-project', reason: 'policy-veto', cliRealpath: null });
  });

  it('global installed + trusted → global active + residual-risk info', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    const { cliRealpath } = buildGlobalFixture(home, { trustProjReal: proj });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'global', reason: 'trusted', cliRealpath });

    const rows = checkGlobalCli(proj, home);
    expect(rows.map((r) => r.status)).toEqual(['pass', 'pass', 'info']);
    expect(rows[0]?.detail).toContain(cliRealpath as string);
    expect(rows[1]?.detail).toContain('global-CLI trust registry');
    expect(rows[1]?.detail).toContain(registryPath(home));
    expect(rows[2]?.detail).toContain('integrity relies on filesystem ownership of');
    expect(rows[2]?.detail).toContain(reaDir(home));
  });

  it('global installed + untrusted → in-project (fail-closed) + warn row', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    buildGlobalFixture(home, { trustProjReal: null });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'in-project', reason: 'untrusted', cliRealpath: null });

    const rows = checkGlobalCli(proj, home);
    expect(rows.map((r) => r.status)).toEqual(['pass', 'warn']);
    expect(rows[1]?.detail).toContain('NOT in the global-CLI trust registry');
    expect(rows[1]?.detail).toContain('run: rea trust');
  });

  it('global installed + trusted but policy veto → in-project (policy-veto)', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj, { veto: true });
    buildGlobalFixture(home, { trustProjReal: proj });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'in-project', reason: 'policy-veto', cliRealpath: null });

    const rows = checkGlobalCli(proj, home);
    expect(rows.map((r) => r.status)).toEqual(['pass', 'info']);
    expect(rows[1]?.detail).toContain('policy.runtime.allow_global_cli: false');
  });

  it('global root world-writable → hard fail (drives exit 1)', () => {
    const proj = mkTemp('rea-parity-proj-');
    buildGlobalFixture(home, { trustProjReal: proj, worldWritable: true });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'in-project', reason: 'global-root-unsafe' });
    expect(t.safety?.ok).toBe(false);

    const rows = checkGlobalCli(proj, home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('fail');
    expect(rows[0]?.label).toBe('global rea CLI root safety');
    expect(rows.some((r) => r.status === 'fail')).toBe(true);
  });

  it('global root present but no resolvable CLI → hard fail (drives exit 1)', () => {
    const proj = mkTemp('rea-parity-proj-');
    buildGlobalFixture(home, { installCli: false, trustProjReal: proj });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'in-project', reason: 'global-unresolvable' });

    const rows = checkGlobalCli(proj, home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('fail');
    expect(rows[0]?.detail).toContain('re-run `rea install --global`');
  });

  it('symlinked global root → hard fail (root safety refuses)', () => {
    const proj = mkTemp('rea-parity-proj-');
    // Make <home>/.rea a symlink to elsewhere — the safety gate must refuse.
    const elsewhere = mkTemp('rea-parity-elsewhere-');
    fs.mkdirSync(path.join(elsewhere, 'cli'), { recursive: true });
    fs.symlinkSync(elsewhere, reaDir(home));
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({ tier: 'in-project', reason: 'global-root-unsafe' });
    expect(t.safety?.code).toBe('symlink');

    const rows = checkGlobalCli(proj, home);
    expect(rows[0]?.status).toBe('fail');
    expect(rows[0]?.detail).toContain('rm ');
  });

  // P2-1 — a candidate that fails the A1–A4 sandbox must NOT be reported as
  // global (the shim falls back to no-CLI). tier = in-project + fail row.
  it('trusted but candidate index.js is a symlink → in-project + candidate-safety fail', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    buildGlobalFixture(home, { trustProjReal: proj, symlinkCli: true });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({
      tier: 'in-project',
      reason: 'global-candidate-unsafe',
      cliRealpath: null,
    });
    expect(t.candidateSafety?.code).toBe('symlink');

    const rows = checkGlobalCli(proj, home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('fail');
    expect(rows[0]?.label).toBe('global rea CLI candidate safety');
    expect(rows[0]?.detail).toContain('symlink');
  });

  it('trusted but global package.json name is wrong → in-project + candidate-safety fail', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    buildGlobalFixture(home, { trustProjReal: proj, badPkgName: true });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({
      tier: 'in-project',
      reason: 'global-candidate-unsafe',
      cliRealpath: null,
    });
    expect(t.candidateSafety?.code).toBe('no-rea-pkg');

    const rows = checkGlobalCli(proj, home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('fail');
    expect(rows[0]?.detail).toContain('no-rea-pkg');
  });

  // P2 (round-4) — a sandbox-clean global CLI that predates `hook policy-get`
  // makes the shim fall back to no-CLI at the veto step; doctor must NOT report
  // global. Injected probe keeps this hermetic (no spawn).
  it('trusted but global CLI lacks hook policy-get (injected probe) → in-project + capability fail', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    const { cliRealpath } = buildGlobalFixture(home, { trustProjReal: proj });
    const incapable = (): { ok: boolean } => ({ ok: false });
    const t = resolveGlobalCliTier(proj, home, incapable);
    expect(t).toMatchObject({
      tier: 'in-project',
      reason: 'global-cli-incapable',
      cliRealpath: null,
    });
    expect(t.globalCliRealpath).toBe(cliRealpath);

    const rows = checkGlobalCli(proj, home, incapable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('fail');
    expect(rows[0]?.label).toBe('global rea CLI capability');
    expect(rows[0]?.detail).toContain('hook policy-get');
  });

  // Same, but driving the REAL default probe (spawn) against an incapable stub
  // CLI — proves the shared probeGlobalCliCapability actually detects it.
  it('trusted but incapable stub CLI (real probe) → in-project + capability fail', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    buildGlobalFixture(home, { trustProjReal: proj, incapableCli: true });
    const t = resolveGlobalCliTier(proj, home); // default real probe
    expect(t).toMatchObject({
      tier: 'in-project',
      reason: 'global-cli-incapable',
      cliRealpath: null,
    });
  });

  // Injected CAPABLE probe → the tier resolves to global (proves the probe
  // gates both ways, and that a capable CLI is not spuriously rejected).
  it('trusted + capable CLI (injected probe ok) → global', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    const { cliRealpath } = buildGlobalFixture(home, { trustProjReal: proj });
    const capable = (): { ok: boolean } => ({ ok: true });
    const t = resolveGlobalCliTier(proj, home, capable);
    expect(t).toMatchObject({ tier: 'global', reason: 'trusted', cliRealpath });
  });

  // P2 (round-5) — the global tier is POSIX-only. The bash shim_global_entry_gate
  // uses process.geteuid() (undefined on Windows/Git Bash) → the tier is
  // silently unavailable. Simulate by removing geteuid; a trusted global root
  // must NOT resolve to `global` and must NOT emit a fail/warn.
  it('no geteuid (Windows) + trusted global root → NOT global, one benign info row', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    buildGlobalFixture(home, { trustProjReal: proj });
    const savedGeteuid = process.geteuid;
    process.geteuid = undefined;
    try {
      // Even an injected CAPABLE probe must not lift the platform gate.
      const t = resolveGlobalCliTier(proj, home, () => ({ ok: true }));
      expect(t.tier).toBe('in-project');
      expect(t.reason).toBe('global-unavailable-platform');
      expect(t.cliRealpath).toBeNull();

      const rows = checkGlobalCli(proj, home, () => ({ ok: true }));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('info');
      expect(rows[0]?.label).toBe('global rea CLI');
      expect(rows[0]?.detail).toContain('POSIX-only');
      expect(rows.some((r) => r.status === 'fail' || r.status === 'warn')).toBe(false);
    } finally {
      process.geteuid = savedGeteuid;
    }
  });

  it('no geteuid (Windows) + in-project present → in-project reporting unchanged, no fail/warn', () => {
    const proj = mkTemp('rea-parity-proj-');
    const inProj = fs.realpathSync(installInProjectCli(proj));
    buildGlobalFixture(home, { trustProjReal: proj });
    const savedGeteuid = process.geteuid;
    process.geteuid = undefined;
    try {
      const t = resolveGlobalCliTier(proj, home);
      expect(t).toMatchObject({ tier: 'in-project', reason: 'in-project-wins', cliRealpath: inProj });
      const rows = checkGlobalCli(proj, home);
      expect(rows.some((r) => r.status === 'fail' || r.status === 'warn')).toBe(false);
    } finally {
      process.geteuid = savedGeteuid;
    }
  });

  // P2-1 — an unsafe trust registry (A5.3b) makes the shim refuse the global
  // CLI. Doctor must NOT report global/trusted; it reports NOT-global + a fail
  // row carrying the registry remediation.
  it('trusted-projects registry is mode 0644 → in-project + registry-safety fail', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    buildGlobalFixture(home, { trustProjReal: proj, registryMode: 0o644 });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({
      tier: 'in-project',
      reason: 'global-registry-unsafe',
      cliRealpath: null,
    });
    expect(t.safety?.ok).toBe(false);
    expect(t.safety?.code).toBe('bad-mode');

    const rows = checkGlobalCli(proj, home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('fail');
    expect(rows[0]?.label).toBe('global-CLI trust registry safety');
    expect(rows[0]?.detail).toContain('chmod 600');
  });

  it('trusted-projects registry is a symlink → in-project + registry-safety fail', () => {
    const proj = mkTemp('rea-parity-proj-');
    writePolicy(proj);
    buildGlobalFixture(home, { trustProjReal: proj, symlinkRegistry: true });
    const t = resolveGlobalCliTier(proj, home);
    expect(t).toMatchObject({
      tier: 'in-project',
      reason: 'global-registry-unsafe',
      cliRealpath: null,
    });
    expect(t.safety?.code).toBe('symlink');

    const rows = checkGlobalCli(proj, home);
    expect(rows[0]?.status).toBe('fail');
    expect(rows[0]?.detail).toContain('rm ');
  });

  // P2-2 — a passwd lookup that throws (arbitrary/unmapped UID in a container
  // or CI) must NOT crash `rea doctor`; it degrades to a single info row.
  it('passwd lookup throwing → one info row, never a crash', () => {
    const proj = mkTemp('rea-parity-proj-');
    vi.spyOn(os, 'userInfo').mockImplementation(() => {
      throw new Error('getpwuid_r failed (no passwd entry)');
    });
    // No `home` arg → checkGlobalCli must resolve it via passwdHome() and
    // survive the throw.
    const rows = checkGlobalCli(proj);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('info');
    expect(rows[0]?.label).toBe('global rea CLI');
    expect(rows[0]?.detail).toContain('could not resolve home directory');
    vi.restoreAllMocks();
  });
});

// ===========================================================================
// Layer 2 — doctor↔shim parity (guarded-skip; real passwd home)
// ===========================================================================

function bashAvailable(): boolean {
  try {
    return spawnSync('bash', ['-c', 'exit 0']).status === 0;
  } catch {
    return false;
  }
}

/**
 * Computed at module load. The bash global resolver reads the ENV-IMMUNE
 * passwd home, so the only hermetic-enough way to drive it is against the real
 * `~/.rea` — which we refuse to touch if it already exists. We ALSO skip when
 * the passwd home is present-but-not-writable: sandboxed runners (Codex's
 * workspace-write env) have a real home that `mkdir <home>/.rea` cannot create,
 * and an unguarded `mkdir` would throw EPERM/EACCES and fail the suite before
 * any assertion. The hermetic (injected-home) layer above is unaffected.
 */
const canRunRealShim = (() => {
  if (process.platform === 'win32') return false;
  if (!bashAvailable()) return false;
  let home: string;
  try {
    home = passwdHome();
  } catch {
    return false; // no passwd entry (arbitrary/unmapped UID)
  }
  if (fs.existsSync(path.join(home, '.rea'))) return false; // never clobber a real install
  try {
    fs.accessSync(home, fs.constants.W_OK); // throws when the home dir is not writable
  } catch {
    return false;
  }
  return true;
})();

/** Write the shim-driver harness (mirrors shim_run steps 4 / 4-global / veto). */
function writeHarness(dir: string): string {
  const harness = [
    '#!/bin/bash',
    '# Test harness — sources the REAL shim-runtime.sh and runs the same',
    '# resolver sequence as shim_run() steps 4 / 4-global / 4-global-veto,',
    '# then reports the resolved tier + the CLI path REA_ARGV forwards to.',
    'set -uo pipefail',
    'SHIM_LIB="$1"',
    'proj="$2"',
    'REA_ROOT="$proj"',
    '. "$SHIM_LIB"',
    'REA_ARGV=()',
    'RESOLVED_CLI_PATH=""',
    'TRUST_TIER="project"',
    'shim_resolve_cli',
    'if [ "${#REA_ARGV[@]}" -eq 0 ]; then shim_resolve_cli_global; fi',
    '# verbatim mirror of shim_run() step 4-global-veto',
    'if [ "$TRUST_TIER" = "global" ]; then',
    '  veto_out=$("${REA_ARGV[@]}" hook policy-get runtime.allow_global_cli 2>/dev/null); veto_status=$?',
    '  _gv=0',
    '  if [ "$veto_status" -ne 0 ]; then _gv=1; else case "$veto_out" in false) _gv=1 ;; *) ;; esac; fi',
    '  if [ "$_gv" -eq 1 ]; then REA_ARGV=(); TRUST_TIER="project"; fi',
    'fi',
    '# REA_ARGV[1] is the CLI path the shim forwards to (empty when no CLI).',
    'CLI_PATH="${REA_ARGV[1]:-}"',
    'printf "%s\\t%s\\n" "$TRUST_TIER" "$CLI_PATH"',
    '',
  ].join('\n');
  const p = path.join(dir, 'shim-tier-probe.sh');
  fs.writeFileSync(p, harness, { mode: 0o755 });
  return p;
}

function driveShim(
  harness: string,
  proj: string,
  env: Record<string, string> = {},
): { tier: string; cliPath: string } {
  const r = spawnSync('bash', [harness, SHIM_LIB, proj], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const [tier = '', cliPath = ''] = (r.stdout ?? '').trim().split('\t');
  return { tier, cliPath };
}

/** Map the TS predicate's tier onto the bash shim's TRUST_TIER vocabulary. */
function tsTierToBash(tier: 'in-project' | 'global'): string {
  return tier === 'global' ? 'global' : 'project';
}

describe.skipIf(!canRunRealShim)('doctor↔shim parity (real bash shim)', () => {
  const home = passwdHome();
  const rea = reaDir(home);
  let harness: string;

  beforeEach(() => {
    harness = writeHarness(mkTemp('rea-parity-harness-'));
  });

  function cleanupRealHome(): void {
    try {
      fs.chmodSync(rea, 0o700); // undo world-writable so rm can recurse
    } catch {
      /* may not exist */
    }
    fs.rmSync(rea, { recursive: true, force: true });
  }

  interface Scenario {
    name: string;
    /** build the fixture; returns the (realpath'd) project dir. */
    setup: () => string;
    /** env for the bash drive (e.g. REA_TEST_VETO). */
    env?: Record<string, string>;
  }

  const scenarios: Scenario[] = [
    {
      name: 'in-project present (global absent)',
      setup: () => {
        const proj = mkTemp('rea-parity-real-inproj-');
        installInProjectCli(proj);
        return proj;
      },
    },
    {
      name: 'global root absent',
      setup: () => mkTemp('rea-parity-real-absent-'),
    },
    {
      name: 'global + trusted',
      setup: () => {
        const proj = mkTemp('rea-parity-real-trust-');
        writePolicy(proj);
        buildGlobalFixture(home, { trustProjReal: proj });
        return proj;
      },
    },
    {
      name: 'global + untrusted',
      setup: () => {
        const proj = mkTemp('rea-parity-real-untrust-');
        writePolicy(proj);
        buildGlobalFixture(home, { trustProjReal: null });
        return proj;
      },
    },
    {
      name: 'global + veto (allow_global_cli:false)',
      setup: () => {
        const proj = mkTemp('rea-parity-real-veto-');
        writePolicy(proj, { veto: true });
        buildGlobalFixture(home, { trustProjReal: proj });
        return proj;
      },
      env: { REA_TEST_VETO: '1' },
    },
    {
      name: 'global bad-perms (world-writable root)',
      setup: () => {
        const proj = mkTemp('rea-parity-real-badperm-');
        writePolicy(proj);
        buildGlobalFixture(home, { trustProjReal: proj, worldWritable: true });
        return proj;
      },
    },
    {
      // P2-1 unsafe-candidate: trusted, but index.js is a symlink → the shim's
      // A2 walk refuses. Both sides MUST land on not-global.
      name: 'global + trusted + symlinked candidate index.js',
      setup: () => {
        const proj = mkTemp('rea-parity-real-symcli-');
        writePolicy(proj);
        buildGlobalFixture(home, { trustProjReal: proj, symlinkCli: true });
        return proj;
      },
    },
    {
      // P2-1 unsafe-candidate: trusted, but the global package.json name is
      // wrong → the shim's A3 walk refuses. Both sides MUST land on not-global.
      name: 'global + trusted + wrong package.json name',
      setup: () => {
        const proj = mkTemp('rea-parity-real-badpkg-');
        writePolicy(proj);
        buildGlobalFixture(home, { trustProjReal: proj, badPkgName: true });
        return proj;
      },
    },
    {
      // P2-a: in-project present, but ~/.rea/cli is broken (world-writable
      // root). The shim NEVER consults ~/.rea → in-project. Doctor must NOT
      // emit a fail row for the unused, broken global tree.
      name: 'in-project present + broken global root (world-writable)',
      setup: () => {
        const proj = mkTemp('rea-parity-real-inproj-broken-');
        installInProjectCli(proj);
        buildGlobalFixture(home, { trustProjReal: proj, worldWritable: true });
        return proj;
      },
    },
    {
      // P2-b: trusted + NO policy.yaml. A missing policy is veto-ABSENT — the
      // shim's policy-get exits 0 empty ⇒ ALLOW. Both sides MUST land on global.
      name: 'global + trusted + policy absent',
      setup: () => {
        const proj = mkTemp('rea-parity-real-nopolicy-');
        // No writePolicy: .rea/policy.yaml is absent.
        buildGlobalFixture(home, { trustProjReal: proj });
        return proj;
      },
    },
    {
      // P2-1 (registry A5.3b): trusted member, but trusted-projects is mode
      // 0644 → the shim's entry gate refuses. Both sides MUST land on not-global.
      name: 'global + trusted + unsafe registry (mode 0644)',
      setup: () => {
        const proj = mkTemp('rea-parity-real-badreg-');
        writePolicy(proj);
        buildGlobalFixture(home, { trustProjReal: proj, registryMode: 0o644 });
        return proj;
      },
    },
    {
      // P2 (round-4): trusted, sandbox-clean, but the global CLI predates
      // `hook policy-get` → the shim's veto read exits non-zero → fail-closed to
      // no-CLI. Both the real shim and doctor's real probe MUST land on
      // not-global.
      name: 'global + trusted + capability-incapable CLI',
      setup: () => {
        const proj = mkTemp('rea-parity-real-incap-');
        writePolicy(proj);
        buildGlobalFixture(home, { trustProjReal: proj, incapableCli: true });
        return proj;
      },
    },
  ];

  it('the TS predicate agrees with the bash shim on tier + CLI realpath for every scenario', () => {
    const results: Array<{
      name: string;
      bash: { tier: string; cliPath: string };
      ts: ReturnType<typeof resolveGlobalCliTier>;
      rows: ReturnType<typeof checkGlobalCli>;
    }> = [];

    for (const sc of scenarios) {
      // Guard against a real global install that appeared mid-run: never
      // clobber it — abort the whole layer if so.
      if (fs.existsSync(rea)) {
        throw new Error(`refusing to run parity: ${rea} exists (would clobber a real install)`);
      }
      let proj: string;
      let bash: { tier: string; cliPath: string };
      let ts: ReturnType<typeof resolveGlobalCliTier>;
      let rows: ReturnType<typeof checkGlobalCli>;
      try {
        proj = sc.setup();
        bash = driveShim(harness, proj, sc.env);
        // Same fixture, same real passwd home — the TS predicate must agree.
        ts = resolveGlobalCliTier(proj, home);
        rows = checkGlobalCli(proj, home);
      } finally {
        cleanupRealHome();
      }
      results.push({ name: sc.name, bash, ts, rows });
    }

    for (const r of results) {
      expect(r.bash.tier, `${r.name}: tier`).toBe(tsTierToBash(r.ts.tier));
      expect(r.bash.cliPath, `${r.name}: CLI realpath`).toBe(r.ts.cliRealpath ?? '');
    }

    // P2-a: in-project short-circuit — a broken/unused global tree yields NO
    // fail/warn row when the checkout runs the in-project CLI.
    const inprojBroken = results.find((r) => r.name.includes('broken global root'));
    expect(inprojBroken?.ts.tier).toBe('in-project');
    expect(inprojBroken?.ts.reason).toBe('in-project-wins');
    expect(inprojBroken?.rows.some((x) => x.status === 'fail' || x.status === 'warn')).toBe(false);

    // P2-b: trusted + missing policy → global (allowed), never policy-veto.
    const noPolicy = results.find((r) => r.name.includes('policy absent'));
    expect(noPolicy?.ts.tier).toBe('global');
    expect(noPolicy?.ts.reason).not.toBe('policy-veto');

    // P2-1: unsafe trust registry → not-global on both sides + a fail row.
    const badReg = results.find((r) => r.name.includes('unsafe registry'));
    expect(badReg?.ts.tier).toBe('in-project');
    expect(badReg?.ts.reason).toBe('global-registry-unsafe');
    expect(badReg?.rows.some((x) => x.status === 'fail')).toBe(true);

    // P2 (round-4): capability-incapable CLI → not-global on both sides + a
    // fail row (the shim fail-closes at the veto read; doctor's probe agrees).
    const incap = results.find((r) => r.name.includes('capability-incapable'));
    expect(incap?.ts.tier).toBe('in-project');
    expect(incap?.ts.reason).toBe('global-cli-incapable');
    expect(incap?.rows.some((x) => x.status === 'fail')).toBe(true);
  });
});
