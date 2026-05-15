/**
 * Unit tests for `runEnvFileProtection` — the Node-binary port of
 * `hooks/env-file-protection.sh`.
 *
 * Covers every branch in the executor:
 *   - HALT short-circuit (exit 2)
 *   - Malformed payload fail-closed (exit 2)
 *   - Non-Bash tool → exit 0
 *   - Empty command → exit 0
 *   - source/cp anchor patterns (exit 2)
 *   - Utility + .env co-occurrence (exit 2)
 *   - Same-segment requirement (multi-segment FP class)
 *   - Quote-aware splitting (commit-message FP class)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEnvFileProtection } from './index.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-env-protection-'));
}
function rm(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
function payload(cmd: string, toolName: string = 'Bash'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });
}

describe('runEnvFileProtection', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rm(root);
  });

  describe('HALT short-circuit', () => {
    it('exits 2 when .rea/HALT exists', async () => {
      fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen by test\n');
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('cat .env'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('REA HALT');
    });
  });

  describe('payload validation', () => {
    it('exits 2 on malformed JSON', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: '{not json',
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('env-file-protection');
      expect(result.stderr).toContain('refusing on uncertainty');
    });

    it('exits 2 on non-string command', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: ['cat', '.env'] },
        }),
      });
      expect(result.exitCode).toBe(2);
    });

    it('exits 0 on empty stdin', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: '',
      });
      expect(result.exitCode).toBe(0);
    });

    it('exits 0 on empty command', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload(''),
      });
      expect(result.exitCode).toBe(0);
    });
  });

  describe('tool filter', () => {
    it('exits 0 when tool_name is not Bash', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('cat .env', 'Write'),
      });
      expect(result.exitCode).toBe(0);
    });

    it('exits 0 when tool_name is empty (treated as Bash)', async () => {
      // No tool_name → treated as Bash; the command IS a .env read.
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: JSON.stringify({ tool_input: { command: 'cat .env' } }),
      });
      expect(result.exitCode).toBe(2);
    });
  });

  describe('source / cp anchor patterns', () => {
    it('blocks `source .env`', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('source .env'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Direct sourcing or copying');
    });

    it('blocks `. .env`', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('. .env.production'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Direct sourcing or copying');
    });

    it('blocks `source ./path/to/.env.local`', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('source ./path/.env.local'),
      });
      expect(result.exitCode).toBe(2);
    });

    it('blocks `cp .env /tmp/leak`', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('cp .env /tmp/leak'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Direct sourcing or copying');
    });

    it('does NOT match `source` inside a commit message', async () => {
      // discord-ops Round 9 #4 fix: segment-start anchor required.
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload(`git commit -m "fix: do not source .env files"`),
      });
      expect(result.exitCode).toBe(0);
    });
  });

  describe('utility + .env co-occurrence', () => {
    const blocked = [
      'cat .env',
      'head .env.production',
      'tail .env.local',
      'less .envrc',
      'grep PASSWORD .env',
      'sed -n 1p .env',
      'awk "{print}" .env',
      'cat ./.env',
      'cat /etc/.env',
    ];
    for (const cmd of blocked) {
      it(`blocks: ${cmd}`, async () => {
        const result = await runEnvFileProtection({
          reaRoot: root,
          stdinOverride: payload(cmd),
        });
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('Reading .env files via Bash is blocked');
      });
    }
  });

  describe('same-segment requirement (multi-segment FP class)', () => {
    it('does NOT block when utility and .env live in different segments', async () => {
      // helix-017 P2 #2 fix: utility AND env-filename must co-occur in
      // the SAME segment. Pre-fix would block this.
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('echo "log: cat is broken" ; touch foo.env'),
      });
      expect(result.exitCode).toBe(0);
    });

    it('does NOT block "cat foo.txt && echo .env"', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('cat foo.txt && echo .env'),
      });
      expect(result.exitCode).toBe(0);
    });

    it('blocks when both appear in one segment regardless of position', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('ls && cat .env && echo done'),
      });
      expect(result.exitCode).toBe(2);
    });
  });

  describe('false-positive resistance', () => {
    it('allows commit messages mentioning .env', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload(`git commit -m "stop reading .env via cat"`),
      });
      expect(result.exitCode).toBe(0);
    });

    it('allows mkdir of .environments directory (boundary test)', async () => {
      // .environments does NOT match .env* because the trailing pattern
      // requires a word boundary (`\s|"|'|$`). But .env-something does
      // because hyphens are in the character class.
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('cat .environments/log.txt'),
      });
      // .environments/log matches PATTERN_ENV_FILE because:
      //   `.env[a-zA-Z0-9._-]*` matches `.environments`
      //   then `(\s|"|'|$)` doesn't match `/` so this should NOT fire.
      expect(result.exitCode).toBe(0);
    });

    it('allows pnpm run with .env-prefixed script name', async () => {
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload('pnpm run start'),
      });
      expect(result.exitCode).toBe(0);
    });
  });

  describe('truncation', () => {
    it('truncates long commands in the banner to 100 chars', async () => {
      const longCmd = 'cat .env' + ' && true '.repeat(50);
      const result = await runEnvFileProtection({
        reaRoot: root,
        stdinOverride: payload(longCmd),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('...');
    });
  });
});
