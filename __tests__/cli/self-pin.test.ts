/**
 * Tests for `src/cli/install/self-pin.ts` (0.49.0).
 *
 * # Acceptance cases (devex-architect)
 *
 *   1. Fresh project — no @bookedsolid/rea in package.json → write
 *      caret pin to devDependencies.
 *   2. Idempotent re-run — second invocation produces byte-identical
 *      package.json.
 *   3. Existing same pin → no write, `skipped-same`.
 *   4. Existing different pin → no write, `skipped-different`, warn.
 *   5. Dogfood short-circuit — `pkg.name === '@bookedsolid/rea'` → skip.
 *   6. Indent / EOL / trailing-newline preservation across re-write.
 *
 * Plus brick-state detection via `checkSelfPinDeclaredSync`.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REA_PACKAGE_NAME,
  selfPinRea,
  checkSelfPinDeclaredSync,
} from '../../src/cli/install/self-pin.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-self-pin-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writePackageJson(content: unknown): Promise<string> {
  const p = path.join(tmpDir, 'package.json');
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  await fs.writeFile(p, body, 'utf8');
  return p;
}

describe('selfPinRea — acceptance cases', () => {
  it('writes a caret pin to devDependencies when no rea dep exists (--pin opt-in)', async () => {
    // 0.53.0 GLOBAL-FIRST: a write now requires the explicit `pin: true`
    // opt-in — the default no longer self-pins.
    const pkgPath = await writePackageJson({ name: 'consumer', version: '1.0.0' });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });

    expect(r.action).toBe('wrote');
    expect(r.packageJsonPath).toBe(pkgPath);
    expect(r.pinnedRange).toBe('^0.49.0');

    const after = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, unknown>;
    expect(after['devDependencies']).toEqual({ [REA_PACKAGE_NAME]: '^0.49.0' });
  });

  it('is idempotent — re-run produces byte-identical package.json (--pin opt-in)', async () => {
    await writePackageJson({ name: 'consumer', version: '1.0.0' });

    await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });
    const pkgPath = path.join(tmpDir, 'package.json');
    const after1 = await fs.readFile(pkgPath, 'utf8');

    const r2 = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });
    const after2 = await fs.readFile(pkgPath, 'utf8');

    expect(after2).toEqual(after1);
    expect(r2.action).toBe('skipped-same');
  });

  it('skips with `skipped-same` when the pin matches exactly', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.action).toBe('skipped-same');
  });

  it('skips with `skipped-different` when an existing different pin is present', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '0.48.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.action).toBe('skipped-different');
    expect(r.existingRange).toBe('0.48.0');
    expect(r.message).toMatch(/0\.48\.0/);
    expect(r.message).toMatch(/\^0\.49\.0/);
  });

  it('respects an existing pin in dependencies (NOT devDependencies)', async () => {
    await writePackageJson({
      name: 'consumer',
      dependencies: { [REA_PACKAGE_NAME]: 'workspace:^' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.action).toBe('skipped-different');
    expect(r.existingRange).toBe('workspace:^');
  });

  it('skips with `skipped-dogfood` when pkg.name === @bookedsolid/rea', async () => {
    await writePackageJson({ name: REA_PACKAGE_NAME, version: '0.49.0' });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.action).toBe('skipped-dogfood');

    // No write should have happened.
    const after = await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8');
    expect(after).not.toMatch(/devDependencies/);
  });

  it('returns `skipped-no-package-json` when no package.json exists upward', async () => {
    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.action).toBe('skipped-no-package-json');
    expect(r.packageJsonPath).toBeNull();
  });

  it('returns `skipped-malformed-package-json` when package.json is not valid JSON', async () => {
    await writePackageJson('NOT JSON {{{');

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.action).toBe('skipped-malformed-package-json');
  });

  it('returns `skipped-malformed-package-json` when package.json is an array', async () => {
    await writePackageJson(['not', 'an', 'object']);

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.action).toBe('skipped-malformed-package-json');
  });
});

describe('selfPinRea — upgrade-mode managed-caret bump (P1-1)', () => {
  // P1-1 (codex round 2): `rea upgrade` must bump a managed-caret pin
  // when the existing range does not admit the new CLI minor. The
  // npm pre-1.0 caret spec makes `^0.49.0` reject `0.50.0`; without
  // auto-bump, `rea upgrade 0.50.0` ships newer hooks against the
  // older pinned CLI — the brick state the feature exists to prevent.
  // `init` mode never bumps (respects operator's existing pin).

  it('bumps ^0.49.0 → ^0.50.0 in devDependencies (same-major minor change)', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r.action).toBe('bumped');
    expect(r.existingRange).toBe('^0.49.0');
    expect(r.pinnedRange).toBe('^0.50.0');
    expect(r.message).toMatch(/bumped/);
    expect(r.message).toMatch(/\^0\.49\.0/);
    expect(r.message).toMatch(/\^0\.50\.0/);

    const after = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(after['devDependencies']).toEqual({ [REA_PACKAGE_NAME]: '^0.50.0' });
  });

  it('bumps ^0.49.0 → ^0.50.0 in dependencies (preserves operator-chosen surface)', async () => {
    await writePackageJson({
      name: 'consumer',
      dependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r.action).toBe('bumped');
    expect(r.existingRange).toBe('^0.49.0');
    expect(r.pinnedRange).toBe('^0.50.0');

    const after = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(after['dependencies']).toEqual({ [REA_PACKAGE_NAME]: '^0.50.0' });
    // devDependencies surface untouched — we bumped in place where
    // the operator placed the dep.
    expect(after['devDependencies']).toBeUndefined();
  });

  it('NO-OP (skipped-same) when ^0.49.0 already admits the new patch 0.49.5', async () => {
    // Pre-1.0 caret = tilde: `^0.49.0` admits `0.49.5`. The new
    // pin shape (`^0.49.5`) differs from the existing (`^0.49.0`),
    // so we DO write — but it's still a "wrote/skipped-same" path,
    // NOT a "bumped" one (the existing range satisfied the new CLI).
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.5', mode: 'upgrade' });
    // The existing pin (`^0.49.0`) DOES admit 0.49.5 — same minor.
    // `shouldBumpManagedCaret` returns false. The result is
    // `skipped-different` (existing differs from `^0.49.5` but is
    // not auto-bump-eligible). Operator keeps their pin and pnpm
    // resolves to 0.49.5 on next install.
    expect(r.action).toBe('skipped-different');
    expect(r.existingRange).toBe('^0.49.0');
  });

  it('hands off on workspace:* (not a managed-caret shape) — warn+skip', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'workspace:*' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r.action).toBe('skipped-different');
    expect(r.existingRange).toBe('workspace:*');
  });

  it('hands off on file:../rea (not a managed-caret shape) — warn+skip', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'file:../rea' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r.action).toBe('skipped-different');
    expect(r.existingRange).toBe('file:../rea');
  });

  it('hands off on a git URL — warn+skip', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'git+https://github.com/bookedsolidtech/rea.git#main' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r.action).toBe('skipped-different');
  });

  it('hands off on a dist-tag `next` — warn+skip', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'next' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r.action).toBe('skipped-different');
  });

  it('hands off on an exact pin (e.g. `0.48.1`) — warn+skip', async () => {
    // Exact pin (no caret) is operator-chosen reproducibility — never
    // auto-bump.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '0.48.1' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r.action).toBe('skipped-different');
  });

  it('hands off on a tilde pin (`~0.49.0`) — warn+skip', async () => {
    // Tilde is a managed shape in OTHER tools but NOT what selfPinRea
    // writes. We never wrote it, so we don't own it — hands off.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '~0.49.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r.action).toBe('skipped-different');
  });

  it('hands off across MAJOR (^0.49.0 → 1.0.0) — major bump is operator-authored intent', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '1.0.0', mode: 'upgrade' });
    expect(r.action).toBe('skipped-different');
    expect(r.existingRange).toBe('^0.49.0');
  });

  it('hands off across MAJOR (^1.0.0 → 0.50.0 — defensive downgrade) — warn+skip', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^1.0.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r.action).toBe('skipped-different');
  });

  it('default mode (init) NEVER bumps — respects operator pin', async () => {
    // P1-1 contract: `rea init` keeps the warn-and-skip posture.
    // Only `rea upgrade` opts into the bump. Verify the default
    // mode (no `mode:` field provided) preserves init semantics.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0' });
    expect(r.action).toBe('skipped-different');
    expect(r.existingRange).toBe('^0.49.0');

    // Explicit init mode same.
    const r2 = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'init' });
    expect(r2.action).toBe('skipped-different');
  });

  it('idempotent re-run after a bump → skipped-same', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r1 = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r1.action).toBe('bumped');

    const r2 = await selfPinRea({ cwd: tmpDir, cliVersion: '0.50.0', mode: 'upgrade' });
    expect(r2.action).toBe('skipped-same');
  });
});

describe('shouldBumpManagedCaret — predicate unit tests (P1-1)', () => {
  it('returns true for same-major pre-1.0 minor differences', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^0.49.0', '^0.50.0')).toBe(true);
    expect(shouldBumpManagedCaret('^0.10.0', '^0.50.0')).toBe(true);
  });
  it('returns false when existing caret already admits the new version', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    // ^0.49.0 admits 0.49.5 (same minor) — no bump.
    expect(shouldBumpManagedCaret('^0.49.0', '^0.49.5')).toBe(false);
    // 1.0+: ^1.0.0 admits any 1.x.y — no bump.
    expect(shouldBumpManagedCaret('^1.0.0', '^1.5.0')).toBe(false);
    expect(shouldBumpManagedCaret('^1.2.3', '^1.99.0')).toBe(false);
  });
  it('returns false across majors', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^0.49.0', '^1.0.0')).toBe(false);
    expect(shouldBumpManagedCaret('^1.0.0', '^2.0.0')).toBe(false);
    expect(shouldBumpManagedCaret('^1.0.0', '^0.50.0')).toBe(false);
  });
  it('returns false for non-managed shapes', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('workspace:*', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('workspace:^', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('file:../rea', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('git+https://github.com/foo/rea.git', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('next', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('latest', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('0.49.0', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('~0.49.0', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('>=0.49.0 <0.50.0', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('0.49.x', '^0.50.0')).toBe(false);
    expect(shouldBumpManagedCaret('^0.49.0 || ^0.48.0', '^0.50.0')).toBe(false);
  });
  it('accepts prerelease tails in the managed-caret shape', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^0.49.0-beta.1', '^0.50.0')).toBe(true);
    expect(shouldBumpManagedCaret('^0.49.0', '^0.50.0-rc.1')).toBe(true);
  });
});

describe('shouldBumpManagedCaret — semver-satisfies for prerelease (R4-P2)', () => {
  // R4-P2 (codex round 4): the predicate previously compared
  // major/minor by hand and misclassified prerelease bumps as
  // already-covered. Switched to `semver.satisfies` so npm-spec
  // prerelease behavior is correct:
  //
  //   - A non-prerelease range like `^0.49.0` does NOT include
  //     `0.49.1-beta.0` (npm spec excludes prereleases from non-
  //     prerelease ranges).
  //   - A non-prerelease range like `^1.0.0` does NOT include
  //     `1.1.0-beta.0` for the same reason.
  //
  // Pre-fix, `rea upgrade` from `^0.49.0` to `0.49.1-beta.0` left
  // the pin untouched, recreating the hook/CLI skew on the next
  // install.

  it('bumps ^0.49.0 → 0.49.1-beta.0 (prerelease outside non-pre range)', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^0.49.0', '^0.49.1-beta.0')).toBe(true);
  });

  it('does NOT bump ^0.49.0 → 0.49.0 (range satisfies)', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^0.49.0', '^0.49.0')).toBe(false);
  });

  it('bumps ^0.49.0 → 0.50.0 (cross-minor pre-1.0)', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^0.49.0', '^0.50.0')).toBe(true);
  });

  it('does NOT bump ^0.49.0 → 1.0.0 (cross-major)', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^0.49.0', '^1.0.0')).toBe(false);
  });

  it('bumps ^1.0.0 → 1.1.0-beta.0 (prerelease outside non-pre range, 1.0+)', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^1.0.0', '^1.1.0-beta.0')).toBe(true);
  });

  it('does NOT bump ^1.0.0 → 1.1.0 (range satisfies)', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^1.0.0', '^1.1.0')).toBe(false);
  });

  it('does NOT bump ^1.0.0 → 2.0.0-rc.1 (cross-major even with prerelease)', async () => {
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    expect(shouldBumpManagedCaret('^1.0.0', '^2.0.0-rc.1')).toBe(false);
  });

  it('handles invalid floor versions gracefully — returns false', async () => {
    // Defensive: if newRange is somehow non-semver despite matching
    // the regex (shouldn't happen with the regex we use, but
    // belt-and-braces), the predicate returns false rather than
    // throwing.
    const { shouldBumpManagedCaret } = await import('../../src/cli/install/self-pin.js');
    // The regex requires at least major.minor — an input like
    // `^0` would fail to match the regex (so first guard returns
    // false). Test the explicit invalid-floor branch by mocking
    // a managed-shape string with embedded bad semver — not
    // representable through normal input, so we verify the
    // valid-semver gate is reachable via a manual check on the
    // regex:
    expect(shouldBumpManagedCaret('^abc.def', '^0.50.0')).toBe(false);
  });

  it('full selfPinRea flow: ^0.49.0 + prerelease CLI 0.49.1-beta.0 → bumped (E2E for R4-P2)', async () => {
    // End-to-end verification: selfPinRea actually writes the new
    // pin for the prerelease bump case. Pre-fix this was a
    // skipped-different.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.1-beta.0', mode: 'upgrade' });
    expect(r.action).toBe('bumped');
    expect(r.existingRange).toBe('^0.49.0');
    expect(r.pinnedRange).toBe('^0.49.1-beta.0');

    const after = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(after['devDependencies']).toEqual({ [REA_PACKAGE_NAME]: '^0.49.1-beta.0' });
  });
});

describe('selfPinRea — dry-run preview (R3-P2)', () => {
  // R3-P2 (codex round 3): `rea upgrade --dry-run` previously
  // short-circuited around `selfPinRea` entirely. Operators saw zero
  // pin-related output, then ran the live upgrade and got a surprise
  // mutation. `dryRun: true` computes the SAME action discriminant
  // as the live run, returns the SAME message structure (with
  // "would" verbs), but performs NO on-disk write.

  it('dryRun: writes nothing on the new-pin path; returns action `wrote` with "would add" message', async () => {
    const pkgPath = await writePackageJson({ name: 'consumer', version: '1.0.0' });
    const before = await fs.readFile(pkgPath, 'utf8');

    // 0.53.0: `pin: true` opts in to the write path this test exercises.
    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', dryRun: true, pin: true });
    expect(r.action).toBe('wrote');
    expect(r.pinnedRange).toBe('^0.49.0');
    expect(r.message).toMatch(/would add/);
    expect(r.message).not.toMatch(/^self-pin: added /);

    const after = await fs.readFile(pkgPath, 'utf8');
    expect(after).toBe(before);
  });

  it('dryRun: writes nothing on the bump path; returns action `bumped` with "would bump" message', async () => {
    const pkgPath = await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.48.0' },
    });
    const before = await fs.readFile(pkgPath, 'utf8');

    const r = await selfPinRea({
      cwd: tmpDir,
      cliVersion: '0.49.0',
      mode: 'upgrade',
      dryRun: true,
    });
    expect(r.action).toBe('bumped');
    expect(r.existingRange).toBe('^0.48.0');
    expect(r.pinnedRange).toBe('^0.49.0');
    expect(r.message).toMatch(/would bump/);
    expect(r.message).not.toMatch(/^self-pin: bumped /);

    const after = await fs.readFile(pkgPath, 'utf8');
    expect(after).toBe(before);
  });

  it('dryRun: skipped-same path is unaffected — message has no "would" prefix (nothing to do)', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', dryRun: true });
    expect(r.action).toBe('skipped-same');
    // skipped-same has no would/would-not distinction — there's
    // nothing the live run would have done either.
    expect(r.message).not.toMatch(/would/);
  });

  it('dryRun: skipped-different path is unaffected — operator-owned pin stays', async () => {
    const pkgPath = await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'workspace:*' },
    });
    const before = await fs.readFile(pkgPath, 'utf8');

    const r = await selfPinRea({
      cwd: tmpDir,
      cliVersion: '0.49.0',
      mode: 'upgrade',
      dryRun: true,
    });
    expect(r.action).toBe('skipped-different');
    expect(r.existingRange).toBe('workspace:*');

    const after = await fs.readFile(pkgPath, 'utf8');
    expect(after).toBe(before);
  });

  it('dryRun consistency: dry-run + live produce the same action for the same input (write path)', async () => {
    // Drive the dry-run against one fixture, the live run against a
    // fresh fixture, and assert the action discriminant matches.
    // This is the contract operators rely on: "what dry-run says
    // will happen IS what happens".
    await writePackageJson({ name: 'consumer', version: '1.0.0' });
    const dryR = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', dryRun: true, pin: true });

    // Tear down + rebuild.
    await fs.rm(path.join(tmpDir, 'package.json'));
    await writePackageJson({ name: 'consumer', version: '1.0.0' });
    const liveR = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });

    expect(dryR.action).toBe(liveR.action);
    expect(dryR.pinnedRange).toBe(liveR.pinnedRange);
    expect(dryR.packageJsonPath).toBe(liveR.packageJsonPath);
  });

  it('dryRun consistency: dry-run + live produce the same action for the same input (bump path)', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.48.0' },
    });
    const dryR = await selfPinRea({
      cwd: tmpDir,
      cliVersion: '0.49.0',
      mode: 'upgrade',
      dryRun: true,
    });
    // Re-create the SAME starting fixture (dry-run didn't mutate).
    const liveR = await selfPinRea({
      cwd: tmpDir,
      cliVersion: '0.49.0',
      mode: 'upgrade',
    });

    expect(dryR.action).toBe('bumped');
    expect(liveR.action).toBe('bumped');
    expect(dryR.existingRange).toBe(liveR.existingRange);
    expect(dryR.pinnedRange).toBe(liveR.pinnedRange);
  });

  it('dryRun default is false — omitting the field preserves write behavior (--pin)', async () => {
    const pkgPath = await writePackageJson({ name: 'consumer' });
    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });
    expect(r.action).toBe('wrote');

    const after = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, unknown>;
    expect(after['devDependencies']).toEqual({ [REA_PACKAGE_NAME]: '^0.49.0' });
  });
});

describe('selfPinRea — UTF-8 BOM tolerance (P2-3)', () => {
  it('strips a leading UTF-8 BOM before parse, succeeds on write, and the BOM is gone on disk', async () => {
    // P2-3 (codex round 1): some Windows operators commit package.json
    // with a leading BOM (UTF-8 EF BB BF / ﻿). JSON.parse rejects
    // it (the spec is unambiguous). Pre-fix, this caused
    // `skipped-malformed-package-json` and falsely told the operator
    // their manifest was broken. We silent-drop the BOM on read and
    // write back without it — npm + pnpm both tolerate either form.
    const pkgPath = path.join(tmpDir, 'package.json');
    const body = '﻿' + JSON.stringify({ name: 'consumer' }, null, 2) + '\n';
    await fs.writeFile(pkgPath, body, 'utf8');

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });
    expect(r.action).toBe('wrote');
    expect(r.packageJsonPath).toBe(pkgPath);

    const after = await fs.readFile(pkgPath, 'utf8');
    expect(after.startsWith('﻿')).toBe(false);
    expect(JSON.parse(after)).toMatchObject({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
  });
});

describe('selfPinRea — formatting preservation', () => {
  it('preserves 4-space indent', async () => {
    const original = JSON.stringify({ name: 'consumer', version: '1.0.0' }, null, 4) + '\n';
    const pkgPath = path.join(tmpDir, 'package.json');
    await fs.writeFile(pkgPath, original, 'utf8');

    await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });
    const after = await fs.readFile(pkgPath, 'utf8');

    // 4-space indent — check a line indented by 4 spaces.
    expect(after).toMatch(/^ {4}"devDependencies":/m);
  });

  it('preserves CRLF EOL', async () => {
    const original = JSON.stringify({ name: 'consumer' }, null, 2).replace(/\n/g, '\r\n') + '\r\n';
    const pkgPath = path.join(tmpDir, 'package.json');
    await fs.writeFile(pkgPath, original, 'utf8');

    await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });
    const after = await fs.readFile(pkgPath, 'utf8');

    // Every newline should be CRLF.
    expect(after).toMatch(/\r\n/);
    // No LF without a preceding CR.
    expect(after.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('preserves absence of trailing newline', async () => {
    const original = JSON.stringify({ name: 'consumer' }, null, 2);
    // Note: no trailing newline.
    const pkgPath = path.join(tmpDir, 'package.json');
    await fs.writeFile(pkgPath, original, 'utf8');

    await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });
    const after = await fs.readFile(pkgPath, 'utf8');

    expect(after.endsWith('\n')).toBe(false);
  });

  it('preserves trailing newline when present', async () => {
    const original = JSON.stringify({ name: 'consumer' }, null, 2) + '\n';
    const pkgPath = path.join(tmpDir, 'package.json');
    await fs.writeFile(pkgPath, original, 'utf8');

    await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });
    const after = await fs.readFile(pkgPath, 'utf8');

    expect(after.endsWith('\n')).toBe(true);
  });
});

describe('selfPinRea — explicit-target-only resolution (P2-4)', () => {
  it('REFUSES to walk up: invocation from a pkg-less subdir → skipped-no-package-json', async () => {
    // P2-4 (codex round 1 / locked design): rea init invoked from a
    // workspace subdirectory with NO package.json of its own must NOT
    // silently mutate the parent's manifest. Earlier revisions walked
    // upward; the locked design says refuse.
    await writePackageJson({ name: 'consumer' });
    const sub = path.join(tmpDir, 'apps', 'web');
    await fs.mkdir(sub, { recursive: true });

    const r = await selfPinRea({ cwd: sub, cliVersion: '0.49.0' });
    expect(r.action).toBe('skipped-no-package-json');
    expect(r.packageJsonPath).toBeNull();
    expect(r.message).toMatch(/no package\.json in the target directory/);

    // Parent untouched.
    const parent = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(parent['devDependencies']).toBeUndefined();
  });

  it('pins at the explicit cwd when the subpackage has its own package.json', async () => {
    // Sub-package has its own package.json AND parent has one too.
    // We pin the sub-package's manifest — the parent is never touched.
    await writePackageJson({ name: 'workspace-root', private: true });
    const sub = path.join(tmpDir, 'apps', 'web');
    await fs.mkdir(sub, { recursive: true });
    const subPkg = path.join(sub, 'package.json');
    await fs.writeFile(
      subPkg,
      JSON.stringify({ name: 'apps-web', version: '1.0.0' }, null, 2) + '\n',
      'utf8',
    );

    const r = await selfPinRea({ cwd: sub, cliVersion: '0.49.0', pin: true });
    expect(r.action).toBe('wrote');
    expect(r.packageJsonPath).toBe(subPkg);

    // Parent untouched.
    const parent = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(parent['devDependencies']).toBeUndefined();
  });
});

describe('checkSelfPinDeclaredSync — brick-state detector', () => {
  it('returns pass-no-hooks when .claude/hooks/ is absent', () => {
    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('pass-no-hooks');
  });

  it('returns pass when hooks exist AND rea is declared in devDependencies', async () => {
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('pass');
    if (r.kind !== 'pass') return;
    expect(r.declaredIn).toBe('devDependencies');
    expect(r.declaredRange).toBe('^0.49.0');
  });

  it('returns pass when hooks exist AND rea is declared in dependencies', async () => {
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    await writePackageJson({
      name: 'consumer',
      dependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('pass');
    if (r.kind !== 'pass') return;
    expect(r.declaredIn).toBe('dependencies');
  });

  it('returns pass-dogfood when pkg.name === @bookedsolid/rea', async () => {
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    await writePackageJson({ name: REA_PACKAGE_NAME, version: '0.49.0' });

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('pass-dogfood');
  });

  it('returns FAIL (the brick state) when hooks exist but no rea pin', async () => {
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    await writePackageJson({ name: 'consumer', version: '1.0.0' });

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('fail');
  });

  it('returns FAIL when hooks exist + rea is in peerDependencies ONLY', async () => {
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    await writePackageJson({
      name: 'consumer',
      peerDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });

    // peerDependencies are NOT a self-pin — npm/pnpm install does NOT
    // install them by default. The detector treats them as missing.
    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('fail');
  });

  it('returns warn-shaped pass-no-pkg when hooks exist but no package.json', () => {
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('pass-no-pkg');
  });

  it('returns fail-malformed when package.json is unparseable', async () => {
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    await writePackageJson('NOT JSON');

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('fail-malformed');
  });

  it('tolerates a leading UTF-8 BOM (P3-1) — passes when rea is declared, no fail-malformed', async () => {
    // P3-1 (codex round 1): the doctor brick-state detector used to
    // call JSON.parse on a BOM-prefixed manifest and trip its
    // `fail-malformed` branch, even though `selfPinRea` wrote that
    // manifest fine. The shared `stripUtf8Bom` helper now serves both
    // readers — write path and doctor reach identical conclusions on
    // identical input.
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    const pkgPath = path.join(tmpDir, 'package.json');
    const body =
      '﻿' +
      JSON.stringify(
        { name: 'consumer', devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' } },
        null,
        2,
      ) +
      '\n';
    await fs.writeFile(pkgPath, body, 'utf8');

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('pass');
    if (r.kind !== 'pass') return;
    expect(r.declaredRange).toBe('^0.49.0');
    expect(r.declaredIn).toBe('devDependencies');
  });

  it('tolerates a leading UTF-8 BOM (P3-1) — brick state still detected when rea is missing', async () => {
    // BOM tolerance must NOT mask the brick state: a BOM-prefixed
    // manifest with hooks present but no @bookedsolid/rea declared
    // still fails (not fail-malformed).
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    const pkgPath = path.join(tmpDir, 'package.json');
    const body = '﻿' + JSON.stringify({ name: 'consumer' }, null, 2) + '\n';
    await fs.writeFile(pkgPath, body, 'utf8');

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('fail');
  });
});

describe('stripUtf8Bom — canonical BOM-strip helper (P3-1)', () => {
  it('drops a leading BOM (U+FEFF) and returns the remainder', async () => {
    const { stripUtf8Bom } = await import('../../src/cli/install/self-pin.js');
    expect(stripUtf8Bom('﻿{"a":1}')).toBe('{"a":1}');
    expect(stripUtf8Bom('﻿hello')).toBe('hello');
  });
  it('is a no-op when no BOM is present', async () => {
    const { stripUtf8Bom } = await import('../../src/cli/install/self-pin.js');
    expect(stripUtf8Bom('{"a":1}')).toBe('{"a":1}');
    expect(stripUtf8Bom('')).toBe('');
  });
  it('only strips ONE BOM — embedded U+FEFF characters survive', async () => {
    // U+FEFF inside a string is a zero-width no-break space and is
    // legitimately valid in JSON strings. Only the leading character
    // is dropped.
    const { stripUtf8Bom } = await import('../../src/cli/install/self-pin.js');
    expect(stripUtf8Bom('﻿hello﻿world')).toBe('hello﻿world');
  });
});

describe('checkUpgradeBlockingPin — R9-P1 abort preflight', () => {
  // R9-P1 (codex round 9 / 0.49.0): when `rea upgrade` would leave a
  // stale `@bookedsolid/rea` pin in place AND that pin does not admit
  // the installed CLI version, the upgrade MUST abort BEFORE writing
  // 0.49 hooks/policy artifacts. Otherwise the consumer ends up with
  // 0.49 hooks resolving an old CLI from node_modules whose strict
  // policy loader rejects the new `bootstrap_allowlist:` key — every
  // Bash payload then refuses until the operator reconciles the pin.
  //
  // The check is read-only (a single package.json read) and returns
  // a discriminated result; `runUpgrade` calls it BEFORE any
  // artifact-writing step and aborts on `kind: 'block'`.

  it('R9.1 — workspace:* pin → BLOCK', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'workspace:*' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
    if (r.kind !== 'block') return;
    expect(r.existingRange).toBe('workspace:*');
    expect(r.newCliVersion).toBe('0.49.0');
    expect(r.newPinnedRange).toBe('^0.49.0');
    expect(r.reason).toContain('rea upgrade refusing');
    // Workspace-specific reconciliation hint surfaces.
    expect(r.reason).toMatch(/workspace:\*/);
  });

  it('R9.2 — workspace:^ pin → BLOCK (same shape class)', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'workspace:^' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
  });

  it('R9.3 — file:../rea pin → BLOCK with file-specific hint', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'file:../rea' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
    if (r.kind !== 'block') return;
    expect(r.reason).toMatch(/file:/);
  });

  it('R9.4 — github: pin → BLOCK with git-specific hint', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'github:bookedsolidtech/rea#main' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
    if (r.kind !== 'block') return;
    expect(r.reason).toMatch(/git URL/);
  });

  it('R9.5 — git+https URL pin → BLOCK', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: {
        [REA_PACKAGE_NAME]: 'git+https://github.com/bookedsolidtech/rea.git#abc123',
      },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
  });

  it('R9.6 — dist-tag `next` pin → BLOCK with dist-tag hint', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'next' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
    if (r.kind !== 'block') return;
    expect(r.reason).toMatch(/dist-tag "next"/);
  });

  it('R9.7 — exact older version `0.48.0` + CLI `0.49.0` → BLOCK', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '0.48.0' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
    if (r.kind !== 'block') return;
    expect(r.existingRange).toBe('0.48.0');
  });

  it('R9.8 — managed caret `^0.48.0` + CLI `0.49.0` → OK (R2-P1-1 bumps it)', async () => {
    // Existing R2-P1-1 contract: same-major-different-minor caret is
    // a managed-caret bump. `selfPinRea` will rewrite the pin in
    // place; no skew remains after the upgrade completes.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.48.0' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('ok');
  });

  it('R9.9 — current `^0.49.0` + CLI `0.49.0` → OK (no-op)', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('ok');
  });

  it('R9.10 — no existing pin + CLI `0.49.0` → OK (fresh write path)', async () => {
    await writePackageJson({ name: 'consumer' });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('ok');
  });

  it('R9.11 — newer-than-us caret `^0.50.0` + CLI `0.49.0` → BLOCK', async () => {
    // Hands-off in R2-P1-1 (cross-minor pre-1.0 from above), but
    // 0.49.0 does NOT satisfy `^0.50.0` (`^0.50.0` admits 0.50.x
    // ONLY, pre-1.0 = tilde semantics). Skew exists → BLOCK.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.50.0' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
  });

  it('R9.12 — existing satisfying range `>=0.49.0 <0.50.0` + CLI `0.49.5` → OK', async () => {
    // Range that admits the new CLI: semver.satisfies returns true,
    // no skew at install time. We don't auto-rewrite (it's operator-
    // authored), but we also don't abort.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '>=0.49.0 <0.50.0' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.5' });
    expect(r.kind).toBe('ok');
  });

  it('R9.13 — pin in `dependencies` (not devDependencies) → same block logic applies', async () => {
    await writePackageJson({
      name: 'consumer',
      dependencies: { [REA_PACKAGE_NAME]: 'workspace:*' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
  });

  it('R9.14 — dogfood (pkg.name === @bookedsolid/rea) → OK (skipped path)', async () => {
    await writePackageJson({
      name: REA_PACKAGE_NAME,
      version: '0.49.0',
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('dogfood');
  });

  it('R9.15 — no package.json → no-pkg-json (proceed)', async () => {
    // tmpDir intentionally empty.
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('no-pkg-json');
  });

  it('R9.16 — malformed package.json → malformed-pkg-json (proceed)', async () => {
    await writePackageJson('NOT VALID JSON {');
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('malformed-pkg-json');
  });

  it('R9.17 — block reason includes the operator-actionable reconciliation steps', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '0.48.0' },
    });
    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');
    if (r.kind !== 'block') return;
    // R12-P2 (codex round 12): the recovery command is the BARE
    // spec (no `@<ver>` suffix). The CLI-missing bash gate refuses
    // version-pinned forms; recommending one here would dead-end
    // the recovery loop. The bare spec installs the latest matching
    // the consumer's existing range; a follow-up `rea upgrade`
    // then runs the managed-caret bump under audit.
    expect(r.reason).toMatch(/pnpm add -D @bookedsolid\/rea\b/);
    // Sanity guard: NO version-pinned recommendation in the reason
    // string. If a future change reintroduces `@^X.Y.Z`, agents
    // running the diagnostic-suggested command would loop forever
    // against the bash gate.
    expect(r.reason).not.toMatch(/pnpm add -D @bookedsolid\/rea@/);
    expect(r.reason).toMatch(/Then re-run: rea upgrade/);
    // Cites the existing pin AND the new CLI version verbatim.
    expect(r.reason).toMatch(/"0\.48\.0"/);
    expect(r.reason).toMatch(/0\.49\.0/);
  });

  it('R9.18 — read-only: no disk mutation on block (verify package.json bytes unchanged)', async () => {
    const before = JSON.stringify(
      { name: 'consumer', devDependencies: { [REA_PACKAGE_NAME]: 'workspace:*' } },
      null,
      2,
    );
    const pkgPath = path.join(tmpDir, 'package.json');
    await fs.writeFile(pkgPath, before, 'utf8');

    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block');

    const after = await fs.readFile(pkgPath, 'utf8');
    expect(after).toBe(before);
  });
});

