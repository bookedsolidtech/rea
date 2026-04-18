/**
 * Copy hooks, commands, and agents from the installed package into a consumer's
 * `.claude/` directory. This is the core of what makes `rea init` a real
 * installer rather than a policy-file writer.
 *
 * Conflict policy:
 *
 *   - `--force` (boolean): overwrite unconditionally. Reserved for power users
 *     who have intentionally modified their local `.claude/` and know they want
 *     fresh-from-package versions back.
 *   - `--yes` (boolean): non-interactive. Skips existing files — NEVER silently
 *     replaces a consumer-modified hook. This is the safe default for CI.
 *   - Default (interactive): prompts per conflict via `@clack/prompts`.
 *
 * Hook scripts are chmod'd to 0o755 so the shell hooks the harness fires can
 * actually execute on a fresh clone.
 *
 * ## Symlink safety (finding #5)
 *
 * A prior malicious PR could leave a symlink at a destination path (e.g.
 * `.claude/hooks/secret-scanner.sh` → `/etc/shadow`). Node's `copyFile` and
 * `chmod` follow symlinks, so a subsequent `rea init --force` would overwrite
 * the link target and chmod it 0o755. We defend in multiple layers:
 *
 *   1. Resolve the install root with `realpath` once per run.
 *   2. Before any write, `lstat` the destination and REFUSE (hard error, named
 *      file + link target) if it is a symlink. The presence of a symlink is a
 *      signal worth surfacing to the operator — we do not silently rewrite it.
 *   3. For every destination path, resolve it and assert containment within the
 *      resolved root. Anything escaping the root is refused.
 *
 * On overwrite we use `openSync(O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW)` and
 * write the bytes ourselves — `O_EXCL` makes the create race-safe, and
 * `O_NOFOLLOW` refuses any symlink that sneaks in between the lstat and the
 * write. On fresh creates we use the same flags for the same reason.
 *
 * ## Parent-directory TOCTOU (finding R2-4)
 *
 * `assertSafeDirectory` validates a path *string*. A concurrent attacker with
 * write access under the install tree could swap `.claude/hooks` for a symlink
 * in the window between validation and the subsequent `copyFile`/`unlink`. To
 * close this window:
 *
 *   1. After validating the install root, snapshot the realpath of every
 *      ancestor directory between the destination and the root.
 *   2. Immediately before every mutation (`unlink`, then the file write), we
 *      re-realpath the same ancestors and refuse if any changed. This closes
 *      the practical exploit window to sub-millisecond.
 *   3. `O_NOFOLLOW` on the write call catches a symlink that slips in at the
 *      leaf between the re-check and the `open` syscall.
 *
 * Residual risk: a race that wins between the re-realpath loop and the `open`
 * syscall on the leaf still exists, but the `O_NOFOLLOW | O_EXCL` open will
 * refuse any symlink that lands in that micro-window. Fully closing the
 * ancestor-swap race would require dirfd-relative APIs (`openat`) which Node's
 * core `fs` module does not expose. Documented; not a code-execution primitive.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { PKG_ROOT, warn } from '../utils.js';

export interface CopyOptions {
  force: boolean;
  yes: boolean;
}

export interface CopyResult {
  copied: string[];
  skipped: string[];
  overwritten: string[];
}

/** Subdirectory names under `.claude/` that we manage. */
const COPY_DIRS = ['hooks', 'commands', 'agents'] as const;

type CopyDir = (typeof COPY_DIRS)[number];

/**
 * Thrown when a destination path is a symlink, escapes the install root, or a
 * previously-validated ancestor directory changed shape between validation and
 * the write (finding R2-4). Kept as a named class so callers (and tests) can
 * match the shape without scraping the message.
 */
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

function relClaude(targetDir: string, absPath: string): string {
  return path.relative(targetDir, absPath);
}

async function decideConflict(
  relPath: string,
  options: CopyOptions,
): Promise<'overwrite' | 'skip'> {
  if (options.force) return 'overwrite';
  if (options.yes) return 'skip';
  const answer = await p.select<'overwrite' | 'skip'>({
    message: `${relPath} already exists — overwrite?`,
    initialValue: 'skip',
    options: [
      { value: 'skip', label: 'skip', hint: 'keep existing file' },
      { value: 'overwrite', label: 'overwrite', hint: 'replace with packaged version' },
    ],
  });
  if (p.isCancel(answer)) return 'skip';
  return answer;
}

async function ensureDir(dir: string): Promise<void> {
  await fsPromises.mkdir(dir, { recursive: true });
}

