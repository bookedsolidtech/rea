/**
 * BUG-010 — `.gitignore` scaffolding for rea-managed runtime artifacts.
 *
 * Background. `rea serve` (G7 catalog fingerprint) writes
 * `.rea/fingerprints.json` at startup. `rea init` in 0.4.0 and earlier never
 * scaffolded ANY `.gitignore` entries for the consumer repo, so an operator
 * who ran `rea init` then started the gateway would see a "new file" in
 * `git status` that nobody told them about. Helix reported this as BUG-010.
 *
 * The fix is broader than fingerprints.json — every runtime artifact rea
 * writes under `.rea/` must be in the consumer's `.gitignore`:
 *
 *   - `.rea/audit.jsonl`          — G1 hash-chained audit log (append-only)
 *   - `.rea/audit-*.jsonl`        — G1 rotated audit archives
 *   - `.rea/HALT`                 — /freeze marker (ephemeral)
 *   - `.rea/metrics.jsonl`        — G5 metrics stream
 *   - `.rea/serve.pid`            — G5 `rea serve` pidfile
 *   - `.rea/serve.state.json`     — G5 `rea serve` state snapshot
 *   - `.rea/fingerprints.json`    — G7 downstream catalog fingerprints (BUG-010)
 *   - `.rea/review-cache.jsonl`   — BUG-009 review cache (rea cache set/check)
 *
 * Idempotency contract.
 *
 *   - `rea init` on a fresh repo with no `.gitignore` → create one with the
 *     managed block only.
 *   - `rea init` on a repo with a `.gitignore` that has NO rea block → append
 *     a managed block separated by a blank line.
 *   - `rea upgrade` on an older install whose `.gitignore` lacks the block →
 *     same as init; backfill the block so `fingerprints.json` stops showing
 *     up as an untracked file.
 *   - `rea upgrade` where the managed block exists but is missing some new
 *     entries (e.g. `fingerprints.json`, `review-cache.jsonl` added in 0.5.0)
 *     → insert the missing lines inside the existing block, preserving any
 *     operator-authored lines within the block.
 *   - All entries already present, in any order → no-op.
 *
 * Security/containment. This helper writes ONLY `.gitignore` at the root of
 * the resolved install target. No symlink traversal: we refuse to follow a
 * `.gitignore` that is a symlink (avoids writing through a link to
 * `/etc/shadow`). Content is bounded (managed block is small), so we use a
 * straightforward read/append model rather than the full `safeInstallFile`
 * apparatus — but we still resolve via `realpath` and re-verify containment
 * at write time, matching the rest of the install-side defenses.
 */

import type fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

const GITIGNORE = '.gitignore';

export const GITIGNORE_BLOCK_START = '# === rea managed — do not edit between markers ===';
export const GITIGNORE_BLOCK_END = '# === end rea managed ===';

/**
 * Ordered list of entries every rea install must gitignore. Order is stable
 * so the scaffolded block is deterministic across runs, which in turn makes
 * drift detection tractable: a diff in the managed block means a consumer
 * (or another installer) edited it, not that rea reshuffled.
 */
export const REA_GITIGNORE_ENTRIES: readonly string[] = [
  '.rea/audit.jsonl',
  '.rea/audit-*.jsonl',
  '.rea/HALT',
  '.rea/metrics.jsonl',
  '.rea/serve.pid',
  '.rea/serve.state.json',
  '.rea/fingerprints.json',
  '.rea/review-cache.jsonl',
];

export interface EnsureGitignoreResult {
  /** Absolute path to the `.gitignore` file that was (maybe) written. */
  path: string;
  /** `created` = no file before. `updated` = block added or amended. `unchanged` = no-op. */
  action: 'created' | 'updated' | 'unchanged';
  /** Entries the caller added this run (subset of `REA_GITIGNORE_ENTRIES`). */
  addedEntries: string[];
  /** Non-fatal operator-facing messages (e.g. "`.gitignore` is a symlink — skipped"). */
  warnings: string[];
}

function buildManagedBlock(entries: readonly string[]): string {
  return [GITIGNORE_BLOCK_START, ...entries, GITIGNORE_BLOCK_END].join('\n');
}

/**
 * Find the managed block by ANCHORED marker lines — substring matches are
 * rejected. A consumer comment containing the sentinel string must not
 * reclassify an arbitrary block as rea-managed.
 *
 * Returns `null` if the start or end marker is not present, or if the start
 * appears after the end (mangled block — caller falls back to append).
 */
function findManagedBlock(
  lines: readonly string[],
): { startIdx: number; endIdx: number } | null {
  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (startIdx === -1 && lines[i] === GITIGNORE_BLOCK_START) {
      startIdx = i;
    } else if (startIdx !== -1 && lines[i] === GITIGNORE_BLOCK_END) {
      endIdx = i;
      break;
    }
  }
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  return { startIdx, endIdx };
}

