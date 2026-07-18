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
});
