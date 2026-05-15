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
  anySegmentMatchesBoth,
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

  // 2026-05-15 codex round-3 P1 fix: even-count backslashes DO NOT
  // escape the following separator — `\\` is a literal `\` escape
  // pair, and the `;` that follows it IS a real separator. Pre-fix
  // the single-char lookbehind regex treated `\\;` as escaped, which
  // let `dependency-audit-gate` miss `npm install evil-pkg` in
  // `echo \\; npm install evil-pkg`.
  it('SPLITS on `\\\\;` (even backslashes do not escape)', () => {
    const segs = splitSegments('echo \\\\; npm install evil-pkg');
    // Bash semantics: `\\` is a literal `\`, `;` is a real separator.
    expect(segs).toHaveLength(2);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^npm\s+install\s+evil-pkg/i.test(h))).toBe(true);
  });

  it('SPLITS on `\\\\\\\\&&` (4 backslashes — two pairs)', () => {
    // 4 backslashes = 2 literal `\` chars, then `&&` is a real
    // separator. The walker should treat this as 2 segments.
    const segs = splitSegments('echo \\\\\\\\&& npm install evil');
    expect(segs).toHaveLength(2);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^npm\s+install\s+evil/i.test(h))).toBe(true);
  });

  it('does NOT split on `\\\\\\;` (3 backslashes — odd, escapes the `;`)', () => {
    // 3 backslashes: first 2 form an escape pair (literal `\`), the
    // 3rd escapes the `;`. So we have a literal `\\;` and NO split.
    const segs = splitSegments('echo \\\\\\; npm install evil');
    // Single segment — the `;` is escaped.
    expect(segs).toHaveLength(1);
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

describe('nested-shell unwrapping (helix-017 #3 parity)', () => {
  it('unwraps `bash -lc PAYLOAD` and emits inner segments', () => {
    const segs = splitSegments(`bash -lc 'npm install lodash'`);
    // First segment is the wrapper itself; second is the inner.
    expect(segs.length).toBeGreaterThanOrEqual(2);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^npm\s+install\s+lodash/i.test(h))).toBe(true);
  });

  it('unwraps `sh -c PAYLOAD`', () => {
    const segs = splitSegments(`sh -c 'pnpm add foo'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^pnpm\s+add\s+foo/i.test(h))).toBe(true);
  });

  it('unwraps double-quoted nested payload', () => {
    const segs = splitSegments(`bash -c "yarn add lodash"`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^yarn\s+add\s+lodash/i.test(h))).toBe(true);
  });

  it('handles double-nested wrappers up to MAX_NESTED_DEPTH', () => {
    const segs = splitSegments(`bash -c "sh -c 'npm install deep'"`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^npm\s+install\s+deep/i.test(h))).toBe(true);
  });

  it('does NOT recurse forever on adversarial input', () => {
    // 20 nested wrappers — depth-bound limits to MAX_NESTED_DEPTH levels.
    let cmd = 'echo done';
    for (let i = 0; i < 20; i += 1) {
      cmd = `bash -c '${cmd}'`;
    }
    const segs = splitSegments(cmd);
    // Just confirm we return (no infinite loop) and the segment list
    // is bounded.
    expect(segs.length).toBeLessThan(40);
  });

  it('does not unwrap non-shell wrappers', () => {
    const segs = splitSegments(`node -e 'console.log("hi")'`);
    // node -e is not bash/sh; should be a single segment.
    expect(segs).toHaveLength(1);
  });

  // 2026-05-15 codex round-1 P1 parity additions — `dash`, split-flag
  // forms, and ANSI-C $'...' payloads. Each shape MUST unwrap so the
  // inner payload reaches downstream advisory matchers.

  it('unwraps `dash -c PAYLOAD` (helix-018 corpus shell)', () => {
    const segs = splitSegments(`dash -c 'npm install hostile-pkg'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^npm\s+install\s+hostile-pkg/i.test(h))).toBe(
      true,
    );
  });

  it('unwraps `bash -l -c PAYLOAD` (split-flag form)', () => {
    const segs = splitSegments(`bash -l -c 'gh issue create --title pwn'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^gh\s+issue\s+create/i.test(h))).toBe(true);
  });

  it('unwraps `bash -i -c PAYLOAD` (split-flag, -i then -c)', () => {
    const segs = splitSegments(`bash -i -c "pnpm add evil"`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^pnpm\s+add\s+evil/i.test(h))).toBe(true);
  });

  it('unwraps `bash -e -c PAYLOAD` (split-flag, -e then -c)', () => {
    const segs = splitSegments(`bash -e -c 'gh issue create --title x'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^gh\s+issue\s+create/i.test(h))).toBe(true);
  });

  it('unwraps `bash -l -i -c PAYLOAD` (multi-pre-flag form)', () => {
    const segs = splitSegments(
      `bash -l -i -c 'npm install \\@evil/pkg'`,
    );
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^npm\s+install/i.test(h))).toBe(true);
  });

  it("unwraps `bash -c $'PAYLOAD'` (ANSI-C single-quote)", () => {
    const segs = splitSegments(`bash -c $'gh issue create --title pwn'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^gh\s+issue\s+create/i.test(h))).toBe(true);
  });

  it('decodes ANSI-C `\\n` so payload-internal newlines become segment splits', () => {
    // helix-028 sibling — ANSI-C `\n` becomes a real LF and the
    // payload's second statement gets its own segment.
    const segs = splitSegments(
      `bash -c $'gh issue create --title first\\ngh pr create --title second'`,
    );
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^gh\s+issue\s+create/i.test(h))).toBe(true);
    expect(heads.some((h) => /^gh\s+pr\s+create/i.test(h))).toBe(true);
  });

  it("decodes ANSI-C `\\xHH` hex escapes", () => {
    // `\x3b` = ';' — should become a segment separator after decode.
    const segs = splitSegments(
      `bash -c $'gh issue create\\x0Agh pr create'`,
    );
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^gh\s+issue\s+create/i.test(h))).toBe(true);
    expect(heads.some((h) => /^gh\s+pr\s+create/i.test(h))).toBe(true);
  });

  // 2026-05-15 codex round-2 P1 additions — ksh / mksh / oksh / posh /
  // yash / csh / tcsh / fish. Each shell ships on real machines (mksh
  // on Alpine/Debian minimal; oksh / posh on minimal containers; ksh
  // on legacy Solaris/macOS; csh/tcsh on BSD; fish on dev workstations)
  // and accepts a -c flag with a quoted payload. Round-1's quartet
  // left these shells unwrapped — a real bypass surface against
  // env-file-protection and dependency-audit-gate.

  it('unwraps `ksh -c PAYLOAD`', () => {
    const segs = splitSegments(`ksh -c 'npm install evil-pkg'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^npm\s+install\s+evil-pkg/i.test(h))).toBe(true);
  });

  it('unwraps `mksh -c PAYLOAD`', () => {
    const segs = splitSegments(`mksh -c 'source .env'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^source\s+\.env/i.test(h))).toBe(true);
  });

  it('unwraps `oksh -c PAYLOAD`', () => {
    const segs = splitSegments(`oksh -c 'pnpm add hostile'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^pnpm\s+add\s+hostile/i.test(h))).toBe(true);
  });

  it('unwraps `yash -c PAYLOAD`', () => {
    const segs = splitSegments(`yash -c 'cat .env.production'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^cat\s+\.env\.production/i.test(h))).toBe(true);
  });

  it('unwraps `tcsh -c PAYLOAD` (BSD shell)', () => {
    const segs = splitSegments(`tcsh -c 'yarn add evil'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^yarn\s+add\s+evil/i.test(h))).toBe(true);
  });

  it('unwraps `fish -c PAYLOAD` (dev-workstation shell)', () => {
    const segs = splitSegments(`fish -c 'npm i evil-pkg'`);
    const heads = segs.map((s) => s.head);
    expect(heads.some((h) => /^npm\s+i\s+evil-pkg/i.test(h))).toBe(true);
  });

  it('still does NOT unwrap unknown shell-like names (pwsh / etc)', () => {
    // pwsh requires a separate code path (base64 decoding); not in
    // this set.
    const segs = splitSegments(`pwsh -c 'Get-Content .env'`);
    // No unwrap — single segment.
    expect(segs).toHaveLength(1);
  });

  it('does NOT unwrap unquoted payload (no quote introducer)', () => {
    // `bash -c foo` with no quotes — the bash WRAP regex requires a
    // quote introducer too. Treat as a single segment.
    const segs = splitSegments(`bash -c foo`);
    // Wrapper itself is one segment; no inner unwrap.
    expect(segs).toHaveLength(1);
  });
});

