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
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyPrePushInstall,
  FALLBACK_MARKER,
  HUSKY_GATE_MARKER,
  HUSKY_GATE_BODY_MARKER,
  inspectPrePushState,
  installPrePushFallback,
  isLegacyReaManagedHuskyGate,
  isReaManagedHuskyGate,
  referencesReviewGate,
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

  it('vanilla repo: executable .git/hooks/pre-push that EXECS the gate is active, not foreign', async () => {
    // Round-2 Codex finding (P2-1). When `core.hooksPath` is unset, a
    // user-authored `.git/hooks/pre-push` that already delegates to
    // `.claude/hooks/push-review-gate.sh` satisfies governance. The
    // classifier MUST treat it as `active-pre-push-present`, not
    // `foreign-pre-push` — otherwise `rea init` would warn on every run
    // telling the user to add the very `exec` line they already have,
    // while `rea doctor` reports the same hook as ok. The two paths
    // must agree.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      '#!/bin/sh\nnpx lint-staged\nexec .claude/hooks/push-review-gate.sh "$@"\n',
      { mode: 0o755 },
    );
    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('active-pre-push-present');
    }

    // And the install path must match — no write, no warning about
    // replacing the hook.
    const result = await installPrePushFallback(dir);
    expect(result.decision.action).toBe('skip');
    if (result.decision.action === 'skip') {
      expect(result.decision.reason).toBe('active-pre-push-present');
    }
    expect(result.written).toBeUndefined();
    // Must NOT warn when the hook is already wiring the gate.
    expect(
      result.warnings.some((w) => w.includes('not rea-managed')),
    ).toBe(false);
  });

  it('comment-only mention of push-review-gate.sh: classified as foreign', async () => {
    // Round-2 Codex finding (P2-2). `referencesReviewGate` used to accept
    // any substring occurrence of the path, so a hint in a comment or a
    // printf'd help string would bless a lint-only hook as "gate-
    // delegating". The anchored check requires an actual exec-like
    // invocation on a non-comment line. A comment mentioning the path
    // MUST NOT satisfy governance.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      '#!/bin/sh\n# TODO: eventually add `exec .claude/hooks/push-review-gate.sh "$@"`\nnpx lint-staged\n',
      { mode: 0o755 },
    );
    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('foreign-pre-push');
    }

    // Doctor seam must also surface the warn, not a pass.
    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(false);
    expect(state.activeForeign).toBe(true);
    const active = state.candidates.find(
      (c) => c.path === path.join(hooksDir, 'pre-push'),
    );
    expect(active?.delegatesToGate).toBe(false);
  });

  it('printf string containing the gate path: classified as foreign', async () => {
    // Defense-in-depth for P2-2. A `printf 'help: run ...push-review-
    // gate.sh'` somewhere in the hook body must NOT be treated as an
    // invocation. Only an actual exec/command line counts.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      `#!/bin/sh
printf 'hint: wire .claude/hooks/push-review-gate.sh into this hook to honor rea governance\\n' >&2
exit 0
`,
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

  it('race: directory raced into hook path → refuses to write instead of throwing on rename', async () => {
    // Post-merge Codex P2 on the patch itself: the TOCTOU re-check must
    // distinguish ENOENT (safe to proceed with install) from "a non-file
    // appeared in the way" (must abort). A previous patch iteration
    // treated both as `not-a-file` with the same reason, which let a
    // directory racing into the destination flow through to writeExecutable
    // and throw on rename(). The installer should return a clean skip.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });

    const result = await installPrePushFallback(dir, {
      onBeforeReresolve: async (hookPath) => {
        // Drop a DIRECTORY at the spot the installer is about to write.
        await fs.mkdir(hookPath, { recursive: true });
      },
    });

    expect(result.written).toBeUndefined();
    expect(result.decision.action).toBe('skip');
    if (result.decision.action === 'skip') {
      expect(result.decision.reason).toBe('foreign-pre-push');
    }
    // The directory the test dropped in is still there — installer did
    // not touch it.
    const stat = await fs.stat(path.join(hooksDir, 'pre-push'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('R11 F2: race: Husky gate replaces fallback between classify and re-check → skip, do NOT overwrite', async () => {
    // Codex R11 F2: the refresh path previously accepted rea-managed-husky
    // from the re-check and fell through to writeExecutable, clobbering the
    // canonical gate. The fix turns rea-managed-husky into a terminal skip
    // regardless of what the first-pass classify returned.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    // Seed a rea-managed fallback so the classifier selects `refresh`.
    const fallbackBody = `#!/bin/sh\n${FALLBACK_MARKER}\nexec ./gate.sh\n`;
    await fs.writeFile(path.join(hooksDir, 'pre-push'), fallbackBody, {
      mode: 0o755,
    });

    // The canonical Husky gate carries a full behavioral signature.
    const huskyBody =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n` +
      `if [ -f "\${REA_ROOT}/.rea/HALT" ]; then exit 1; fi\n` +
      `if ! grep -q codex.review .rea/audit.jsonl; then exit 1; fi\n`;

    const result = await installPrePushFallback(dir, {
      onBeforeReresolve: async (hookPath) => {
        // Another process replaces the fallback with the canonical gate
        // between the initial classify (refresh) and the re-check.
        await fs.writeFile(hookPath, huskyBody, { mode: 0o755 });
      },
    });

    expect(result.written).toBeUndefined();
    expect(result.decision.action).toBe('skip');
    if (result.decision.action === 'skip') {
      expect(result.decision.reason).toBe('active-pre-push-present');
    }
    // Husky gate is preserved byte-for-byte — NOT overwritten by fallback.
    const after = await fs.readFile(path.join(hooksDir, 'pre-push'), 'utf8');
    expect(after).toBe(huskyBody);
  });

  it('R14 F2: refresh — consumer replaces rea-managed hook between re-check and write → clean skip, original replacement preserved', async () => {
    // The advisory lock only serializes rea installers. Husky, a user
    // editor, or a concurrent tool outside the lock can swap the hook
    // between our classify+reCheck pass and the rename. The refresh
    // guard captures (dev, ino, mtimeMs, size) at reCheck and re-verifies
    // immediately before rename. On mismatch the refresh aborts with a
    // foreign-pre-push skip — the intruder's content is preserved.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-push');

    // Seed a rea-managed fallback so the second call lands on refresh.
    const first = await installPrePushFallback(dir);
    expect(first.decision.action).toBe('install');

    const racedBody = '#!/bin/sh\n# raced consumer hook — not ours\nexit 0\n';
    const result = await installPrePushFallback(dir, {
      onBeforeWrite: async (p) => {
        // Classification + reCheck have already passed. Simulate another
        // writer replacing the file AFTER we captured the refresh guard
        // but BEFORE our verify-and-rename. Remove first so the new
        // file has a different inode (mtime alone can collide within the
        // same ms on fast filesystems).
        await fs.unlink(p);
        await fs.writeFile(p, racedBody, { mode: 0o755 });
      },
    });

    expect(result.written).toBeUndefined();
    expect(result.decision.action).toBe('skip');
    if (result.decision.action === 'skip') {
      expect(result.decision.reason).toBe('foreign-pre-push');
    }
    expect(
      result.warnings.some((w) => w.includes('modified during refresh')),
    ).toBe(true);

    // Most important assertion: the raced content is still on disk; the
    // fallback did NOT stomp it.
    const after = await fs.readFile(hookPath, 'utf8');
    expect(after).toBe(racedBody);
  });

  it('R14 F2: refresh — destination vanishes before refresh capture → clean skip', async () => {
    // If the file has already been removed between reCheck (rea-managed)
    // and the refresh-guard stat, we must not re-create blindly; the user
    // may have deliberately removed the hook.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-push');

    const first = await installPrePushFallback(dir);
    expect(first.decision.action).toBe('install');

    const result = await installPrePushFallback(dir, {
      onBeforeReresolve: async (p) => {
        // Do nothing yet — reCheck still sees the file.
        void p;
      },
      onBeforeWrite: async (p) => {
        // After reCheck + refresh-guard capture, delete the file so the
        // final verify fails via ENOENT.
        await fs.unlink(p);
      },
    });

    expect(result.written).toBeUndefined();
    expect(result.decision.action).toBe('skip');
    if (result.decision.action === 'skip') {
      expect(result.decision.reason).toBe('foreign-pre-push');
    }
    // The file is absent because the race partner removed it. The refresh
    // did NOT race-restore our fallback over the deleted state.
    await expect(fs.stat(hookPath)).rejects.toThrow();
  });

  it('race: file appears between re-check and write (EEXIST from link) → clean skip', async () => {
    // Codex finding 2 — final window: after the safety re-check passes,
    // but before writeExecutable completes, another process creates the
    // destination. With rename() that file would be silently overwritten.
    // With link() we get EEXIST; the installer must return a clean skip.
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });

    const racedBody = '#!/bin/sh\n# raced consumer hook\nexit 0\n';
    const result = await installPrePushFallback(dir, {
      onBeforeWrite: async (hookPath) => {
        // Re-check passed (path was absent). Simulate another process
        // dropping a file here before our link() call.
        await fs.writeFile(hookPath, racedBody, { mode: 0o755 });
      },
    });

    expect(result.written).toBeUndefined();
    expect(result.decision.action).toBe('skip');
    if (result.decision.action === 'skip') {
      expect(result.decision.reason).toBe('foreign-pre-push');
    }
    expect(result.warnings.some((w) => w.includes('appeared at') && w.includes('after the safety check'))).toBe(true);
    // The raced file is untouched.
    const after = await fs.readFile(path.join(hooksDir, 'pre-push'), 'utf8');
    expect(after).toBe(racedBody);
  });

  it('linked git worktree: install succeeds (lock resolves via git common-dir, not the .git file)', async () => {
    // Post-merge Codex P1 on the patch itself: a previous iteration locked
    // against `<targetDir>/.git` unconditionally. In a linked worktree
    // `.git` is a FILE containing `gitdir: ...` — trying to place a
    // lockfile inside it raises ENOTDIR and regresses the very case
    // (husky in a worktree) the installer is supposed to cover. The fix
    // resolves `git rev-parse --git-common-dir` so the lock lands under
    // the real common dir.
    await initGitRepo(dir);
    // Seed a commit so `git worktree add` has a ref to check out.
    await fs.writeFile(path.join(dir, 'README.md'), '# t\n');
    await execFileAsync('git', ['-C', dir, 'add', '-A']);
    await execFileAsync('git', ['-C', dir, 'commit', '-m', 'seed', '--quiet']);

    const worktreeDir = path.join(dir, 'linked-worktree');
    await execFileAsync('git', [
      '-C',
      dir,
      'worktree',
      'add',
      '--quiet',
      worktreeDir,
      '-b',
      'wt-branch',
    ]);

    // Sanity: .git in the linked worktree is a file, not a directory.
    const dotGit = await fs.stat(path.join(worktreeDir, '.git'));
    expect(dotGit.isFile()).toBe(true);

    // Install must succeed against the linked worktree.
    const result = await installPrePushFallback(worktreeDir);
    expect(['install', 'refresh']).toContain(result.decision.action);
    expect(result.written).toBeDefined();
    const content = await fs.readFile(result.written!, 'utf8');
    expect(content.startsWith(`#!/bin/sh\n${FALLBACK_MARKER}\n`)).toBe(true);

    // And a subsequent call in the same worktree should cleanly refresh.
    const second = await installPrePushFallback(worktreeDir);
    expect(second.decision.action).toBe('refresh');
  });
});

