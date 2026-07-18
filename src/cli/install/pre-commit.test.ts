/**
 * Unit tests for the G1 spec-gate `.husky/pre-commit` installer.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  preCommitHookContent,
  isReaManagedPreCommit,
  classifyPreCommit,
  installPreCommitHook,
  PRE_COMMIT_MARKER,
  PRE_COMMIT_BODY_MARKER,
} from './pre-commit.js';

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-precommit-'));
}
function rm(d: string): void {
  fs.rmSync(d, { recursive: true, force: true });
}

describe('pre-commit installer', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeDir();
  });
  afterEach(() => {
    rm(dir);
  });

  it('content carries both markers and invokes `rea gate spec-check`', () => {
    const c = preCommitHookContent();
    expect(c.startsWith('#!/bin/sh\n')).toBe(true);
    expect(c.split('\n')[1]).toBe(PRE_COMMIT_MARKER);
    expect(c.split('\n')[2]).toBe(PRE_COMMIT_BODY_MARKER);
    expect(c).toContain('gate spec-check');
    expect(isReaManagedPreCommit(c)).toBe(true);
  });

  it('installs when absent, then reclassifies as refresh (idempotent)', async () => {
    const first = await installPreCommitHook({ targetDir: dir });
    expect(first.decision.action).toBe('install');
    expect(first.written).toBe(path.join(dir, '.husky', 'pre-commit'));
    const onDisk = fs.readFileSync(first.written as string, 'utf8');
    expect(isReaManagedPreCommit(onDisk)).toBe(true);

    const second = await installPreCommitHook({ targetDir: dir });
    expect(second.decision.action).toBe('refresh');
    // Byte-identical on re-run.
    expect(fs.readFileSync(second.written as string, 'utf8')).toBe(onDisk);
  });

  it('leaves a foreign pre-commit alone (skip)', async () => {
    fs.mkdirSync(path.join(dir, '.husky'), { recursive: true });
    const foreign = '#!/bin/sh\necho custom\n';
    fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), foreign);
    const res = await installPreCommitHook({ targetDir: dir });
    expect(res.decision.action).toBe('skip');
    expect(fs.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8')).toBe(foreign);
  });

  it('classifyPreCommit reports install/refresh/skip correctly', async () => {
    expect((await classifyPreCommit(dir)).action).toBe('install');
    await installPreCommitHook({ targetDir: dir });
    expect((await classifyPreCommit(dir)).action).toBe('refresh');
  });

  it('rejects a hook with the header marker but a stubbed-out body', () => {
    const stubbed = `#!/bin/sh\n${PRE_COMMIT_MARKER}\n# not the body marker\nexit 0\n`;
    expect(isReaManagedPreCommit(stubbed)).toBe(false);
  });
});
