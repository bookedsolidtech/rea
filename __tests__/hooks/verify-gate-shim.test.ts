/**
 * End-to-end tests for the G2 verification shims, THROUGH the shim path
 * (round-13). Round-12's fixes lived in the CLI cores but the cheap relevance
 * SHIMS short-circuited before those cores ran, so the symlink-alias coverage
 * never fired end-to-end. These tests drive `hooks/verify-gate.sh` (editor)
 * and `hooks/verify-gate-bash-gate.sh` (bash) as the harness would — real
 * shim → real CLI → real policy/store — proving:
 *
 *   - editor Write to `tasklog -> .rea/tasks.jsonl` under enforce is BLOCKED
 *     via the shim (the shim resolves the alias and forwards);
 *   - bash `tee tasklog` (alias, no `tasks`/`jsonl` keyword) under enforce is
 *     BLOCKED via the shim (mode-gated relevance forwards it);
 *   - both are byte-identical no-ops (exit 0) under `off`.
 *
 * The shim's CLI sandbox requires the resolved CLI's realpath to live inside
 * CLAUDE_PROJECT_DIR, so we stage a temp "consumer" repo with a REAL copy of
 * `dist/` and a symlinked `node_modules` (deps resolve through it) plus a
 * `package.json` naming `@bookedsolid/rea`. The shim then resolves
 * `<repo>/dist/cli/index.js`, passes the sandbox, and runs the real gate
 * against the temp repo's policy + store.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EDITOR_SHIM = path.join(REPO_ROOT, 'hooks', 'verify-gate.sh');
const BASH_SHIM = path.join(REPO_ROOT, 'hooks', 'verify-gate-bash-gate.sh');

const IS_WIN = process.platform === 'win32';
function bashOk(): boolean {
  return spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
}
const distExists = fs.existsSync(path.join(REPO_ROOT, 'dist', 'cli', 'index.js'));
const ENABLED = !IS_WIN && bashOk() && distExists;

let repo = '';

function writePolicy(mode: 'off' | 'shadow' | 'enforce'): void {
  fs.writeFileSync(
    path.join(repo, '.rea', 'policy.yaml'),
    [
      'version: "0.54.0"',
      'profile: bst-internal',
      'installed_by: test',
      'installed_at: "2026-01-01T00:00:00Z"',
      'autonomy_level: L1',
      'max_autonomy_level: L2',
      'promotion_requires_human_approval: true',
      'blocked_paths: []',
      'artifact_gates:',
      '  g2_verify:',
      `    mode: ${mode}`,
      '',
    ].join('\n'),
  );
}

/** (Re)create the store + the `tasklog` alias pointing at it. */
function seedStoreAndAlias(): void {
  const store = path.join(repo, '.rea', 'tasks.jsonl');
  fs.writeFileSync(store, '');
  const link = path.join(repo, 'tasklog');
  try {
    fs.unlinkSync(link);
  } catch {
    /* not present */
  }
  fs.symlinkSync(store, link);
}

