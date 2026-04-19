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

  it('hooksPath set and pre-push already present, governance-carrying: skips with active-pre-push-present', async () => {
    // The "happy husky path": hooksPath set, a hook already exists at that
    // path, and the hook wires the shared review gate. Classifier must
    // stand down. A previous version of this test used an opaque
    // `echo existing` body, but that bypasses governance — that case is
    // now covered under the foreign branch below.
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(
      path.join(huskyDir, 'pre-push'),
      '#!/bin/sh\nexec .claude/hooks/push-review-gate.sh "$@"\n',
      { mode: 0o755 },
    );
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', huskyDir]);

    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('active-pre-push-present');
      expect(decision.hookPath).toBe(path.join(huskyDir, 'pre-push'));
    }
  });

  it('hooksPath set with executable non-rea, non-gate pre-push: foreign (NOT active-pre-push-present)', async () => {
    // Finding 1 from Codex post-merge review. The previous implementation
    // skipped on mere existence, so a lint-only husky pre-push would
    // silently bypass the protected-path gate and still pass doctor. Now
    // we demand either the rea marker OR a `.claude/hooks/push-review-gate.sh`
    // reference in the body.
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(
      path.join(huskyDir, 'pre-push'),
      '#!/bin/sh\n# lint-only\nnpx lint-staged\n',
      { mode: 0o755 },
    );
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', huskyDir]);

    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('foreign-pre-push');
    }

    // And the doctor seam must warn, not pass.
    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(false);
    expect(state.activeForeign).toBe(true);
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

  it('marker only on a later line (not anchored): classified as foreign, NOT refresh', async () => {
    // Finding 3 from Codex post-merge review. Substring-matching the
    // FALLBACK_MARKER misclassifies any file that merely mentions the
    // sentinel (a consumer comment, a grep log fragment, a migration
    // note). The anchored check requires the marker to sit on the second
    // line, immediately after `#!/bin/sh\n`. Anything else is foreign —
    // which means `rea init` must NOT overwrite it.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      // Shebang, consumer comment on line 2, marker buried on line 3.
      // Under the old substring rule this was (wrongly) "rea-managed".
      `#!/bin/sh\n# sacred consumer hook — do not touch\n${FALLBACK_MARKER}\nexec /bin/true\n`,
      { mode: 0o755 },
    );

    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('foreign-pre-push');
    }
  });

  it('alternate shebang (#!/usr/bin/env sh) + rea marker: still foreign', async () => {
    // Defense-in-depth: the anchor is byte-exact and deliberately does
    // not tolerate alternate shebangs. If rea ever needs to support
    // `#!/usr/bin/env sh` output, bump the marker version and migrate
    // explicitly; do not let the classifier widen silently.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      `#!/usr/bin/env sh\n${FALLBACK_MARKER}\nexec /bin/true\n`,
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

  it('executable foreign pre-push without gate reference: ok=false, activeForeign=true', async () => {
    // Finding 1 (doctor side). `rea doctor` needs to distinguish "nothing
    // there" from "something there that silently bypasses governance" so
    // it can surface the warn variant instead of a green pass.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      '#!/bin/sh\nnpx lint-staged\n',
      { mode: 0o755 },
    );

    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(false);
    expect(state.activeForeign).toBe(true);
    expect(state.activePath).toBe(path.join(hooksDir, 'pre-push'));
    const active = state.candidates.find(
      (c) => c.path === path.join(hooksDir, 'pre-push'),
    );
    expect(active?.exists).toBe(true);
    expect(active?.executable).toBe(true);
    expect(active?.reaManaged).toBe(false);
    expect(active?.delegatesToGate).toBe(false);
  });

  it('executable foreign pre-push that DOES delegate to gate: ok=true', async () => {
    // Legitimate integration — a consumer wrote their own lint-then-exec
    // wrapper. Must not be warned.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      '#!/bin/sh\nnpx lint-staged\nexec .claude/hooks/push-review-gate.sh "$@"\n',
      { mode: 0o755 },
    );

    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(true);
    expect(state.activeForeign).toBe(false);
    const active = state.candidates.find(
      (c) => c.path === path.join(hooksDir, 'pre-push'),
    );
    expect(active?.delegatesToGate).toBe(true);
    expect(active?.reaManaged).toBe(false);
  });
});

