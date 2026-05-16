/**
 * Unit tests for the Node-binary port of `hooks/blocked-paths-bash-gate.sh`.
 *
 * Two tiers of coverage:
 *
 *   1. Routing: HALT, malformed payload, non-Bash tool, empty command,
 *      empty policy, missing policy file — all decided BEFORE the
 *      scanner runs.
 *   2. Scanner-integration smoke: verifies that the gate actually
 *      delegates to `runBlockedScan` (block on a write to a blocked
 *      entry; allow on benign read).
 *
 * The exhaustive scanner-rule corpus lives under `src/hooks/bash-
 * scanner/` — duplicating those classes here would be drift bait.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBlockedPathsBashGate } from './index.js';

function payload(cmd: string, toolName = 'Bash'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });
}

function writePolicy(reaRoot: string, blockedPaths: string[]): void {
  fs.mkdirSync(path.join(reaRoot, '.rea'), { recursive: true });
  const yaml = `version: "1"\nblocked_paths:\n${blockedPaths.map((p) => `  - ${JSON.stringify(p)}`).join('\n')}\n`;
  fs.writeFileSync(path.join(reaRoot, '.rea', 'policy.yaml'), yaml);
}

describe('blocked-paths-bash-gate (Node-binary port)', () => {
  let reaRoot: string;

  beforeEach(() => {
    reaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-bpbg-'));
  });

  afterEach(() => {
    fs.rmSync(reaRoot, { recursive: true, force: true });
  });

  describe('routing', () => {
    it('HALT active → exit 2 with banner', async () => {
      fs.mkdirSync(path.join(reaRoot, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(reaRoot, '.rea', 'HALT'), 'kill switch on\n');
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('ls /tmp'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('REA HALT');
      expect(r.stderr).toContain('kill switch on');
    });

    it('malformed JSON → exit 2', async () => {
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: '{not-json',
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/refusing on uncertainty/);
    });

    it('non-Bash tool → exit 0 silently', async () => {
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('rm -rf src/', 'Write'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe('');
    });

    it('empty command → exit 0 silently', async () => {
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload(''),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe('');
    });

    it('empty stdin → exit 0', async () => {
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: '',
      });
      expect(r.exitCode).toBe(0);
    });

    it('missing policy.yaml → exit 0 (no enforcement)', async () => {
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('rm -rf src/'),
      });
      expect(r.exitCode).toBe(0);
    });

    it('empty blocked_paths list → exit 0', async () => {
      writePolicy(reaRoot, []);
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('rm -rf src/'),
      });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('scanner integration', () => {
    it('benign read passes through cleanly even when blocked_paths set', async () => {
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('cat README.md'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.verdict?.verdict).toBe('allow');
    });

    it('write redirect to blocked dir → exit 2', async () => {
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('echo hi > secrets/foo.env'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.verdict?.verdict).toBe('block');
    });

    it('cp into blocked dir → exit 2', async () => {
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('cp /tmp/foo secrets/'),
      });
      expect(r.exitCode).toBe(2);
    });

    it('exact-match blocked entry → exit 2', async () => {
      writePolicy(reaRoot, ['CODEOWNERS']);
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('echo x > CODEOWNERS'),
      });
      expect(r.exitCode).toBe(2);
    });
  });

  describe('permissive policy load', () => {
    it('policy with unknown keys still reads blocked_paths', async () => {
      // Partial policy.yaml — would fail strict-schema validation.
      fs.mkdirSync(path.join(reaRoot, '.rea'), { recursive: true });
      fs.writeFileSync(
        path.join(reaRoot, '.rea', 'policy.yaml'),
        `version: "1"\nunknown_legacy_key: blah\nblocked_paths:\n  - "secrets/"\n`,
      );
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('echo hi > secrets/foo'),
      });
      expect(r.exitCode).toBe(2);
    });

    it('unparseable YAML → exit 0 (no enforcement, fail-safe)', async () => {
      fs.mkdirSync(path.join(reaRoot, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(reaRoot, '.rea', 'policy.yaml'), ': : : :');
      const r = await runBlockedPathsBashGate({
        reaRoot,
        stdinOverride: payload('echo hi > secrets/foo'),
      });
      // Permissive read returns [] → no enforcement.
      expect(r.exitCode).toBe(0);
    });
  });
});