describe('selfPinRea — R10-P2 symlinked package.json refusal', () => {
  // R10-P2 (codex round 10): writing the rea pin through a symlinked
  // package.json would mutate the target file — typically outside
  // the requested project tree. R2-P4 established "don't mutate a
  // parent the operator did not target"; this closes the same class
  // for symlink-redirected writes.
  //
  // selfPinRea THROWS on symlink (security refusal — not a benign
  // skip). checkUpgradeBlockingPin returns kind:'block-symlink'.
  // checkSelfPinDeclaredSync returns kind:'fail-symlink'.

  let externalDir: string;

  beforeEach(async () => {
    externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-self-pin-external-'));
  });

  afterEach(async () => {
    await fs.rm(externalDir, { recursive: true, force: true });
  });

  async function makeSymlinkedPkgJson(): Promise<{ linkPath: string; targetPath: string; targetBytes: string }> {
    // Create a real package.json OUTSIDE tmpDir, then symlink
    // tmpDir/package.json → that file.
    const targetPath = path.join(externalDir, 'package.json');
    const targetBytes = JSON.stringify(
      { name: 'external-victim', devDependencies: {} },
      null,
      2,
    ) + '\n';
    await fs.writeFile(targetPath, targetBytes, 'utf8');
    const linkPath = path.join(tmpDir, 'package.json');
    await fs.symlink(targetPath, linkPath);
    return { linkPath, targetPath, targetBytes };
  }

  it('R10.S.1 — selfPinRea THROWS with a refusing-symlink message', async () => {
    await makeSymlinkedPkgJson();
    await expect(selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' })).rejects.toThrow(
      /refusing: .* is a symlink/,
    );
  });

  it('R10.S.2 — target bytes are UNCHANGED after the throw', async () => {
    const { targetPath, targetBytes } = await makeSymlinkedPkgJson();

    await expect(selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' })).rejects.toThrow();

    const after = await fs.readFile(targetPath, 'utf8');
    expect(after).toBe(targetBytes);
  });

  it('R10.S.3 — regular file is unaffected (regression guard)', async () => {
    // R10-P2 must not interfere with the existing happy path.
    await writePackageJson({ name: 'consumer' });

    const r = await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', pin: true });
    expect(r.action).toBe('wrote');
  });

  it('R10.S.4 — dry-run returns `skipped-symlink-package-json` (does NOT throw)', async () => {
    // R10-P2: dry-run must complete a preview even when the
    // live run would refuse. The pre-flight (checkUpgradeBlockingPin)
    // has already surfaced the block-symlink diagnostic to the
    // operator; the downstream selfPinRea call here returns a
    // skip-shape so the dry-run summary doesn't fail mid-flight.
    // Live mode (R10.S.1) STILL throws — security refusal posture
    // is preserved for the actual write.
    const { targetPath, targetBytes } = await makeSymlinkedPkgJson();

    const r = await selfPinRea({
      cwd: tmpDir,
      cliVersion: '0.49.0',
      dryRun: true,
    });
    expect(r.action).toBe('skipped-symlink-package-json');
    expect(r.message).toMatch(/refusing: .* is a symlink/);

    // Even in dry-run, no mutation reaches the symlink target.
    const after = await fs.readFile(targetPath, 'utf8');
    expect(after).toBe(targetBytes);
  });

  it('R10.S.5 — `mode: upgrade` ALSO throws (no path bypasses the check)', async () => {
    await makeSymlinkedPkgJson();
    await expect(
      selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0', mode: 'upgrade' }),
    ).rejects.toThrow(/refusing: .* is a symlink/);
  });
});

describe('checkUpgradeBlockingPin — R10-P2 symlinked package.json', () => {
  let externalDir: string;

  beforeEach(async () => {
    externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-blockpin-external-'));
  });

  afterEach(async () => {
    await fs.rm(externalDir, { recursive: true, force: true });
  });

  it('R10.S.U.1 — symlinked package.json → kind: block-symlink with reason', async () => {
    const targetPath = path.join(externalDir, 'package.json');
    await fs.writeFile(
      targetPath,
      JSON.stringify({ name: 'external' }, null, 2),
      'utf8',
    );
    await fs.symlink(targetPath, path.join(tmpDir, 'package.json'));

    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    const r = await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });
    expect(r.kind).toBe('block-symlink');
    if (r.kind !== 'block-symlink') return;
    expect(r.reason).toMatch(/refusing: .* is a symlink/);
    expect(r.packageJsonPath).toBe(path.join(tmpDir, 'package.json'));
  });

  it('R10.S.U.2 — preflight does NOT mutate the symlink target', async () => {
    const targetPath = path.join(externalDir, 'package.json');
    const targetBytes = JSON.stringify({ name: 'external' }, null, 2) + '\n';
    await fs.writeFile(targetPath, targetBytes, 'utf8');
    await fs.symlink(targetPath, path.join(tmpDir, 'package.json'));

    const { checkUpgradeBlockingPin } = await import('../../src/cli/install/self-pin.js');
    await checkUpgradeBlockingPin({ cwd: tmpDir, cliVersion: '0.49.0' });

    const after = await fs.readFile(targetPath, 'utf8');
    expect(after).toBe(targetBytes);
  });
});

