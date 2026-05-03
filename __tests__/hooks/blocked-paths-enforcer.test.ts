/**
 * Tests for `hooks/blocked-paths-enforcer.sh` — the PreToolUse hook that
 * enforces `policy.review.blocked_paths` against agent Write/Edit calls.
 *
 * 0.14.0 iron-gate fix: prior versions only ran the policy literal-match
 * after `normalize_path()` stripped the project root and URL-decoded a
 * fixed character set. `..` segments were untouched, so a path like
 * `foo/../CODEOWNERS` would NOT match the literal `CODEOWNERS` entry —
 * the loop compared `foo/../CODEOWNERS` against `CODEOWNERS` and found
 * no match. The downstream Write tool would then resolve the traversal
 * and write the file anyway, defeating the gate.
 *
 * These tests pin the new §5a path-traversal rejection alongside the
 * literal-match and directory-prefix paths that must continue to work.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'blocked-paths-enforcer.sh');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(dir: string, filePath: string): HookResult {
  const payload = JSON.stringify({ tool_input: { file_path: filePath } });
  const res = spawnSync('bash', [HOOK_SRC], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: dir },
    input: payload,
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function jqExists(): boolean {
  return spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
}

const POLICY_WITH_CODEOWNERS = `
profile: test
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
blocked_paths:
  - "CODEOWNERS"
  - ".github/workflows/"
  - ".env"
`;

describe('blocked-paths-enforcer.sh — literal match (baseline behavior)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-blocked-paths-')),
    );
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_WITH_CODEOWNERS);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('blocks a direct write to CODEOWNERS', () => {
    if (!jqExists()) return;
    const target = path.join(dir, 'CODEOWNERS');
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/BLOCKED PATH/);
  });

  it('blocks a write under .github/workflows/', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.github', 'workflows', 'release.yml');
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
  });

  it('allows an unrelated write', () => {
    if (!jqExists()) return;
    const target = path.join(dir, 'src', 'foo.ts');
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });
});

describe('blocked-paths-enforcer.sh — path-traversal rejection (0.14.0 iron-gate fix)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-blocked-paths-tr-')),
    );
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_WITH_CODEOWNERS);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects foo/../CODEOWNERS (the documented traversal bypass)', () => {
    if (!jqExists()) return;
    // Pre-fix: this would compare `foo/../CODEOWNERS` against the literal
    // `CODEOWNERS` blocked_paths entry, fail to match, and exit 0 — the
    // downstream Write tool would then resolve the traversal and write
    // CODEOWNERS anyway. Post-fix: §5a traversal-reject blocks at exit 2.
    // Raw-string concat (NOT path.join, which canonicalizes the traversal
    // before the hook ever sees it).
    const target = `${dir}/foo/../CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/path traversal rejected/);
  });

  it('rejects ../CODEOWNERS (parent-relative traversal)', () => {
    if (!jqExists()) return;
    const target = `${dir}/sub/../CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/path traversal rejected/);
  });

  it('rejects deeply nested traversal (.github/workflows/../../foo)', () => {
    if (!jqExists()) return;
    const target = `${dir}/.github/workflows/../../sensitive`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/path traversal rejected/);
  });

  it('rejects URL-encoded traversal (%2E%2E/CODEOWNERS)', () => {
    if (!jqExists()) return;
    const target = `${dir}/sub/%2E%2E/CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/path traversal rejected/);
  });

  it('rejects mixed-case URL-encoded traversal (%2e%2e/CODEOWNERS)', () => {
    if (!jqExists()) return;
    const target = `${dir}/sub/%2e%2e/CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
  });

  it('allows paths that contain ".." as part of a filename (not a segment)', () => {
    if (!jqExists()) return;
    // `foo..bar/baz.ts` and `foo..` are NOT traversal — `..` is a literal
    // substring of the filename. The matcher anchors on `/../` to avoid
    // false positives.
    const target = path.join(dir, 'src', 'foo..bar', 'baz.ts');
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });

  it('allows a single dot directory ("./foo")', () => {
    if (!jqExists()) return;
    // `normalize_path()` strips a leading `./`. The remaining path should
    // be allowed if not in blocked_paths.
    const target = path.join(dir, '.', 'src', 'foo.ts');
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });
});

describe('blocked-paths-enforcer.sh — agent-writable allowlist (regression)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-blocked-paths-aw-')),
    );
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    // Block .rea/ so we can verify the allowlist exemptions work.
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      `
profile: test
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
blocked_paths:
  - ".rea/"
`,
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('allows .rea/tasks.jsonl despite .rea/ being in blocked_paths', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.rea', 'tasks.jsonl');
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });

  it('blocks .rea/policy.yaml (not in allowlist)', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.rea', 'policy.yaml');
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
  });

  it('still rejects .rea/tasks.jsonl when accessed via traversal', () => {
    if (!jqExists()) return;
    // Defense-in-depth: even an allowlisted path should not be reachable
    // via traversal. `..` rejection runs BEFORE the allowlist check.
    const target = `${dir}/sub/../.rea/tasks.jsonl`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/path traversal rejected/);
  });
});
