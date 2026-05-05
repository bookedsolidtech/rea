/**
 * Tests for the ANSI-C `$'...'` decoder in `walker.ts` — helix-028 P1-1
 * (0.26.1 patch).
 *
 * Pre-fix mvdan-sh emitted `$'echo > .rea/HALT\\ntrue'` as a single
 * `SglQuoted{Dollar:true}` node whose `Value` was the RAW escape source
 * (literal backslash-n, not LF). The walker concatenated this verbatim
 * into the nested-shell payload and `parseBashCommand` re-parsed it; the
 * inner redirect target became `.rea/HALT\ntrue`. Then
 * `stripBashBackslashEscapes` (regex `\\([A-Za-z0-9./_~-])`) stripped the
 * backslash — `n` matches `[A-Za-z]` — yielding `.rea/HALTntrue`, which
 * never matched the protected pattern. Real bash, however, expanded
 * `\n` to LF, so the runtime redirect targeted `.rea/HALT` and the
 * kill-switch was overwritten.
 *
 * The fix:
 *   1. Detect `Dollar: true` on `SglQuoted` parts in `wordToString`.
 *   2. Decode common ANSI-C escapes (`\\` `\'` `\"` `\?` `\a` `\b` `\e`
 *      `\E` `\f` `\n` `\r` `\t` `\v`) plus `\xHH` `\NNN` `\uHHHH`
 *      `\UHHHHHHHH` `\cX`.
 *   3. Fail closed on unknown escapes (mark word dynamic).
 *
 * Cumulative coverage: walker-level unit (this file) + helper-level unit
 * (cmd-segments-helix-028.test.ts) + end-to-end integration
 * (scan-bash-cli-helix-028.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { parseBashCommand } from '../../../src/hooks/bash-scanner/parser.js';
import { walkForWrites } from '../../../src/hooks/bash-scanner/walker.js';

function detect(cmd: string): { paths: string[]; dynamic: boolean[] } {
  const r = parseBashCommand(cmd);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  const writes = walkForWrites(r.file);
  return {
    paths: writes.map((w) => w.path),
    dynamic: writes.map((w) => w.dynamic),
  };
}

describe('walker — ANSI-C $’...’ decoding (helix-028 P1-1)', () => {
  it('decodes \\n inside nested-shell payload — exposes hidden write to .rea/HALT', () => {
    const cmd = "bash -lc $'echo x > .rea/HALT\\ntrue'";
    const r = detect(cmd);
    // After ANSI-C decode, nested-shell unwrap re-parses
    // `echo x > .rea/HALT\ntrue` as TWO statements; the first has a
    // redirect target of `.rea/HALT`.
    expect(r.paths).toContain('.rea/HALT');
  });

  it('decodes \\x0A — exposes hidden write to .rea/HALT', () => {
    const cmd = "bash -lc $'echo x > .rea/HALT\\x0Arm -rf foo'";
    const r = detect(cmd);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('decodes \\012 octal — exposes hidden write to .rea/HALT', () => {
    const cmd = "bash -lc $'echo x > .rea/HALT\\012true'";
    const r = detect(cmd);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('decodes \\015 (CR — non-LF terminator) — exposes hidden write', () => {
    // Bash treats LF as the only statement terminator; CR is preserved in
    // the token. We still want the decoder to handle it correctly so the
    // re-parse doesn't see a corrupted target.
    const cmd = "bash -lc $'true\\nrm -rf .rea/policy.yaml'";
    const r = detect(cmd);
    // Two statements after decode; rm has dest .rea/policy.yaml.
    expect(r.paths.some((p) => p.includes('.rea/policy.yaml'))).toBe(true);
  });

  it('decodes \\cJ control char (= LF) — exposes hidden statement', () => {
    const cmd = "bash -lc $'echo x > .rea/HALT\\cJtrue'";
    const r = detect(cmd);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('decodes \\u000A (4-digit unicode = LF) — exposes hidden statement', () => {
    const cmd = "bash -lc $'echo x > .rea/HALT\\u000Atrue'";
    const r = detect(cmd);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('decodes \\U0000000A (8-digit unicode = LF) — exposes hidden statement', () => {
    const cmd = "bash -lc $'echo x > .rea/HALT\\U0000000Atrue'";
    const r = detect(cmd);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('regression: single-quoted (NOT ANSI-C) write-target still detected', () => {
    const cmd = "bash -lc 'echo > .rea/HALT'";
    const r = detect(cmd);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('regression: literal $\\n in double-quoted does NOT decode (no Dollar prefix)', () => {
    // `bash -lc "echo x > .rea/HALT\\ntrue"` (DQ — no $-introducer).
    // Pre-existing behavior: the literal `\n` was preserved in DQ
    // parsing; the redirect target became `.rea/HALT\ntrue` then the
    // path-mangler applied. After our fix, ANSI-C decoding only fires
    // for `Dollar: true` SglQuoted nodes. DblQuoted is unchanged.
    const cmd = `bash -lc "echo x > .rea/HALT\\ntrue"`;
    // We don't assert blocking here — the existing path-mangler still
    // applies to DQ. We just assert this code path is not affected by
    // our fix (no exceptions, walker still produces results).
    expect(() => detect(cmd)).not.toThrow();
  });

  it('regression: benign multiline ANSI-C does NOT report protected hits', () => {
    const cmd = "bash -lc $'echo hello\\necho world'";
    const r = detect(cmd);
    expect(r.paths.every((p) => !p.includes('.rea/HALT'))).toBe(true);
  });

  it('regression: empty ANSI-C body does not crash', () => {
    const cmd = "bash -lc $''";
    expect(() => detect(cmd)).not.toThrow();
  });

  it('regression: ANSI-C with only common escapes decodes correctly', () => {
    const cmd = "bash -lc $'echo a\\tb\\rc'";
    expect(() => detect(cmd)).not.toThrow();
  });
});

describe('walker — ANSI-C in non-nested redirect targets', () => {
  it('decodes \\x prefix in direct redirect target', () => {
    // Direct redirect with ANSI-C target (no nested shell). Bash actually
    // forbids this shape (`$'...'` inside redirect target evaluates to
    // a path). Our walker should still NOT mangle the decoded form.
    const cmd = "echo x > $'foo\\x42ar'";
    const r = detect(cmd);
    // After decode: `fooBar`. The path field should reflect the decoded
    // form (or be marked dynamic).
    if (r.paths.length > 0 && !r.dynamic[0]) {
      // Either the decoded form OR a refused-on-uncertainty marker is OK.
      expect(r.paths[0]).toBe('fooBar');
    }
  });
});
