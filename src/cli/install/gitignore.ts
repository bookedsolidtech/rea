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
 * writes (under `.rea/` AND its sibling `proper-lockfile` directory at
 * `.rea.lock`) must be in the consumer's `.gitignore`:
 *
 *   - `.rea/audit.jsonl`              — G1 hash-chained audit log (append-only)
 *   - `.rea/audit-*.jsonl`            — G1 rotated audit archives
 *   - `.rea/HALT`                     — /freeze marker (ephemeral)
 *   - `.rea/metrics.jsonl`            — G5 metrics stream
 *   - `.rea/serve.pid`                — G5 `rea serve` pidfile
 *   - `.rea/serve.state.json`         — G5 `rea serve` state snapshot
 *   - `.rea/fingerprints.json`        — G7 downstream catalog fingerprints (BUG-010)
 *   - `.rea/last-review.json`         — 0.11.0 push-gate last-review dump
 *   - `.rea/*.tmp`                    — serve temp-file-then-rename pattern
 *   - `.rea/*.tmp.*`                  — push-gate pid-salted temp pattern
 *   - `.rea/install-manifest.json.bak` / `.tmp` — fs-safe atomic-replace sidecars
 *   - `.gitignore.rea-tmp-*`          — this module's own temp files on crash
 *                                       (root-level — writeAtomic stages next
 *                                       to .gitignore, not under .rea/)
 *   - `.rea.lock`                     — proper-lockfile sibling dir (NOT under .rea/)
 *     (Codex F1 on the BUG-010 review caught all three of these last groups.)
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
 *   Operator DELETIONS of canonical entries are NOT preserved — re-running
 *   ensureReaGitignore will re-insert any canonical entry missing from the
 *   block body. To opt out of ignoring a specific artifact, operators must
 *   configure rea itself, not edit the managed block. This is intentional —
 *   the managed block is rea's territory.
 *
 * Security/containment.
 *
 *   - Refuse to follow a `.gitignore` symlink (`lstat` gate before any read).
 *     The subsequent read uses `O_NOFOLLOW | O_RDONLY` so a TOCTOU swap after
 *     the lstat cannot trick us into reading through a symlink to secrets
 *     (e.g. `~/.ssh/id_rsa`) and splicing them into the written `.gitignore`.
 *   - Temp file name uses `crypto.randomBytes(16)` — not PID + Date.now, which
 *     are predictable and leak process info. (Codex F2.)
 *   - Cleanup best-effort on write failure so a stale temp file from a
 *     prior crash does not accrete.
 *
 * CRLF compatibility (Codex F3).
 *
 *   Windows consumers with `core.autocrlf=true` get CRLF line endings on
 *   `.gitignore`. Without explicit handling, `"# === rea managed ==="` !==
 *   `"# === rea managed ===\r"` and every upgrade would append a duplicate
 *   block. We detect the input EOL on read, split on `\r?\n`, trim trailing
 *   whitespace from each line before marker-anchored matching, and re-emit
 *   with the detected EOL on write.
 *
 * Duplicate blocks (Codex F4).
 *
 *   If the file already contains two managed blocks (from a prior bug,
 *   manual copy-paste, or two different rea versions), refuse to modify and
 *   surface a warning. Merging is more ambitious than this module needs to
 *   be — the operator resolves manually, then a subsequent run proceeds.
 */

import type fs from 'node:fs';
import crypto from 'node:crypto';
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
 *
 * The grouping below is by origin, not alphabetical:
 *   1. audit + HALT + metrics   (G1, G4, G5)
 *   2. serve state              (G5)
 *   3. fingerprints             (G7 / BUG-010)
 *   4. review cache             (BUG-009)
 *   5. temp/sidecar patterns    (Codex F1)
 *   6. sibling lockfile         (Codex F1 — OUTSIDE .rea/)
 */
