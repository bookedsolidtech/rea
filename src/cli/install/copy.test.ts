import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyArtifacts, UnsafeInstallPathError } from './copy.js';

describe('copyArtifacts', () => {
  let targetDir: string;

  beforeEach(async () => {
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-copy-'));
  });

  afterEach(async () => {
    await fs.rm(targetDir, { recursive: true, force: true });
  });

  it('copies hooks/commands/agents into .claude/ and chmods hooks executable', async () => {
    const result = await copyArtifacts(targetDir, { force: false, yes: true });
    expect(result.copied.length).toBeGreaterThan(0);
    expect(result.overwritten).toHaveLength(0);

    // Hooks must be executable.
    const hookPath = path.join(targetDir, '.claude', 'hooks', 'dangerous-bash-interceptor.sh');
    const stat = await fs.stat(hookPath);
    expect(stat.mode & 0o111).toBeGreaterThan(0);

    // Agents must be present.
    const agent = path.join(targetDir, '.claude', 'agents', 'rea-orchestrator.md');
    expect((await fs.stat(agent)).isFile()).toBe(true);
  });

  it('skips existing files under --yes (no silent overwrite)', async () => {
    // First copy.
    await copyArtifacts(targetDir, { force: false, yes: true });
    // Mutate one file — simulates a consumer edit.
    const hookPath = path.join(targetDir, '.claude', 'hooks', 'dangerous-bash-interceptor.sh');
    await fs.writeFile(hookPath, '# user edit\n', 'utf8');

    const result = await copyArtifacts(targetDir, { force: false, yes: true });
    expect(result.copied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);

    // User edit must still be intact.
    const content = await fs.readFile(hookPath, 'utf8');
    expect(content).toBe('# user edit\n');
  });

  it('--force overwrites existing files', async () => {
    await copyArtifacts(targetDir, { force: false, yes: true });
    const hookPath = path.join(targetDir, '.claude', 'hooks', 'dangerous-bash-interceptor.sh');
    await fs.writeFile(hookPath, '# user edit\n', 'utf8');

    const result = await copyArtifacts(targetDir, { force: true, yes: true });
    expect(result.overwritten.length).toBeGreaterThan(0);

    // User edit must NOT be intact under --force.
    const content = await fs.readFile(hookPath, 'utf8');
    expect(content).not.toBe('# user edit\n');
  });

  // ---- Finding #5: symlink safety -----------------------------------------

  it('refuses to write through a symlinked hook destination (--force)', async () => {
    // First install to create the tree.
    await copyArtifacts(targetDir, { force: false, yes: true });

    // Plant a symlink at a hook destination pointing at a "sensitive" file we
    // control inside the sandbox. If the installer follows the link, the
    // target gets overwritten — that is the vulnerability we are testing.
    const hookDst = path.join(
      targetDir,
      '.claude',
      'hooks',
      'dangerous-bash-interceptor.sh',
    );
    const sensitive = path.join(targetDir, 'sentinel.txt');
    const sentinelContents = 'DO NOT OVERWRITE\n';
    await fs.writeFile(sensitive, sentinelContents, 'utf8');

    await fs.unlink(hookDst);
    await fs.symlink(sensitive, hookDst);

    // A --force re-install must refuse. It must NOT touch the sentinel.
    let caught: unknown = null;
    try {
      await copyArtifacts(targetDir, { force: true, yes: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsafeInstallPathError);
    const uip = caught as UnsafeInstallPathError;
    expect(uip.kind).toBe('symlink');
    expect(uip.targetPath).toContain('dangerous-bash-interceptor.sh');
    expect(uip.linkTarget).toBe(sensitive);

    // Sentinel must be untouched — neither content nor mode.
    const after = await fs.readFile(sensitive, 'utf8');
    expect(after).toBe(sentinelContents);
    const stat = await fs.stat(sensitive);
    expect(stat.mode & 0o111).toBe(0); // not chmod'd executable
  });

  it('refuses to write through a symlinked destination on a fresh install (--yes)', async () => {
    // Pre-create the .claude/hooks/ tree and plant a symlink BEFORE install.
    const hooksDir = path.join(targetDir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });

    const sensitive = path.join(targetDir, 'sentinel.txt');
    await fs.writeFile(sensitive, 'UNTOUCHED\n', 'utf8');

    const hookDst = path.join(hooksDir, 'secret-scanner.sh');
    await fs.symlink(sensitive, hookDst);

    let caught: unknown = null;
    try {
      await copyArtifacts(targetDir, { force: false, yes: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsafeInstallPathError);
    expect((caught as UnsafeInstallPathError).kind).toBe('symlink');

    // Sentinel untouched.
    expect(await fs.readFile(sensitive, 'utf8')).toBe('UNTOUCHED\n');
  });

  it('refuses to write when a parent directory under .claude/ is a symlink', async () => {
    // Plant the attack at the directory level: swap .claude/hooks/ for a
    // symlink pointing somewhere in the sandbox. The installer must refuse
    // before it writes a single file, rather than silently treating the
    // linked directory as the hooks directory.
    const claudeDir = path.join(targetDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });

    const decoy = path.join(targetDir, 'decoy');
    await fs.mkdir(decoy, { recursive: true });

    const hookDir = path.join(claudeDir, 'hooks');
    await fs.symlink(decoy, hookDir);

    let caught: unknown = null;
    try {
      await copyArtifacts(targetDir, { force: false, yes: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsafeInstallPathError);
    const uip = caught as UnsafeInstallPathError;
    expect(uip.kind).toBe('symlink');

    // The decoy directory must still be empty — the installer bailed before
    // any write happened.
    const decoyEntries = await fs.readdir(decoy);
    expect(decoyEntries).toEqual([]);
  });
});
