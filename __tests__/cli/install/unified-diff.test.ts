/**
 * Unit tests for the unified-diff helper used by `rea upgrade --check`
 * (0.41.0). The helper is small and tightly scoped — these tests pin
 * the LCS edge cases (identical, full add, full remove, mixed
 * interleave), the hunk header math, the multi-hunk merge behavior,
 * and trailing-newline normalization.
 */

import { describe, expect, it } from 'vitest';
import {
  diffUnified,
  DIFF_TOO_LARGE_NOTICE,
  MAX_LCS_CELLS,
} from '../../../src/cli/install/unified-diff.js';

describe('diffUnified — base cases', () => {
  it('returns empty string for byte-identical inputs', () => {
    expect(diffUnified('alpha\nbeta\n', 'alpha\nbeta\n')).toBe('');
  });

  it('treats only-trailing-newline differences as identical', () => {
    expect(diffUnified('alpha\nbeta\n', 'alpha\nbeta')).toBe('');
  });

  it('returns empty for empty-vs-empty', () => {
    expect(diffUnified('', '')).toBe('');
  });

  it('formats full-add as a single hunk of additions', () => {
    const result = diffUnified('', 'one\ntwo\n', {
      oldPath: 'foo.txt',
      newPath: 'foo.txt',
    });
    expect(result).toContain('--- a/foo.txt\n');
    expect(result).toContain('+++ b/foo.txt\n');
    expect(result).toContain('@@ -1,0 +1,2 @@\n');
    expect(result).toContain('+one\n');
    expect(result).toContain('+two\n');
  });

  it('formats full-remove as a single hunk of removals', () => {
    const result = diffUnified('one\ntwo\n', '', {
      oldPath: 'foo.txt',
      newPath: 'foo.txt',
    });
    expect(result).toContain('@@ -1,2 +1,0 @@\n');
    expect(result).toContain('-one\n');
    expect(result).toContain('-two\n');
  });
});

describe('diffUnified — context windows', () => {
  it('emits 3 lines of context around a single change by default', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const newText = ['a', 'b', 'c', 'D', 'e', 'f', 'g'].join('\n');
    const result = diffUnified(oldText, newText);
    // 3 lines context before + 1 removed + 1 added + 3 lines context after
    expect(result).toContain(' a\n b\n c\n-d\n+D\n e\n f\n g\n');
  });

  it('respects custom contextLines', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const newText = ['a', 'b', 'c', 'D', 'e', 'f', 'g'].join('\n');
    const result = diffUnified(oldText, newText, { contextLines: 1 });
    // 1 context before + change + 1 context after. 'd' is on line 4
    // (1-indexed); contextLines=1 → window covers lines 3..5.
    expect(result).toMatch(/@@ -3,3 \+3,3 @@\n c\n-d\n\+D\n e\n/);
  });

  it('merges adjacent change regions whose context windows overlap', () => {
    // Two changes 3 lines apart with default contextLines=3 → one hunk.
    const oldText = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
    const newText = ['1', 'TWO', '3', '4', '5', '6', '7', 'EIGHT', '9'].join('\n');
    const result = diffUnified(oldText, newText);
    // Exactly one `@@` header → merged into one hunk.
    const hunkHeaders = result.match(/^@@ /gm);
    expect(hunkHeaders).toHaveLength(1);
  });

  it('splits non-adjacent changes into separate hunks', () => {
    const oldText = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    // Change line 1 and line 25 — well outside contextLines=3 of each
    // other.
    const newLines = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`);
    newLines[0] = 'LINE 1';
    newLines[24] = 'LINE 25';
    const newText = newLines.join('\n');
    const result = diffUnified(oldText, newText);
    const hunkHeaders = result.match(/^@@ /gm);
    expect(hunkHeaders).toHaveLength(2);
  });
});

describe('diffUnified — hunk header math', () => {
  it('produces correct line counts for a balanced edit', () => {
    const oldText = ['a', 'b', 'c'].join('\n');
    const newText = ['a', 'X', 'c'].join('\n');
    const result = diffUnified(oldText, newText);
    expect(result).toContain('@@ -1,3 +1,3 @@\n');
  });

  it('produces correct line counts for an asymmetric edit', () => {
    const oldText = ['a', 'b', 'c'].join('\n');
    const newText = ['a', 'X', 'Y', 'Z', 'c'].join('\n');
    const result = diffUnified(oldText, newText);
    // Old: 3 lines covered (a, b, c). New: 5 lines covered (a, X, Y, Z, c).
    expect(result).toContain('@@ -1,3 +1,5 @@\n');
  });
});

describe('diffUnified — header naming', () => {
  it('defaults old/new path to "file"', () => {
    const result = diffUnified('a', 'b');
    expect(result).toContain('--- a/file\n');
    expect(result).toContain('+++ b/file\n');
  });

  it('respects explicit oldPath / newPath', () => {
    const result = diffUnified('a', 'b', { oldPath: 'src/foo.ts', newPath: 'src/foo.ts' });
    expect(result).toContain('--- a/src/foo.ts\n');
    expect(result).toContain('+++ b/src/foo.ts\n');
  });

  it('falls back to oldPath when only oldPath is supplied', () => {
    const result = diffUnified('a', 'b', { oldPath: 'lone.txt' });
    expect(result).toContain('--- a/lone.txt\n');
    expect(result).toContain('+++ b/lone.txt\n');
  });
});

describe('diffUnified — line-count overflow guard (codex round-1 P1)', () => {
  it('returns the DIFF_TOO_LARGE_NOTICE sentinel when cell count would exceed MAX_LCS_CELLS', () => {
    // Construct two inputs whose line product exceeds the cap. We
    // pick lineCount such that (lineCount+1)^2 > MAX_LCS_CELLS.
    // sqrt(MAX_LCS_CELLS) ≈ 2000; use 2200 short lines.
    const lineCount = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 200;
    const oldText = Array.from({ length: lineCount }, (_, i) => `a${String(i)}`).join('\n');
    const newText = Array.from({ length: lineCount }, (_, i) => `b${String(i)}`).join('\n');
    const result = diffUnified(oldText, newText, { oldPath: 'big.txt', newPath: 'big.txt' });
    expect(result).toContain('--- a/big.txt');
    expect(result).toContain('+++ b/big.txt');
    expect(result).toContain(DIFF_TOO_LARGE_NOTICE.trim());
  });

  it('does NOT trigger the guard for inputs within budget', () => {
    const oldText = Array.from({ length: 100 }, (_, i) => `old ${String(i)}`).join('\n');
    const newText = Array.from({ length: 100 }, (_, i) => `new ${String(i)}`).join('\n');
    const result = diffUnified(oldText, newText);
    expect(result).not.toContain(DIFF_TOO_LARGE_NOTICE.trim());
    expect(result).toContain('-old 0');
    expect(result).toContain('+new 0');
  });
});

describe('diffUnified — newline / EOL handling', () => {
  it('does not normalize CRLF — line-ending differences ARE differences', () => {
    const result = diffUnified('alpha\r\nbeta\r\n', 'alpha\nbeta\n');
    // Both reduce to ['alpha\r', 'beta\r'] vs ['alpha', 'beta'] →
    // every line shows up as changed.
    expect(result).not.toBe('');
    expect(result).toContain('-alpha\r');
    expect(result).toContain('+alpha');
  });
});
