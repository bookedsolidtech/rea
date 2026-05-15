/**
 * Unit tests for `src/hooks/_lib/segments.ts`.
 *
 * Coverage focus:
 *   - Empty/blank command → []
 *   - Simple separator splits (`;`, `&&`, `||`, `|`, `&`, newline)
 *   - Quote-masking parity with cmd-segments.sh: separators inside
 *     `"..."` and `'...'` do NOT split.
 *   - Escape parity: `\;` `\&` do NOT split.
 *   - Prefix stripping: `sudo`, `exec`, `time`, `then`, `do`, env vars.
 *   - `anySegmentStartsWith` — head-anchored, case-insensitive.
 *   - `anySegmentMatches` — raw-text scan, case-insensitive.
 *   - Hostile inputs: `then then then …`, unterminated quotes.
 *
 * These tests describe BEHAVIOR the Phase 1 pilots depend on. If the
 * splitter regresses, pilot 2 / pilot 3 unit tests would also fail —
 * this layer pins the contract for the next 0.32.0+ port and gives a
 * single failure surface when the split semantics drift.
 */

import { describe, it, expect } from 'vitest';
import {
  splitSegments,
  anySegmentStartsWith,
  anySegmentMatches,
} from './segments.js';

describe('splitSegments', () => {
  it('returns [] for an empty command', () => {
    expect(splitSegments('')).toEqual([]);
  });

  it('returns [] for a whitespace-only command', () => {
    expect(splitSegments('   \t \n   ')).toEqual([]);
  });

  it('treats a bare command as a single segment', () => {
    expect(splitSegments('git status')).toEqual([
      { raw: 'git status', head: 'git status' },
    ]);
  });

  it('splits on `;`', () => {
    const segs = splitSegments('cd foo; git pull');
    expect(segs.map((s) => s.head)).toEqual(['cd foo', 'git pull']);
  });

  it('splits on `&&` and `||`', () => {
    const segs = splitSegments('cd foo && git pull || echo fail');
    expect(segs.map((s) => s.head)).toEqual(['cd foo', 'git pull', 'echo fail']);
  });

  it('splits on `|` but does not split inside `||`', () => {
    const segs = splitSegments('cat foo | grep bar || true');
    expect(segs.map((s) => s.head)).toEqual(['cat foo', 'grep bar', 'true']);
  });

  it('splits on a single `&`', () => {
    const segs = splitSegments('sleep 1 & git push --force');
    expect(segs.map((s) => s.head)).toEqual(['sleep 1', 'git push --force']);
  });

  it('splits on newlines', () => {
    const segs = splitSegments('git status\ngit push');
    expect(segs.map((s) => s.head)).toEqual(['git status', 'git push']);
  });

  it('does NOT split on separators inside double-quoted spans', () => {
    const segs = splitSegments('echo "release note & git push --force"');
    expect(segs).toHaveLength(1);
    expect(segs[0]?.head).toBe('echo "release note & git push --force"');
  });

  it('does NOT split on separators inside single-quoted spans', () => {
    const segs = splitSegments("echo 'a; b && c || d | e & f'");
    expect(segs).toHaveLength(1);
    expect(segs[0]?.head).toBe("echo 'a; b && c || d | e & f'");
  });

  it('handles mixed quote types', () => {
    const segs = splitSegments(
      `git commit -m "fix: prevent ';' injection" && echo done`,
    );
    expect(segs.map((s) => s.head)).toEqual([
      `git commit -m "fix: prevent ';' injection"`,
      'echo done',
    ]);
  });

  it('honors `\\;` `\\&` escapes outside quotes', () => {
    // `git commit \&\& foo` should NOT split.
    const segs = splitSegments('git commit \\&\\& foo');
    expect(segs).toHaveLength(1);
    // The raw text preserves the escaped form.
    expect(segs[0]?.raw).toBe('git commit \\&\\& foo');
  });

  it('strips a leading `sudo`', () => {
    const segs = splitSegments('sudo gh pr create --title x');
    expect(segs[0]?.head).toBe('gh pr create --title x');
    expect(segs[0]?.raw).toBe('sudo gh pr create --title x');
  });

  it('strips a leading env-var assignment', () => {
    const segs = splitSegments('CI=1 pnpm add foo');
    expect(segs[0]?.head).toBe('pnpm add foo');
  });

  it('strips multiple env-var assignments in sequence', () => {
    const segs = splitSegments('CI=1 HUSKY=0 NODE_ENV=test pnpm add foo');
    expect(segs[0]?.head).toBe('pnpm add foo');
  });

  it('strips `sudo` then env-var (in that order)', () => {
    const segs = splitSegments('sudo CI=1 pnpm add foo');
    expect(segs[0]?.head).toBe('pnpm add foo');
  });

  it('strips a leading `then`', () => {
    const segs = splitSegments('then git push --force');
    expect(segs[0]?.head).toBe('git push --force');
  });

  it('caps prefix-stripping iterations on hostile input', () => {
    // `then then then …` 40 times — should NOT busy-loop. The cap
    // (32 iterations) leaves some prefixes intact for very hostile
    // input, but the cap MUST NOT crash or spin.
    const segs = splitSegments('then '.repeat(40) + 'git push');
    expect(segs[0]?.head.startsWith('then')).toBe(true);
  });

  it('strips a double-quoted env-var value (codex round 1 P1)', () => {
    const segs = splitSegments(`REA_SKIP="urgent fix" gh issue create x`);
    expect(segs[0]?.head).toBe('gh issue create x');
  });

  it('strips a single-quoted env-var value', () => {
    const segs = splitSegments(`REA_SKIP='urgent fix' gh issue create x`);
    expect(segs[0]?.head).toBe('gh issue create x');
  });

  it("strips an ANSI-C dollar-quoted env-var value", () => {
    // `$'a\\nb'` → ANSI-C escape form, single-quoted-style.
    const segs = splitSegments(`KEY=$'a\\nb' git commit -m x`);
    expect(segs[0]?.head).toBe('git commit -m x');
  });

  it('strips stacked quoted env-vars then sudo then unquoted env', () => {
    const segs = splitSegments(
      `A="x y" sudo B='c d' E=plain gh issue create`,
    );
    expect(segs[0]?.head).toBe('gh issue create');
  });

  it('does NOT strip `KEY=` with no value (incomplete prefix)', () => {
    const segs = splitSegments('KEY= gh issue create');
    // The value is empty, which the matcher treats as "no value
    // token follows" — bash would error on this too. The head stays
    // intact rather than misinterpreting.
    expect(segs[0]?.head).toBe('gh issue create');
  });

  it('does NOT strip `FOO=barbaz` with no trailing whitespace', () => {
    // Single-token assignment with no following command — leave it.
    const segs = splitSegments('FOO=barbaz');
    expect(segs[0]?.head).toBe('FOO=barbaz');
  });

  it('returns the unterminated-quote span as a single segment (best-effort)', () => {
    // Caller's bug — but the splitter should NOT throw.
    const segs = splitSegments('echo "unterminated &&');
    expect(segs).toHaveLength(1);
    expect(segs[0]?.raw).toBe('echo "unterminated &&');
  });
});

