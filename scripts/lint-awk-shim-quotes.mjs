#!/usr/bin/env node
// G — Static lint for `awk '...'` blocks embedded in bash hooks.
//
// 0.36.0 charter item 3 / 0.34.0 round-4 + round-6 regression class.
//
// # The class
//
// Bash hooks frequently embed an awk script inside a bash-single-quoted
// argument:
//
//   awk '
//     # awk comment
//     { print $1 }
//   '
//
// Bash single-quoted strings have one rule: NO escape sequences inside.
// The string ends at the next unescaped `'`. If any character inside the
// awk body is a literal `'`, bash terminates the string THERE — the rest
// of the awk body is then re-parsed as bash, almost always producing a
// `syntax error near unexpected token` or worse, silently shelling out
// to whatever follows.
//
// The 0.34.0 marathon hit this twice — once at round-4, once at round-6.
// The round-6 instance locked the entire repo (every Bash refused at
// hook parse time because every hook sourced `_lib/cmd-segments.sh`,
// which crashed at parse). Repair required out-of-session `git apply`.
//
// # The lint
//
// For each `*.sh` under `hooks/` and `.claude/hooks/` (dogfood mirror),
// find every `awk '<NL>` block opening (the awk-with-multiline-body
// shape that the marathon class triggers in), scan inward until the
// matching unescaped `'`, and flag any line inside that:
//
//   - Starts with optional whitespace then `#` (a comment line in awk),
//   - Contains a literal `'`.
//
// We deliberately do NOT lint inline awk one-liners (`awk '{ print $1 }'`
// on one line) because those have no comment lines by construction —
// the bug class only manifests in multi-line awk bodies.
//
// # Wired into `pnpm lint`
//
// `package.json#scripts.lint` chains `lint:awk-quotes` before eslint, in
// the same posture as `lint:regex`. A failure here means a `'` ended up
// in an awk comment in a shipped hook body; the diff that introduced it
// would have parse-failed the hook at runtime (the way 0.34.0 round-6
// did). CI catches it before it ships.
//
// Mirrors-coverage rationale: `.claude/hooks/` is rea's own dogfood
// mirror. `tools/check-dogfood-drift.mjs` already enforces byte-equality
// between `hooks/*.sh` and `.claude/hooks/*.sh`, but this lint runs
// BEFORE that gate during a typical edit cycle, and a drifted mirror
// could still ship if the drift gate is bypassed. Lint both for
// defense-in-depth.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// 0.36.0 codex round-5 P2 #1: extended coverage. Originally the
// SCAN_DIRS list only covered `hooks/` and `.claude/hooks/` — but the
// package also ships awk-heavy shell scripts in `.husky/` (e.g.
// `prepare-commit-msg`) and `templates/` (e.g.
// `local-review-gate.dogfood-staged.sh`). A bare-apostrophe regression
// in those surfaces would have shipped silently. Adding them here
// pulls them under the same gate. Each path is checked for existence
// in `listShellFiles` so a profile that omits the directory still
// works.
const SCAN_DIRS = [
  path.join(repoRoot, 'hooks'),
  path.join(repoRoot, 'hooks', '_lib'),
  path.join(repoRoot, '.claude', 'hooks'),
  path.join(repoRoot, '.claude', 'hooks', '_lib'),
  // 0.36.0 codex round-5 P2 #1 additions.
  path.join(repoRoot, '.husky'),
  path.join(repoRoot, 'templates'),
];

/**
 * List shell-script files directly under the given directory
 * (non-recursive). A file qualifies if it ends in `.sh` OR its
 * first line is a `#!/...sh`/`#!/...bash` shebang (for extensionless
 * husky hooks like `.husky/pre-push`).
 *
 * Returns empty array if the directory doesn't exist.
 *
 * 0.36.0 codex round-5 P2 #1: pre-fix required `.sh` extension, which
 * skipped every `.husky/` file (they're shipped extensionless).
 */
function listShellFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    // Codex round-7 P2: `.patch` files are unified diffs (hunk-prefixed
    // lines, comments interleaved with `+`/`-`/` `), NOT raw shell. The
    // scanFile function only understands shell syntax, so feeding a
    // patch through it generates false-positives on benign comment-
    // hunks like `+# this isn't related to awk`. Skip patches; the
    // hook body the patch SHIPS TO will be linted directly once
    // applied, which is the more reliable signal anyway.
    if (e.name.endsWith('.sh')) {
      out.push(full);
      continue;
    }
    // Extensionless: check shebang.
    try {
      const head = readFileSync(full, 'utf8').slice(0, 64);
      if (/^#!.*\b(sh|bash|zsh|dash|ksh)\b/.test(head)) {
        out.push(full);
      }
    } catch {
      // unreadable — skip silently
    }
  }
  return out;
}

/**
 * Scan a single `.sh` file for `awk '` opening blocks (multi-line body
 * shape: `awk '` at end of a line, OR `awk '` followed by newline). For
 * each open block, walk lines until the closing unescaped `'` and flag
 * any comment line containing a literal `'`.
 *
 * Returns an array of `{file, line, content, reason}` findings.
 */
function scanFile(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const findings = [];

  let inAwkBlock = false;
  let awkStartLine = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (!inAwkBlock) {
      // Detect block opening: any line containing the `awk` keyword
      // that opens an awk-arg single-quote which DOESN'T close on
      // the same line. Real-corpus shapes that must trigger:
      //
      //   awk '                                        ← bare
      //   ... | awk '                                   ← piped
      //   ... | awk -v key=val '                        ← -v vars
      //   foo=$(awk -v a="$x" -v b="$y" '              ← multi-var
      //   awk -F: '                                     ← field-sep
      //   awk -v msg="can't" '                          ← -v with `'` in DQ-arg
      //   awk 'BEGIN { ... }                            ← body starts on opener
      //   ... | awk 'BEGIN { x = 1                      ← body starts on opener
      //
      // And must NOT trigger on:
      //
      //   # Example: awk '...'                          ← shell comment about awk
      //   awk '{print $1}'                              ← one-liner (no multi-line)
      //
      // Algorithm:
      //   1. Skip shell-comment lines (leading `#`).
      //   2. Require the `awk` keyword somewhere on the line.
      //   3. Strip benign bash quote-escape sequences.
      //   4. Count remaining `'`. An odd count means the line opens
      //      an awk-arg that doesn't close on this line (multi-line
      //      body). An even count means every open is paired with a
      //      close on this line (one-liner — no multi-line bug
      //      class).
      //
      // 0.36.0 codex round-3 P2 #1: pre-fix opener was
      // `/\bawk\b/ && /'\s*$/` which flipped on any prose line
      // mentioning awk that happened to end in `'` (e.g. a comment
      // like `# Example: awk '`). Shell-comment skip closes that
      // false-positive path.
      //
      // 0.36.0 codex round-3 P2 #2: pre-fix opener required `'` at
      // EOL, missing the `awk 'BEGIN { ... }` shape where the body
      // starts on the same line as the opener. Odd-quote-count
      // detection handles both shapes uniformly.
      // Skip shell-comment lines — they may mention `awk` in prose
      // (e.g. `# Example: awk '...'`) without being a real awk call.
      const codeOnly = line.replace(/^\s+/, '');
      if (codeOnly.startsWith('#')) continue;
      if (!/\bawk\b/.test(line)) continue;
      // Strip in order:
      //   - bash double-quoted spans (`"..."`) — bash treats `'`
      //     inside them as literal, NOT as quote terminators. Without
      //     this strip, `awk -v msg="can't" '` would count 2 `'`s
      //     and look balanced when it's actually 1 unclosed open.
      //   - benign quote-escape sequences (`'\''`, `'"'"'`, `''`).
      // Order matters: strip `"..."` first because the `'"'"'`
      // escape contains a DQ pair that would be wrongly consumed by
      // the DQ-strip if applied second.
      // Codex round-7 P1 fix: the prior `"[^"]*"` strip was too naive —
      // a valid shell line like `awk -v msg="foo \"can't\" bar" '` has
      // backslash-escaped quotes inside the double-quoted span. `[^"]*`
      // stops at the first `"` (which is `\"`), the next `"` opens a
      // new span, etc. The apostrophe from `can't` is left behind and
      // the linter false-balances the quote count. Fix: walk DQ spans
      // with proper escape handling — treat `\\` and `\"` as escapes,
      // ANY other char between `"`s is literal.
      let sanitizedOpener = line
        .replace(/'"'"'/g, '')
        .replace(/'\\''/g, '')
        .replace(/''/g, '');
      // Replace each `"..."` (with backslash-escape awareness) with `""`.
      sanitizedOpener = sanitizedOpener.replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""');
      const quoteCount = (sanitizedOpener.match(/'/g) ?? []).length;
      // Odd → opens a multi-line body. Even (incl. 0 / 2) → no
      // unclosed open on this line (one-liner or no quote at all).
      if (quoteCount % 2 === 1) {
        inAwkBlock = true;
        awkStartLine = i + 1; // 1-indexed for human-readable errors
        // 0.36.0 codex round-4 P2 #1: when the body starts on the
        // SAME line as the opener (`awk 'BEGIN { print "can't"`),
        // any apostrophe-in-word shape already on that opener line
        // MUST be checked too. Pre-fix the opener-detect branch
        // flipped state and immediately `continue`d, leaving the
        // opener line's body content unscanned.
        //
        // Locate the OPENING `'` (the LAST `'` in the sanitized
        // line — `awk` is typically the last token before the
        // opening quote, so any earlier `'`s are inside upstream
        // shell commands like `printf '%s'`). Then run the
        // apostrophe-in-word check on the text AFTER it (the awk
        // body content). Word-boundary detection scopes the lint
        // to the high-confidence bug shape (same discriminator as
        // the body-line check above).
        const openerIdx = sanitizedOpener.lastIndexOf("'");
        const bodyOnOpenerLine = sanitizedOpener.slice(openerIdx + 1);
        const apostropheInWord = /\b[A-Za-z][A-Za-z]*'[A-Za-z]/g;
        const om = bodyOnOpenerLine.match(apostropheInWord);
        if (om !== null) {
          const strippedOpener = line.replace(/^\s+/, '');
          const kind = strippedOpener.startsWith('#') ? 'comment' : 'code';
          findings.push({
            file,
            line: i + 1,
            content: line,
            reason:
              `awk-body ${kind} content on the OPENER line ` +
              `contains an apostrophe-in-word shape (${om[0]}). ` +
              `Bash terminates the \`awk '...'\` single-quoted ` +
              `argument at the embedded \`'\`, splicing the rest ` +
              `of the body into bash context; the hook parse-fails ` +
              `at runtime (0.34.0 round-4 + round-6 class). ` +
              `Rewrite without the apostrophe (e.g. \`cannot\` for ` +
              `\`can't\`) or escape as \`'\\''\`.`,
            awkStartLine,
          });
          // Bail out of block-mode — the bare `'` already
          // terminated bash quoting at runtime.
          inAwkBlock = false;
          awkStartLine = -1;
        }
      }
      continue;
    }

    // Inside awk block. Three things can happen on this line:
    //   1. The line contains a BARE `'` somewhere (in code OR
    //      comment) that isn't a close → finding.
    //   2. The line is the canonical block close → leave the block.
    //   3. Neither — keep walking.
    //
    // Bare-quote definition: a `'` that isn't part of a known-safe
    // bash escape sequence for embedding a literal apostrophe inside
    // a single-quoted string. The three benign forms are:
    //   - `'\''`  (close-quote, backslash-escaped quote, reopen-quote)
    //   - `'"'"'` (close-quote, double-quoted quote, reopen-quote)
    //   - `''`    (close + reopen, injects NO byte — used in rea
    //              hook comments to quote literal-byte sequences like
    //              `\\\''` without breaking bash parsing).
    // All three are fine in awk-internal context: bash terminates the
    // single-quoted argument, emits a literal `'` (or no byte for
    // `''`), and resumes single-quoting.
    //
    // 0.36.0 codex round-2 P2 #1 fix: pre-fix the bare-quote check
    // only ran on comment lines (`stripped.startsWith('#')`). A code
    // line like `BEGIN { print "can't" }` or `/can't/` parse-fails
    // the same way — bash sees the `'` in `can't` regardless of
    // whether awk parses the surrounding chars as a comment, string,
    // or regex. Lint now scans every line in the block.
    //
    // Close detection: the rea hook bodies always close an `awk '`
    // block with a `'` followed by a redirect / pipe / end-of-line
    // / closing paren on a line that is OTHERWISE empty of awk-body
    // text. Concretely: leading whitespace, then `'`, then optional
    // `|`/`>`/`)`/whitespace/EOL. We detect close BEFORE running the
    // bare-quote check on that line so a canonical-close line
    // (`  '`) doesn't itself trip a finding.
    const sanitized = line
      .replace(/'"'"'/g, '')
      .replace(/'\\''/g, '')
      .replace(/''/g, '');

    if (!sanitized.includes("'")) {
      // No bare `'` after stripping benign forms — no close, no bug.
      continue;
    }

    // Detect the 0.34.0 round-4 + round-6 bug class specifically:
    // an apostrophe-in-word shape like `can't`, `isn't`, `doesn't`
    // — a `'` flanked by ASCII word chars on at least one side.
    // That's the exact shape that broke the marathon (it appears
    // naturally in English prose and slips past code review). Other
    // possible bare-`'` shapes (e.g. `'X` at line start, where X is
    // ASCII content) are genuinely ambiguous from the lint's POV —
    // they may be the canonical close `'` followed by a bash
    // continuation, the close of a bash quoted string, etc. We
    // deliberately scope the lint to the high-confidence,
    // demonstrated-historical-bug shape rather than risk
    // false-positives on bash-grammar surface area we cannot parse.
    //
    // 0.36.0 codex round-4 P2 #2 resolution: pre-fix tried to
    // distinguish close from bug structurally (by what preceded or
    // followed the `'`). Both attempts produced false-positives on
    // valid close shapes (`' "$arg"`, `END { print x }'`,
    // `' | tr ...`). Word-boundary detection is the simplest
    // discriminator that catches the exact bug class without
    // tripping on legitimate bash continuation.
    const apostropheInWord = /\b[A-Za-z][A-Za-z]*'[A-Za-z]/g;
    const m = sanitized.match(apostropheInWord);
    if (m !== null) {
      const strippedLine = line.replace(/^\s+/, '');
      const kind = strippedLine.startsWith('#') ? 'comment' : 'code';
      findings.push({
        file,
        line: i + 1,
        content: line,
        reason:
          `awk-body ${kind} line contains an apostrophe-in-word ` +
          `shape (${m[0]}). Bash terminates the \`awk '...'\` ` +
          `single-quoted argument at the embedded \`'\`, splicing ` +
          `the rest of the body into bash context; the hook ` +
          `parse-fails at runtime (0.34.0 round-4 + round-6 class). ` +
          `Rewrite without the apostrophe (e.g. \`cannot\` for ` +
          `\`can't\`) or escape as \`'\\''\`.`,
        awkStartLine,
      });
      // Bail out of block-mode — the bare `'` already terminated
      // bash quoting at runtime, so further lines are bash-parsed,
      // not awk-parsed.
      inAwkBlock = false;
      awkStartLine = -1;
      continue;
    }

    // Any other `'` shape: assume it's a legitimate close `'`
    // followed by bash continuation. Leave the block.
    inAwkBlock = false;
    awkStartLine = -1;
  }

  return findings;
}

const allFindings = [];
for (const dir of SCAN_DIRS) {
  for (const file of listShellFiles(dir)) {
    allFindings.push(...scanFile(file));
  }
}

if (allFindings.length === 0) {
  // Quiet success — matches the posture of lint:regex.
  process.exit(0);
}

console.error(
  '[lint:awk-quotes] FAIL — bare single-quote in awk comment line ' +
    '(0.34.0 round-4 + round-6 regression class):\n',
);
for (const f of allFindings) {
  const rel = path.relative(repoRoot, f.file);
  console.error(`  ${rel}:${f.line}  (awk block opened at line ${f.awkStartLine})`);
  console.error(`    ${f.content.trim()}`);
  console.error(`    → ${f.reason}\n`);
}
console.error(
  `[lint:awk-quotes] ${allFindings.length} finding(s) across ${SCAN_DIRS.length} scan path(s).`,
);
process.exit(1);
