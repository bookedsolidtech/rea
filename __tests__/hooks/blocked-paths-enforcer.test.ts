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
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-blocked-paths-')));
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
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-blocked-paths-tr-')));
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

  it('blocks backslash-separated paths matching a blocked entry (0.15.0 fix)', () => {
    if (!jqExists()) return;
    // Pre-0.15.0: `.github\workflows\release.yml` reaches `.github/workflows/release.yml`
    // on Windows / Git Bash but didn't normalize to forward slashes, so the
    // literal-match against `.github/workflows/` (which IS in the policy)
    // failed and the hook exited 0. settings-protection.sh had this fix
    // since 0.10.x; blocked-paths-enforcer was the gap.
    const target = `${dir}/.github\\workflows\\release.yml`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/BLOCKED PATH/);
  });

  it('blocks percent-encoded backslash traversal (%5C)', () => {
    if (!jqExists()) return;
    const target = `${dir}/.github%5Cworkflows%5Crelease.yml`;
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

/**
 * 0.29.0 — sibling class to `..` traversal. `normalize_path` strips the
 * LEADING `./` but deliberately does not collapse interior `/./` segments
 * (collapsing them would corrupt `..` reasoning). That leaves a bypass:
 * `foo/./CODEOWNERS` resolves on disk to `foo/CODEOWNERS`, but the
 * literal/prefix-match loops compare against the un-collapsed string and
 * miss `CODEOWNERS`. The conservative closure (per Jake 2026-05-12)
 * treats every interior `/./` exactly like `..`.
 *
 * Corpus designed by pairing shell-scripting-specialist + adversarial-test-
 * specialist on the sibling-shape sweep methodology: enumerate every
 * encoding + composition that produces an interior single-dot segment.
 */
describe('blocked-paths-enforcer.sh — interior dot-segment rejection (0.29.0 helix-/./-class)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-blocked-paths-dot-')));
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_WITH_CODEOWNERS);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects foo/./CODEOWNERS (interior single-dot segment)', () => {
    if (!jqExists()) return;
    // Pre-0.29.0: this would compare `foo/./CODEOWNERS` against the literal
    // `CODEOWNERS` entry, fail to match, and exit 0 — the downstream Write
    // tool would then resolve `/.` and write CODEOWNERS anyway. Post-fix:
    // §5a-bis interior-dot-reject blocks at exit 2.
    const target = `${dir}/foo/./CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects ./CODEOWNERS only when interior (NOT a leading-./ benign case)', () => {
    if (!jqExists()) return;
    // Leading `./` is stripped by normalize_path — `.//CODEOWNERS` is the
    // operative shape because the slash after `./` survives. Verify the
    // hook still blocks via the LITERAL-match path (not the dot-segment
    // guard) since `normalize_path` collapses the leading `./` and the
    // path becomes a plain `/CODEOWNERS`-style match.
    const target = `${dir}/./CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    // Either reason is acceptable here — both close the bypass.
    expect(res.stderr).toMatch(/BLOCKED PATH|interior dot-segment/);
  });

  it('rejects repeated interior dot segments (foo/././CODEOWNERS)', () => {
    if (!jqExists()) return;
    const target = `${dir}/foo/././CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects .//.-class (interior dot followed by extra slash)', () => {
    if (!jqExists()) return;
    // `foo/.//CODEOWNERS` — `/./ ` is interior; the double-slash is
    // independent. The case-pattern `*/./*` matches the `/./` substring
    // regardless of trailing `/`.
    const target = `${dir}/foo/.//CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects URL-encoded interior dot segment (foo/%2E/CODEOWNERS)', () => {
    if (!jqExists()) return;
    // `normalize_path` URL-decodes `%2E` to `.` BEFORE the §5a-bis check,
    // so the normalized form becomes `foo/./CODEOWNERS` and the guard
    // fires. The raw-form encoded guard (`*%2E/*`) is a defense-in-depth
    // companion that triggers even if URL-decoding ever drops the entry.
    const target = `${dir}/foo/%2E/CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects URL-encoded interior dot-slash (foo/.%2FCODEOWNERS)', () => {
    if (!jqExists()) return;
    // `.%2F` decodes to `./` mid-path. After URL-decode + leading-./
    // strip, the normalized form contains `/./` interior.
    const target = `${dir}/foo/.%2FCODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects mixed-case URL-encoded interior dot (foo/%2e/CODEOWNERS)', () => {
    if (!jqExists()) return;
    const target = `${dir}/foo/%2e/CODEOWNERS`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects interior dot under a directory prefix (.github/./workflows/release.yml)', () => {
    if (!jqExists()) return;
    // `.github/workflows/` is the policy entry. Without the §5a-bis guard,
    // `.github/./workflows/release.yml` would compare against `.github/workflows/`
    // as a prefix-match (which still works because the prefix is literal
    // `.github/`), but a more constructed case like below would slip:
    // `.github/./workflows/./release.yml`. Pin both shapes.
    const target = `${dir}/.github/./workflows/release.yml`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects interior dot in .env target (foo/./.env)', () => {
    if (!jqExists()) return;
    const target = `${dir}/foo/./.env`;
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('allows benign paths that contain "." as part of a filename', () => {
    if (!jqExists()) return;
    // `foo.bar/baz.ts` and `foo.` are NOT interior dot segments —
    // `.` is a literal substring of the filename. The case-pattern
    // `*/./*` anchors on the surrounding slashes.
    const target = path.join(dir, 'src', 'foo.bar', 'baz.ts');
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });

  it('allows a leading "./" without interior segments (canonical relative)', () => {
    if (!jqExists()) return;
    // Pure leading `./` is stripped by normalize_path before §5a-bis runs.
    // Result: an unrelated file under src/ is allowed.
    const target = `${dir}/./src/foo.ts`;
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });

  it('allows percent-encoded leading "./" (codex round 1 P2-1 regression)', () => {
    if (!jqExists()) return;
    // %2E%2F decodes to `./` in normalize_path. The leading-strip loop
    // removes it. Resulting NORMALIZED form is `src/foo.ts` — no
    // interior `/./` segment. A pre-fix raw-form encoded guard would
    // have wrongly flagged this as a dot-segment bypass. Pin the fix.
    const target = `${dir}/%2E%2Fsrc/foo.ts`;
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/interior dot-segment rejected/);
  });

  it('allows percent-encoded leading ".%2F" (sibling encoded form)', () => {
    if (!jqExists()) return;
    // `.%2F` decodes to `./`; same logic as the above test.
    const target = `${dir}/.%2Fsrc/foo.ts`;
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/interior dot-segment rejected/);
  });
});

describe('blocked-paths-enforcer.sh — agent-writable allowlist (regression)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-blocked-paths-aw-')));
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