export const REA_GITIGNORE_ENTRIES: readonly string[] = [
  '.rea/audit.jsonl',
  '.rea/audit-*.jsonl',
  '.rea/HALT',
  '.rea/metrics.jsonl',
  '.rea/serve.pid',
  '.rea/serve.state.json',
  '.rea/fingerprints.json',
  '.rea/last-review.json',
  '.rea/*.tmp',
  '.rea/*.tmp.*',
  '.rea/install-manifest.json.bak',
  '.rea/install-manifest.json.tmp',
  // This module's own crash-time temp files. `writeAtomic` stages the temp
  // next to `.gitignore` (i.e. at the repo root), NOT under `.rea/` — so
  // the glob must live at the repo root too. Codex F2 on the re-review
  // caught the earlier `.rea/.gitignore.rea-tmp-*` mismatch.
  '.gitignore.rea-tmp-*',
  // proper-lockfile (audit chain, cache) locks `.rea/` via a SIBLING dir at
  // `.rea.lock` — NOT inside `.rea/`. If this looks wrong to a future
  // maintainer: it is correct, see src/audit/fs.ts.
  '.rea.lock',
];

export interface EnsureGitignoreResult {
  /** Absolute path to the `.gitignore` file that was (maybe) written. */
  path: string;
  /** `created` = no file before. `updated` = block added or amended. `unchanged` = no-op. */
  action: 'created' | 'updated' | 'unchanged';
  /** Entries the caller added this run (subset of `REA_GITIGNORE_ENTRIES`). */
  addedEntries: string[];
  /** Non-fatal operator-facing messages (e.g. symlink refused, duplicate blocks). */
  warnings: string[];
}

function buildManagedBlock(entries: readonly string[], eol: string): string {
  return [GITIGNORE_BLOCK_START, ...entries, GITIGNORE_BLOCK_END].join(eol);
}

/**
 * Trim trailing whitespace ONLY (not leading) and strip a leading UTF-8 BOM.
 * Leading whitespace would defeat the substring-spoof-rejection guarantee
 * the tests exercise (`## === rea managed ===` must NOT match).
 */
function normalizeLineForMatch(line: string, isFirst: boolean): string {
  const noBom = isFirst ? line.replace(/^\uFEFF/, '') : line;
  return noBom.replace(/\s+$/, '');
}

/**
 * Find the managed block by ANCHORED marker lines — substring matches are
 * rejected. A consumer comment containing the sentinel string must not
 * reclassify an arbitrary block as rea-managed.
 *
 * Returns `null` if the start or end marker is not present, or if the start
 * appears after the end (mangled block — caller falls back to append).
 *
 * Returns `'duplicate'` if more than one start marker or more than one end
 * marker is found — caller refuses to modify in that case.
 */
function findManagedBlock(
  lines: readonly string[],
): { startIdx: number; endIdx: number } | null | 'duplicate' {
  const startIndices: number[] = [];
  const endIndices: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const norm = normalizeLineForMatch(lines[i]!, i === 0);
    if (norm === GITIGNORE_BLOCK_START) startIndices.push(i);
    else if (norm === GITIGNORE_BLOCK_END) endIndices.push(i);
  }
  if (startIndices.length === 0 || endIndices.length === 0) return null;
  if (startIndices.length > 1 || endIndices.length > 1) return 'duplicate';
  const [startIdx] = startIndices as [number];
  const [endIdx] = endIndices as [number];
  if (endIdx <= startIdx) return null;
  return { startIdx, endIdx };
}

/**
 * Ensure every required entry is present in the managed block. Preserves any
 * operator-authored lines between the markers (e.g. a consumer adds
 * `.rea/my-local-cache` to the block directly — we leave it alone). Missing
 * required entries are appended in the canonical order, after the existing
 * body lines.
 *
 * NOTE: operator deletions of canonical entries are NOT preserved — see the
 * module docstring.
 */