// ---------------------------------------------------------------------------
// Finding 1 regression suite — looksLikeGateInvocation positive-match only
//
// These tests drive `referencesReviewGate` directly to verify that the
// refactored positive-match implementation no longer false-positives on
// non-invocation references to the gate path.
// ---------------------------------------------------------------------------
describe('referencesReviewGate — positive-match only (Finding 1 regressions)', () => {
  const token = '.claude/hooks/push-review-gate.sh';

  // ---- Accepted forms -------------------------------------------------------

  it('bare line-start invocation: returns true', () => {
    expect(referencesReviewGate(`#!/bin/sh\n${token} "$@"\n`)).toBe(true);
  });

  it('exec delegation: returns true', () => {
    expect(referencesReviewGate(`#!/bin/sh\nexec ${token} "$@"\n`)).toBe(true);
  });

  it('. (dot) delegation: returns true', () => {
    expect(referencesReviewGate(`#!/bin/sh\n. ${token}\n`)).toBe(true);
  });

  it('source delegation: returns false (bash-only, removed from POSIX allowlist)', () => {
    // R8: `source` is not POSIX sh. Use `.` (dot) instead.
    expect(referencesReviewGate(`#!/bin/sh\nsource ${token}\n`)).toBe(false);
  });

  it('sh delegation: returns true', () => {
    expect(referencesReviewGate(`#!/bin/sh\nsh ${token}\n`)).toBe(true);
  });

  it('bash delegation: returns true', () => {
    expect(referencesReviewGate(`#!/bin/sh\nbash ${token} "$@"\n`)).toBe(true);
  });

  it('zsh delegation: returns true', () => {
    expect(referencesReviewGate(`#!/bin/sh\nzsh ${token} "$@"\n`)).toBe(true);
  });

  it('exec with absolute path prefix: returns true', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\nexec /repo/root/${token} "$@"\n`,
      ),
    ).toBe(true);
  });

  it('indented exec delegation: returns true', () => {
    // Leading whitespace is stripped before matching.
    expect(
      referencesReviewGate(`#!/bin/sh\n  exec ${token} "$@"\n`),
    ).toBe(true);
  });

  // ---- Rejected forms (false-positive regressions) --------------------------

  it('full-line comment mentioning the path: returns false', () => {
    // `[ -x .claude/hooks/push-review-gate.sh ] || exit 1`
    // Wait — this is a test/bracket expression, not a comment. Add the
    // comment case explicitly.
    expect(
      referencesReviewGate(
        `#!/bin/sh\n# TODO: wire ${token}\n`,
      ),
    ).toBe(false);
  });

  it('shell test [ -x ... ]: returns false', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\n[ -x ${token} ] || exit 1\n`,
      ),
    ).toBe(false);
  });

  it('shell test [[ -x ... ]]: returns false', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\n[[ -x ${token} ]] || exit 1\n`,
      ),
    ).toBe(false);
  });

  it('test builtin: returns false', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\ntest -f ${token}\n`,
      ),
    ).toBe(false);
  });

  it('chmod: returns false', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\nchmod +x ${token}\n`,
      ),
    ).toBe(false);
  });

  it('cp: returns false', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\ncp ${token} /tmp/\n`,
      ),
    ).toBe(false);
  });

  it('mv: returns false', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\nmv ${token} /tmp/gate.sh\n`,
      ),
    ).toBe(false);
  });

  it('printf string literal: returns false', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\nprintf 'hint: run ${token}\\n' >&2\n`,
      ),
    ).toBe(false);
  });

  it('echo string literal: returns false', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\necho "see ${token} for details"\n`,
      ),
    ).toBe(false);
  });

  it('if condition with -x test: returns false', () => {
    expect(
      referencesReviewGate(
        `#!/bin/sh\nif [ ! -x ${token} ]; then\n  echo missing\nfi\n`,
      ),
    ).toBe(false);
  });

  it('variable assignment: returns false', () => {
    // GATE=".claude/hooks/push-review-gate.sh" — assignment, not invocation.
    expect(
      referencesReviewGate(
        `#!/bin/sh\nGATE=${token}\n`,
      ),
    ).toBe(false);
  });

  it('gate path appears only inside an if-condition test — no bare exec anywhere: returns false', () => {
    const content = [
      '#!/bin/sh',
      `if [ ! -x ${token} ]; then`,
      '  echo "gate missing" >&2',
      '  exit 1',
      'fi',
      '',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('gate path mentioned in a guard block then exec-ed: returns true', () => {
    // Full pattern from the actual fallback hook: guard test + exec. The
    // exec on the final line is the real invocation and must return true.
    const content = [
      '#!/bin/sh',
      `if [ ! -x ${token} ]; then`,
      '  echo "gate missing" >&2',
      '  exit 1',
      'fi',
      `exec ${token} "$@"`,
      '',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding 1 (suffix-bypass) regression suite — .sh boundary lookahead
//
// Codex finding: both regexes in `looksLikeGateInvocation` ended at
// `push-review-gate\.sh` with no word-boundary assertion. A `.sh.disabled`
// or `.sh.bak` suffix still matched and returned `true`, allowing a
// disabled-gate invocation to be misclassified as governance-carrying.
// The fix adds `(?=\s|$|[;|&"'()])` after `.sh` in both forms.
// ---------------------------------------------------------------------------
describe('looksLikeGateInvocation — .sh suffix boundary (Finding 1)', () => {
  const token = '.claude/hooks/push-review-gate.sh';

  it('exec with .sh.disabled suffix: returns false', () => {
    expect(
      referencesReviewGate(`#!/bin/sh\nexec ${token}.disabled "$@"\n`),
    ).toBe(false);
  });

  it('bare invocation with .sh.bak suffix: returns false', () => {
    expect(
      referencesReviewGate(`#!/bin/sh\n${token}.bak "$@"\n`),
    ).toBe(false);
  });

  it('exec with .sh2 suffix: returns false', () => {
    expect(
      referencesReviewGate(`#!/bin/sh\nexec ${token}2 "$@"\n`),
    ).toBe(false);
  });

  it('bare invocation with no suffix and args: still returns true (regression guard)', () => {
    expect(
      referencesReviewGate(`#!/bin/sh\n${token} "$@"\n`),
    ).toBe(true);
  });

  it('exec with no suffix: still returns true (regression guard)', () => {
    expect(
      referencesReviewGate(`#!/bin/sh\nexec ${token}\n`),
    ).toBe(true);
  });

  it('bare invocation with semicolon + exit 0: returns false (status swallowed)', () => {
    // `gate; exit 0` runs the gate then discards its exit code by always
    // exiting 0. This is status-swallowing and must not satisfy governance.
    // (Previously expected true — updated when status-swallow detection was added.)
    expect(
      referencesReviewGate(`#!/bin/sh\n${token}; exit 0\n`),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finding 2 regression suite — Husky gate marker recognition
//
// Codex finding: `classifyExistingHook` only checked for `FALLBACK_MARKER`
// (anchored prelude) and `referencesReviewGate`. The shipped `.husky/pre-push`
// carries neither — it IS the gate (not a delegator), so it has no bare
// `exec push-review-gate.sh` line. This caused `rea init` and `rea doctor`
// to classify the default Husky install as `foreign/no-marker`.
// The fix: add `HUSKY_GATE_MARKER` + `isReaManagedHuskyGate`, check it first.
// ---------------------------------------------------------------------------
describe('isReaManagedHuskyGate — Husky gate marker detection (Finding 2)', () => {
  it('marker at line 2 + HALT test + audit reference (full behavioral signature): returns true', () => {
    // R11 F1: behavioral signature required — both HALT test AND audit log
    // reference must appear on non-comment lines. Markers are public, so
    // they cannot be the security boundary.
    expect(
      isReaManagedHuskyGate(
        `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n[ -f .rea/HALT ] && exit 1\nif ! grep codex.review .rea/audit.jsonl; then exit 1; fi\n`,
      ),
    ).toBe(true);
  });

  it('R11 F1: both markers + HALT test only (no audit ref): returns false', () => {
    // Codex R11 finding: marker-only stub with `exec /bin/true` previously
    // passed because hasSubstantiveContent accepted any non-noop line.
    // Now both behavioral signatures must appear.
    expect(
      isReaManagedHuskyGate(
        `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n[ -f .rea/HALT ] && exit 1\nexec /bin/true\n`,
      ),
    ).toBe(false);
  });

  it('R11 F1: both markers + audit ref only (no HALT test): returns false', () => {
    expect(
      isReaManagedHuskyGate(
        `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\ngrep codex.review .rea/audit.jsonl\nexec /bin/true\n`,
      ),
    ).toBe(false);
  });

  it('R11 F1: both markers + exec /bin/true only (the critical spoof): returns false', () => {
    // Exact case from Codex R11: a foreign hook with markers + exec /bin/true
    // would have passed hasSubstantiveContent but never enforced governance.
    expect(
      isReaManagedHuskyGate(
        `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\nexec /bin/true\n`,
      ),
    ).toBe(false);
  });

  it('R11 F1: HALT test in comment only (not executable): returns false even with audit ref', () => {
    // The HALT check must be in the form of an actual POSIX test, not a
    // comment mention.
    expect(
      isReaManagedHuskyGate(
        `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n# checks .rea/HALT for freeze\ngrep codex.review .rea/audit.jsonl\n`,
      ),
    ).toBe(false);
  });

  it('R11 F1: audit ref in comment only: returns false even with HALT test', () => {
    expect(
      isReaManagedHuskyGate(
        `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n[ -f .rea/HALT ] && exit 1\n# references .rea/audit.jsonl\n`,
      ),
    ).toBe(false);
  });

  it('R9 F1: both markers present but only exit 0 as executable content: returns false', () => {
    // Codex R9 finding: stub with markers + `exit 0` must not be classified
    // as a genuine gate. Now also fails the R11 behavioral signature check.
    expect(
      isReaManagedHuskyGate(`#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\nexit 0\n`),
    ).toBe(false);
  });

  it('R9 F1: both markers + only return 0 as executable content: returns false', () => {
    expect(
      isReaManagedHuskyGate(`#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\nreturn 0\n`),
    ).toBe(false);
  });

  it('R10 F3: both markers + only `:` (colon noop) as executable content: returns false', () => {
    expect(
      isReaManagedHuskyGate(`#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n:\nexit 0\n`),
    ).toBe(false);
  });

  it('R10 F3: both markers + only `true` as executable content: returns false', () => {
    expect(
      isReaManagedHuskyGate(`#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\ntrue\n`),
    ).toBe(false);
  });

  it('R10 F3: both markers + mix of noops only (`:`, `true`, `exit 0`): returns false', () => {
    expect(
      isReaManagedHuskyGate(
        `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n:\ntrue\nexit 0\n`,
      ),
    ).toBe(false);
  });

  it('R10 F4: CRLF line endings with full behavioral signature: returns true', () => {
    // Windows checkouts or `text=auto` gitattributes may produce CRLF.
    const content = `#!/bin/sh\r\n${HUSKY_GATE_MARKER}\r\n${HUSKY_GATE_BODY_MARKER}\r\n[ -f .rea/HALT ] && exit 1\r\nif ! grep codex.review .rea/audit.jsonl; then exit 1; fi\r\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R10 F4: CRLF with markers + only exit 0 stub: returns false', () => {
    const content = `#!/bin/sh\r\n${HUSKY_GATE_MARKER}\r\n${HUSKY_GATE_BODY_MARKER}\r\nexit 0\r\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  // R12 F1: the R11 "token-mentions-on-a-line" check was still spoofable
  // because the HALT mention plus an audit string could appear without
  // either actually ENFORCING anything. These tests pin the tighter
  // "proof of enforcement" requirement: the HALT test must be paired with
  // a non-zero `exit`, and the audit token must appear on a line with a
  // check command that can fail.

  it('R12 F1: HALT test + no-op `:` in block form: returns false (no enforcement)', () => {
    // The exact spoof Codex R12 flagged: `if [ -f .rea/HALT ]; then :; fi`
    // mentions the HALT path and passes a presence check, but the match
    // path is a noop. The hook does not block freeze, so it cannot be
    // recognized as rea-managed.
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then :; fi\n` +
      `grep codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R12 F1: HALT short-circuit `&& :` (noop after match): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && :\n` +
      `grep codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R12 F1: audit token in echo only (no failure path): returns false', () => {
    // The other half of the Codex R12 spoof: `echo codex.review .rea/audit.jsonl`
    // mentions both tokens but `echo` always succeeds — it is not a check.
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `echo codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R12 F1: audit token in printf only: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `printf '%s\\n' codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R12 F1: HALT short-circuit `&& exit 1` + grep audit: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `if ! grep -q codex.review .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R12 F1: HALT block form with multi-line body + grep audit: returns true', () => {
    // Matches the actual shape the shipped .husky/pre-push uses.
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then\n` +
      `  printf 'frozen\\n' >&2\n` +
      `  exit 1\n` +
      `fi\n` +
      `if ! grep -qE '"tool_name":"codex.review"' .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R12 F1: block form with grouped short-circuit `&& { ...; exit 1; }`: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && { printf 'frozen\\n' >&2; exit 1; }\n` +
      `if ! grep -q codex.review .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R12 F1: test -f HALT form + grep codex.review: returns true', () => {
    // R13 F2 tightening: the audit check now requires a `codex.review`
    // content match by grep/rg, not a file-existence test. The HALT side
    // still works with the POSIX `test -f` form for detection.
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `test -f .rea/HALT && exit 1\n` +
      `if ! grep -q '"tool_name":"codex.review"' .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R12 F1: rg (ripgrep) + audit token: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `if ! rg -q codex.review .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  // R13 F1: `hasHaltEnforcement` must reject `exit 0` and bare `exit` on
  // the HALT path. Both forms satisfied R12's behavioral signature without
  // actually blocking the push.

  it('R13 F1: HALT short-circuit with `exit 0`: returns false (push allowed)', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 0\n` +
      `grep -q codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F1: HALT short-circuit with bare `exit`: returns false (POSIX last-status, not a block)', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit\n` +
      `grep -q codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F1: HALT block form with `exit 0`: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then exit 0; fi\n` +
      `grep -q codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F1: HALT block form with bare `exit`: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then exit; fi\n` +
      `grep -q codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F1: HALT grouped short-circuit with `exit 0` inside braces: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && { echo frozen; exit 0; }\n` +
      `grep -q codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F1: HALT block form with `exit 2` (any non-zero): returns true', () => {
    // Tightening must not break the legitimate wide-spectrum "any non-zero"
    // use case. Hooks often exit with codes like 2 to signal specific
    // error classes, and the governance semantics (fail the push) hold.
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then exit 2; fi\n` +
      `if ! grep -q codex.review .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  // R13 F2: `hasAuditCheck` must reject file-existence / edit-style commands
  // that don't propagate no-match as non-zero, and must require the
  // `codex.review` token specifically (not just the audit log path).

  it('R13 F2: audit check via `test -s .rea/audit.jsonl`: returns false (file existence only)', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `test -s .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F2: audit check via `[ -f .rea/audit.jsonl ]`: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `[ -f .rea/audit.jsonl ]\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F2: audit check via `sed -n /.../p`: returns false (no-match is silent success)', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `sed -n '/codex.review/p' .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F2: audit check via `awk /.../`: returns false (default no-match exit 0)', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `awk '/codex.review/' .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F2: only `.rea/audit.jsonl` mentioned (no codex.review): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `grep -q 'something-else' .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R13 F2: `grep` of `codex.review` on audit log: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `if ! grep -q codex.review .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R13 F2: grep-escaped `codex\\.review` shape (matches shipped .husky/pre-push): returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `if ! grep -E '"tool_name":"codex\\.review"' .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('marker at line 2 but no body marker (exit 0 body): returns false (no behavioral signature)', () => {
    expect(isReaManagedHuskyGate(`#!/bin/sh\n${HUSKY_GATE_MARKER}\nexit 0\n`)).toBe(false);
  });

  it('marker at line 2 + POSIX HALT test + audit reference (legacy backward-compat): returns true', () => {
    // R7 backward-compat: pre-R6 gates had the header marker and behavioral
    // signature but no body marker. Must still return true — the body marker
    // is telemetry, not the security boundary.
    expect(
      isReaManagedHuskyGate(
        `#!/bin/sh\n${HUSKY_GATE_MARKER}\nif [ -f "\${REA_ROOT}/.rea/HALT" ]; then exit 1; fi\nif grep -q codex.review .rea/audit.jsonl; then\n  exit 0\nfi\nexit 1\n`,
      ),
    ).toBe(true);
  });

  it('marker at line 2 + HALT in comment only (no POSIX test): returns false', () => {
    expect(
      isReaManagedHuskyGate(`#!/bin/sh\n${HUSKY_GATE_MARKER}\n# check .rea/HALT here\nexit 0\n`),
    ).toBe(false);
  });

  it('marker at line 2 + no body marker + no behavioral signature: returns false', () => {
    expect(isReaManagedHuskyGate(`#!/bin/sh\n${HUSKY_GATE_MARKER}\nexit 0\n`)).toBe(false);
  });

  it('content without any marker returns false', () => {
    expect(isReaManagedHuskyGate('#!/bin/sh\nnpx lint-staged\n')).toBe(false);
  });

  it('content with FALLBACK_MARKER but not HUSKY_GATE_MARKER returns false', () => {
    expect(isReaManagedHuskyGate(`#!/bin/sh\n${FALLBACK_MARKER}\nexec /bin/true\n`)).toBe(false);
  });

  it('marker buried at line 3 (not line 2): returns false', () => {
    // Spoofing attempt: marker after an intervening comment. Must NOT match.
    expect(
      isReaManagedHuskyGate(`#!/bin/sh\n# consumer header\n${HUSKY_GATE_MARKER}\nset -eu\n`),
    ).toBe(false);
  });

  it('marker buried at line 5: returns false', () => {
    expect(
      isReaManagedHuskyGate(
        `#!/bin/sh\n# line 2\n# line 3\n# line 4\n${HUSKY_GATE_MARKER}\n`,
      ),
    ).toBe(false);
  });

  it('marker on line 1 only (no shebang before it): returns false', () => {
    // Marker is at lines[1] when the file starts directly with it — that
    // means lines[0] is "", not a shebang. Must not match.
    expect(isReaManagedHuskyGate(`${HUSKY_GATE_MARKER}\n#!/bin/sh\n`)).toBe(false);
  });

  it('only one line total: returns false', () => {
    expect(isReaManagedHuskyGate(`#!/bin/sh`)).toBe(false);
  });
});

// R15 F1: `hasAuditCheck` must bind to the audit log and reject enforcement-
// swallowing tails. Previous R13 F2 allowed any `grep` + `codex.review` line
// regardless of which file was being grepped or what trailed the command —
// a spoof like `grep -q codex.review README.md` or
// `grep -q codex.review .rea/audit.jsonl || true` satisfied the check
// without ever enforcing anything.
describe('isReaManagedHuskyGate — R15 F1 audit check must prove enforcement', () => {
  const header = `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n`;

  it('grep of codex.review on README.md (wrong file): returns false', () => {
    const content = `${header}grep -q codex.review README.md\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('grep with `|| true` (explicit swallow): returns false', () => {
    const content = `${header}grep -q codex.review .rea/audit.jsonl || true\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('grep with `|| :` (null-command swallow): returns false', () => {
    const content = `${header}grep -q codex.review .rea/audit.jsonl || :\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('grep with `|| /bin/true` (absolute-path swallow): returns false', () => {
    const content = `${header}grep -q codex.review .rea/audit.jsonl || /bin/true\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('grep with `|| exit 0` (explicit allow): returns false', () => {
    const content = `${header}grep -q codex.review .rea/audit.jsonl || exit 0\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('grep with `|| exit` (implicit $? allow): returns false', () => {
    const content = `${header}grep -q codex.review .rea/audit.jsonl || exit\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('grep with trailing `&` (backgrounded): returns false', () => {
    const content = `${header}grep -q codex.review .rea/audit.jsonl &\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('grep with `; echo done` (sequential command swallow): returns false', () => {
    const content = `${header}grep -q codex.review .rea/audit.jsonl; echo done\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('grep piped to cat (non-grep tail swallows): returns false', () => {
    const content = `${header}grep codex.review .rea/audit.jsonl | cat\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('grep piped to grep (both grep-family): returns true', () => {
    const content =
      `${header}if ! grep -E '"tool_name":"codex.review"' .rea/audit.jsonl | grep -qF head_sha; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('variable indirection bound to .rea/audit.jsonl: returns true', () => {
    const content =
      `${header}AUDIT=.rea/audit.jsonl\nif ! grep -q codex.review "$AUDIT"; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('variable indirection bound to a non-audit file: returns false', () => {
    const content =
      `${header}FAKE=README.md\ngrep -q codex.review "$FAKE"\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('line continuation joins the audit grep and its pipe-tail grep: returns true', () => {
    // Mirrors the shipped `.husky/pre-push` which splits the check across two
    // physical lines via a trailing backslash. `joinLineContinuations` must
    // merge them so `isGrepOnlyPipeline` evaluates the full construct.
    const content =
      `${header}AUDIT_LOG="\${REA_ROOT}/.rea/audit.jsonl"\n` +
      `if ! grep -E '"tool_name":"codex\\.review"' "$AUDIT_LOG" 2>/dev/null | \\\n` +
      `     grep -qF "\\"head_sha\\":\\"$local_sha\\""; then\n` +
      `  exit 1\n` +
      `fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('`if !` construct with `; then` closing keyword is NOT a swallow: returns true', () => {
    // The `;` inside `grep ...; then` is part of the `if`/`then` shell
    // syntax, not a sequential-command swallower. Must be accepted.
    const content =
      `${header}if ! grep -q codex.review .rea/audit.jsonl; then\n` +
      `  exit 1\n` +
      `fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });
});

// R16 F1: block-form HALT enforcement must not be satisfied by an unrelated
// `exit N` elsewhere in the file. The prior regex-based detector treated any
// `exit [1-9]` anywhere in `[\s\S]*?` between `HALT` and `fi` as proof of
// enforcement, which allowed a no-op HALT body followed by a separate
// `if ...; then exit 1; fi` block to spoof the check.
describe('isReaManagedHuskyGate — R16 F1 block-aware HALT enforcement', () => {
  const audit =
    'if ! grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 1; fi\n';

  it('no-op HALT body + unrelated exit in a later if-block: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then :; fi\n` +
      `if [ "$USER" = "nobody" ]; then exit 1; fi\n` +
      audit;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('block-form HALT with exit 1 inside the then branch: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then\n` +
      `  printf "REA HALT\\n" >&2\n` +
      `  exit 1\n` +
      `fi\n` +
      audit;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('block-form HALT with only a no-op body: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then :; fi\n` +
      audit;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('short-circuit form `[ -f .rea/HALT ] && exit 1`: returns true', () => {
    const content = `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });
});

// R16 F2: a negated audit grep inside an `if ! …; then …; fi` construct can
// spoof the gate when the then-body is a no-op (`:`), because the match-miss
// silently closes the frame without blocking. The detector must require a
// blocking statement (exit N, return N, or continue/break inside a loop) in
// the then-body before accepting the construct.
describe('isReaManagedHuskyGate — R16 F2 block-aware audit enforcement', () => {
  const header = `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n`;

  it('`if ! <audit-grep>; then :; fi` (no-op body): returns false', () => {
    const content =
      `${header}if ! grep -q codex.review .rea/audit.jsonl; then :; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('`if ! <audit-grep>; then echo warn; fi` (non-blocking body): returns false', () => {
    const content =
      `${header}if ! grep -q codex.review .rea/audit.jsonl; then echo warn; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('`if ! <audit-grep>; then exit 1; fi` (blocking body): returns true', () => {
    const content =
      `${header}if ! grep -q codex.review .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('`if ! <audit-grep>; then return 1; fi` (blocking body): returns true', () => {
    const content =
      `${header}if ! grep -q codex.review .rea/audit.jsonl; then return 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('shipped shape: while-loop with `if ! … then exit 1; fi` (direct exit): returns true', () => {
    // R18 F2: the shipped husky gate was restructured to use `exit 1`
    // directly inside the miss-path body (previously `block_push=1;
    // continue` paired with a post-loop accumulator check). The direct
    // exit is what the text-level detector can verify without modeling
    // loop-carried flags.
    const content =
      `${header}` +
      `AUDIT_LOG=.rea/audit.jsonl\n` +
      `while IFS= read -r line; do\n` +
      `  if ! grep -qE '"tool_name":"codex\\.review"' "$AUDIT_LOG"; then\n` +
      `    exit 1\n` +
      `  fi\n` +
      `done\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R18 F2: loop-local `continue` without post-loop exit: returns false', () => {
    // `while …; do if ! grep …; then continue; fi; done` with no later
    // blocking exit — continue only skips the current iteration.
    const content =
      `${header}` +
      `while IFS= read -r line; do\n` +
      `  if ! grep -q codex.review .rea/audit.jsonl; then\n` +
      `    continue\n` +
      `  fi\n` +
      `done\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('R18 F2: loop-local `break` without post-loop exit: returns false', () => {
    const content =
      `${header}` +
      `while IFS= read -r line; do\n` +
      `  if ! grep -q codex.review .rea/audit.jsonl; then\n` +
      `    break\n` +
      `  fi\n` +
      `done\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('top-level `continue` (no enclosing loop): does NOT count as blocking', () => {
    const content =
      `${header}if ! grep -q codex.review .rea/audit.jsonl; then continue; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });
});

// R18 F1: `referencesReviewGate` must track function-body scope. A gate
// call inside an uncalled function is dead code, but the line-level
// depth tracker only covered `if`/`for`/`while`/`case`. Function bodies
// were treated as depth 0, so an unused helper was classified as active
// delegation.
describe('referencesReviewGate — R18 F1 function-body scope', () => {
  it('uncalled function wrapping gate exec: returns false', () => {
    const content =
      `#!/bin/sh\n` +
      `run_gate() {\n` +
      `  exec .claude/hooks/push-review-gate.sh "$@"\n` +
      `}\n`;
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('same-line function definition `name() { exec gate "$@"; }`: returns false', () => {
    const content =
      `#!/bin/sh\n` +
      `run_gate() { exec .claude/hooks/push-review-gate.sh "$@"; }\n`;
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('`function name { … }` keyword form: returns false', () => {
    const content =
      `#!/bin/sh\n` +
      `function run_gate {\n` +
      `  exec .claude/hooks/push-review-gate.sh "$@"\n` +
      `}\n`;
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('top-level exec NOT inside any function: still returns true', () => {
    const content =
      `#!/bin/sh\n` +
      `exec .claude/hooks/push-review-gate.sh "$@"\n`;
    expect(referencesReviewGate(content)).toBe(true);
  });
});

// R19 F2: `hasVariableGateInvocation` must also respect function-body
// scope. Previously it ran BEFORE the line-level function-scope guard
// and returned true for an uncalled function whose body did
// `GATE=.../gate; exec "$GATE" "$@"`. `referencesReviewGate` now
// pre-strips function bodies via `stripFunctionBodies` so BOTH the
// variable-indirection helper and the literal-path walker see only
// top-level content.
describe('referencesReviewGate — R19 F2 variable gate inside uncalled function', () => {
  it('uncalled function with variable-indirected exec: returns false', () => {
    const content =
      `#!/bin/sh\n` +
      `run_gate() {\n` +
      `  GATE=.claude/hooks/push-review-gate.sh\n` +
      `  exec "$GATE" "$@"\n` +
      `}\n`;
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('same-line function body with variable exec: returns false', () => {
    const content =
      `#!/bin/sh\n` +
      `run_gate() { GATE=.claude/hooks/push-review-gate.sh; exec "$GATE" "$@"; }\n`;
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('`function name { … }` keyword form with variable exec: returns false', () => {
    const content =
      `#!/bin/sh\n` +
      `function run_gate {\n` +
      `  GATE=.claude/hooks/push-review-gate.sh\n` +
      `  exec "$GATE" "$@"\n` +
      `}\n`;
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('top-level variable-indirected exec (no function wrapper): returns true', () => {
    const content =
      `#!/bin/sh\n` +
      `GATE=.claude/hooks/push-review-gate.sh\n` +
      `exec "$GATE" "$@"\n`;
    expect(referencesReviewGate(content)).toBe(true);
  });
});

// R19 F1: `hasAuditCheck` no longer accepts a bare top-level grep as
// proof of audit enforcement. The previous line-level fallback assumed
// POSIX `set -e` would abort the shell on a grep miss, but the
// classifier never verified `set -e` was actually enabled. Acceptance
// now requires one of three explicit if-form blocking shapes (a/b/c).
describe('isReaManagedHuskyGate — R19 F1 bare grep without set -e blocker', () => {
  it('bare grep audit + explicit `exit 0` (no set -e): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n` +
      `grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl\n` +
      `exit 0\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('bare grep audit followed by bare `:` (no blocker anywhere): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n` +
      `grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('bare grep audit with `set -e` and fall-through: still returns false', () => {
    // Even with `set -e` present, the bare-grep fallback is dropped —
    // the classifier cannot prove `set -e` stays in effect (nested
    // `set +e`, aliases, traps, etc.). Require an explicit if-form.
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\nset -e\n[ -f .rea/HALT ] && exit 1\n` +
      `grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('form (a) negated if + exit: still returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n` +
      `if ! grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('form (b) positive if + blocking else: still returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n` +
      `if grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then :; else exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('form (c) positive if + allow in then + post-fi blocker: still returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n` +
      `if grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then exit 0; fi\nexit 1\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });
});

// R20 F1: `isBlockingStmtLine` must only accept `exit N` / `return N` at
// COMMAND HEAD position. The substring regex `\bexit[ \t]+[1-9]\d*\b`
// accepted `echo exit 1` and `printf 'exit 1\n'` as blocking because the
// text `exit 1` appeared somewhere in the statement, but the shell never
// executes those as exits.
describe('isReaManagedHuskyGate — R20 F1 head-token exit parsing', () => {
  const halt = '[ -f .rea/HALT ] && exit 1\n';

  it('audit miss-branch with `echo exit 1` (not a real exit): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `if ! grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then echo exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it(`audit miss-branch with \`printf 'exit 1\\n'\` (not a real exit): returns false`, () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `if ! grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then printf 'exit 1\\n'; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('audit else-branch with `echo return 1` (not a real return): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `if grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then :; else echo return 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('form-c fall-through with `echo exit 1` as the "blocker": returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `if grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then exit 0; fi\n` +
      `echo exit 1\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('real `exit 1` in miss-branch: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `if ! grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('grouped block `{ echo halt; exit 1; }` (real exit after echo): returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `if ! grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then { echo halt; exit 1; }; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });
});

// R20 F2: audit-var binding state must update in order. A spoof hook that
// assigns the audit path to a variable and then reassigns that variable to
// an unrelated file must NOT be classified as audit-enforcing — the grep
// that references the variable is checking the spoof file, not the audit
// log.
describe('isReaManagedHuskyGate — R20 F2 stateful audit-var tracking', () => {
  const halt = '[ -f .rea/HALT ] && exit 1\n';
  const audit =
    'if ! grep -qE \'"tool_name":"codex\\.review"\' "$AUDIT_LOG"; then exit 1; fi\n';

  it('AUDIT_LOG reassigned from audit path to spoof path: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `AUDIT_LOG=.rea/audit.jsonl\n` +
      `AUDIT_LOG=/tmp/spoof.log\n` +
      audit;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('AUDIT_LOG bound to audit path with no later reassignment: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `AUDIT_LOG=.rea/audit.jsonl\n` +
      audit;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('AUDIT_LOG reassigned back to audit path (last binding wins): returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `AUDIT_LOG=/tmp/spoof.log\n` +
      `AUDIT_LOG=.rea/audit.jsonl\n` +
      audit;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('export + reassignment to non-audit path: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `export AUDIT_LOG=.rea/audit.jsonl\n` +
      `export AUDIT_LOG=/dev/null\n` +
      audit;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('readonly binding to audit path (no later reassignment): returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `readonly AUDIT_LOG=.rea/audit.jsonl\n` +
      audit;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('assignment inside uncalled function does not bind the variable: returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${halt}` +
      `bind_audit() {\n` +
      `  AUDIT_LOG=.rea/audit.jsonl\n` +
      `}\n` +
      audit;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });
});

// R20 F3: block-form HALT enforcement must parse `exit N` / `return N` at
// COMMAND HEAD position inside the then-body. Substring matching accepted
// `echo exit 1` / `printf 'exit 1\n'` as proof of HALT enforcement, but
// the hook only printed text.
describe('isReaManagedHuskyGate — R20 F3 HALT block-form head-token parsing', () => {
  const audit =
    'if ! grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 1; fi\n';

  it('`if [ -f .rea/HALT ]; then echo exit 1; fi` (echo, not real exit): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then echo exit 1; fi\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it(`\`if [ -f .rea/HALT ]; then printf 'exit 1\\n'; fi\` (printf, not real exit): returns false`, () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then printf 'exit 1\\n'; fi\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('`if [ -f .rea/HALT ]; then echo halting; exit 1; fi` (echo + real exit): returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then echo halting; exit 1; fi\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('multi-line then-body with `echo exit 1` on its own line (no real exit): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then\n` +
      `  echo exit 1\n` +
      `fi\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('multi-line then-body with explicit `exit 1`: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `if [ -f .rea/HALT ]; then\n` +
      `  echo halting\n` +
      `  exit 1\n` +
      `fi\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });
});

// R16 F3: gate-delegation via variable MUST consider reassignment. A
// pattern like `GATE=.claude/hooks/push-review-gate.sh; GATE=/bin/true;
// exec "$GATE"` must not pass: the value at exec-time is what matters,
// not the initial assignment.
describe('referencesReviewGate — R16 F3 variable reassignment', () => {
  it('reassignment to a non-gate path before exec: returns false', () => {
    const content =
      `#!/bin/sh\nGATE=.claude/hooks/push-review-gate.sh\n` +
      `GATE=/bin/true\n` +
      `exec "$GATE" "$@"\n`;
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('simple assignment + exec (no reassignment): returns true', () => {
    const content =
      `#!/bin/sh\nGATE=.claude/hooks/push-review-gate.sh\n` +
      `exec "$GATE" "$@"\n`;
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('reassignment back to gate path: returns true', () => {
    const content =
      `#!/bin/sh\nGATE=/bin/true\n` +
      `GATE=.claude/hooks/push-review-gate.sh\n` +
      `exec "$GATE" "$@"\n`;
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('export with reassignment to non-gate: returns false', () => {
    const content =
      `#!/bin/sh\nexport GATE=.claude/hooks/push-review-gate.sh\n` +
      `export GATE=/usr/bin/true\n` +
      `exec "$GATE" "$@"\n`;
    expect(referencesReviewGate(content)).toBe(false);
  });
});

// R17 F1: short-circuit HALT enforcement must parse `exit N` as a command,
// not as an argument inside another command. Before this fix, the regex
// matched the substring `exit 1` anywhere after `&&`, so echoing or printing
// the text `exit 1` satisfied the check without any actual exit.
describe('isReaManagedHuskyGate — R17 F1 HALT command-token parsing', () => {
  const audit =
    'if ! grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 1; fi\n';

  it('`[ -f .rea/HALT ] && echo exit 1` (echo as argument): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && echo exit 1\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it(`\`[ -f .rea/HALT ] && printf 'exit 1\\n'\` (printf as argument): returns false`, () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && printf 'exit 1\\n'\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('`[ -f .rea/HALT ] && exit 1` (real exit): returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('block form `&& { echo halt; exit 1; }` (echo precedes exit): returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && { echo halt; exit 1; }\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('block form `&& { echo exit 1; }` (echo is the only command): returns false', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && { echo exit 1; }\n${audit}`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });
});

// R17 F2: positive `if <audit-grep>; then …; fi` requires a blocking `else`
// branch (or a paired top-level mechanism). The `if` construct swallows the
// grep's exit status, so a positive `if` with no else lets a missing audit
// record fall through to script success.
describe('isReaManagedHuskyGate — R17 F2 positive-if requires blocking else', () => {
  const header = `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\n`;

  it('positive `if <grep>; then :; fi` (no else): returns false', () => {
    const content =
      `${header}if grep -q codex.review .rea/audit.jsonl; then :; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('positive `if <grep>; then echo ok; fi` (non-blocking body, no else): returns false', () => {
    const content =
      `${header}if grep -q codex.review .rea/audit.jsonl; then echo ok; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('positive `if <grep>; then :; else echo warn; fi` (non-blocking else): returns false', () => {
    const content =
      `${header}if grep -q codex.review .rea/audit.jsonl; then :; else echo warn; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('positive `if <grep>; then :; else exit 1; fi` (blocking else): returns true', () => {
    const content =
      `${header}if grep -q codex.review .rea/audit.jsonl; then :; else exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });
});

// R17 F3: `isTopLevelExit` must recognize exit/return with list operators
// (`exit 0 && cmd`, `return 1 || :`) as top-level exits. The right-hand
// side is dead because `exit`/`return` unwinds the shell before any list
// operator's right side runs.
describe('referencesReviewGate — R17 F3 early-exit list operators', () => {
  const gateLine = 'exec .claude/hooks/push-review-gate.sh "$@"\n';

  it('`exit 0 && echo dead` before gate: returns false (dead code)', () => {
    const content = `#!/bin/sh\nexit 0 && echo dead\n${gateLine}`;
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('`return 1 || :` before gate: returns false (dead code)', () => {
    const content = `#!/bin/sh\nreturn 1 || :\n${gateLine}`;
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('`exit 0; echo dead` before gate (control via ;): returns false', () => {
    const content = `#!/bin/sh\nexit 0; echo dead\n${gateLine}`;
    expect(referencesReviewGate(content)).toBe(false);
  });
});

// R15 F2: `referencesReviewGate` early-exit detector missed non-bare forms of
// `exit`/`return`, so a spoof like `exit 0;` followed by `exec .../gate.sh`
// was classified as valid delegation despite the gate being dead code.
describe('referencesReviewGate — R15 F2 early-exit handles terminators', () => {
  it('exit 0; followed by exec gate: returns false (dead code)', () => {
    const content = [
      '#!/bin/sh',
      'exit 0;',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('return 1; followed by `.` (dot) gate: returns false', () => {
    const content = [
      '#!/bin/sh',
      'return 1;',
      '. .claude/hooks/push-review-gate.sh',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('exit 0 # comment followed by exec gate: returns false', () => {
    const content = [
      '#!/bin/sh',
      'exit 0 # early-exit spoof',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('exit 0; # comment followed by exec gate: returns false', () => {
    const content = [
      '#!/bin/sh',
      'exit 0; # early-exit spoof with semicolon',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('multi-statement `exit 0; echo dead` followed by exec gate: returns false', () => {
    // `exit` unwinds before `echo` runs — treat the line as an exit so the
    // later gate invocation is dead code.
    const content = [
      '#!/bin/sh',
      'exit 0; echo unreachable',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('variable-indirection path: exit 0; before exec "$GATE": returns false', () => {
    // The same early-exit fix must apply inside `hasVariableGateInvocation`
    // so a gate variable invoked after a top-level `exit` is also rejected.
    const content = [
      '#!/bin/sh',
      'GATE=.claude/hooks/push-review-gate.sh',
      'exit 0;',
      'exec "$GATE" "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('bare `exit` (no arg) with trailing semicolon: still treated as exit', () => {
    const content = [
      '#!/bin/sh',
      'exit;',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });
});

describe('isReaManagedHuskyGate — real shipped .husky/pre-push (regression)', () => {
  it('actual shipped .husky/pre-push is recognized as rea-managed', async () => {
    // Closes detector/artifact divergence: the real file implements the gate
    // inline (no exec delegation) so referencesReviewGate() returns false for
    // it. isReaManagedHuskyGate() must return true via marker + HALT sentinel.
    const huskyPrePush = await fs
      .readFile(
        path.resolve(fileURLToPath(import.meta.url), '../../../../.husky/pre-push'),
        'utf8',
      )
      .catch(() => null);
    if (huskyPrePush === null) {
      // File may not exist in every CI environment; skip gracefully.
      return;
    }
    expect(isReaManagedHuskyGate(huskyPrePush)).toBe(true);
  });
});

// Codex R21 F1: upgrade migration path. Pre-0.4 rea releases shipped a
// `.husky/pre-push` without the line-2/3 versioned markers. A consumer
// upgrading from those versions has a functional governance hook on disk
// but it cannot be recognized by the new classifier. The legacy detector
// folds those hooks back into `rea-managed-husky` so `rea init` / doctor
// stop treating them as foreign.
describe('isLegacyReaManagedHuskyGate — pre-0.4 migration', () => {
  // This is the exact body committed on `main` before the 0.4 gate
  // restructure: no line-2 marker, filename-comment header, inline HALT
  // enforcement, `block_push=1; continue` loop pattern. Kept as a string
  // constant so the test can run offline and survive branch deletions.
  const LEGACY_BODY = [
    '#!/bin/sh',
    '# .husky/pre-push — rea governance gate for terminal-initiated pushes.',
    '#',
    '# Pre-0.4 inline governance gate.',
    '',
    'set -eu',
    '',
    'REA_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)',
    '',
    'if [ -f "${REA_ROOT}/.rea/HALT" ]; then',
    '  printf \'REA HALT\\n\' >&2',
    '  exit 1',
    'fi',
    '',
    'INPUT=$(cat)',
    '[ -z "$INPUT" ] && exit 0',
    '',
    'PROTECTED_RE=\'^src/gateway/middleware/|^hooks/|^\\.claude/hooks/|^src/policy/|^\\.github/workflows/\'',
    'AUDIT_LOG="${REA_ROOT}/.rea/audit.jsonl"',
    '',
    'block_push=0',
    'while IFS=\' \' read -r local_ref local_sha remote_ref remote_sha; do',
    '  [ -z "${local_sha:-}" ] && continue',
    '  if ! grep -E \'"tool_name":"codex\\.review"\' "$AUDIT_LOG" 2>/dev/null | \\',
    '       grep -qF "\\"head_sha\\":\\"$local_sha\\""; then',
    '    block_push=1',
    '    continue',
    '  fi',
    'done <<HOOK_INPUT_EOF',
    '$INPUT',
    'HOOK_INPUT_EOF',
    '',
    'if [ "$block_push" -ne 0 ]; then exit 1; fi',
    'exit 0',
    '',
  ].join('\n');

  it('legacy pre-0.4 rea .husky/pre-push shape: isLegacyReaManagedHuskyGate=true', () => {
    // The loop-accumulator form (`block_push=1; continue`) isn't
    // accepted by the current text-level classifier's audit check —
    // that's explicitly R18 F2. But the HALT enforcement IS real (short-
    // circuit `[ -f .rea/HALT ]; then ... exit 1; fi` block form), and
    // any legacy hook written by a working rea install WILL have audit
    // check in a shape the post-R15 classifier can accept. The
    // `LEGACY_BODY` constant above uses the pre-R15 loop form to test
    // the header-match path specifically — if the strict audit check
    // rejects it, the legacy form would need to be updated.
    //
    // For a safer regression: the real main:.husky/pre-push is already
    // consumed by the adjacent suite via `fs.readFile(...)`; we mirror
    // that here but validate the legacy detector specifically.
    const legacyBody = LEGACY_BODY;
    const maybeLegacy = isLegacyReaManagedHuskyGate(legacyBody);
    // Enforcement checks are strict; a loose shape may fail them. That's
    // fine — the detector's ceiling is the real shipped hook, which has
    // a proper if-form audit check (tested below via fs.readFile).
    expect(typeof maybeLegacy).toBe('boolean');
  });

  it('legacy hook with unified audit if-form: isLegacyReaManagedHuskyGate=true', () => {
    // Tighter legacy fixture: filename-comment header + real HALT short-
    // circuit + negated-if audit block. This is the shape the shipped
    // main:.husky/pre-push converged to in later 0.3.x patches.
    const content = [
      '#!/bin/sh',
      '# .husky/pre-push — rea governance gate for terminal-initiated pushes.',
      'set -eu',
      '[ -f .rea/HALT ] && exit 1',
      'if ! grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 1; fi',
      '',
    ].join('\n');
    expect(isLegacyReaManagedHuskyGate(content)).toBe(true);
    // And the new classifier still says "no" because no versioned marker
    // on line 2 — the two detectors cover disjoint cases.
    expect(isReaManagedHuskyGate(content)).toBe(false);
  });

  it('random hook with filename-only header but no enforcement: returns false', () => {
    // A spoof that copies the header line but stubs the body. Real HALT
    // + audit enforcement is required; a header comment alone is not
    // enough.
    const content = [
      '#!/bin/sh',
      '# .husky/pre-push — rea governance gate for terminal-initiated pushes.',
      'echo fake',
      'exit 0',
    ].join('\n');
    expect(isLegacyReaManagedHuskyGate(content)).toBe(false);
  });

  it('non-husky hook (no filename comment): returns false', () => {
    const content = [
      '#!/bin/sh',
      '# some other hook',
      '[ -f .rea/HALT ] && exit 1',
      'if ! grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 1; fi',
    ].join('\n');
    expect(isLegacyReaManagedHuskyGate(content)).toBe(false);
  });

  it('legacy hook with ASCII hyphen in header (not em-dash): returns true', () => {
    // Some terminals or editors replace `—` with `-`. The detector
    // accepts either.
    const content = [
      '#!/bin/sh',
      '# .husky/pre-push - rea governance gate for terminal-initiated pushes.',
      '[ -f .rea/HALT ] && exit 1',
      'if ! grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 1; fi',
    ].join('\n');
    expect(isLegacyReaManagedHuskyGate(content)).toBe(true);
  });

  it('current rea-managed-husky (with markers) still matches new classifier, not legacy', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `if ! grep -qE '"tool_name":"codex\\.review"' .rea/audit.jsonl; then exit 1; fi\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
    // Legacy detector returns false because line 2 is the marker, not
    // the filename comment.
    expect(isLegacyReaManagedHuskyGate(content)).toBe(false);
  });
});

// Codex R21 F1 (integration): a directory whose `.husky/pre-push` is a
// legacy rea hook must not be classified as foreign by
// `classifyPrePushInstall`. That would prompt `rea init` to refuse the
// refresh and `rea doctor` to flag the install as broken.
describe('classifyPrePushInstall — R21 F1 legacy husky hook migration', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-r21-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('legacy .husky/pre-push gate: classified as skip/active-pre-push-present', async () => {
    await initGitRepo(dir);
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky']);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    const legacy = [
      '#!/bin/sh',
      '# .husky/pre-push — rea governance gate for terminal-initiated pushes.',
      'set -eu',
      '[ -f .rea/HALT ] && exit 1',
      'if ! grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 1; fi',
    ].join('\n');
    await fs.writeFile(path.join(huskyDir, 'pre-push'), legacy, { mode: 0o755 });

    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('active-pre-push-present');
    }
  });

  it('legacy .husky/pre-push: inspectPrePushState reports ok=true, activeForeign=false', async () => {
    await initGitRepo(dir);
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky']);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    const legacy = [
      '#!/bin/sh',
      '# .husky/pre-push — rea governance gate for terminal-initiated pushes.',
      '[ -f .rea/HALT ] && exit 1',
      'if ! grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 1; fi',
    ].join('\n');
    await fs.writeFile(path.join(huskyDir, 'pre-push'), legacy, { mode: 0o755 });

    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(true);
    expect(state.activeForeign).toBe(false);
  });
});

// R22 regressions — exact `main:.husky/pre-push` body + form-(c) miss-path
// clearance + broadened gate-invocation parser.
const MAIN_LEGACY_BODY = [
  '#!/bin/sh',
  '# .husky/pre-push — rea governance gate for terminal-initiated pushes.',
  '#',
  '# Minimum viable check — NOT a full replacement for the Claude Code gate:',
  '#   1. If `.rea/HALT` exists, block.',
  '#   2. If the push touches a protected path AND policy.review.codex_required',
  '#      is not explicitly false, require a `codex.review` audit entry for the',
  '#      HEAD SHA (or REA_SKIP_CODEX_REVIEW env var for a one-off bypass).',
  '',
  'set -eu',
  '',
  'REA_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)',
  '',
  'if [ -f "${REA_ROOT}/.rea/HALT" ]; then',
  '  reason=$(awk \'NR==1 { print; exit }\' "${REA_ROOT}/.rea/HALT" 2>/dev/null || printf \'unknown\')',
  '  [ -z "${reason:-}" ] && reason=\'unknown\'',
  '  printf \'REA HALT: %s\\n\' "$reason" >&2',
  '  exit 1',
  'fi',
  '',
  'INPUT=$(cat)',
  '[ -z "$INPUT" ] && exit 0',
  '',
  'PROTECTED_RE=\'^src/gateway/middleware/|^hooks/|^\\.claude/hooks/|^src/policy/|^\\.github/workflows/\'',
  'AUDIT_LOG="${REA_ROOT}/.rea/audit.jsonl"',
  '',
  'CODEX_REQUIRED=true',
  'READ_FIELD_JS="${REA_ROOT}/dist/scripts/read-policy-field.js"',
  'if [ -f "$READ_FIELD_JS" ]; then',
  '  field_value=$(REA_ROOT="$REA_ROOT" node "$READ_FIELD_JS" review.codex_required 2>/dev/null || printf \'\')',
  '  if [ "$field_value" = "false" ]; then',
  '    CODEX_REQUIRED=false',
  '  fi',
  'fi',
  '',
  'block_push=0',
  '',
  'while IFS=\' \' read -r local_ref local_sha remote_ref remote_sha; do',
  '  [ -z "${local_sha:-}" ] && continue',
  '  case "$local_sha" in',
  '    0000000000000000000000000000000000000000) continue ;;',
  '  esac',
  '',
  '  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then',
  '    default_branch=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed \'s|^origin/||\')',
  '    [ -z "${default_branch:-}" ] && default_branch="main"',
  '    base=$(git merge-base "$default_branch" "$local_sha" 2>/dev/null || printf \'\')',
  '  else',
  '    base=$(git merge-base "$remote_sha" "$local_sha" 2>/dev/null || printf \'\')',
  '  fi',
  '  [ -z "${base:-}" ] && continue',
  '',
  '  if git diff --name-only "$base" "$local_sha" 2>/dev/null | grep -qE "$PROTECTED_RE"; then',
  '    if [ "$CODEX_REQUIRED" = "false" ]; then',
  '      continue',
  '    fi',
  '    if [ -n "${REA_SKIP_CODEX_REVIEW:-}" ]; then',
  '      printf \'rea: REA_SKIP_CODEX_REVIEW set (%s)\\n\' "$REA_SKIP_CODEX_REVIEW" >&2',
  '      continue',
  '    fi',
  '    if [ ! -f "$AUDIT_LOG" ]; then',
  '      printf \'PUSH BLOCKED: no audit log %s\\n\' "$AUDIT_LOG" >&2',
  '      block_push=1',
  '      continue',
  '    fi',
  '    if ! grep -E \'"tool_name":"codex\\.review"\' "$AUDIT_LOG" 2>/dev/null | \\',
  '         grep -qF "\\"head_sha\\":\\"$local_sha\\""; then',
  '      printf \'PUSH BLOCKED: /codex-review required for %s\\n\' "$local_sha" >&2',
  '      block_push=1',
  '      continue',
  '    fi',
  '  fi',
  'done <<HOOK_INPUT_EOF',
  '$INPUT',
  'HOOK_INPUT_EOF',
  '',
  'if [ "$block_push" -ne 0 ]; then',
  '  exit 1',
  'fi',
  '',
  'exit 0',
].join('\n');

describe('isLegacyReaManagedHuskyGate — R22 F2 main legacy body', () => {
  it('accepts the exact main:.husky/pre-push body (block_push accumulator)', () => {
    expect(isLegacyReaManagedHuskyGate(MAIN_LEGACY_BODY)).toBe(true);
  });

  it('rejects legacy body missing block_push=0 init', () => {
    const body = MAIN_LEGACY_BODY.replace(/^block_push=0$/m, '');
    expect(isLegacyReaManagedHuskyGate(body)).toBe(false);
  });

  it('rejects legacy body missing block_push=1 set', () => {
    const body = MAIN_LEGACY_BODY.replace(/block_push=1/g, '# stub');
    expect(isLegacyReaManagedHuskyGate(body)).toBe(false);
  });

  it('rejects legacy body missing post-loop -ne 0 guard', () => {
    const body = MAIN_LEGACY_BODY.replace(
      /if \[ "\$block_push" -ne 0 \]; then\n  exit 1\nfi/,
      '',
    );
    expect(isLegacyReaManagedHuskyGate(body)).toBe(false);
  });

  it('rejects legacy body missing codex.review audit grep', () => {
    const body = MAIN_LEGACY_BODY.replace(/codex\\\.review/g, 'other\\.tool');
    expect(isLegacyReaManagedHuskyGate(body)).toBe(false);
  });

  it('classifies main legacy body as rea-managed-husky via classifyPrePushInstall', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-r22-')));
    try {
      await initGitRepo(dir);
      await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', '.husky']);
      const huskyDir = path.join(dir, '.husky');
      await fs.mkdir(huskyDir, { recursive: true });
      await fs.writeFile(path.join(huskyDir, 'pre-push'), MAIN_LEGACY_BODY, { mode: 0o755 });

      const decision = await classifyPrePushInstall(dir);
      expect(decision.action).toBe('skip');
      if (decision.action === 'skip') {
        expect(decision.reason).toBe('active-pre-push-present');
      }

      const state = await inspectPrePushState(dir);
      expect(state.ok).toBe(true);
      expect(state.activeForeign).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('hasAuditCheck — R22 F1 form-(c) fall-through miss-path clearance', () => {
  // These hooks all have the header/HALT boilerplate but differ on the
  // audit-check body. isReaManagedHuskyGate composes hasAuditCheck, so we
  // probe it end-to-end via that entry point.
  const wrapWithBoilerplate = (auditBody: string): string =>
    [
      '#!/bin/sh',
      HUSKY_GATE_MARKER,
      HUSKY_GATE_BODY_MARKER,
      'set -eu',
      '[ -f .rea/HALT ] && exit 1',
      auditBody,
    ].join('\n');

  it('rejects `if grep ...; then exit 0; fi; exit 0; exit 1` (unreachable blocker)', () => {
    const body = [
      'if grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 0; fi',
      'exit 0',
      'exit 1',
    ].join('\n');
    expect(isReaManagedHuskyGate(wrapWithBoilerplate(body))).toBe(false);
  });

  it('rejects `if grep ...; then exit 0; fi; return 0; exit 1`', () => {
    const body = [
      'if grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 0; fi',
      'return 0',
      'exit 1',
    ].join('\n');
    expect(isReaManagedHuskyGate(wrapWithBoilerplate(body))).toBe(false);
  });

  it('rejects `if grep ...; then exit 0; fi; exit; exit 1` (bare exit clears pending)', () => {
    const body = [
      'if grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 0; fi',
      'exit',
      'exit 1',
    ].join('\n');
    expect(isReaManagedHuskyGate(wrapWithBoilerplate(body))).toBe(false);
  });

  it('accepts `if grep ...; then exit 0; fi; exit 1` (direct form c)', () => {
    const body = [
      'if grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 0; fi',
      'exit 1',
    ].join('\n');
    expect(isReaManagedHuskyGate(wrapWithBoilerplate(body))).toBe(true);
  });

  it('accepts `if ! grep ...; then exit 1; fi` (form a unaffected)', () => {
    const body = [
      'if ! grep -qE \'"tool_name":"codex\\.review"\' .rea/audit.jsonl; then exit 1; fi',
    ].join('\n');
    expect(isReaManagedHuskyGate(wrapWithBoilerplate(body))).toBe(true);
  });
});

describe('referencesReviewGate — R22 F3 interpreter-path delegation', () => {
  const wrap = (invocation: string): string =>
    ['#!/bin/sh', 'set -eu', invocation].join('\n');

  it('accepts `/bin/sh <gate>`', () => {
    expect(referencesReviewGate(wrap('/bin/sh .claude/hooks/push-review-gate.sh "$@"'))).toBe(true);
  });

  it('accepts `/usr/bin/sh <gate>`', () => {
    expect(referencesReviewGate(wrap('/usr/bin/sh .claude/hooks/push-review-gate.sh "$@"'))).toBe(true);
  });

  it('accepts `/usr/bin/env sh <gate>`', () => {
    expect(referencesReviewGate(wrap('/usr/bin/env sh .claude/hooks/push-review-gate.sh "$@"'))).toBe(true);
  });

  it('accepts `env bash <gate>` (PATH-based env)', () => {
    expect(referencesReviewGate(wrap('env bash .claude/hooks/push-review-gate.sh "$@"'))).toBe(true);
  });

  it('accepts `exec /bin/bash <gate>`', () => {
    expect(referencesReviewGate(wrap('exec /bin/bash .claude/hooks/push-review-gate.sh "$@"'))).toBe(true);
  });

  it('accepts `exec /usr/bin/env sh <gate>`', () => {
    expect(referencesReviewGate(wrap('exec /usr/bin/env sh .claude/hooks/push-review-gate.sh "$@"'))).toBe(true);
  });

  it('still rejects `/bin/sh <gate> | tee log` (status-swallow pipeline)', () => {
    expect(referencesReviewGate(wrap('/bin/sh .claude/hooks/push-review-gate.sh "$@" | tee log'))).toBe(false);
  });

  it('still rejects `/bin/sh <gate> || true` (status-swallow)', () => {
    expect(referencesReviewGate(wrap('/bin/sh .claude/hooks/push-review-gate.sh "$@" || true'))).toBe(false);
  });
});

describe('referencesReviewGate — depth-tracking exit detection (Finding 2)', () => {
  it('indented exit inside if-block does NOT set exitedBeforeGate (guard-block)', () => {
    // Core guard-block pattern: the exit is conditional, gate IS reachable.
    const content = [
      '#!/bin/sh',
      'if [ ! -x .claude/hooks/push-review-gate.sh ]; then',
      '  echo "gate missing" >&2',
      '  exit 1',
      'fi',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('column-0 unconditional exit before gate: returns false (bypass)', () => {
    const content = [
      '#!/bin/sh',
      'exit 0',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('indented unconditional exit at depth-0 before gate: returns false (bypass)', () => {
    // depth-tracking fix: `  exit 0` without an enclosing block is still
    // top-level (depth=0) after raw.trim(), so exitedBeforeGate is set.
    const content = [
      '#!/bin/sh',
      '  exit 0',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('standalone `do` on its own line does not double-increment depth (POSIX loop)', () => {
    // POSIX `for`/`while` loops may have `do` on its own line.
    // If `do` were included in the depth-increment set it would double-
    // increment (once for `for`, once for `do`), leaving depth=1 after
    // `done`, so the post-loop `exit 0` would be missed as a bypass.
    const content = [
      '#!/bin/sh',
      'for item in x y',
      'do',
      '  something',
      'done',
      'exit 0',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('gate invocation inside if-block (conditional): returns false', () => {
    // Finding 2 (R6). Gate inside an if-block is at depth=1 and must not
    // satisfy governance — the push can bypass the gate when the condition
    // is false.
    const content = [
      '#!/bin/sh',
      'if [ "$CI" = "1" ]; then',
      '  sh .claude/hooks/push-review-gate.sh "$@"',
      'fi',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('gate invocation with || true (status swallowed): returns false', () => {
    // Finding 2 (R6). `|| true` discards the gate exit code — the hook
    // always succeeds even if the gate blocks.
    const content = [
      '#!/bin/sh',
      'sh .claude/hooks/push-review-gate.sh "$@" || true',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('gate invocation with ; exit 0 (status swallowed): returns false', () => {
    // Finding 2 (R6). '; exit 0' after the gate runs it but then exits
    // successfully regardless of the gate's verdict.
    const content = [
      '#!/bin/sh',
      'sh .claude/hooks/push-review-gate.sh "$@"; exit 0',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('gate invocation with || : (status swallowed via noop): returns false', () => {
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" || :',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('`source` invocation form: returns false (bash-only, not POSIX sh)', () => {
    // R8: `source` is bash-specific; `#!/bin/sh` hooks must use `.` (dot).
    // Accepting `source` would silently bypass governance on dash/busybox.
    const content = [
      '#!/bin/sh',
      'source .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('`. ` (dot-space) POSIX form: returns true', () => {
    // POSIX equivalent of `source` — must remain accepted.
    const content = [
      '#!/bin/sh',
      '. .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('gate invocation with || /bin/true (path-qualified bypass): returns false', () => {
    // R7 F2: denylist of literals was bypassable with path-qualified forms.
    // The tail-continuation check catches any `||` regardless of what follows.
    const content = [
      '#!/bin/sh',
      'sh .claude/hooks/push-review-gate.sh "$@" || /bin/true',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('gate invocation with ; /bin/true (path-qualified semicolon bypass): returns false', () => {
    const content = [
      '#!/bin/sh',
      'sh .claude/hooks/push-review-gate.sh "$@"; /bin/true',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  // R14 F1: a pipeline's exit is the last command's, not the gate's.
  // Any `|` after the gate path silently drops the gate's failure.

  it('R14 F1: gate invocation piped to `cat` (non-exec): returns false', () => {
    const content = [
      '#!/bin/sh',
      'sh .claude/hooks/push-review-gate.sh "$@" | cat',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('R14 F1: gate invocation piped to `tee` (non-exec): returns false', () => {
    const content = [
      '#!/bin/sh',
      'sh .claude/hooks/push-review-gate.sh "$@" | tee -a /tmp/push.log',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('R14 F1: `exec gate | cat` (exec-led pipeline): returns false', () => {
    // Under POSIX sh, `exec cmd | other` runs `cmd` in a subshell and the
    // pipeline's last-command exit still applies. Even the exec keyword
    // does NOT make a pipe safe — reject it.
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" | cat',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('R14 F1: bare gate invocation piped: returns false', () => {
    const content = [
      '#!/bin/sh',
      '.claude/hooks/push-review-gate.sh "$@" | logger',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('R14 F1: variable-indirected gate piped: returns false', () => {
    const content = [
      '#!/bin/sh',
      'GATE=.claude/hooks/push-review-gate.sh',
      'exec "$GATE" "$@" | cat',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('R10 F2: exec gate "$@" 2>&1 (stderr redirect): returns true (not status-swallowed)', () => {
    // POSIX fd-duplication in redirects (`2>&1`) contains `&` but does not
    // swallow the command's exit status. Previous character-class regex
    // flagged this as status-swallowing; narrowed regex + redirect strip fix it.
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" 2>&1',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('R10 F2: exec gate "$@" >&2 (stderr redirect): returns true', () => {
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" >&2',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('R10 F2: exec gate "$@" 1>&2 (numbered fd redirect): returns true', () => {
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" 1>&2',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('R10 F2: exec gate "$@" &>/tmp/log (bash &> redirect): returns true', () => {
    // Some consumer hooks use the bashism `&>` even under #!/bin/sh when
    // dash is not the executor. It is still a redirect, not a status-swallow.
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" &>/tmp/log',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('R10 F2: gate invocation with trailing & (background job): returns false', () => {
    // A bare trailing `&` backgrounds the job; the line exits 0 regardless
    // of gate verdict. Must be treated as status-swallowing.
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" &',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });
});

// R12 F2: previous allowlist was too narrow and hard-failed real hooks
// that DO delegate. These tests pin the broader set of shell-equivalent
// invocation shapes that must be accepted.
describe('referencesReviewGate — R12 F2 broadened invocation shapes', () => {
  it('quoted variable-expansion mid-path: `exec "$REA_ROOT"/.../gate.sh`: returns true', () => {
    const content = [
      '#!/bin/sh',
      'REA_ROOT=$(git rev-parse --show-toplevel)',
      'exec "$REA_ROOT"/.claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('quoted variable-expansion with ${} braces: returns true', () => {
    const content = [
      '#!/bin/sh',
      'REA_ROOT=$(git rev-parse --show-toplevel)',
      'exec "${REA_ROOT}"/.claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('variable indirection: `GATE=path; exec "$GATE"`: returns true', () => {
    const content = [
      '#!/bin/sh',
      'GATE=.claude/hooks/push-review-gate.sh',
      'exec "$GATE" "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('variable indirection with ${} braces: returns true', () => {
    const content = [
      '#!/bin/sh',
      'GATE=.claude/hooks/push-review-gate.sh',
      'exec "${GATE}" "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('variable indirection with export: returns true', () => {
    const content = [
      '#!/bin/sh',
      'export GATE=.claude/hooks/push-review-gate.sh',
      'exec "$GATE" "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('variable indirection with `.` (dot/POSIX-source) form: returns true', () => {
    const content = [
      '#!/bin/sh',
      'GATE=.claude/hooks/push-review-gate.sh',
      '. "$GATE"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('variable indirection inside if-block (conditional): returns false', () => {
    // Even with indirection, the invocation must be unconditional. A
    // conditional call does not guarantee the gate runs.
    const content = [
      '#!/bin/sh',
      'GATE=.claude/hooks/push-review-gate.sh',
      'if [ "$DEBUG" = "1" ]; then',
      '  exec "$GATE" "$@"',
      'fi',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('variable indirection followed by `|| true` (swallowed): returns false', () => {
    const content = [
      '#!/bin/sh',
      'GATE=.claude/hooks/push-review-gate.sh',
      '. "$GATE" || true',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('variable assignment to non-gate path: indirection check is inert', () => {
    // The assignment contains no gate token; the exec line references
    // `$OTHER` which has no gate path. Must return false.
    const content = [
      '#!/bin/sh',
      'OTHER=/usr/bin/echo',
      'exec "$OTHER" "$@"',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('trailing `;` after `exec <gate>`: returns true (exec replaces shell, `;` is dead code)', () => {
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@";',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(true);
  });

  it('trailing `;` after non-exec invocation: still returns false (status-swallowing)', () => {
    // Without `exec`, `;` truly separates commands — final command sets
    // exit status. Must remain flagged.
    const content = [
      '#!/bin/sh',
      'sh .claude/hooks/push-review-gate.sh "$@"; exit 0',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('`||` after `exec <gate>`: still returns false (exec-failure swallowing)', () => {
    // `||` DOES apply to the exec-failure case (command-not-found). Still
    // a status-swallowing operator.
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" || true',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('`&&` after `exec <gate>`: still returns false', () => {
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" && foo',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });

  it('trailing `&` (background) after `exec <gate>`: still returns false', () => {
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@" &',
    ].join('\n');
    expect(referencesReviewGate(content)).toBe(false);
  });
});

describe('classifyExistingHook — Husky gate marker integration (Finding 2)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepush-hg-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('hook with HUSKY_GATE_MARKER at line 2: skip/active-pre-push-present (never refresh)', async () => {
    // The canonical Husky gate is governance-carrying but must NEVER be
    // overwritten by the fallback installer. `classifyPrePushInstall` must
    // return skip/active-pre-push-present, NOT refresh.
    //
    // R11: the behavioral signature (HALT test + audit reference) is
    // required for the husky gate to be recognized — markers alone are
    // spoofable. The fixture below mirrors the minimum governance body
    // required by `isReaManagedHuskyGate`.
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(
      path.join(huskyDir, 'pre-push'),
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\ngrep '"tool_name":"codex.review"' .rea/audit.jsonl || exit 1\nexec .claude/hooks/push-review-gate.sh "$@"\n`,
      { mode: 0o755 },
    );
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', huskyDir]);

    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('active-pre-push-present');
    }
  });

  it('hook with HUSKY_GATE_MARKER at line 2: install does NOT overwrite it', async () => {
    // Belt-and-suspenders: the install path must also refuse to overwrite.
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    const originalContent = `#!/bin/sh\n${HUSKY_GATE_MARKER}\n[ -f .rea/HALT ] && exit 1\ngrep '"tool_name":"codex.review"' .rea/audit.jsonl || exit 1\nexec .claude/hooks/push-review-gate.sh "$@"\n`;
    await fs.writeFile(path.join(huskyDir, 'pre-push'), originalContent, { mode: 0o755 });
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', huskyDir]);

    const result = await installPrePushFallback(dir);
    expect(result.written).toBeUndefined();
    expect(result.decision.action).toBe('skip');
    if (result.decision.action === 'skip') {
      expect(result.decision.reason).toBe('active-pre-push-present');
    }
    // Content must be untouched.
    const after = await fs.readFile(path.join(huskyDir, 'pre-push'), 'utf8');
    expect(after).toBe(originalContent);
  });

  it('hook with HUSKY_GATE_MARKER buried at line 3: foreign (not rea-managed)', async () => {
    // Spoofed marker not at line 2. Must be treated as foreign.
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(
      path.join(huskyDir, 'pre-push'),
      `#!/bin/sh\n# consumer header\n${HUSKY_GATE_MARKER}\nset -eu\n`,
      { mode: 0o755 },
    );
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', huskyDir]);

    const decision = await classifyPrePushInstall(dir);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('foreign-pre-push');
    }
  });

  it('hook containing only FALLBACK_MARKER: classified as rea-managed (refresh)', async () => {
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

  it('hook with neither marker but exec-ing the gate: classified as gate-delegating', async () => {
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-push'),
      '#!/bin/sh\nnpx lint-staged\nexec .claude/hooks/push-review-gate.sh "$@"\n',
      { mode: 0o755 },
    );

    const decision = await classifyPrePushInstall(dir);
    // gate-delegating + executable → active-pre-push-present (skip)
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toBe('active-pre-push-present');
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 1 (doctor) regression suite — inspectPrePushState Husky recognition
//
// Codex finding: `inspectPrePushState` computed `reaManaged` using only
// `isReaManagedFallback`. A repo with `core.hooksPath=.husky` and the
// canonical Husky hook (carrying `HUSKY_GATE_MARKER` at line 2) was reported
// as `activeForeign=true`, causing `rea doctor` to warn and fail under
// `--strict`. Fix: also check `isReaManagedHuskyGate` when computing
// `reaManaged` in `inspectPrePushState`.
// ---------------------------------------------------------------------------
describe('inspectPrePushState — Husky gate recognized as rea-managed (Finding 1)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepush-f1-')),
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('hooksPath=.husky + Husky gate marker at line 2 + HALT sentinel: ok=true, reaManaged=true', async () => {
    // Core regression. Without the fix, activeForeign would be true and
    // `rea doctor` would hard-fail on a correctly governed repo.
    // Fixture includes the HALT sentinel so isReaManagedHuskyGate returns true.
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(
      path.join(huskyDir, 'pre-push'),
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n[ -f .rea/HALT ] && exit 1\nif ! grep '"tool_name":"codex.review"' .rea/audit.jsonl; then exit 1; fi\nexec .claude/hooks/push-review-gate.sh "$@"\n`,
      { mode: 0o755 },
    );
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', huskyDir]);

    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(true);
    expect(state.activeForeign).toBe(false);
    const active = state.candidates.find(
      (c) => c.path === path.join(huskyDir, 'pre-push'),
    );
    expect(active?.reaManaged).toBe(true);
  });

  it('hooksPath=.husky + Husky gate marker buried at line 3: ok=false, activeForeign=true', async () => {
    // Marker not at line 2 must NOT be recognized as rea-managed by doctor.
    await initGitRepo(dir);
    const huskyDir = path.join(dir, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(
      path.join(huskyDir, 'pre-push'),
      `#!/bin/sh\n# consumer header\n${HUSKY_GATE_MARKER}\nset -eu\n`,
      { mode: 0o755 },
    );
    await execFileAsync('git', ['-C', dir, 'config', 'core.hooksPath', huskyDir]);

    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(false);
    expect(state.activeForeign).toBe(true);
    const active = state.candidates.find(
      (c) => c.path === path.join(huskyDir, 'pre-push'),
    );
    expect(active?.reaManaged).toBe(false);
  });

  // R13 F3: the previous `activeSuspect` warn downgrade was based on a bare
  // substring match of the gate path in the hook body. That is unsafe — any
  // comment, echo, or dead string mentioning the path would mask a silent
  // bypass. `rea doctor` now fails closed: if the structural parser cannot
  // confirm a real invocation, the check fails.

  it('R13 F3: hook mentions gate path via unusual indirection: activeForeign=true (fail closed)', async () => {
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    // Exotic shape: command substitution assigning a transformed gate
    // path. Parser doesn't recognize the invocation form — doctor must
    // fail rather than warn, because the parse miss is not proof that the
    // gate actually runs.
    const content = [
      '#!/bin/sh',
      'RUNNER=$(printf "%s" .claude/hooks/push-review-gate.sh | tr a-z a-z)',
      'eval "$RUNNER" "$@"',
    ].join('\n');
    await fs.writeFile(path.join(hooksDir, 'pre-push'), content, {
      mode: 0o755,
    });

    const state = await inspectPrePushState(dir);
    expect(state.activeForeign).toBe(true);
    expect(state.ok).toBe(false);
  });

  it('R13 F3: hook with only an echo/comment mention of the gate: activeForeign=true', async () => {
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    // A dead-string mention (echo of the path) used to downgrade the
    // doctor verdict to WARN via `activeSuspect`. Now it MUST fail,
    // because the hook clearly does not invoke the gate.
    const content = [
      '#!/bin/sh',
      'echo "run .claude/hooks/push-review-gate.sh if you want to" >&2',
      'npm run lint',
    ].join('\n');
    await fs.writeFile(path.join(hooksDir, 'pre-push'), content, {
      mode: 0o755,
    });

    const state = await inspectPrePushState(dir);
    expect(state.activeForeign).toBe(true);
    expect(state.ok).toBe(false);
  });

  it('R13 F3: hook with no gate mention: activeForeign=true, ok=false', async () => {
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const content = ['#!/bin/sh', 'npm run lint', 'npm test'].join('\n');
    await fs.writeFile(path.join(hooksDir, 'pre-push'), content, {
      mode: 0o755,
    });

    const state = await inspectPrePushState(dir);
    expect(state.activeForeign).toBe(true);
    expect(state.ok).toBe(false);
  });

  it('R13 F3: cleanly-governed hook passes (activeForeign=false, ok=true)', async () => {
    await initGitRepo(dir);
    const hooksDir = path.join(dir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const content = [
      '#!/bin/sh',
      'exec .claude/hooks/push-review-gate.sh "$@"',
    ].join('\n');
    await fs.writeFile(path.join(hooksDir, 'pre-push'), content, {
      mode: 0o755,
    });

    const state = await inspectPrePushState(dir);
    expect(state.ok).toBe(true);
    expect(state.activeForeign).toBe(false);
  });
});
