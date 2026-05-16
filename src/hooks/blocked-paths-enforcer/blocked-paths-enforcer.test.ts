/**
 * Unit tests for the Node-binary port of `hooks/blocked-paths-enforcer.sh`.
 *
 * Coverage:
 *   - Routing (HALT, malformed, empty file_path, missing policy)
 *   - §5a path-traversal reject (both `..` raw + URL-encoded)
 *   - §5a-bis interior `/./` reject
 *   - Agent-writable allow-list short-circuit
 *   - Match shapes: exact, directory prefix, glob
 *   - §H.2 intermediate-symlink resolution
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBlockedPathsEnforcer } from './index.js';

function writePayload(filePath: string, toolName = 'Write'): string {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: { file_path: filePath, content: 'foo' },
  });
}

function notebookPayload(notebookPath: string): string {
  return JSON.stringify({
    tool_name: 'NotebookEdit',
    tool_input: { notebook_path: notebookPath, new_source: 'foo' },
  });
}

function writePolicy(reaRoot: string, blockedPaths: string[]): void {
  fs.mkdirSync(path.join(reaRoot, '.rea'), { recursive: true });
  const yaml = `version: "1"\nblocked_paths:\n${blockedPaths.map((p) => `  - ${JSON.stringify(p)}`).join('\n')}\n`;
  fs.writeFileSync(path.join(reaRoot, '.rea', 'policy.yaml'), yaml);
}

describe('blocked-paths-enforcer (Node-binary port)', () => {
  let reaRoot: string;
  beforeEach(() => {
    reaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-bpe-'));
  });
  afterEach(() => {
    fs.rmSync(reaRoot, { recursive: true, force: true });
  });

  describe('routing', () => {
    it('HALT → exit 2', async () => {
      fs.mkdirSync(path.join(reaRoot, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(reaRoot, '.rea', 'HALT'), 'stopped\n');
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('src/foo.ts'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('REA HALT');
    });

    it('malformed → exit 2', async () => {
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: 'not json',
      });
      expect(r.exitCode).toBe(2);
    });

    it('empty file_path → exit 0', async () => {
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: JSON.stringify({
          tool_name: 'Write',
          tool_input: {},
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('missing policy.yaml → exit 0', async () => {
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('src/foo.ts'),
      });
      expect(r.exitCode).toBe(0);
    });

    it('empty blocked_paths → exit 0', async () => {
      writePolicy(reaRoot, []);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('src/foo.ts'),
      });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('§5a path traversal', () => {
    it('refuses raw `..` segment', async () => {
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('foo/../secrets/x'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('path traversal rejected');
    });

    it('refuses normalized `..` segment', async () => {
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('secrets/..'),
      });
      expect(r.exitCode).toBe(2);
    });

    it('refuses URL-encoded traversal', async () => {
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('foo/%2E%2E/secrets/x'),
      });
      expect(r.exitCode).toBe(2);
    });
  });

  describe('§5a-bis interior /./', () => {
    it('refuses interior /./ segment', async () => {
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('foo/./secrets/x'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('interior dot-segment rejected');
    });

    it('allows leading ./ (stripped by normalize)', async () => {
      // blocked_paths doesn't include src/, so leading ./ -> exit 0.
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('./src/foo.ts'),
      });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('agent-writable allow-list', () => {
    it('exact .rea/tasks.jsonl always passes even if .rea/ blocked', async () => {
      writePolicy(reaRoot, ['.rea/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('.rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(0);
    });

    it('.rea/audit/* always passes', async () => {
      writePolicy(reaRoot, ['.rea/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('.rea/audit/2026-05.jsonl'),
      });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('match shapes', () => {
    it('directory prefix → exit 2', async () => {
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('secrets/foo.env'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.matched).toBe('secrets/');
    });

    it('exact match → exit 2', async () => {
      writePolicy(reaRoot, ['CODEOWNERS']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('CODEOWNERS'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.matched).toBe('CODEOWNERS');
    });

    it('case-insensitive match', async () => {
      writePolicy(reaRoot, ['Codeowners']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('codeowners'),
      });
      expect(r.exitCode).toBe(2);
    });

    it('glob match → exit 2 with `(glob pattern)` suffix', async () => {
      writePolicy(reaRoot, ['*.env']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('foo.env'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('(glob pattern)');
    });

    it('non-matching path → exit 0', async () => {
      writePolicy(reaRoot, ['secrets/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('src/foo.ts'),
      });
      expect(r.exitCode).toBe(0);
    });

    it('NotebookEdit honored via notebook_path', async () => {
      writePolicy(reaRoot, ['restricted/']);
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: notebookPayload('restricted/foo.ipynb'),
      });
      expect(r.exitCode).toBe(2);
    });
  });

  describe('§H.2 intermediate-symlink resolution', () => {
    it('refuses write through symlinked parent into blocked dir', async () => {
      writePolicy(reaRoot, ['secrets/']);
      fs.mkdirSync(path.join(reaRoot, 'secrets'), { recursive: true });
      fs.mkdirSync(path.join(reaRoot, 'innocuous'), { recursive: true });
      fs.symlinkSync(
        path.join(reaRoot, 'secrets'),
        path.join(reaRoot, 'innocuous', 'mirror'),
      );
      const target = path.join(reaRoot, 'innocuous', 'mirror', 'foo');
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload(target),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('intermediate-symlink resolution blocked');
    });
  });

  describe('permissive policy load', () => {
    it('partial/migrating policy preserves enforcement', async () => {
      fs.mkdirSync(path.join(reaRoot, '.rea'), { recursive: true });
      fs.writeFileSync(
        path.join(reaRoot, '.rea', 'policy.yaml'),
        `version: "1"\nlegacy_key: 1\nblocked_paths:\n  - "secrets/"\n`,
      );
      const r = await runBlockedPathsEnforcer({
        reaRoot,
        stdinOverride: writePayload('secrets/foo'),
      });
      expect(r.exitCode).toBe(2);
    });
  });
});