describe('checkSelfPinDeclaredSync — R10-P2 symlinked package.json', () => {
  let externalDir: string;

  beforeEach(async () => {
    externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-doctor-external-'));
  });

  afterEach(async () => {
    await fs.rm(externalDir, { recursive: true, force: true });
  });

  it('R10.S.D.1 — symlinked package.json + hooks present → kind: fail-symlink', async () => {
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    const targetPath = path.join(externalDir, 'package.json');
    await fs.writeFile(
      targetPath,
      JSON.stringify({ name: 'external' }, null, 2),
      'utf8',
    );
    await fs.symlink(targetPath, path.join(tmpDir, 'package.json'));

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('fail-symlink');
    if (r.kind !== 'fail-symlink') return;
    expect(r.reason).toMatch(/refusing: .* is a symlink/);
    expect(r.packageJsonPath).toBe(path.join(tmpDir, 'package.json'));
  });

  it('R10.S.D.2 — doctor diagnostic message mirrors the write-path refusal verbatim', async () => {
    // R10-P2 explicitly requires write-path and doctor surfaces
    // produce IDENTICAL wording so operators don't see two
    // versions of the same diagnostic. Both paths pull from the
    // shared `buildSymlinkRefusalMessage` helper.
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    const targetPath = path.join(externalDir, 'package.json');
    await fs.writeFile(targetPath, '{}', 'utf8');
    await fs.symlink(targetPath, path.join(tmpDir, 'package.json'));

    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('fail-symlink');
    if (r.kind !== 'fail-symlink') return;

    // Sanity: capture the write-path's thrown message and compare.
    let thrown: Error | null = null;
    try {
      await selfPinRea({ cwd: tmpDir, cliVersion: '0.49.0' });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toBe(r.reason);
  });
});

describe('R12-P2 meta — diagnostics consistency with bash allowlist', () => {
  // R12-P2 (codex round 12): the CLI-missing bash gate refuses
  // version-pinned `pnpm add -D @bookedsolid/rea@<ver>` forms (R6-P2
  // lock — security: prevents attacker version-pin downgrade in
  // CLI-missing state). The TS-side diagnostics MUST recommend the
  // bare form so an agent running the suggested command doesn't
  // dead-end against the bash gate.
  //
  // This meta-test reads the self-pin.ts source verbatim and asserts:
  //   1. `_bootstrap_match_rea_spec` (the bash counterpart) accepts
  //      ONLY the bare spec — verified by reading the helper source.
  //   2. NO `pnpm add -D ${REA_PACKAGE_NAME}@` substring exists in
  //      any diagnostic-emission line of self-pin.ts. The bare
  //      `pnpm add -D ${REA_PACKAGE_NAME}` is fine; the `@<ver>`
  //      suffix is what we ban.
  //
  // If a future change reintroduces a version-pinned recommendation,
  // this test fails before the regression ships.

  it('self-pin.ts diagnostics do NOT recommend `pnpm add -D @bookedsolid/rea@<ver>`', async () => {
    const selfPinSrc = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'cli', 'install', 'self-pin.ts'),
      'utf8',
    );
    // Match the version-pinned form in template-literal contexts:
    //   pnpm add -D ${REA_PACKAGE_NAME}@<anything>
    //   pnpm add -D @bookedsolid/rea@<anything>
    // Skip false-positives in doc-comment text that quotes user
    // commands (e.g. `// "pnpm add -D @bookedsolid/rea@latest"`
    // explaining what we refuse). We only care about template
    // literals destined for stderr.
    const recoveryLinePattern =
      /pnpm add -D (?:\$\{REA_PACKAGE_NAME\}|@bookedsolid\/rea)@[\^~\d$<]/g;
    const matches = selfPinSrc.match(recoveryLinePattern) ?? [];
    // Allow ONLY matches that appear inside a `*` doc-comment block
    // (those are explanatory text, not emitted to stderr). The
    // recovery-text lines are inside backtick template literals
    // assembled in `reason:` properties; we detect those by
    // requiring the match's containing line to start with a
    // backtick-prefixed indent (the way every recovery line is
    // formatted).
    const offending: string[] = [];
    for (const m of matches) {
      const idx = selfPinSrc.indexOf(m);
      // Find the start of the enclosing line.
      const lineStart = selfPinSrc.lastIndexOf('\n', idx) + 1;
      const lineEnd = selfPinSrc.indexOf('\n', idx);
      const line = selfPinSrc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      // Doc-comment lines start with `*` or `//`; recovery lines
      // are inside template literals and have the form `  \`...\``.
      // Anything not commented-out is an offender.
      const trimmed = line.trim();
      if (!trimmed.startsWith('*') && !trimmed.startsWith('//')) {
        offending.push(line);
      }
    }
    expect(offending).toEqual([]);
  });

  it('bash _bootstrap_match_rea_spec is bare-only (R6-P2 lock invariant)', async () => {
    const bashSrc = await fs.readFile(
      path.resolve(
        __dirname,
        '..',
        '..',
        'hooks',
        '_lib',
        'bootstrap-allowlist.sh',
      ),
      'utf8',
    );
    // The helper body should be a single-line `[ "$1" = '@bookedsolid/rea' ]`
    // check (R6-P2). Grep for the function and assert no `@bookedsolid/rea@`
    // pattern survives in the matcher's body (the doc-comment above
    // the function legitimately mentions the version-pinned form to
    // explain the refusal — we're checking the executable code only).
    const fnStart = bashSrc.indexOf('_bootstrap_match_rea_spec()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = bashSrc.indexOf('\n}\n', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = bashSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain("'@bookedsolid/rea'");
    // Critical R6-P2 lock invariant: no '@bookedsolid/rea@' (with
    // trailing version separator) inside the function body — that
    // shape would mean the helper accepts versioned forms.
    expect(fnBody).not.toContain("'@bookedsolid/rea@'");
    expect(fnBody).not.toMatch(/@bookedsolid\/rea@[^']/);
  });
});

describe('checkSelfPinDeclaredSync — R11-P3 pin-compatibility check', () => {
  // R11-P3 (codex round 11): doctor must surface skew BEFORE it
  // bricks the consumer. Pre-R11 the check was presence-only; an
  // exact older pin like `"0.48.0"` reported pass even when the
  // running CLI was 0.49.x. R11-P3 adds an opt-in compatibility
  // check via a `cliVersion` arg; callers that pass it get
  // `fail-incompatible` / `fail-non-semver` on skew.
  //
  // Backwards-compat: callers that omit `cliVersion` (existing
  // pre-R11 callers) get the original presence-only behavior.

  beforeEach(async () => {
    // Doctor's check requires `.claude/hooks/` to be present —
    // without hooks installed it short-circuits to `pass-no-hooks`.
    fsSync.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
  });

  it('R11.P3.1 — declared `^0.49.0` + running 0.49.0 → pass (range satisfies)', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('pass');
  });

  it('R11.P3.2 — declared `^0.49.0` + running 0.49.5 → pass (caret admits patch)', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.5');
    expect(r.kind).toBe('pass');
  });

  it('R11.P3.3 — declared `^0.48.0` + running 0.49.0 → fail-incompatible', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.48.0' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('fail-incompatible');
    if (r.kind !== 'fail-incompatible') return;
    expect(r.declaredRange).toBe('^0.48.0');
    expect(r.currentCliVersion).toBe('0.49.0');
    expect(r.reason).toMatch(/Self-pin declared but incompatible/);
    expect(r.reason).toMatch(/\^0\.48\.0/);
    expect(r.reason).toMatch(/0\.49\.0/);
    // R12-P2 (codex round 12): bare-spec form only; the CLI-missing
    // bash gate refuses version-pinned adds.
    expect(r.reason).toMatch(/pnpm add -D @bookedsolid\/rea\b/);
    expect(r.reason).not.toMatch(/pnpm add -D @bookedsolid\/rea@/);
  });

  it('R11.P3.4 — exact `0.49.0` + running 0.49.0 → pass (exact match satisfies)', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '0.49.0' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('pass');
  });

  it('R11.P3.5 — exact `0.48.0` + running 0.49.0 → fail-incompatible', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '0.48.0' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('fail-incompatible');
  });

  it('R11.P3.6 — `workspace:*` pin → fail-non-semver', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'workspace:*' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('fail-non-semver');
    if (r.kind !== 'fail-non-semver') return;
    expect(r.declaredRange).toBe('workspace:*');
    expect(r.reason).toMatch(/non-semver shape/);
  });

  it('R11.P3.7 — `file:../rea` pin → fail-non-semver', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'file:../rea' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('fail-non-semver');
  });

  it('R11.P3.8 — git URL pin → fail-non-semver', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'github:bookedsolidtech/rea#main' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('fail-non-semver');
  });

  it('R11.P3.9 — dist-tag `next` pin → fail-non-semver', async () => {
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'next' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('fail-non-semver');
  });

  it('R11.P3.10 — `^0.49.0` + running 0.49.1-beta.0 → pass (includePrerelease)', async () => {
    // semver.satisfies with includePrerelease:true lets a 0.49.1-
    // beta.0 running CLI pass against `^0.49.0`. Without that
    // option, the prerelease would fail-incompatible against its
    // own non-prerelease range, which is operator-confusing.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.1-beta.0');
    expect(r.kind).toBe('pass');
  });

  it('R11.P3.11 — no existing pin + version supplied → fail (existing brick-state)', async () => {
    // The fail (brick-state) check still fires when there is no
    // pin AT ALL — R11-P3's compat check is in addition to the
    // pre-R11 presence check.
    await writePackageJson({ name: 'consumer' });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('fail');
  });

  it('R11.P3.12 — version-omitted backwards-compat: legacy callers still get presence-only', async () => {
    // Pre-R11 callers that don't pass `cliVersion` get the original
    // presence-only behavior: stale pin reports pass.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.48.0' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir);
    expect(r.kind).toBe('pass');
    if (r.kind !== 'pass') return;
    expect(r.declaredRange).toBe('^0.48.0');
  });

  it('R11.P3.13 — pin in `dependencies` (not devDependencies) → compat check still runs', async () => {
    await writePackageJson({
      name: 'consumer',
      dependencies: { [REA_PACKAGE_NAME]: '^0.48.0' },
    });
    const r = checkSelfPinDeclaredSync(tmpDir, '0.49.0');
    expect(r.kind).toBe('fail-incompatible');
    if (r.kind !== 'fail-incompatible') return;
    expect(r.declaredIn).toBe('dependencies');
  });
});

