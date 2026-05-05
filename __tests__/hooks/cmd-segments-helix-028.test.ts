/**
 * Tests for `hooks/_lib/cmd-segments.sh` — helix-028 multiline-payload
 * bypass (0.26.1 patch).
 *
 * Pre-fix `awk -v raw="$cmd" -v masked="$masked"` errored with
 * `awk: newline in string ...` whenever the wrapped command contained a
 * literal newline. Awk fell back to the unsplit outer segment, so every
 * `any_segment_starts_with`-based gate (env-file-protection,
 * dependency-audit-gate, attribution-advisory, dangerous-bash-interceptor,
 * security-disclosure-gate, local-review-gate) missed the dangerous first
 * line inside a multiline `bash -c/-lc` wrapper. This reopened the
 * nested-shell bypass `_rea_unwrap_nested_shells` was added to close in
 * 0.17.0.
 *
 * The fix:
 *   1. Feed the entire multiline `$cmd` to awk as a SINGLE record using
 *      a multi-byte record separator (`\x1c\x1d` = FS+GS). `awk -v` is
 *      replaced with NUL-region stdin (NUL itself is unreliable on BSD
 *      awk; FS+GS is portable).
 *   2. Recognize `$'\''...'\''` (ANSI-C quoting) as a third quoted-body
 *      form — pre-fix the wrapper-scan only handled `'\''...'\''` and
 *      `"..."`, and the masker treated `$` as plain text in mode 0 so
 *      the closing `'\''` of `$'\''...'\''` flipped the mask state for
 *      the rest of the input. Common ANSI-C escape sequences (`\\n`,
 *      `\\t`, `\\r`, `\\\\`, `\\\''`, `\\"`) are decoded when emitting
 *      the payload so the segment splitter sees real newlines and splits
 *      on them.
 *   3. Sibling sweep: same fix applied to `quote_masked_cmd` (also
 *      processed input as records, dropping newlines and scrambling the
 *      mask) and to `_rea_split_segments`'s quote-mask awk (added mode 3
 *      so `echo $'\''a;b'\''` no longer false-splits on the in-quote `;`).
 *
 * These tests exercise the bash helper directly via a tiny harness shell
 * script — calling the higher-level gates would mostly be redundant
 * because the active bash-tier hooks `protected-paths-bash-gate.sh` and
 * `blocked-paths-bash-gate.sh` were rewritten in 0.23.0 as thin shims to
 * the Node-based scanner; only the LEGACY gates that still use
 * `cmd-segments.sh` benefit from this fix. The integration touchpoints
 * are:
 *   - env-file-protection.sh
 *   - dependency-audit-gate.sh
 *   - attribution-advisory.sh
 *   - dangerous-bash-interceptor.sh
 *   - security-disclosure-gate.sh
 *   - local-review-gate.sh
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(REPO_ROOT, 'hooks', '_lib', 'cmd-segments.sh');

/**
 * Run a snippet of bash that sources cmd-segments.sh and returns the
 * stdout of the snippet. The snippet is the body of a function `body()`
 * that is invoked at the end. `cmd` is exported into the env as `CMD`
 * for convenience.
 */
