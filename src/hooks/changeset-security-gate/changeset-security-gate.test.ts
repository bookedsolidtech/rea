/**
 * Unit tests for `runChangesetSecurityGate`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runChangesetSecurityGate } from './index.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-changeset-gate-'));
}
function rm(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function writePayload(opts: {
  toolName?: string;
  filePath?: string;
  content?: string;
}): string {
  const ti: Record<string, unknown> = {};
  if (opts.filePath !== undefined) ti['file_path'] = opts.filePath;
  if (opts.content !== undefined) ti['content'] = opts.content;
  return JSON.stringify({
    tool_name: opts.toolName ?? 'Write',
    tool_input: ti,
  });
}

function editPayload(opts: {
  toolName?: string;
  filePath?: string;
  newString?: string;
}): string {
  const ti: Record<string, unknown> = {};
  if (opts.filePath !== undefined) ti['file_path'] = opts.filePath;
  if (opts.newString !== undefined) ti['new_string'] = opts.newString;
  return JSON.stringify({ tool_name: opts.toolName ?? 'Edit', tool_input: ti });
}

function multiEditPayload(opts: {
  filePath?: string;
  edits?: string[];
}): string {
  return JSON.stringify({
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: opts.filePath,
      edits: opts.edits?.map((s) => ({ old_string: 'x', new_string: s })),
    },
  });
}

function notebookEditPayload(opts: {
  notebookPath?: string;
  newSource?: string;
}): string {
  return JSON.stringify({
    tool_name: 'NotebookEdit',
    tool_input: {
      notebook_path: opts.notebookPath,
      new_source: opts.newSource,
    },
  });
}

const VALID_CHANGESET = `---
'@bookedsolid/rea': patch
---

fix(hooks): updated env-file-protection banner text
`;

describe('runChangesetSecurityGate', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rm(root);
  });

  describe('HALT and payload', () => {
    it('HALT exits 2', async () => {
      fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen\n');
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/test.md',
          content: VALID_CHANGESET,
        }),
      });
      expect(r.exitCode).toBe(2);
    });

    it('exits 2 on malformed JSON', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: '{nope',
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('changeset-security-gate');
    });

    it('exits 0 on empty stdin', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: '',
      });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('tool filter', () => {
    it('exits 0 for Bash tool', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('accepts Write', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: VALID_CHANGESET,
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('accepts Edit', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: editPayload({
          filePath: '.changeset/x.md',
          newString: VALID_CHANGESET,
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('accepts MultiEdit', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: multiEditPayload({
          filePath: '.changeset/x.md',
          edits: ['hello world'],
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('accepts NotebookEdit', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: notebookEditPayload({
          notebookPath: '.changeset/x.md',
          newSource: VALID_CHANGESET,
        }),
      });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('path filter', () => {
    it('exits 0 for non-changeset files', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: 'src/foo.ts',
          content: 'GHSA-aaaa-bbbb-cccc',
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('exits 0 for .changeset/README.md (metadata)', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/README.md',
          content: 'GHSA-aaaa-bbbb-cccc',
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('matches .changeset/<random>.md', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/cool-bears-jump.md',
          content: VALID_CHANGESET,
        }),
      });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('disclosure scan', () => {
    it('blocks GHSA identifier', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: `---\n'@bookedsolid/rea': patch\n---\n\nfix GHSA-3w3m-7gg4-f82g symlink bypass\n`,
        }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('security advisory identifier');
      expect(r.stdout).toContain('permissionDecision');
      expect(r.stdout).toContain('deny');
    });

    it('blocks CVE identifier', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: `---\n'@bookedsolid/rea': patch\n---\n\nfix CVE-2026-1234\n`,
        }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('CVE-');
    });

    it('blocks GHSA inside MultiEdit fragment', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: multiEditPayload({
          filePath: '.changeset/x.md',
          edits: ['fix GHSA-aaaa-bbbb-cccc bypass'],
        }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('GHSA-');
    });

    it('does NOT block clean content', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: `---\n'@bookedsolid/rea': patch\n---\n\nsecurity: harden middleware chain\n`,
        }),
      });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('frontmatter validation', () => {
    it('blocks missing frontmatter', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: 'no frontmatter here\n',
        }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('Missing frontmatter block');
    });

    it('blocks malformed frontmatter (no bump entry)', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: '---\nnotice: a fake\n---\n\ndesc\n',
        }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('valid package bump entry');
    });

    it('blocks missing description', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: `---\n'@bookedsolid/rea': patch\n---\n\n   \n`,
        }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('Missing description');
    });

    it('accepts single-quoted package name', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: `---\n'@bookedsolid/rea': patch\n---\n\nfix something\n`,
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('accepts double-quoted package name', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: `---\n"@bookedsolid/rea": minor\n---\n\nfeat ok\n`,
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('accepts unquoted package name (0.15.0 codex P2-1 fix)', async () => {
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: writePayload({
          filePath: '.changeset/x.md',
          content: `---\n@bookedsolid/rea: major\n---\n\nbreaking change\n`,
        }),
      });
      expect(r.exitCode).toBe(0);
    });

    it('skips frontmatter validation on MultiEdit (fragment shape)', async () => {
      // MultiEdit fragments are not full files. Frontmatter validation
      // would always reject the partial content.
      const r = await runChangesetSecurityGate({
        reaRoot: root,
        stdinOverride: multiEditPayload({
          filePath: '.changeset/x.md',
          edits: ['fix typo in description'],
        }),
      });
      expect(r.exitCode).toBe(0);
    });
  });
});