describe('installPrePushFallback — concurrency + temp-file hygiene', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepush-cc-')),
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('cleans up stale `.rea-tmp-*` siblings on install entry', async () => {
    // Finding 4. A crash between writeFile and rename would leave a
    // predictable `${dst}.rea-tmp-${pid}` sibling at 0o755 perms. Random
    // suffixes make the filename unpredictable, and we proactively unlink
    // any siblings on entry so they don't accumulate across runs.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const stray1 = path.join(hooksDir, 'pre-push.rea-tmp-stale-1');
    const stray2 = path.join(hooksDir, 'pre-push.rea-tmp-stale-2');
    await fs.writeFile(stray1, '#!/bin/sh\n# stale\n', { mode: 0o755 });
    await fs.writeFile(stray2, '#!/bin/sh\n# stale\n', { mode: 0o755 });

    const result = await installPrePushFallback(dir);
    expect(result.decision.action).toBe('install');

    // After a successful install, both stray temps must be gone and only
    // a single `pre-push` must remain.
    await expect(fs.stat(stray1)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(stray2)).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await fs.readdir(hooksDir);
    expect(entries.filter((e) => e.startsWith('pre-push.rea-tmp-'))).toEqual([]);
  });

  it('race: file appears between classify and write → no stomp, no throw', async () => {
    // Finding 2 (TOCTOU). Simulate the window by having the test drop a
    // foreign file at the classified path between the classify and the
    // re-resolution/write steps. The installer must re-check, abort the
    // write, preserve the foreign content, and return a clean skip.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const foreignBody = '#!/bin/sh\n# raced consumer hook\nexit 0\n';

    const result = await installPrePushFallback(dir, {
      onBeforeReresolve: async (hookPath) => {
        // Classifier saw no file and chose `install`. Drop one now.
        await fs.writeFile(hookPath, foreignBody, { mode: 0o755 });
      },
    });

    // Installer must refuse to clobber the raced-in file.
    expect(result.written).toBeUndefined();
    expect(result.decision.action).toBe('skip');
    const after = await fs.readFile(
      path.join(hooksDir, 'pre-push'),
      'utf8',
    );
    expect(after).toBe(foreignBody);
  });

  it('race: rea-managed file replaced by foreign between classify and refresh → no stomp', async () => {
    // Same TOCTOU shape but the classifier saw a refresh candidate. A
    // consumer (or second process) swaps the file for something of their
    // own before the write. Installer must notice on re-check and skip.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-push');
    await fs.writeFile(
      hookPath,
      `#!/bin/sh\n${FALLBACK_MARKER}\nexec /bin/true\n`,
      { mode: 0o755 },
    );

    const foreignBody = '#!/bin/sh\n# raced consumer hook\nexit 0\n';
    const result = await installPrePushFallback(dir, {
      onBeforeReresolve: async (p) => {
        await fs.writeFile(p, foreignBody, { mode: 0o755 });
      },
    });

    expect(result.written).toBeUndefined();
    expect(result.decision.action).toBe('skip');
    const after = await fs.readFile(hookPath, 'utf8');
    expect(after).toBe(foreignBody);
  });

  it('concurrent installs serialize via advisory lock: one writes, one refreshes, no collisions', async () => {
    // Finding 4 again, at the integration level. Two back-to-back calls
    // in-process used to collide on the PID-based tmp filename. With
    // randomized suffixes + advisory lock + `wx` open flag, both runs
    // complete cleanly: the first installs, the second refreshes, and
    // the hooks directory contains exactly one pre-push with no lingering
    // tmp siblings.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });

    const results = await Promise.all([
      installPrePushFallback(dir),
      installPrePushFallback(dir),
    ]);

    for (const r of results) {
      expect(['install', 'refresh']).toContain(r.decision.action);
      expect(r.written).toBe(path.join(hooksDir, 'pre-push'));
    }

    const entries = await fs.readdir(hooksDir);
    expect(entries.filter((e) => e === 'pre-push')).toEqual(['pre-push']);
    expect(entries.filter((e) => e.startsWith('pre-push.rea-tmp-'))).toEqual([]);

    // Final content carries our anchored marker.
    const content = await fs.readFile(path.join(hooksDir, 'pre-push'), 'utf8');
    expect(content.startsWith(`#!/bin/sh\n${FALLBACK_MARKER}\n`)).toBe(true);
  });
});
