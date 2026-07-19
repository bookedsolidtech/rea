/**
 * Unit tests for the G1 spec-gate pre-commit installer.
 *
 * Round-12 F1/F2 coverage:
 *   - active-hooks-path resolution (vanilla git → `.git/hooks/pre-commit`;
 *     `core.hooksPath=.husky` → `.husky/pre-commit`; foreign posture).
 *   - the generated body carries the `REA_CLI_ROOT` worktree fallback so a
 *     linked worktree resolves the primary checkout's CLI (F2).
 */

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  preCommitHookContent,
  isReaManagedPreCommit,
  classifyPreCommit,
  installPreCommitHook,
  resolveTargetHookPath,
  PRE_COMMIT_MARKER,
  PRE_COMMIT_BODY_MARKER,
} from './pre-commit.js';

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-precommit-')));
  await execFileAsync('git', ['-C', dir, 'init', '-q']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@test']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'test']);
  return dir;
}
async function setHooksPath(dir: string, hooksPath: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', hooksPath]);
}
function rm(d: string): void {
  fssync.rmSync(d, { recursive: true, force: true });
}

describe('pre-commit installer — content + markers', () => {
  it('content carries both markers and invokes `rea gate spec-check`', () => {
    const c = preCommitHookContent();
    expect(c.startsWith('#!/bin/sh\n')).toBe(true);
    expect(c.split('\n')[1]).toBe(PRE_COMMIT_MARKER);
    expect(c.split('\n')[2]).toBe(PRE_COMMIT_BODY_MARKER);
    expect(c).toContain('gate spec-check');
    expect(isReaManagedPreCommit(c)).toBe(true);
  });

  it('rejects a hook with the header marker but a stubbed-out body', () => {
    const stubbed = `#!/bin/sh\n${PRE_COMMIT_MARKER}\n# not the body marker\nexit 0\n`;
    expect(isReaManagedPreCommit(stubbed)).toBe(false);
  });

  // Round-12 F2 — the body must carry the pre-push v6 REA_CLI_ROOT worktree
  // fallback so a linked worktree (no local node_modules/dist) resolves the
  // primary checkout's CLI instead of falling through to fail-open exit 0.
  describe('F2 — REA_CLI_ROOT worktree fallback in the body', () => {
    const body = preCommitHookContent();
    it('seeds REA_CLI_ROOT from REA_ROOT then re-resolves via git-common-dir', () => {
      expect(body).toContain('REA_CLI_ROOT="$REA_ROOT"');
      expect(body).toMatch(/rev-parse --git-common-dir/);
      expect(body).toMatch(/git -C "\$REA_ROOT" worktree list --porcelain/);
    });
    it('dispatches from REA_CLI_ROOT across every tier (via _rea_spec_gate)', () => {
      // Round-17: the actual `gate spec-check` invocation moved into the
      // `_rea_spec_gate` helper (`"$@" gate spec-check`); the tiers pass the
      // resolved CLI to it. The name-guard on the dist tier is unchanged.
      expect(body).toMatch(/_rea_spec_gate "\$\{REA_CLI_ROOT\}\/node_modules\/\.bin\/rea"/);
      expect(body).toMatch(/_rea_spec_gate node "\$\{REA_CLI_ROOT\}\/dist\/cli\/index\.js"/);
      expect(body).toContain('"$@" gate spec-check');
      expect(body).toMatch(
        /grep -q '"name": \*"@bookedsolid\/rea"' "\$\{REA_CLI_ROOT\}\/package\.json"/,
      );
    });
    it('same-repository verification guards a foreign nested checkout', () => {
      expect(body).toContain('_rea_same_repo');
    });
    it('round-54: no-CLI branch routes through the tri-state cannot-run helper', () => {
      // Round-23 F2 + round-54: the no-CLI else calls `_rea_spec_cannot_run`,
      // which is enforce → exit 2 / shadow → warn+return 0 / off → return 0
      // (control falls through to the fragment chain for shadow/off).
      expect(body).toMatch(/else\n\s+# No rea CLI anywhere\. round-54 tri-state[\s\S]*_rea_spec_cannot_run 'no rea CLI is installed or built'\nfi/);
    });
    // Round-15 P1 kept: `npx --no-install` (a network auto-install that exits
    // non-zero on a cache miss) is NEVER reintroduced.
    it('has NO npx / network-auto-install fallback (round-15 P1)', () => {
      expect(body).not.toContain('npx');
    });
    // Round-17 F2 reconciliation: a global/PATH `rea` tier IS present (for
    // `rea install --global`), but every tier runs through `_rea_spec_gate`,
    // which blocks ONLY on a genuine G1 refusal (exit 2) — so a too-old/broken
    // CLI at any tier fails OPEN. This is the mechanism that lets the PATH tier
    // come back without the round-15 fresh-clone brick.
    it('F2: has a global/PATH `rea` tier gated by the exit-2-only discipline', () => {
      expect(body).toContain('_rea_spec_gate()');
      expect(body).toMatch(/command -v rea >\/dev\/null 2>&1; then/);
      expect(body).toMatch(/_rea_spec_gate rea\b/);
      // The discipline: a genuine G1 refusal is exit 2 → block; a pass / any
      // non-2 RETURNS 0 (round-23 F2 — control falls through to the fragment
      // chain, not `exit 0`).
      expect(body).toMatch(/if \[ "\$_rc" -eq 2 \]; then/);
      expect(body).toMatch(/_rc=\$\?[\s\S]*return 0/);
    });
    // round-54 — tri-state mode detector + cannot-run routing (incl. catch-all).
    it('round-54: carries the g1_spec gate-MODE detector + tri-state routing', () => {
      expect(body).toContain('_rea_spec_gate_mode()');
      expect(body).toContain('_rea_spec_cannot_run()');
      expect(body).toMatch(/_rea_pol="\$\{REA_ROOT\}\/\.rea\/policy\.yaml"/);
      expect(body).toMatch(/\[ -f "\$_rea_pol" \] \|\| \{ printf 'off'; return 0; \}/);
      expect(body).toMatch(/command -v awk >\/dev\/null 2>&1 \|\| \{ printf 'enforce'; return 0; \}/);
      // block + inline-flow-map detection for g1_spec.
      expect(body).toMatch(/opener="\^g1_spec:"/);
      expect(body).toMatch(/inlinep="g1_spec\[\^A-Za-z_\]\.\*mode:"/);
      // tri-state: enforce → CONFIG-ERROR + exit 2; shadow → WARN + return 0.
      expect(body).toMatch(/case "\$\(_rea_spec_gate_mode\)" in/);
      expect(body).toContain('CONFIG-ERROR');
      expect(body).toMatch(/WARN — G1 spec gate \(shadow\) could not run/);
      // unknown-command routed to cannot-run; unknown-option always returns 0;
      // finding-2 catch-all `*)` ALSO routed to cannot-run (not a bare return 0).
      expect(body).toMatch(/\*"unknown command"\*\)\n\s+_rea_spec_cannot_run/);
      expect(body).toMatch(/\*"unknown option"\*\)\n\s+return 0 ;;/);
      expect(body).toMatch(/rea gate spec-check failed to run \(unexpected error\)/);
    });
    it('F2: in-project tiers also run through _rea_spec_gate', () => {
      expect(body).toMatch(/_rea_spec_gate "\$\{REA_CLI_ROOT\}\/node_modules\/\.bin\/rea"/);
      expect(body).toMatch(/_rea_spec_gate node "\$\{REA_CLI_ROOT\}\/dist\/cli\/index\.js"/);
    });
    // Round-23 F2 — pre-commit.d fragment chaining (mirrors pre-push's
    // `.husky/pre-push.d/`): iterate the dir in glob (POSIX-sorted) order,
    // run executable regular files, missing dir = no-op.
    it('F2: chains `.husky/pre-commit.d/*` fragments after the spec gate', () => {
      expect(body).toContain('${REA_ROOT}/.husky/pre-commit.d');
      expect(body).toMatch(/for frag in "\$ext_dir"\/\*; do/);
      expect(body).toMatch(/\[ -x "\$frag" \] \|\| continue/);
      expect(body).toMatch(/"\$frag"\n\s*done/);
    });
  });
});

