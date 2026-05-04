/**
 * Tests for `hooks/secret-scanner.sh` — the PreToolUse hook that scans
 * about-to-be-written content for credential patterns.
 *
 * 0.14.0 iron-gate fix: prior versions only inspected `tool_input.content`
 * (Write) and `tool_input.new_string` (Edit). MultiEdit's payload is at
 * `tool_input.edits[].new_string` (an array) and was never inspected, so
 * any agent could route credential writes through MultiEdit to bypass the
 * scanner entirely. These tests pin the new MultiEdit handling alongside
 * the pre-existing Write/Edit paths.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'secret-scanner.sh');

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

// IMPORTANT: assemble the AWS-key pattern at runtime so this test FILE itself
// does not contain a literal that matches `AKIA[0-9A-Z]{16}`. Writing this
// file would otherwise be blocked by secret-scanner.sh on every commit. The
// concatenation breaks the regex's required alphanumeric run while still
// producing the canonical AWS docs example value at runtime.
const FAKE_AWS_KEY = 'AKIA' + 'IOSFODNN' + '7EXAMPLE';

describe('secret-scanner.sh — Write tool', () => {
  it('blocks a Write payload containing a credential pattern', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        content: `const k = "${FAKE_AWS_KEY}";\n`,
      },
    });
    expect(res.status).toBe(2);
  });

  it('allows a Write payload with no credential pattern', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: { file_path: '/tmp/foo.ts', content: 'const k = "hello";\n' },
    });
    expect(res.status).toBe(0);
  });
});

describe('secret-scanner.sh — Edit tool', () => {
  it('blocks an Edit payload containing a credential pattern in new_string', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        old_string: 'const k = "old";',
        new_string: `const k = "${FAKE_AWS_KEY}";`,
      },
    });
    expect(res.status).toBe(2);
  });

  it('allows an Edit payload with no credential pattern', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        old_string: 'const k = "old";',
        new_string: 'const k = "hello";',
      },
    });
    expect(res.status).toBe(0);
  });
});

describe('secret-scanner.sh — MultiEdit tool (0.14.0 iron-gate fix)', () => {
  it('blocks a MultiEdit payload when ANY edit.new_string contains a credential', () => {
    if (!jqExists()) return;
    // Pre-fix: this payload bypassed scanning entirely because the hook
    // only read tool_input.content and tool_input.new_string.
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        edits: [
          { old_string: 'a', new_string: 'safe value' },
          {
            old_string: 'b',
            new_string: `const k = "${FAKE_AWS_KEY}";`,
          },
          { old_string: 'c', new_string: 'another safe value' },
        ],
      },
    });
    expect(res.status).toBe(2);
  });

  it('blocks a MultiEdit with a single edit that contains a credential', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        edits: [
          {
            old_string: 'placeholder',
            new_string: `secret = "${FAKE_AWS_KEY}"`,
          },
        ],
      },
    });
    expect(res.status).toBe(2);
  });

  it('allows a MultiEdit when no edit.new_string contains a credential', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        edits: [
          { old_string: 'a', new_string: 'safe value 1' },
          { old_string: 'b', new_string: 'safe value 2' },
          { old_string: 'c', new_string: 'safe value 3' },
        ],
      },
    });
    expect(res.status).toBe(0);
  });

  it('handles an empty edits array (no payload to scan)', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: { file_path: '/tmp/foo.ts', edits: [] },
    });
    expect(res.status).toBe(0);
  });

  it('handles edits with missing new_string fields (defensive)', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        edits: [{ old_string: 'a' }, { old_string: 'b', new_string: 'safe' }],
      },
    });
    expect(res.status).toBe(0);
  });
});

describe('secret-scanner.sh — malformed MultiEdit payloads (codex round-1 P1 regression)', () => {
  it('blocks even when ONE edit has a non-string new_string (number) alongside a real credential', () => {
    if (!jqExists()) return;
    // Codex round-1 P1: pre-fix, jq errored on the non-string and the hook
    // fell through to exit 0, silently allowing the credential through.
    // Post-fix, `tostring` coerces every value so jq always succeeds and
    // the credential pattern still gets scanned.
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        edits: [
          { old_string: 'a', new_string: 42 },
          {
            old_string: 'b',
            new_string: `secret = "${FAKE_AWS_KEY}"`,
          },
        ],
      },
    });
    expect(res.status).toBe(2);
  });

  it('blocks when new_string is an object alongside a real credential', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        edits: [
          { old_string: 'a', new_string: { nested: 'object' } },
          { old_string: 'b', new_string: `key="${FAKE_AWS_KEY}"` },
        ],
      },
    });
    expect(res.status).toBe(2);
  });

  it('does not crash when edits is a non-array (string)', () => {
    if (!jqExists()) return;
    // Pre-fix: jq's `.tool_input.edits | map(...)` would error on a string
    // payload, fail-open via empty CONTENT_MULTIEDIT. Post-fix: type-guard
    // coerces non-array to [], hook exits 0 cleanly.
    const res = runHook({
      tool_input: { file_path: '/tmp/foo.ts', edits: 'not an array' },
    });
    expect(res.status).toBe(0);
  });

  it('does not crash when edits is a non-array (object)', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        edits: { not: 'an array either' },
      },
    });
    expect(res.status).toBe(0);
  });

  it('still scans valid string new_strings after coercing heterogeneous types', () => {
    if (!jqExists()) return;
    // All-strings case must continue to work as before — the coercion
    // change must not regress the happy path.
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        edits: [
          { old_string: 'a', new_string: 'safe value 1' },
          { old_string: 'b', new_string: 'safe value 2' },
        ],
      },
    });
    expect(res.status).toBe(0);
  });
});

describe('secret-scanner.sh — payload precedence', () => {
  it('Write content takes precedence over Edit new_string when both present', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        content: 'safe write content',
        new_string: `const k = "${FAKE_AWS_KEY}";`,
      },
    });
    expect(res.status).toBe(0);
  });

  it('Edit new_string takes precedence over MultiEdit edits[] when both present', () => {
    if (!jqExists()) return;
    const res = runHook({
      tool_input: {
        file_path: '/tmp/foo.ts',
        new_string: 'safe edit content',
        edits: [
          {
            old_string: 'x',
            new_string: `secret = "${FAKE_AWS_KEY}"`,
          },
        ],
      },
    });
    expect(res.status).toBe(0);
  });
});
