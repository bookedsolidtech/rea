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
      `grep -q codex.review .rea/audit.jsonl\n`;

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
        `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n[ -f .rea/HALT ] && exit 1\ngrep codex.review .rea/audit.jsonl\n`,
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
    const content = `#!/bin/sh\r\n${HUSKY_GATE_MARKER}\r\n${HUSKY_GATE_BODY_MARKER}\r\n[ -f .rea/HALT ] && exit 1\r\ngrep codex.review .rea/audit.jsonl\r\n`;
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
      `grep -q codex.review .rea/audit.jsonl\n`;
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
      `grep -qE '"tool_name":"codex.review"' .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R12 F1: block form with grouped short-circuit `&& { ...; exit 1; }`: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && { printf 'frozen\\n' >&2; exit 1; }\n` +
      `grep -q codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R12 F1: test -f HALT form + grep codex.review: returns true', () => {
    // R13 F2 tightening: the audit check now requires a `codex.review`
    // content match by grep/rg, not a file-existence test. The HALT side
    // still works with the POSIX `test -f` form for detection.
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `test -f .rea/HALT && exit 1\n` +
      `grep -q '"tool_name":"codex.review"' .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R12 F1: rg (ripgrep) + audit token: returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `rg -q codex.review .rea/audit.jsonl\n`;
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
      `grep -q codex.review .rea/audit.jsonl\n`;
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
      `grep -q codex.review .rea/audit.jsonl\n`;
    expect(isReaManagedHuskyGate(content)).toBe(true);
  });

  it('R13 F2: grep-escaped `codex\\.review` shape (matches shipped .husky/pre-push): returns true', () => {
    const content =
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n` +
      `[ -f .rea/HALT ] && exit 1\n` +
      `grep -E '"tool_name":"codex\\.review"' .rea/audit.jsonl\n`;
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
      `#!/bin/sh\n${HUSKY_GATE_MARKER}\n${HUSKY_GATE_BODY_MARKER}\n[ -f .rea/HALT ] && exit 1\ngrep '"tool_name":"codex.review"' .rea/audit.jsonl || exit 1\nexec .claude/hooks/push-review-gate.sh "$@"\n`,
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