function runWithLib(snippet: string, cmd: string): { stdout: string; stderr: string; status: number } {
  const script = `
set -u
source ${JSON.stringify(LIB)}
body() {
  ${snippet}
}
body
`;
  const res = spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', CMD: cmd },
    encoding: 'utf8',
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

describe('cmd-segments.sh — helix-028 multiline-awk bypass (0.26.1)', () => {
  describe('_rea_unwrap_nested_shells extracts multiline payloads', () => {
    it('extracts a multiline double-quoted bash -lc payload', () => {
      // `bash -lc "printf x > .rea/HALT\ntrue"` with a LITERAL newline
      // between the two commands. Pre-fix: awk -v errored, payload not
      // emitted, gate let through.
      const cmd = 'bash -lc "printf x > .rea/HALT\ntrue"';
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).not.toMatch(/newline in string/);
      // Inner payload is emitted as a record after the outer wrapper.
      expect(res.stdout).toContain('printf x > .rea/HALT');
      expect(res.stdout).toContain('true');
    });

    it('extracts a multiline ANSI-C dollar-quoted payload (decoded \\n)', () => {
      // `bash -lc $'echo z > .rea/HALT\nrm -rf /tmp/foo'` — the body has
      // a literal backslash-n which bash would expand to newline at exec
      // time. The unwrap layer decodes the same sequence so the segment
      // splitter sees the inner commands as separate segments.
      const cmd = "bash -lc $'echo z > .rea/HALT\\nrm -rf /tmp/foo'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).not.toMatch(/newline in string/);
      expect(res.stdout).toContain('echo z > .rea/HALT');
      expect(res.stdout).toContain('rm -rf /tmp/foo');
    });

    it('handles bash -c (not just -lc) with ANSI-C dollar-quoted payload', () => {
      const cmd = "bash -c $'cat /etc/passwd > .env.local\\ntrue'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).not.toMatch(/newline in string/);
      expect(res.stdout).toContain('cat /etc/passwd > .env.local');
      expect(res.stdout).toContain('true');
    });

    it('handles ANSI-C with force-push payload', () => {
      const cmd = "bash -lc $'git push --force origin main\\ntrue'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).not.toMatch(/newline in string/);
      expect(res.stdout).toContain('git push --force origin main');
    });

    it('decodes common ANSI-C escapes (\\n \\t \\r \\\\ \\\' \\")', () => {
      const cmd = "bash -c $'a\\nb\\tc\\rd\\\\e\\'f\\\"g'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).not.toMatch(/newline in string/);
      // Payload includes a real newline, real tab, etc.
      expect(res.stdout).toMatch(/a\nb\tc/);
      expect(res.stdout).toContain("\\e"); // \\\\ → \\
      expect(res.stdout).toContain("'f"); // \\' → '
      expect(res.stdout).toContain('"g'); // \\" → "
    });

    it('decodes \\xHH hex escapes (round-1 P1-2)', () => {
      // Pre-round-1 fix: `\x0A` was preserved as the literal pair `\x0A`,
      // so the splitter never saw the LF, and the inner two statements
      // stayed glued together. Now the helper decodes hex escapes.
      const cmd = "bash -c $'echo a\\x0Aecho b'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).not.toMatch(/newline in string/);
      // Real LF between the two echo statements.
      expect(res.stdout).toMatch(/echo a\necho b/);
    });

    it('decodes \\NNN octal escapes (round-1 P1-2)', () => {
      // `\012` is octal 12 = decimal 10 = LF.
      const cmd = "bash -c $'echo a\\012echo b'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).not.toMatch(/newline in string/);
      expect(res.stdout).toMatch(/echo a\necho b/);
    });

    it('decodes \\xH single-digit hex with non-hex terminator (round-1 P1-2)', () => {
      // `\xA;` — one-digit hex 0xA = LF, terminated by `;` (non-hex).
      // Bash also reads up to TWO hex digits for `\x`, so `\xAecho` would
      // consume `Ae` → 0xAE (not LF). Forcing a non-hex byte after the
      // first digit exercises the 1-digit-hex branch.
      const cmd = "bash -c $'echo a\\xA;echo b'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).not.toMatch(/newline in string/);
      expect(res.stdout).toMatch(/echo a\n;echo b/);
    });

    it('decodes \\a \\b \\e \\E \\f \\v (rare BSD-only escapes)', () => {
      // Bash decodes `\a` BEL, `\b` BS, `\e`/`\E` ESC, `\f` FF, `\v` VT.
      // The helper now decodes these so the splitter sees control bytes
      // (which can't appear in a write-target match but verifies the
      // decoder branches don't regress on other inputs).
      const cmd = "bash -c $'a\\ab\\bc\\ed\\Ee\\ff\\vg'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      // BEL = 0x07; the decoded body is shorter than the encoded body.
      // Just assert the helper produces output and the test does not
      // crash the awk decoder.
      expect(res.stdout.length).toBeGreaterThan(0);
    });

    it('regression: \\u and \\U preserve literal pair (rare in legacy gates)', () => {
      // Per design: rare escapes preserve as literal pairs in the bash
      // helper to avoid awk-side unicode decode complexity. The Node
      // scanner — primary enforcement for protected/blocked paths since
      // 0.23.0 — fails closed on these.
      const cmd = "bash -c $'echo \\u0041'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      // Preserved literally: backslash + u + 0041.
      expect(res.stdout).toContain('\\u0041');
    });

    it('regression: single-line single-quoted payload still extracts', () => {
      const cmd = "bash -lc 'echo hello'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      expect(res.stdout).toContain('echo hello');
    });

    it('regression: single-line double-quoted payload still extracts', () => {
      const cmd = 'bash -lc "echo hello"';
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      expect(res.stdout).toContain('echo hello');
    });

    it('regression: empty single-quoted payload yields no inner record', () => {
      const cmd = "bash -lc ''";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      // Outer line emitted, but no inner payload between the quotes.
      const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length).toBe(1);
    });

    it('regression: empty ANSI-C dollar-quoted payload yields no inner record', () => {
      const cmd = "bash -lc $''";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length).toBe(1);
    });

    it('regression: plain text mentioning bash -c does not emit phantom payload', () => {
      const cmd = `echo "docs: do not run bash -c 'rm -rf' as root"`;
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      // Only the outer line; no inner payload extracted from the quoted
      // prose.
      const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length).toBe(1);
      expect(lines[0]).toBe(cmd);
    });

    it('handles two separated wrappers (multi-wrapper input)', () => {
      const cmd = "bash -c 'echo a' && bash -c \"echo b\"";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      expect(res.stdout).toContain('echo a');
      expect(res.stdout).toContain('echo b');
    });

    it('handles two separated ANSI-C wrappers', () => {
      const cmd = "bash -c $'echo a' ; bash -c $'echo b'";
      const res = runWithLib(`_rea_unwrap_nested_shells "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      expect(res.stdout).toContain('echo a');
      expect(res.stdout).toContain('echo b');
    });
  });

  describe('any_segment_starts_with detects danger after unwrap', () => {
    it('finds rm -rf inside ANSI-C multiline payload', () => {
      const cmd = "bash -c $'cd /; rm -rf foo\\necho hi'";
      const res = runWithLib(
        `if any_segment_starts_with "$CMD" 'rm[[:space:]]+-rf'; then echo MATCH; else echo NO_MATCH; fi`,
        cmd,
      );
      expect(res.stdout.trim()).toBe('MATCH');
    });

    it('finds git push --force inside multiline payload', () => {
      const cmd = "bash -lc $'git push --force origin main\\ntrue'";
      const res = runWithLib(
        `if any_segment_starts_with "$CMD" 'git[[:space:]]+push'; then echo MATCH; else echo NO_MATCH; fi`,
        cmd,
      );
      expect(res.stdout.trim()).toBe('MATCH');
    });

    it('regression: multiline payload that does NOT touch danger does not match', () => {
      const cmd = "bash -lc $'echo hello\\necho world'";
      const res = runWithLib(
        `if any_segment_starts_with "$CMD" 'rm[[:space:]]+-rf'; then echo MATCH; else echo NO_MATCH; fi`,
        cmd,
      );
      expect(res.stdout.trim()).toBe('NO_MATCH');
    });
  });

  describe('quote_masked_cmd handles multiline input', () => {
    it('preserves newlines and quote-state across lines', () => {
      // Pre-fix: `quote_masked_cmd` processed input as awk records. A
      // multiline input had newlines dropped AND mode reset per-line.
      // For `echo "a\nb" | grep x`, the closing `"` on line 2 was
      // treated as opening a new quoted span in mode 0, scrambling the
      // mask of the trailing `|`.
      const cmd = 'echo "a\nb" | grep x';
      const res = runWithLib(`quote_masked_cmd "$CMD" | od -c`, cmd);
      expect(res.stderr).toBe('');
      // Newline must be preserved in the output.
      expect(res.stdout).toMatch(/\\n/);
      // The `|` between `"a\nb"` and `grep x` is OUT of quotes and must
      // remain literal (not masked into INQ_PIPE).
      expect(res.stdout).toContain('|');
      expect(res.stdout).not.toContain('INQUOTE_PIPE');
    });

    it('masks in-quote `|` inside ANSI-C span', () => {
      // `echo $'a|b'` — the `|` is INSIDE the ANSI-C span and must be
      // masked. Pre-fix mode 3 didn't exist; `$` was plain mode 0 and the
      // `|` was treated as an out-of-quote separator.
      const cmd = "echo $'a|b'";
      const res = runWithLib(`quote_masked_cmd "$CMD"`, cmd);
      expect(res.stderr).toBe('');
      // The in-quote `|` must be masked.
      expect(res.stdout).toContain('INQUOTE_PIPE');
    });
  });

  describe('_rea_split_segments mode-3 ANSI-C support', () => {
    it('does not split on `;` inside ANSI-C span', () => {
      // `echo $'a;b'` is ONE segment. Pre-fix the splitter saw `;` in
      // plain mode 0 (because mode 3 didn't exist) and broke it into
      // `echo $'a` and `b'`.
      const cmd = "echo $'a;b'";
      const res = runWithLib(
        `_rea_split_segments "$CMD" | wc -l | tr -d '[:space:]'`,
        cmd,
      );
      expect(res.stderr).toBe('');
      expect(res.stdout.trim()).toBe('1');
    });

    it('still splits on out-of-quote `;` outside the ANSI-C span', () => {
      const cmd = "echo $'a;b' ; echo c";
      const res = runWithLib(
        `_rea_split_segments "$CMD" | wc -l | tr -d '[:space:]'`,
        cmd,
      );
      expect(res.stderr).toBe('');
      // Two segments: `echo $'a;b'` and ` echo c`.
      expect(res.stdout.trim()).toBe('2');
    });
  });
});
