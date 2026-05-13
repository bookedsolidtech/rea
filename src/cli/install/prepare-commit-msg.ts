/**
 * Install the husky `prepare-commit-msg` hook that drives the 0.30.0
 * attribution augmenter.
 *
 * The hook itself is a stable POSIX-sh body sourced from the package's
 * own `.husky/prepare-commit-msg`. `rea init` and `rea upgrade` copy it
 * into `.husky/` and (when `core.hooksPath` is not configured at
 * `.husky`) `.git/hooks/` as the belt-and-suspenders pair — mirroring
 * the `installCommitMsgHook` strategy in `commit-msg.ts`.
 *
 * Foreign-hook conflict pattern: the 0.13.2 prepush prior art applies.
 * If a foreign `prepare-commit-msg` exists (no rea marker, not the husky
 * 9 indirection stub), we REFUSE to overwrite, surface the conflict via
 * `rea doctor`, and recommend the `.husky/prepare-commit-msg.d/<NN>-name`
 * extension-fragment migration path (TODO: wire fragment chaining if
 * consumers demand it; not in 0.30.0 scope).
 *
 * Idempotency: the canonical body carries the `# rea:prepare-commit-msg v1`
 * marker on line 2 and `# rea:augment-body-v1` on line 3. Re-running rea
 * init / upgrade refreshes the file in-place whenever the marker matches;
 * foreign hooks are left alone.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PKG_ROOT, warn } from '../utils.js';
import { isHusky9Stub, resolveHusky9StubTarget } from './pre-push.js';

const execFileAsync = promisify(execFile);

/**
 * Marker baked into every rea-installed prepare-commit-msg hook.
 * Anchored on line 2 (immediately after the shebang) for classification.
 * Bump the version suffix whenever the body semantics change so
 * upgrades migrate cleanly.
 *
 * v1 — 0.30.0: first version of the augmenter hook.
 */
export const PREPARE_COMMIT_MSG_MARKER = '# rea:prepare-commit-msg v1';

/**
 * Body marker anchored on line 3. A foreign hook that carries the
 * header marker as a comment but has an empty body (stubbed by a
 * consumer) will NOT be classified as rea-managed because the body
 * marker won't be on line 3. Both markers together close the
 * classification question.
 */
export const PREPARE_COMMIT_MSG_BODY_MARKER = '# rea:augment-body-v1';

export type PrepareCommitMsgClassification =
  | { kind: 'absent' }
  | { kind: 'rea-managed'; version: string }
  | { kind: 'foreign'; reason: string };

/**
 * Inspect `hookPath` and decide whether it is rea-authored or foreign.
 * Strict: BOTH markers must appear on lines 2 + 3 in order. Substring
 * matches deliberately rejected so a comment quoting the marker doesn't
 * fool the classifier.
 */
