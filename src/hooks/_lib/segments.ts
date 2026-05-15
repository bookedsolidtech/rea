/**
 * Quote-aware shell-segment splitter for the Node-binary hook tier.
 *
 * 0.32.0 — port of the relevant primitives in
 * `hooks/_lib/cmd-segments.sh`. The bash helper is 1002 LOC of
 * defense-in-depth (heredoc unwrapping, nested-shell recursion,
 * env-var-assignment stripping, etc.) — most of those branches exist
 * to defend against bypass attempts in WRITE-tier gates (`dangerous-
 * bash-interceptor`, `dependency-audit-gate`). The Phase 1 pilots
 * landing in 0.32.0 (`security-disclosure-gate`,
 * `attribution-advisory`) only need the SUBSET of segment behavior
 * those two hooks actually exercise:
 *
 *   1. Split the input on shell command separators (`;`, `&&`, `||`,
 *      `|`, `&`, newline) while masking separators that appear inside
 *      matched `"..."` and `'...'` quote spans.
 *   2. For each segment, strip leading `sudo`, `exec`, `time`, `then`,
 *      `do`, `else`, `fi`, and `VAR=value` env-prefixes so the
 *      caller's regex can anchor at the segment's actual command head.
 *   3. Expose two query primitives:
 *        - `anySegmentStartsWith(cmd, regexHead)`
 *            true if any segment's prefix-stripped head matches the
 *            head-anchored regex.
 *        - `anySegmentMatches(cmd, regex)`
 *            true if any segment's raw (non-stripped) text contains a
 *            match for the regex (used for content scans like
 *            `Co-Authored-By:` markers inside `git commit -m "..."`).
 *
 * Out-of-scope vs. the bash helper:
 *
 *   - No heredoc body extraction. The pilots match on the command
 *     line, not on heredoc contents. (Body-file resolution in
 *     `security-disclosure-gate` is done separately by reading the
 *     file path off the command.)
 *   - No nested-shell unwrapping (`bash -c 'PAYLOAD'`). The
 *     bash-scanner walker already handles that for the WRITE gates;
 *     the Phase 1 pilots inherit the SECURITY guarantee that any
 *     hostile nested shell would have been refused by the bash-scanner
 *     tier BEFORE this advisory tier ran.
 *   - No backtick/command-substitution recursion.
 *
 * If a future pilot needs those branches, port them here in a
 * subsequent release. The CURRENT pilots' bash counterparts call only
 * `any_segment_starts_with` and `any_segment_matches` against
 * direct-stdin commands.
 *
 * Quote-handling parity with cmd-segments.sh:
 *
 *   - Double-quoted spans (`"..."`): `\"` and `\\` are literal escapes;
 *     all other characters are literal.
 *   - Single-quoted spans (`'...'`): no escape semantics; every
 *     character is literal until the next `'`.
 *   - Unterminated quote spans extend to end-of-input (caller's bug —
 *     we still emit a single segment for it rather than throwing).
 *   - Backslash outside quotes escapes the following character (so
 *     `git commit \&\& foo` parses as a single segment, matching
 *     bash's behavior).
 */

/**
 * Sentinel bytes used to mask separators that appear inside quote
 * spans before splitting. Multi-byte and not legal in shell command
 * input — collisions are impossible for any realistic payload.
 *
 * The byte choices (0x1c – 0x1f are ASCII file-separator / group-
 * separator / record-separator / unit-separator) are the same range
 * `cmd-segments.sh` uses for its in-quote masking. We never expose
 * them externally; they exist only during the split and are restored
 * verbatim in the emitted segment text.
 */
const MASK = {
  SEMI: '\x1c\x10S\x1d',
  AMP_AMP: '\x1c\x10A\x10A\x1d',
  PIPE_PIPE: '\x1c\x10P\x10P\x1d',
  PIPE: '\x1c\x10P\x1d',
  AMP: '\x1c\x10A\x1d',
  NEWLINE: '\x1c\x10N\x1d',
} as const;