function reconcileBlock(
  bodyLines: readonly string[],
  required: readonly string[],
): { lines: string[]; added: string[] } {
  const present = new Set(
    bodyLines.map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0),
  );
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
 * Open `.gitignore` via `O_NOFOLLOW | O_RDONLY` so a symlink that appeared
 * after our `lstat` (TOCTOU window) cannot be followed. Darwin/Linux map
 * `O_NOFOLLOW` to `ELOOP`; we translate that to the same symlink-refusal
 * message the lstat path would produce.
 *
 * Returns `null` when the file does not exist.
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
  // O_NOFOLLOW closes the TOCTOU window between lstat and open on POSIX.
  // On Windows O_NOFOLLOW is not defined — refuse to edit an existing
  // `.gitignore` there rather than silently accept the TOCTOU hole.
  // (Codex F1 on the bc2b77b re-review.) Consumers who still have a
  // regular file get the lstat-only protection below; operators who end
  // up with a symlinked .gitignore get a refusal rather than a splice.
  const O_NOFOLLOW = fsPromises.constants?.O_NOFOLLOW;
  const O_RDONLY = fsPromises.constants?.O_RDONLY;
  if (O_NOFOLLOW === undefined || O_RDONLY === undefined) {
    throw new Error(
      `${absPath} exists and this platform lacks O_NOFOLLOW — refusing to edit ` +
        `an existing .gitignore without symlink-race protection. Delete the ` +
        `file first if rea should scaffold a fresh one.`,
    );
  }
  const fd = await fsPromises
    .open(absPath, O_RDONLY | O_NOFOLLOW)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ELOOP') {
        throw new Error(
          `${absPath} became a symlink between lstat and open — refusing to read.`,
        );
      }
      throw err;
    });
  try {
    return await fd.readFile('utf8');
  } finally {
    await fd.close();
  }
}

/**
 * Write `.gitignore` with a temp-file + rename, same pattern as the cache
 * atomic-clear (F4). Avoids torn reads for any tool (IDE, `rea doctor`)
 * racing this write.
 *
 * Temp-name uses `crypto.randomBytes(16)` (not PID/timestamp) — Codex F2
 * flagged the old name as predictable, which gave a local attacker a way
 * to pre-create the path and block the write (or place a FIFO on it).
 */
async function writeAtomic(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  const rand = crypto.randomBytes(16).toString('hex');
  const tmp = path.join(dir, `.gitignore.rea-tmp-${rand}`);
  try {
    await fsPromises.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
    await fsPromises.rename(tmp, absPath);
  } catch (err) {
    await fsPromises.unlink(tmp).catch(() => {
      // Best-effort cleanup. If rename failed the tmp exists; if writeFile
      // failed before anything landed, unlink fails with ENOENT — either way
      // we don't want the original error masked.
    });
    throw err;
  }
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

  // Detect EOL so a CRLF repo stays CRLF and doesn't get torn. Codex F3.
  const eol = existing !== null && existing.includes('\r\n') ? '\r\n' : '\n';

  if (existing === null) {
    const content = buildManagedBlock(entries, '\n') + '\n';
    await writeAtomic(absPath, content);
    return {
      path: absPath,
      action: 'created',
      addedEntries: [...entries],
      warnings,
    };
  }

  const lines = existing.split(/\r?\n/);
  const hadTrailingNewline = existing.endsWith('\n');

  const block = findManagedBlock(lines);

  if (block === 'duplicate') {
    warnings.push(
      `${absPath} contains multiple '# === rea managed' blocks — refusing to modify. ` +
        `Consolidate the managed blocks manually and rerun.`,
    );
    return { path: absPath, action: 'unchanged', addedEntries: [], warnings };
  }

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
      buildManagedBlock(entries, eol),
    ];
    const content = newLines.join(eol) + eol;
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
  let content = newLines.join(eol);
  if (hadTrailingNewline && !content.endsWith(eol)) content += eol;
  await writeAtomic(absPath, content);
  return {
    path: absPath,
    action: 'updated',
    addedEntries: added,
    warnings,
  };
}
