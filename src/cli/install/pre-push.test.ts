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

describe('BODY_TEMPLATE — path-with-spaces portability (Fix A / 0.12.0)', () => {
  it('uses positional-args dispatch via `set --` rather than `exec $REA_BIN`', () => {
    const body = fallbackHookContent();
    // The 0.11.x body word-split on `exec $REA_BIN ...` — break that by
    // ensuring the modern form uses `set --` arms. v4 (0.13.0) replaces the
    // old terminal `exec "$@"` with `"$@"` followed by status-propagation
    // and extension-fragment chaining (so fragments under
    // `.husky/pre-push.d/` run AFTER rea succeeds).
    expect(body).toMatch(/set -- "\$\{REA_ROOT\}\/node_modules\/\.bin\/rea" hook push-gate "\$@"/);
    expect(body).toMatch(/set -- node "\$\{REA_ROOT\}\/dist\/cli\/index\.js" hook push-gate "\$@"/);
    // v4 marker: rea body is invoked then exit propagated, so a bare `"$@"`
    // statement appears (no `exec` prefix) BEFORE the fragment loop.
    expect(body).toMatch(/^"\$@"$/m);
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
    // v4 (0.13.0): rea body invoked via `"$@"` (not `exec`) so post-body
    // extension-fragment chaining can run.
    expect(husky).toMatch(/^"\$@"$/m);
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
});
