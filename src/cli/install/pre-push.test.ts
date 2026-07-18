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
    expect(body).toMatch(/set -- "\$\{REA_CLI_ROOT\}\/node_modules\/\.bin\/rea" hook push-gate "\$@"/);
    expect(body).toMatch(/set -- node "\$\{REA_CLI_ROOT\}\/dist\/cli\/index\.js" hook push-gate "\$@"/);
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
    expect(body).toMatch(/"\$\{REA_CLI_ROOT\}\/node_modules\/\.bin\/rea"/);
    expect(body).toMatch(/"\$\{REA_CLI_ROOT\}\/dist\/cli\/index\.js"/);
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
    expect(body).toMatch(/grep -q '"name": \*"@bookedsolid\/rea"' "\$\{REA_CLI_ROOT\}\/package\.json"/);
    expect(body).toMatch(
      /\[ -f "\$\{REA_CLI_ROOT\}\/dist\/cli\/index\.js" \] && \[ -f "\$\{REA_CLI_ROOT\}\/package\.json" \]/,
    );
  });

  it('shipped husky body delegates via `set --` arms identically to the fallback', () => {
    const husky = huskyHookContent();
    expect(husky).toMatch(/set -- "\$\{REA_CLI_ROOT\}\/node_modules\/\.bin\/rea" hook push-gate "\$@"/);
    // 0.13.2: rea body invoked via `exec "$@"` inside a subshell so post-body
    // extension-fragment chaining sees git's original argv.
    expect(husky).toMatch(/exec\s+"\$@"/);
    expect(husky).toMatch(/rea_status=\$\?/);
    const huskyLines = husky.split('\n');
    const executableHuskyLines = huskyLines.filter((l) => !/^\s*#/.test(l));
    expect(executableHuskyLines.some((l) => /exec\s+\$REA_BIN/.test(l))).toBe(false);
  });

  it('carries the round-54 tri-state no-preflight split (mode detector + enforce/shadow/off branches)', () => {
    const body = fallbackHookContent();
    // The gate-MODE helper exists and reads the LOCAL policy via REA_ROOT.
    expect(body).toMatch(/_rea_review_gate_mode\(\) \{/);
    expect(body).toMatch(/_rea_pol="\$\{REA_ROOT\}\/\.rea\/policy\.yaml"/);
    // Absent policy → off (allow); no awk → enforce (bias closed).
    expect(body).toMatch(/\[ -f "\$_rea_pol" \] \|\| \{ printf 'off'; return 0; \}/);
    expect(body).toMatch(/command -v awk >\/dev\/null 2>&1 \|\| \{ printf 'enforce'; return 0; \}/);
    // Detection targets both gate blocks (block + inline flow map at any depth).
    expect(body).toMatch(/opener="\^\(local_review\|g3_review\):"/);
    expect(body).toMatch(/inlinep="\(local_review\|g3_review\)\[\^A-Za-z_\]\.\*mode:"/);
    // Tri-state: enforce → CONFIG-ERROR + rc 2; shadow → WARN + rc 0; off → rc 0.
    expect(body).toMatch(/case "\$\(_rea_review_gate_mode\)" in/);
    expect(body).toMatch(/enforce\)/);
    expect(body).toMatch(/_pf_out=""; _pf_rc=2/);
    expect(body).toMatch(/CONFIG-ERROR/);
    expect(body).toMatch(/WARN — review gate \(shadow\) could not run/);
    expect(body).toMatch(/REA_SKIP_LOCAL_REVIEW/);
    // The pure `unknown option` arm still allows unconditionally (any mode).
    expect(body).toMatch(/# Pure flag incompatibility on a preflight-capable CLI/);
    // Structural: within the inner (retry) case, the unknown-command arm
    // precedes the unknown-option arm so a missing command is matched first.
    const innerCmd = body.indexOf('*"unknown command"*)');
    const innerOpt = body.lastIndexOf('*"unknown option"*)');
    expect(innerCmd).toBeGreaterThan(-1);
    expect(innerOpt).toBeGreaterThan(innerCmd);
  });

  it('husky body carries the identical round-54 tri-state split', () => {
    const husky = huskyHookContent();
    expect(husky).toMatch(/_rea_review_gate_mode\(\) \{/);
    expect(husky).toMatch(/case "\$\(_rea_review_gate_mode\)" in/);
    expect(husky).toMatch(/CONFIG-ERROR/);
    expect(husky).toMatch(/WARN — review gate \(shadow\) could not run/);
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

describe('marker bumps (0.26.0 — v5 markers + v4/v3/v2 legacy detection)', () => {
  it('FALLBACK_MARKER is the v6 marker', () => {
    expect(FALLBACK_MARKER).toBe('# rea:pre-push-fallback v6');
  });

  it('HUSKY_GATE_MARKER and HUSKY_GATE_BODY_MARKER are v6', () => {
    expect(HUSKY_GATE_MARKER).toBe('# rea:husky-pre-push-gate v6');
    expect(HUSKY_GATE_BODY_MARKER).toBe('# rea:gate-body-v6');
  });

  it('isLegacyReaManagedFallback recognizes 0.13–0.25.x v4 markers (refresh-on-upgrade)', () => {
    const v4Body = `#!/bin/sh\n# rea:pre-push-fallback v4\n# rea:gate-body-v4\nset -eu\nexec "$@"\n`;
    expect(isLegacyReaManagedFallback(v4Body)).toBe(true);
  });

  it('isLegacyReaManagedHuskyGate recognizes 0.13–0.25.x v4 marker pair (refresh-on-upgrade)', () => {
    const v4Body = `#!/bin/sh\n# rea:husky-pre-push-gate v4\n# rea:gate-body-v4\nset -eu\nexec "$@"\n`;
    expect(isLegacyReaManagedHuskyGate(v4Body)).toBe(true);
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
    const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-h-')));
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
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-e2e-')));
    try {
      // Init a real git repo so `git rev-parse --show-toplevel` works.
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      // Stub the rea CLI under node_modules/.bin/rea — write a 0-exit
      // shell script that logs a marker line and then exits.
      const log = path.join(repoDir, 'order.log');
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      // 0.26.0 — the body invokes `rea preflight --strict` BEFORE the
      // `rea hook push-gate` dispatch. The test's intent is the
      // `hook push-gate` arm (extension-fragment ordering); silence
      // the preflight branch so the order log only captures the
      // hook-push-gate invocation.
      await fs.writeFile(
        stubBin,
        `#!/bin/sh\nif [ "\${1:-}" = "preflight" ]; then exit 0; fi\nprintf 'rea\\n' >> "${log}"\nexit 0\n`,
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
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-fail-')));
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      // 0.26.0 — both `rea preflight --strict` (called first by the new body)
      // and `rea hook push-gate` (the dispatch) succeed. Fragment fails next.
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
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-noop-')));
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

  // ── Round-32 F1 — preflight `--operation` compat against an OLD rea CLI ──
  // Helper: run the fallback hook against a stub `rea` in a temp git repo.
  async function runPrePushWithStub(stub: string): Promise<{ code: number; stderr: string }> {
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-compat-')));
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      await fs.writeFile(stubBin, stub, { mode: 0o755 });
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
      await fs.writeFile(hookPath, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      const r = await execFileAsync(hookPath, ['origin', 'git@example:r.git'], {
        cwd: repoDir,
      }).catch((e: { code?: number; stderr?: string }) => e);
      return { code: (r as { code?: number }).code ?? 0, stderr: (r as { stderr?: string }).stderr ?? '' };
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  }

  it('F1: an OLD CLI that rejects `--operation` does NOT block — retries `preflight --strict`', async () => {
    // Stub: `preflight` WITH `--operation` → commander unknown-option (exit 1);
    // `preflight` WITHOUT it (the retry) → 0; `hook push-gate` → 0.
    const stub = [
      '#!/bin/sh',
      'op=0; for a in "$@"; do [ "$a" = "--operation" ] && op=1; done',
      'case "$1" in',
      '  preflight)',
      '    if [ "$op" = "1" ]; then echo "error: unknown option \'--operation\'" >&2; exit 1; fi',
      '    exit 0 ;;',
      '  hook) exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n');
    const r = await runPrePushWithStub(stub);
    expect(r.code).toBe(0); // push NOT blocked
    expect(r.stderr).not.toContain('unknown option'); // the flag error was swallowed
  });

  it('F1: a CLI too old to have `preflight` at all → FAIL OPEN (push not blocked)', async () => {
    // Both invocations → unknown command 'preflight'. The gate can't run; the
    // push-gate second layer still does and the push proceeds.
    const stub = [
      '#!/bin/sh',
      'case "$1" in',
      '  preflight) echo "error: unknown command \'preflight\'" >&2; exit 1 ;;',
      '  hook) exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n');
    const r = await runPrePushWithStub(stub);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('unknown command');
  });

  it('F1: a GENUINE preflight refusal (exit 2, no unknown-* marker) STILL blocks the push', async () => {
    // `preflight` refuses with a real banner + exit 2 → must propagate (block).
    const stub = [
      '#!/bin/sh',
      'case "$1" in',
      '  preflight) echo "REA preflight: no recent local review covers HEAD" >&2; exit 2 ;;',
      '  hook) exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n');
    const r = await runPrePushWithStub(stub);
    expect(r.code).toBe(2); // blocked
    expect(r.stderr).toContain('no recent local review');
  });

  // ── Round-50 P1 — no-preflight compat is MODE-AWARE (off means off) ────────
  // A CLI too old to have `preflight` at all previously ALWAYS failed open,
  // silently disabling a configured git-side review gate. Now the disposition
  // depends on whether the LOCAL policy has an active review-gate mode.
  // `TOO_OLD_NO_PREFLIGHT` emits `unknown command 'preflight'` for BOTH the
  // `--operation` form and the bare-retry form (the retry is what tier 3 sees).
  const TOO_OLD_NO_PREFLIGHT = [
    '#!/bin/sh',
    "case \"$1\" in",
    "  preflight) echo \"error: unknown command 'preflight'\" >&2; exit 1 ;;",
    '  hook) exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');

  async function runPrePushWithStubPolicy(
    stub: string,
    policy: string | null,
  ): Promise<{ code: number; stderr: string }> {
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-p50-')));
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      await fs.writeFile(stubBin, stub, { mode: 0o755 });
      if (policy !== null) {
        await fs.mkdir(path.join(repoDir, '.rea'), { recursive: true });
        await fs.writeFile(path.join(repoDir, '.rea', 'policy.yaml'), policy);
      }
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
      await fs.writeFile(hookPath, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      const r = await execFileAsync(hookPath, ['origin', 'git@example:r.git'], {
        cwd: repoDir,
      }).catch((e: { code?: number; stderr?: string }) => e);
      return {
        code: (r as { code?: number }).code ?? 0,
        stderr: (r as { stderr?: string }).stderr ?? '',
      };
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  }

  it('P1: no-preflight CLI + `local_review.mode: enforce` → FAIL CLOSED (exit 2 + CONFIG-ERROR)', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'review:\n  local_review:\n    mode: enforce\n',
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CONFIG-ERROR');
    expect(r.stderr).toContain('REA_SKIP_LOCAL_REVIEW');
  });

  it('round-54: no-preflight CLI + `local_review.mode: shadow` → WARN + ALLOW (exit 0)', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'review:\n  local_review:\n    mode: shadow\n',
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('WARN — review gate (shadow) could not run');
    expect(r.stderr).not.toContain('CONFIG-ERROR');
  });

  it('round-54: no-preflight CLI + mixed local_review shadow + g3_review enforce → strongest wins → FAIL CLOSED', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'review:\n  local_review:\n    mode: shadow\nartifact_gates:\n  g3_review:\n    mode: enforce\n',
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CONFIG-ERROR');
  });

  // round-54 tri-state: shadow is OBSERVE-ONLY and must NEVER block.
  it('P1/round-54: no-preflight CLI + `g3_review.mode: shadow` → WARN + ALLOW (exit 0)', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'artifact_gates:\n  g3_review:\n    mode: shadow\n',
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('WARN — review gate (shadow) could not run');
    expect(r.stderr).not.toContain('CONFIG-ERROR');
  });

  it('P1: no-preflight CLI + inline `local_review: { mode: enforce }` → FAIL CLOSED (exit 2)', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'review:\n  local_review: { mode: enforce }\n',
    );
    expect(r.code).toBe(2);
  });

  // Round-51 F2 — DEEPLY NESTED inline flow maps must not read as "gate off".
  it('P1/F2: no-preflight CLI + nested inline `review: { local_review: { mode: enforce } }` → FAIL CLOSED', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'review: { local_review: { mode: enforce } }\n',
    );
    expect(r.code).toBe(2);
  });

  it('P1/F2/round-54: no-preflight CLI + nested inline `artifact_gates: { g3_review: { mode: shadow } }` → WARN + ALLOW (exit 0)', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'artifact_gates: { g3_review: { mode: shadow } }\n',
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('WARN — review gate (shadow) could not run');
  });

  it('P1/F2: no-preflight CLI + tight inline `local_review:{mode:enforce}` → FAIL CLOSED', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'review:\n  local_review:{mode:enforce}\n',
    );
    expect(r.code).toBe(2);
  });

  it('P1/F2: no-preflight CLI + inline `local_review: { mode: off }` → FAIL OPEN (off means off)', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'review:\n  local_review: { mode: off }\n',
    );
    expect(r.code).toBe(0);
  });

  it('P1: no-preflight CLI + `local_review.mode: off` → FAIL OPEN (exit 0)', async () => {
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'review:\n  local_review:\n    mode: off\n',
    );
    expect(r.code).toBe(0);
  });

  it('P1: no-preflight CLI + policy ABSENT → FAIL OPEN (exit 0)', async () => {
    const r = await runPrePushWithStubPolicy(TOO_OLD_NO_PREFLIGHT, null);
    expect(r.code).toBe(0);
  });

  it('P1: no-preflight CLI + unrelated sibling `mode: enforce` does NOT trip the gate → FAIL OPEN (exit 0)', async () => {
    // Indentation-tracked block detection: a `mode: enforce` under a NON-target
    // sibling key must not be read as an active local_review/g3_review gate.
    const r = await runPrePushWithStubPolicy(
      TOO_OLD_NO_PREFLIGHT,
      'review:\n  local_review:\n    enabled: false\n  other_thing:\n    mode: enforce\n',
    );
    expect(r.code).toBe(0);
  });

  it('P1: pure `unknown option` at tier 3 + active gate → FAIL OPEN (flag mismatch never blocks)', async () => {
    // A CLI that rejects EVERY option form with `unknown option` (never
    // `unknown command`) is preflight-capable; a flag incompatibility must
    // never block a push even in a gate-active repo.
    const alwaysUnknownOption = [
      '#!/bin/sh',
      "case \"$1\" in",
      '  preflight) echo "error: unknown option" >&2; exit 1 ;;',
      '  hook) exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n');
    const r = await runPrePushWithStubPolicy(
      alwaysUnknownOption,
      'review:\n  local_review:\n    mode: enforce\n',
    );
    expect(r.code).toBe(0);
  });

  // ── Round-33 P1 — HALT freeze covers BOTH roots, zero CLI dependency ──────
  // Run the fallback hook in a repo with a given HALT layout and (optional) stub.
  async function runPrePush(opts: {
    haltLocal?: string; // write .rea/HALT in the pushed repo
    stub?: string; // node_modules/.bin/rea contents (omit → no CLI at all)
  }): Promise<{ code: number; stderr: string }> {
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-halt-')));
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      if (opts.stub !== undefined) {
        const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
        await fs.mkdir(path.dirname(stubBin), { recursive: true });
        await fs.writeFile(stubBin, opts.stub, { mode: 0o755 });
      }
      if (opts.haltLocal !== undefined) {
        await fs.mkdir(path.join(repoDir, '.rea'), { recursive: true });
        await fs.writeFile(path.join(repoDir, '.rea', 'HALT'), opts.haltLocal);
      }
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-push');
      await fs.writeFile(hookPath, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      const r = await execFileAsync(hookPath, ['origin', 'git@example:r.git'], {
        cwd: repoDir,
      }).catch((e: { code?: number; stderr?: string }) => e);
      return { code: (r as { code?: number }).code ?? 0, stderr: (r as { stderr?: string }).stderr ?? '' };
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  }

  const OK_STUB = '#!/bin/sh\nexit 0\n'; // preflight + push-gate both pass
  const TOO_OLD_STUB = [
    '#!/bin/sh',
    "case \"$1\" in preflight) echo \"error: unknown command 'preflight'\" >&2; exit 1 ;; hook) exit 0 ;; esac",
    'exit 0',
    '',
  ].join('\n');

  it('P1: `.rea/HALT` + NO CLI at all → push blocked (exit 2), before the CLI ladder', async () => {
    const r = await runPrePush({ haltLocal: 'frozen\n' }); // no stub
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('REA HALT');
  });

  it('P1: HALT WINS even when the CLI would fail-open (too-old preflight stub)', async () => {
    const r = await runPrePush({ haltLocal: 'frozen mid-push\n', stub: TOO_OLD_STUB });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('REA HALT');
  });

  it('P1 control: NO HALT + too-old preflight stub → round-32 fail-open still holds (exit 0)', async () => {
    const r = await runPrePush({ stub: TOO_OLD_STUB });
    expect(r.code).toBe(0);
  });

  it('P1 control: NO HALT + OK stub → push proceeds (exit 0)', async () => {
    const r = await runPrePush({ stub: OK_STUB });
    expect(r.code).toBe(0);
  });

  it('P1: common-root (sibling worktree) HALT → push from the worktree is blocked (exit 2)', async () => {
    const primary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-wt-')));
    const wtA = `${primary}-A`;
    try {
      await execFileAsync('git', ['-C', primary, 'init', '-q']);
      await execFileAsync('git', ['-C', primary, 'config', 'user.email', 't@t']);
      await execFileAsync('git', ['-C', primary, 'config', 'user.name', 't']);
      await execFileAsync('git', ['-C', primary, 'commit', '-q', '--allow-empty', '-m', 'init']);
      await execFileAsync('git', ['-C', primary, 'worktree', 'add', '-q', wtA, '-b', 'stream-a']);
      // Freeze the PRIMARY (common root); worktree A has NO local HALT + no CLI.
      await fs.mkdir(path.join(primary, '.rea'), { recursive: true });
      await fs.writeFile(path.join(primary, '.rea', 'HALT'), 'repo-wide freeze\n');
      // Resolve + write the hook git fires for the worktree, then run FROM wtA.
      const hookPath = (
        await execFileAsync('git', ['-C', wtA, 'rev-parse', '--git-path', 'hooks/pre-push'])
      ).stdout.trim();
      const abs = path.isAbsolute(hookPath) ? hookPath : path.join(wtA, hookPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, fallbackHookContent(), { encoding: 'utf8', mode: 0o755 });
      const r = await execFileAsync(abs, ['origin', 'git@example:r.git'], { cwd: wtA }).catch(
        (e: { code?: number; stderr?: string }) => e,
      );
      expect((r as { code?: number }).code).toBe(2);
      expect((r as { stderr?: string }).stderr ?? '').toContain('REA HALT');
    } finally {
      await fs.rm(wtA, { recursive: true, force: true });
      await fs.rm(primary, { recursive: true, force: true });
    }
  });

  it('non-executable files in `.husky/pre-push.d/` are silently skipped', async () => {
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-skip-')));
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const log = path.join(repoDir, 'order.log');
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      // 0.26.0 — the body invokes `rea preflight --strict` BEFORE the
      // `rea hook push-gate` dispatch. The test's intent is the
      // `hook push-gate` arm (extension-fragment ordering); silence
      // the preflight branch so the order log only captures the
      // hook-push-gate invocation.
      await fs.writeFile(
        stubBin,
        `#!/bin/sh\nif [ "\${1:-}" = "preflight" ]; then exit 0; fi\nprintf 'rea\\n' >> "${log}"\nexit 0\n`,
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

  it("end-to-end: fragments receive git's original argv (Fix 0.13.2 — $@ preservation)", async () => {
    // Regression test for the BST 2026-05-03 report. Pre-0.13.2, the rea
    // dispatch used `set -- "${REA_ROOT}/node_modules/.bin/rea" hook push-gate "$@"`
    // followed by `"$@"` to invoke. The `set --` mutated the parent shell's
    // $@, so by the time the fragment loop ran `"$frag" "$@"` it was passing
    // the rewritten rea-CLI argv (`<rea-bin> hook push-gate <remote> <url>`)
    // instead of git's original `<remote> <url>` — breaking branch-policy
    // linters, lint-staged-on-push wrappers, and any fragment that reads
    // $1/$2 per the standard pre-push contract. The fix wraps the dispatch
    // in a subshell `(...)` so set-- stays scoped.
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-argv-')));
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const reaArgvLog = path.join(repoDir, 'rea-argv.log');
      const fragArgvLog = path.join(repoDir, 'frag-argv.log');
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      // rea CLI logs its full argv so we can assert it gets `hook push-gate
      // <remote> <url>` (the dispatched argv).
      // 0.26.0 — silence the `rea preflight --strict` invocation that runs
      // before the dispatch; the test's intent is the dispatch's argv.
      await fs.writeFile(
        stubBin,
        `#!/bin/sh\nif [ "\${1:-}" = "preflight" ]; then exit 0; fi\nprintf '%s\\n' "$#" "$@" >> "${reaArgvLog}"\nexit 0\n`,
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

  it("end-to-end: fragments receive git's argv even when rea CLI is multi-token (node + script path)", async () => {
    // Variant of the argv preservation test using the dogfood dispatch arm
    // (`set -- node "${REA_ROOT}/dist/cli/index.js" hook push-gate "$@"`),
    // which has the most tokens and the highest blast radius for $@
    // contamination.
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pp-argv2-')));
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      // Set up the dogfood dispatch trigger: dist/cli/index.js + a
      // package.json declaring the rea package name.
      const distEntry = path.join(repoDir, 'dist', 'cli', 'index.js');
      await fs.mkdir(path.dirname(distEntry), { recursive: true });
      const reaLog = path.join(repoDir, 'rea-argv.log');
      const fragLog = path.join(repoDir, 'frag-argv.log');
      // The "rea CLI" here is actually a node script that logs its argv.
      // 0.26.0 — the new body invokes `node dist/cli/index.js preflight --strict`
      // BEFORE the `hook push-gate` dispatch. Silence the preflight call so
      // the test's argv assertion captures only the dispatched argv.
      await fs.writeFile(
        distEntry,
        `#!/usr/bin/env node\nimport('node:fs').then(({ writeFileSync, appendFileSync }) => {\n  if (process.argv[2] === 'preflight') { process.exit(0); }\n  appendFileSync(${JSON.stringify(reaLog)}, [process.argv.length - 2, ...process.argv.slice(2)].join('\\n') + '\\n');\n  process.exit(0);\n});\n`,
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

// ── Round-34 F2 — templates/pre-push.local-first.sh `--operation` compat ─────
// This minimal reference template must carry the SAME compat-fallback as the
// canonical BODY_TEMPLATE (round-32 F1): an older resolved `rea` that rejects
// `--operation` must not hard-block the push.
describe('templates/pre-push.local-first.sh — --operation compat-fallback (round-34 F2)', () => {
  const TEMPLATE = path.resolve(__dirname, '..', '..', '..', 'templates', 'pre-push.local-first.sh');

  async function runTemplate(stub: string): Promise<{ code: number; stderr: string }> {
    const repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tmpl-')));
    try {
      await execFileAsync('git', ['-C', repoDir, 'init', '-q']);
      const stubBin = path.join(repoDir, 'node_modules', '.bin', 'rea');
      await fs.mkdir(path.dirname(stubBin), { recursive: true });
      await fs.writeFile(stubBin, stub, { mode: 0o755 });
      const tmpl = await fs.readFile(TEMPLATE, 'utf8');
      const hookPath = path.join(repoDir, 'pp.sh');
      await fs.writeFile(hookPath, tmpl, { mode: 0o755 });
      const r = await execFileAsync('bash', [hookPath], { cwd: repoDir }).catch(
        (e: { code?: number; stderr?: string }) => e,
      );
      return {
        code: (r as { code?: number }).code ?? 0,
        stderr: (r as { stderr?: string }).stderr ?? '',
      };
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  }

  it('bash -n parses (template is syntactically valid)', async () => {
    const tmpl = await fs.readFile(TEMPLATE, 'utf8');
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tmpl-n-')));
    try {
      const p = path.join(dir, 'pp.sh');
      await fs.writeFile(p, tmpl);
      const r = await execFileAsync('bash', ['-n', p]).catch((e: { code?: number }) => e);
      expect((r as { code?: number }).code ?? 0).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('F2: an OLD CLI rejecting `--operation` → retries `--strict`, push NOT blocked (exit 0)', async () => {
    const stub = [
      '#!/bin/sh',
      'op=0; for a in "$@"; do [ "$a" = "--operation" ] && op=1; done',
      'case "$1" in',
      '  preflight)',
      '    if [ "$op" = "1" ]; then echo "error: unknown option \'--operation\'" >&2; exit 1; fi',
      '    exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n');
    const r = await runTemplate(stub);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('unknown option');
  });

  it('F2: a CLI with no `preflight` at all → FAIL OPEN (exit 0)', async () => {
    const stub = [
      '#!/bin/sh',
      "case \"$1\" in preflight) echo \"error: unknown command 'preflight'\" >&2; exit 1 ;; esac",
      'exit 0',
      '',
    ].join('\n');
    expect((await runTemplate(stub)).code).toBe(0);
  });

  it('F2: a GENUINE refusal (exit 2) STILL blocks the push', async () => {
    const stub = [
      '#!/bin/sh',
      'case "$1" in preflight) echo "no recent local review covers HEAD" >&2; exit 2 ;; esac',
      'exit 0',
      '',
    ].join('\n');
    const r = await runTemplate(stub);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no recent local review');
  });
});