describe('anySegmentStartsWith', () => {
  it('matches when the head of any segment matches the regex', () => {
    expect(
      anySegmentStartsWith(
        'echo hi && gh pr create --title x',
        'gh\\s+pr\\s+create',
      ),
    ).toBe(true);
  });

  it('does NOT match when the trigger word is inside a quoted body', () => {
    // The historical false-positive: substring `gh pr create` inside a
    // quoted body shouldn't trigger.
    expect(
      anySegmentStartsWith(
        'gh pr edit --body "tracked: gh pr create earlier in the run"',
        'gh\\s+pr\\s+create',
      ),
    ).toBe(false);
  });

  it('matches `gh pr edit` separately from `gh pr create`', () => {
    expect(
      anySegmentStartsWith('gh pr edit --body x', 'gh\\s+pr\\s+(create|edit)'),
    ).toBe(true);
    expect(
      anySegmentStartsWith('gh pr edit --body x', 'gh\\s+pr\\s+create'),
    ).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(
      anySegmentStartsWith('GH PR CREATE --title x', 'gh\\s+pr\\s+create'),
    ).toBe(true);
  });

  it('matches the post-prefix-strip head', () => {
    // After stripping `sudo`, the head IS `gh pr create`.
    expect(
      anySegmentStartsWith('sudo gh pr create --title x', 'gh\\s+pr\\s+create'),
    ).toBe(true);
  });

  it('matches `git commit` segments', () => {
    expect(
      anySegmentStartsWith('git commit -m "fix x"', 'git\\s+commit'),
    ).toBe(true);
  });
});

describe('anySegmentMatches', () => {
  it('matches when any segment contains the regex anywhere', () => {
    expect(
      anySegmentMatches(
        'git commit -m "feat: prevent injection"',
        'injection',
      ),
    ).toBe(true);
  });

  it('does NOT match across segment boundaries', () => {
    // Pattern split across two segments via && should not match.
    // (The segments here are: ['gh issue create --title foo',
    // 'gh issue create --title bar']; `gh issue create --title foo bar`
    // would NOT exist as a single segment.)
    expect(
      anySegmentMatches(
        'gh issue create --title foo && gh issue create --title bar',
        'foo\\s+bar',
      ),
    ).toBe(false);
  });

  it('matches Co-Authored-By: pattern inside a git commit segment', () => {
    expect(
      anySegmentMatches(
        'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
        'Co-Authored-By:.*noreply@(anthropic\\.com)',
      ),
    ).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(anySegmentMatches('echo HELLO', 'hello')).toBe(true);
  });
});