describe('checkSelfPinDeclaredCheck — R18-P1 prefers LOCAL CLI version', () => {
  // R18-P1 (codex round 18): pre-R18 doctor passed `getPkgVersion()`
  // (the version of the rea binary running doctor) into the pin-
  // compat check. That caused false failures whenever an operator
  // ran a newer GLOBAL CLI against a repo whose pin and local
  // node_modules/@bookedsolid/rea were on an older but compatible
  // version. Doctor now resolves `<baseDir>/node_modules/@bookedsolid/
  // rea/package.json` first and falls back to the invoker only when
  // the local CLI is absent (a different diagnostic — the brick
  // state's own existing arm handles it).
  //
  // These tests exercise the doctor-side wrapper end-to-end so the
  // resolver is verified together with the report-ladder mapping.

  // Re-import doctor lazily; doctor.ts has top-level side-effects we
  // want isolated to this block.
  async function loadDoctorCheck(): Promise<
    (baseDir: string) => { label: string; status: 'pass' | 'fail' | 'warn' | 'info'; detail?: string }
  > {
    const m = await import('../../src/cli/doctor.js');
    return m.checkSelfPinDeclaredCheck;
  }

  async function writeLocalCli(baseDir: string, version: string): Promise<void> {
    const dir = path.join(baseDir, 'node_modules', '@bookedsolid', 'rea');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: REA_PACKAGE_NAME, version }, null, 2) + '\n',
      'utf8',
    );
  }

  async function writeHookShim(baseDir: string): Promise<void> {
    // checkSelfPinDeclaredSync short-circuits with `pass-no-hooks`
    // when .claude/hooks/ is absent. Every R18 test needs a hook dir
    // present so the pin-compat path actually runs.
    const dir = path.join(baseDir, '.claude', 'hooks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'blocked-paths-bash-gate.sh'),
      '#!/bin/bash\nexit 0\n',
      'utf8',
    );
  }

  it('R18.P1.1 — local CLI 0.49.0 + pin `^0.49.0` + invoker 0.50.0 → PASS (local admits pin)', async () => {
    // The headline codex-round-18 false-fail: operator runs a newer
    // global rea against a repo whose local install is the older
    // pinned version. Pre-R18 this reported fail-incompatible
    // (because `^0.49.0` doesn't admit 0.50.0). Post-R18 doctor
    // sees the local 0.49.0 and reports pass.
    await writeHookShim(tmpDir);
    await writeLocalCli(tmpDir, '0.49.0');
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    // 0.53.0 GLOBAL-FIRST: a PRESENT local pin is now a WARN (non-fatal),
    // recommending `rea migrate --to-global`. The range is still surfaced.
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('^0.49.0');
    expect(r.detail).toMatch(/rea migrate --to-global/);
  });

  it('R18.P1.2 — no pin + USABLE global tier → PASS; + NO usable tier → FAIL (0.53.0 safety layer)', async () => {
    // 0.53.0 GLOBAL-FIRST + SAFETY LAYER: a missing local pin is healthy ONLY
    // when a usable global tier can run the hooks; otherwise it is a true brick.
    await writeHookShim(tmpDir);
    await writePackageJson({ name: 'consumer' });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();

    const ok = checkSelfPinDeclaredCheck(tmpDir, { globalTierProbe: () => true });
    expect(ok.status).toBe('pass');
    expect(ok.detail).toMatch(/global-first/i);

    const brick = checkSelfPinDeclaredCheck(tmpDir, { globalTierProbe: () => false });
    expect(brick.status).toBe('fail');
    expect(brick.detail).toMatch(/no usable global rea CLI/);
  });

  it('R18.P1.3 — local CLI present + no pin: still gated on a usable global tier', async () => {
    // Even with node_modules/@bookedsolid/rea present, a missing pin is healthy
    // only when the global tier is usable (the hooks resolve the global CLI).
    await writeHookShim(tmpDir);
    await writeLocalCli(tmpDir, '0.49.0');
    await writePackageJson({ name: 'consumer' });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();

    expect(checkSelfPinDeclaredCheck(tmpDir, { globalTierProbe: () => true }).status).toBe('pass');
    expect(checkSelfPinDeclaredCheck(tmpDir, { globalTierProbe: () => false }).status).toBe('fail');
  });

  it('R18.P1.4 — local CLI 0.49.0 + pin `^0.48.0` (doesnt admit local) → fail-incompatible', async () => {
    // Real mismatch: the pin doesn't admit even the LOCAL CLI. This
    // is a genuine config bug the operator should reconcile.
    await writeHookShim(tmpDir);
    await writeLocalCli(tmpDir, '0.49.0');
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.48.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('does not admit the installed CLI');
    expect(r.detail).toContain('0.49.0');
  });

  it('R18.P1.5 — local CLI 0.49.0 + pin `^0.50.0` (pin demands newer than local) → fail-incompatible', async () => {
    // Pin allows only 0.50.x but local is 0.49.x — the hooks will
    // resolve the local 0.49.0 binary at runtime, but the pin
    // promised 0.50.x. Genuine mismatch; consumer should re-install
    // to bring node_modules in line with the pin.
    await writeHookShim(tmpDir);
    await writeLocalCli(tmpDir, '0.49.0');
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.50.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('does not admit the installed CLI');
    expect(r.detail).toContain('0.49.0');
  });

  it('R18.P1.6 / R19.P2.1 — local CLI absent + pin present → PASS (compat check skipped)', async () => {
    // R19-P2 (codex round 19): when the local CLI cannot be
    // resolved from EITHER the node_modules layout OR the dogfood
    // dist layout, the compat check is SKIPPED entirely. Pre-R19
    // the resolver fell back to the invoker version
    // (`getPkgVersion()`), which produced false-fails on fresh
    // clones where a newer global rea ran doctor against a repo
    // pinned at an older but legitimate range. R19's correct
    // posture: cannot determine what hooks will run → skip compat
    // → pass. The brick state (no pin at all) is still caught by
    // the `fail-no-pin` arm — that hasn't moved.
    await writeHookShim(tmpDir);
    // Intentionally no local CLI.
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.48.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    // 0.53.0: pin present (compat skipped) → WARN, range still surfaced.
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('^0.48.0');
  });

  it('R18.P1.7 — local CLI 0.49.0 + pin `^0.49.0` → pass even when local node_modules layout has BOM', async () => {
    // Defense: the resolver tolerates a UTF-8 BOM in the local
    // CLI's package.json (some Windows-authored manifests carry
    // one). Reuses the canonical `stripUtf8Bom` helper.
    const dir = path.join(tmpDir, 'node_modules', '@bookedsolid', 'rea');
    await fs.mkdir(dir, { recursive: true });
    // Write the local CLI's package.json with a leading BOM.
    const bomBody =
      '﻿' +
      JSON.stringify({ name: REA_PACKAGE_NAME, version: '0.49.0' }, null, 2) +
      '\n';
    await fs.writeFile(path.join(dir, 'package.json'), bomBody, 'utf8');
    await writeHookShim(tmpDir);
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    // 0.53.0 GLOBAL-FIRST: pin present + compatible → WARN (was pass).
    expect(r.status).toBe('warn');
  });

  it('R18.P1.8 — local CLI 0.49.0 + non-semver pin (workspace:*) → fail-non-semver against LOCAL', async () => {
    // Non-semver pins (workspace:*, file:.., git, dist-tag) cannot
    // be statically resolved against any version. The
    // fail-non-semver arm fires; the helper's reason text references
    // whichever version the resolver passed in (local in R18, was
    // invoker pre-R18). The user-facing recovery instruction is the
    // same either way.
    await writeHookShim(tmpDir);
    await writeLocalCli(tmpDir, '0.49.0');
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: 'workspace:*' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('non-semver shape');
    expect(r.detail).toContain('0.49.0');
  });

  it('R18.P1.9 / R19.P2 — corrupt local CLI package.json → resolver returns null → compat skipped → PASS (no crash)', async () => {
    // Defensive: a partially-written or corrupted local CLI manifest
    // must not crash doctor. Resolver returns null silently; under
    // R19 the compat check is skipped entirely (no invoker fallback)
    // and the result is `pass` since the pin itself is present.
    const dir = path.join(tmpDir, 'node_modules', '@bookedsolid', 'rea');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), '{not-json', 'utf8');
    await writeHookShim(tmpDir);
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    // 0.53.0 GLOBAL-FIRST: pin present (compat skipped) → WARN (was pass).
    expect(r.status).toBe('warn');
  });
});

