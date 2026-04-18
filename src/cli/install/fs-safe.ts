/**
 * Shared safe-filesystem primitives for install-time writes (G12).
 *
 * Extracted from `copy.ts` so `upgrade.ts` inherits the same defenses:
 *   - path containment (destinations must live inside a resolved root)
 *   - symlink refusal (never write through a link — `rea init` originally
 *     defended against a malicious PR planting `.claude/hooks/x → /etc/shadow`)
 *   - parent-directory TOCTOU: `snapshotAncestors` + `verifyAncestorsUnchanged`
 *   - leaf-level race safety via `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`
 *
 * Every mutation in `copy.ts` and `upgrade.ts` must go through helpers here.
 * Adding a new write path and *not* using these helpers is a security bug.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export class UnsafeInstallPathError extends Error {
  public readonly kind: 'symlink' | 'escape' | 'ancestor-changed';
  public readonly targetPath: string;
  public readonly linkTarget?: string;

  public constructor(
    kind: 'symlink' | 'escape' | 'ancestor-changed',
    targetPath: string,
    linkTarget: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeInstallPathError';
    this.kind = kind;
    this.targetPath = targetPath;
    if (linkTarget !== undefined) this.linkTarget = linkTarget;
  }
}

/**
 * Validate that `candidate` is a relative path that stays inside `resolvedRoot`.
 * Rejects absolute paths, `..` segments, and anything that resolves outside the
 * root. Returns the fully-resolved absolute path on success.
 *
 * Use this on every path that originates from user- or manifest-supplied data
 * before it touches disk. An attacker who plants
 * `{"path": "../../../etc/passwd"}` in `.rea/install-manifest.json` must be
 * refused before any `unlink` / `open` / `copyFile` / `readFile` runs.
 */
export function resolveContained(resolvedRoot: string, candidate: string): string {
  if (path.isAbsolute(candidate)) {
    throw new UnsafeInstallPathError(
      'escape',
      candidate,
      undefined,
      `refusing absolute path: ${candidate}`,
    );
  }
  // Reject `..` segments on either separator, independent of OS.
  const parts = candidate.split(/[\\/]/);
  if (parts.includes('..')) {
    throw new UnsafeInstallPathError(
      'escape',
      candidate,
      undefined,
      `refusing path with parent-directory segments: ${candidate}`,
    );
  }
  const absolute = path.resolve(resolvedRoot, candidate);
  const rootWithSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  if (absolute !== resolvedRoot && !absolute.startsWith(rootWithSep)) {
    throw new UnsafeInstallPathError(
      'escape',
      absolute,
      undefined,
      `refusing to resolve outside install root: ${absolute} is not under ${resolvedRoot}`,
    );
  }
  return absolute;
}

/**
 * Assert that `dstPath` resolves to a location inside `resolvedRoot` and is
 * either absent or a regular file — never a symlink. Returns `true` if the
 * destination already exists (regular file), `false` if absent.
 */
