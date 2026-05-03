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
  isHusky9Stub,
  isLegacyReaManagedFallback,
  isLegacyReaManagedHuskyGate,
  isReaManagedFallback,
  isReaManagedHuskyGate,
  LEGACY_FALLBACK_MARKER_V1,
  LEGACY_HUSKY_GATE_BODY_MARKER_V1,
  LEGACY_HUSKY_GATE_MARKER_V1,
  referencesReviewGate,
  resolveHusky9StubTarget,
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

describe('BODY_TEMPLATE — path-with-spaces portability (Fix A / 0.12.0)', () => {
  it('uses positional-args dispatch via `set --` rather than `exec $REA_BIN`', () => {
    const body = fallbackHookContent();
    // The 0.11.x body word-split on `exec $REA_BIN ...` — break that by
    // ensuring the modern form uses `set --` arms. v4 (0.13.0) introduced
    // post-body extension-fragment chaining; 0.13.2 wraps the dispatch in
    // a subshell `(...)` so the `set --` rewrite of $@ does NOT bleed into
    // the parent shell where the fragment loop runs.
    expect(body).toMatch(/set -- "\$\{REA_ROOT\}\/node_modules\/\.bin\/rea" hook push-gate "\$@"/);
    expect(body).toMatch(/set -- node "\$\{REA_ROOT\}\/dist\/cli\/index\.js" hook push-gate "\$@"/);
    // 0.13.2: rea body invoked via `exec "$@"` inside a subshell, with
    // status captured via `$?` after the subshell exits. The $@ rewrite
    // is scoped to the subshell so the fragment loop's `"$@"` still
    // sees git's original argv.
    expect(body).toMatch(/exec\s+"\$@"/);
    expect(body).toMatch(/rea_status=\$\?/);
    // The fragile pattern `exec $REA_BIN ...` must not appear as an
    // executable line. Comments referencing the historic bug are fine —
    // anchor the negative match to lines NOT starting with `#`.
    const bodyLines = body.split('\n');
    const executableLines = bodyLines.filter((l) => !/^\s*#/.test(l));
    expect(executableLines.some((l) => /exec\s+\$REA_BIN/.test(l))).toBe(false);
  });

  it('shellcheck-clean: every command substitution + var expansion is double-quoted', () => {
    const body = fallbackHookContent();
    // `${REA_ROOT}/...` paths inside `set --` arms must be quoted (positional
    // arg integrity when the path contains spaces).
    expect(body).toMatch(/"\$\{REA_ROOT\}\/node_modules\/\.bin\/rea"/);
    expect(body).toMatch(/"\$\{REA_ROOT\}\/dist\/cli\/index\.js"/);
    // The HALT-detection branch already used quoted expansion; keep it.
    expect(body).toMatch(/"\$\{REA_ROOT\}\/\.rea\/HALT"/);
  });

  it('dogfood `dist/cli/index.js` branch is gated on package.json declaring @bookedsolid/rea', () => {
    // Regression for codex-adversarial finding 2026-04-29 (P1):
    // a bare `[ -f dist/cli/index.js ]` predicate fired in any consumer
    // repo that happened to ship its own dist/cli/index.js — running the
    // consumer's unrelated app with `hook push-gate` instead of REA. The
    // dogfood arm must require a rea-specific package.json signal too.
    const body = fallbackHookContent();
    expect(body).toMatch(/grep -q '"name": \*"@bookedsolid\/rea"' "\$\{REA_ROOT\}\/package\.json"/);
    expect(body).toMatch(/\[ -f "\$\{REA_ROOT\}\/dist\/cli\/index\.js" \] && \[ -f "\$\{REA_ROOT\}\/package\.json" \]/);
  });

  it('shipped husky body delegates via `set --` arms identically to the fallback', () => {
    const husky = huskyHookContent();
    expect(husky).toMatch(/set -- "\$\{REA_ROOT\}\/node_modules\/\.bin\/rea" hook push-gate "\$@"/);
    // 0.13.2: rea body invoked via `exec "$@"` inside a subshell so post-body
    // extension-fragment chaining sees git's original argv.
    expect(husky).toMatch(/exec\s+"\$@"/);
    expect(husky).toMatch(/rea_status=\$\?/);
    const huskyLines = husky.split('\n');
    const executableHuskyLines = huskyLines.filter((l) => !/^\s*#/.test(l));
    expect(executableHuskyLines.some((l) => /exec\s+\$REA_BIN/.test(l))).toBe(false);
  });

  it('runs end-to-end against a path containing a space (real shell exec)', async () => {
    // Stage the body in a tmpdir whose path contains a space (the
    // helixir-migration breakage). Use `sh -n` for a syntax check first
    // (parse failures would manifest as syntax errors when REA_ROOT
    // contained whitespace under the old word-split form).
    const dirWithSpace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-prepush-space ')),
    );
    try {
      const hp = path.join(dirWithSpace, 'pre-push');
      await fs.writeFile(hp, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      // sh -n verifies the body parses without word-splitting issues even
      // when the surrounding directory has whitespace.
      const r = await execFileAsync('sh', ['-n', hp]);
      expect(r.stderr).toBe('');
    } finally {
      await fs.rm(dirWithSpace, { recursive: true, force: true });
    }
  });
});

describe('marker bumps (Fix H / 0.13.0) — v4 markers + v3/v2 legacy detection', () => {
  it('FALLBACK_MARKER is the v4 marker', () => {
    expect(FALLBACK_MARKER).toBe('# rea:pre-push-fallback v4');
  });

  it('HUSKY_GATE_MARKER and HUSKY_GATE_BODY_MARKER are v4', () => {
    expect(HUSKY_GATE_MARKER).toBe('# rea:husky-pre-push-gate v4');
    expect(HUSKY_GATE_BODY_MARKER).toBe('# rea:gate-body-v4');
  });

  it('isLegacyReaManagedFallback recognizes 0.12.x v3 markers (refresh-on-upgrade)', () => {
    const v3Body = `#!/bin/sh\n# rea:pre-push-fallback v3\n# rea:gate-body-v3\nset -eu\nexec "$@"\n`;
    expect(isLegacyReaManagedFallback(v3Body)).toBe(true);
  });

  it('isLegacyReaManagedFallback recognizes 0.11.x v2 markers (refresh-on-upgrade)', () => {
    const v2Body = `#!/bin/sh\n# rea:pre-push-fallback v2\n# rea:gate-body-v2\nset -eu\nexec $REA_BIN hook push-gate "$@"\n`;
    expect(isLegacyReaManagedFallback(v2Body)).toBe(true);
  });

  it('isLegacyReaManagedHuskyGate recognizes 0.12.x v3 marker pair (refresh-on-upgrade)', () => {
    const v3Body = `#!/bin/sh\n# rea:husky-pre-push-gate v3\n# rea:gate-body-v3\nset -eu\nexec "$@"\n`;
    expect(isLegacyReaManagedHuskyGate(v3Body)).toBe(true);
  });

  it('isLegacyReaManagedHuskyGate recognizes 0.11.x v2 marker pair (refresh-on-upgrade)', () => {
    const v2Body = `#!/bin/sh\n# rea:husky-pre-push-gate v2\n# rea:gate-body-v2\nset -eu\nexec $REA_BIN hook push-gate "$@"\n`;
    expect(isLegacyReaManagedHuskyGate(v2Body)).toBe(true);
  });

  it('classifyExistingHook maps a v3 husky body to rea-managed-husky-legacy-v1 (legacy bucket)', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-v3-')));
    try {
      const hp = path.join(tmp, 'pre-push');
      const v3Body = `#!/bin/sh\n# rea:husky-pre-push-gate v3\n# rea:gate-body-v3\nset -eu\nexec "$@"\n`;
      await writeHook(hp, v3Body);
      const res = await classifyExistingHook(hp);
      expect(res.kind).toBe('rea-managed-husky-legacy-v1');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('classifyExistingHook maps a v2 husky body to rea-managed-husky-legacy-v1 (legacy bucket)', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-v2-')));
    try {
      const hp = path.join(tmp, 'pre-push');
      const v2Body = `#!/bin/sh\n# rea:husky-pre-push-gate v2\n# rea:gate-body-v2\nset -eu\nexec $REA_BIN hook push-gate "$@"\n`;
      await writeHook(hp, v2Body);
      const res = await classifyExistingHook(hp);
      expect(res.kind).toBe('rea-managed-husky-legacy-v1');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
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
// Husky 9 stub follow (false-positive fix — see helixir migration report)
// ---------------------------------------------------------------------------

describe('isHusky9Stub — husky 9 auto-generated stub detection', () => {
  it('accepts the canonical husky 9 stub with `${0%/*}/h`', () => {
    const stub = '#!/usr/bin/env sh\n. "${0%/*}/h"\n';
    expect(isHusky9Stub(stub)).toBe(true);
  });

  it('accepts the alternate `$(dirname -- "$0")/h` shape', () => {
    const stub = '#!/usr/bin/env sh\n. "$(dirname -- "$0")/h"\n';
    expect(isHusky9Stub(stub)).toBe(true);
  });

  it('accepts the stub with a trailing comment block', () => {
    const stub =
      '#!/usr/bin/env sh\n# husky 9 stub — do not edit\n. "${0%/*}/h"\n# fires .husky/<hookname>\n';
    expect(isHusky9Stub(stub)).toBe(true);
  });

  it('rejects a husky 9 stub with extra non-comment lines', () => {
    const stub = '#!/usr/bin/env sh\n. "${0%/*}/h"\necho "after"\n';
    expect(isHusky9Stub(stub)).toBe(false);
  });

  it('rejects a hook that sources something other than `h`', () => {
    expect(isHusky9Stub('#!/usr/bin/env sh\n. "${0%/*}/init.sh"\n')).toBe(false);
  });

  it('rejects a hook whose source argument has no `$0` self-reference', () => {
    expect(isHusky9Stub('#!/usr/bin/env sh\n. /usr/local/lib/h\n')).toBe(false);
  });

  it('rejects the rea husky body (multi-line, references `rea hook push-gate`)', () => {
    expect(isHusky9Stub(huskyHookContent())).toBe(false);
  });

  it('rejects a foreign multi-command hook', () => {
    expect(isHusky9Stub('#!/bin/sh\npnpm lint\npnpm test\n')).toBe(false);
  });

  it('rejects an empty file', () => {
    expect(isHusky9Stub('')).toBe(false);
  });
});

describe('resolveHusky9StubTarget — derive parent hook path', () => {
  it('walks `.husky/_/pre-push` to `.husky/pre-push`', () => {
    expect(resolveHusky9StubTarget('/repo/.husky/_/pre-push')).toBe('/repo/.husky/pre-push');
  });

  it('walks any one-level husky-style stub directory', () => {
    expect(resolveHusky9StubTarget('/repo/hooks/_/commit-msg')).toBe('/repo/hooks/commit-msg');
  });

  it('returns null at the filesystem root', () => {
    expect(resolveHusky9StubTarget('/pre-push')).toBe(null);
  });
});

describe('classifyExistingHook — follows husky 9 stubs to canonical body', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('returns rea-managed-husky when the active stub points at a rea-managed parent', async () => {
    // Reproduces the helixir false-positive: git fires `.husky/_/pre-push`
    // (auto-generated) which sources `.husky/_/h` which exec's the canonical
    // `.husky/pre-push` (rea-managed). Doctor should follow the chain.
    const stubPath = path.join(repo, '.husky/_/pre-push');
    const realPath = path.join(repo, '.husky/pre-push');
    await writeHook(stubPath, '#!/usr/bin/env sh\n. "${0%/*}/h"\n');
    await writeHook(realPath, huskyHookContent());

    const res = await classifyExistingHook(stubPath);
    expect(res.kind).toBe('rea-managed-husky');
  });

  it('returns gate-delegating when the parent is a custom hook that invokes the gate', async () => {
    const stubPath = path.join(repo, '.husky/_/pre-push');
    const realPath = path.join(repo, '.husky/pre-push');
    await writeHook(stubPath, '#!/usr/bin/env sh\n. "${0%/*}/h"\n');
    await writeHook(realPath, '#!/bin/sh\necho custom\nexec rea hook push-gate "$@"\n');

    const res = await classifyExistingHook(stubPath);
    expect(res.kind).toBe('gate-delegating');
  });

  it('returns absent when the stub points at a missing parent', async () => {
    const stubPath = path.join(repo, '.husky/_/pre-push');
    await writeHook(stubPath, '#!/usr/bin/env sh\n. "${0%/*}/h"\n');
    const res = await classifyExistingHook(stubPath);
    expect(res.kind).toBe('absent');
  });

  it('returns foreign when the stub points at a foreign parent', async () => {
    const stubPath = path.join(repo, '.husky/_/pre-push');
    const realPath = path.join(repo, '.husky/pre-push');
    await writeHook(stubPath, '#!/usr/bin/env sh\n. "${0%/*}/h"\n');
    await writeHook(realPath, '#!/bin/sh\npnpm lint\n');
    const res = await classifyExistingHook(stubPath);
    expect(res.kind).toBe('foreign');
  });

  it('does not recurse stubs of stubs (one level of follow only)', async () => {
    // Two stubs in a chain — the outer stub follows once, then the second
    // stub is classified WITHOUT further follow, so it returns foreign.
    const outer = path.join(repo, '.husky/_/_/pre-push');
    const inner = path.join(repo, '.husky/_/pre-push');
    await writeHook(outer, '#!/usr/bin/env sh\n. "${0%/*}/h"\n');
    await writeHook(inner, '#!/usr/bin/env sh\n. "${0%/*}/h"\n');
    const res = await classifyExistingHook(outer);
    // Inner stub, when classified without follow, is foreign (no marker, not
    // rea-managed). This proves we cap the chain at one hop and don't loop.
    expect(res.kind).toBe('foreign');
  });

  it('returns rea-managed-husky directly (not via stub follow) when called on the canonical body', async () => {
    // Sanity: non-stub paths take the normal classifier path; the stub follow
    // is skipped because `isHusky9Stub` returns false for the rea body.
    const realPath = path.join(repo, '.husky/pre-push');
    await writeHook(realPath, huskyHookContent());
    const res = await classifyExistingHook(realPath);
    expect(res.kind).toBe('rea-managed-husky');
  });
});

describe('inspectPrePushState — husky 9 governance via stub indirection', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('reports ok=true when core.hooksPath=.husky/_ and the stub delegates to a rea-managed parent', async () => {
    // The exact helixir failure: doctor previously reported
    // ok=false because it classified `.husky/_/pre-push` (the stub) as
    // foreign. With the stub-follow patch, doctor sees through the
    // indirection and recognizes the rea-managed `.husky/pre-push`.
    await setHooksPath(repo, '.husky/_');
    const stubPath = path.join(repo, '.husky/_/pre-push');
    const realPath = path.join(repo, '.husky/pre-push');
    await writeHook(stubPath, '#!/usr/bin/env sh\n. "${0%/*}/h"\n');
    await writeHook(realPath, huskyHookContent());

    const state = await inspectPrePushState(repo);
    expect(state.ok).toBe(true);
    expect(state.activeForeign).toBe(false);
    expect(state.activePath).toBe(stubPath);
  });

  it('reports activeForeign=true when the stub delegates to a foreign parent', async () => {
    await setHooksPath(repo, '.husky/_');
    const stubPath = path.join(repo, '.husky/_/pre-push');
    const realPath = path.join(repo, '.husky/pre-push');
    await writeHook(stubPath, '#!/usr/bin/env sh\n. "${0%/*}/h"\n');
    await writeHook(realPath, '#!/bin/sh\npnpm lint\n');

    const state = await inspectPrePushState(repo);
    expect(state.ok).toBe(false);
    expect(state.activeForeign).toBe(true);
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

  it('skip + active-pre-push-present on husky 9 layout (stub delegates to rea-managed parent)', async () => {
    // Pin the install-side behavior change: husky 9 layouts where
    // core.hooksPath=.husky/_ used to classify the active hook (the stub)
    // as foreign and warn `skip + foreign-pre-push`. With stub-follow,
    // the install path now sees the parent's `rea-managed-husky`
    // classification and correctly skips with `active-pre-push-present`
    // — matching the canonical husky-gate path.
    await setHooksPath(repo, '.husky/_');
    const stubPath = path.join(repo, '.husky', '_', 'pre-push');
    const realPath = path.join(repo, '.husky', 'pre-push');
    await writeHook(stubPath, '#!/usr/bin/env sh\n. "${0%/*}/h"\n');
    await writeHook(realPath, huskyHookContent());
    const d = await classifyPrePushInstall(repo);
    expect(d).toEqual({
      action: 'skip',
      reason: 'active-pre-push-present',
      hookPath: stubPath,
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

// ---------------------------------------------------------------------------
// Extension-hook chaining (Fix H / 0.13.0)
// ---------------------------------------------------------------------------

describe('extension-hook chaining (Fix H / 0.13.0) — `.husky/pre-push.d/*`', () => {
  it('BODY contains the extension-hook loop sourcing `.husky/pre-push.d/`', () => {
    const body = fallbackHookContent();
    expect(body).toMatch(/ext_dir="\$\{REA_ROOT\}\/\.husky\/pre-push\.d"/);
    expect(body).toMatch(/if \[ -d "\$ext_dir" \]; then/);
    // Lex-ordered glob — POSIX `*` expands sorted.
    expect(body).toMatch(/for frag in "\$ext_dir"\/\*/);
    // Executable-bit gate — non-executable files are skipped silently.
    expect(body).toMatch(/\[ -x "\$frag" \] \|\| continue/);
    // Fragment receives original positional args.
    expect(body).toMatch(/"\$frag" "\$@"/);
  });

  it('BODY runs rea push-gate FIRST and exits on its non-zero — fragments only fire on success', () => {
    const body = fallbackHookContent();
    // Fragment loop must come AFTER the rea_status guard. Verify the
    // status check + early-exit precedes the ext_dir loop.
    const reaStatusIdx = body.indexOf('rea_status=$?');
    const extDirIdx = body.indexOf('ext_dir="${REA_ROOT}/.husky/pre-push.d"');
    expect(reaStatusIdx).toBeGreaterThan(0);
    expect(extDirIdx).toBeGreaterThan(reaStatusIdx);
    expect(body).toMatch(/if \[ "\$rea_status" -ne 0 \]; then\n\s*exit "\$rea_status"/);
  });

  it('shipped husky hook also carries the extension-hook loop', () => {
    const husky = huskyHookContent();
    expect(husky).toMatch(/ext_dir="\$\{REA_ROOT\}\/\.husky\/pre-push\.d"/);
    expect(husky).toMatch(/for frag in "\$ext_dir"\/\*/);
  });

  it('BODY parses cleanly under `sh -n` (POSIX syntax check)', async () => {
    const tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-h-')),
    );
    try {
      const hp = path.join(tmpDir, 'pre-push');
      await fs.writeFile(hp, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      const r = await execFileAsync('sh', ['-n', hp]);
      expect(r.stderr).toBe('');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('end-to-end: a successful rea body invokes fragments in lex order', async () => {
    // Stand up a tmp REA_ROOT with a stubbed rea binary that exits 0,
    // a `.husky/pre-push.d/` populated with three fragments, and the
    // extension-loop body. Track invocation order via a shared log
    // file. The fragments must run after the rea body in lex order
    // (10 → 20 → 90), and the final exit code must be 0.
    const repoDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-e2e-')),
    );
    try {
      // Init a real git repo so `git rev-parse --show-toplevel` works.
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      // Stub the rea CLI under node_modules/.bin/rea — write a 0-exit
      // shell script that logs a marker line and then exits.
      const log = path.join(repoDir, 'order.log');
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      await fs.writeFile(
        stubBin,
        `#!/bin/sh\nprintf 'rea\\n' >> "${log}"\nexit 0\n`,
        { mode: 0o755 },
      );
      // Fragments in deliberately-non-alphabetical filenames to prove
      // sort-order, not creation-order, dictates execution.
      const fragDir = path.join(repoDir, '.husky', 'pre-push.d');
      await fs.mkdir(fragDir, { recursive: true });
      await fs.writeFile(
        path.join(fragDir, '90-third'),
        `#!/bin/sh\nprintf 'third\\n' >> "${log}"\n`,
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(fragDir, '10-first'),
        `#!/bin/sh\nprintf 'first\\n' >> "${log}"\n`,
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(fragDir, '20-second'),
        `#!/bin/sh\nprintf 'second\\n' >> "${log}"\n`,
        { mode: 0o755 },
      );
      // A README sitting in the dir without exec bit is silently skipped.
      await fs.writeFile(path.join(fragDir, 'README'), '# notes\n', { mode: 0o644 });

      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
      await fs.writeFile(hookPath, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      // Invoke the hook; pre-push fixtures pass two positional args
      // (remote name, remote URL).
      const r = await execFileAsync(hookPath, ['origin', 'git@example:repo.git'], {
        cwd: repoDir,
      });
      expect(r.stderr).toBe('');
      const order = (await fs.readFile(log, 'utf8')).trim().split('\n');
      expect(order).toEqual(['rea', 'first', 'second', 'third']);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('end-to-end: a non-zero fragment fails the push (set -eu propagates)', async () => {
    const repoDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-fail-')),
    );
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      await fs.writeFile(stubBin, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
      const fragDir = path.join(repoDir, '.husky', 'pre-push.d');
      await fs.mkdir(fragDir, { recursive: true });
      await fs.writeFile(
        path.join(fragDir, '50-broken'),
        `#!/bin/sh\nprintf 'broken\\n' >&2\nexit 7\n`,
        { mode: 0o755 },
      );
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
      await fs.writeFile(hookPath, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      const r = await execFileAsync(hookPath, ['origin', 'git@example:r.git'], {
        cwd: repoDir,
      }).catch((e: { code?: number; stderr?: string }) => e);
      // When set -eu propagates a non-zero from the fragment, the script
      // exits with that non-zero status. execFileAsync rejects.
      const exitCode = (r as { code?: number }).code ?? 0;
      expect(exitCode).not.toBe(0);
      expect((r as { stderr?: string }).stderr ?? '').toContain('broken');
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('missing `.husky/pre-push.d/` is a no-op (backward compat)', async () => {
    const repoDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-noop-')),
    );
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      await fs.writeFile(stubBin, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
      // No `.husky/pre-push.d/` directory.
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
      await fs.writeFile(hookPath, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      const r = await execFileAsync(hookPath, ['origin', 'git@example:r.git'], {
        cwd: repoDir,
      });
      expect(r.stderr).toBe('');
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('non-executable files in `.husky/pre-push.d/` are silently skipped', async () => {
    const repoDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-skip-')),
    );
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const log = path.join(repoDir, 'order.log');
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      await fs.writeFile(
        stubBin,
        `#!/bin/sh\nprintf 'rea\\n' >> "${log}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const fragDir = path.join(repoDir, '.husky', 'pre-push.d');
      await fs.mkdir(fragDir, { recursive: true });
      // 10-not-exec is a valid shell script BUT lacks the exec bit — must be skipped.
      await fs.writeFile(
        path.join(fragDir, '10-not-exec'),
        `#!/bin/sh\nprintf 'should-not-run\\n' >> "${log}"\n`,
        { mode: 0o644 },
      );
      // 20-runs IS executable — must run.
      await fs.writeFile(
        path.join(fragDir, '20-runs'),
        `#!/bin/sh\nprintf 'runs\\n' >> "${log}"\n`,
        { mode: 0o755 },
      );
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
      await fs.writeFile(hookPath, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      await execFileAsync(hookPath, ['origin', 'git@example:r.git'], { cwd: repoDir });
      const order = (await fs.readFile(log, 'utf8')).trim().split('\n');
      expect(order).toEqual(['rea', 'runs']);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('end-to-end: fragments receive git\'s original argv (Fix 0.13.2 — $@ preservation)', async () => {
    // Regression test for the BST 2026-05-03 report. Pre-0.13.2, the rea
    // dispatch used `set -- "${REA_ROOT}/node_modules/.bin/rea" hook push-gate "$@"`
    // followed by `"$@"` to invoke. The `set --` mutated the parent shell's
    // $@, so by the time the fragment loop ran `"$frag" "$@"` it was passing
    // the rewritten rea-CLI argv (`<rea-bin> hook push-gate <remote> <url>`)
    // instead of git's original `<remote> <url>` — breaking branch-policy
    // linters, lint-staged-on-push wrappers, and any fragment that reads
    // $1/$2 per the standard pre-push contract. The fix wraps the dispatch
    // in a subshell `(...)` so set-- stays scoped.
    const repoDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-argv-')),
    );
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const reaArgvLog = path.join(repoDir, 'rea-argv.log');
      const fragArgvLog = path.join(repoDir, 'frag-argv.log');
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      // rea CLI logs its full argv so we can assert it gets `hook push-gate
      // <remote> <url>` (the dispatched argv).
      await fs.writeFile(
        stubBin,
        `#!/bin/sh\nprintf '%s\\n' "$#" "$@" >> "${reaArgvLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const fragDir = path.join(repoDir, '.husky', 'pre-push.d');
      await fs.mkdir(fragDir, { recursive: true });
      // Fragment logs its argv so we can assert it gets git's original
      // `<remote> <url>` (NOT the rea-CLI dispatched argv).
      await fs.writeFile(
        path.join(fragDir, '99-argv-probe'),
        `#!/bin/sh\nprintf '%s\\n' "$#" "$@" >> "${fragArgvLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
      await fs.writeFile(hookPath, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      await execFileAsync(hookPath, ['origin', 'git@example:repo.git'], { cwd: repoDir });

      const reaArgv = (await fs.readFile(reaArgvLog, 'utf8')).trim().split('\n');
      // rea CLI receives: argc=4, args = hook push-gate origin git@example:repo.git
      expect(reaArgv).toEqual(['4', 'hook', 'push-gate', 'origin', 'git@example:repo.git']);

      const fragArgv = (await fs.readFile(fragArgvLog, 'utf8')).trim().split('\n');
      // Fragment receives: argc=2, args = origin git@example:repo.git (git's original)
      expect(fragArgv).toEqual(['2', 'origin', 'git@example:repo.git']);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('end-to-end: fragments receive git\'s argv even when rea CLI is multi-token (node + script path)', async () => {
    // Variant of the argv preservation test using the dogfood dispatch arm
    // (`set -- node "${REA_ROOT}/dist/cli/index.js" hook push-gate "$@"`),
    // which has the most tokens and the highest blast radius for $@
    // contamination.
    const repoDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-argv2-')),
    );
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      // Set up the dogfood dispatch trigger: dist/cli/index.js + a
      // package.json declaring the rea package name.
      const distEntry = path.join(repoDir, 'dist', 'cli', 'index.js');
      await fs.mkdir(path.dirname(distEntry), { recursive: true });
      const reaLog = path.join(repoDir, 'rea-argv.log');
      const fragLog = path.join(repoDir, 'frag-argv.log');
      // The "rea CLI" here is actually a node script that logs its argv.
      await fs.writeFile(
        distEntry,
        `#!/usr/bin/env node\nimport('node:fs').then(({ writeFileSync, appendFileSync }) => {\n  appendFileSync(${JSON.stringify(reaLog)}, [process.argv.length - 2, ...process.argv.slice(2)].join('\\n') + '\\n');\n  process.exit(0);\n});\n`,
      );
      await fs.writeFile(
        path.join(repoDir, 'package.json'),
        JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0' }),
      );
      const fragDir = path.join(repoDir, '.husky', 'pre-push.d');
      await fs.mkdir(fragDir, { recursive: true });
      await fs.writeFile(
        path.join(fragDir, '99-argv-probe'),
        `#!/bin/sh\nprintf '%s\\n' "$#" "$@" >> "${fragLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
      await fs.writeFile(hookPath, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      await execFileAsync(hookPath, ['origin', 'git@example:repo.git'], { cwd: repoDir });

      const reaArgv = (await fs.readFile(reaLog, 'utf8')).trim().split('\n');
      // node receives: hook, push-gate, origin, git@example:repo.git (after script path)
      expect(reaArgv).toEqual(['4', 'hook', 'push-gate', 'origin', 'git@example:repo.git']);

      const fragArgv = (await fs.readFile(fragLog, 'utf8')).trim().split('\n');
      expect(fragArgv).toEqual(['2', 'origin', 'git@example:repo.git']);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });
});
