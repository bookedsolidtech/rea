/**
 * Tests for the 0.11.0 pre-push installer.
 *
 * The 0.10.x test suite was ~4000 lines of structural shell-body parsers —
 * checking whether a hypothetical foreign hook "correctly" invoked the
 * bash push-review gate. All of that is obsolete in 0.11.0: the body is
 * now a 15-line templated stub that delegates to `rea hook push-gate`.
 * We only need to prove:
 *
 *   1. Marker classifiers recognize rea-authored files (current + legacy)
 *      and reject everything else.
 *   2. `classifyPrePushInstall` maps hook states to the right action
 *      (install / refresh / skip-active / skip-foreign).
 *   3. `installPrePushFallback` writes atomically, respects the lock,
 *      and never stomps foreign files.
 *   4. `inspectPrePushState` surfaces enough info for `rea doctor`.
 *   5. `referencesReviewGate` recognizes custom consumer hooks that
 *      still delegate to `rea hook push-gate`.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyExistingHook,
  classifyPrePushInstall,
  FALLBACK_MARKER,
  fallbackHookContent,
  HUSKY_GATE_BODY_MARKER,
  HUSKY_GATE_MARKER,
  huskyHookContent,
  inspectPrePushState,
  installPrePushFallback,
  isLegacyReaManagedFallback,
  isLegacyReaManagedHuskyGate,
  isReaManagedFallback,
  isReaManagedHuskyGate,
  LEGACY_FALLBACK_MARKER_V1,
  LEGACY_HUSKY_GATE_BODY_MARKER_V1,
  LEGACY_HUSKY_GATE_MARKER_V1,
  referencesReviewGate,
} from './pre-push.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepush-')));
  await execFileAsync('git', ['-C', dir, 'init', '-q']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@test']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'test']);
  return dir;
}

async function setHooksPath(dir: string, hooksPath: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', hooksPath]);
}

async function writeHook(hookPath: string, content: string, mode = 0o755): Promise<void> {
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, content, { encoding: 'utf8', mode });
}

// ---------------------------------------------------------------------------
// Marker classifiers
// ---------------------------------------------------------------------------

describe('isReaManagedFallback — anchored v2 fallback marker', () => {
  it('accepts a real v2 fallback body', () => {
    expect(isReaManagedFallback(fallbackHookContent())).toBe(true);
  });

  it('rejects a file that lacks the shebang', () => {
    expect(isReaManagedFallback(`${FALLBACK_MARKER}\nexec rea hook push-gate\n`)).toBe(false);
  });

  it('rejects a substring match — marker on any line other than line 2', () => {
    const body = `#!/bin/sh\n# legit header\n${FALLBACK_MARKER}\nexec rea hook push-gate\n`;
    expect(isReaManagedFallback(body)).toBe(false);
  });

  it('rejects a foreign hook that mentions the marker in a comment', () => {
    const body = `#!/bin/sh\n# NOTE: do not use rea's ${FALLBACK_MARKER} — rolled our own\nexit 0\n`;
    expect(isReaManagedFallback(body)).toBe(false);
  });

  it('accepts v1 legacy marker via the legacy classifier', () => {
    const body = `#!/bin/sh\n${LEGACY_FALLBACK_MARKER_V1}\nexec .claude/hooks/push-review-gate.sh "$@"\n`;
    expect(isLegacyReaManagedFallback(body)).toBe(true);
    expect(isReaManagedFallback(body)).toBe(false);
  });
});

describe('isReaManagedHuskyGate — three-line anchored markers', () => {
  it('accepts the shipped v2 husky hook', () => {
    expect(isReaManagedHuskyGate(huskyHookContent())).toBe(true);
  });

  it('rejects a hook with only the v2 header marker and no body marker', () => {
    const body = `#!/bin/sh\n${HUSKY_GATE_MARKER}\n# no body marker\nexit 0\n`;
    expect(isReaManagedHuskyGate(body)).toBe(false);
  });

  it('rejects a hook with header + body markers swapped', () => {
    const body = `#!/bin/sh\n${HUSKY_GATE_BODY_MARKER}\n${HUSKY_GATE_MARKER}\nexit 0\n`;
    expect(isReaManagedHuskyGate(body)).toBe(false);
  });

  it('accepts the legacy v1 husky pair via the legacy classifier', () => {
    const body = `#!/bin/sh\n${LEGACY_HUSKY_GATE_MARKER_V1}\n${LEGACY_HUSKY_GATE_BODY_MARKER_V1}\nexec .claude/hooks/push-review-gate.sh "$@"\n`;
    expect(isLegacyReaManagedHuskyGate(body)).toBe(true);
    expect(isReaManagedHuskyGate(body)).toBe(false);
  });
});

describe('referencesReviewGate — delegation to `rea hook push-gate`', () => {
  it('matches a bare `exec rea hook push-gate` line', () => {
    expect(referencesReviewGate('#!/bin/sh\nexec rea hook push-gate\n')).toBe(true);
  });

  it('matches an indented invocation', () => {
    expect(referencesReviewGate('#!/bin/sh\nif true; then\n  rea hook push-gate\nfi\n')).toBe(true);
  });

  it('matches a subshell/backtick invocation', () => {
    expect(referencesReviewGate('#!/bin/sh\necho $(rea hook push-gate)\n')).toBe(true);
  });

  it('does NOT match when the invocation is inside a commented line', () => {
    expect(referencesReviewGate('#!/bin/sh\n# TODO: wire rea hook push-gate\nexit 0\n')).toBe(
      false,
    );
  });

  it('does NOT match `rea hook push-something-else`', () => {
    expect(referencesReviewGate('#!/bin/sh\nrea hook push-something\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyExistingHook
// ---------------------------------------------------------------------------

describe('classifyExistingHook', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('absent when the file does not exist', async () => {
    const res = await classifyExistingHook(path.join(repo, '.git/hooks/pre-push'));
    expect(res.kind).toBe('absent');
  });

  it('rea-managed when the file carries the v2 fallback marker', async () => {
    const hp = path.join(repo, '.git/hooks/pre-push');
    await writeHook(hp, fallbackHookContent());
    const res = await classifyExistingHook(hp);
    expect(res.kind).toBe('rea-managed');
  });

  it('rea-managed-husky when the file carries the v2 husky markers', async () => {
    const hp = path.join(repo, '.husky/pre-push');
    await writeHook(hp, huskyHookContent());
    const res = await classifyExistingHook(hp);
    expect(res.kind).toBe('rea-managed-husky');
  });

  it('rea-managed-legacy-v1 when the file is a 0.10.x fallback', async () => {
    const hp = path.join(repo, '.git/hooks/pre-push');
    await writeHook(
      hp,
      `#!/bin/sh\n${LEGACY_FALLBACK_MARKER_V1}\nexec .claude/hooks/push-review-gate.sh "$@"\n`,
    );
    const res = await classifyExistingHook(hp);
    expect(res.kind).toBe('rea-managed-legacy-v1');
  });

  it('gate-delegating when the file is foreign but invokes `rea hook push-gate`', async () => {
    const hp = path.join(repo, '.git/hooks/pre-push');
    await writeHook(hp, '#!/bin/sh\necho "my custom hook"\nexec rea hook push-gate "$@"\n');
    const res = await classifyExistingHook(hp);
    expect(res.kind).toBe('gate-delegating');
  });

  it('foreign when the file is a lint-only husky hook', async () => {
    const hp = path.join(repo, '.husky/pre-push');
    await writeHook(hp, '#!/bin/sh\npnpm lint\n');
    const res = await classifyExistingHook(hp);
    expect(res.kind).toBe('foreign');
  });

  it('foreign with is-directory when a directory exists at the target', async () => {
    const hp = path.join(repo, '.husky/pre-push');
    await fs.mkdir(hp, { recursive: true });
    const res = await classifyExistingHook(hp);
    expect(res.kind).toBe('foreign');
    if (res.kind === 'foreign') expect(res.reason).toBe('is-directory');
  });

  it('foreign with is-symlink when the target is a symlink', async () => {
    const hp = path.join(repo, '.husky/pre-push');
    const real = path.join(repo, 'real-hook.sh');
    await writeHook(real, '#!/bin/sh\nexit 0\n');
    await fs.mkdir(path.dirname(hp), { recursive: true });
    await fs.symlink(real, hp);
    const res = await classifyExistingHook(hp);
    expect(res.kind).toBe('foreign');
    if (res.kind === 'foreign') expect(res.reason).toBe('is-symlink');
  });
});

// ---------------------------------------------------------------------------
// classifyPrePushInstall
// ---------------------------------------------------------------------------

describe('classifyPrePushInstall — decision tree', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('install when vanilla git + no pre-push exists', async () => {
    const d = await classifyPrePushInstall(repo);
    expect(d.action).toBe('install');
    expect(d.hookPath).toMatch(/\.git\/hooks\/pre-push$/);
  });

  it('refresh when a v2 fallback is already present', async () => {
    const hp = path.join(repo, '.git/hooks/pre-push');
    await writeHook(hp, fallbackHookContent());
    const d = await classifyPrePushInstall(repo);
    expect(d.action).toBe('refresh');
  });

  it('refresh when a legacy v1 fallback is present — upgrade path', async () => {
    const hp = path.join(repo, '.git/hooks/pre-push');
    await writeHook(
      hp,
      `#!/bin/sh\n${LEGACY_FALLBACK_MARKER_V1}\nexec .claude/hooks/push-review-gate.sh "$@"\n`,
    );
    const d = await classifyPrePushInstall(repo);
    expect(d.action).toBe('refresh');
  });

  it('skip + active-pre-push-present when a canonical husky gate lives under hooksPath', async () => {
    await setHooksPath(repo, '.husky');
    const hp = path.join(repo, '.husky', 'pre-push');
    await writeHook(hp, huskyHookContent());
    const d = await classifyPrePushInstall(repo);
    expect(d).toEqual({
      action: 'skip',
      reason: 'active-pre-push-present',
      hookPath: hp,
    });
  });

  it('skip + foreign-pre-push when the active hook is a lint-only husky hook', async () => {
    await setHooksPath(repo, '.husky');
    const hp = path.join(repo, '.husky', 'pre-push');
    await writeHook(hp, '#!/bin/sh\npnpm lint\n');
    const d = await classifyPrePushInstall(repo);
    expect(d).toEqual({
      action: 'skip',
      reason: 'foreign-pre-push',
      hookPath: hp,
    });
  });

  it('skip + active when foreign hook is executable AND delegates to `rea hook push-gate`', async () => {
    await setHooksPath(repo, '.husky');
    const hp = path.join(repo, '.husky', 'pre-push');
    await writeHook(hp, '#!/bin/sh\npnpm lint && exec rea hook push-gate "$@"\n');
    const d = await classifyPrePushInstall(repo);
    expect(d).toEqual({
      action: 'skip',
      reason: 'active-pre-push-present',
      hookPath: hp,
    });
  });
});

// ---------------------------------------------------------------------------
// installPrePushFallback
// ---------------------------------------------------------------------------

describe('installPrePushFallback', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('writes the v2 stub to `.git/hooks/pre-push` in a vanilla repo', async () => {
    const r = await installPrePushFallback({ targetDir: repo });
    expect(r.decision.action).toBe('install');
    expect(r.written).toBeDefined();
    const body = await fs.readFile(r.written!, 'utf8');
    expect(body).toBe(fallbackHookContent());
    const st = await fs.stat(r.written!);
    expect(st.mode & 0o111).not.toBe(0);
  });

  it('refreshes a legacy v1 fallback in place — upgrade migration', async () => {
    const hp = path.join(repo, '.git/hooks/pre-push');
    await writeHook(
      hp,
      `#!/bin/sh\n${LEGACY_FALLBACK_MARKER_V1}\nexec .claude/hooks/push-review-gate.sh "$@"\n`,
    );
    const r = await installPrePushFallback({ targetDir: repo });
    expect(r.decision.action).toBe('refresh');
    const body = await fs.readFile(hp, 'utf8');
    expect(body).toBe(fallbackHookContent());
  });

  it('refuses to overwrite a foreign hook', async () => {
    await setHooksPath(repo, '.husky');
    const hp = path.join(repo, '.husky', 'pre-push');
    const foreign = '#!/bin/sh\npnpm lint\n';
    await writeHook(hp, foreign);
    const r = await installPrePushFallback({ targetDir: repo });
    expect(r.decision.action).toBe('skip');
    expect(r.written).toBeUndefined();
    const body = await fs.readFile(hp, 'utf8');
    expect(body).toBe(foreign);
    expect(r.warnings.some((w) => w.includes('foreign pre-push'))).toBe(true);
  });

  it('is idempotent — running twice leaves the v2 body intact', async () => {
    const r1 = await installPrePushFallback({ targetDir: repo });
    expect(r1.decision.action).toBe('install');
    const body1 = await fs.readFile(r1.written!, 'utf8');
    const r2 = await installPrePushFallback({ targetDir: repo });
    expect(r2.decision.action).toBe('refresh');
    const body2 = await fs.readFile(r2.written!, 'utf8');
    expect(body2).toBe(body1);
  });

  it('concurrent installs serialize via the git-common-dir lock', async () => {
    const [r1, r2] = await Promise.all([
      installPrePushFallback({ targetDir: repo }),
      installPrePushFallback({ targetDir: repo }),
    ]);
    const actions = [r1.decision.action, r2.decision.action].sort();
    expect(actions).toEqual(['install', 'refresh']);
    const finalBody = await fs.readFile(path.join(repo, '.git/hooks/pre-push'), 'utf8');
    expect(finalBody).toBe(fallbackHookContent());
  });
});

// ---------------------------------------------------------------------------
// inspectPrePushState — doctor seam
// ---------------------------------------------------------------------------

describe('inspectPrePushState', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('ok=false when no hook exists anywhere', async () => {
    const s = await inspectPrePushState(repo);
    expect(s.ok).toBe(false);
    expect(s.activeForeign).toBe(false);
  });

  it('ok=true when the active hook is the v2 fallback', async () => {
    await installPrePushFallback({ targetDir: repo });
    const s = await inspectPrePushState(repo);
    expect(s.ok).toBe(true);
    expect(s.activeForeign).toBe(false);
    const active = s.candidates.find((c) => c.path === s.activePath);
    expect(active?.reaManaged).toBe(true);
  });

  it('ok=true when the active husky hook is rea-authored', async () => {
    await setHooksPath(repo, '.husky');
    const hp = path.join(repo, '.husky', 'pre-push');
    await writeHook(hp, huskyHookContent());
    const s = await inspectPrePushState(repo);
    expect(s.ok).toBe(true);
  });

  it('ok=true when a consumer-authored hook delegates to `rea hook push-gate`', async () => {
    await setHooksPath(repo, '.husky');
    const hp = path.join(repo, '.husky', 'pre-push');
    await writeHook(hp, '#!/bin/sh\npnpm lint\nexec rea hook push-gate "$@"\n');
    const s = await inspectPrePushState(repo);
    expect(s.ok).toBe(true);
    const active = s.candidates.find((c) => c.path === s.activePath);
    expect(active?.delegatesToGate).toBe(true);
  });

  it('ok=false + activeForeign=true when a lint-only husky hook squats at the active path', async () => {
    await setHooksPath(repo, '.husky');
    const hp = path.join(repo, '.husky', 'pre-push');
    await writeHook(hp, '#!/bin/sh\npnpm lint\n');
    const s = await inspectPrePushState(repo);
    expect(s.ok).toBe(false);
    expect(s.activeForeign).toBe(true);
  });
});