export async function assertSafeDestination(
  resolvedRoot: string,
  dstPath: string,
): Promise<boolean> {
  const resolvedDst = path.resolve(dstPath);
  const rootWithSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  if (resolvedDst !== resolvedRoot && !resolvedDst.startsWith(rootWithSep)) {
    throw new UnsafeInstallPathError(
      'escape',
      resolvedDst,
      undefined,
      `refusing to write outside install root: ${resolvedDst} is not under ${resolvedRoot}`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(dstPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  if (stat.isSymbolicLink()) {
    let linkTarget = '<unreadable>';
    try {
      linkTarget = await fsPromises.readlink(dstPath);
    } catch {
      /* informational only */
    }
    throw new UnsafeInstallPathError(
      'symlink',
      dstPath,
      linkTarget,
      `refusing to write through symlink at ${dstPath} → ${linkTarget}. ` +
        `Remove the symlink manually after auditing where it points.`,
    );
  }

  if (!stat.isFile()) {
    throw new UnsafeInstallPathError(
      'escape',
      dstPath,
      undefined,
      `refusing to write: ${dstPath} exists but is not a regular file (mode ${stat.mode.toString(8)})`,
    );
  }

  return true;
}

export async function assertSafeDirectory(
  resolvedRoot: string,
  dirPath: string,
): Promise<void> {
  const resolvedDir = path.resolve(dirPath);
  const rootWithSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(rootWithSep)) {
    throw new UnsafeInstallPathError(
      'escape',
      resolvedDir,
      undefined,
      `refusing to operate on directory outside install root: ${resolvedDir}`,
    );
  }
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    let linkTarget = '<unreadable>';
    try {
      linkTarget = await fsPromises.readlink(dirPath);
    } catch {
      /* informational only */
    }
    throw new UnsafeInstallPathError(
      'symlink',
      dirPath,
      linkTarget,
      `refusing to traverse symlinked directory at ${dirPath} → ${linkTarget}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new UnsafeInstallPathError(
      'escape',
      dirPath,
      undefined,
      `refusing to operate: ${dirPath} exists but is not a directory`,
    );
  }
}

export async function snapshotAncestors(
  resolvedRoot: string,
  dstPath: string,
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const rootWithSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  const leafDir = path.dirname(path.resolve(dstPath));
  let cursor = leafDir;
  let reachedRoot = false;
  while (true) {
    let lstat: fs.Stats;
    try {
      lstat = await fsPromises.lstat(cursor);
    } catch (err) {
      throw err as NodeJS.ErrnoException;
    }
    if (lstat.isSymbolicLink()) {
      let linkTarget = '<unreadable>';
      try {
        linkTarget = await fsPromises.readlink(cursor);
      } catch {
        /* informational only */
      }
      throw new UnsafeInstallPathError(
        'symlink',
        cursor,
        linkTarget,
        `refusing to snapshot: ancestor ${cursor} is a symbolic link → ${linkTarget}. ` +
          `Remove the symlink manually after auditing where it points.`,
      );
    }
    let real: string;
    try {
      real = await fsPromises.realpath(cursor);
    } catch (err) {
      throw err as NodeJS.ErrnoException;
    }
    if (real !== resolvedRoot && !real.startsWith(rootWithSep)) {
      throw new UnsafeInstallPathError(
        'escape',
        real,
        undefined,
        `refusing to snapshot: ancestor ${cursor} resolves to ${real}, which is outside install root ${resolvedRoot}`,
      );
    }
    snapshot.set(cursor, real);

    if (cursor === resolvedRoot) {
      reachedRoot = true;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!reachedRoot) {
    throw new UnsafeInstallPathError(
      'escape',
      leafDir,
      undefined,
      `refusing to snapshot: ancestor walk from ${leafDir} never reached install root ${resolvedRoot}`,
    );
  }
  return snapshot;
}

export async function verifyAncestorsUnchanged(
  snapshot: Map<string, string>,
): Promise<void> {
  for (const [ancestor, originalReal] of snapshot) {
    let currentReal: string;
    try {
      currentReal = await fsPromises.realpath(ancestor);
    } catch (err) {
      throw new UnsafeInstallPathError(
        'ancestor-changed',
        ancestor,
        undefined,
        `refusing to write: ancestor directory ${ancestor} disappeared or became unreadable between validation and write (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
      );
    }
    if (currentReal !== originalReal) {
      throw new UnsafeInstallPathError(
        'ancestor-changed',
        ancestor,
        currentReal,
        `refusing to write: ancestor directory ${ancestor} changed between validation and write (was ${originalReal}, now ${currentReal})`,
      );
    }
  }
}

/**
 * Race-safe write: `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`. Caller must
 * ensure the leaf does not already exist — `upgrade.ts` overwrite path
 * `unlink`s first and then calls this.
 */
export async function writeFileExclusiveNoFollow(
  dstPath: string,
  contents: Buffer,
  mode: number = 0o644,
): Promise<void> {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
  const fh = await fsPromises.open(dstPath, flags, mode);
  try {
    await fh.writeFile(contents);
  } finally {
    await fh.close();
  }
}

export interface SafeWriteOptions {
  /** Absolute path to the canonical source file. Reads follow symlinks (trusted). */
  srcAbsPath: string;
  /** Resolved install root (from `fs.realpath(targetDir)`). */
  resolvedRoot: string;
  /** Destination relative to `resolvedRoot`. Validated for containment. */
  destRelPath: string;
  /** Mode to chmod the destination to after writing. */
  mode: number;
}

/**
 * Atomic-ish safe copy: validate containment, snapshot ancestors, `unlink` any
 * existing regular file (refuse symlinks), write via `O_NOFOLLOW|O_EXCL`, then
 * `chmod`. Every mutation is bracketed by `verifyAncestorsUnchanged` to close
 * the TOCTOU window on ancestor swaps.
 *
 * Returns the resolved absolute destination path on success.
 */
export async function safeInstallFile(opts: SafeWriteOptions): Promise<string> {
  const dstAbs = resolveContained(opts.resolvedRoot, opts.destRelPath);
  const exists = await assertSafeDestination(opts.resolvedRoot, dstAbs);
  await fsPromises.mkdir(path.dirname(dstAbs), { recursive: true });
  const ancestors = await snapshotAncestors(opts.resolvedRoot, dstAbs);
  const contents = await fsPromises.readFile(opts.srcAbsPath);

  if (exists) {
    await verifyAncestorsUnchanged(ancestors);
    await fsPromises.unlink(dstAbs);
  }
  await verifyAncestorsUnchanged(ancestors);
  await writeFileExclusiveNoFollow(dstAbs, contents, opts.mode);
  await fsPromises.chmod(dstAbs, opts.mode);
  return dstAbs;
}

/**
 * Safe delete: validate containment, refuse if the leaf is a symlink or not a
 * regular file. Used by `rea upgrade` on `removed-upstream` classifications
 * where the path comes from a manifest (attacker-controllable).
 */
export async function safeDeleteFile(
  resolvedRoot: string,
  destRelPath: string,
): Promise<void> {
  const abs = resolveContained(resolvedRoot, destRelPath);
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    let linkTarget = '<unreadable>';
    try {
      linkTarget = await fsPromises.readlink(abs);
    } catch {
      /* informational */
    }
    throw new UnsafeInstallPathError(
      'symlink',
      abs,
      linkTarget,
      `refusing to delete symlink at ${abs} → ${linkTarget}. Audit and remove manually.`,
    );
  }
  if (!stat.isFile()) {
    throw new UnsafeInstallPathError(
      'escape',
      abs,
      undefined,
      `refusing to delete: ${abs} is not a regular file (mode ${stat.mode.toString(8)})`,
    );
  }
  // Ancestors must be clean. Snapshot + re-verify to close the TOCTOU window.
  const ancestors = await snapshotAncestors(resolvedRoot, abs);
  await verifyAncestorsUnchanged(ancestors);
  await fsPromises.unlink(abs);
}