describe('checkSelfPinDeclaredCheck — R19-P2 skip compat when local CLI unresolvable', () => {
  // R19-P2 (codex round 19): R18-P1 fell back to the invoker
  // version when the local CLI couldn't be resolved. That still
  // produced false-fails on fresh clones (no node_modules + no
  // dogfood dist). R19 SKIPS the compat check entirely when local
  // is unresolvable; the existing fail-no-pin / fail-malformed
  // arms still catch the brick states.
  //
  // This block adds the new layouts R19 explicitly recognizes
  // (dogfood `dist/cli/index.js` shape) and pins the "fresh-clone
  // no longer false-fails" contract.

  async function loadDoctorCheck(): Promise<
    (baseDir: string) => { label: string; status: 'pass' | 'fail' | 'warn' | 'info'; detail?: string }
  > {
    const m = await import('../../src/cli/doctor.js');
    return m.checkSelfPinDeclaredCheck;
  }

  async function writeHookShim(baseDir: string): Promise<void> {
    const dir = path.join(baseDir, '.claude', 'hooks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'blocked-paths-bash-gate.sh'),
      '#!/bin/bash\nexit 0\n',
      'utf8',
    );
  }

  async function writeLocalCli(baseDir: string, version: string): Promise<void> {
    const dir = path.join(baseDir, 'node_modules', '@bookedsolid', 'rea');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: REA_PACKAGE_NAME, version }, null, 2) + '\n',
      'utf8',
    );
  }

  /**
   * Write the rea-repo dogfood layout: `<baseDir>/dist/cli/index.js`
   * exists AND `<baseDir>/package.json` has `name === '@bookedsolid/rea'`.
   * The package.json's `version` IS the dist CLI version (dist is a
   * build output of that same manifest).
   */
  async function writeDogfoodDistLayout(baseDir: string, version: string): Promise<void> {
    const distDir = path.join(baseDir, 'dist', 'cli');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, 'index.js'),
      '#!/usr/bin/env node\n// dogfood dist stub\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify(
        {
          name: REA_PACKAGE_NAME,
          version,
          // Dogfood doesn't pin itself; this is the rea repo.
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }

  it('R19.P2.2 — fresh clone (no local, no dist) + pin `^0.49.0` → PASS', async () => {
    // The exact false-fail codex R19 called out: operator runs a
    // newer global rea binary against a freshly-cloned consumer
    // repo BEFORE `pnpm install`. Pre-R19, the invoker-fallback
    // path produced fail-incompatible. R19: pass (we can't
    // determine what hooks will run; pnpm install will materialize
    // the actual version next).
    await writeHookShim(tmpDir);
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    // 0.53.0 GLOBAL-FIRST: pin present → WARN (was pass).
    expect(r.status).toBe('warn');
  });

  it('R19.P2.3 — local 0.49.0 + pin `^0.49.0` → PASS (compat satisfied via local)', async () => {
    // R18-P1 regression guard under the new R19 contract.
    await writeHookShim(tmpDir);
    await writeLocalCli(tmpDir, '0.49.0');
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    // 0.53.0 GLOBAL-FIRST: pin present + compatible → WARN (was pass).
    expect(r.status).toBe('warn');
  });

  it('R19.P2.4 — local 0.49.0 + pin `^0.48.0` (genuine mismatch) → fail-incompatible', async () => {
    // Genuine compat failure: local CLI is 0.49.0 but pin only
    // admits 0.48.x. This is the case that MUST still fail — the
    // R19 skip-on-unresolvable rule does NOT relax the compat
    // check when local IS resolvable.
    await writeHookShim(tmpDir);
    await writeLocalCli(tmpDir, '0.49.0');
    await writePackageJson({
      name: 'consumer',
      devDependencies: { [REA_PACKAGE_NAME]: '^0.48.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('does not admit the installed CLI');
  });

  it('R19.P2.5 — dogfood dist layout `<base>/dist/cli/index.js` + base pkg.name=@bookedsolid/rea + version 0.49.0 → uses dist version', async () => {
    // The rea-repo's own dogfood. No node_modules/@bookedsolid/rea
    // — the dist is a build output of THIS package.json. The
    // resolver must pick up `version` from the dogfood package.json
    // when the dist layout exists.
    await writeHookShim(tmpDir);
    await writeDogfoodDistLayout(tmpDir, '0.49.0');
    // The dogfood case: package.json IS rea's own. The pin in this
    // case is irrelevant (rea doesn't self-pin — pass-dogfood
    // short-circuits in checkSelfPinDeclaredSync). Verify the
    // pass-dogfood arm fires.
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('dogfood');
  });

  it('R19.P2.6 — dist layout WITHOUT pkg.name=@bookedsolid/rea → NOT treated as a CLI version source', async () => {
    // A consumer with their OWN `dist/cli/index.js` (e.g. they
    // happen to have a tool with the same layout) must NOT have
    // their package.json's `version` mis-identified as the rea
    // CLI version. The guard is `pkg.name === '@bookedsolid/rea'`
    // — without that match the dist layout is ignored.
    await writeHookShim(tmpDir);
    const distDir = path.join(tmpDir, 'dist', 'cli');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, 'index.js'), '// not rea\n', 'utf8');
    await writePackageJson({
      name: 'consumer-tool',
      version: '99.0.0', // would falsely report 99.0.0 as the CLI version if the guard was missing
      devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
    });
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    // Without name-match, the resolver returns null → compat
    // check skipped → pin-present → WARN (0.53.0 global-first; was pass).
    // If the guard were missing, 99.0.0 against `^0.49.0` would
    // produce fail-incompatible.
    expect(r.status).toBe('warn');
  });

  it('R19.P2.7 — node_modules layout WINS over dogfood dist (precedence)', async () => {
    // Defensive: both layouts present (a dogfood install that has
    // somehow also picked up a `node_modules/@bookedsolid/rea` —
    // e.g. mid-rebuild state). The resolver prefers the
    // node_modules version because that's what the consumer-style
    // shim resolution would pick first (matches
    // `resolveCliDistPath`'s precedence in doctor.ts).
    await writeHookShim(tmpDir);
    await writeLocalCli(tmpDir, '0.49.0');
    // Also write a dogfood dist with a DIFFERENT version. If
    // precedence is broken, fail-incompatible would fire because
    // 0.99.0 doesn't admit `^0.49.0`. With correct precedence,
    // the local 0.49.0 admits the pin and we get pass.
    await writeDogfoodDistLayout(tmpDir, '0.99.0');
    // Overwrite the dogfood package.json with a CONSUMER name so
    // the pass-dogfood short-circuit doesn't fire — we want the
    // pin-compat path to run with the local CLI.
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify(
        {
          name: 'consumer',
          devDependencies: { [REA_PACKAGE_NAME]: '^0.49.0' },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    const checkSelfPinDeclaredCheck = await loadDoctorCheck();
    const r = checkSelfPinDeclaredCheck(tmpDir);
    // node_modules layout wins; 0.49.0 satisfies ^0.49.0 → compat OK.
    // 0.53.0 GLOBAL-FIRST: pin present → WARN (was pass).
    expect(r.status).toBe('warn');
  });
});