describe('anySegmentMatchesBoth', () => {
  it('returns true when both patterns hit the same segment', () => {
    expect(anySegmentMatchesBoth('cat .env', 'cat\\s', '\\.env')).toBe(true);
  });

  it('returns false when patterns are in different segments', () => {
    // 0.16.2 helix-017 P2 #2 fix: independent any-segment booleans
    // OR'd across segments must not fire.
    expect(
      anySegmentMatchesBoth(
        'echo "log: cat broken" ; touch foo.env',
        'cat\\s',
        '\\.env',
      ),
    ).toBe(false);
  });

  it('returns false when only A matches anywhere', () => {
    expect(anySegmentMatchesBoth('cat foo.txt && ls', 'cat\\s', '\\.env')).toBe(
      false,
    );
  });

  it('returns false when only B matches anywhere', () => {
    expect(anySegmentMatchesBoth('echo .env > log', 'cat\\s', '\\.env')).toBe(
      false,
    );
  });

  it('case-insensitive on both patterns', () => {
    expect(
      anySegmentMatchesBoth('CAT .ENV.production', 'cat\\s', '\\.env'),
    ).toBe(true);
  });

  it('returns false on empty command', () => {
    expect(anySegmentMatchesBoth('', 'a', 'b')).toBe(false);
  });
});
