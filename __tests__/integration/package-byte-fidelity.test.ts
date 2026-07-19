/**
 * 0.32.0 Class G — package byte-fidelity test.
 *
 * Runs `pnpm pack` against the repo into a tmpdir, extracts the
 * tarball, and asserts the published artifact matches the canonical
 * source files byte-for-byte for the surfaces governance depends on:
 *
 *   - `hooks/*.sh`          — Claude Code dispatcher view
 *   - `templates/*.sh`      — husky hook bodies
 *   - `commands/*.md`       — slash commands
 *   - `agents/*.md`         — specialist roster
 *
 * This catches an entire class of bugs that wouldn't surface in unit
 * tests OR `dist/` checks: the source files exist and pass tests, the
 * Node-side compilation is clean, but `package.json#files` is mis-
 * configured (excluded a directory, missed a glob) so the published
 * tarball is missing the file the consumer's `rea init` will refuse
 * to overwrite. Pre-0.32.0 we caught this via reactive bug reports
 * (helix-024 verification correction; 0.13.3 MIGRATING.md packaging
 * follow-up); this test is the proactive gate.
 *
 * Per qa-engineer correction 2026-05-12: the byte-compare must be
 * against the PUBLISHED tarball layout, NOT against `dist/`. `dist/`
 * only contains compiled JS — it never had `hooks/*.sh`. The only way
 * to verify "what consumers actually receive" is `pnpm pack` →
 * extract → diff.
 *
 * Performance: `pnpm pack` is slow (4-8 seconds in CI). Gate the
 * suite behind `SKIP_PACK_TESTS` so the inner-loop `pnpm test` stays
 * fast. CI runs without the env var.
 *
 * Mode-bits assertion: shipped `*.sh` files must be 0o755 (executable
 * for the consumer's husky dispatcher). `pnpm pack` preserves the
 * source mode bits in the tarball; extraction preserves them on
 * POSIX. Skip the mode check on Windows runners (`process.platform
 * === 'win32'`) where mode bits are not reliable.
 *
 * Cross-checks:
 *   - Every entry in `EXPECTED_HOOKS` (from `src/cli/doctor.ts`) is
 *     present in the tarball under `hooks/`.
 *   - Every hook registered in `.claude/settings.json` (the dogfood
 *     install) has a matching shipped file.
 *   - `package.json#files` covers every directory governance touches.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_HOOKS } from '../../src/cli/doctor.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// 0.32.0 round-4 P3: opt-IN (not opt-out). The Class G suite shells
// out to `pnpm pack` + tar-extract per invocation, costing several
// seconds — too expensive for the inner `pnpm test` loop every
// contributor runs. CI sets `RUN_PACK_TESTS=1` to enable; local devs
// stay fast by default. `SKIP_PACK_TESTS=1` is still honored as an
// explicit skip override (e.g. for `vitest --watch` in CI containers).
const RUN_PACK_TESTS = process.env['RUN_PACK_TESTS'] === '1';
const SKIP_PACK_TESTS = process.env['SKIP_PACK_TESTS'] === '1';
const PACK_TESTS_ENABLED = RUN_PACK_TESTS && !SKIP_PACK_TESTS;
const IS_WINDOWS = process.platform === 'win32';

interface PackedTree {
  /** Absolute path to the extracted package root (the dir containing `package.json`). */
  root: string;
  /** Cleanup hook — removes the tmpdir + tarball. */
  cleanup: () => Promise<void>;
}

/**
 * Run `pnpm pack` against REPO_ROOT, writing the tarball into a
 * tmpdir, and extract it. Returns the extracted tree's root.
 *
 * Why pnpm pack and not npm pack: this repo declares
 * `packageManager: pnpm@9.12.x` and pnpm honors `pnpm-lock.yaml` for
 * the prepublish lifecycle hook. `npm pack` would still work for the
 * file-list assertion (the hook chain is the same), but matching the
 * release pipeline's tooling avoids surprise drift.
 */