// Round-15 P1 + round-17 F2 — behavioural proof that the installed hook FAILS
// OPEN across every tier. The body is run as a real shell script in a temp git
// repo; the ONLY non-zero exit is a WORKING rea CLI (in-project OR global)
// whose `gate spec-check` genuinely refuses (exit 2).
describe('pre-commit body — fail-open behaviour (round-15 P1 + round-17 F2)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeRepo();
    // Install the managed hook so we run the EXACT bytes the installer writes.
    await installPreCommitHook({ targetDir: dir });
  });
  afterEach(() => rm(dir));

  const HOOK = (): string => path.join(dir, '.git', 'hooks', 'pre-commit');
  const bashOk = (): boolean => spawnSync('bash', ['--version']).status === 0;

  // `bash` (and git/grep) come from the real PATH; a fake-bin dir is PREPENDED
  // so its `rea` wins `command -v rea` inside the script. The temp repo has NO
  // policy.yaml, so even a REAL global rea that leaks through resolves the gate
  // to `off` → exit 0 — the assertions hold regardless of the host's global CLI.
  function run(prependBin?: string): number {
    const base = process.env['PATH'] ?? '';
    const res = spawnSync('bash', [HOOK()], {
      cwd: dir,
      env: { PATH: prependBin ? `${prependBin}:${base}` : base, HOME: process.env['HOME'] ?? '/tmp' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return res.status ?? -1;
  }

  /** Write a fake `rea` (exits `code`) into `dir/<bin>` and return that bin dir. */
  function fakeRea(bin: string, code: number): string {
    const binDir = path.join(dir, bin);
    fssync.mkdirSync(binDir, { recursive: true });
    const p = path.join(binDir, 'rea');
    fssync.writeFileSync(p, `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
    fssync.chmodSync(p, 0o755);
    return binDir;
  }

  /** Write a fake in-project `node_modules/.bin/rea` that exits `code`. */
  function inProjectRea(code: number): void {
    const binDir = path.join(dir, 'node_modules', '.bin');
    fssync.mkdirSync(binDir, { recursive: true });
    const p = path.join(binDir, 'rea');
    fssync.writeFileSync(p, `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
    fssync.chmodSync(p, 0o755);
  }

  it('exits 0 on a fresh clone (no in-project CLI; gate off / no CLI → fail open)', () => {
    if (!bashOk()) return;
    // No node_modules/.bin/rea, no dist, no policy → exit 0.
    expect(run()).toBe(0);
  });

  it('propagates a RESOLVED in-project CLI refusal (node_modules/.bin/rea exit 2 → 2)', () => {
    if (!bashOk()) return;
    inProjectRea(2); // the one legitimate non-zero path
    expect(run()).toBe(2);
  });

  it('fails OPEN when the in-project CLI is TOO OLD (node_modules/.bin/rea exit 1 → 0)', () => {
    if (!bashOk()) return;
    inProjectRea(1); // commander unknown-command / any non-2 error
    expect(run()).toBe(0);
  });

  // Round-17 F2 — the global/PATH tier (reached only when no in-project CLI).
  it('F2: a GLOBAL rea that refuses (exit 2) blocks the commit (→ 2)', () => {
    if (!bashOk()) return;
    expect(run(fakeRea('globalbin', 2))).toBe(2);
  });

  it('F2: a GLOBAL rea that is too-old/broken (exit 1) fails OPEN (→ 0)', () => {
    if (!bashOk()) return;
    expect(run(fakeRea('globalbin', 1))).toBe(0);
  });

  it('F2: a GLOBAL rea that errors hard (exit 3, foreign) fails OPEN (→ 0)', () => {
    if (!bashOk()) return;
    expect(run(fakeRea('globalbin', 3))).toBe(0);
  });

  // ── round-53 P1 — mode-aware fail-closed when the CLI cannot run G1 ────────
  /** Write a policy.yaml under the repo. */
  function writePolicy(yaml: string): void {
    fssync.mkdirSync(path.join(dir, '.rea'), { recursive: true });
    fssync.writeFileSync(path.join(dir, '.rea', 'policy.yaml'), yaml);
  }
  /** In-project `rea` whose `gate` subcommand emits `msg` to stderr + exits 1. */
  function inProjectReaGateError(msg: string): void {
    const binDir = path.join(dir, 'node_modules', '.bin');
    fssync.mkdirSync(binDir, { recursive: true });
    const p = path.join(binDir, 'rea');
    fssync.writeFileSync(
      p,
      `#!/bin/sh\ncase "$1" in gate) echo "${msg}" >&2; exit 1 ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    fssync.chmodSync(p, 0o755);
  }
  /** In-project `rea` whose `gate` subcommand CRASHES: non-2 exit, no
   *  unknown-* marker (simulates node-missing on the dist path / corrupted
   *  install / the command dying before it returns its own verdict). */
  function inProjectReaGateCrash(): void {
    const binDir = path.join(dir, 'node_modules', '.bin');
    fssync.mkdirSync(binDir, { recursive: true });
    const p = path.join(binDir, 'rea');
    fssync.writeFileSync(
      p,
      `#!/bin/sh\ncase "$1" in gate) echo "Segmentation fault (core dumped)" >&2; exit 3 ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    fssync.chmodSync(p, 0o755);
  }
  /** run() variant returning both status and stderr. */
  function runFull(): { status: number; stderr: string } {
    const base = process.env['PATH'] ?? '';
    const res = spawnSync('bash', [HOOK()], {
      cwd: dir,
      env: { PATH: base, HOME: process.env['HOME'] ?? '/tmp' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: res.status ?? -1, stderr: res.stderr ?? '' };
  }

  const G1_ENFORCE = 'artifact_gates:\n  g1_spec:\n    mode: enforce\n';
  const G1_SHADOW = 'artifact_gates:\n  g1_spec:\n    mode: shadow\n';
  const G1_OFF = 'artifact_gates:\n  g1_spec:\n    mode: off\n';

  it('P1: unknown-command CLI + g1_spec enforce → FAIL CLOSED (exit 2 + CONFIG-ERROR)', () => {
    if (!bashOk()) return;
    writePolicy(G1_ENFORCE);
    inProjectReaGateError("error: unknown command 'gate'");
    const r = runFull();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('CONFIG-ERROR');
  });

  // round-54 tri-state: shadow is OBSERVE-ONLY → WARN + ALLOW, never blocks.
  it('round-54: unknown-command CLI + g1_spec shadow → WARN + ALLOW (exit 0)', () => {
    if (!bashOk()) return;
    writePolicy(G1_SHADOW);
    inProjectReaGateError("error: unknown command 'gate'");
    const r = runFull();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARN — G1 spec gate (shadow) could not run');
    expect(r.stderr).not.toContain('CONFIG-ERROR');
  });

  it('P1: unknown-command CLI + nested-inline g1_spec enforce → FAIL CLOSED (exit 2)', () => {
    if (!bashOk()) return;
    writePolicy('artifact_gates: { g1_spec: { mode: enforce } }\n');
    inProjectReaGateError("error: unknown command 'gate'");
    expect(runFull().status).toBe(2);
  });

  it('round-54: unknown-command CLI + nested-inline g1_spec shadow → WARN + ALLOW (exit 0)', () => {
    if (!bashOk()) return;
    writePolicy('artifact_gates: { g1_spec: { mode: shadow } }\n');
    inProjectReaGateError("error: unknown command 'gate'");
    const r = runFull();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARN');
  });

  it('P1: unknown-command CLI + g1_spec off → FAIL OPEN (exit 0 silent)', () => {
    if (!bashOk()) return;
    writePolicy(G1_OFF);
    inProjectReaGateError("error: unknown command 'gate'");
    const r = runFull();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('WARN');
  });

  it('P1: unknown-OPTION CLI + g1_spec enforce → FAIL OPEN (flag compat never blocks)', () => {
    if (!bashOk()) return;
    writePolicy(G1_ENFORCE);
    inProjectReaGateError("error: unknown option '--foo'");
    const r = runFull();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('CONFIG-ERROR');
  });

  // Finding 2 (round-54 P2) — an UNEXPECTED runner error (non-2, no unknown-*
  // marker: crash / node-missing on the dist path / corrupted install) must NOT
  // silently pass an ENFORCE gate. Routed through the same tri-state.
  it('F2: unexpected runner error (exit 3, no unknown-*) + enforce → FAIL CLOSED (exit 2 + CONFIG-ERROR)', () => {
    if (!bashOk()) return;
    writePolicy(G1_ENFORCE);
    inProjectReaGateCrash();
    const r = runFull();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('CONFIG-ERROR');
    expect(r.stderr).toContain('failed to run');
  });

  it('F2: unexpected runner error + shadow → WARN + ALLOW (exit 0)', () => {
    if (!bashOk()) return;
    writePolicy(G1_SHADOW);
    inProjectReaGateCrash();
    const r = runFull();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARN');
    expect(r.stderr).not.toContain('CONFIG-ERROR');
  });

  it('F2: unexpected runner error + off → FAIL OPEN (exit 0)', () => {
    if (!bashOk()) return;
    writePolicy(G1_OFF);
    inProjectReaGateCrash();
    expect(runFull().status).toBe(0);
  });

  it('P1: NO CLI + g1_spec enforce → FAIL CLOSED (exit 2 + CONFIG-ERROR)', () => {
    if (!bashOk()) return;
    writePolicy(G1_ENFORCE);
    const r = runFull();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('CONFIG-ERROR');
  });

  it('round-54: NO CLI + nested-inline g1_spec shadow → WARN + ALLOW (exit 0)', () => {
    if (!bashOk()) return;
    writePolicy('artifact_gates: { g1_spec: { mode: shadow } }\n');
    const r = runFull();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARN');
  });

  it('P1: NO CLI + nested-inline g1_spec enforce → FAIL CLOSED (exit 2)', () => {
    if (!bashOk()) return;
    writePolicy('artifact_gates: { g1_spec: { mode: enforce } }\n');
    expect(runFull().status).toBe(2);
  });

  it('P1: NO CLI + g1_spec off → FAIL OPEN (exit 0)', () => {
    if (!bashOk()) return;
    writePolicy(G1_OFF);
    expect(runFull().status).toBe(0);
  });

  // Round-18 F2 — the shell HALT check at the TOP of the body freezes the
  // commit with ZERO CLI dependency, BEFORE the fail-open CLI ladder.
  it('round-18: `.rea/HALT` + NO CLI → exit 2 (frozen WINS over fail-open)', () => {
    if (!bashOk()) return;
    fssync.mkdirSync(path.join(dir, '.rea'), { recursive: true });
    fssync.writeFileSync(path.join(dir, '.rea', 'HALT'), 'frozen\n');
    expect(run()).toBe(2);
  });

  it('round-18: HALT check does NOT hard-fail when absent (no HALT + no CLI → 0)', () => {
    if (!bashOk()) return;
    // No .rea/HALT anywhere → the HALT block falls through to the fail-open
    // ladder (round-15 fresh-clone proof still holds).
    expect(run()).toBe(0);
  });

  // ── Round-23 F2 — `.husky/pre-commit.d/*` fragment chaining ──────────────
  /** Write an executable fragment `<name>` under `.husky/pre-commit.d/`. */
  function fragment(name: string, sh: string): void {
    const d = path.join(dir, '.husky', 'pre-commit.d');
    fssync.mkdirSync(d, { recursive: true });
    const p = path.join(d, name);
    fssync.writeFileSync(p, `#!/bin/sh\n${sh}\n`, { mode: 0o755 });
    fssync.chmodSync(p, 0o755);
  }
  const marker = (n: string): string => path.join(dir, n);
  const ran = (n: string): boolean => fssync.existsSync(marker(n));

  it('F2: a fragment RUNS after a passing spec-gate (in-project rea exit 0 → fragment → 0)', () => {
    if (!bashOk()) return;
    inProjectRea(0); // spec gate PASSES
    fragment('10-check', ': > "$(git rev-parse --show-toplevel)/frag-ran"');
    expect(run()).toBe(0);
    expect(ran('frag-ran')).toBe(true);
  });

  it('F2: a fragment RUNS with NO CLI at all (fail-open spec-gate still chains)', () => {
    if (!bashOk()) return;
    fragment('10-check', ': > "$(git rev-parse --show-toplevel)/frag-ran"');
    expect(run()).toBe(0);
    expect(ran('frag-ran')).toBe(true);
  });

  it("F2: a fragment's non-zero exit BLOCKS the commit (mirrors pre-push)", () => {
    if (!bashOk()) return;
    inProjectRea(0); // spec gate passes, then the fragment fails
    fragment('10-fail', ': > "$(git rev-parse --show-toplevel)/frag-ran"\nexit 1');
    expect(run()).toBe(1);
    expect(ran('frag-ran')).toBe(true); // it DID run
  });

  it('F2: a spec-gate REFUSAL (exit 2) exits WITHOUT running fragments', () => {
    if (!bashOk()) return;
    inProjectRea(2); // genuine G1 refusal
    fragment('10-check', ': > "$(git rev-parse --show-toplevel)/frag-ran"');
    expect(run()).toBe(2);
    expect(ran('frag-ran')).toBe(false); // blocked commit never ran the fragment
  });

  it('F2: fragments run in POSIX-sorted order', () => {
    if (!bashOk()) return;
    inProjectRea(0);
    // Each fragment appends its name; order must be 05 then 10 then 20.
    fragment('20-c', 'printf c >> "$(git rev-parse --show-toplevel)/order"');
    fragment('05-a', 'printf a >> "$(git rev-parse --show-toplevel)/order"');
    fragment('10-b', 'printf b >> "$(git rev-parse --show-toplevel)/order"');
    expect(run()).toBe(0);
    expect(fssync.readFileSync(marker('order'), 'utf8')).toBe('abc');
  });

  it('F2: a NON-executable file in pre-commit.d is inert (not run)', () => {
    if (!bashOk()) return;
    inProjectRea(0);
    const d = path.join(dir, '.husky', 'pre-commit.d');
    fssync.mkdirSync(d, { recursive: true });
    fssync.writeFileSync(path.join(d, 'README.md'), 'not a hook\n', { mode: 0o644 });
    fssync.chmodSync(path.join(d, 'README.md'), 0o644);
    expect(run()).toBe(0); // no crash, README ignored
  });
});

// Round-18 F2 — common-root (worktree) HALT freezes a local commit, resolved
// entirely in the shell body (no CLI). Self-contained: a real linked worktree.
describe('pre-commit body — worktree HALT freeze (round-18 F2)', () => {
  it('common-root HALT (primary checkout) freezes a commit run from a worktree', async () => {
    if (spawnSync('bash', ['--version']).status !== 0) return;
    const primary = await makeRepo();
    try {
      // A worktree needs a commit to branch from.
      await execFileAsync('git', ['-C', primary, 'commit', '-q', '--allow-empty', '-m', 'init']);
      const wt = `${primary}-wt`;
      await execFileAsync('git', ['-C', primary, 'worktree', 'add', '-q', wt, '-b', 'wt-halt']);
      // Install the (shared) hook via the worktree, then freeze the PRIMARY.
      await installPreCommitHook({ targetDir: wt });
      fssync.mkdirSync(path.join(primary, '.rea'), { recursive: true });
      fssync.writeFileSync(path.join(primary, '.rea', 'HALT'), 'frozen by primary\n');
      // The hook git fires lives in the shared hooks dir.
      const hookPath = (
        await execFileAsync('git', ['-C', wt, 'rev-parse', '--git-path', 'hooks/pre-commit'])
      ).stdout.trim();
      const abs = path.isAbsolute(hookPath) ? hookPath : path.join(wt, hookPath);
      const res = spawnSync('bash', [abs], {
        cwd: wt,
        env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/tmp' },
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(res.status ?? -1).toBe(2);
      expect(res.stderr).toContain('REA HALT');
      fssync.rmSync(wt, { recursive: true, force: true });
    } finally {
      rm(primary);
    }
  });

  // Round-19 F1 — same-repo safety under `--separate-git-dir`. When a
  // separate-git-dir repo keeps its metadata INSIDE an UNRELATED `outer` repo,
  // a linked worktree's `dirname(git-common-dir)` resolves to `outer` — which
  // has its own `.rea`. The OLD dirname-based probe would route the HALT check
  // there and FALSELY freeze on `outer`'s HALT. `git worktree list` only ever
  // lists THIS repo's worktrees, so it can never false-route to `outer`; the
  // probe degenerates to the local worktree (consistent with the TS
  // `resolveCommonRoot`, which also degenerates for this topology).
  it('F1: worktree-list is same-repo-safe — an UNRELATED repo HALT does NOT freeze', async () => {
    if (spawnSync('bash', ['--version']).status !== 0) return;
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-xrepo-')));
    try {
      const outer = path.join(scratch, 'outer');
      const innerMeta = path.join(outer, 'inner.git'); // metadata nested UNDER outer
      const innerPrimary = path.join(scratch, 'inner-primary');
      const innerWt = path.join(scratch, 'inner-wt');

      fssync.mkdirSync(outer, { recursive: true });
      await execFileAsync('git', ['init', '-q', outer]);
      await execFileAsync('git', ['-C', outer, 'config', 'user.email', 't@t']);
      await execFileAsync('git', ['-C', outer, 'config', 'user.name', 't']);
      fssync.mkdirSync(path.join(outer, '.rea'), { recursive: true });
      fssync.writeFileSync(path.join(outer, 'f'), 'x');
      await execFileAsync('git', ['-C', outer, 'add', '-A']);
      await execFileAsync('git', ['-C', outer, 'commit', '-q', '-m', 'outer']);

      fssync.mkdirSync(innerPrimary, { recursive: true });
      await execFileAsync('git', ['init', '-q', `--separate-git-dir=${innerMeta}`, innerPrimary]);
      await execFileAsync('git', ['-C', innerPrimary, 'config', 'user.email', 't@t']);
      await execFileAsync('git', ['-C', innerPrimary, 'config', 'user.name', 't']);
      await execFileAsync('git', ['-C', innerPrimary, 'commit', '-q', '--allow-empty', '-m', 'inner']);
      await execFileAsync('git', ['-C', innerPrimary, 'worktree', 'add', '-q', innerWt, '-b', 'inner-b']);

      // Sanity: dirname(git-common-dir) from the worktree IS `outer` (the trap).
      const cd = (
        await execFileAsync('git', ['-C', innerWt, 'rev-parse', '--git-common-dir'])
      ).stdout.trim();
      expect(await fs.realpath(path.dirname(cd))).toBe(await fs.realpath(outer));

      await installPreCommitHook({ targetDir: innerWt });
      const hookPath = (
        await execFileAsync('git', ['-C', innerWt, 'rev-parse', '--git-path', 'hooks/pre-commit'])
      ).stdout.trim();
      const abs = path.isAbsolute(hookPath) ? hookPath : path.join(innerWt, hookPath);
      const runFromWt = (): number =>
        spawnSync('bash', [abs], {
          cwd: innerWt,
          env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/tmp' },
          encoding: 'utf8',
          timeout: 20_000,
        }).status ?? -1;

      // (a) HALT in the UNRELATED `outer` repo must NOT freeze the inner commit.
      fssync.writeFileSync(path.join(outer, '.rea', 'HALT'), 'foreign freeze\n');
      expect(runFromWt()).toBe(0);

      // (b) A LOCAL worktree HALT still freezes (degenerate common = local).
      fssync.mkdirSync(path.join(innerWt, '.rea'), { recursive: true });
      fssync.writeFileSync(path.join(innerWt, '.rea', 'HALT'), 'local freeze\n');
      expect(runFromWt()).toBe(2);
    } finally {
      rm(scratch);
    }
  });
});

describe('pre-commit installer — active-hooks-path resolution (F1)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeRepo();
  });
  afterEach(() => rm(dir));

  it('vanilla git (no core.hooksPath) installs `.git/hooks/pre-commit`', async () => {
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('install');
    expect(res.written).toBe(path.join(dir, '.git', 'hooks', 'pre-commit'));
    // The .husky path is NOT written in vanilla-git — git would never fire it.
    expect(fssync.existsSync(path.join(dir, '.husky', 'pre-commit'))).toBe(false);
    const onDisk = fssync.readFileSync(res.written as string, 'utf8');
    expect(isReaManagedPreCommit(onDisk)).toBe(true);
    expect((fssync.statSync(res.written as string).mode & 0o111) !== 0).toBe(true);
  });

  it('core.hooksPath=.husky installs `.husky/pre-commit` (unchanged path)', async () => {
    await setHooksPath(dir, '.husky');
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('install');
    expect(res.written).toBe(path.join(dir, '.husky', 'pre-commit'));
    expect(fssync.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  // Round-13 F1 — Husky 9's DEFAULT layout is `core.hooksPath=.husky/_`. git
  // fires the generated stub `.husky/_/pre-commit`, which sources `.husky/_/h`
  // and execs the USER hook `.husky/pre-commit`. The managed hook must land at
  // the USER path, not the `_` stub dir (which husky regenerates + which the
  // installer would classify foreign).
  it('core.hooksPath=.husky/_ (Husky 9 default) installs at the USER path `.husky/pre-commit`', async () => {
    await setHooksPath(dir, '.husky/_');
    const resolved = await resolveTargetHookPath(dir);
    expect(resolved.hookPath).toBe(path.join(dir, '.husky', 'pre-commit'));
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('install');
    expect(res.written).toBe(path.join(dir, '.husky', 'pre-commit'));
    // Nothing written INTO the stub dir.
    expect(fssync.existsSync(path.join(dir, '.husky', '_', 'pre-commit'))).toBe(false);
  });

  it('installs then reclassifies as refresh (idempotent, byte-identical)', async () => {
    await setHooksPath(dir, '.husky');
    const first = await installPreCommitHook({ targetDir: dir });
    expect(first.decision.action).toBe('install');
    const onDisk = fssync.readFileSync(first.written as string, 'utf8');
    const second = await installPreCommitHook({ targetDir: dir });
    expect(second.decision.action).toBe('refresh');
    expect(fssync.readFileSync(second.written as string, 'utf8')).toBe(onDisk);
  });

  it('leaves a foreign pre-commit alone at the active path (skip)', async () => {
    await setHooksPath(dir, '.husky');
    fssync.mkdirSync(path.join(dir, '.husky'), { recursive: true });
    const foreign = '#!/bin/sh\necho custom\n';
    fssync.writeFileSync(path.join(dir, '.husky', 'pre-commit'), foreign);
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('skip');
    expect(fssync.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8')).toBe(foreign);
  });

  it('foreign posture applies to a vanilla-git `.git/hooks/pre-commit` too', async () => {
    const gitHook = path.join(dir, '.git', 'hooks', 'pre-commit');
    fssync.mkdirSync(path.dirname(gitHook), { recursive: true });
    fssync.writeFileSync(gitHook, '#!/bin/sh\nexit 0\n');
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('skip');
  });

  it('resolveTargetHookPath reports configured vs vanilla correctly', async () => {
    const vanilla = await resolveTargetHookPath(dir);
    expect(vanilla.hooksPathConfigured).toBe(false);
    expect(vanilla.hookPath).toBe(path.join(dir, '.git', 'hooks', 'pre-commit'));
    await setHooksPath(dir, '.husky');
    const husky = await resolveTargetHookPath(dir);
    expect(husky.hooksPathConfigured).toBe(true);
    expect(husky.hookPath).toBe(path.join(dir, '.husky', 'pre-commit'));
  });

  it('classifyPreCommit reports install → refresh across the active path', async () => {
    await setHooksPath(dir, '.husky');
    expect((await classifyPreCommit(dir)).action).toBe('install');
    await installPreCommitHook({ targetDir: dir });
    expect((await classifyPreCommit(dir)).action).toBe('refresh');
  });
});

// ── Round-44 F1 — Windows rename-does-not-replace parity ─────────────────────
// A refresh over an EXISTING pre-commit renames a temp file over it. On Windows
// `rename` fails EEXIST/EPERM; the installer must unlink + retry (the same
// fallback writeSettingsAtomic / the pre-push installer carry).
describe('installPreCommitHook — Windows rename fallback (round-44)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeRepo();
    await setHooksPath(dir, '.husky'); // deterministic active path: .husky/pre-commit
  });
  afterEach(() => rm(dir));

  it('a refresh over an existing pre-commit recovers from a rename EEXIST (Windows)', async () => {
    // First install creates the managed hook.
    const first = await installPreCommitHook({ targetDir: dir });
    expect(first.decision.action).toBe('install');
    const hookPath = path.join(dir, '.husky', 'pre-commit');

    // Simulate the Windows rename-EEXIST on the FIRST rename over `pre-commit`;
    // the fallback unlink + retry should succeed on the second.
    const originalRename = fs.rename;
    let calls = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      calls += 1;
      if (calls === 1 && typeof newPath === 'string' && newPath.endsWith('pre-commit')) {
        const e = new Error('simulated EEXIST') as NodeJS.ErrnoException;
        e.code = 'EEXIST';
        throw e;
      }
      return originalRename(oldPath as fssync.PathLike, newPath as fssync.PathLike);
    });

    let second: Awaited<ReturnType<typeof installPreCommitHook>>;
    try {
      second = await installPreCommitHook({ targetDir: dir }); // the refresh
    } finally {
      spy.mockRestore();
    }

    // First rename threw (simulated Windows), the fallback retried and succeeded.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(second.decision.action).toBe('refresh');
    const onDisk = fssync.readFileSync(hookPath, 'utf8');
    expect(isReaManagedPreCommit(onDisk)).toBe(true);
    // The hook is intact + executable; no temp artifact left behind.
    expect((fssync.statSync(hookPath).mode & 0o111) !== 0).toBe(true);
    const leftover = fssync
      .readdirSync(path.join(dir, '.husky'))
      .filter((n) => n.includes('.rea-tmp-'));
    expect(leftover).toEqual([]);
  });

  it('a non-EEXIST rename error is re-thrown (POSIX path unchanged)', async () => {
    await installPreCommitHook({ targetDir: dir }); // create
    const originalRename = fs.rename;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (typeof newPath === 'string' && newPath.endsWith('pre-commit')) {
        const e = new Error('boom') as NodeJS.ErrnoException;
        e.code = 'EACCES';
        throw e;
      }
      return originalRename(oldPath as fssync.PathLike, newPath as fssync.PathLike);
    });
    try {
      await expect(installPreCommitHook({ targetDir: dir })).rejects.toThrow(/boom/);
    } finally {
      spy.mockRestore();
    }
  });
});