/**
 * Replace separators inside quote spans with sentinels so the split
 * walker doesn't see them. After splitting, the sentinels are
 * unmasked back to their literal characters in each emitted segment.
 */
function maskQuotedSeparators(cmd: string): string {
  let out = '';
  let i = 0;
  const n = cmd.length;
  let mode: 'plain' | 'dquote' | 'squote' = 'plain';
  while (i < n) {
    const ch = cmd[i] as string;
    if (mode === 'plain') {
      if (ch === '\\' && i + 1 < n) {
        // Backslash escapes the next character — emit both verbatim;
        // the split walker treats `\` as not-a-separator so escaped
        // `\&\&` etc. survive into the segment.
        out += ch + (cmd[i + 1] as string);
        i += 2;
        continue;
      }
      if (ch === '"') {
        mode = 'dquote';
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "'") {
        mode = 'squote';
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'dquote') {
      if (ch === '\\' && i + 1 < n) {
        out += ch + (cmd[i + 1] as string);
        i += 2;
        continue;
      }
      if (ch === '"') {
        mode = 'plain';
        out += ch;
        i += 1;
        continue;
      }
      // Mask separators inside double-quoted spans.
      if (ch === ';') {
        out += MASK.SEMI;
        i += 1;
        continue;
      }
      if (ch === '&' && cmd[i + 1] === '&') {
        out += MASK.AMP_AMP;
        i += 2;
        continue;
      }
      if (ch === '|' && cmd[i + 1] === '|') {
        out += MASK.PIPE_PIPE;
        i += 2;
        continue;
      }
      if (ch === '|') {
        out += MASK.PIPE;
        i += 1;
        continue;
      }
      if (ch === '&') {
        out += MASK.AMP;
        i += 1;
        continue;
      }
      if (ch === '\n') {
        out += MASK.NEWLINE;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    // mode === 'squote' — no escape semantics; mask separators verbatim.
    if (ch === "'") {
      mode = 'plain';
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ';') {
      out += MASK.SEMI;
      i += 1;
      continue;
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      out += MASK.AMP_AMP;
      i += 2;
      continue;
    }
    if (ch === '|' && cmd[i + 1] === '|') {
      out += MASK.PIPE_PIPE;
      i += 2;
      continue;
    }
    if (ch === '|') {
      out += MASK.PIPE;
      i += 1;
      continue;
    }
    if (ch === '&') {
      out += MASK.AMP;
      i += 1;
      continue;
    }
    if (ch === '\n') {
      out += MASK.NEWLINE;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Reverse the masking. Sentinels become their literal separator
 * character again so the emitted segment text reads as the caller
 * authored it.
 */
function unmask(text: string): string {
  return text
    .replace(/\x1c\x10S\x1d/g, ';')
    .replace(/\x1c\x10A\x10A\x1d/g, '&&')
    .replace(/\x1c\x10P\x10P\x1d/g, '||')
    .replace(/\x1c\x10P\x1d/g, '|')
    .replace(/\x1c\x10A\x1d/g, '&')
    .replace(/\x1c\x10N\x1d/g, '\n');
}

/**
 * Split the masked command on UNQUOTED separators. The masking pass
 * already replaced in-quote separators with sentinels, so a plain
 * regex split is now safe.
 *
 * The split pattern matches any of: `;`, `&&`, `||`, `|`, `&` (when
 * not part of `&&`), newline. We use a single regex with a lookbehind
 * to avoid splitting `&&` as two `&`s.
 *
 * `\\` escapes the next character — we don't want to split on `\;`
 * either. Handled by checking the preceding character is NOT `\`
 * (lookbehind).
 */
function splitOnUnquotedSeparators(masked: string): string[] {
  // Negative lookbehind for `\` — `git commit \; foo` shouldn't split.
  // JS regex supports lookbehind in V8 / Node 12+.
  const splitter = /(?<!\\)(\&\&|\|\||;|\||\&|\n)/g;
  // We split AND consume the separator (capture group above). The
  // result interleaves segment, separator, segment, separator, …; we
  // keep only the even-indexed entries (the segments).
  const parts = masked.split(splitter);
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    segments.push(trimmed);
  }
  return segments;
}

/**
 * Patterns that may precede a real command head in a segment. Mirrors
 * the catalog in `cmd-segments.sh#strip_segment_prefix`. Order matters
 * — env-var-assignment must come AFTER `sudo` because `sudo VAR=x cmd`
 * is a real shape.
 *
 * `--<flag>=<value>` is NOT stripped — those are part of the command.
 */
const LEADING_KEYWORDS = ['sudo', 'exec', 'time', 'then', 'do', 'else', 'fi'];

/**
 * Match an env-var assignment at the head of a segment, INCLUDING
 * quoted and ANSI-C values. Codex round 1 P1 (2026-05-15): the
 * pre-fix pattern was `^[A-Za-z_][A-Za-z0-9_]*=\S*\s+` which only
 * matched unquoted single-token values. The bash helper this
 * replaces handles five shapes the prior regex missed:
 *
 *   1. `KEY="value with spaces" cmd`     (double-quoted)
 *   2. `KEY='value with spaces' cmd`     (single-quoted)
 *   3. `KEY=$'ANSI-C\\nvalue' cmd`       (ANSI-C escape form)
 *   4. `KEY=`                            (empty value)
 *   5. `KEY=value cmd`                   (unquoted, the old form)
 *
 * Without coverage of (1)-(3), an attacker could hide a relevant
 * command head behind `REA_SKIP="urgent" gh issue create …` and
 * the `gh issue create` head would never reach the matcher in
 * `runSecurityDisclosureGate` / `runAttributionAdvisory`.
 *
 * Returns the consumed prefix length, or 0 if no env assignment.
 */
function matchEnvAssignLength(seg: string): number {
  // Variable-name prefix: `[A-Za-z_][A-Za-z0-9_]*=`. Strict POSIX
  // identifier — bash itself rejects names starting with a digit.
  const namePrefix = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(seg);
  if (namePrefix === null) return 0;
  let i = namePrefix[0].length;
  const n = seg.length;
  if (i >= n) return 0; // `KEY=` followed by nothing — not a prefix.

  // Determine the value-form by the first character after `=`.
  const ch = seg[i];

  // 3. ANSI-C form: `$'…'`. Consume up to the matching `'`,
  //    honoring backslash escapes (so `$'a\\'b'` → contents are
  //    `a\'b`, terminator is the third `'`). Bash forbids the
  //    closing quote from being escaped — the `$'` shape uses C
  //    string conventions, not shell-quote conventions.
  if (ch === '$' && i + 1 < n && seg[i + 1] === "'") {
    i += 2; // consume `$'`
    while (i < n && seg[i] !== "'") {
      if (seg[i] === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      i += 1;
    }
    if (i >= n) return 0; // unterminated — not a clean prefix.
    i += 1; // consume closing `'`
  } else if (ch === '"') {
    // 1. Double-quoted form. `\"` and `\\` are escapes.
    i += 1;
    while (i < n && seg[i] !== '"') {
      if (seg[i] === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      i += 1;
    }
    if (i >= n) return 0;
    i += 1;
  } else if (ch === "'") {
    // 2. Single-quoted form. No escapes — consume until next `'`.
    i += 1;
    while (i < n && seg[i] !== "'") i += 1;
    if (i >= n) return 0;
    i += 1;
  } else {
    // 5. Unquoted form. Consume contiguous non-whitespace.
    while (i < n && seg[i] !== ' ' && seg[i] !== '\t') i += 1;
  }

  // Require at least one whitespace after the value so we don't
  // strip `FOO=barbaz` (no command following).
  if (i >= n || (seg[i] !== ' ' && seg[i] !== '\t')) return 0;
  // Consume trailing whitespace before yielding the new segment.
  while (i < n && (seg[i] === ' ' || seg[i] === '\t')) i += 1;
  return i;
}

/**
 * Strip leading shell keywords and env-var assignments from a segment
 * so the caller's head-anchored regex sees the actual command first.
 *
 * Examples:
 *   `sudo gh pr create` → `gh pr create`
 *   `CI=1 pnpm add foo` → `pnpm add foo`
 *   `sudo CI=1 pnpm add foo` → `pnpm add foo`
 *   `REA_SKIP="urgent fix" gh issue create x` → `gh issue create x`
 *   `KEY=$'a\\nb' git commit` → `git commit`
 *   `then git push --force` → `git push --force`
 *
 * The bash counterpart loops until no more prefix matches. We mirror
 * that with an iteration cap of 32 (was 8; raised to support deeply
 * stacked env prefixes — bash itself has no limit so 8 was a per-
 * advisory-pilot bypass surface).
 */
function stripSegmentPrefix(seg: string): string {
  let current = seg;
  for (let iter = 0; iter < 32; iter += 1) {
    let changed = false;
    for (const kw of LEADING_KEYWORDS) {
      const re = new RegExp(`^${kw}\\s+`);
      if (re.test(current)) {
        current = current.replace(re, '');
        changed = true;
        break;
      }
    }
    if (changed) continue;
    const envLen = matchEnvAssignLength(current);
    if (envLen > 0) {
      current = current.slice(envLen);
      changed = true;
    }
    if (!changed) break;
  }
  return current;
}

/**
 * A single emitted segment. `raw` preserves the original (post-
 * unmasking) text; `head` is the prefix-stripped form used for
 * head-anchored matchers.
 */
export interface CommandSegment {
  raw: string;
  head: string;
}

/**
 * Split `cmd` into segments using the quote-aware masking → split →
 * unmask pipeline. Returns an array of `{ raw, head }` tuples in the
 * order they appeared in the original command.
 */
export function splitSegments(cmd: string): CommandSegment[] {
  if (cmd.length === 0) return [];
  const masked = maskQuotedSeparators(cmd);
  const rawSegs = splitOnUnquotedSeparators(masked);
  return rawSegs.map((raw) => {
    const unmaskedRaw = unmask(raw);
    return { raw: unmaskedRaw, head: stripSegmentPrefix(unmaskedRaw) };
  });
}

/**
 * Returns true if any segment's prefix-stripped head matches the
 * head-anchored regex. The regex must NOT include a `^` anchor —
 * we anchor by testing against the head of the segment via
 * `regex.test(head.slice(0, match.length))` simulation. In practice
 * we just run the regex against the head with the regex already
 * head-anchored by virtue of `head` containing only the prefix-
 * stripped form.
 *
 * The bash counterpart uses `grep -qiE PATTERN <<<"$head"` so we
 * match the same posture: case-INSENSITIVE, extended regex.
 *
 * @param regexSource ERE source. We compile with case-insensitive
 *                    flag. Caller passes the same string they would
 *                    have passed to `any_segment_starts_with` in bash.
 *                    The regex is internally anchored with `^`.
 */
export function anySegmentStartsWith(cmd: string, regexSource: string): boolean {
  // Compile once. `^` anchor + `i` flag.
  const re = new RegExp(`^${regexSource}`, 'i');
  for (const seg of splitSegments(cmd)) {
    if (re.test(seg.head)) return true;
  }
  return false;
}

/**
 * Returns true if any segment's RAW text contains a match for the
 * regex (no head anchoring). Mirrors `any_segment_matches` — used for
 * content-scan patterns like `Co-Authored-By:` markers inside
 * quoted `git commit -m "..."` arguments.
 *
 * Case-INSENSITIVE, extended regex. Same posture as the bash helper.
 */
export function anySegmentMatches(cmd: string, regexSource: string): boolean {
  const re = new RegExp(regexSource, 'i');
  for (const seg of splitSegments(cmd)) {
    if (re.test(seg.raw)) return true;
  }
  return false;
}