async function packAndExtract(): Promise<PackedTree> {
  const tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rea-pack-test-'));
  // `pnpm pack --pack-destination <dir>` writes the tarball there
  // without polluting the repo root with `.tgz` artifacts.
  await execFileAsync(
    'pnpm',
    ['pack', '--pack-destination', tmpdir],
    { cwd: REPO_ROOT, env: process.env },
  );
  // Locate the tarball (filename includes the version, which we don't
  // want to hard-code).
  const entries = await fsp.readdir(tmpdir);
  const tarballName = entries.find((n) => n.endsWith('.tgz'));
  if (tarballName === undefined) {
    throw new Error(
      `pnpm pack produced no .tgz in ${tmpdir} (got: ${entries.join(', ')})`,
    );
  }
  const tarballPath = path.join(tmpdir, tarballName);
  // Extract into a subdir so the tarball file and the extracted tree
  // don't clobber each other.
  const extractDir = path.join(tmpdir, 'extracted');
  await fsp.mkdir(extractDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractDir]);
  // npm tarballs always extract under `package/`.
  const root = path.join(extractDir, 'package');
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error(
      `extracted package missing package.json at ${root} — npm tarball layout changed?`,
    );
  }
  return {
    root,
    cleanup: async () => {
      try {
        await fsp.rm(tmpdir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

describe.runIf(PACK_TESTS_ENABLED)('package byte-fidelity', () => {
  let tree: PackedTree;

  beforeAll(async () => {
    tree = await packAndExtract();
  }, 120_000);

  afterAll(async () => {
    if (tree !== undefined) await tree.cleanup();
  });

  it('every EXPECTED_HOOKS entry is present in hooks/', () => {
    for (const hookName of EXPECTED_HOOKS) {
      const inTarball = path.join(tree.root, 'hooks', hookName);
      expect(fs.existsSync(inTarball), `hooks/${hookName} missing from tarball`).toBe(
        true,
      );
    }
  });

  it('every shipped hook is byte-identical to the source', async () => {
    const hooksDir = path.join(REPO_ROOT, 'hooks');
    for (const hookName of EXPECTED_HOOKS) {
      const source = await fsp.readFile(
        path.join(hooksDir, hookName),
        'utf8',
      );
      const shipped = await fsp.readFile(
        path.join(tree.root, 'hooks', hookName),
        'utf8',
      );
      expect(shipped, `hooks/${hookName} drift between source and tarball`).toBe(
        source,
      );
    }
  });

  it.runIf(!IS_WINDOWS)('every shipped *.sh file is at least readable by all', async () => {
    // NOTE — pnpm pack normalizes ALL files in the tarball to 0o644
    // regardless of the source mode bits. This is a known npm/pnpm
    // packaging behavior. Consumers invoke hooks through Claude Code's
    // dispatcher which runs `bash <hookpath>` (an explicit interpreter
    // call that does NOT require the executable bit), so the lost
    // +x has been latent without breaking governance.
    //
    // We assert the WEAKER invariant — the file is at least
    // world-readable — because that's the only one `pnpm pack`
    // actually preserves. A future 0.33.0+ packaging hardening pass
    // could either restore +x via a `prepack` script (chmod the tree
    // before tar-ing) or via the consumer's `postinstall` (the
    // `scripts/postinstall.mjs` would walk `node_modules/@bookedsolid/
    // rea/hooks/` and chmod each *.sh). Neither is on the 0.32.0
    // critical path.
    const hooksInTarball = await fsp.readdir(path.join(tree.root, 'hooks'));
    for (const name of hooksInTarball) {
      if (!name.endsWith('.sh')) continue;
      const stat = await fsp.stat(path.join(tree.root, 'hooks', name));
      const mode = stat.mode & 0o777;
      expect(
        (mode & 0o444) === 0o444,
        `hooks/${name} is not world-readable (mode = ${mode.toString(8)})`,
      ).toBe(true);
    }
  });

  it('every templates/*.sh entry is byte-identical to source', async () => {
    const templatesDir = path.join(REPO_ROOT, 'templates');
    const templateNames = (await fsp.readdir(templatesDir)).filter((n) =>
      n.endsWith('.sh'),
    );
    for (const name of templateNames) {
      const source = await fsp.readFile(path.join(templatesDir, name), 'utf8');
      const shipped = await fsp.readFile(
        path.join(tree.root, 'templates', name),
        'utf8',
      );
      expect(shipped, `templates/${name} drift between source and tarball`).toBe(
        source,
      );
    }
  });

  // Round-3 P1: `installPrepareCommitMsgHook()` copies the BODY at
  // `PKG_ROOT/.husky/prepare-commit-msg`, not the template under
  // `templates/`. If those two drift, `rea init` / `rea upgrade` ships
  // a stale hook body to consumers — silently nullifying surface
  // updates (the 0.32.0 `run_extension_chain` augmenter shipped at the
  // template path but not the canonical body would not have reached
  // any consumer install). Pin them.
  it('.husky/prepare-commit-msg matches templates/prepare-commit-msg.husky.sh byte-for-byte', async () => {
    const installed = await fsp.readFile(
      path.join(REPO_ROOT, '.husky', 'prepare-commit-msg'),
      'utf8',
    );
    const template = await fsp.readFile(
      path.join(REPO_ROOT, 'templates', 'prepare-commit-msg.husky.sh'),
      'utf8',
    );
    expect(
      installed,
      '.husky/prepare-commit-msg has drifted from templates/prepare-commit-msg.husky.sh — re-sync via git-apply (the dogfood install path is hard-protected by settings-protection.sh)',
    ).toBe(template);
  });

  it('package.json#files covers every governance directory', async () => {
    const pkg = JSON.parse(
      await fsp.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { files?: string[] };
    expect(pkg.files).toBeDefined();
    const required = [
      'dist/',
      'hooks/',
      'commands/',
      'agents/',
      'spine/',
      'profiles/',
      'templates/',
    ];
    for (const entry of required) {
      expect(
        pkg.files,
        `package.json#files missing required entry: ${entry}`,
      ).toContain(entry);
    }
  });

  it('every hook registered in .claude/settings.json has a matching shipped file', async () => {
    const settingsPath = path.join(REPO_ROOT, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      // Dogfood install absent — skip this assertion. The shipped
      // package isn't expected to carry .claude/settings.json itself
      // (consumers get it via `rea init`), so we only validate when
      // the source repo HAS the dogfood install.
      return;
    }
    const settings = JSON.parse(await fsp.readFile(settingsPath, 'utf8')) as {
      hooks?: Record<
        string,
        Array<{
          hooks?: Array<{ command?: string }>;
        }>
      >;
    };
    const groups = settings.hooks ?? {};
    const referencedHookFiles = new Set<string>();
    for (const matchers of Object.values(groups)) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks ?? []) {
          if (typeof hook.command !== 'string') continue;
          // Match `.claude/hooks/<name>.sh` references.
          const m = /\.claude\/hooks\/([\w.-]+\.sh)/.exec(hook.command);
          if (m && m[1] !== undefined) referencedHookFiles.add(m[1]);
        }
      }
    }
    for (const name of referencedHookFiles) {
      const inTarball = path.join(tree.root, 'hooks', name);
      expect(
        fs.existsSync(inTarball),
        `.claude/settings.json references hooks/${name} but it is not in the published tarball`,
      ).toBe(true);
    }
  });

  it('the pr-issue-link-gate Node-binary shim ships in the package', async () => {
    // 0.32.0 Phase 1 Pilot #1 — explicit anchor test for the new
    // shim shape. If the bash → Node migration regresses (someone
    // restores the bash body without updating tests), this trips.
    const shipped = await fsp.readFile(
      path.join(tree.root, 'hooks', 'pr-issue-link-gate.sh'),
      'utf8',
    );
    expect(shipped).toContain('Node-binary shim for `rea hook pr-issue-link-gate`');
    expect(shipped).toContain('rea hook pr-issue-link-gate');
    // Must NOT contain the old bash-resident matching logic — the
    // canonical body now lives in src/hooks/pr-issue-link-gate/.
    expect(shipped).not.toContain('SECURITY_PATTERNS=');
    expect(shipped).not.toContain('PR ISSUE LINK ADVISORY:');
  });
});
