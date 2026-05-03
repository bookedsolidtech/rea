/**
 * Tests for `hooks/changeset-security-gate.sh`.
 *
 * 0.15.0 fix: pre-0.15.0 the gate exited 0 on every MultiEdit call against
 * `.changeset/*.md`, letting GHSA / CVE pre-disclosure through and skipping
 * frontmatter validation entirely. Same bypass shape as the secret-scanner
 * MultiEdit fix in 0.14.0; this is the second hook in the same family.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'changeset-security-gate.sh');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(payload: object): HookResult {
  const res = spawnSync('bash', [HOOK_SRC], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: REPO_ROOT },
    input: JSON.stringify(payload),
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

describe('changeset-security-gate.sh — Write tool (baseline)', () => {
  it('blocks a Write payload containing a GHSA identifier', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: '.changeset/some-fix.md',
        content: '---\n"@bookedsolid/rea": patch\n---\n\nFixes GHSA-1234-5678-9abc\n',
      },
    });
    expect(res.status).not.toBe(0);
  });

  it('blocks a Write payload containing a CVE identifier', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: '.changeset/some-fix.md',
        content: '---\n"@bookedsolid/rea": patch\n---\n\nFixes CVE-2026-12345\n',
      },
    });
    expect(res.status).not.toBe(0);
  });

  it('allows a clean Write payload without disclosure markers', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: '.changeset/some-fix.md',
        content: '---\n"@bookedsolid/rea": patch\n---\n\nFixes a logic bug.\n',
      },
    });
    expect(res.status).toBe(0);
  });
});

describe('changeset-security-gate.sh — MultiEdit tool (0.15.0 fix)', () => {
  it('blocks a MultiEdit payload when ANY edit.new_string contains a GHSA', () => {
    if (!jqExists()) return;
    // Pre-fix: this returned exit 0 because the hook short-circuited on
    // any tool_name other than Write/Edit, letting the GHSA through
    // unscanned.
    const res = runHook({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '.changeset/some-fix.md',
        edits: [
          { old_string: 'placeholder', new_string: 'safe content' },
          { old_string: 'note', new_string: 'Fixes GHSA-aaaa-bbbb-cccc' },
        ],
      },
    });
    expect(res.status).not.toBe(0);
  });

  it('blocks a MultiEdit payload when ANY edit.new_string contains a CVE', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '.changeset/some-fix.md',
        edits: [{ old_string: 'x', new_string: 'addresses CVE-2026-99999' }],
      },
    });
    expect(res.status).not.toBe(0);
  });

  it('allows a MultiEdit payload with no disclosure markers', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '.changeset/some-fix.md',
        edits: [
          { old_string: 'a', new_string: 'safe content' },
          { old_string: 'b', new_string: 'more safe content' },
        ],
      },
    });
    expect(res.status).toBe(0);
  });

  it('handles malformed MultiEdit payloads (non-string new_string) without fail-open', () => {
    if (!jqExists()) return;
    // Same defensive coercion as secret-scanner: tostring + array-type
    // guard so jq can't error and silently fall through to exit 0.
    const res = runHook({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '.changeset/some-fix.md',
        edits: [
          { old_string: 'a', new_string: 42 },
          { old_string: 'b', new_string: 'addresses GHSA-zzzz-yyyy-xxxx' },
        ],
      },
    });
    expect(res.status).not.toBe(0);
  });

  it('handles non-array edits without crashing (defensive)', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '.changeset/some-fix.md',
        edits: 'not an array',
      },
    });
    expect(res.status).toBe(0);
  });
});

describe('changeset-security-gate.sh — non-changeset paths bypass cleanly', () => {
  it('exits 0 on a Write to a non-.changeset/ path', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: 'src/foo.ts',
        content: 'GHSA-1234-5678-9abc would not matter here',
      },
    });
    expect(res.status).toBe(0);
  });

  it('exits 0 on .changeset/README.md (changeset tool metadata)', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: '.changeset/README.md',
        content: '# Changesets\n',
      },
    });
    expect(res.status).toBe(0);
  });
});
