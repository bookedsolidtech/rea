/**
 * Unit tests for the Node-binary port of `hooks/protected-paths-bash-gate.sh`.
 *
 * Coverage:
 *   - Routing (HALT, malformed, non-Bash, empty)
 *   - Scanner integration smoke (allow benign / block protected write)
 *   - REA_HOOK_PATCH_SESSION relaxes `.claude/hooks/` for the Bash tier
 *   - protected_writes + protected_paths_relax policy plumbing
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProtectedPathsBashGate } from './index.js';

function payload(cmd: string, toolName = 'Bash'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });
}

describe('protected-paths-bash-gate (Node-binary port)', () => {
  let reaRoot: string;

  beforeEach(() => {
    reaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-ppbg-'));
  });

  afterEach(() => {
    fs.rmSync(reaRoot, { recursive: true, force: true });
  });

  describe('routing', () => {
    it('HALT active → exit 2', async () => {
      fs.mkdirSync(path.join(reaRoot, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(reaRoot, '.rea', 'HALT'), 'halted\n');
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload('ls'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('REA HALT');
    });

    it('malformed JSON → exit 2', async () => {
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: '{garbage',
      });
      expect(r.exitCode).toBe(2);
    });

    it('non-Bash tool bypassed', async () => {
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload('echo > .claude/settings.json', 'Write'),
      });
      expect(r.exitCode).toBe(0);
    });

    it('empty command → exit 0', async () => {
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload(''),
      });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('scanner integration', () => {
    it('benign command passes through', async () => {
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload('cat README.md'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.verdict?.verdict).toBe('allow');
    });

    it('write redirect to .claude/settings.json → exit 2', async () => {
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload('echo "" > .claude/settings.json'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.verdict?.verdict).toBe('block');
    });

    it('write redirect to .husky/pre-push → exit 2', async () => {
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload('cat <<EOF > .husky/pre-push\nEOF'),
      });
      expect(r.exitCode).toBe(2);
    });

    it('write redirect to .rea/HALT → exit 2', async () => {
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload('echo > .rea/HALT'),
      });
      expect(r.exitCode).toBe(2);
    });
  });

  describe('REA_HOOK_PATCH_SESSION', () => {
    // The Bash-tier scanner's HISTORICAL_DEFAULT_PROTECTED_PATTERNS does
    // NOT include .claude/hooks/ — that's a Write-tier-only patch-session
    // pattern. So `cat > .claude/hooks/foo.sh` is allowed at the bash
    // tier regardless of env var. The Node port's relax logic for
    // .claude/hooks/ is harmless here (the pattern isn't in the bash
    // protected set to begin with). The Write-tier sibling
    // (settings-protection) is where the patch-session unlock matters.
    it('without env var, benign .claude/hooks/ writes pass at bash tier', async () => {
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload('cat > .claude/hooks/foo.sh'),
        patchSessionOverride: '',
      });
      expect(r.exitCode).toBe(0);
    });

    it('patch-session does NOT relax kill-switch invariants (.rea/HALT)', async () => {
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload('echo > .rea/HALT'),
        patchSessionOverride: 'trying to bypass',
      });
      expect(r.exitCode).toBe(2);
    });
  });

  describe('permissive policy', () => {
    it('partial/migrating policy.yaml does not collapse enforcement', async () => {
      fs.mkdirSync(path.join(reaRoot, '.rea'), { recursive: true });
      fs.writeFileSync(
        path.join(reaRoot, '.rea', 'policy.yaml'),
        `version: "1"\nlegacy_key: 1\nprotected_paths_relax:\n  - "ignored_path/"\n`,
      );
      const r = await runProtectedPathsBashGate({
        reaRoot,
        stdinOverride: payload('echo > .claude/settings.json'),
      });
      expect(r.exitCode).toBe(2);
    });
  });
});
