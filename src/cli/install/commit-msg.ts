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

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { PKG_ROOT, warn } from '../utils.js';

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
  let hooksDir = path.join(gitDir, 'hooks');
  try {
    // Read .git/config naively — we only care about `hooksPath` and only when
    // it's literally set, which is rare in practice.
    const cfgPath = path.join(gitDir, 'config');
    if (fs.existsSync(cfgPath)) {
      const cfg = fs.readFileSync(cfgPath, 'utf8');
      const match = cfg.match(/^\s*hooksPath\s*=\s*(.+)\s*$/m);
      if (match?.[1]) {
        const raw = match[1].trim();
        hooksDir = path.isAbsolute(raw) ? raw : path.join(targetDir, raw);
        result.warnings.push(`git core.hooksPath is set — installing to ${hooksDir}`);
      }
    }
  } catch {
    // Non-fatal — fall back to the default path.
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
