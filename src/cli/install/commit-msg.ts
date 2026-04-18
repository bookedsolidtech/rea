/**
 * Install the commit-msg hook that enforces `block_ai_attribution`.
 *
 * Strategy: belt-and-suspenders.
 *
 *   1. Always write `.git/hooks/commit-msg` (the "belt") — every git commit
 *      in this repo will hit it, no matter what frontend the consumer uses.
 *   2. If `.husky/` exists (husky is installed), also write `.husky/commit-msg`
 *      (the "suspenders") — this is what husky-based projects see in their
 *      source tree and will share with collaborators.
 *
 * The hook itself is sourced from the packaged `.husky/commit-msg` so there is
 * exactly one version of truth. `package.json#files[]` includes `.husky/` so
 * the file ships to npm.
 *
 * The hook is a no-op when `block_ai_attribution` is not set to `true` in
 * `.rea/policy.yaml`, so it is safe to install unconditionally — see the
 * header of `.husky/commit-msg` for the opt-in check.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PKG_ROOT, warn } from '../utils.js';

const execFileAsync = promisify(execFile);

/**
 * Read `core.hooksPath` via `git config --get`. This is the only correct way
 * to consult git config: regex-matching `.git/config` (finding #9) is
 * section-blind and matches `hooksPath = …` inside `[worktree]`, `[alias]`,
 * `[includeIf]`, or conditional include files — any of which would aim the
 * installer at the wrong directory.
 *
 * We use `execFile` (not `exec`) so there is no shell interpolation of the
 * target directory. Returns `null` if the key is unset (git exits non-zero),
 * or if git itself isn't on PATH.
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
    // Non-zero exit (key not set) or git missing from PATH. Either way we fall
    // back to the default `.git/hooks/`.
    return null;
  }
}

export interface CommitMsgInstallResult {
  gitHook?: string;
  huskyHook?: string;
  warnings: string[];
}

function sourceHookPath(): string {
  return path.join(PKG_ROOT, '.husky', 'commit-msg');
}

async function writeExecutable(src: string, dst: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(dst), { recursive: true });
  await fsPromises.copyFile(src, dst);
  await fsPromises.chmod(dst, 0o755);
}

/**
 * Install the commit-msg hook into the consumer project at `targetDir`.
 * Requires `targetDir/.git` to exist (not a bare clone). The husky copy is
 * best-effort and only runs if `.husky/` is already a directory.
 */
export async function installCommitMsgHook(
  targetDir: string,
): Promise<CommitMsgInstallResult> {
  const result: CommitMsgInstallResult = { warnings: [] };
  const src = sourceHookPath();
  if (!fs.existsSync(src)) {
    result.warnings.push(`packaged commit-msg hook missing at ${src}`);
    return result;
  }

  const gitDir = path.join(targetDir, '.git');
  if (!fs.existsSync(gitDir)) {
    result.warnings.push('.git/ not found — skipping commit-msg install (not a git repo?)');
    return result;
  }

  // Determine the true hooks directory; respect core.hooksPath when set.
  // We defer to `git config --get` rather than regex-matching `.git/config`
  // so that section-scoped keys (`[worktree]`, `[alias]`, `[includeIf]`,
  // `[include]` files) are resolved the way git itself resolves them. Any
  // other approach (finding #9) is section-blind.
  let hooksDir = path.join(gitDir, 'hooks');
  const configuredHooksPath = await readHooksPathFromGit(targetDir);
  if (configuredHooksPath !== null) {
    hooksDir = path.isAbsolute(configuredHooksPath)
      ? configuredHooksPath
      : path.join(targetDir, configuredHooksPath);
    result.warnings.push(`git core.hooksPath is set — installing to ${hooksDir}`);
  }

  const gitHookPath = path.join(hooksDir, 'commit-msg');
  await writeExecutable(src, gitHookPath);
  result.gitHook = gitHookPath;

  const huskyDir = path.join(targetDir, '.husky');
  if (fs.existsSync(huskyDir)) {
    const huskyHookPath = path.join(huskyDir, 'commit-msg');
    await writeExecutable(src, huskyHookPath);
    result.huskyHook = huskyHookPath;
  } else {
    // Not a warning — husky is optional. Just note the state for logging.
    warn('no .husky/ directory — skipped husky commit-msg copy (git-hooks copy is sufficient)');
  }

  return result;
}