/**
 * Assert that `dstPath` resolves to a location inside `resolvedRoot` and is
 * either absent or a regular file — never a symlink. Throws
 * `UnsafeInstallPathError` with a clear diagnostic on any violation.
 *
 * Returns `true` if the destination already exists (regular file), `false` if
 * it is absent. Any other shape (symlink, directory, device) → throw.
 */
async function assertSafeDestination(
  resolvedRoot: string,
  dstPath: string,
): Promise<boolean> {
  // Containment: resolve without following symlinks on the leaf so an attacker
  // cannot smuggle us out via a symlink in the leaf itself.
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
      // readlink can fail on broken or permission-restricted links; we still
      // refuse the write but the target string is informational only.
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

/**
 * Guard a directory path the same way we guard files: the directory itself
 * must not be a symlink, and it must live inside the install root. We don't
 * demand it already exists — `ensureDir` handles that. We only demand that if
 * it does exist, it's a real directory owned by the tree we're writing into.
 */
async function assertSafeDirectory(
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

interface WalkContext {
  resolvedRoot: string;
}

/**
 * Snapshot the realpath of every ancestor directory between `dstPath` and
 * `resolvedRoot` (inclusive of the root, exclusive of the leaf). The resulting
 * map — `absolute ancestor path → realpath at snapshot time` — is later
 * re-validated by {@link verifyAncestorsUnchanged} immediately before each
 * mutation. If any entry has changed, the tree was swapped and we refuse.
 *
 * We deliberately skip the leaf: the leaf's safety is handled by the
 * `lstat` check in `assertSafeDestination` and by `O_NOFOLLOW` on the open.
 */
async function snapshotAncestors(
  resolvedRoot: string,
  dstPath: string,
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const leafDir = path.dirname(path.resolve(dstPath));
  let cursor = leafDir;
  // Walk up until we pass the root. Every ancestor must resolve to something
  // inside the root (including the root itself).
  // path.parse('/').root === '/', so cursor === path.dirname(cursor) only at FS root.
  while (true) {
    try {
      const real = await fsPromises.realpath(cursor);
      snapshot.set(cursor, real);
    } catch (err) {
      // ENOENT is acceptable here only if `ensureDir` has not yet created the
      // directory. We only snapshot dirs the caller has already ensured exist,
      // so any error is a real problem — surface it.
      throw err as NodeJS.ErrnoException;
    }
    if (cursor === resolvedRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break; // reached filesystem root without hitting resolvedRoot
    cursor = parent;
  }
  return snapshot;
}

/**
 * Re-realpath every ancestor captured in `snapshot` and throw
 * {@link UnsafeInstallPathError} if any resolution has changed (an intermediate
 * directory was replaced with a symlink, renamed, etc.) or disappeared.
 */
async function verifyAncestorsUnchanged(
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
 * Write `srcPath`'s bytes to `dstPath` using `openSync(O_WRONLY | O_CREAT |
 * O_EXCL | O_NOFOLLOW)`. This is the race-safe replacement for `copyFile` —
 *
 *   - `O_EXCL`: the open fails with EEXIST if anything appears at the leaf
 *     between our pre-check and this call, including a symlink or regular file.
 *   - `O_NOFOLLOW`: the open fails with ELOOP if the leaf itself is a symlink
 *     that somehow bypassed EXCL (belt-and-suspenders; on most platforms EXCL
 *     alone is sufficient).
 *
 * Reads the source via the fs/promises API so we inherit standard error shapes.
 * Source-side read follows symlinks, which is fine: `srcPath` is inside PKG_ROOT
 * and the source tree is trusted.
 */
async function writeFileExclusiveNoFollow(
  srcPath: string,
  dstPath: string,
): Promise<void> {
  const contents = await fsPromises.readFile(srcPath);
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
  const fh = await fsPromises.open(dstPath, flags, 0o644);
  try {
    await fh.writeFile(contents);
  } finally {
    await fh.close();
  }
}

async function walkAndCopy(
  sourceRoot: string,
  destRoot: string,
  dirName: CopyDir,
  targetDir: string,
  options: CopyOptions,
  result: CopyResult,
  ctx: WalkContext,
): Promise<void> {
  const src = path.join(sourceRoot, dirName);
  const dst = path.join(destRoot, dirName);
  if (!fs.existsSync(src)) {
    warn(`packaged directory missing: ${src} — skipping ${dirName} copy`);
    return;
  }
  await assertSafeDirectory(ctx.resolvedRoot, dst);
  await ensureDir(dst);

  const entries = await fsPromises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    const relPath = relClaude(targetDir, dstPath);

    if (entry.isDirectory()) {
      // Recurse into subdirectories (e.g. hooks/_lib/).
      await assertSafeDirectory(ctx.resolvedRoot, dstPath);
      await ensureDir(dstPath);
      const subEntries = await fsPromises.readdir(srcPath, { withFileTypes: true });
      for (const sub of subEntries) {
        const subSrc = path.join(srcPath, sub.name);
        const subDst = path.join(dstPath, sub.name);
        if (sub.isDirectory()) {
          // Two levels of recursion is enough for the current layout; anything
          // deeper is a design smell worth failing loudly on.
          warn(`nested directory beyond depth 2 ignored: ${subSrc}`);
          continue;
        }
        await copyOne(
          subSrc,
          subDst,
          relClaude(targetDir, subDst),
          dirName,
          options,
          result,
          ctx,
        );
      }
      continue;
    }
    await copyOne(srcPath, dstPath, relPath, dirName, options, result, ctx);
  }
}

async function copyOne(
  srcPath: string,
  dstPath: string,
  relPath: string,
  dirName: CopyDir,
  options: CopyOptions,
  result: CopyResult,
  ctx: WalkContext,
): Promise<void> {
  // Symlink + containment check. Throws UnsafeInstallPathError on violation —
  // we let it propagate so the caller (`rea init`) prints a hard error and
  // exits non-zero. Recovering silently would defeat the signal.
  const exists = await assertSafeDestination(ctx.resolvedRoot, dstPath);

  // Snapshot every ancestor directory between the destination and the install
  // root (finding R2-4). We re-verify this snapshot immediately before each
  // mutation to shrink the parent-directory TOCTOU window to sub-millisecond.
  const ancestorSnapshot = await snapshotAncestors(ctx.resolvedRoot, dstPath);

  if (exists) {
    const decision = await decideConflict(relPath, options);
    if (decision === 'skip') {
      result.skipped.push(relPath);
      return;
    }
    // Overwrite path: re-verify ancestors, then unlink, then re-verify again
    // before writing. Writes use O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW so
    // any symlink/file that slips in between the unlink and the open fails
    // the syscall rather than letting us clobber something we shouldn't.
    await verifyAncestorsUnchanged(ancestorSnapshot);
    await fsPromises.unlink(dstPath);
    await verifyAncestorsUnchanged(ancestorSnapshot);
    await writeFileExclusiveNoFollow(srcPath, dstPath);
    if (dirName === 'hooks') await fsPromises.chmod(dstPath, 0o755);
    result.overwritten.push(relPath);
    return;
  }

  // Fresh create: re-verify ancestors, then open with EXCL|NOFOLLOW. EXCL
  // guarantees we fail if something appeared at the leaf; NOFOLLOW guarantees
  // we fail if the leaf is a symlink.
  await verifyAncestorsUnchanged(ancestorSnapshot);
  await writeFileExclusiveNoFollow(srcPath, dstPath);
  if (dirName === 'hooks') await fsPromises.chmod(dstPath, 0o755);
  result.copied.push(relPath);
}

/**
 * Copy hooks/commands/agents from the package root into `${targetDir}/.claude/`.
 *
 * Caller is responsible for ensuring `targetDir` is a real directory — this
 * function creates `.claude/` and the three subdirectories if missing.
 *
 * Throws {@link UnsafeInstallPathError} if any destination is a symlink or
 * would escape the resolved install root. The caller should surface this as a
 * named failure and exit non-zero; do not wrap-and-swallow.
 */
export async function copyArtifacts(
  targetDir: string,
  options: CopyOptions,
): Promise<CopyResult> {
  // Resolve the install root up front — `realpath` so a symlinked targetDir
  // (e.g. `/tmp` on macOS → `/private/tmp`) still produces a correct
  // containment root.
  const resolvedTarget = await fsPromises.realpath(targetDir);
  const claudeDir = path.join(resolvedTarget, '.claude');
  await assertSafeDirectory(resolvedTarget, claudeDir);
  await ensureDir(claudeDir);

  const ctx: WalkContext = { resolvedRoot: resolvedTarget };

  const result: CopyResult = { copied: [], skipped: [], overwritten: [] };
  for (const dir of COPY_DIRS) {
    await walkAndCopy(PKG_ROOT, claudeDir, dir, resolvedTarget, options, result, ctx);
  }
  return result;
}

/**
 * Internal helpers exposed for unit tests only. Not part of the public API —
 * do not import from outside `./copy.test.ts`. Grouped under `__internal` so
 * consumers can grep and stay away.
 */
export const __internal = {
  snapshotAncestors,
  verifyAncestorsUnchanged,
  writeFileExclusiveNoFollow,
} as const;