function runShim(shim: string, payload: string): number {
  const res = spawnSync('bash', [shim], {
    cwd: repo,
    env: {
      PATH: process.env['PATH'] ?? '',
      CLAUDE_PROJECT_DIR: repo,
      HOME: process.env['HOME'] ?? '/tmp',
    },
    input: payload,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return res.status ?? -1;
}

/** Run the editor shim with an explicit project dir + cwd (worktree tests). */
function runEditorShimAt(projectDir: string, cwd: string, payload: string): number {
  const res = spawnSync('bash', [EDITOR_SHIM], {
    cwd,
    env: {
      PATH: process.env['PATH'] ?? '',
      CLAUDE_PROJECT_DIR: projectDir,
      HOME: process.env['HOME'] ?? '/tmp',
    },
    input: payload,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return res.status ?? -1;
}

function g2PolicyText(mode: 'off' | 'shadow' | 'enforce'): string {
  return [
    'version: "0.54.0"',
    'profile: bst-internal',
    'installed_by: test',
    'installed_at: "2026-01-01T00:00:00Z"',
    'autonomy_level: L1',
    'max_autonomy_level: L2',
    'promotion_requires_human_approval: true',
    'blocked_paths: []',
    'artifact_gates:',
    '  g2_verify:',
    `    mode: ${mode}`,
    '',
  ].join('\n');
}

const COMPLETED_NO_EVIDENCE = JSON.stringify({
  id: 'T-0001',
  subject: 's',
  active: false,
  status: 'completed',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

beforeAll(() => {
  if (!ENABLED) return;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-vgshim-')));
  fs.mkdirSync(path.join(repo, '.rea'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: '@bookedsolid/rea', version: '0.51.0', type: 'module' }, null, 2),
  );
  // Real dist copy (sandbox needs the CLI realpath inside the project dir).
  fs.cpSync(path.join(REPO_ROOT, 'dist'), path.join(repo, 'dist'), { recursive: true });
  // Symlinked node_modules so the copied CLI's deps resolve.
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)('verify-gate shims — end-to-end through the shim', () => {
  it('editor: Write to `tasklog -> store` under ENFORCE is blocked via the shim', () => {
    writePolicy('enforce');
    seedStoreAndAlias();
    const payload = JSON.stringify({
      tool_name: 'Write',
      cwd: repo,
      tool_input: { file_path: path.join(repo, 'tasklog'), content: COMPLETED_NO_EVIDENCE },
    });
    expect(runShim(EDITOR_SHIM, payload)).toBe(2);
  });

  it('editor: same alias Write under OFF is a no-op (exit 0)', () => {
    writePolicy('off');
    seedStoreAndAlias();
    const payload = JSON.stringify({
      tool_name: 'Write',
      cwd: repo,
      tool_input: { file_path: path.join(repo, 'tasklog'), content: COMPLETED_NO_EVIDENCE },
    });
    expect(runShim(EDITOR_SHIM, payload)).toBe(0);
  });

  it('bash: `tee tasklog` (alias, no keyword) under ENFORCE is blocked via the shim', () => {
    writePolicy('enforce');
    seedStoreAndAlias();
    const payload = JSON.stringify({
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'echo x | tee tasklog' },
    });
    expect(runShim(BASH_SHIM, payload)).toBe(2);
  });

  it('bash: same `tee tasklog` under OFF is a no-op (exit 0)', () => {
    writePolicy('off');
    seedStoreAndAlias();
    const payload = JSON.stringify({
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'echo x | tee tasklog' },
    });
    expect(runShim(BASH_SHIM, payload)).toBe(0);
  });

  it('bash: a benign read reaches no block under enforce (exit 0)', () => {
    writePolicy('enforce');
    seedStoreAndAlias();
    const payload = JSON.stringify({
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'echo hello' },
    });
    expect(runShim(BASH_SHIM, payload)).toBe(0);
  });

  // Round-17 F1 — editing the store from a SUBDIRECTORY via a cwd-relative
  // path. The pre-round-17 shim resolved file_path only against REA_ROOT, so a
  // `../../.rea/tasks.jsonl` from `packages/foo` was gated out before the core.
  it('editor: cwd-relative `../../.rea/tasks.jsonl` from a subdir under ENFORCE is blocked', () => {
    writePolicy('enforce');
    const store = path.join(repo, '.rea', 'tasks.jsonl');
    fs.writeFileSync(store, '');
    const subdir = path.join(repo, 'packages', 'foo');
    fs.mkdirSync(subdir, { recursive: true });
    const payload = JSON.stringify({
      tool_name: 'Write',
      cwd: subdir,
      tool_input: { file_path: '../../.rea/tasks.jsonl', content: COMPLETED_NO_EVIDENCE },
    });
    expect(runShim(EDITOR_SHIM, payload)).toBe(2);
  });

  it('editor: same cwd-relative store write under OFF is a no-op (exit 0)', () => {
    writePolicy('off');
    const store = path.join(repo, '.rea', 'tasks.jsonl');
    fs.writeFileSync(store, '');
    const subdir = path.join(repo, 'packages', 'foo');
    fs.mkdirSync(subdir, { recursive: true });
    const payload = JSON.stringify({
      tool_name: 'Write',
      cwd: subdir,
      tool_input: { file_path: '../../.rea/tasks.jsonl', content: COMPLETED_NO_EVIDENCE },
    });
    expect(runShim(EDITOR_SHIM, payload)).toBe(0);
  });

  // Round-19 F2 — fresh repo: the alias dangles (tasks.jsonl not yet created).
  // The FIRST Write through it must still be blocked (shim `_vg_resolve` and the
  // core `canonicalizePath` both follow a dangling link to its target).
  it('editor: first Write through a DANGLING alias under ENFORCE is blocked via the shim', () => {
    writePolicy('enforce');
    const store = path.join(repo, '.rea', 'tasks.jsonl');
    try {
      fs.unlinkSync(store);
    } catch {
      /* already absent */
    }
    const link = path.join(repo, 'tasklog');
    try {
      fs.unlinkSync(link);
    } catch {
      /* not present */
    }
    fs.symlinkSync(store, link); // dangling — target does not exist yet
    const payload = JSON.stringify({
      tool_name: 'Write',
      cwd: repo,
      tool_input: { file_path: link, content: COMPLETED_NO_EVIDENCE },
    });
    expect(runShim(EDITOR_SHIM, payload)).toBe(2);
  });

  // Round-36 F1 — the shim's relevance pre-gate must also match SIBLING
  // worktree stores, or a no-evidence completion into another stream slips
  // past G2. Cross-repo isolation (a truly foreign repo) must still hold.
  it('editor: from worktree A, a Write to an alias resolving to SIBLING worktree B store → exit 2', () => {
    const git = (cwd: string, ...args: string[]): void => {
      spawnSync('git', args, { cwd, stdio: 'ignore' });
    };
    const primary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-vgwt-')));
    const wtA = `${primary}-A`;
    const wtB = `${primary}-B`;
    const foreign = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-vgforeign-')));
    try {
      spawnSync('git', ['init', '-q', primary], { stdio: 'ignore' });
      git(primary, 'config', 'user.email', 't@t');
      git(primary, 'config', 'user.name', 't');
      git(primary, 'config', 'commit.gpgsign', 'false');
      git(primary, 'commit', '-q', '--allow-empty', '-m', 'init');
      git(primary, 'worktree', 'add', '-q', wtA, '-b', 'stream-a');
      git(primary, 'worktree', 'add', '-q', wtB, '-b', 'stream-b');
      // Stage a sandboxed CLI INSIDE worktree A (= CLAUDE_PROJECT_DIR).
      fs.writeFileSync(
        path.join(wtA, 'package.json'),
        JSON.stringify({ name: '@bookedsolid/rea', version: '0.51.0', type: 'module' }),
      );
      fs.cpSync(path.join(REPO_ROOT, 'dist'), path.join(wtA, 'dist'), { recursive: true });
      fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(wtA, 'node_modules'), 'dir');
      // A enforces G2; B has its own store; foreign is a SEPARATE repo.
      fs.mkdirSync(path.join(wtA, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(wtA, '.rea', 'policy.yaml'), g2PolicyText('enforce'));
      fs.mkdirSync(path.join(wtB, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(wtB, '.rea', 'tasks.jsonl'), '');
      spawnSync('git', ['init', '-q', foreign], { stdio: 'ignore' });
      fs.mkdirSync(path.join(foreign, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(foreign, '.rea', 'tasks.jsonl'), '');

      // (a) Alias in A → SIBLING B's store. Completed-no-evidence → BLOCKED.
      const aliasB = path.join(wtA, 'tasklog');
      fs.symlinkSync(path.join(wtB, '.rea', 'tasks.jsonl'), aliasB);
      const payloadB = JSON.stringify({
        tool_name: 'Write',
        cwd: wtA,
        tool_input: { file_path: aliasB, content: COMPLETED_NO_EVIDENCE },
      });
      expect(runEditorShimAt(wtA, wtA, payloadB)).toBe(2); // sibling governed

      // (b) Alias in A → FOREIGN repo's store (not a worktree of primary) →
      //     NOT governed; the shim's sibling enumeration lists only THIS
      //     repo's worktrees, so cross-repo isolation holds.
      const aliasF = path.join(wtA, 'foreignlog');
      fs.symlinkSync(path.join(foreign, '.rea', 'tasks.jsonl'), aliasF);
      const payloadF = JSON.stringify({
        tool_name: 'Write',
        cwd: wtA,
        tool_input: { file_path: aliasF, content: COMPLETED_NO_EVIDENCE },
      });
      expect(runEditorShimAt(wtA, wtA, payloadF)).toBe(0); // foreign isolated
    } finally {
      for (const d of [wtA, wtB, primary, foreign]) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  });
});

// ── round-53 P1 — CLI-MISSING fail posture is mode-aware (off means off) ─────
// These deliberately DO NOT stage a dist copy: the shim resolves no in-project
// CLI (cli-missing branch), and shim-runtime omits PATH + the temp repo is not
// registry-blessed, so no global CLI resolves either. A FAIL-OPEN shim guarding
// an ACTIVE g2_verify gate must now FAIL CLOSED so a raw write cannot bypass an
// opted-in gate just because the CLI is unbuilt in this checkout.
const CLI_MISSING_ENABLED = !IS_WIN && bashOk();
describe.skipIf(!CLI_MISSING_ENABLED)('verify-gate shims — round-53 P1 CLI-missing fail-closed', () => {
  function mkRepo(policy: string | null): string {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-vg53-')));
    spawnSync('git', ['init', '-q', d], { stdio: 'ignore' });
    fs.mkdirSync(path.join(d, '.rea'), { recursive: true });
    if (policy !== null) fs.writeFileSync(path.join(d, '.rea', 'policy.yaml'), policy);
    return d;
  }
  function runFull(shim: string, repoDir: string, payload: string): { status: number; stderr: string } {
    const res = spawnSync('bash', [shim], {
      cwd: repoDir,
      env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: repoDir, HOME: repoDir },
      input: payload,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: res.status ?? -1, stderr: res.stderr ?? '' };
  }
  const bashPayload = (repoDir: string): string =>
    JSON.stringify({ tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'echo x > .rea/tasks.jsonl' } });
  const storeWrite = (repoDir: string): string =>
    JSON.stringify({
      tool_name: 'Write',
      cwd: repoDir,
      tool_input: { file_path: path.join(repoDir, '.rea', 'tasks.jsonl'), content: 'x' },
    });
  const nonStoreWrite = (repoDir: string): string =>
    JSON.stringify({
      tool_name: 'Write',
      cwd: repoDir,
      tool_input: { file_path: path.join(repoDir, 'src', 'foo.ts'), content: 'x' },
    });

  it('bash-gate: enforce + no CLI → FAIL CLOSED (exit 2 + CONFIG-ERROR)', () => {
    const d = mkRepo(g2PolicyText('enforce'));
    try {
      const r = runFull(BASH_SHIM, d, bashPayload(d));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('CONFIG-ERROR');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('bash-gate: shadow + no CLI → FAIL CLOSED (exit 2)', () => {
    const d = mkRepo(g2PolicyText('shadow'));
    try {
      expect(runFull(BASH_SHIM, d, bashPayload(d)).status).toBe(2);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('bash-gate: nested-inline `artifact_gates: { g2_verify: { mode: enforce } }` + no CLI → FAIL CLOSED', () => {
    const d = mkRepo('artifact_gates: { g2_verify: { mode: enforce } }\n');
    try {
      expect(runFull(BASH_SHIM, d, bashPayload(d)).status).toBe(2);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('bash-gate: off + no CLI → FAIL OPEN (exit 0)', () => {
    const d = mkRepo(g2PolicyText('off'));
    try {
      expect(runFull(BASH_SHIM, d, bashPayload(d)).status).toBe(0);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('bash-gate: absent policy + no CLI → FAIL OPEN (exit 0)', () => {
    const d = mkRepo(null);
    try {
      expect(runFull(BASH_SHIM, d, bashPayload(d)).status).toBe(0);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('editor: enforce + store write + no CLI → FAIL CLOSED (exit 2 + CONFIG-ERROR)', () => {
    const d = mkRepo(g2PolicyText('enforce'));
    try {
      const r = runFull(EDITOR_SHIM, d, storeWrite(d));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('CONFIG-ERROR');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('editor: nested-inline enforce + store write + no CLI → FAIL CLOSED (exit 2)', () => {
    const d = mkRepo('artifact_gates: { g2_verify: { mode: enforce } }\n');
    try {
      expect(runFull(EDITOR_SHIM, d, storeWrite(d)).status).toBe(2);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('editor: off + store write + no CLI → FAIL OPEN (exit 0)', () => {
    const d = mkRepo(g2PolicyText('off'));
    try {
      expect(runFull(EDITOR_SHIM, d, storeWrite(d)).status).toBe(0);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('editor: enforce + NON-store write + no CLI → FAIL OPEN (not relevant, exit 0)', () => {
    const d = mkRepo(g2PolicyText('enforce'));
    try {
      expect(runFull(EDITOR_SHIM, d, nonStoreWrite(d)).status).toBe(0);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
