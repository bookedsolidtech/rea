/**
 * Unit tests for `src/hooks/security-disclosure-gate/index.ts`.
 *
 * Coverage focus:
 *   - HALT → exit 2 with banner.
 *   - DisclosureMode normalization: `disabled`, `issues`, `advisory`,
 *     undefined → 'advisory', bogus → 'advisory'.
 *   - `disabled` mode → exit 0 before any scan.
 *   - Non-Bash tool → exit 0.
 *   - Non-`gh issue create` command → exit 0.
 *   - `gh issue edit` (head-anchor strictness) → exit 0.
 *   - SECURITY_PATTERNS matches → exit 2 + JSON block on stdout.
 *   - Both modes emit their distinct reason banner.
 *   - First-match wins: scan stops at the earliest catalog pattern.
 *   - Body-file resolution:
 *       - `--body-file <PATH>` (space form)
 *       - `--body-file=<PATH>` (equals form)
 *       - `-F <PATH>` and `-F=<PATH>`
 *       - Stdin form (`-F -`) is skipped.
 *       - Quoted path with spaces (`--body-file "path with spaces.md"`).
 *       - Unreadable path emits warning, continues.
 *       - `..` traversal escaping REA_ROOT → exit 2 with refusal banner.
 *       - `..` traversal staying inside REA_ROOT is fine.
 *       - Absolute `/tmp/...` paths without `..` are accepted.
 *   - Malformed JSON → exit 2.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSecurityDisclosureGate } from './index.js';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-sec-disc-test-'));
}

function payload(cmd: string, toolName = 'Bash'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });
}

describe('runSecurityDisclosureGate', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 with HALT banner when .rea/HALT is present', async () => {
    fs.mkdirSync(path.join(root, '.rea'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen');
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload('gh issue create --title "bypass found"'),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('REA HALT: frozen');
  });

  it('exits 0 silently when disclosure mode is disabled', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload('gh issue create --title "exploit found"'),
      disclosureModeOverride: 'disabled',
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 for non-Bash tool calls', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload('gh issue create --title bypass', 'Edit'),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 when command is not `gh issue create`', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload('gh issue list --label bypass'),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 for `gh issue edit` (head-anchored relevance)', async () => {
    // 0.16.3 F8 — anchor at segment start so adjacent commands don't
    // false-trigger.
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        'gh issue edit 42 --body "describing the prior bypass earlier"',
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 when no security pattern matches', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload('gh issue create --title "doc typo" --body "fix"'),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(0);
  });

  it('blocks on bypass keyword in title (advisory mode default)', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        'gh issue create --title "Found a HALT bypass" --body "see x"',
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('permissionDecision');
    expect(result.stdout).toContain('deny');
    expect(result.stdout).toContain('security-advisories');
    expect(result.stdout).toContain("matched: 'bypass'");
  });

  // 0.32.0 codex round 2 P2: legacy bash hook printed the deny
  // banner to stderr (via `json_output "block"` → `printf >&2`).
  // The Node port initially returned `stderr: ''` from the block
  // emitter, leaving hook runners that only surface stderr with
  // no remediation text. Pin the stderr banner on both branches.
  it('emits the deny banner on stderr in advisory mode', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        'gh issue create --title "Found a HALT bypass"',
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('SECURITY DISCLOSURE GATE');
    expect(result.stderr).toContain("matched: 'bypass'");
    expect(result.stderr).toContain('security-advisories');
  });

  it('emits the deny banner on stderr in issues mode', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        'gh issue create --title "found CVE-2025-9999"',
      ),
      disclosureModeOverride: 'issues',
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('SECURITY DISCLOSURE GATE');
    expect(result.stderr).toContain("gh issue create --label 'security,internal'");
  });

  it('routes to issues-mode banner when REA_DISCLOSURE_MODE=issues', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        'gh issue create --title "found CVE-2025-9999" --body "internal"',
      ),
      disclosureModeOverride: 'issues',
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("gh issue create --label 'security,internal'");
    expect(result.stdout).not.toContain('security-advisories');
  });

  it('normalizes bogus REA_DISCLOSURE_MODE to advisory', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        'gh issue create --title "RCE in foo" --body "x"',
      ),
      disclosureModeOverride: 'something-else',
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('security-advisories');
  });

  it('respects first-match-wins from SECURITY_PATTERNS order', async () => {
    // `bypass` appears before `injection` in the catalog. A title
    // containing both should report 'bypass'.
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        'gh issue create --title "bypass + injection found"',
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("matched: 'bypass'");
  });

  it('resolves --body-file with equals form', async () => {
    const bodyPath = path.join(root, 'body.md');
    fs.writeFileSync(bodyPath, 'this is a serious code execution finding');
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        `gh issue create --title "minor docs" --body-file=${bodyPath}`,
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("matched: 'code.execution'");
  });

  it('resolves --body-file with space form', async () => {
    const bodyPath = path.join(root, 'body.md');
    fs.writeFileSync(bodyPath, 'prompt injection vulnerability');
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        `gh issue create --title "minor docs" --body-file ${bodyPath}`,
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
  });

  it('resolves -F short form', async () => {
    const bodyPath = path.join(root, 'body.md');
    fs.writeFileSync(bodyPath, 'token leak in audit log');
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        `gh issue create --title "minor docs" -F ${bodyPath}`,
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("matched: 'token.*leak'");
  });

  it('skips stdin form `-F -`', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload('gh issue create --title docs -F -'),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(0);
  });

  it('refuses `..` traversal escaping REA_ROOT', async () => {
    // Build a payload whose body-file resolves outside root via `..`.
    // We don't even need the file to exist — the traversal check fires
    // before readability.
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        `gh issue create --title x --body-file ${root}/sub/../../../etc/passwd`,
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('path traversal escapes project root');
  });

  it('allows absolute paths without `..` (tmpfile pattern)', async () => {
    const tmpFile = path.join(os.tmpdir(), `rea-sec-disc-tmpbody-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, 'clean message');
    try {
      const result = await runSecurityDisclosureGate({
        reaRoot: root,
        stdinOverride: payload(
          `gh issue create --title "docs fix" --body-file ${tmpFile}`,
        ),
        cwdOverride: root,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('warns and continues for unreadable --body-file', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        `gh issue create --title "minor docs" --body-file ${root}/does-not-exist.md`,
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('unreadable; skipping body scan');
  });

  it('exits 2 (fail-closed) on malformed JSON stdin', async () => {
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: '{not json',
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('refusing on uncertainty');
  });

  it('honors quoted --body-file path with spaces', async () => {
    const bodyPath = path.join(root, 'security notes.md');
    fs.writeFileSync(bodyPath, 'arbitrary code injection');
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        `gh issue create --title docs --body-file "${bodyPath}"`,
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
  });

  it('does not trigger on body text that has none of the patterns', async () => {
    const bodyPath = path.join(root, 'body.md');
    fs.writeFileSync(bodyPath, 'just a plain documentation update');
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        `gh issue create --title docs --body-file ${bodyPath}`,
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(0);
  });

  it('blocks despite quoted env-prefix bypass attempt (codex round 1 P1)', async () => {
    // Pre-fix the segment matcher only stripped unquoted env tokens,
    // so `REA_SKIP="urgent" gh issue create --title "bypass found"`
    // had its head left as `REA_SKIP="urgent"` and the gate never
    // matched the relevance regex. Verify the new env-prefix
    // stripper consumes the quoted value and exposes the `gh issue
    // create` head.
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        `REA_SKIP="urgent fix" gh issue create --title "bypass found"`,
      ),
      cwdOverride: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("matched: 'bypass'");
  });

  it('caps body-file read at 64 KiB', async () => {
    // Write 128 KiB of clean text, with a security keyword AT BYTE
    // 100_000 — the cap should stop us before we see it.
    const bodyPath = path.join(root, 'body.md');
    const clean = 'safe content '.repeat(8000); // ~104 KiB
    const trigger = '\nzero day exploit\n';
    fs.writeFileSync(bodyPath, clean + trigger);
    const result = await runSecurityDisclosureGate({
      reaRoot: root,
      stdinOverride: payload(
        `gh issue create --title docs --body-file ${bodyPath}`,
      ),
      cwdOverride: root,
    });
    // Trigger was past 64 KiB — should NOT have matched.
    expect(result.exitCode).toBe(0);
  });
});