export async function classifyPrepareCommitMsgHook(
  hookPath: string,
): Promise<PrepareCommitMsgClassification> {
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(hookPath);
  } catch {
    return { kind: 'absent' };
  }
  if (stat.isDirectory()) return { kind: 'foreign', reason: 'is-directory' };
  if (stat.isSymbolicLink()) return { kind: 'foreign', reason: 'is-symlink' };
  if (!stat.isFile()) return { kind: 'foreign', reason: 'not-regular-file' };

  let content: string;
  try {
    content = await fsPromises.readFile(hookPath, 'utf8');
  } catch (e) {
    return {
      kind: 'foreign',
      reason: `read-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Codex round 2 P2: Husky 9 layout (`core.hooksPath=.husky/_`) auto-
  // generates a stub like `#!/usr/bin/env sh\n. "${0%/*}/h"` at the
  // active hooks path. Git dispatches through that stub to `.husky/
  // prepare-commit-msg` (the canonical body, which IS rea-managed).
  // Treat the stub as a managed pointer — follow the indirection and
  // re-classify against the canonical target. Same pattern as
  // pre-push.ts's husky 9 handling.
  if (isHusky9Stub(content)) {
    const target = resolveHusky9StubTarget(hookPath);
    if (target !== null && target !== hookPath) {
      return classifyPrepareCommitMsgHook(target);
    }
  }

  if (!content.startsWith('#!/bin/sh\n')) {
    return { kind: 'foreign', reason: 'no-marker' };
  }
  const lines = content.split('\n');
  if (lines[1] !== PREPARE_COMMIT_MSG_MARKER || lines[2] !== PREPARE_COMMIT_MSG_BODY_MARKER) {
    return { kind: 'foreign', reason: 'no-marker' };
  }
  return { kind: 'rea-managed', version: 'v1' };
}

/**
 * Read `core.hooksPath` via `git config --get`. Returns `null` when the
 * key is unset. Same execFile (not exec) discipline as the other
 * installers so the target directory cannot interpolate through a
 * shell.
 */
async function readHooksPathFromGit(targetDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', targetDir, 'config', '--get', 'core.hooksPath'],
      { encoding: 'utf8' },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export interface PrepareCommitMsgInstallResult {
  gitHook?: string;
  huskyHook?: string;
  warnings: string[];
  /**
   * When the install is a refresh of an existing rea-managed body, this
   * is true. Useful for upgrade messaging.
   */
  refreshed?: boolean;
  /**
   * When the install was skipped because a foreign hook is present.
   * Surfaced separately so `rea doctor` can render the migration path.
   */
  skippedForeign?: boolean;
}

function sourceHookPath(): string {
  return path.join(PKG_ROOT, '.husky', 'prepare-commit-msg');
}

async function writeExecutable(src: string, dst: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(dst), { recursive: true });
  await fsPromises.copyFile(src, dst);
  await fsPromises.chmod(dst, 0o755);
}

/**
 * Install the prepare-commit-msg hook into the consumer project at
 * `targetDir`. Refuses to stomp foreign hooks; refreshes rea-managed
 * hooks in place. Best-effort: a missing `.husky/` directory simply
 * skips the husky copy (git-hooks copy is sufficient for vanilla git).
 *
 * Foreign-hook conflict (the 0.13.2 pre-push prior art): we never
 * overwrite a non-rea body. The caller surfaces the conflict to the
 * operator; `rea doctor` flags the gap so the operator can decide
 * whether to relocate their existing hook into a fragment, replace it
 * with rea's body, or set `attribution.co_author.enabled: false`.
 */
export async function installPrepareCommitMsgHook(
  targetDir: string,
): Promise<PrepareCommitMsgInstallResult> {
  const result: PrepareCommitMsgInstallResult = { warnings: [] };
  const src = sourceHookPath();
  if (!fs.existsSync(src)) {
    result.warnings.push(`packaged prepare-commit-msg hook missing at ${src}`);
    return result;
  }

  const gitDir = path.join(targetDir, '.git');
  if (!fs.existsSync(gitDir)) {
    result.warnings.push('.git/ not found — skipping prepare-commit-msg install (not a git repo?)');
    return result;
  }

  // Codex round 4 P2: `.git` may be a FILE (linked worktrees, submodules)
  // rather than a directory. `path.join(targetDir, '.git', 'hooks')` then
  // points into a non-existent location and the writeExecutable mkdir
  // throws ENOTDIR. Use `git rev-parse --git-path hooks` to resolve
  // the actual hooks dir regardless of worktree/submodule indirection.
  let hooksDir: string;
  const configuredHooksPath = await readHooksPathFromGit(targetDir);
  if (configuredHooksPath !== null) {
    hooksDir = path.isAbsolute(configuredHooksPath)
      ? configuredHooksPath
      : path.join(targetDir, configuredHooksPath);
    result.warnings.push(
      `git core.hooksPath is set — installing prepare-commit-msg to ${hooksDir}`,
    );
  } else {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', targetDir, 'rev-parse', '--git-path', 'hooks'],
        { encoding: 'utf8' },
      );
      const resolved = stdout.trim();
      hooksDir = path.isAbsolute(resolved) ? resolved : path.join(targetDir, resolved);
    } catch {
      hooksDir = path.join(gitDir, 'hooks');
    }
  }

  const gitHookPath = path.join(hooksDir, 'prepare-commit-msg');
  const gitClassification = await classifyPrepareCommitMsgHook(gitHookPath);
  if (gitClassification.kind === 'foreign') {
    result.warnings.push(
      `foreign prepare-commit-msg at ${gitHookPath} (${gitClassification.reason}) — ` +
        `leaving alone. Either remove it and re-run rea init, or migrate to a ` +
        `fragment under .husky/prepare-commit-msg.d/ (not yet supported in 0.30.0).`,
    );
    result.skippedForeign = true;
  } else {
    await writeExecutable(src, gitHookPath);
    result.gitHook = gitHookPath;
    if (gitClassification.kind === 'rea-managed') {
      result.refreshed = true;
    }
  }

  const huskyDir = path.join(targetDir, '.husky');
  if (fs.existsSync(huskyDir)) {
    const huskyHookPath = path.join(huskyDir, 'prepare-commit-msg');
    const huskyClassification = await classifyPrepareCommitMsgHook(huskyHookPath);
    if (huskyClassification.kind === 'foreign') {
      result.warnings.push(
        `foreign .husky/prepare-commit-msg at ${huskyHookPath} ` +
          `(${huskyClassification.reason}) — leaving alone.`,
      );
      result.skippedForeign = true;
    } else {
      await writeExecutable(src, huskyHookPath);
      result.huskyHook = huskyHookPath;
      if (huskyClassification.kind === 'rea-managed' && result.refreshed !== true) {
        result.refreshed = true;
      }
    }
  } else {
    warn(
      'no .husky/ directory — skipped husky prepare-commit-msg copy ' +
        '(git-hooks copy is sufficient)',
    );
  }

  return result;
}