/**
 * Safe read: validate containment and that the leaf is a regular file
 * (refuses symlinks). Used by the drift report and by upgrade's SHA readers
 * when the path originates from the manifest.
 */
export async function safeReadFile(
  resolvedRoot: string,
  destRelPath: string,
): Promise<Buffer | null> {
  const abs = resolveContained(resolvedRoot, destRelPath);
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new UnsafeInstallPathError(
      'symlink',
      abs,
      undefined,
      `refusing to read symlink at ${abs}`,
    );
  }
  if (!stat.isFile()) return null;
  return fsPromises.readFile(abs);
}

/**
 * Atomic tmp + rename with a three-file dance that avoids the Windows
 * data-loss window. On POSIX, `rename(2)` replaces the destination atomically
 * and the dance collapses. On Windows, when `rename(tmp → final)` fails with
 * EEXIST/EPERM:
 *
 *   1. `rename(final → final.bak)` — preserves the previous manifest
 *   2. `rename(tmp → final)` — installs the new one
 *   3. On success: `unlink(final.bak)`
 *   4. On failure: `rename(final.bak → final)` to restore; throw
 *
 * At every point on disk there is exactly one valid file (either `final` or
 * `final.bak`). A crash in the middle leaves `final.bak` recoverable.
 */
export async function atomicReplaceFile(
  finalPath: string,
  contents: string | Buffer,
): Promise<void> {
  const dir = path.dirname(finalPath);
  await fsPromises.mkdir(dir, { recursive: true });
  const tmp = `${finalPath}.tmp`;
  const bak = `${finalPath}.bak`;
  const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
  await fsPromises.writeFile(tmp, bytes);
  try {
    await fsPromises.rename(tmp, finalPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') {
      await fsPromises.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  // Windows replace path: preserve the current file under .bak first.
  let movedToBak = false;
  try {
    await fsPromises.rename(finalPath, bak);
    movedToBak = true;
    await fsPromises.rename(tmp, finalPath);
    await fsPromises.unlink(bak).catch(() => undefined);
    return;
  } catch (retryErr) {
    // Restore: if we moved the old file to .bak but failed to install the new
    // one, put the old one back. Never leave the caller with no file at all.
    if (movedToBak) {
      try {
        await fsPromises.rename(bak, finalPath);
      } catch {
        // Best-effort. If even the restore fails, the .bak file remains on
        // disk as a recoverable artifact.
      }
    }
    await fsPromises.unlink(tmp).catch(() => undefined);
    throw retryErr;
  }
}