/**
 * Ensure every required entry is present in the managed block. Preserves any
 * operator-authored lines between the markers (e.g. a consumer adds
 * `.rea/my-local-cache` to the block directly — we leave it alone). Missing
 * required entries are appended in the canonical order, after the existing
 * body lines.
 */
function reconcileBlock(
  bodyLines: readonly string[],
  required: readonly string[],
): { lines: string[]; added: string[] } {
  const present = new Set(bodyLines.map((l) => l.trim()).filter((l) => l.length > 0));
  const added: string[] = [];
  const appended: string[] = [];
  for (const entry of required) {
    if (!present.has(entry)) {
      appended.push(entry);
      added.push(entry);
    }
  }
  return { lines: [...bodyLines, ...appended], added };
}

/**
 * Read `.gitignore` if it exists. Refuses symlinks — attempting to follow one
 * during an install-time write is a supply-chain hazard we pay a small
 * ergonomic cost to prevent. Returns `null` when absent; throws only on
 * unexpected I/O errors or symlink refusal.
 */
async function readGitignoreIfFile(absPath: string): Promise<string | null> {
  let lst: fs.Stats;
  try {
    lst = await fsPromises.lstat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (lst.isSymbolicLink()) {
    throw new Error(
      `${absPath} is a symlink — refusing to edit .gitignore through a link. ` +
        `Replace the link with a regular file and rerun.`,
    );
  }
  if (!lst.isFile()) {
    throw new Error(
      `${absPath} is not a regular file (type=${String(lst.mode & 0o170000)}) — refusing to edit.`,
    );
  }
  return fsPromises.readFile(absPath, 'utf8');
}

/**
 * Write `.gitignore` with a temp-file + rename, same pattern as the cache
 * atomic-clear (F4). Avoids torn reads for any tool (IDE, `rea doctor`)
 * racing this write.
 */
async function writeAtomic(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.gitignore.rea-tmp-${process.pid}-${Date.now()}`);
  await fsPromises.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
  await fsPromises.rename(tmp, absPath);
}

/**
 * Main entry point. Idempotent: calling twice in a row produces `unchanged`
 * on the second call.
 *
 * The `entries` parameter defaults to `REA_GITIGNORE_ENTRIES` — both `rea
 * init` and `rea upgrade` pass the default. Tests override to verify
 * reconciliation.
 */
export async function ensureReaGitignore(
  targetDir: string,
  entries: readonly string[] = REA_GITIGNORE_ENTRIES,
): Promise<EnsureGitignoreResult> {
  const absPath = path.resolve(targetDir, GITIGNORE);
  const warnings: string[] = [];

  let existing: string | null;
  try {
    existing = await readGitignoreIfFile(absPath);
  } catch (err) {
    warnings.push((err as Error).message);
    return { path: absPath, action: 'unchanged', addedEntries: [], warnings };
  }

  if (existing === null) {
    const content = buildManagedBlock(entries) + '\n';
    await writeAtomic(absPath, content);
    return {
      path: absPath,
      action: 'created',
      addedEntries: [...entries],
      warnings,
    };
  }

  const lines = existing.split('\n');
  // `split('\n')` on content ending in `\n` yields a trailing empty string.
  // Preserve it so we can reconstruct identical-trailing-newline content
  // when no changes are needed.
  const hadTrailingNewline = existing.endsWith('\n');

  const block = findManagedBlock(lines);

  if (block === null) {
    // No managed block. Append one after a blank-line separator (unless the
    // file is empty or already ends with a blank line).
    const trimmedTailIdx = (() => {
      let i = lines.length - 1;
      while (i >= 0 && lines[i] === '') i -= 1;
      return i;
    })();
    const bodyLines = lines.slice(0, trimmedTailIdx + 1);
    const separator = bodyLines.length === 0 ? [] : [''];
    const newLines = [
      ...bodyLines,
      ...separator,
      buildManagedBlock(entries),
    ];
    const content = newLines.join('\n') + '\n';
    await writeAtomic(absPath, content);
    return {
      path: absPath,
      action: 'updated',
      addedEntries: [...entries],
      warnings,
    };
  }

  // Managed block exists — reconcile body lines.
  const bodyLines = lines.slice(block.startIdx + 1, block.endIdx);
  const { lines: reconciledBody, added } = reconcileBlock(bodyLines, entries);

  if (added.length === 0) {
    return {
      path: absPath,
      action: 'unchanged',
      addedEntries: [],
      warnings,
    };
  }

  const newLines = [
    ...lines.slice(0, block.startIdx + 1),
    ...reconciledBody,
    ...lines.slice(block.endIdx),
  ];
  const content = newLines.join('\n') + (hadTrailingNewline ? '' : '\n');
  // `lines.join('\n')` already restores the internal newlines; if the file
  // had a trailing newline the split left an empty string at the end and
  // the join restores it naturally. We ensure EOL newline regardless.
  const finalContent = content.endsWith('\n') ? content : content + '\n';
  await writeAtomic(absPath, finalContent);
  return {
    path: absPath,
    action: 'updated',
    addedEntries: added,
    warnings,
  };
}
