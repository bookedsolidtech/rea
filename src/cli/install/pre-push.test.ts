/**
 * G6 — Pre-push fallback installer tests.
 *
 * Covers the three install shapes documented in `pre-push.ts`:
 *   1. vanilla git (no core.hooksPath) → `.git/hooks/pre-push`
 *   2. hooksPath set, pre-push already present → skip
 *   3. hooksPath set, no pre-push → install into hooksPath
 *
 * Plus idempotency (re-run does not double-install, refreshes the marker)
 * and foreign-hook safety (we refuse to stomp a hook that doesn't carry
 * our marker).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyPrePushInstall,
  FALLBACK_MARKER,
  inspectPrePushState,
  installPrePushFallback,
} from './pre-push.js';

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'test']);
}

describe('installPrePushFallback — classifyPrePushInstall branches', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepush-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('vanilla git: classifies as install at .git/hooks/pre-push', async () => {
    await initGitRepo(dir);
    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('install');
    expect(decision.hookPath).toBe(path.join(dir, '.git', 'hooks', 'pre-push'));
  });

  it('hooksPath set and pre-push already present: skips with active-pre-push-present', async () => {
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(path.join(huskyDir, 'pre-push'), '#!/bin/sh\necho existing\n', { mode: 0o755 });
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', huskyDir]);

    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('active-pre-push-present');
      expect(decision.hookPath).toBe(path.join(huskyDir, 'pre-push'));
    }
  });

  it('hooksPath set but empty: classifies as install into hooksPath', async () => {
    await initGitRepo(dir);
    const custom = path.join(dir, 'custom-hooks');
    await fs.mkdir(custom, { recursive: true });
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', custom]);

    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('install');
    expect(decision.hookPath).toBe(path.join(custom, 'pre-push'));
  });

  it('existing rea-managed hook: classifies as refresh', async () => {
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      `#!/bin/sh\n${FALLBACK_MARKER}\nexec /bin/true\n`,
      { mode: 0o755 },
    );
    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('refresh');
  });

  it('existing foreign hook: classifies as skip foreign-pre-push', async () => {
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      '#!/bin/sh\n# consumer-owned pre-push\necho custom\n',
      { mode: 0o755 },
    );
    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('foreign-pre-push');
    }
  });
});

describe('installPrePushFallback — write semantics', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepush-w-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a fresh executable hook containing the marker', async () => {
    await initGitRepo(dir);
    const result = await installPrePushFallback(dir);
    expect(result.decision.action).toBe('install');
    expect(result.written).toBe(path.join(dir, '.git', 'hooks', 'pre-push'));

    const content = await fs.readFile(result.written!, 'utf8');
    expect(content).toContain(FALLBACK_MARKER);
    // Delegates to the shared gate — critical invariant.
    expect(content).toContain('.claude/hooks/push-review-gate.sh');

    const stat = await fs.stat(result.written!);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('is idempotent: re-run refreshes without doubling files or touching foreign hooks', async () => {
    await initGitRepo(dir);
    const first = await installPrePushFallback(dir);
    expect(first.decision.action).toBe('install');

    const second = await installPrePushFallback(dir);
    expect(second.decision.action).toBe('refresh');
    expect(second.written).toBe(first.written);

    // Content still carries our marker and delegates to the gate.
    const content = await fs.readFile(second.written!, 'utf8');
    expect(content).toContain(FALLBACK_MARKER);
    expect(content).toContain('.claude/hooks/push-review-gate.sh');

    // Nothing got duplicated under .git/hooks/.
    const entries = await fs.readdir(path.join(dir, '.git', 'hooks'));
    const prePushEntries = entries.filter((e) => e === 'pre-push');
    expect(prePushEntries).toEqual(['pre-push']);
  });

  it('refuses to overwrite a foreign hook', async () => {
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const customContent = '#!/bin/sh\n# sacred\nexit 0\n';
    await fs.writeFile(path.join(hooksDir, 'pre-push'), customContent, {
      mode: 0o755,
    });

    const result = await installPrePushFallback(dir);
    expect(result.decision.action).toBe('skip');
    if (result.decision.action === 'skip') {
      expect(result.decision.reason).toBe('foreign-pre-push');
    }
    expect(result.written).toBeUndefined();
    const after = await fs.readFile(path.join(hooksDir, 'pre-push'), 'utf8');
    expect(after).toBe(customContent);
    expect(result.warnings.some((w) => w.includes('not rea-managed'))).toBe(true);
  });

  it('skips gracefully when .git/ is absent', async () => {
    // No `git init`. Still must not throw.
    const result = await installPrePushFallback(dir);
    expect(result.warnings.some((w) => w.includes('.git/ not found'))).toBe(true);
    expect(result.written).toBeUndefined();
  });
});

describe('inspectPrePushState — doctor seam', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepush-d-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('vanilla git with .git/hooks/pre-push installed: ok=true', async () => {
    await initGitRepo(dir);
    await installPrePushFallback(dir);
    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(true);
    const active = state.candidates.find((c) => c.exists && c.executable);
    expect(active?.path).toBe(path.join(dir, '.git', 'hooks', 'pre-push'));
    expect(active?.reaManaged).toBe(true);
  });

  it('vanilla git without pre-push installed: ok=false', async () => {
    await initGitRepo(dir);
    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(false);
  });

  it('hooksPath=.husky with executable .husky/pre-push: ok=true', async () => {
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(
      path.join(huskyDir, 'pre-push'),
      '#!/bin/sh\nexec .claude/hooks/push-review-gate.sh "$@"\n',
      { mode: 0o755 },
    );
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', huskyDir]);

    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(true);
    const active = state.candidates.find((c) => c.path === path.join(huskyDir, 'pre-push'));
    expect(active?.exists).toBe(true);
    expect(active?.executable).toBe(true);
  });

  it('`.husky/pre-push` exists but hooksPath is unset: ok=false', async () => {
    // This is the exact dogfooding gap G6 closes. Without hooksPath pointing
    // at .husky/, git never fires .husky/pre-push, so the protected-path
    // gate would be bypassed. inspectPrePushState must report this as NOT ok.
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(
      path.join(huskyDir, 'pre-push'),
      '#!/bin/sh\nexec /bin/true\n',
      { mode: 0o755 },
    );
    // No `git config core.hooksPath` — husky is not active.

    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(false);
    // The husky copy is reported as present (for context) but not active.
    const huskyCandidate = state.candidates.find(
      (c) => c.path === path.join(huskyDir, 'pre-push'),
    );
    expect(huskyCandidate?.exists).toBe(true);
  });

  it('pre-push present but not executable: ok=false with informative candidates', async () => {
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, 'pre-push'), '#!/bin/sh\n', { mode: 0o644 });

    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(false);
    const active = state.candidates.find((c) => c.path === path.join(hooksDir, 'pre-push'));
    expect(active?.exists).toBe(true);
    expect(active?.executable).toBe(false);
  });
});
