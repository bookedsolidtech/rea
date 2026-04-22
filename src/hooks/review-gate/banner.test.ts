/**
 * Unit tests for `banner.ts`. Closes defect K's regression class (the
 * `0\n0` duplicate-zero render) with explicit coverage of the zero case,
 * the empty-diff case, and the unicode-filename edge.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  computeDiffStats,
  countChangedFiles,
  countChangedLines,
  renderProtectedPathsBlockedBanner,
  renderPushReviewRequiredBanner,
  stripControlChars,
} from './banner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
interface FixtureScenario {
  diff: string;
  expected_key: string;
  expected_line_count_plus_minus: number;
  expected_file_count: number;
}
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/cache-keys.json'), 'utf8'),
) as { scenarios: Record<string, FixtureScenario> };

describe('countChangedLines — defect K regression guard', () => {
  it('returns 0 on the empty string (not empty-string, not "0\\n0")', () => {
    expect(countChangedLines('')).toBe(0);
  });

  it('returns 0 on a diff with only headers', () => {
    const diff = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n';
    expect(countChangedLines(diff)).toBe(0);
  });

  it('counts `+` and `-` content lines but not headers', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n unchanged\n+added\n-removed\n';
    expect(countChangedLines(diff)).toBe(2);
  });

  it('ignores `+++ ` and `--- ` header lines', () => {
    const diff = '+++ b/file\n--- a/file\n+real-add\n-real-remove\n';
    expect(countChangedLines(diff)).toBe(2);
  });

  it('rejects `++foo` and `--bar` (bash-core parity `^\\+[^+]|^-[^-]`)', () => {
    // Codex pass-1 on phase 1 flagged a too-lax earlier implementation that
    // only rejected `+++`/`---`. Bash's regex uses a strict "char-1 is +/-,
    // char-2 is NOT the same" predicate, so `++foo` and `--bar` are BOTH
    // excluded alongside the 3-char header lines.
    const diff = '++foo\n--bar\n+real-add\n-real-remove\n';
    expect(countChangedLines(diff)).toBe(2);
  });

  it('rejects a bare single `+` or `-` line', () => {
    // bash regex requires TWO characters to match (`^\+[^+]` — the second
    // char must be something). A single-char line cannot satisfy that.
    expect(countChangedLines('+\n-\n')).toBe(0);
  });
});

describe('countChangedFiles — defect K regression guard', () => {
  it('returns 0 on empty input', () => {
    expect(countChangedFiles('')).toBe(0);
  });

  it('counts each `+++ ` header as one file', () => {
    const diff = 'diff --git a/a b/a\n+++ b/a\nbody\ndiff --git a/b b/b\n+++ b/b\nbody\n';
    expect(countChangedFiles(diff)).toBe(2);
  });

  it('does not count content lines starting with +++', () => {
    // A content line with `+++ ` is impossible in unified-diff format for
    // lines that aren't the file header. We still handle it correctly.
    const diff = '+++ b/a\n+++ normal line starts with plusses but no space-path\n';
    // The second line has `+++ ` prefix (space included) so by our
    // start-with-`+++ ` rule it counts as a file header. This matches the
    // bash core's `grep -c '^\+\+\+ '` behavior bit-for-bit.
    expect(countChangedFiles(diff)).toBe(2);
  });
});

describe('computeDiffStats — fixture parity', () => {
  for (const [name, scenario] of Object.entries(fixture.scenarios)) {
    it(`matches expected stats for scenario ${name}`, () => {
      const stats = computeDiffStats(scenario.diff);
      expect(stats.line_count).toBe(scenario.expected_line_count_plus_minus);
      expect(stats.file_count).toBe(scenario.expected_file_count);
    });
  }
});

describe('renderPushReviewRequiredBanner', () => {
  it('renders the full banner with cache-enabled hint', () => {
    const out = renderPushReviewRequiredBanner({
      source_ref: 'refs/heads/feature',
      source_sha: 'abcdef0123456789abcdef0123456789abcdef01',
      target_branch: 'main',
      merge_base: '1111111111111111111111111111111111111111',
      stats: { line_count: 42, file_count: 7 },
      push_sha: 'f'.repeat(64),
      source_branch: 'feature',
    });
    expect(out).toContain('PUSH REVIEW GATE: Review required before pushing');
    expect(out).toContain('Source ref: refs/heads/feature (abcdef012345)');
    expect(out).toContain('Target: main');
    expect(out).toContain('Scope: 7 files changed, 42 lines');
    expect(out).toContain('rea cache set');
    expect(out).toContain(`rea cache set ${'f'.repeat(64)} pass`);
    expect(out).not.toContain('Cache is DISABLED');
  });

  it('renders the cache-disabled fallback when push_sha is empty', () => {
    const out = renderPushReviewRequiredBanner({
      source_ref: 'HEAD',
      source_sha: 'a'.repeat(40),
      target_branch: 'main',
      merge_base: 'b'.repeat(40),
      stats: { line_count: 0, file_count: 0 },
      push_sha: '',
      source_branch: 'main',
    });
    expect(out).toContain('Cache is DISABLED on this host');
    expect(out).toContain('REA_SKIP_PUSH_REVIEW="<reason>"');
    expect(out).not.toContain('rea cache set');
  });

  it('never emits a "0\\n0" duplicated zero (defect K)', () => {
    const out = renderPushReviewRequiredBanner({
      source_ref: 'HEAD',
      source_sha: 'a'.repeat(40),
      target_branch: 'main',
      merge_base: 'b'.repeat(40),
      stats: { line_count: 0, file_count: 0 },
      push_sha: 'c'.repeat(64),
      source_branch: 'main',
    });
    expect(out).toMatch(/Scope: 0 files changed, 0 lines/);
    expect(out).not.toMatch(/0\n0/);
  });

  it('truncates source_sha to 12 chars for display', () => {
    const out = renderPushReviewRequiredBanner({
      source_ref: 'refs/heads/f',
      source_sha: '0123456789abcdef0123456789abcdef01234567',
      target_branch: 'main',
      merge_base: 'b'.repeat(40),
      stats: { line_count: 1, file_count: 1 },
      push_sha: 'c'.repeat(64),
      source_branch: 'f',
    });
    expect(out).toContain('(0123456789ab)');
  });
});

describe('renderProtectedPathsBlockedBanner', () => {
  it('includes the source ref + sha + action required text', () => {
    const out = renderProtectedPathsBlockedBanner({
      source_ref: 'refs/heads/feature',
      source_sha: 'a'.repeat(40),
    });
    expect(out).toContain('PUSH BLOCKED: protected paths changed');
    expect(out).toContain('Source ref: refs/heads/feature');
    expect(out).toContain('/codex-review');
    expect(out).toContain('pass');
    expect(out).toContain('concerns');
  });

  it('lists all 7 protected-path prefixes', () => {
    const out = renderProtectedPathsBlockedBanner({
      source_ref: 'HEAD',
      source_sha: 'a'.repeat(40),
    });
    expect(out).toContain('- src/gateway/middleware/');
    expect(out).toContain('- hooks/');
    expect(out).toContain('- .claude/hooks/');
    expect(out).toContain('- src/policy/');
    expect(out).toContain('- .github/workflows/');
    expect(out).toContain('- .rea/');
    expect(out).toContain('- .husky/');
  });
});

describe('stripControlChars — Codex LOW 5 on the 0.9.4 pass', () => {
  it('removes bare ESC (0x1b) / CSI sequences', () => {
    const input = 'normal\x1b[31mred\x1b[0mreset';
    const out = stripControlChars(input);
    expect(out).not.toContain('\x1b');
  });

  it('preserves tab, LF, and CR', () => {
    const input = 'a\tb\nc\rd';
    expect(stripControlChars(input)).toBe(input);
  });

  it('removes C1 bytes (0x80-0x9f) that some terminals honor as CSI introducers', () => {
    const input = 'safe' + String.fromCharCode(0x9b) + 'payload';
    const out = stripControlChars(input);
    expect(out).not.toContain(String.fromCharCode(0x9b));
  });

  it('preserves printable UTF-8 (multi-byte codepoints)', () => {
    const input = 'café 日本 ✓';
    expect(stripControlChars(input)).toBe(input);
  });

  it('removes DEL (0x7f)', () => {
    const input = 'a\x7fb';
    expect(stripControlChars(input)).toBe('ab');
  });
});
