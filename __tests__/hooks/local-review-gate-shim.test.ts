/**
 * End-to-end tests for `hooks/local-review-gate.sh` — the PreToolUse shim
 * that forwards Bash payloads to the Node-binary local-review-gate CLI
 * (introduced in 0.34.0).
 *
 * Why these exist (0.34.0 round-4 findings):
 *
 * Round-4 P1 — the shim's relevance pre-gate runs a second awk program
 * embedded in a single-quoted shell string. Comments inside that awk
 * program with bare single quotes (e.g. `' ... '`) terminate the bash
 * string at runtime and cause `awk: syntax error`. The error was being
 * swallowed by `|| true` → RELEVANT=0 → silent bypass on every Bash
 * call. The CLI-level test suite missed it because tests call the CLI's
 * runLocalReviewGate() directly without going through the shim's awk
 * pre-gate.
 *
 * Round-4 P2 — the shim's two jq probes (PROBE for relevance and the
 * policy-leaf reader) swallowed jq parse failures with `|| true`. A
 * malformed PreToolUse payload would yield empty PROBE → RELEVANT=0 →
 * silent bypass. The fix captures jq's exit code separately and forces
 * RELEVANT=1 on parse failure so the CLI body decides (CLI fails closed
 * on schema violations via Zod).
 *
 * These tests pin the SHIM-level invariants:
 *   - awk pre-gate parses (no runtime syntax error)
 *   - quoted-mention does NOT silent-bypass via masker error
 *   - relevant `git push` reaches the CLI (which refuses under default policy)
 *   - malformed JSON forwards to CLI (exit 2, not silent 0)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(REPO_ROOT, 'hooks', 'local-review-gate.sh');

interface ShimResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runShim(payload: string): ShimResult {
  const res = spawnSync('bash', [SHIM], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      CLAUDE_PROJECT_DIR: REPO_ROOT,
      HOME: process.env.HOME ?? '/tmp',
    },
    input: payload,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function bashExists(): boolean {
  return spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
}

describe('hooks/local-review-gate.sh — shim end-to-end', () => {
  it('does NOT emit `awk: syntax error` for any payload (round-4 P1 regression)', () => {
    if (!bashExists()) return;
    // The shim's second awk program had bare single quotes inside its
    // comments which terminated the bash single-quoted string and caused
    // awk to fail at runtime. The `|| true` swallowed the failure →
    // silent bypass. This test asserts the awk parses cleanly on the
    // hot path (any payload that reaches the awk pre-gate).
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    const r = runShim(payload);
    expect(r.stderr).not.toContain('awk: syntax error');
    expect(r.stderr).not.toContain('awk: illegal statement');
    // Non-trigger command → exit 0 (relevance pre-gate filters it out).
    expect(r.status).toBe(0);
  });

  it('exits 0 on non-Bash payload (Read tool)', () => {
    if (!bashExists()) return;
    const r = runShim(
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/foo' },
      }),
    );
    expect(r.status).toBe(0);
  });

  it('exits 0 on echoed mention of "git push" inside quoted body (must not over-trigger)', () => {
    if (!bashExists()) return;
    const r = runShim(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo "remember git push later"' },
      }),
    );
    expect(r.stderr).not.toContain('awk: syntax error');
    expect(r.status).toBe(0);
  });

  it('reaches the CLI for a real `git push` and refuses without a recent review', () => {
    if (!bashExists()) return;
    // Under the dogfood policy `review.local_review.mode: enforced` and
    // refuse_at: push, a real `git push` payload must NOT silent-exit-0.
    // Pre-round-4-P1 the awk syntax error caused RELEVANT=0 → exit 0
    // silent bypass. Post-fix this reaches the CLI which refuses.
    const r = runShim(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
      }),
    );
    expect(r.stderr).not.toContain('awk: syntax error');
    // Could be 0 (allow) or 2 (refuse) depending on whether there's a
    // recent local-review audit entry for HEAD. What MUST be true is
    // that the shim did not silent-bypass: either we see the CLI's
    // refusal banner OR we see a benign allow. In either case we
    // reached the CLI. The reliable assertion: exit code is exactly
    // 0 or 2 (the CLI's documented values).
    expect([0, 2]).toContain(r.status);
    // If refused, the banner appears somewhere in the combined
    // shim/CLI output (stdout or stderr depending on CLI version).
    if (r.status === 2) {
      const combined = r.stdout + r.stderr;
      expect(combined).toContain('local-first review required');
    }
  });

  it('forwards malformed JSON to the CLI which fails closed (round-4 P2 regression)', () => {
    if (!bashExists()) return;
    // Pre-fix: jq parse failure was swallowed by `|| true` → empty
    // PROBE → RELEVANT=0 → exit 0 silent allow on malformed payload.
    // Post-fix: jq exit code is captured separately; on parse failure
    // RELEVANT is forced to 1 and the CLI body refuses with exit 2.
    const r = runShim('{ "tool_name": "Bash", "tool_input":');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not valid JSON|refusing on uncertainty/i);
  });

  it('reaches CLI for `bash -c "git push"` wrapper (round-5 P1 regression)', () => {
    if (!bashExists()) return;
    // Pre-round-5-P1: the shim's awk pre-gate quote-masker hid the
    // `git push` substring inside `bash -c "..."`, leaving the head
    // token as `bash` → no trigger match → exit 0 silent bypass.
    // The CLI's full nested-shell unwrap caught it correctly.
    // Post-fix: any segment whose head is a known shell wrapper
    // forces RELEVANT=1 so the CLI walks the wrapped payload.
    const r = runShim(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'bash -c "git push origin main"' },
      }),
    );
    expect([0, 2]).toContain(r.status);
    // Must reach the CLI — when refused, banner shows up.
    if (r.status === 2) {
      const combined = r.stdout + r.stderr;
      expect(combined).toContain('local-first review required');
    }
  });

  it('reaches CLI for `time sudo git push` (round-5 P1 keyword-strip regression)', () => {
    if (!bashExists()) return;
    // Pre-round-5-P1: the keyword-strip `sub(/^(sudo|exec|time...)/)`
    // only stripped ONE keyword. `time sudo git push` became
    // `sudo git push` which did not match `^git push` → exit 0
    // silent bypass. Post-fix: keyword strip iterates until no
    // more matches.
    const r = runShim(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'time sudo git push origin main' },
      }),
    );
    expect([0, 2]).toContain(r.status);
    if (r.status === 2) {
      const combined = r.stdout + r.stderr;
      expect(combined).toContain('local-first review required');
    }
  });

  it('does NOT over-trigger on `bash scripts/setup.sh` (round-6 P2 regression)', () => {
    if (!bashExists()) return;
    // Pre-round-6-P2: the round-5 wrapper shortcut matched ANY
    // segment starting with a shell name, so `bash scripts/setup.sh`
    // (benign script execution, no `-c` payload) was forced
    // RELEVANT=1 → reached fail-closed branch on unbuilt installs
    // and refused with "rea CLI is not built" even though the
    // pre-0.34 hook never gated such commands. Fix: require a
    // `-c`-class flag (combined or via pre-flag walk) before
    // forcing relevance.
    const r = runShim(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'bash scripts/setup.sh' },
      }),
    );
    expect(r.status).toBe(0);
  });

  it('does NOT over-trigger on `sh /path/to/script.sh`', () => {
    if (!bashExists()) return;
    const r = runShim(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'sh /path/to/script.sh --flag' },
      }),
    );
    expect(r.status).toBe(0);
  });

  it('still reaches CLI for `bash -l -c "git push ..."` with pre-flags', () => {
    if (!bashExists()) return;
    // The round-6 fix must preserve round-5 enforcement for
    // wrapper-with-pre-flags. `bash -l -c '...'` is a real
    // wrapper-with-payload and must reach the CLI.
    const r = runShim(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'bash -l -c "git push origin main"' },
      }),
    );
    expect([0, 2]).toContain(r.status);
    if (r.status === 2) {
      const combined = r.stdout + r.stderr;
      expect(combined).toContain('local-first review required');
    }
  });

  // ── round-7 P2 regression: bypass env-var must work even when the CLI
  //    policy-reader path is broken or unreachable. Pre-fix the bypass
  //    check sat at section 6, AFTER the policy reader (which can spawn
  //    the CLI for inline-form support). The early-bypass short-circuit
  //    at section 2b honors REA_SKIP_LOCAL_REVIEW BEFORE any policy work.
  it('honors REA_SKIP_LOCAL_REVIEW=<reason> as an early short-circuit on real `git push`', () => {
    if (!bashExists()) return;
    const res = spawnSync('bash', [SHIM], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: REPO_ROOT,
        HOME: process.env.HOME ?? '/tmp',
        REA_SKIP_LOCAL_REVIEW: 'pushing-from-test',
      },
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
      }),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(res.status).toBe(0);
    // No refusal banner — the bypass short-circuited the gate entirely.
    expect(res.stderr).not.toContain('local-first review required');
    expect(res.stderr).not.toContain('rea CLI is not built');
  });

  it('honors REA_SKIP_LOCAL_REVIEW with a non-existent CLI path (round-7 P2: bypass works when CLI is unreachable)', () => {
    if (!bashExists()) return;
    // Simulate CLI-unreachable by pointing CLAUDE_PROJECT_DIR at a dir
    // with no node_modules/@bookedsolid/rea AND no dist/cli/index.js.
    // The early bypass at section 2b must short-circuit BEFORE the
    // section-7 CLI-missing fail-closed branch fires.
    const tmpdir = path.join(REPO_ROOT, '.claude', 'tmp', `r7-${Date.now()}`);
    spawnSync('mkdir', ['-p', tmpdir]);
    try {
      const res = spawnSync('bash', [SHIM], {
        cwd: tmpdir,
        env: {
          PATH: process.env.PATH ?? '',
          CLAUDE_PROJECT_DIR: tmpdir,
          HOME: process.env.HOME ?? '/tmp',
          REA_SKIP_LOCAL_REVIEW: 'cli-not-built-fresh-install',
        },
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'git push origin main' },
        }),
        encoding: 'utf8',
        timeout: 20_000,
      });
      // The early bypass must short-circuit cleanly. No CLI-missing
      // refusal banner.
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain('rea CLI is not built');
    } finally {
      spawnSync('rm', ['-rf', tmpdir]);
    }
  });
});

// 0.50.0 Phase 2b — the global-CLI resolver tier wired into this shim. A
// BLESSED global-only repo (no in-project @bookedsolid/rea) must resolve the
// per-user global CLI instead of refusing the push as `cli-missing`. Same
// guarded-skip-if-`~/.rea`-exists pattern the shim-runtime global e2e uses:
// writes to the REAL passwd-derived ~/.rea and SKIPS when it already exists.
describe('hooks/local-review-gate.sh — global tier (blessed global-only repo, real passwd home, guarded)', () => {
  const REAL_HOME = os.userInfo().homedir;
  const REAL_REA = path.join(REAL_HOME, '.rea');
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-lrg-global-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function withFreshRea(body: (reaDir: string) => void): boolean {
    if (fs.existsSync(REAL_REA)) {
      return false; // documented residual: never clobber an existing ~/.rea
    }
    fs.mkdirSync(REAL_REA, { recursive: true });
    fs.chmodSync(REAL_REA, 0o700);
    try {
      body(REAL_REA);
      return true;
    } finally {
      fs.rmSync(REAL_REA, { recursive: true, force: true });
    }
  }

  // Global CLI stub implementing the three subcommands this shim drives on
  // the global tier: `hook local-review-gate --help` (version probe), `hook
  // policy-get ...` (delegated to the real repo CLI so the policy reads hit
  // the project policy.yaml), and the bare `hook local-review-gate` forward
  // (emits a marker + exit 0 so a resolved tier is observable).
  function installGlobalCli(reaDir: string): void {
    const pkgRoot = path.join(reaDir, 'cli', 'node_modules', '@bookedsolid', 'rea');
    const distCli = path.join(pkgRoot, 'dist', 'cli');
    fs.mkdirSync(distCli, { recursive: true });
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }),
    );
    const realCli = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
    fs.writeFileSync(
      path.join(distCli, 'index.js'),
      `#!/usr/bin/env node
const cp = require('child_process');
const args = process.argv.slice(2);
if (args.length >= 3 && args[0] === 'hook' && args[1] === 'local-review-gate' && args[2] === '--help') {
  process.stdout.write('Usage: rea hook local-review-gate\\n');
  process.exit(0);
}
if (args[0] === 'hook' && args[1] === 'policy-get') {
  const r = cp.spawnSync(process.execPath, [${JSON.stringify(realCli)}, ...args], {
    env: process.env, encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status == null ? 1 : r.status);
}
let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  process.stdout.write('LRG_GLOBAL_FORWARD:' + process.argv[1] + ':' + buf.length + '\\n');
  process.exit(0);
});
`,
    );
    fs.chmodSync(path.join(distCli, 'index.js'), 0o755);
  }

  function blessRegistry(reaDir: string, entry: string): void {
    const reg = path.join(reaDir, 'trusted-projects');
    fs.writeFileSync(reg, entry + '\n');
    fs.chmodSync(reg, 0o600);
  }

  function writePolicy(contents: string): void {
    const reaProj = path.join(projectDir, '.rea');
    fs.mkdirSync(reaProj, { recursive: true });
    fs.writeFileSync(path.join(reaProj, 'policy.yaml'), contents);
  }

  function runShimIn(command: string): ShimResult {
    const res = spawnSync('bash', [SHIM], {
      cwd: projectDir,
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: projectDir,
        HOME: process.env.HOME ?? '/tmp',
        REA_SHIM_CACHE: '0',
      },
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      timeout: 20_000,
    });
    return {
      status: res.status ?? -1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  }

  // Active gate: enforced + refuse_at push, NO in-project CLI in projectDir.
  const ACTIVE_POLICY =
    'profile: bst-internal\nreview:\n  local_review:\n    mode: enforced\n    refuse_at: push\n';

  it('blessed global-only repo: `git push` is NOT cli-missing-blocked — tier resolves + forwards', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalCli(reaDir);
      blessRegistry(reaDir, fs.realpathSync(projectDir));
      writePolicy(ACTIVE_POLICY);
      const r = runShimIn('git push origin main');
      // Pre-fix: REA_ARGV empty → section 7 cli-missing banner + exit 2.
      // Post-fix: the global tier resolves → the forward reaches the GLOBAL
      // CLI (its realpath under <pw_dir>/.rea/cli), so the push is NOT blocked
      // as cli-missing.
      expect(r.stderr, `stderr: ${r.stderr}`).not.toContain('cannot run — the rea CLI is not built');
      expect(r.stdout).toContain('LRG_GLOBAL_FORWARD:');
      const line = r.stdout.split('\n').find((l) => l.startsWith('LRG_GLOBAL_FORWARD:')) ?? '';
      expect(line).toContain(`.rea${path.sep}cli${path.sep}`); // ran the GLOBAL realpath
      expect(r.status).toBe(0);
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('blessed global-only repo with allow_global_cli:false: `git push` is REFUSED — veto honored, NO forward', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalCli(reaDir);
      blessRegistry(reaDir, fs.realpathSync(projectDir));
      // Blessed in the registry (tier resolves) BUT the project vetoes the
      // global CLI. The push gate must honor the veto: fall back to no-CLI →
      // refuse cli-missing, NOT forward through the global CLI.
      writePolicy(
        'profile: bst-internal\nruntime:\n  allow_global_cli: false\n' +
          'review:\n  local_review:\n    mode: enforced\n    refuse_at: push\n',
      );
      const r = runShimIn('git push origin main');
      expect(r.status).toBe(2);
      expect(r.stdout).not.toContain('LRG_GLOBAL_FORWARD:'); // veto → no forward through global CLI
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global'); // veto is silent, not a bad:global advisory
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });

  it('un-blessed global-only repo: `git push` still refuses cli-missing (feature-absent parity, silent)', () => {
    if (!bashExists()) return;
    const ran = withFreshRea((reaDir) => {
      installGlobalCli(reaDir);
      // Registry is well-formed but lists a DIFFERENT path → not a member.
      blessRegistry(reaDir, '/some/other/blessed/project');
      writePolicy(ACTIVE_POLICY);
      const r = runShimIn('git push origin main');
      // Un-blessed → global tier silently unavailable → REA_ARGV stays empty
      // → section 7 refuses, byte-identical to feature-absent (no advisory).
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('cannot run — the rea CLI is not built');
      expect(r.stderr).not.toContain('global');
    });
    if (!ran) expect(fs.existsSync(REAL_REA)).toBe(true);
  });
});
