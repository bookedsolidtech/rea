/**
 * Minimal LCS-based unified-diff renderer (0.41.0).
 *
 * Used by `rea upgrade --check` to emit a per-file preview of what the
 * upgrade flow WOULD change. We deliberately ship our own implementation
 * rather than pulling in the `diff` npm package — REA's dependency
 * footprint is small and load-bearing, and the upgrade-check preview is
 * the only consumer.
 *
 * Output shape mirrors `diff -u`:
 *
 *     --- a/path/to/file
 *     +++ b/path/to/file
 *     @@ -1,3 +1,4 @@
 *      context line
 *     -removed line
 *     +added line
 *      context line
 *
 * Hunks are constructed greedily — adjacent changed regions within
 * `contextLines` of each other are merged into a single hunk so a
 * reviewer reading the output doesn't have to mentally stitch tiny
 * back-to-back hunks together.
 *
 * Performance: classic O(n*m) LCS with two parallel `Uint32Array`s for
 * the DP table. Files in the upgrade-check path are bounded at
 * `DIFF_SIZE_CAP_BYTES` (256 KiB) by callers, so even the worst-case
 * shape (256 KiB of single-character lines) stays inside the addressable
 * range of `Uint32Array` indices (~4 GiB worth of cells). The caller is
 * responsible for refusing to diff files larger than the cap; this
 * module trusts its inputs.
 *
 * Newline handling: we split on `\n` only. A file with `\r\n` line
 * endings will surface as one big changed block if compared against a
 * `\n`-ending canonical, which is the right behavior — line endings
 * differing IS a real difference. We do not normalize.
 */

const DEFAULT_CONTEXT_LINES = 3;

/**
 * Hard cap on the DP-table cell count. The O(m*n) LCS table is the
 * dominant memory cost; with a 4-byte `Uint32Array` cell, this works
 * out to ~16 MiB of allocation at the cap. We deliberately key off
 * cell COUNT, not file bytes — codex round-1 P1 flagged that the
 * 256 KiB byte cap callers enforce can still produce pathological
 * matrices when files are mostly single-character lines (200 KiB of
 * one-char lines = 200K lines = 40 GiB of cells).
 *
 * Exported so callers can detect the "too large to diff" verdict
 * structurally instead of grepping the returned string.
 */
export const MAX_LCS_CELLS = 4_000_000;

/**
 * Sentinel returned in place of a real diff when the line counts
 * would blow past `MAX_LCS_CELLS`. Wrapped in a recognizable comment
 * shape so consumers grepping the diff body see a clear notice.
 */
export const DIFF_TOO_LARGE_NOTICE =
  '# rea: diff suppressed — file pair too large for the LCS matrix budget\n';

interface DiffOp {
  kind: 'context' | 'add' | 'remove';
  /** Line content, sans trailing newline. */
  text: string;
}

interface Hunk {
  /** 1-based starting line in the OLD file. */
  oldStart: number;
  /** Number of OLD-file lines covered by this hunk (context + removes). */
  oldLines: number;
  /** 1-based starting line in the NEW file. */
  newStart: number;
  /** Number of NEW-file lines covered by this hunk (context + adds). */
  newLines: number;
  /** Hunk body, in unified-diff order. */
  ops: DiffOp[];
}

/**
 * Compute the LCS table for two line arrays. Cell (i, j) is the length
 * of the longest common subsequence of `a[0..i)` and `b[0..j)`.
 *
 * Returns a row-major `Uint32Array` of size `(a.length + 1) * (b.length + 1)`.
 */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array {
  const m = a.length;
  const n = b.length;
  const rowStride = n + 1;
  const table = new Uint32Array((m + 1) * rowStride);
  for (let i = 1; i <= m; i += 1) {
    const rowBase = i * rowStride;
    const prevRowBase = (i - 1) * rowStride;
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        table[rowBase + j] = table[prevRowBase + (j - 1)]! + 1;
      } else {
        const up = table[prevRowBase + j]!;
        const left = table[rowBase + (j - 1)]!;
        table[rowBase + j] = up >= left ? up : left;
      }
    }
  }
  return table;
}

/**
 * Walk the LCS table backwards to produce the ordered diff op sequence.
 */
