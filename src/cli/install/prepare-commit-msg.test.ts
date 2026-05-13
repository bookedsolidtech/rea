/**
 * Tests for `installPrepareCommitMsgHook` and `classifyPrepareCommitMsgHook`.
 *
 * Covers:
 *   - install into vanilla git repo (no .husky/) writes .git/hooks/prepare-commit-msg
 *   - install into husky-configured repo writes both .git/hooks/ AND .husky/
 *   - re-install (idempotent) refreshes a rea-managed body in place
 *   - foreign hook present → refuses to overwrite, surfaces conflict
 *   - classification: absent / rea-managed / foreign
 *   - foreign-hook conflict mirrors the 0.13.2 pre-push prior art shape
 *
 * Hermetic: every test uses a fresh tmpdir + `git init --quiet`.
 */

import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PKG_ROOT } from '../utils.js';
import {
  classifyPrepareCommitMsgHook,
  installPrepareCommitMsgHook,
  PREPARE_COMMIT_MSG_BODY_MARKER,
  PREPARE_COMMIT_MSG_MARKER,
} from './prepare-commit-msg.js';

const execFileAsync = promisify(execFile);

/**
 * The husky `prepare-commit-msg` canonical body is authored as a
 * one-time bootstrap step in the 0.30.0 release process: Jake copies
 * `templates/prepare-commit-msg.husky.sh` to `.husky/prepare-commit-msg`
 * and `chmod +x`. Until that bootstrap runs, the installer's
 * `sourceHookPath()` (which reads `PKG_ROOT/.husky/prepare-commit-msg`)
 * cannot find the source — so this test suite SKIPS when the canonical
 * path is absent. Once Jake completes the bootstrap, every test runs.
 */
const CANONICAL_SOURCE = path.join(PKG_ROOT, '.husky', 'prepare-commit-msg');
const CANONICAL_PRESENT = fsSync.existsSync(CANONICAL_SOURCE);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'test']);
}

describe.skipIf(!CANONICAL_PRESENT)('installPrepareCommitMsgHook', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepare-cm-'));
    dir = await fs.realpath(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('installs to .git/hooks/ when core.hooksPath is unset (vanilla git)', async () => {
    await initGitRepo(dir);
    const result = await installPrepareCommitMsgHook(dir);
    expect(result.gitHook).toBe(path.join(dir, '.git', 'hooks', 'prepare-commit-msg'));
    const stat = await fs.stat(result.gitHook!);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('installs to BOTH .git/hooks/ and .husky/ when .husky/ exists', async () => {
    await initGitRepo(dir);
    await fs.mkdir(path.join(dir, '.husky'), { recursive: true });
    const result = await installPrepareCommitMsgHook(dir);
    expect(result.gitHook).toBeDefined();
    expect(result.huskyHook).toBe(path.join(dir, '.husky', 'prepare-commit-msg'));
  });

  it('refresh is idempotent — re-install on a rea-managed hook returns refreshed=true', async () => {
    await initGitRepo(dir);
    const first = await installPrepareCommitMsgHook(dir);
    expect(first.refreshed).toBeUndefined();
    const second = await installPrepareCommitMsgHook(dir);
    expect(second.refreshed).toBe(true);
  });

  it('refuses to overwrite a foreign hook (no rea marker)', async () => {
    await initGitRepo(dir);
    const gitHook = path.join(dir, '.git', 'hooks', 'prepare-commit-msg');
    await fs.writeFile(gitHook, '#!/bin/sh\necho "user hook"\n', { mode: 0o755 });
    const result = await installPrepareCommitMsgHook(dir);
    expect(result.gitHook).toBeUndefined();
    expect(result.skippedForeign).toBe(true);
    const body = await fs.readFile(gitHook, 'utf8');
    expect(body).toBe('#!/bin/sh\necho "user hook"\n');
  });

  it('skips install when .git/ is absent', async () => {
    const result = await installPrepareCommitMsgHook(dir);
    expect(result.gitHook).toBeUndefined();
    expect(result.huskyHook).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('.git/ not found'))).toBe(true);
  });
});

describe('classifyPrepareCommitMsgHook', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepare-cm-classify-'));
    dir = await fs.realpath(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns absent for a non-existent file', async () => {
    const cls = await classifyPrepareCommitMsgHook(path.join(dir, 'nope'));
    expect(cls.kind).toBe('absent');
  });

  it('returns rea-managed when both markers are present on lines 2 and 3', async () => {
    const hookPath = path.join(dir, 'h');
    const body = `#!/bin/sh\n${PREPARE_COMMIT_MSG_MARKER}\n${PREPARE_COMMIT_MSG_BODY_MARKER}\n# body\n`;
    await fs.writeFile(hookPath, body);
    const cls = await classifyPrepareCommitMsgHook(hookPath);
    expect(cls.kind).toBe('rea-managed');
  });

  it('returns foreign when the marker is missing', async () => {
    const hookPath = path.join(dir, 'h');
    await fs.writeFile(hookPath, '#!/bin/sh\n# user hook\necho hi\n');
    const cls = await classifyPrepareCommitMsgHook(hookPath);
    expect(cls.kind).toBe('foreign');
    if (cls.kind === 'foreign') {
      expect(cls.reason).toBe('no-marker');
    }
  });

  it('returns foreign when the marker is present as substring but not on line 2', async () => {
    const hookPath = path.join(dir, 'h');
    // Header marker appears as a comment inside the body — must NOT
    // count as rea-managed.
    const body = `#!/bin/sh\n# something else here\n${PREPARE_COMMIT_MSG_MARKER}\n`;
    await fs.writeFile(hookPath, body);
    const cls = await classifyPrepareCommitMsgHook(hookPath);
    expect(cls.kind).toBe('foreign');
  });

  it('returns foreign for symlinks', async () => {
    const target = path.join(dir, 'target');
    await fs.writeFile(
      target,
      `#!/bin/sh\n${PREPARE_COMMIT_MSG_MARKER}\n${PREPARE_COMMIT_MSG_BODY_MARKER}\n`,
    );
    const link = path.join(dir, 'link');
    await fs.symlink(target, link);
    const cls = await classifyPrepareCommitMsgHook(link);
    expect(cls.kind).toBe('foreign');
    if (cls.kind === 'foreign') {
      expect(cls.reason).toBe('is-symlink');
    }
  });
});
