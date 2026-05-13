/**
 * Defect I (rea#76) regression tests — REA_HOOK_PATCH_SESSION escape hatch.
 *
 * Background: settings-protection.sh blanket-blocked edits under
 * .claude/hooks/ and hooks/. That is correct as a default (agents must not
 * silently mutate safety infrastructure) but it left no documented path for
 * applying upstream-sourced CodeRabbit/Codex findings on hook scripts during
 * a consumer session. The only workaround was to escape out to `!`-bash
 * which dodged every audit surface.
 *
 * Fix: when REA_HOOK_PATCH_SESSION=<reason> is set, the hook allows edits
 * under .claude/hooks/ and hooks/ FOR THAT SESSION only. Every allowed edit
 * emits a hooks.patch.session audit record. Other protected paths
 * (.rea/policy.yaml, .rea/HALT, .claude/settings.json) remain locked —
 * this is a hook-maintenance escape, not a policy-editing one.
 *
 * These tests drive the real shell hook against temp dirs.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'settings-protection.sh');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface Env {
  [key: string]: string | undefined;
}

function runHook(dir: string, filePath: string, env: Env = {}): HookResult {
  const payload = JSON.stringify({ tool_input: { file_path: filePath } });
  const res = spawnSync('bash', [HOOK_SRC], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      ...env,
      CLAUDE_PROJECT_DIR: dir,
    },
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

// Shared helper — symlinks REPO_ROOT/dist into the test temp dir so the
// hook's `${REA_ROOT}/dist/audit/append.js` import succeeds. Returns true on
// success, false if dist/ is not built (caller should skip).
async function symlinkDist(dir: string): Promise<boolean> {
  const repoDist = path.join(REPO_ROOT, 'dist');
  try {
    await fs.access(path.join(repoDist, 'audit', 'append.js'));
  } catch {
    return false;
  }
  await fs.symlink(repoDist, path.join(dir, 'dist'), 'dir');
  return true;
}

describe('settings-protection.sh — REA_HOOK_PATCH_SESSION env var (Defect I)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-patch-session-')));
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.mkdir(path.join(dir, '.claude', 'hooks'), { recursive: true });
    await fs.mkdir(path.join(dir, 'hooks'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('BASELINE: blocks edits to .claude/hooks/* when env var is unset', async () => {
    if (!jqExists()) return;

    const target = path.join(dir, '.claude', 'hooks', 'custom-hook.sh');
    await fs.writeFile(target, '#!/bin/bash\necho hi\n');

    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });

  it('allows edits to .claude/hooks/* when REA_HOOK_PATCH_SESSION is set', async () => {
    if (!jqExists()) return;
    if (!(await symlinkDist(dir))) return;

    const target = path.join(dir, '.claude', 'hooks', 'custom-hook.sh');
    await fs.writeFile(target, '#!/bin/bash\necho hi\n');

    const res = runHook(dir, target, {
      REA_HOOK_PATCH_SESSION: 'applying CodeRabbit finding from PR #1234',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/REA_HOOK_PATCH_SESSION/);
    expect(res.stderr).toMatch(/applying CodeRabbit finding/);
  });

  it('hooks/ (source-of-truth) is editable without env var — only runtime .claude/hooks/ is patch-session-scoped', async () => {
    if (!jqExists()) return;

    const target = path.join(dir, 'hooks', 'example.sh');
    await fs.writeFile(target, '#!/bin/bash\necho hi\n');

    // No env var set — still allowed because hooks/ is source-of-truth,
    // not a runtime attack surface. rea init copies hooks/ → .claude/hooks/
    // so an edit to hooks/ only takes effect after rea init.
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });

  it('still blocks .rea/policy.yaml even with env var set (not a policy-editing escape)', async () => {
    if (!jqExists()) return;

    const target = path.join(dir, '.rea', 'policy.yaml');
    await fs.writeFile(target, 'profile: test\n');

    const res = runHook(dir, target, {
      REA_HOOK_PATCH_SESSION: 'trying to edit policy',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });

  it('still blocks .claude/settings.json even with env var set', async () => {
    if (!jqExists()) return;

    const target = path.join(dir, '.claude', 'settings.json');
    await fs.writeFile(target, '{}\n');

    const res = runHook(dir, target, {
      REA_HOOK_PATCH_SESSION: 'trying to edit settings',
    });
    expect(res.status).toBe(2);
  });

  it('still blocks .rea/HALT even with env var set', async () => {
    if (!jqExists()) return;

    const target = path.join(dir, '.rea', 'HALT');
    await fs.writeFile(target, 'reason\n');

    const res = runHook(dir, target, {
      REA_HOOK_PATCH_SESSION: 'trying to edit HALT',
    });
    expect(res.status).toBe(2);
  });

  it('empty env var value does NOT activate the bypass', async () => {
    if (!jqExists()) return;

    const target = path.join(dir, '.claude', 'hooks', 'custom.sh');
    await fs.writeFile(target, '#!/bin/bash\n');

    const res = runHook(dir, target, { REA_HOOK_PATCH_SESSION: '' });
    expect(res.status).toBe(2);
  });

  it('writes a hooks.patch.session audit record on each allowed edit', async () => {
    if (!jqExists()) return;
    if (!(await symlinkDist(dir))) return;

    const target = path.join(dir, '.claude', 'hooks', 'custom.sh');
    await fs.writeFile(target, '#!/bin/bash\noriginal\n');
    const auditFile = path.join(dir, '.rea', 'audit.jsonl');

    const res = runHook(dir, target, {
      REA_HOOK_PATCH_SESSION: 'PR #1234 CodeRabbit',
    });
    expect(res.status).toBe(0);

    const raw = await fs.readFile(auditFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as {
      tool_name: string;
      server_name: string;
      status: string;
      metadata: {
        reason: string;
        file: string;
        sha_before: string;
        actor: { name: string; email: string };
        pid: number;
        ppid: number;
      };
      hash: string;
      prev_hash: string;
    };
    expect(rec.tool_name).toBe('hooks.patch.session');
    expect(rec.server_name).toBe('rea');
    expect(rec.status).toBe('allowed');
    expect(rec.metadata.reason).toBe('PR #1234 CodeRabbit');
    expect(rec.metadata.file).toBe('.claude/hooks/custom.sh');
    expect(rec.metadata.sha_before).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof rec.metadata.pid).toBe('number');
    expect(typeof rec.metadata.ppid).toBe('number');
    // Hash-chain integrity: the TS append MUST populate hash + prev_hash.
    // This is the guarantee Codex's Finding 1 called out.
    expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.prev_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when neither @bookedsolid/rea/audit nor dist/audit/append.js is reachable', async () => {
    if (!jqExists()) return;

    // Deliberately do NOT symlink dist/. The temp dir has no node_modules
    // either. Both import paths must fail. Hook must exit 2 rather than
    // silently allowing the edit without an audit entry (Codex Finding 1).
    const target = path.join(dir, '.claude', 'hooks', 'custom.sh');
    await fs.writeFile(target, '#!/bin/bash\n');

    const res = runHook(dir, target, {
      REA_HOOK_PATCH_SESSION: 'no dist available',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/audit-append failed/);
  });
});

/**
 * Codex HIGH 1 regression — path-traversal bypass of the patch-session
 * allowlist.
 *
 * Before the fix, normalize_path() stripped interior ./ sequences and the
 * patch-session case-glob matched `.claude/hooks/*` textually. Paths like
 * `.claude/hooks/../settings.json` slipped through both checks and reached
 * .claude/settings.json on disk with the env var set.
 *
 * The fix rejects any path that contains a `..` segment BEFORE any match
 * runs, and reorders so hard-protected paths (.rea/policy.yaml, .rea/HALT,
 * .claude/settings.json) are denied before the patch-session allowlist is
 * consulted.
 */
