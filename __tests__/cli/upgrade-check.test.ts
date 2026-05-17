/**
 * Tests for `rea upgrade --check` (0.41.0).
 *
 * The check flow is a preview — it reads the canonical file set,
 * compares against on-disk + manifest, and emits per-file diffs. We
 * verify the four fundamental file states (created / modified /
 * unchanged / removed-upstream), the synthetic settings + claude-md
 * rollups, and the headline rendering contract (counts, diff bodies,
 * "no changes" notice).
 *
 * The test seam: `computeUpgradeCheck({ canonicalFiles: [...] })` lets
 * us point the planner at a tiny synthetic canonical set instead of
 * the full `PKG_ROOT` enumeration. This keeps tests fast and means a
 * new shipped hook doesn't churn the assertions.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeUpgradeCheck,
  renderUpgradeCheck,
  UPGRADE_CHECK_SCHEMA_VERSION,
} from '../../src/cli/upgrade-check.js';
import type { CanonicalFile } from '../../src/cli/install/canonical.js';
import type { InstallManifest } from '../../src/cli/install/manifest-schema.js';
import { sha256OfBuffer } from '../../src/cli/install/sha.js';

interface Scratch {
  dir: string;
  pkgDir: string;
}

async function setupScratch(): Promise<Scratch> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-check-')));
  const pkgDir = path.join(dir, '_pkg');
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  await fs.mkdir(pkgDir, { recursive: true });
  // Minimal CLAUDE.md fragment loader needs a policy file. We give it
  // a minimal one so the synthetic claude-md classification runs end
  // to end. (Tests that exercise the no-policy branch don't write it.)
  await fs.writeFile(
    path.join(dir, '.rea', 'policy.yaml'),
    [
      'version: "1"',
      'profile: minimal',
      'installed_by: "rea@0.41.0 (test)"',
      'installed_at: "2026-05-16T00:00:00Z"',
      'autonomy_level: L1',
      'max_autonomy_level: L2',
      'promotion_requires_human_approval: true',
      'block_ai_attribution: true',
      'blocked_paths: []',
      'notification_channel: ""',
    ].join('\n'),
    'utf8',
  );
  return { dir, pkgDir };
}

async function writeCanonicalSource(
  pkgDir: string,
  relPath: string,
  content: string,
): Promise<{ src: string; sha: string }> {
  const src = path.join(pkgDir, relPath);
  await fs.mkdir(path.dirname(src), { recursive: true });
  await fs.writeFile(src, content, 'utf8');
  return { src, sha: sha256OfBuffer(Buffer.from(content, 'utf8')) };
}

function makeCanonical(srcAbsPath: string, destRelPath: string): CanonicalFile {
  return {
    sourceAbsPath: srcAbsPath,
    destRelPath,
    source: 'hook',
    mode: 0o755,
  };
}

async function writeManifest(
  baseDir: string,
  manifest: InstallManifest,
): Promise<void> {
  await fs.writeFile(
    path.join(baseDir, '.rea', 'install-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
}

describe('computeUpgradeCheck — basic classification', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns a stable schema_version + rea_version + target_root', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', '#!/bin/sh\necho one\n');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    expect(plan.schema_version).toBe(UPGRADE_CHECK_SCHEMA_VERSION);
    expect(plan.target_root).toBe(dir);
    expect(typeof plan.rea_version).toBe('string');
  });

  it('classifies an absent local file as `created`', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src, sha } = await writeCanonicalSource(pkgDir, 'one.sh', '#!/bin/sh\necho one\n');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const file = plan.files.find((f) => f.path === 'one.sh');
    expect(file).toBeDefined();
    expect(file!.action).toBe('created');
    expect(file!.new_sha).toBe(sha);
    expect(file!.old_sha).toBeUndefined();
    expect(file!.diff).toContain('--- a/one.sh');
    expect(file!.diff).toContain('+#!/bin/sh');
    expect(plan.counts.created).toBeGreaterThanOrEqual(1);
  });

  it('classifies a matching local file as `unchanged`', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const content = '#!/bin/sh\necho one\n';
    const { src, sha } = await writeCanonicalSource(pkgDir, 'one.sh', content);
    await fs.writeFile(path.join(dir, 'one.sh'), content, 'utf8');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const file = plan.files.find((f) => f.path === 'one.sh');
    expect(file!.action).toBe('unchanged');
    expect(file!.old_sha).toBe(sha);
    expect(file!.new_sha).toBe(sha);
    expect(file!.diff).toBeUndefined();
  });

  it('classifies a divergent local file as `modified` with a real diff', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const canonicalContent = '#!/bin/sh\necho NEW\n';
    const localContent = '#!/bin/sh\necho OLD\n';
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', canonicalContent);
    await fs.writeFile(path.join(dir, 'one.sh'), localContent, 'utf8');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const file = plan.files.find((f) => f.path === 'one.sh');
    expect(file!.action).toBe('modified');
    expect(file!.old_sha).not.toBe(file!.new_sha);
    expect(file!.diff).toContain('-echo OLD');
    expect(file!.diff).toContain('+echo NEW');
  });

  it('classifies a manifest-only entry as `removed_upstream`', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    // Canonical set is empty, but a local file exists and a manifest
    // entry pins it.
    const removedContent = 'stale\n';
    await fs.writeFile(path.join(dir, 'gone.sh'), removedContent, 'utf8');
    const removedSha = sha256OfBuffer(Buffer.from(removedContent, 'utf8'));
    await writeManifest(dir, {
      version: '0.40.0',
      profile: 'minimal',
      installed_at: '2026-05-15T00:00:00Z',
      upgraded_at: '2026-05-15T00:00:00Z',
      files: [{ path: 'gone.sh', sha256: removedSha, source: 'hook' }],
    });
    // No canonical files at all so 'gone.sh' isn't reclassified.
    // BUT: we need at least one canonical file because the test should
    // still exercise the synthetic settings + claude-md, which is fine.
    const { src } = await writeCanonicalSource(pkgDir, 'kept.sh', 'kept\n');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'kept.sh')],
    });
    const file = plan.files.find((f) => f.path === 'gone.sh');
    expect(file).toBeDefined();
    expect(file!.action).toBe('removed_upstream');
    expect(file!.diff).toContain('-stale');
    expect(plan.counts.removed_upstream).toBe(1);
  });

  it('flags bootstrap mode when no manifest exists', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'echo one\n');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    expect(plan.bootstrap).toBe(true);
  });

  it('does not flag bootstrap when a manifest is present', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src, sha } = await writeCanonicalSource(pkgDir, 'one.sh', 'echo one\n');
    await fs.writeFile(path.join(dir, 'one.sh'), 'echo one\n', 'utf8');
    await writeManifest(dir, {
      version: '0.40.0',
      profile: 'minimal',
      installed_at: '2026-05-15T00:00:00Z',
      upgraded_at: '2026-05-15T00:00:00Z',
      files: [{ path: 'one.sh', sha256: sha, source: 'hook' }],
    });
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    expect(plan.bootstrap).toBe(false);
  });
});

describe('computeUpgradeCheck — synthetic entries', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('emits a synthetic CLAUDE.md row when policy is loadable', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'x\n');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const claudeMd = plan.files.find((f) => f.synthetic === 'claude-md');
    expect(claudeMd).toBeDefined();
    // No CLAUDE.md on disk yet — fragment will be created.
    expect(claudeMd!.action).toBe('created');
    expect(claudeMd!.diff).toContain('+# CLAUDE.md');
  });

  it('emits a synthetic settings.json row even when settings.json is absent', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'x\n');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const settings = plan.files.find((f) => f.synthetic === 'settings');
    expect(settings).toBeDefined();
    expect(settings!.action).toBe('created');
    expect(settings!.path).toBe('.claude/settings.json');
    // The diff should contain the added hooks block.
    expect(settings!.diff).toContain('+');
  });

  it('emits a synthetic .gitignore row when the managed block is missing (codex round-1 P2)', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'x\n');
    // Pre-existing .gitignore without the rea-managed block — the
    // shape every 0.4.0-era install lands in.
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\n', 'utf8');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const gitignore = plan.files.find((f) => f.synthetic === 'gitignore');
    expect(gitignore).toBeDefined();
    expect(gitignore!.action).toBe('modified');
    expect(gitignore!.diff).toContain('+# === rea managed');
    expect(gitignore!.diff).toContain('+.rea/audit.jsonl');
  });

  it('synthetic SHA fields hash the on-disk file content, not subset/fragment SHAs (codex round-2 P2)', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'x\n');
    const { sha256OfBuffer } = await import('../../src/cli/install/sha.js');
    const {
      defaultDesiredHooks,
      mergeSettings,
      canonicalSettingsSubsetHash,
    } = await import('../../src/cli/install/settings-merge.js');
    // Place a settings.json that already has every desired hook
    // merged so the synthetic row reports `unchanged`.
    const desired = defaultDesiredHooks();
    const merged = mergeSettings({}, desired).merged;
    const onDiskBlob = `${JSON.stringify(merged, null, 2)}\n`;
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude', 'settings.json'), onDiskBlob, 'utf8');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const settings = plan.files.find((f) => f.synthetic === 'settings')!;
    expect(settings.action).toBe('unchanged');
    const expectedFileSha = sha256OfBuffer(Buffer.from(onDiskBlob, 'utf8'));
    expect(settings.new_sha).toBe(expectedFileSha);
    expect(settings.old_sha).toBe(expectedFileSha);
    // The manifest-tracked subset SHA must NOT be reported as new_sha.
    expect(settings.new_sha).not.toBe(canonicalSettingsSubsetHash(desired));
    // It should still appear in the note for forensics.
    expect(settings.note).toContain('rea-subset SHA');
  });

  it('CLAUDE.md synthetic uses full-file SHA, not fragment SHA, when unchanged', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'x\n');
    const { sha256OfBuffer } = await import('../../src/cli/install/sha.js');
    // Plant a CLAUDE.md with the canonical fragment so it's unchanged.
    const { buildFragment } = await import('../../src/cli/install/claude-md.js');
    const { loadPolicy } = await import('../../src/policy/loader.js');
    const policy = loadPolicy(dir);
    const fragment = buildFragment({
      policyPath: '.rea/policy.yaml',
      profile: policy.profile,
      autonomyLevel: policy.autonomy_level,
      maxAutonomyLevel: policy.max_autonomy_level,
      blockedPathsCount: policy.blocked_paths.length,
      blockAiAttribution: policy.block_ai_attribution,
    });
    const onDisk = `# CLAUDE.md\n\n${fragment}\n`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), onDisk, 'utf8');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const claudeMd = plan.files.find((f) => f.synthetic === 'claude-md')!;
    expect(claudeMd.action).toBe('unchanged');
    const expectedFileSha = sha256OfBuffer(Buffer.from(onDisk, 'utf8'));
    expect(claudeMd.new_sha).toBe(expectedFileSha);
    expect(claudeMd.old_sha).toBe(expectedFileSha);
    // The fragment-only SHA should NOT equal the file SHA.
    const fragmentOnlySha = sha256OfBuffer(Buffer.from(fragment, 'utf8'));
    expect(claudeMd.new_sha).not.toBe(fragmentOnlySha);
    // The note still references the fragment SHA for traceability.
    expect(claudeMd.note).toContain(fragmentOnlySha.slice(0, 12));
  });

  it('emits a `created` synthetic .gitignore row on a fresh repo', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'x\n');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const gitignore = plan.files.find((f) => f.synthetic === 'gitignore');
    expect(gitignore).toBeDefined();
    expect(gitignore!.action).toBe('created');
    expect(gitignore!.diff).toContain('+# === rea managed');
  });

  it('marks settings.json `unchanged` when desired hooks are already merged', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'x\n');
    // First pass: capture the settings shape the planner produces.
    const planA = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const settingsA = planA.files.find((f) => f.synthetic === 'settings')!;
    // Replay the would-be settings to disk, then re-run.
    expect(settingsA.diff).toBeDefined();
    // Reverse-engineer the desired content by reading the planner's
    // diff: easier to materialize via mergeSettings directly.
    // Instead, write what the planner would write by running an
    // upgrade-equivalent: synthesize defaults via the planner itself.
    // Simplest path: extract the new content from the diff by
    // re-running computeUpgradeCheck — the on-disk file is what the
    // planner will produce next round. For now we just install an
    // empty merge target by writing the canonical desired-hooks blob
    // via the public helper: pretend the user already has settings.
    // Reuse the existing test pattern from settings-merge.test.ts.
    const { defaultDesiredHooks, mergeSettings } = await import(
      '../../src/cli/install/settings-merge.js'
    );
    const desired = defaultDesiredHooks();
    const baseline = mergeSettings({}, desired).merged;
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'settings.json'),
      `${JSON.stringify(baseline, null, 2)}\n`,
      'utf8',
    );
    const planB = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const settingsB = planB.files.find((f) => f.synthetic === 'settings')!;
    expect(settingsB.action).toBe('unchanged');
  });
});

describe('computeUpgradeCheck — counts + ordering', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('sorts modified ahead of created ahead of unchanged', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src: srcA } = await writeCanonicalSource(pkgDir, 'a.sh', 'A2\n');
    const { src: srcB } = await writeCanonicalSource(pkgDir, 'b.sh', 'B\n');
    const { src: srcC } = await writeCanonicalSource(pkgDir, 'c.sh', 'C\n');
    // a.sh exists with different content → modified
    // b.sh exists with same content → unchanged
    // c.sh is absent → created
    await fs.writeFile(path.join(dir, 'a.sh'), 'A1\n', 'utf8');
    await fs.writeFile(path.join(dir, 'b.sh'), 'B\n', 'utf8');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [
        makeCanonical(srcA, 'a.sh'),
        makeCanonical(srcB, 'b.sh'),
        makeCanonical(srcC, 'c.sh'),
      ],
    });
    // Find indices of our test files in the sorted output.
    const idxA = plan.files.findIndex((f) => f.path === 'a.sh');
    const idxB = plan.files.findIndex((f) => f.path === 'b.sh');
    const idxC = plan.files.findIndex((f) => f.path === 'c.sh');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxC); // modified before created
    expect(idxC).toBeLessThan(idxB); // created before unchanged
  });

  it('respects includeDiffs=false', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'NEW\n');
    await fs.writeFile(path.join(dir, 'one.sh'), 'OLD\n', 'utf8');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
      includeDiffs: false,
    });
    const file = plan.files.find((f) => f.path === 'one.sh');
    expect(file!.action).toBe('modified');
    expect(file!.diff).toBeUndefined();
    expect(file!.diff_truncated).toBeUndefined();
  });
});

describe('CLI flag wiring (codex round-2 P1)', () => {
  it('refuses `--json` without `--check` instead of running a real upgrade', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const distCli = path.join(repoRoot, 'dist', 'cli', 'index.js');
    if (!fsSync.existsSync(distCli)) {
      // The full suite runs `pnpm build` first; skip when invoked in
      // isolation against a stale dist (the file says so).
      console.warn('skipping: dist/cli/index.js not built (run `pnpm build`)');
      return;
    }
    const result = spawnSync(process.execPath, [distCli, 'upgrade', '--json'], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('preview-only');
  });

  it('refuses `--no-diff` without `--check`', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const distCli = path.join(repoRoot, 'dist', 'cli', 'index.js');
    if (!fsSync.existsSync(distCli)) {
      console.warn('skipping: dist/cli/index.js not built');
      return;
    }
    const result = spawnSync(process.execPath, [distCli, 'upgrade', '--no-diff'], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('preview-only');
  });
});

describe('renderUpgradeCheck', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('prints a "no changes" notice when nothing would change', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    // Make every canonical match its on-disk counterpart AND settings
    // already merged.
    const content = 'fixed\n';
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', content);
    await fs.writeFile(path.join(dir, 'one.sh'), content, 'utf8');
    // Settings: write the merged baseline.
    const { defaultDesiredHooks, mergeSettings } = await import(
      '../../src/cli/install/settings-merge.js'
    );
    const baseline = mergeSettings({}, defaultDesiredHooks()).merged;
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'settings.json'),
      `${JSON.stringify(baseline, null, 2)}\n`,
      'utf8',
    );
    // CLAUDE.md fragment: synthesize via buildFragment so it lines up.
    const { buildFragment } = await import('../../src/cli/install/claude-md.js');
    const { loadPolicy } = await import('../../src/policy/loader.js');
    const policy = loadPolicy(dir);
    const fragment = buildFragment({
      policyPath: '.rea/policy.yaml',
      profile: policy.profile,
      autonomyLevel: policy.autonomy_level,
      maxAutonomyLevel: policy.max_autonomy_level,
      blockedPathsCount: policy.blocked_paths.length,
      blockAiAttribution: policy.block_ai_attribution,
    });
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), `# CLAUDE.md\n\n${fragment}\n`, 'utf8');
    // .gitignore managed block: run ensureReaGitignore for real so the
    // canonical entries land. Subsequent dry-run should report
    // 'unchanged'.
    const { ensureReaGitignore } = await import('../../src/cli/install/gitignore.js');
    await ensureReaGitignore(dir);

    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const rendered = renderUpgradeCheck(plan);
    expect(rendered).toContain('No changes — your install is already in sync');
  });

  it('renders modified file diffs with the trailing "no changes were written" notice', async () => {
    const { dir, pkgDir } = await setupScratch();
    cleanup.push(dir);
    const { src } = await writeCanonicalSource(pkgDir, 'one.sh', 'NEW\n');
    await fs.writeFile(path.join(dir, 'one.sh'), 'OLD\n', 'utf8');
    const plan = await computeUpgradeCheck({
      baseDir: dir,
      canonicalFiles: [makeCanonical(src, 'one.sh')],
    });
    const rendered = renderUpgradeCheck(plan);
    expect(rendered).toContain('~ one.sh');
    expect(rendered).toContain('-OLD');
    expect(rendered).toContain('+NEW');
    expect(rendered).toContain('No changes were written. Run `rea upgrade`');
  });
});
