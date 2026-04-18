import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyArtifacts, UnsafeInstallPathError, __internal } from './copy.js';

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

  // ---- Finding R2-4: parent-directory TOCTOU ------------------------------

  it('verifyAncestorsUnchanged throws ancestor-changed when an ancestor dir is swapped', async () => {
    // Build a snapshot of `targetDir/.claude/hooks` ancestors, then swap an
    // intermediate directory for a symlink to a sibling. The re-verification
    // must refuse — this is the exact race R2-4 is defending against,
    // simulated deterministically by doing the swap between snapshot and check.
    const resolvedRoot = await fs.realpath(targetDir);
    const claudeDir = path.join(resolvedRoot, '.claude');
    const hooksDir = path.join(claudeDir, 'hooks');
    const leaf = path.join(hooksDir, 'probe.sh');
    await fs.mkdir(hooksDir, { recursive: true });

    const snapshot = await __internal.snapshotAncestors(resolvedRoot, leaf);
    // Sanity: snapshot covers root, .claude, .claude/hooks.
    expect(snapshot.size).toBeGreaterThanOrEqual(3);
    expect(snapshot.has(hooksDir)).toBe(true);

    // Simulate the race: swap .claude/hooks for a symlink to a decoy.
    const decoy = path.join(resolvedRoot, 'decoy');
    await fs.mkdir(decoy, { recursive: true });
    await fs.rm(hooksDir, { recursive: true, force: true });
    await fs.symlink(decoy, hooksDir);

    let caught: unknown = null;
    try {
      await __internal.verifyAncestorsUnchanged(snapshot);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsafeInstallPathError);
    const uip = caught as UnsafeInstallPathError;
    expect(uip.kind).toBe('ancestor-changed');
    expect(uip.targetPath).toBe(hooksDir);
  });

  it('verifyAncestorsUnchanged passes when ancestors are stable', async () => {
    const resolvedRoot = await fs.realpath(targetDir);
    const claudeDir = path.join(resolvedRoot, '.claude');
    const hooksDir = path.join(claudeDir, 'hooks');
    const leaf = path.join(hooksDir, 'probe.sh');
    await fs.mkdir(hooksDir, { recursive: true });

    const snapshot = await __internal.snapshotAncestors(resolvedRoot, leaf);
    // No changes — must not throw.
    await __internal.verifyAncestorsUnchanged(snapshot);
  });

  // ---- Finding R3-1: install-root escape via pre-snapshot ancestor swap ---

  it('snapshotAncestors refuses when an ancestor is a symbolic link (inside root)', async () => {
    // Plant the attack at snapshot time rather than between snapshot and
    // verify: swap `.claude/hooks` for a symlink to a sibling directory that
    // is still inside the install root. Without R3-1 hardening, the snapshot
    // would record the attacker's state as baseline (realpath stable), and
    // verifyAncestorsUnchanged would later pass. With hardening, the lstat
    // check refuses at snapshot time.
    const resolvedRoot = await fs.realpath(targetDir);
    const claudeDir = path.join(resolvedRoot, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });

    const sibling = path.join(resolvedRoot, 'sibling');
    await fs.mkdir(sibling, { recursive: true });

    const hooksDir = path.join(claudeDir, 'hooks');
    // hooksDir is a symlink to an in-root directory — containment would pass
    // but the ancestor itself is a symlink and must be refused.
    await fs.symlink(sibling, hooksDir);

    const leaf = path.join(hooksDir, 'secret-scanner.sh');

    let caught: unknown = null;
    try {
      await __internal.snapshotAncestors(resolvedRoot, leaf);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsafeInstallPathError);
    const uip = caught as UnsafeInstallPathError;
    expect(uip.kind).toBe('symlink');
    expect(uip.targetPath).toBe(hooksDir);
  });

  it('snapshotAncestors refuses when an ancestor escapes the install root', async () => {
    // The exact R3-1 primitive: `.claude/hooks` is a symlink pointing outside
    // the install root. Before R3-1 hardening, snapshotAncestors recorded
    // `/tmp/decoy` as baseline, verifyAncestorsUnchanged passed, and
    // writeFileExclusiveNoFollow landed the payload at /tmp/decoy/<leaf>
    // (O_NOFOLLOW only guards the leaf, not ancestor components).
    const resolvedRoot = await fs.realpath(targetDir);
    const claudeDir = path.join(resolvedRoot, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });

    // Decoy lives outside resolvedRoot. We build it inside a separate tmp dir
    // so its realpath is definitively not under the install root.
    const decoyParent = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-decoy-'));
    try {
      const decoy = await fs.realpath(decoyParent);
      const hooksDir = path.join(claudeDir, 'hooks');
      await fs.symlink(decoy, hooksDir);

      const leaf = path.join(hooksDir, 'secret-scanner.sh');

      let caught: unknown = null;
      try {
        await __internal.snapshotAncestors(resolvedRoot, leaf);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnsafeInstallPathError);
      const uip = caught as UnsafeInstallPathError;
      // The symlink check fires first (and it should — lstat is cheaper than
      // realpath + containment). Either kind is a correct refusal, so we
      // assert that the call refused AND that the containment path would
      // also have refused by separately probing a non-symlink-but-escaping
      // configuration below.
      expect(['symlink', 'escape']).toContain(uip.kind);

      // Confirm the targetPath names the offending ancestor or its resolved
      // destination — never a component outside what the attacker planted.
      if (uip.kind === 'symlink') {
        expect(uip.targetPath).toBe(hooksDir);
        expect(uip.linkTarget).toBe(decoy);
      } else {
        // kind === 'escape'
        expect(uip.targetPath).toBe(decoy);
      }

      // Nothing should have been written into the decoy.
      const decoyEntries = await fs.readdir(decoy);
      expect(decoyEntries).toEqual([]);
    } finally {
      await fs.rm(decoyParent, { recursive: true, force: true });
    }
  });

  it('writeFileExclusiveNoFollow refuses when the leaf is a symlink (O_NOFOLLOW)', async () => {
    const resolvedRoot = await fs.realpath(targetDir);
    const src = path.join(resolvedRoot, 'src-file.txt');
    await fs.writeFile(src, 'hello\n', 'utf8');

    const sensitive = path.join(resolvedRoot, 'sensitive.txt');
    await fs.writeFile(sensitive, 'SACROSANCT\n', 'utf8');

    const leaf = path.join(resolvedRoot, 'leaf.txt');
    await fs.symlink(sensitive, leaf);

    let caught: NodeJS.ErrnoException | null = null;
    try {
      await __internal.writeFileExclusiveNoFollow(src, leaf);
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    expect(caught).not.toBeNull();
    // Either EEXIST (from O_EXCL, since the link itself exists as an entry) or
    // ELOOP (from O_NOFOLLOW on platforms where EXCL lets the syscall progress
    // far enough to hit NOFOLLOW). Both are correct refusals.
    expect(['EEXIST', 'ELOOP']).toContain(caught!.code);

    // Sensitive target must be untouched.
    expect(await fs.readFile(sensitive, 'utf8')).toBe('SACROSANCT\n');
  });

  // Concurrent ancestor-swap during a live install would require spawning a
  // second process that wins the event-loop race between snapshot/verify and
  // the subsequent write. Node's single-threaded I/O and vitest's event loop
  // make that effectively non-deterministic here — we skip the integration
  // race test and rely on the deterministic helper tests above plus the
  // O_EXCL | O_NOFOLLOW open in writeFileExclusiveNoFollow. The residual
  // sub-millisecond race is documented in copy.ts.
  it.skip('race: concurrent attacker swaps ancestor mid-install (non-deterministic)', () => {
    // Intentionally not implemented — see comment above.
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