describe('settings-protection.sh — path-traversal bypass (Codex HIGH 1)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-traversal-')));
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.mkdir(path.join(dir, '.claude', 'hooks'), { recursive: true });
    await fs.mkdir(path.join(dir, 'hooks'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    '.claude/hooks/../settings.json',
    '.claude/hooks/../../.rea/HALT',
    '.claude/hooks/./../settings.json',
    'hooks/../.rea/policy.yaml',
  ])('rejects traversal "%s" even with REA_HOOK_PATCH_SESSION set', async (suffix) => {
    if (!jqExists()) return;

    // Absolute path form (CLAUDE_PROJECT_DIR + traversal)
    const abs = path.join(dir, suffix);
    const res = runHook(dir, abs, {
      REA_HOOK_PATCH_SESSION: 'attempt bypass',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });

  it('rejects traversal even without env var set (defense in depth)', async () => {
    if (!jqExists()) return;

    const abs = path.join(dir, '.claude/hooks/../settings.json');
    const res = runHook(dir, abs);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });

  it('hard-protected paths are blocked BEFORE patch-session allowlist is consulted', async () => {
    if (!jqExists()) return;

    // Direct target (no traversal) but hard-protected.
    // With patch-session env set, the old code consulted the allowlist first;
    // the new code runs hard-protected denies first so no allowlist detour.
    const target = path.join(dir, '.claude', 'settings.json');
    await fs.writeFile(target, '{}');
    const res = runHook(dir, target, {
      REA_HOOK_PATCH_SESSION: 'should not matter',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });
});

/**
 * 0.29.0 — interior `/./` segment rejection. Sibling class to the `..`
 * traversal guard above. `normalize_path` strips the LEADING `./` but
 * does not collapse interior `/./` segments (which would corrupt `..`
 * reasoning), so a path like `.claude/hooks/./settings.json` survived
 * normalization with the literal `/./` intact and the §6 prefix-matcher
 * (which compares against `.claude/hooks/`) saw `.claude/hooks/./settings.json`
 * — DID match the prefix but the patch-session allowlist would have let
 * it through; meanwhile `.claude/./settings.json` would miss the literal
 * `.claude/settings.json` block entirely.
 *
 * The conservative closure (per Jake 2026-05-12): refuse outright with
 * the same wording as the `..` guard. Corpus pairs shell-scripting-
 * specialist with adversarial-test-specialist; we enumerate the encoded,
 * repeated, and mixed-with-`..` shapes.
 */
describe('settings-protection.sh — interior dot-segment rejection (0.29.0 helix-/./-class)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-dotseg-')));
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    await fs.mkdir(path.join(dir, '.claude', 'hooks'), { recursive: true });
    await fs.mkdir(path.join(dir, '.husky'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects .claude/./settings.json (interior dot, hard-protected target)', () => {
    if (!jqExists()) return;
    const abs = `${dir}/.claude/./settings.json`;
    const res = runHook(dir, abs);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects .rea/./policy.yaml even with REA_HOOK_PATCH_SESSION set', () => {
    if (!jqExists()) return;
    const abs = `${dir}/.rea/./policy.yaml`;
    const res = runHook(dir, abs, { REA_HOOK_PATCH_SESSION: 'attempt bypass' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects .husky/./pre-push (interior dot in package-managed body)', () => {
    if (!jqExists()) return;
    const abs = `${dir}/.husky/./pre-push`;
    const res = runHook(dir, abs);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects repeated interior dot segments (.claude/././settings.json)', () => {
    if (!jqExists()) return;
    const abs = `${dir}/.claude/././settings.json`;
    const res = runHook(dir, abs);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects URL-encoded interior dot (.claude/%2E/settings.json)', () => {
    if (!jqExists()) return;
    // %2E decodes to `.` in normalize_path; after backslash-translate and
    // leading-./ strip the form is `.claude/./settings.json`.
    const abs = `${dir}/.claude/%2E/settings.json`;
    const res = runHook(dir, abs);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects mixed-case URL-encoded interior dot (.claude/%2e/settings.json)', () => {
    if (!jqExists()) return;
    const abs = `${dir}/.claude/%2e/settings.json`;
    const res = runHook(dir, abs);
    expect(res.status).toBe(2);
  });

  it('rejects double-slash sibling (.claude/.//settings.json)', () => {
    if (!jqExists()) return;
    const abs = `${dir}/.claude/.//settings.json`;
    const res = runHook(dir, abs);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('rejects interior dot in extension surface (.husky/pre-push.d/./fragment)', () => {
    if (!jqExists()) return;
    // The extension surface is documented-writable, but an interior `/./`
    // segment must still be refused — it indicates an attempt to bypass
    // the literal/prefix matcher even within an allowed surface. The
    // §5a-bis guard runs BEFORE the §5b allowlist, so this rejects.
    const abs = `${dir}/.husky/pre-push.d/./fragment`;
    const res = runHook(dir, abs);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interior dot-segment rejected/);
  });

  it('allows benign leading-./ canonical path (./hooks/something.sh)', () => {
    if (!jqExists()) return;
    // normalize_path strips the leading `./`, so the form becomes
    // `hooks/something.sh`. With REA_HOOK_PATCH_SESSION set and the path
    // under hooks/, this should be permitted by the patch-session
    // allowlist. Without the env var it would block per the §6c
    // patch-session-pattern rule (which is the existing behavior).
    // Here we verify the dot-segment guard does NOT false-positive on
    // pure leading `./`.
    const abs = `${dir}/./hooks/something.sh`;
    const res = runHook(dir, abs);
    // Status may be 0 (allowed) or 2 (blocked by patch-session rule),
    // but NEVER with "interior dot-segment" wording.
    expect(res.stderr).not.toMatch(/interior dot-segment rejected/);
  });

  it('allows benign filename containing dots (src/foo.bar.test.ts)', async () => {
    if (!jqExists()) return;
    // `foo.bar.test.ts` is a legit filename — the `*/./* ` pattern
    // requires `.` between slashes, not within a filename.
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    const abs = `${dir}/src/foo.bar.test.ts`;
    const res = runHook(dir, abs);
    expect(res.status).toBe(0);
  });
});

describe('settings-protection.sh — `.husky/*.d/` extension surface (Fix 0.13.2)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-ext-')));
    await fs.mkdir(path.join(dir, '.husky', 'pre-push.d'), { recursive: true });
    await fs.mkdir(path.join(dir, '.husky', 'commit-msg.d'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('allows agent writes to .husky/pre-push.d/<fragment>', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.husky', 'pre-push.d', '00-act-ci');
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });

  it('allows agent writes to .husky/commit-msg.d/<fragment>', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.husky', 'commit-msg.d', '01-commitlint');
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });

  it('allows nested fragments (e.g. .husky/pre-push.d/sub/file)', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.husky', 'pre-push.d', 'sub', 'inner');
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });

  it('still blocks .husky/pre-push (the package-managed body)', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.husky', 'pre-push');
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });

  it('still blocks .husky/commit-msg (the package-managed body)', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.husky', 'commit-msg');
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });

  it('still blocks .husky/_/<hookname> (husky 9 runtime stubs)', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.husky', '_', 'pre-push');
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });

  it('does NOT allow .husky/pre-push.d.bak/* (near-miss prefix)', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.husky', 'pre-push.d.bak', 'foo');
    const res = runHook(dir, target);
    // Falls through to .husky/ prefix block.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });

  it('rejects traversal back into protected files via the .d/ surface', () => {
    if (!jqExists()) return;
    const target = path.join(dir, '.husky/pre-push.d/../pre-push');
    const res = runHook(dir, target);
    // §5a path-traversal reject runs BEFORE the §5b allow-list, so the
    // traversal can't smuggle a write to the package-managed body.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/SETTINGS PROTECTION/);
  });

  it('refuses symlinks placed in .husky/pre-push.d/* (defense-in-depth)', async () => {
    if (!jqExists()) return;
    // Without the symlink check, an agent could `ln -s ../pre-push
    // .husky/pre-push.d/00-evil` then Write through the symlink to
    // overwrite the package-managed `.husky/pre-push` body (which §6
    // protects). §5b refuses any symlink in the .d/ surface; consumers
    // have no legitimate use case for symlinked fragments.
    const protectedBody = path.join(dir, '.husky', 'pre-push');
    await fs.writeFile(protectedBody, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const symlinkPath = path.join(dir, '.husky', 'pre-push.d', '00-evil');
    await fs.symlink('../pre-push', symlinkPath);
    const res = runHook(dir, symlinkPath);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/symlink in extension surface refused/);
  });

  it('refuses symlinks placed in .husky/commit-msg.d/* (defense-in-depth)', async () => {
    if (!jqExists()) return;
    const protectedBody = path.join(dir, '.husky', 'commit-msg');
    await fs.writeFile(protectedBody, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const symlinkPath = path.join(dir, '.husky', 'commit-msg.d', '01-evil');
    await fs.symlink('../commit-msg', symlinkPath);
    const res = runHook(dir, symlinkPath);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/symlink in extension surface refused/);
  });

  it('refuses intermediate-directory symlink bypass (helix Finding 2 / 0.15.0)', async () => {
    if (!jqExists()) return;
    // The earlier `[ -L "$FILE_PATH" ]` check only inspected the FINAL
    // path component. An attacker could symlink an INTERMEDIATE
    // directory inside the surface to escape it:
    //
    //   .husky/pre-push.d/linkdir -> ../   (resolves to .husky/)
    //   write .husky/pre-push.d/linkdir/pre-push  → writes .husky/pre-push
    //
    // The final `pre-push` is not yet a file/symlink so `[ -L … ]`
    // returned false. The 0.15.0 fix resolves the parent dir's realpath
    // and refuses if the resolved path leaves the surface.
    const protectedBody = path.join(dir, '.husky', 'pre-push');
    await fs.writeFile(protectedBody, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const linkDir = path.join(dir, '.husky', 'pre-push.d', 'linkdir');
    await fs.symlink('../', linkDir);
    const target = path.join(linkDir, 'pre-push');
    const res = runHook(dir, target);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/extension path resolves outside surface/);
  });

  it('still allows nested fragments under non-symlinked subdirs', async () => {
    if (!jqExists()) return;
    // Regression-protection: the realpath check must not refuse
    // legitimate nested-but-real subdirectories under the surface.
    const subdir = path.join(dir, '.husky', 'pre-push.d', 'sub');
    await fs.mkdir(subdir, { recursive: true });
    const target = path.join(subdir, 'inner');
    const res = runHook(dir, target);
    expect(res.status).toBe(0);
  });
});
