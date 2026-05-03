/**
 * Tests for `hooks/protected-paths-bash-gate.sh` — Bash-tier redirect
 * gate for the hard-protected path list (`.rea/HALT`, `.rea/policy.yaml`,
 * `.claude/settings.json`, `.husky/*`).
 *
 * Coverage spans:
 *   - 0.15.0 introduced the gate (closes J.9 shell-redirect bypass)
 *   - 0.16.0 closes the helix-015 P1 set: `..` traversal, case-
 *     insensitive matching on macOS, widened redirect regex
 *   - 0.16.0 codex round-1 P1: glob expansion in the `..` resolver
 *     (must use `read -ra`, not unquoted `for`)
 *   - 0.16.0 codex round-1 P2-1: placeholder-collision in segment
 *     splitter (`>|` placeholder must be collision-safe)
 *   - 0.16.0 codex round-1 P2-3: paths escaping REA_ROOT refused
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'protected-paths-bash-gate.sh');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(cmd: string, opts: { cwd?: string; reaRoot?: string } = {}): HookResult {
  const cwd = opts.cwd ?? REPO_ROOT;
  const claudeProjectDir = opts.reaRoot ?? cwd;
  const payload = JSON.stringify({ tool_input: { command: cmd } });
  const res = spawnSync('bash', [HOOK_SRC], {
    cwd,
    env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: claudeProjectDir },
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

describe('protected-paths-bash-gate.sh — baseline redirect detection', () => {
  it('blocks `> .rea/HALT`', () => {
    if (!jqExists()) return;
    const res = runHook('printf x > .rea/HALT');
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/PROTECTED PATH/);
  });

  it('blocks `>> .rea/policy.yaml`', () => {
    if (!jqExists()) return;
    const res = runHook('echo new > /tmp/x; cat /tmp/x >> .rea/policy.yaml');
    expect(res.status).toBe(2);
  });

  it('blocks `tee .claude/settings.json`', () => {
    if (!jqExists()) return;
    const res = runHook('echo {} | tee .claude/settings.json');
    expect(res.status).toBe(2);
  });

  it('blocks `cp src dst` when dst is protected', () => {
    if (!jqExists()) return;
    const res = runHook('cp /tmp/new-policy.yaml .rea/policy.yaml');
    expect(res.status).toBe(2);
  });

  it('blocks `sed -i path` when path is protected', () => {
    if (!jqExists()) return;
    const res = runHook("sed -i '' 's/foo/bar/' .husky/pre-push");
    expect(res.status).toBe(2);
  });

  it('blocks `dd of=path` when path is protected', () => {
    if (!jqExists()) return;
    const res = runHook('dd if=/dev/zero of=.rea/HALT bs=1 count=0');
    expect(res.status).toBe(2);
  });

  it('blocks `truncate path` when path is protected', () => {
    if (!jqExists()) return;
    const res = runHook('truncate -s 0 .rea/HALT');
    expect(res.status).toBe(2);
  });
});

describe('protected-paths-bash-gate.sh — helix-015 #1: `..` traversal normalization', () => {
  it('blocks `> .claude/hooks/../settings.json` (target resolves to .claude/settings.json)', () => {
    if (!jqExists()) return;
    // Pre-0.16.0: literal-string match against `.claude/hooks/../settings.json`
    // didn't match the `.claude/settings.json` pattern, even though bash
    // resolves the `..` and writes the protected file. Fixed via
    // `..`-resolver in `_normalize_target`.
    const res = runHook('printf x > .claude/hooks/../settings.json');
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/PROTECTED PATH|path traversal/);
  });

  it('blocks `> .husky/foo/../pre-push` (target resolves to .husky/pre-push)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x > .husky/foo/../pre-push');
    expect(res.status).toBe(2);
  });

  it('blocks `> ./.rea/HALT` (./ prefix)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x > ./.rea/HALT');
    expect(res.status).toBe(2);
  });
});

describe('protected-paths-bash-gate.sh — helix-015 #2: case-insensitive matching', () => {
  it('blocks `> .ClAuDe/settings.json` (mixed case)', () => {
    if (!jqExists()) return;
    // macOS APFS is case-insensitive by default. The mixed-case path
    // lands on the same file as `.claude/settings.json` but pre-fix
    // matched case-sensitively and missed.
    const res = runHook('printf x > .ClAuDe/settings.json');
    expect(res.status).toBe(2);
  });

  it('blocks `> .REA/HALT` (all caps)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x > .REA/HALT');
    expect(res.status).toBe(2);
  });

  it('blocks `tee .Husky/pre-push`', () => {
    if (!jqExists()) return;
    const res = runHook('echo body | tee .Husky/pre-push');
    expect(res.status).toBe(2);
  });
});

describe('protected-paths-bash-gate.sh — helix-015 #3: widened redirect regex', () => {
  it('blocks `1> .rea/HALT` (explicit stdout fd)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x 1> .rea/HALT');
    expect(res.status).toBe(2);
  });

  it('blocks `1>> .rea/HALT` (explicit stdout fd append)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x 1>> .rea/HALT');
    expect(res.status).toBe(2);
  });

  it('blocks `>| .rea/HALT` (noclobber-override)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x >| .rea/HALT');
    expect(res.status).toBe(2);
  });

  it('blocks `9> .rea/HALT` (arbitrary fd-prefixed redirect)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x 9> .rea/HALT');
    expect(res.status).toBe(2);
  });

  it('blocks `&>> .rea/HALT` (stderr+stdout append)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x &>> .rea/HALT');
    expect(res.status).toBe(2);
  });
});

describe('protected-paths-bash-gate.sh — codex round-1 P1: glob expansion in `..` resolver', () => {
  let cwd: string;

  beforeEach(async () => {
    // Create a temp dir with sibling files so `*` glob would expand.
    cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-bash-gate-glob-')));
    await fs.mkdir(path.join(cwd, '.claude'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.claude', 'foo.json'), '{}');
    await fs.writeFile(path.join(cwd, '.claude', 'bar.json'), '{}');
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('blocks `> .claude/*/../settings.json` even with sibling files in cwd that would glob-expand `*`', () => {
    if (!jqExists()) return;
    // Codex round-1 P1: pre-fix used `for part in $abs` (unquoted),
    // which globbed `*` against cwd. With `.claude/foo.json` in cwd,
    // `*` expanded to `foo.json`, the resolver lost track of the `..`,
    // and the gate let the write through. Fix uses `read -ra` which
    // does not glob.
    const res = runHook('printf x > .claude/*/../settings.json', { cwd, reaRoot: cwd });
    expect(res.status).toBe(2);
  });
});

describe('protected-paths-bash-gate.sh — codex round-1 P2-3: paths escaping REA_ROOT', () => {
  it('refuses `> ../../etc/passwd` outright (escapes project root)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x > ../../etc/passwd');
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/path traversal escapes project root|PROTECTED PATH/);
  });
});

describe('protected-paths-bash-gate.sh — codex round-1 P2-1: segment splitter placeholder', () => {
  it('does not corrupt commands containing literal placeholder bytes', () => {
    if (!jqExists()) return;
    // Pre-fix the placeholder was `\x01` (SOH); a command containing
    // literal SOH would have been silently rewritten with `>|` after
    // splitting. Post-fix the placeholder is multi-byte alphanumeric
    // (`__REA_GTPIPE_a8f2c1__`) which cannot occur naturally — and
    // even if it did, the worst case is fail-closed. We don't have a
    // way to inject SOH through the JSON wire, but we verify a
    // command containing the new sentinel string itself doesn't get
    // mangled into a redirect.
    const cmd =
      'echo "doc: __REA_GTPIPE_a8f2c1__ is the splitter sentinel; do not rename"';
    const res = runHook(cmd);
    expect(res.status).toBe(0);
  });
});

describe('protected-paths-bash-gate.sh — regression-safe: legitimate writes pass', () => {
  it('allows `> /tmp/log` (unprotected)', () => {
    if (!jqExists()) return;
    const res = runHook('printf x > /tmp/log');
    expect(res.status).toBe(0);
  });

  it('allows `tee .rea/audit.jsonl` (operational, not protected)', () => {
    if (!jqExists()) return;
    const res = runHook('echo entry | tee -a .rea/audit.jsonl');
    expect(res.status).toBe(0);
  });

  it('allows `cp src dst` between unprotected paths', () => {
    if (!jqExists()) return;
    const res = runHook('cp src/foo.ts dist/foo.js');
    expect(res.status).toBe(0);
  });

  it("allows `git commit -m 'discusses .rea/HALT'`", () => {
    if (!jqExists()) return;
    // Commit messages mentioning protected paths are NOT redirects;
    // the segment for `git commit` doesn't trigger the redirect-detect
    // patterns.
    const res = runHook("git commit -m 'doc: explain .rea/HALT semantics'");
    expect(res.status).toBe(0);
  });
});
