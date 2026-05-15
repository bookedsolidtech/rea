/**
 * Unit tests for `src/hooks/pr-issue-link-gate/index.ts` — Node-binary
 * pilot port of `hooks/pr-issue-link-gate.sh`.
 *
 * Coverage focus:
 *   - HALT short-circuit → exit 2 + banner (verified against
 *     `formatHaltBanner` byte string)
 *   - Non-Bash tool calls → exit 0 silently
 *   - Bash calls without `gh pr create` → exit 0 silently
 *   - `gh pr create` WITH `closes #N` / `fixes #N` / `resolves #N`
 *     (case variants) → exit 0 silently
 *   - `gh pr create` WITHOUT a closing reference → exit 0 + advisory
 *   - Malformed JSON → exit 2 (fail-closed)
 *   - Wrong-type tool_input.command → exit 2 (fail-closed)
 *   - Empty stdin → exit 0 silently (no command, no advisory)
 *
 * The advisory banner string is asserted against an inlined copy of
 * the bash hook's `printf` lines so any drift trips the test. The
 * Class G byte-fidelity test in 0.32.0 also covers the package-side
 * shim; this suite is the hot-path unit gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPrIssueLinkGate } from './index.js';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pr-link-gate-test-'));
}

function payload(cmd: string, toolName = 'Bash'): string {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: { command: cmd },
  });
}

describe('runPrIssueLinkGate', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 with HALT banner when .rea/HALT is present', async () => {
    fs.mkdirSync(path.join(root, '.rea'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'mid-deploy lockdown');
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: payload('gh pr create --title foo'),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(
      'REA HALT: mid-deploy lockdown\nAll agent operations suspended. Run: rea unfreeze\n',
    );
  });

  it('exits 0 silently for non-Bash tool calls', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: payload('any command', 'Edit'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 silently when command does not contain `gh pr create`', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: payload('git status && echo done'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 silently when `closes #N` is present', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: payload('gh pr create --title x --body "closes #123"'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 silently when `fixes #N` is present (case-insensitive)', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: payload('gh pr create --body "FIXES #42"'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 silently when `resolves #N` is present', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: payload('gh pr create --body "this resolves #7 finally"'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('emits advisory and exits 0 when no closing reference is present', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: payload('gh pr create --title chore --body "no link here"'),
    });
    expect(result.exitCode).toBe(0);
    // The advisory header must be present byte-for-byte.
    expect(result.stderr).toContain(
      'PR ISSUE LINK ADVISORY: This PR does not reference a GitHub issue.\n',
    );
    expect(result.stderr).toContain('  closes #N    closes one issue\n');
    expect(result.stderr).toContain(
      'If this is a chore, release, or hotfix PR with no upstream issue, you may proceed.\n',
    );
  });

  it('matches when `gh   pr   create` has irregular whitespace (\\s+)', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: payload('gh   pr\tcreate --title x'),
    });
    // Should still trigger advisory (no closing ref).
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('PR ISSUE LINK ADVISORY');
  });

  it('exits 2 (fail-closed) on malformed JSON stdin', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: '{not json',
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('refusing on uncertainty');
  });

  it('exits 2 (fail-closed) when tool_input.command is wrong type', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: ['rm', '-rf'] },
      }),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('refusing on uncertainty');
  });

  it('exits 0 silently for empty stdin (no command, no advisory)', async () => {
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: '',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('does NOT trigger on `closes` keyword without `#N` (closes #foo)', async () => {
    // Bash original requires `[0-9]+` after `#`. A bare `closes the PR`
    // or `closes #foo` body should still trigger the advisory because
    // GitHub's autoclose only honors `#<integer>`.
    const result = await runPrIssueLinkGate({
      reaRoot: root,
      stdinOverride: payload(
        'gh pr create --body "this closes the discussion #foo"',
      ),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('PR ISSUE LINK ADVISORY');
  });
});