function backtrackOps(
  a: readonly string[],
  b: readonly string[],
  table: Uint32Array,
): DiffOp[] {
  const ops: DiffOp[] = [];
  const rowStride = b.length + 1;
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'context', text: a[i - 1]! });
      i -= 1;
      j -= 1;
      continue;
    }
    const up = i > 0 ? table[(i - 1) * rowStride + j]! : -1;
    const left = j > 0 ? table[i * rowStride + (j - 1)]! : -1;
    if (j > 0 && (i === 0 || left >= up)) {
      ops.push({ kind: 'add', text: b[j - 1]! });
      j -= 1;
    } else {
      ops.push({ kind: 'remove', text: a[i - 1]! });
      i -= 1;
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Group ops into hunks. A hunk covers a contiguous changed region plus
 * `contextLines` of context on each side. Two adjacent changed regions
 * separated by fewer than `2 * contextLines` context lines are merged
 * into a single hunk (the shared context belongs to both).
 */
function buildHunks(ops: readonly DiffOp[], contextLines: number): Hunk[] {
  // First pass: collect indices of every change op.
  const changedIndices: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]!.kind !== 'context') changedIndices.push(i);
  }
  if (changedIndices.length === 0) return [];

  // Group changed indices into hunk windows. Merge windows whose
  // context-padded ranges overlap or touch.
  interface Window {
    start: number;
    end: number;
  } // half-open: [start, end) on the ops array
  const windows: Window[] = [];
  for (const idx of changedIndices) {
    const winStart = Math.max(0, idx - contextLines);
    const winEnd = Math.min(ops.length, idx + 1 + contextLines);
    const last = windows.length > 0 ? windows[windows.length - 1]! : null;
    if (last !== null && winStart <= last.end) {
      last.end = Math.max(last.end, winEnd);
    } else {
      windows.push({ start: winStart, end: winEnd });
    }
  }

  // Convert windows to hunks with correct old/new line numbers.
  // Track 1-based line cursors as we walk the full ops array.
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let opIdx = 0;
  for (const win of windows) {
    while (opIdx < win.start) {
      const op = ops[opIdx]!;
      if (op.kind === 'context') {
        oldLine += 1;
        newLine += 1;
      } else if (op.kind === 'remove') {
        oldLine += 1;
      } else {
        newLine += 1;
      }
      opIdx += 1;
    }
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    let hunkOldLines = 0;
    let hunkNewLines = 0;
    const hunkOps: DiffOp[] = [];
    while (opIdx < win.end) {
      const op = ops[opIdx]!;
      hunkOps.push(op);
      if (op.kind === 'context') {
        hunkOldLines += 1;
        hunkNewLines += 1;
        oldLine += 1;
        newLine += 1;
      } else if (op.kind === 'remove') {
        hunkOldLines += 1;
        oldLine += 1;
      } else {
        hunkNewLines += 1;
        newLine += 1;
      }
      opIdx += 1;
    }
    hunks.push({
      oldStart: hunkOldStart,
      oldLines: hunkOldLines,
      newStart: hunkNewStart,
      newLines: hunkNewLines,
      ops: hunkOps,
    });
  }
  return hunks;
}

/**
 * Render hunks in unified-diff format. Header lines name the old and new
 * paths via `--- a/<oldPath>` / `+++ b/<newPath>`, the same convention
 * `diff -u` uses.
 *
 * When both files are identical, returns an empty string — the caller
 * decides whether to emit a "no changes" notice.
 */
function renderHunks(
  oldPath: string,
  newPath: string,
  hunks: readonly Hunk[],
): string {
  if (hunks.length === 0) return '';
  const lines: string[] = [];
  lines.push(`--- a/${oldPath}`);
  lines.push(`+++ b/${newPath}`);
  for (const hunk of hunks) {
    // Unified-diff convention: a hunk that contains zero lines on one
    // side renders `0,0` for that side's count. Empty single-line hunks
    // render `N` without a comma (`@@ -5 +5,2 @@`). We always emit the
    // comma form for simplicity — `diff -u` accepts it.
    lines.push(
      `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
    );
    for (const op of hunk.ops) {
      if (op.kind === 'context') lines.push(` ${op.text}`);
      else if (op.kind === 'add') lines.push(`+${op.text}`);
      else lines.push(`-${op.text}`);
    }
  }
  return lines.join('\n') + '\n';
}

export interface UnifiedDiffOptions {
  /** Defaults to `'file'`. Appears after `--- a/` in the header. */
  oldPath?: string;
  /** Defaults to `oldPath`. Appears after `+++ b/` in the header. */
  newPath?: string;
  /** Lines of context around each change. Default 3 — matches `diff -u`. */
  contextLines?: number;
}

/**
 * Compute a unified diff between two text blobs.
 *
 * Returns the empty string when the two inputs are byte-identical. The
 * caller decides whether to wrap that in a "no changes" notice.
 *
 * Splits on `\n` and drops a single trailing `\n` if present so the
 * final line is not phantom-blank. A file that genuinely ends without
 * a newline will appear identical to one that ends with a single
 * newline — REA's canonical files all end with `\n`, so this is fine
 * for our use case. Callers that need strict-EOL fidelity should
 * normalize upstream.
 */
export function diffUnified(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions = {},
): string {
  if (oldText === newText) return '';
  const oldPath = options.oldPath ?? 'file';
  const newPath = options.newPath ?? oldPath;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;

  // Drop one trailing newline so split() doesn't produce a phantom empty
  // line at the end. We compare the trailing-stripped forms; the diff
  // header doesn't track EOL state because callers don't.
  const oldNorm = oldText.endsWith('\n') ? oldText.slice(0, -1) : oldText;
  const newNorm = newText.endsWith('\n') ? newText.slice(0, -1) : newText;
  // Empty file → empty array of lines.
  const oldLines = oldNorm.length === 0 ? [] : oldNorm.split('\n');
  const newLines = newNorm.length === 0 ? [] : newNorm.split('\n');

  // Codex round-1 P1: guard against pathological line-count blowups
  // BEFORE allocating the DP table. Cell count grows as
  // (m+1)*(n+1) — a 200 KiB file of one-character lines is well
  // inside any reasonable byte cap but would allocate gigabytes of
  // Uint32 cells. Return a sentinel comment the caller can detect
  // and surface as "too large to render" instead of OOMing.
  const cellCount = (oldLines.length + 1) * (newLines.length + 1);
  if (cellCount > MAX_LCS_CELLS) {
    return (
      `--- a/${oldPath}\n` +
      `+++ b/${newPath}\n` +
      DIFF_TOO_LARGE_NOTICE
    );
  }
  const table = lcsTable(oldLines, newLines);
  const ops = backtrackOps(oldLines, newLines, table);
  const hunks = buildHunks(ops, contextLines);
  return renderHunks(oldPath, newPath, hunks);
}
