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
  // 2026-05-15 codex round-3 P1 fix: walk char-by-char tracking
  // backslash-escape state instead of using regex lookbehind. The
  // pre-fix regex `(?<!\\)(...)` was a single-char negative lookbehind
  // which treated `echo \\;` as "preceded by `\` → no split". But in
  // bash semantics, `\\` is a literal `\` escape PAIR — the `;` that
  // follows it is NOT escaped, so the command splits into two
  // segments. The pre-fix splitter let `echo \\; npm install evil`
  // pass as a single segment, defeating the dependency-audit-gate
  // segment-anchor check and several other consumers.
  //
  // Strategy: walk left-to-right. When we encounter `\`, advance past
  // the next character (the escape pair consumes 2 bytes). When we
  // encounter a recognized separator at a non-pair position, emit a
  // split. This matches bash's argv-tokenizer semantics for
  // backslash-escape parity.
  //
  // The masker is byte-width-preserving so we can walk `masked`
  // directly without re-syncing with the original.
  const segments: string[] = [];
  let segStart = 0;
  let i = 0;
  const n = masked.length;
  while (i < n) {
    const ch = masked[i] as string;
    if (ch === '\\' && i + 1 < n) {
      // Escape pair — consume both, NEVER treat the next char as a
      // separator. Bash `\\` is a literal `\`; the char following
      // the pair is then evaluated for separator status.
      i += 2;
      continue;
    }
    // Separator detection. Order matters: `&&` and `||` are 2-byte
    // separators; the 1-byte forms must not steal their first byte.
    let sepLen = 0;
    if (ch === '&' && masked[i + 1] === '&') sepLen = 2;
    else if (ch === '|' && masked[i + 1] === '|') sepLen = 2;
    else if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') sepLen = 1;

    if (sepLen > 0) {
      const piece = masked.slice(segStart, i);
      const trimmed = piece.trim();
      if (trimmed.length > 0) segments.push(trimmed);
      i += sepLen;
      segStart = i;
      continue;
    }
    i += 1;
  }
  // Tail.
  if (segStart < n) {
    const piece = masked.slice(segStart, n);
    const trimmed = piece.trim();
    if (trimmed.length > 0) segments.push(trimmed);
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
 *
 * 0.33.0 — nested-shell unwrapping was added on top of the original
 * 0.32.0 splitter. When a segment's head is `bash -c|-lc|--c PAYLOAD`
 * or `sh -c|-lc|--c PAYLOAD` (any combination of `-l` and `-c` flags),
 * the PAYLOAD inside the quoted arg becomes additional segments
 * appended after the wrapper segment. Mirrors the bash counterpart's
 * `_rea_unwrap_nested_shells` (helix-017 #3 fix). Recurses up to
 * `MAX_NESTED_DEPTH` levels.
 */
export function splitSegments(cmd: string): CommandSegment[] {
  if (cmd.length === 0) return [];
  return splitSegmentsRecursive(cmd, 0);
}

const MAX_NESTED_DEPTH = 8;

function splitSegmentsRecursive(cmd: string, depth: number): CommandSegment[] {
  const masked = maskQuotedSeparators(cmd);
  const rawSegs = splitOnUnquotedSeparators(masked);
  const out: CommandSegment[] = [];
  for (const raw of rawSegs) {
    const unmaskedRaw = unmask(raw);
    const head = stripSegmentPrefix(unmaskedRaw);
    out.push({ raw: unmaskedRaw, head });
    // Try to unwrap a nested shell payload.
    if (depth < MAX_NESTED_DEPTH) {
      const inner = extractNestedShellPayload(head);
      if (inner !== null) {
        // Append the inner payload's segments AFTER the wrapper segment.
        // This preserves the bash hook's emit-order: the wrapper IS a
        // segment too (so a hook that anchors on `bash` for some other
        // reason still sees it), and the inner segments follow.
        out.push(...splitSegmentsRecursive(inner, depth + 1));
      }
    }
  }
  return out;
}

/**
 * Recognize a nested-shell wrapper segment and return the unquoted
 * payload string. Returns `null` when the segment is not a wrapper.
 *
 * 2026-05-15 codex round-1 P1 fix — extends parity with
 * `_rea_unwrap_nested_shells` in `hooks/_lib/cmd-segments.sh`.
 *
 * Bash-parity matrix:
 *
 *   1. Shell names: bash | sh | zsh | dash
 *      (The bash counterpart also includes ksh / mksh / oksh / posh /
 *      yash / csh / tcsh / fish per the 0.19.0 M1 security review. We
 *      cover the common quartet here; the rare shells fall through to
 *      the bash-scanner tier which DOES have full coverage. Extending
 *      this list later is a one-line change.)
 *   2. Split-flag forms ANY combination of pre-flags before `-c`:
 *        bash -l -c '…'     bash -i -c '…'     bash -e -c '…'
 *        bash -li -c '…'    bash --noprofile -c '…'
 *      The pre-fix regex `(?:-[a-z]*c|--c)(?:\s+-[a-z]+)*` failed
 *      because it required `-c` to appear IN the FIRST flag token —
 *      `bash -l -c 'PAYLOAD'` did not match.
 *   3. Combined-flag forms: -c, -lc, -lic, -ic, -cl, -cli, -li, -il
 *      (the bash WRAP pattern's `-(c|lc|lic|ic|cl|cli|li|il)` set).
 *   4. ANSI-C-quoted payload: `bash -c $'…'`. Pre-fix the introducer
 *      regex `(['"])` could not match the `$` prefix, so the entire
 *      ANSI-C wrapper was a single un-unwrapped segment.
 *
 * The walker:
 *   - Tokenizes the head into whitespace-separated tokens.
 *   - First token must be a recognized shell name.
 *   - Walks subsequent flag tokens, each `-[A-Za-z]+` or `--[A-Za-z]+`.
 *   - A flag token containing a `c` letter terminates the flag walk
 *     (it's the `-c` introducer). The next non-flag token is the
 *     payload argument.
 *   - The payload argument's first character determines the quote
 *     style: `'`, `"`, or `$'` (ANSI-C). Any other character means
 *     the payload is unquoted and we return null (don't unwrap — the
 *     payload may already be a bare argv).
 */
function extractNestedShellPayload(head: string): string | null {
  // Tokenize on whitespace. The head has already passed through
  // stripSegmentPrefix so leading `sudo`/env-prefixes are gone.
  const trimmed = head.trimStart();
  if (trimmed.length === 0) return null;

  // 1. Shell-name token. Full parity with cmd-segments.sh `WRAP`:
  //    bash | sh | zsh | dash | ksh | mksh | oksh | posh | yash |
  //    csh | tcsh | fish. Codex round-2 P1 (2026-05-15): the round-1
  //    quartet (bash|sh|zsh|dash) left ksh/mksh/oksh/posh/yash/csh/
  //    tcsh/fish unwrapped — on machines where any of those shells
  //    are installed, `mksh -c 'source .env'` and
  //    `ksh -c 'npm install missing-pkg'` would bypass
  //    env-file-protection / dependency-audit-gate entirely.
  //    The bash counterpart caught these via the 0.19.0 M1 security
  //    review (WRAP regex extension).
  //
  //    NOTE: pwsh (PowerShell) is intentionally OUT — it accepts -c
  //    and -Command, and -EncodedCommand base64-decodes at runtime.
  //    Adding pwsh requires a separate code path with base64 decode
  //    (mirroring the bash counterpart's explicit pwsh exclusion).
  const shellMatch = /^(bash|sh|zsh|dash|ksh|mksh|oksh|posh|yash|csh|tcsh|fish)\b/i.exec(trimmed);
  if (shellMatch === null) return null;
  let cursor = shellMatch[0].length;

  // 2. Walk flag tokens. Each token is whitespace-separated and starts
  //    with `-`. A flag token containing the letter `c` (case-insens.)
  //    is the `-c` introducer; the NEXT token is the payload.
  let sawCFlag = false;
  while (cursor < trimmed.length) {
    // Skip whitespace.
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor] as string)) {
      cursor += 1;
    }
    if (cursor >= trimmed.length) return null;

    // Peek next token.
    const rest = trimmed.slice(cursor);
    if (rest[0] !== '-') {
      // Not a flag — must be the payload argument.
      break;
    }
    // Extract the flag token (contiguous non-whitespace).
    const flagMatch = /^(\S+)/.exec(rest);
    if (flagMatch === null) return null;
    const flag = flagMatch[0] ?? '';
    cursor += flag.length;

    // Recognized flag-token shapes:
    //   `-c` `-l` `-i` `-e` `-lc` `-lic` `-ic` `-cl` `-cli` `-li` `-il`
    //   `--c` `--noprofile` (etc.) — we don't enforce the full list,
    //   just that it's `-<letters>` or `--<letters>`.
    if (!/^--?[A-Za-z]+$/.test(flag)) return null;

    // Does this flag contain `c` (the -c introducer letter)?
    // `--c` also counts (rare but bash accepts).
    if (/c/i.test(flag.replace(/^--?/, ''))) {
      sawCFlag = true;
      // Continue the loop — the payload is the NEXT non-flag token.
      // (Bash's argv parser stops walking flags as soon as it sees -c,
      // but we accept additional flags between -c and the payload for
      // safety; the bash WRAP regex similarly tolerates trailing
      // flag-like tokens before the quoted body.)
    }
  }
  if (!sawCFlag) return null;
  if (cursor >= trimmed.length) return null;

  // Skip whitespace before payload.
  while (cursor < trimmed.length && /\s/.test(trimmed[cursor] as string)) {
    cursor += 1;
  }
  if (cursor >= trimmed.length) return null;

  // 3. Inspect the payload's introducer character.
  const first = trimmed[cursor] as string;
  let quote: "'" | '"';
  let isAnsiC = false;
  let payloadStart = cursor;

  if (first === '$' && trimmed[cursor + 1] === "'") {
    // ANSI-C: $'…' — single-quote-style but with C-string escapes.
    quote = "'";
    isAnsiC = true;
    payloadStart = cursor + 2;
  } else if (first === "'" || first === '"') {
    quote = first;
    payloadStart = cursor + 1;
  } else {
    // Unquoted payload — refuse to unwrap. The bash counterpart's
    // WRAP regex requires a quote introducer too.
    return null;
  }

  // 4. Walk the payload, collecting bytes until the matching closing
  //    quote. Honor quote-specific escape rules.
  let i = payloadStart;
  let payload = '';
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === quote) {
      // Closing quote found.
      return payload;
    }
    if (isAnsiC && ch === '\\' && i + 1 < trimmed.length) {
      // ANSI-C escape decoding. Mirror the bash counterpart's escape
      // table (cmd-segments.sh, _rea_unwrap_at_depth). Only the
      // common-enough subset is decoded; unknowns pass through as the
      // literal pair (matches awk default behavior).
      const nxt = trimmed[i + 1] as string;
      switch (nxt) {
        case 'n':
          payload += '\n';
          break;
        case 't':
          payload += '\t';
          break;
        case 'r':
          payload += '\r';
          break;
        case '\\':
          payload += '\\';
          break;
        case "'":
          payload += "'";
          break;
        case '"':
          payload += '"';
          break;
        case 'a':
          payload += '\x07';
          break;
        case 'b':
          payload += '\x08';
          break;
        case 'e':
        case 'E':
          payload += '\x1b';
          break;
        case 'f':
          payload += '\x0c';
          break;
        case 'v':
          payload += '\x0b';
          break;
        case '0':
          payload += '\x00';
          break;
        case 'x': {
          // \xHH or \xH — up to 2 hex digits.
          let hex = '';
          let k = i + 2;
          while (k < trimmed.length && hex.length < 2) {
            const hc = trimmed[k] as string;
            if (!/[0-9a-fA-F]/.test(hc)) break;
            hex += hc;
            k += 1;
          }
          if (hex.length > 0) {
            payload += String.fromCharCode(parseInt(hex, 16));
            i = k;
            continue;
          }
          // Fall through — `\x` with no hex digits is a literal pair.
          payload += '\\x';
          break;
        }
        default:
          // Unknown escape — preserve the literal pair (bash awk
          // default). E.g. `\z` → `\z`.
          payload += '\\' + nxt;
          break;
      }
      i += 2;
      continue;
    }
    if (!isAnsiC && quote === '"' && ch === '\\' && i + 1 < trimmed.length) {
      // Double-quote: backslash escapes the next character.
      payload += (trimmed[i + 1] as string) ?? '';
      i += 2;
      continue;
    }
    payload += ch;
    i += 1;
  }
  // Unterminated quote — return what we have. The bash counterpart
  // similarly accepts unterminated quotes as "rest of line is payload".
  return payload;
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

/**
 * Returns true if any single segment's RAW text contains matches for
 * BOTH `regexA` AND `regexB`. Mirrors `any_segment_matches_both` from
 * the bash counterpart — used by `env-file-protection` to require that
 * a text-reading utility AND an `.env*` filename co-occur within the
 * same shell segment (a multi-segment construction like
 * `echo "log: cat .env stuff" ; touch foo.env` must NOT fire because
 * the utility and filename live in different segments).
 *
 * Case-INSENSITIVE, extended regex on both patterns. Same posture as
 * the bash helper.
 *
 * 0.33.0 port. The bash helper was introduced in 0.16.2 to fix the
 * helix-017 P2 false-positive class where two independent booleans
 * (any-utility OR any-env) were AND'd across segments.
 */
export function anySegmentMatchesBoth(
  cmd: string,
  regexA: string,
  regexB: string,
): boolean {
  const reA = new RegExp(regexA, 'i');
  const reB = new RegExp(regexB, 'i');
  for (const seg of splitSegments(cmd)) {
    if (reA.test(seg.raw) && reB.test(seg.raw)) return true;
  }
  return false;
}
