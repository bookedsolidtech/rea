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

async function walkAndCopy(
  sourceRoot: string,
  destRoot: string,
  dirName: CopyDir,
  targetDir: string,
  options: CopyOptions,
  result: CopyResult,
): Promise<void> {
  const src = path.join(sourceRoot, dirName);
  const dst = path.join(destRoot, dirName);
  if (!fs.existsSync(src)) {
    warn(`packaged directory missing: ${src} — skipping ${dirName} copy`);
    return;
  }
  await ensureDir(dst);

  const entries = await fsPromises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    const relPath = relClaude(targetDir, dstPath);

    if (entry.isDirectory()) {
      // Recurse into subdirectories (e.g. hooks/_lib/).
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
        await copyOne(subSrc, subDst, relClaude(targetDir, subDst), dirName, options, result);
      }
      continue;
    }
    await copyOne(srcPath, dstPath, relPath, dirName, options, result);
  }
}

async function copyOne(
  srcPath: string,
  dstPath: string,
  relPath: string,
  dirName: CopyDir,
  options: CopyOptions,
  result: CopyResult,
): Promise<void> {
  const exists = fs.existsSync(dstPath);
  if (exists) {
    const decision = await decideConflict(relPath, options);
    if (decision === 'skip') {
      result.skipped.push(relPath);
      return;
    }
    await fsPromises.copyFile(srcPath, dstPath);
    if (dirName === 'hooks') await fsPromises.chmod(dstPath, 0o755);
    result.overwritten.push(relPath);
    return;
  }
  await fsPromises.copyFile(srcPath, dstPath);
  if (dirName === 'hooks') await fsPromises.chmod(dstPath, 0o755);
  result.copied.push(relPath);
}

/**
 * Copy hooks/commands/agents from the package root into `${targetDir}/.claude/`.
 *
 * Caller is responsible for ensuring `targetDir` is a real directory — this
 * function creates `.claude/` and the three subdirectories if missing.
 */
export async function copyArtifacts(
  targetDir: string,
  options: CopyOptions,
): Promise<CopyResult> {
  const claudeDir = path.join(targetDir, '.claude');
  await ensureDir(claudeDir);

  const result: CopyResult = { copied: [], skipped: [], overwritten: [] };
  for (const dir of COPY_DIRS) {
    await walkAndCopy(PKG_ROOT, claudeDir, dir, targetDir, options, result);
  }
  return result;
}
