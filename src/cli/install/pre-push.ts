/**
 * G6 — Pre-push hook fallback installer.
 *
 * Ships alongside `commit-msg.ts` as a second-line defender for the
 * protected-path Codex audit gate. The primary path is `.husky/pre-push`,
 * which rea copies into the consumer's `.husky/` via the canonical copy
 * module. That file only runs when the consumer has husky active
 * (`core.hooksPath` points at `.husky/`). Consumers who have never run
 * `husky install`, or who have disabled husky entirely, would otherwise get
 * ZERO pre-push enforcement — and the protected-path gate is exactly the
 * thing we cannot let silently lapse.
 *
 * The fallback writes a small shell script that `exec`s the same
 * `push-review-gate.sh` logic the Claude Code hook already runs. The gate
 * itself is shared — we do NOT duplicate its 700 lines.
 *
 * ## Install policy (decision tree, documented)
 *
 * Given a consumer repo, we must decide where (if anywhere) to install a
 * fallback `pre-push`:
 *
 *   1. `core.hooksPath` unset (vanilla git):
 *      → Install `.git/hooks/pre-push`. This is the only path git will fire.
 *        `.husky/pre-push` sits on disk as a source-of-truth copy but is not
 *        consulted by git directly.
 *
 *   2. `core.hooksPath` set to a directory containing an EXECUTABLE,
 *      governance-carrying `pre-push`:
 *      → Do NOT install. A hook is "governance-carrying" when it either
 *        carries our `FALLBACK_MARKER` (rea-managed) or execs / invokes
 *        `.claude/hooks/push-review-gate.sh` (consumer-wired delegation).
 *        This is the happy path for any project running husky 9+ that has
 *        wired the gate.
 *
 *   3. `core.hooksPath` set to a directory with a pre-push that is NOT
 *      governance-carrying (wrong bits, unrelated script, lint-only husky
 *      hook, directory, etc.):
 *      → Classify as foreign. Leave it alone, warn the user, and let
 *        `rea doctor` downgrade the check to `warn` so the gap is visible.
 *
 *   4. `core.hooksPath` set to a directory WITHOUT a pre-push:
 *      → Install into the configured hooksPath (as `pre-push`). This is the
 *        "hooksPath is set but nothing lives there yet" case. The active
 *        hook directory has changed; we install where git will actually look.
 *
 * Idempotency: every install writes a stable managed header
 * (`# rea:pre-push-fallback v1`). Re-running `rea init` detects the header
 * by ANCHORED match (exact second line after the shebang) and refreshes in
 * place; it NEVER overwrites a hook without our marker — if the consumer
 * has their own pre-push already, we warn and skip. Substring matches are
 * deliberately rejected: a consumer comment, a grep log, or copy-pasted
 * snippet containing the sentinel must not reclassify a foreign file as
 * rea-managed.
 *
 * ## Why not just rely on `.husky/pre-push`?
 *
 * Three concrete failure modes we saw during 0.2.x dogfooding:
 *   - Consumer hasn't run `husky install` (fresh clone, pnpm hasn't run
 *     postinstall yet, etc.). `.husky/pre-push` exists but git's hooksPath
 *     still points at `.git/hooks/`. No enforcement.
 *   - Consumer deliberately uses `core.hooksPath=./custom-hooks` with a
 *     different tool. `.husky/pre-push` is dead weight.
 *   - CI or release automation disables husky via `HUSKY=0`. Again, no
 *     enforcement at push time.
 *
 * The protected-path Codex audit requirement is too important to let any
 * of those slip through silently. See THREAT_MODEL.md §Governance for the
 * full rationale.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import properLockfile from 'proper-lockfile';
import { warn } from '../utils.js';

const execFileAsync = promisify(execFile);

/**
 * Marker baked into every rea-installed fallback pre-push hook. Used for
 * idempotency: on re-run we refresh files carrying the marker and refuse
 * to touch anything that doesn't.
 *
 * Bump the version suffix whenever the embedded script semantics change so
 * upgrades can migrate old installs. Comparison is NOT a substring match —
 * see `isReaManagedFallback` for the anchored form required to classify
 * a file as rea-managed.
 */
export const FALLBACK_MARKER = '# rea:pre-push-fallback v1';

/**
 * Marker present in the shipped `.husky/pre-push` governance gate. Detection
 * requires the marker to appear on the SECOND LINE of the file (immediately
 * after the shebang) to prevent a consumer comment or copy-pasted snippet
 * that mentions the string from causing a foreign hook to be misclassified
 * as rea-managed and then silently overwritten. See `isReaManagedHuskyGate`
 * for the anchored check.
 */
export const HUSKY_GATE_MARKER = '# rea:husky-pre-push-gate v1';

/**
 * Second versioned marker embedded in the body of the shipped `.husky/pre-push`.
 * Required alongside `HUSKY_GATE_MARKER` so that a hook containing only the
 * header marker + `exit 0` (or any stub body) is not classified as rea-managed.
 * A genuine rea Husky gate always carries both. The marker is versioned so it
 * can be bumped if the gate implementation changes significantly.
 */
export const HUSKY_GATE_BODY_MARKER = '# rea:gate-body-v1';

/**
 * Fixed two-line prelude every rea-managed fallback hook opens with. Used
 * to distinguish a real rea install from a file that merely happens to
 * contain the marker substring (consumer comment, grep log, copy-pasted
 * snippet, etc.). The equality check is exact-bytes, anchored at offset 0.
 */
const FALLBACK_PRELUDE = `#!/bin/sh\n${FALLBACK_MARKER}\n`;

/**
 * Any reference to this token in a pre-push hook's body counts as a
 * consumer-wired delegation to the shared review gate. Used to distinguish
 * a legitimate custom pre-push that still honors rea governance from a
 * lint-only husky hook that would silently bypass it.
 */
const GATE_DELEGATION_TOKEN = '.claude/hooks/push-review-gate.sh';

/**
 * True when `content` starts with the exact rea fallback prelude. The
 * marker must appear as the second line, immediately after the shebang,
 * with no leading whitespace, no alternate shebang (`#!/usr/bin/env sh`),
 * and no interposed blank lines. Anything else is foreign.
 *
 * Rejecting a substring match is what stops a consumer comment like
 * `# Hint: the old rea:pre-push-fallback v1 marker moved into .husky/` from
 * accidentally classifying a user's own hook as rea-managed and then
 * getting overwritten on the next `rea init`.
 */
export function isReaManagedFallback(content: string): boolean {
  return content.startsWith(FALLBACK_PRELUDE);
}

/**
 * True when `content` has the shipped Husky gate marker on the SECOND LINE
 * (immediately after the shebang). This is the canonical structure of the
 * rea-authored `.husky/pre-push` — the shebang occupies line 1 and the marker
 * occupies line 2 with no intervening blank lines.
 *
 * Requiring line-2 placement prevents a consumer comment, copy-pasted snippet,
 * or any other text that merely *mentions* the marker string from reclassifying
 * a consumer-owned hook as rea-managed and triggering an overwrite on the next
 * `rea init`. A marker buried anywhere else in the file is not the canonical
 * structure and must not be trusted.
 *
 * This classification is checked BEFORE `isReaManagedFallback` in
 * `classifyExistingHook` so that the shipped `.husky/pre-push` is recognized
 * as a governance-carrying hook rather than `foreign/no-marker`.
 */
export function isReaManagedHuskyGate(content: string): boolean {
  // Positional anchor: header marker must be on line 2 (immediately after
  // shebang). Prevents classifying any file that merely mentions the sentinel.
  const lines = content.split(/\r?\n/);
  if (lines.length < 2 || lines[1] !== HUSKY_GATE_MARKER) return false;

  // R12 F1 (strengthened from R11): heuristic "mentions the string"
  // signatures are still spoofable. A file can include `[ -f .rea/HALT ]`
  // followed by `:` (no-op), or `echo codex.review .rea/audit.jsonl`, and
  // trivially satisfy a presence check without ever enforcing anything.
  //
  // Recognition now requires PROOF OF ENFORCEMENT:
  //
  //   1. HALT enforcement — the HALT test must be paired with a non-zero
  //      `exit` in the matching path. Either short-circuit form
  //      (`[ -f .rea/HALT ] && exit N`) or block form
  //      (`if [ -f .rea/HALT ]; then ... exit N ... fi`).
  //
  //   2. Audit check — the audit token must appear on a line with a command
  //      that can FAIL on a missing match. `grep`, `rg`, `awk`, `test`, `[`,
  //      or `[[` paired with `.rea/audit.jsonl` or `codex.review` satisfies.
  //      `echo codex.review .rea/audit.jsonl` does NOT — echo always succeeds.
  //
  // Both together demand the file actually implement the enforcement
  // behavior. Governance is a behavior, not a sticker; proving behavior
  // requires matching the structure of a real check, not just the text of
  // one.
  if (!hasHaltEnforcement(content)) return false;
  if (!hasAuditCheck(content)) return false;

  return true;
}

/**
 * Pre-0.4 rea-authored `.husky/pre-push` shape — same governance behavior
 * as the current gate but lacks the line-2/3 versioned markers
 * (`# rea:husky-pre-push-gate v1` / `# rea:gate-body-v1`) introduced in
 * 0.4.
 *
 * Codex R21 F1: without this detector, any consumer upgrading from a rea
 * release that shipped the pre-marker hook fell into `foreign/no-marker`.
 * `classifyPrePushInstall` mapped that to `skip/foreign-pre-push` and
 * `rea init` refused to touch the file. `rea doctor` reported
 * `activeForeign=true`. Users had no self-heal path short of manually
 * deleting the hook — which is a bad migration story for a governance
 * primitive that they are supposed to trust.
 *
 * Shape-level detection:
 *   1. Line 2 is the canonical pre-0.4 filename header
 *      `# .husky/pre-push — rea governance gate for terminal-initiated pushes.`
 *      This header shipped verbatim across the 0.2.x/0.3.x rea releases.
 *   2. Real governance still present — `hasHaltEnforcement(content)` AND
 *      `hasAuditCheck(content)` both pass. A stub that only matches the
 *      header comment (no enforcement) fails the shape check and stays
 *      classified as foreign.
 *
 * Classification consequence: `classifyExistingHook` returns
 * `rea-managed-husky` for legacy matches. `classifyPrePushInstall` maps
 * that to `skip/active-pre-push-present` — `rea init` does not touch the
 * hook (correctness: the file IS still functional governance), but
 * `inspectPrePushState` reports `ok=true, activeForeign=false` so doctor
 * stops flagging it. The canonical-manifest-driven upgrade path
 * (`rea upgrade`) detects the hash mismatch against the packaged
 * `.husky/pre-push` and surfaces the legacy shape as drift, letting the
 * operator opt into the refresh explicitly.
 */
export function isLegacyReaManagedHuskyGate(content: string): boolean {
  // R24 F2 — byte-identical SHA256 allowlist.
  //
  // The R22 token fingerprint (`block_push=0` + `block_push=1` + `"$block_push"
  // -ne 0` + `codex.review` grep) did not prove control flow — a drifted or
  // consumer-owned hook could retain those tokens while no longer enforcing
  // the audit gate, and still be classified as rea-managed. The only safe
  // recognition we can make without re-deriving POSIX control-flow semantics
  // is exact-byte equality against a hook body we know we shipped.
  //
  // Each entry below is the SHA256 of a `.husky/pre-push` body that rea has
  // historically published, collected via `git log --follow .husky/pre-push`.
  // On match, the consumer is trusted to be on a known-good rea-managed body,
  // and the canonical-manifest reconciler (`rea upgrade`) handles the refresh
  // to the current canonical SHA. Any byte drift flips the file back to
  // `foreign`, which forces an explicit opt-in upgrade instead of silent
  // trust — the exact escape hatch R24 F2 demanded.
  //
  // R25 F3 — line-ending normalization.
  //
  // Git with `core.autocrlf=true` on Windows checks out text files with CRLF,
  // so a consumer on Windows would present us with `\r\n`-delimited bytes of
  // the exact hook body we shipped. Rejecting those as foreign strands them
  // on the legacy form with no clean upgrade path. We collapse `\r\n` → `\n`
  // (and bare `\r` → `\n` — classic-Mac is dead but cheap to handle) BEFORE
  // hashing so LF-normalized and CRLF-checkout bytes hash to the same value.
  //
  // Trailing-whitespace drift and in-body edits still flip to foreign; only
  // the line-ending platform conversion is forgiven. That preserves the R24
  // F2 invariant — exact-byte equality modulo platform EOL — without blessing
  // semantic drift.
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return KNOWN_LEGACY_HUSKY_SHA256.has(hash);
}

/**
 * R24 F2 — exact-byte allowlist of shipped `.husky/pre-push` bodies
 * recognized as legacy rea-managed hooks. Append a new entry here the
 * moment any change lands in `hooks/` or `.husky/` that alters the
 * published hook body, so consumers upgrading from that version see their
 * install classified correctly and not stranded as foreign.
 *
 * Generated via: `git log --all --format='%H' --follow -- .husky/pre-push`
 * then `git show <sha>:.husky/pre-push | shasum -a 256` for each commit.
 */
const KNOWN_LEGACY_HUSKY_SHA256: ReadonlySet<string> = new Set([
  // v0.3.x shipped body (commit 320c090 → 0.3.0 release).
  '5014c585c4af5aa0425fde36441711fa55833e03b81967c45045c5bd716b821e',
  // Intermediate iteration (commit a356eb0, pre-release).
  '9a668414c557d280a56f48795583acffefbd11b81e2799fd54eb023e48ccb14b',
  // Intermediate iteration (commit 68c2cf2, pre-release).
  '9d4885b64f50dd91887c2c6b4d17e3aa91b0be5da8e842ca8915bec1bf369de5',
  // Initial publication (commit b513760, G6 MVP).
  '1ee21164ccce628a1ef85c313d09afdcdb8560efd761ec64b046cca6cc319cba',
]);

/**
 * True when `content` contains a POSIX shell construct that detects
 * `.rea/HALT` AND causes the script to exit non-zero on match. Comment
 * lines are stripped before scanning so `# if [ -f .rea/HALT ]; then exit`
 * does not satisfy.
 *
 * Patterns accepted:
 *   - Short-circuit:     `[ -f .rea/HALT ] && exit N`
 *                         `test -f .rea/HALT && exit N`
 *                         `[ -f .rea/HALT ] && { ...; exit N; }`
 *   - Block form:        `if [ -f .rea/HALT ]; then ... exit N ... fi`
 *                         (exit must appear in the THEN branch of the HALT if,
 *                         bounded by the matching `fi`)
 *
 * Patterns rejected (previously accepted by R11's signature heuristic):
 *   - `[ -f .rea/HALT ] && :`          — no-op stub
 *   - `if [ -f .rea/HALT ]; then :; fi` — no-op stub
 *   - `# check .rea/HALT`               — comment only
 *   - `echo .rea/HALT`                   — print, not enforce
 *   - `[ -f .rea/HALT ] && exit`         — bare `exit` == `exit 0` on most shells (R13)
 *   - `[ -f .rea/HALT ] && exit 0`       — exit 0 allows the push (R13)
 *   - `if [ -f .rea/HALT ]; then exit; fi` — same: no explicit non-zero code (R13)
 *
 * R12 F1: the previous `hasHaltTest` regex allowed a no-op body. We now
 * require proof that the HALT match actually exits the script.
 *
 * R13 F1: the R12 regex accepted a bare `\bexit\b` on the HALT path, which
 * matched both `exit 0` (allow push) and bare `exit` (POSIX: last command's
 * status — commonly 0). A hook can satisfy R12 and still let pushes through
 * when HALT is present. Proof of blocking enforcement now REQUIRES an explicit
 * non-zero positive integer exit code on the HALT path.
 *
 * R16 F1: the R15 block-form regex used `[\s\S]*?` spans between `then`,
 * `exit`, and `fi`, which could span across UNRELATED if/fi blocks. A spoof
 * `if [ -f .rea/HALT ]; then :; fi; if X; then exit 1; fi` satisfied the regex
 * even though the `exit 1` belonged to a separate if. We now walk statements
 * via a frame stack: each `if` pushes a frame (tagged `haltCond=true` when the
 * condition is the HALT test), statements in the `then` branch toggle
 * `nonZeroExitInBody`, and the matching `fi` pops. Enforcement is proven only
 * when BOTH flags are set on the same popped frame.
 */
function hasHaltEnforcement(content: string): boolean {
  // R13 F1: require `exit N` where N >= 1. Bare `exit` and `exit 0` MUST NOT
  // qualify — both allow the push. Leading zeros on a positive value (e.g.,
  // `exit 01`) are still rejected; shell treats the argument as a string and
  // the spec says "implementation-defined" for values outside 0–255, so we
  // keep the strict form `[1-9]\d*`.
  //
  // R20 F3: the body-check used `NONZERO_EXIT.test(full)`, which only looked
  // for the substring `exit N`. That accepted `echo exit 1` / `printf
  // 'exit 1\n'` inside the HALT branch, even though the hook only printed
  // text. Replaced with statement-level head-token parsing via
  // `isHeadExitStmt` so only a command-head `exit N` / `return N` counts.
  //
  // R20 (defensive): also strip function bodies so a HALT-check + exit 1
  // that lives inside an uncalled helper function doesn't register as
  // enforcement. Consistent with `hasAuditCheck` and `referencesReviewGate`.
  content = stripFunctionBodies(content);
  const HALT_TEST =
    /(?:\[[ \t]+-f[^\n]*\.rea\/HALT[^\n]*\]|\btest[ \t]+-f[^\n]*\.rea\/HALT)/;
  // Scan a free-form body chunk (after `then`, or the whole branch body) for
  // any head-token exit/return terminator. Splits on `;`/newline via
  // `splitStatements` and rejects shapes like `echo exit 1`.
  const bodyHasHeadExit = (body: string): boolean => {
    if (body.length === 0) return false;
    for (const stmt of splitStatements(body)) {
      if (isHeadExitStmt(stmt)) return true;
    }
    return false;
  };

  // R26 F1 — reachability-aware walk.
  //
  // A HALT enforcement match is only proof of governance when it lives at
  // the TOP LEVEL of the script. An enforcement block nested under `if false;
  // then ... fi`, under a loop that never runs, or under any outer control
  // structure can never be reached, so it does not actually block pushes.
  //
  // Both the short-circuit form (`[ -f HALT ] && exit N`) and the block
  // form (`if [ -f HALT ]; then exit N fi`) are now recognized only when
  // they appear at `frames.length === 0 && loopDepth === 0`. A nested
  // enforcement block still closes its frame, but we refuse to return
  // true for it.
  const shortCircuitRe =
    /(?:\[[ \t]+-f[^\n]*\.rea\/HALT[^\n]*\]|\btest[ \t]+-f[^\n]*\.rea\/HALT)[ \t]*&&[ \t]*(.*)$/m;
  const exitStmtRe = /^exit[ \t]+[1-9]\d*\b/;
  const stmtHasShortCircuitHalt = (stmtFull: string): boolean => {
    const m = stmtFull.match(shortCircuitRe);
    if (m === null) return false;
    const tail = m[1] ?? '';
    if (exitStmtRe.test(tail.trimStart())) return true;
    const blockMatch = tail.match(/^\s*\{([^}]*)\}/);
    if (blockMatch !== null) {
      const body = blockMatch[1] ?? '';
      const stmts = body.split(/[;\n]/).map((s) => s.trim());
      if (stmts.some((s) => exitStmtRe.test(s))) return true;
    }
    return false;
  };

  type Frame = {
    haltCond: boolean;
    nonZeroExitInBody: boolean;
    branch: 'cond' | 'body';
  };
  const frames: Frame[] = [];
  let loopDepth = 0;

  for (const stmt of statementsOf(content)) {
    const head = stmt.head;
    const full = stmt.full;

    if (/^(for|while|until)\b/.test(head)) {
      loopDepth++;
      continue;
    }
    if (/^done\b/.test(head)) {
      loopDepth = Math.max(0, loopDepth - 1);
      continue;
    }

    if (/^if\b/.test(head)) {
      const frame: Frame = {
        haltCond: HALT_TEST.test(full),
        nonZeroExitInBody: false,
        branch: 'cond',
      };
      if (/(^|[;\s])then\b/.test(full)) {
        frame.branch = 'body';
        if (bodyHasHeadExit(afterThen(full))) frame.nonZeroExitInBody = true;
      }
      frames.push(frame);
      continue;
    }

    if (/^then\b/.test(head)) {
      const frame = frames[frames.length - 1];
      if (frame !== undefined) {
        frame.branch = 'body';
        if (bodyHasHeadExit(afterThen(full))) frame.nonZeroExitInBody = true;
      }
      continue;
    }

    if (/^(elif|else)\b/.test(head)) {
      const frame = frames[frames.length - 1];
      if (frame !== undefined) frame.branch = 'cond';
      continue;
    }

    if (/^fi\b/.test(head)) {
      const frame = frames.pop();
      // R26 F1: the closing `fi` only proves enforcement when the if it
      // closes was itself TOP-LEVEL. `frames.length === 0` post-pop means
      // there is no outer enclosing `if`; `loopDepth === 0` means we are
      // not inside a `for/while/until`. A nested HALT if under any parent
      // guard is rejected.
      if (
        frame !== undefined &&
        frame.haltCond &&
        frame.nonZeroExitInBody &&
        frames.length === 0 &&
        loopDepth === 0
      ) {
        return true;
      }
      continue;
    }

    // R26 F1 — top-level short-circuit form. The `[ -f HALT ] && exit N`
    // shape only proves enforcement when it lives at top level. An
    // equivalent shape inside `if false; then ... fi` is never executed
    // and must not count. `frames.length === 0 && loopDepth === 0` gates
    // both conditions.
    if (
      frames.length === 0 &&
      loopDepth === 0 &&
      stmtHasShortCircuitHalt(full)
    ) {
      return true;
    }

    if (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame !== undefined && frame.branch === 'body') {
        if (bodyHasHeadExit(full)) frame.nonZeroExitInBody = true;
      }
    }
  }

  return false;
}

/**
 * Return everything after the first `then` keyword on a statement that
 * combines the `if`/condition with the `then` body on the same logical line.
 * Used by `hasHaltEnforcement` to scope the exit-body check so an `exit 1`
 * that precedes `then` (impossible in valid shell, but defensive) is not
 * mistaken for enforcement.
 */
function afterThen(line: string): string {
  const m = line.match(/(^|[;\s])then\b(.*)$/s);
  if (m === null || m[2] === undefined) return '';
  return m[2];
}

/**
 * A shell statement with both a head keyword and the full text. The head is
 * the first non-whitespace token used for control-flow recognition; the full
 * text preserves the statement for content matches (HALT test, audit grep).
 */
type ShellStatement = { head: string; full: string };

/**
 * Walk `content` and produce a stream of shell statements, normalized for
 * parser consumption. Handles:
 *
 *   - Line continuations (`\<newline>` → single space) so multi-physical-line
 *     constructs like the shipped husky `grep -E ... | \` + `grep -qF ...` are
 *     evaluated as one statement.
 *   - Full-line comments (`# ...` at line start) are dropped entirely.
 *   - Trailing comments (` # ...`) are stripped via `stripTrailingComment`.
 *   - `;`-separated statements are split via quote/paren/brace-aware
 *     `splitStatements` so `fi; if X; then ...` yields THREE statements.
 *
 * Each statement's `head` is the first whitespace-delimited token so callers
 * can cheaply classify as `if`/`then`/`fi`/`done`/etc. The `full` retains the
 * complete statement text for regex content checks (HALT test, audit grep,
 * exit N, variable assignments).
 */
function statementsOf(content: string): ShellStatement[] {
  const out: ShellStatement[] = [];
  const joined = joinLineContinuations(content);
  for (const raw of joined.split(/\r?\n/)) {
    const t = raw.trimStart();
    if (t.startsWith('#')) continue;
    const line = stripTrailingComment(t);
    for (const stmt of splitStatements(line)) {
      const trimmed = stmt.trim();
      if (trimmed.length === 0) continue;
      const head = trimmed.split(/\s+/, 1)[0] ?? '';
      out.push({ head, full: trimmed });
    }
  }
  return out;
}

/**
 * Split a logical line into `;`-separated statements, respecting shell
 * quoting and grouping so `;` inside strings / `(...)` / `{...}` is not a
 * separator. Examples:
 *
 *   splitStatements("fi; if X; then exit 1; fi")
 *     → ["fi", "if X", "then exit 1", "fi"]
 *
 *   splitStatements("echo 'a;b'; echo c")
 *     → ["echo 'a;b'", "echo c"]
 *
 * Not a full POSIX parser (no heredoc, no command substitution nesting
 * beyond depth counting) but sufficient for the one-liner hook shapes we
 * actually need to analyze. Any ambiguous input falls back to treating the
 * unclosed quote/paren as swallowing subsequent `;`, which is the safe
 * behavior — the statement appears as a single larger block and the
 * enclosing parser sees it as a non-control statement.
 */
function splitStatements(line: string): string[] {
  const stmts: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += c;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += c;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (c === '(') parenDepth++;
      else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (c === '{') braceDepth++;
      else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (c === ';' && parenDepth === 0 && braceDepth === 0) {
        stmts.push(buf);
        buf = '';
        continue;
      }
    }
    buf += c ?? '';
  }
  if (buf.length > 0) stmts.push(buf);
  return stmts;
}

/**
 * True when `content` contains a shell command that performs a CONTENT match
 * against the `codex.review` audit record, BOUND TO the audit log path, and
 * whose failure is allowed to propagate (no `|| true`, no backgrounding, no
 * pipelines that mask the match via a non-grep tail).
 *
 * Commands accepted (on a non-comment logical line that references
 * `codex.review`, literally or with the backslash-escaped form `codex\.review`
 * that appears inside a grep -E pattern):
 *   - `grep` / `egrep` / `fgrep` — classic POSIX content match
 *   - `rg`                       — ripgrep
 *
 * Binding to the audit log (required — R15 F1):
 *   - Literal `.rea/audit.jsonl` appears on the same logical line, OR
 *   - A variable reference like `$AUDIT` / `${AUDIT}` whose ASSIGNMENT has a
 *     RHS containing the literal `.rea/audit.jsonl`. The shipped husky gate
 *     uses `AUDIT_LOG="${REA_ROOT}/.rea/audit.jsonl"` and `grep ... "$AUDIT_LOG"`.
 *
 * Line continuations: a trailing backslash followed by a newline is joined
 * before scanning. The shipped husky gate splits the audit check across two
 * physical lines via `grep -E ... "$AUDIT_LOG" 2>/dev/null | \` + `grep -qF ...`
 * — we must see the full logical line so the pipe-tail check runs against
 * the complete construct.
 *
 * Commands REJECTED (R13 F2, preserved):
 *   - `test -s .rea/audit.jsonl` / `[ -f .rea/audit.jsonl ]` — file existence
 *     or non-empty test does NOT prove a `codex.review` record is present.
 *   - `awk`, `sed` — pattern-no-match is silent success; the opposite of
 *     what we need.
 *
 * Enforcement-swallowing forms REJECTED (R15 F1):
 *   - `|| true` / `|| :` / `|| /bin/true` / `|| /usr/bin/true` / `|| exit 0`
 *     / `|| exit` with no arg — any of these mask a grep miss.
 *   - Backgrounded: bare `&` that is not part of `&&` or an fd redirect —
 *     the backgrounded pipeline returns 0 to the shell regardless of grep.
 *   - `;` followed by a non-control command word — the LAST command becomes
 *     the status, swallowing the grep miss. Control keywords
 *     (`then`/`do`/`fi`/`done`/`else`/`elif`/`esac`) and trailing comments
 *     are allowed.
 *   - Pipelines whose LAST segment is NOT a grep-family command — under
 *     POSIX sh the pipeline's exit is the last command's, so `grep ... | cat`
 *     returns 0 even when grep missed. Pipelines of grep-only segments are
 *     allowed (the shipped husky gate uses `grep -E ... | grep -qF ...`).
 *
 * Why `codex\.review` (literal backslash) is accepted: the shipped
 * `.husky/pre-push` embeds the token inside a grep -E regex where `.` is
 * escaped to match the literal character, so the token appears on disk as
 * `codex\.review`. The classifier must recognize both forms.
 *
 * R12 F1: rejected `echo`-based spoofs by requiring a paired check command.
 * R13 F2: rejected file-existence-only proofs by requiring a content-match
 *         command AND the `codex.review` token.
 * R15 F1: bind the match to the audit log, reject failure-swallowing tails,
 *         and join shell line continuations so the shipped gate's multi-line
 *         `grep | grep` is evaluated as a single logical line.
 */
function hasAuditCheck(content: string): boolean {
  // R19 F2 + R20 F2: pre-strip function bodies so assignments and grep lines
  // inside dead (uncalled) helper functions don't pollute classifier state.
  const topLevel = stripFunctionBodies(content);

  // R20 F2 (Codex): `collectAuditLogVars` was monotonic — it added every
  // variable whose RHS had ever mentioned the audit path, and never removed
  // the binding when that variable was later reassigned to an unrelated
  // file. A spoof `AUDIT_LOG=.rea/audit.jsonl; AUDIT_LOG=/tmp/spoof; grep
  // codex.review "$AUDIT_LOG"` therefore passed the classifier.
  //
  // Replaced with live in-order state: we walk statements ourselves and
  // update `auditVars` on every assignment — RHS with audit path adds the
  // binding, RHS without removes it. The set is mutated in place so the
  // audit-grep check at each `if` sees the current bindings.
  const auditVars = new Set<string>();
  const ASSIGN_RE =
    /^(?:export[ \t]+|readonly[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
  const AUDIT_LITERAL = /\.rea\/audit\.jsonl/;
  const updateAuditVarState = (full: string): void => {
    const t = stripTrailingComment(full.trimStart());
    if (t.startsWith('#')) return;
    const m = t.match(ASSIGN_RE);
    if (m === null) return;
    const name = m[1];
    const rhs = m[2];
    if (name === undefined || rhs === undefined) return;
    if (AUDIT_LITERAL.test(rhs)) {
      auditVars.add(name);
    } else {
      auditVars.delete(name);
    }
  };

  // R17 F2 — the audit-check classifier must require that the MISS PATH is
  // blocking. Three enforcing forms are recognized:
  //
  //   (a) `if ! <audit-grep>; then <BLOCKING>; fi`
  //       Negated: the grep failing (miss) runs the then-body, which must
  //       block (`exit N` or `return N`).
  //
  //   (b) `if <audit-grep>; then :; else <BLOCKING>; fi`
  //       Positive: the grep failing (miss) runs the else-body, which must
  //       block. A positive `if` with NO `else` (or a non-blocking else)
  //       silently succeeds when the audit record is missing.
  //
  //   (c) `if <audit-grep>; then exit 0; fi` followed by a top-level
  //       blocking statement (`exit N` / `return N`). R18 legacy backward-
  //       compat shape: hit-path terminates inside `then` via allow (exit 0),
  //       miss-path falls through the `fi` and is stopped by a post-fi
  //       top-level blocker. Detected by flagging a pending fall-through
  //       requirement on fi-pop and satisfying it the next time the main
  //       walker sees a blocking statement at `frames.length === 0` and
  //       `loopDepth === 0`.
  //
  //   (d) Top-level bare grep — handled by the line-level fallback below
  //       under POSIX `set -e` semantics.
  //
  // R15's original "accept any positive `if <audit-grep>`" was wrong: the
  // `if` construct explicitly swallows the grep's exit status, so the miss
  // path needs its own blocking. Removing the blanket acceptance forces the
  // frame to carry through to `fi` and check the appropriate branch.
  //
  // Everything else that R15 F1 already required (audit-log binding, no
  // swallowing tails, grep-only pipelines) is still enforced via
  // `isAuditGrepLine` called from the walker.
  type Frame = {
    isNegatedAuditIf: boolean;
    isPositiveAuditIf: boolean;
    hasBlockingInThen: boolean;
    hasBlockingInElse: boolean;
    hasAllowOnMatchInThen: boolean;
    branch: 'cond' | 'then' | 'else';
    // R26 F1 v2 — true when the `if` condition is NOT an obviously-dead
    // literal like `if false;`, `if /bin/false;`, or
    // `if [ "a" = "b" ];` with literal-constant unequal sides. The audit-if
    // fi-pop rejects when ANY enclosing frame has `condIsLive === false`,
    // which catches the `if false; then audit-if; fi` spoof Codex flagged.
    // Conditions that cannot be statically ruled out (variable expansions,
    // command substitutions, non-literal tests) are treated as live — we
    // deliberately err toward accepting legitimate conditional guards over
    // rejecting them, since dead-literal spoofs have to look painfully
    // obvious to slip past human review AND this classifier.
    condIsLive: boolean;
  };
  const frames: Frame[] = [];
  // Parallel stack mirroring `for`/`while`/`until` nesting: `true` for loops
  // whose header is NOT an obviously-dead literal (`while false; do`,
  // `until true; do`, `for X in; do` with empty list), `false` otherwise.
  // Length is the usual `loopDepth`; we keep a boolean for each loop so the
  // audit-if fi-pop can require every enclosing loop to be live.
  const loopLiveStack: boolean[] = [];
  let pendingFallThroughMissBlock = false;

  const recordBlockingIntoFrame = (text: string): void => {
    if (frames.length === 0) return;
    const frame = frames[frames.length - 1];
    if (frame === undefined) return;
    if (isAllowOnMatchStmtLine(text) && frame.branch === 'then') {
      frame.hasAllowOnMatchInThen = true;
    }
    if (!isBlockingStmtLine(text, loopLiveStack.length)) return;
    if (frame.branch === 'then') frame.hasBlockingInThen = true;
    if (frame.branch === 'else') frame.hasBlockingInElse = true;
  };

  for (const stmt of statementsOf(topLevel)) {
    const { head, full } = stmt;

    // R20 F2: update audit-var bindings BEFORE any classifier sees this
    // statement. An assignment at the top of the hook records the binding;
    // a later reassignment to a non-audit path removes it. Order matters —
    // the audit-grep check below uses the CURRENT state, not a precomputed
    // snapshot. Assignment-statement updates are idempotent for non-
    // assignments (the regex fails cleanly and the set is untouched).
    updateAuditVarState(full);

    const loopDepth = loopLiveStack.length;

    if (/^(for|while|until)\b/.test(head)) {
      loopLiveStack.push(!isDeadLoopHead(full));
    }
    if (/^done\b/.test(head)) {
      loopLiveStack.pop();
    }

    if (/^if\b/.test(head)) {
      const condStmt = /(^|[;\s])then\b/.test(full)
        ? full.replace(/(^|[;\s])then\b.*$/s, '')
        : full;
      const condIsAuditGrep = isAuditGrepLine(condStmt, auditVars);
      const condIsNegated = /^if\s+!\s/.test(condStmt);
      const frame: Frame = {
        isNegatedAuditIf: condIsAuditGrep && condIsNegated,
        isPositiveAuditIf: condIsAuditGrep && !condIsNegated,
        hasBlockingInThen: false,
        hasBlockingInElse: false,
        hasAllowOnMatchInThen: false,
        branch: 'cond',
        condIsLive: !isDeadIfCondition(condStmt),
      };
      if (/(^|[;\s])then\b/.test(full)) {
        frame.branch = 'then';
        const bodyText = afterThen(full);
        if (isBlockingStmtLine(bodyText, loopDepth)) {
          frame.hasBlockingInThen = true;
        }
        if (isAllowOnMatchStmtLine(bodyText)) {
          frame.hasAllowOnMatchInThen = true;
        }
      }
      frames.push(frame);
      continue;
    }

    if (/^then\b/.test(head)) {
      const frame = frames[frames.length - 1];
      if (frame !== undefined) {
        frame.branch = 'then';
        const bodyText = afterThen(full);
        if (isBlockingStmtLine(bodyText, loopDepth)) {
          frame.hasBlockingInThen = true;
        }
        if (isAllowOnMatchStmtLine(bodyText)) {
          frame.hasAllowOnMatchInThen = true;
        }
      }
      continue;
    }

    if (/^elif\b/.test(head)) {
      const frame = frames[frames.length - 1];
      if (frame !== undefined) frame.branch = 'cond';
      continue;
    }

    if (/^else\b/.test(head)) {
      const frame = frames[frames.length - 1];
      if (frame !== undefined) {
        frame.branch = 'else';
        // Body after `else` on the same statement (e.g. `else exit 1`
        // produced by `splitStatements` on `; else exit 1;`). Must be
        // routed to hasBlockingInElse — otherwise the blocking text is
        // visible only as statement head text and the frame never sees it.
        const bodyText = full.replace(/^else\b/, '');
        if (isBlockingStmtLine(bodyText, loopDepth)) {
          frame.hasBlockingInElse = true;
        }
      }
      continue;
    }

    if (/^fi\b/.test(head)) {
      const frame = frames.pop();
      if (frame === undefined) continue;
      // R26 F1 v2 — reject an audit-if whose execution path is statically
      // dead. Two cases to catch:
      //   (1) The audit-if itself has a dead condition (`if false; then
      //       audit-grep; ...`): the audit machinery is inside a branch
      //       that never runs.
      //   (2) The audit-if is nested inside a dead enclosing construct —
      //       either an `if` frame whose cond is a dead literal (`if false;
      //       then if ! grep ...; then exit 1; fi; fi`), or a `for/while/
      //       until` loop whose header is dead (`while false; do audit-if;
      //       done`).
      //
      // v1 of R26 over-tightened by requiring `frames.length === 0`,
      // which broke the canonical shipped hook: it wraps the audit-if in
      // a legitimate protected-paths `if git diff ... | grep -qE PROTECTED;
      // then ... fi` guard, AND inside a `while read refspec; do ... done`
      // loop. Those enclosing constructs are live under normal execution.
      //
      // v2 checks every enclosing frame and loop for an obviously-dead
      // literal header. Live-but-text-visible conditions (variable tests,
      // command substitutions, user-supplied globs) pass through — the
      // threat we harden against here is the "look painfully obvious"
      // dead-code spoof, not arbitrary reachability analysis.
      //
      // The fall-through miss-path form (c) additionally requires
      // `loopDepth === 0`: the post-fi blocker is inherently top-level,
      // and wrapping it in a loop would make the blocker execute once
      // per iteration, a pathological shape outside the canonical
      // allow-on-match template.
      const enclosingAllLive =
        frame.condIsLive &&
        frames.every((f) => f.condIsLive) &&
        loopLiveStack.every((v) => v);
      if (enclosingAllLive && frame.isNegatedAuditIf && frame.hasBlockingInThen) {
        return true;
      }
      if (enclosingAllLive && frame.isPositiveAuditIf && frame.hasBlockingInElse) {
        return true;
      }
      if (
        enclosingAllLive &&
        frames.length === 0 &&
        loopDepth === 0 &&
        frame.isPositiveAuditIf &&
        frame.hasAllowOnMatchInThen &&
        !frame.hasBlockingInElse
      ) {
        pendingFallThroughMissBlock = true;
      }
      continue;
    }

    // Top-level blocking statement after a qualifying positive audit-if:
    // satisfies the fall-through miss-path requirement (form c).
    if (
      pendingFallThroughMissBlock &&
      frames.length === 0 &&
      loopDepth === 0 &&
      isBlockingStmtLine(full, loopDepth)
    ) {
      return true;
    }

    // R22 F1 — clear the pending fall-through requirement if we see an
    // intervening top-level `exit`/`return` terminator that is NOT blocking
    // (i.e. `exit 0`, bare `exit`, `return 0`, bare `return`). Such a
    // terminator makes the later `exit N` unreachable, so the miss path
    // still exits successfully — the hook is NOT audit-enforcing. Without
    // this reset, `if grep ...; then exit 0; fi; exit 0; exit 1` would be
    // accepted as fall-through-blocking because the later `exit 1` would
    // satisfy `pendingFallThroughMissBlock` even though execution can never
    // reach it on a miss.
    if (
      pendingFallThroughMissBlock &&
      frames.length === 0 &&
      loopDepth === 0 &&
      isHeadTerminatorStmtLine(full) &&
      !isBlockingStmtLine(full, loopDepth)
    ) {
      pendingFallThroughMissBlock = false;
    }

    // Statement inside an open `if` frame — route blocking statements to
    // the correct branch counter. The shipped husky gate uses exactly this
    // shape: `if ! grep ...; then` followed by `printf ...` +
    // `block_push=1` + `continue` + `fi`.
    recordBlockingIntoFrame(full);
  }

  // R19 F1: No bare-grep fallback. The prior line-level fallback accepted a
  // top-level audit grep under the assumption that POSIX `set -e` would
  // abort the shell on a miss. But `isReaManagedHuskyGate` never verifies
  // that `set -e` is actually enabled for the containing hook, so a gate
  // with `grep ... .rea/audit.jsonl` followed by `exit 0` would pass the
  // classifier while leaving the miss path non-blocking. Rather than chase
  // that proof (`set -e` can be disabled by a nested `set +e`, aliased,
  // overridden by `trap`, etc.), we require an explicit if-form miss-path
  // blocker — that's what forms (a), (b), and (c) above enforce.
  //
  // Consequence: the only accepted audit-check shapes are now
  //   (a) `if ! <audit-grep>; then exit N; fi`
  //   (b) `if <audit-grep>; then :; else exit N; fi`
  //   (c) `if <audit-grep>; then exit 0; fi` followed by top-level `exit N`
  //
  // Any hook shape outside this set is treated as not-audit-enforced and
  // therefore not rea-managed; `rea doctor` will flag it and the installer
  // will refresh it to the canonical husky-gate template.
  return false;
}

/**
 * True when `line` is a single logical line that performs an enforcing
 * `grep`-family match against the audit log for the `codex.review` token.
 * All R15 F1 constraints apply: audit-log binding (literal path or tracked
 * variable), rejection of swallowing tails (`|| true`, `|| :`, trailing `&`,
 * `;` followed by a non-control command), and pipelines must terminate in a
 * grep-family command.
 *
 * Extracted into a helper so `hasAuditCheck` can call it from both the
 * top-level-with-`set -e` path and the `if <audit-grep>; then ... fi` frame.
 */
function isAuditGrepLine(line: string, auditVars: Set<string>): boolean {
  // R26 F2 — scope-bound codex.review token.
  //
  // The previous shape-level check tested each constraint against the full
  // line: contains `codex.review` SOMEWHERE, contains a grep command
  // SOMEWHERE, references the audit log SOMEWHERE. A spoof like
  //
  //   if grep -q '.' "$AUDIT_LOG" && echo codex.review; then exit 0; fi
  //
  // trivially satisfies all three: the grep's pattern is `.` (matches any
  // non-empty line), the `codex.review` literal lives inside a bound `echo`,
  // and nothing prevents the grep from succeeding on any populated audit
  // log — including one with zero codex.review entries. The then-branch
  // then `exit 0`s and the push proceeds without a real review.
  //
  // We now require BOTH (a) the `codex.review` pattern AND (b) the audit-log
  // reference to appear WITHIN the argument range of a single grep-family
  // invocation. `findCommandEnd` walks from the grep token forward through
  // simple quoting and stops at the first unquoted command separator
  // (`;`, `&&`, `||`, `|`, `)`, newline), giving us the grep's own arg
  // scope. `codex.review` anywhere outside that scope — in an adjacent
  // `echo`, a later list member, a following command — fails the check.
  const grepRe = /\b(grep|egrep|fgrep|rg)\b/g;
  let bound = false;
  let match: RegExpExecArray | null;
  while ((match = grepRe.exec(line)) !== null) {
    const start = match.index;
    const rest = line.slice(start);
    const end = findCommandEnd(rest);
    const segment = rest.slice(0, end);
    // The pattern literal MUST live in the grep's own args. Accept both
    // the raw `codex.review` form and the shell-escaped `codex\.review`
    // form (the shipped canonical gate uses the escaped form).
    if (!/codex\\?\.review/.test(segment)) continue;
    const refsAuditLog =
      /\.rea\/audit\.jsonl/.test(segment) ||
      Array.from(auditVars).some((v) =>
        new RegExp(`\\$\\{?${v}\\}?`).test(segment),
      );
    if (!refsAuditLog) continue;
    bound = true;
  }
  if (!bound) return false;

  if (isSwallowingAuditCheck(line)) return false;
  if (!isGrepOnlyPipeline(line)) return false;
  return true;
}

/**
 * True when an `if <cond>; then ... fi` condition is an obviously-dead
 * literal — one whose exit status is statically known without executing any
 * external command. The classifier uses this to refuse to accept an audit-if
 * whose then-body (or whose enclosing then-body) is unreachable in every
 * execution, which would otherwise let `if false; then <audit-if>; fi`
 * score as governance proof.
 *
 * Detected shapes (after stripping leading `if ` and optional `! ` negation):
 *   - Bare `false`, `/bin/false`, `/usr/bin/false` — exit status 1 always.
 *     With odd-count negations those become live; even-count stays dead.
 *   - `[ "LITA" OP "LITB" ]` / `test "LITA" OP "LITB"` where OP is `=`/`==`/
 *     `!=` and both sides are plain double-quoted literals with no variable
 *     expansion or command substitution. Dead when `=`/`==` with unequal
 *     literals, or `!=` with equal literals.
 *
 * Everything else is treated as LIVE — variable tests, command
 * substitutions (`$(...)`), pipelines, and non-test commands cannot be
 * statically evaluated by this parser. The safety posture is: err toward
 * accepting legitimate conditional guards. Dead-code spoofs beyond these
 * patterns are outside the threat model this heuristic targets; a
 * sufficiently creative adversary (`if [ "$SECRET" = "nomatch" ]; then
 * audit-if; fi`) is caught by human review and by the broader reachability
 * checks elsewhere in this module, not by a more elaborate literal-folding
 * engine here.
 */
function isDeadIfCondition(condStmt: string): boolean {
  let s = condStmt.trim();
  if (!s.startsWith('if ') && !s.startsWith('if\t')) return false;
  s = s.replace(/^if[ \t]+/, '');
  let negations = 0;
  while (/^![ \t]+/.test(s)) {
    negations++;
    s = s.replace(/^![ \t]+/, '');
  }
  // Head-token dead commands: `false`, `/bin/false`, `/usr/bin/false`. A
  // trailing space, semicolon, or end-of-string separates the head.
  const headMatch = s.match(/^(\S+)(?=\s|;|$)/);
  const head = headMatch ? headMatch[1] : '';
  const headIsDeadFalse =
    head === 'false' || head === '/bin/false' || head === '/usr/bin/false';
  const headIsDeadTrue =
    head === 'true' || head === ':' || head === '/bin/true' || head === '/usr/bin/true';
  if (headIsDeadFalse) {
    return negations % 2 === 0;
  }
  if (headIsDeadTrue) {
    // `if true; then ...` is ALWAYS-TAKEN, not dead. But under a single
    // negation (`if ! true;`) it becomes always-skipped — dead.
    return negations % 2 === 1;
  }
  // Literal-constant equality tests: `[ "x" = "y" ]` / `test "x" = "y"`.
  const LITEQ =
    /^(?:\[|test)\s+"([^"$`\\]*)"\s+(=|==|!=)\s+"([^"$`\\]*)"\s+\]?\s*$/;
  const m = s.match(LITEQ);
  if (m !== null) {
    const lhs = m[1] ?? '';
    const op = m[2] ?? '';
    const rhs = m[3] ?? '';
    let dead: boolean;
    if (op === '=' || op === '==') {
      dead = lhs !== rhs;
    } else {
      dead = lhs === rhs;
    }
    return negations % 2 === 0 ? dead : !dead;
  }
  return false;
}

/**
 * True when a loop header (`for`/`while`/`until`) is statically dead — no
 * iteration will ever execute. Catches the `while false; do <audit-if>;
 * done` spoof symmetric to `isDeadIfCondition`.
 *
 * Detected shapes:
 *   - `while false`, `while /bin/false`, `while /usr/bin/false`
 *   - `until true`, `until :`, `until /bin/true`, `until /usr/bin/true`
 *   - `for VAR in ; do` — empty in-list, no iterations. Note: `for VAR;`
 *     (no `in`) iterates positional params and is treated as LIVE because
 *     `"$@"` is usually populated; a hook invoked with no args would
 *     not iterate but that is an operational state, not a syntactic
 *     deadness, so we accept it as live.
 *
 * Everything else (variable-driven conditions, command substitutions) is
 * treated as live.
 */
function isDeadLoopHead(loopHead: string): boolean {
  const s = loopHead.trim();
  const whileM = s.match(/^while[ \t]+(.+?)(?:[;\s]+do\b|;?\s*$)/);
  if (whileM !== null) {
    const cond = (whileM[1] ?? '').trim();
    const head = cond.split(/\s+/, 1)[0] ?? '';
    if (head === 'false' || head === '/bin/false' || head === '/usr/bin/false') {
      return true;
    }
    return false;
  }
  const untilM = s.match(/^until[ \t]+(.+?)(?:[;\s]+do\b|;?\s*$)/);
  if (untilM !== null) {
    const cond = (untilM[1] ?? '').trim();
    const head = cond.split(/\s+/, 1)[0] ?? '';
    if (
      head === 'true' ||
      head === ':' ||
      head === '/bin/true' ||
      head === '/usr/bin/true'
    ) {
      return true;
    }
    return false;
  }
  const forEmptyIn = /^for[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+in[ \t]*(?:;|\s*do\b|\s*$)/;
  if (forEmptyIn.test(s)) return true;
  return false;
}

/**
 * Scan `s` forward from offset 0 and return the index of the first unquoted
 * command separator, or `s.length` if none. Used by `isAuditGrepLine` to
 * carve out the argument scope of a single grep-family invocation.
 *
 * Recognizes shell single- and double-quote pairs and backslash escapes.
 * Does NOT implement full POSIX parsing — ANSI-C `$'...'`, command
 * substitution `$()`, arithmetic `$(( ))`, and backtick subshells are not
 * modeled. That is intentional: the audit-check patterns we accept are
 * deliberately simple, and any hook using exotic quoting or substitution
 * to compose an audit grep should be treated as drift and reinstalled to
 * the canonical form. This keeps the parser conservative — it may cut a
 * scope short and reject a legitimate shape, never extend a scope past a
 * real separator and accept a spoof.
 */
function findCommandEnd(s: string): number {
  let i = 0;
  let quote: '"' | "'" | null = null;
  let escape = false;
  while (i < s.length) {
    const c = s[i];
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (c === '\\') {
      escape = true;
      i++;
      continue;
    }
    if (quote !== null) {
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
      continue;
    }
    if (c === ';') return i;
    if (c === '\n') return i;
    if (c === ')') return i;
    if (c === '&' && s[i + 1] === '&') return i;
    if (c === '|') return i;
    i++;
  }
  return s.length;
}

/**
 * True when `line` contains at least one statement that, if executed, causes
 * the push to block. Recognized forms:
 *
 *   - `exit N` / `return N` where N >= 1 — explicit non-zero termination.
 *
 * Explicitly NOT blocking:
 *   - `:` (null command) — no-op.
 *   - `printf` / `echo` — informational output only.
 *   - Bare assignments (e.g. `block_push=1`) without a subsequent
 *     flow-control statement — the flag means nothing by itself.
 *   - `continue` / `break` — loop control only. The shell still falls
 *     through to whatever follows the enclosing `done`, which may be
 *     `exit 0`. The accumulator pattern that would make them blocking
 *     (`block_push=1; continue` paired with a post-loop
 *     `if [ "$block_push" -ne 0 ]; then exit 1; fi`) is outside the
 *     scope of this text-level parser (R18 F2). The shipped husky gate
 *     was restructured to use `exit 1` directly inside the miss-path
 *     body so that this detector can verify it cleanly.
 */
/**
 * True when the trimmed statement text's FIRST command token is `exit N`
 * or `return N` with N >= 1. Refuses to match when `exit N` appears as an
 * argument to another command (`echo exit 1`, `printf 'exit 1'`, etc.),
 * which the shell never executes as a real exit.
 *
 * R20 F1/F3 (Codex): the prior substring regex `\bexit[ \t]+[1-9]\d*\b`
 * accepted `echo exit 1` as blocking because the regex only cared that
 * the characters `exit 1` appeared somewhere in the statement. Head-token
 * parsing refuses that shape.
 *
 * Also recognizes a grouped block `{ … }` whose inner statements contain a
 * head-matched exit — `{ echo halt; exit 1; }` still blocks, but
 * `{ echo exit 1; }` does not.
 */
function isHeadExitStmt(stmt: string): boolean {
  const t = stmt.trim();
  if (t.length === 0) return false;
  if (/^exit[ \t]+[1-9]\d*\b/.test(t)) return true;
  // R23 F1 — top-level `return N` in a POSIX hook script is NOT a script
  // terminator. `/bin/sh -c 'return 1; exit 0'` emits a diagnostic and
  // continues to `exit 0`, so a hook that writes `return 1` where it means
  // `exit 1` is still fully bypassable. `stripFunctionBodies` already zeroes
  // out real function bodies, so by the time the parser sees a statement
  // every `return` here is top-level — treat it as non-blocking.
  // Grouped block `{ a; b; exit N; }` — split the body on `;`/newline and
  // require that AT LEAST ONE inner statement is itself head-matched.
  const blockMatch = t.match(/^\{([^}]*)\}/);
  if (blockMatch !== null) {
    const body = blockMatch[1] ?? '';
    for (const inner of body.split(/[;\n]/)) {
      const sub = inner.trim();
      if (sub.length === 0) continue;
      if (/^exit[ \t]+[1-9]\d*\b/.test(sub)) return true;
    }
  }
  return false;
}

/**
 * True when `line` contains at least one statement that unconditionally
 * allows the push to proceed from the current branch (`exit 0` / `return 0`).
 * Used to detect the legacy "allow-on-match + fall-through-block" shape
 * (R18 form c):
 *
 *   if grep -q codex.review .rea/audit.jsonl; then exit 0; fi
 *   exit 1
 *
 * On match, `exit 0` in the then-branch terminates the shell successfully.
 * On miss, the then-branch is skipped and control falls through the `fi`,
 * where the post-fi `exit 1` blocks the push. The classifier needs to see
 * both halves (allow in then, block after fi) to accept this shape.
 *
 * Bare `exit` / `return` (no arg) is not treated as allow-on-match because
 * POSIX uses the last command's exit status, which is brittle inside a
 * freshly-entered `then` branch (grep's status was already consumed by the
 * `if`). Requiring an explicit `0` keeps the detector fail-closed.
 */
function isAllowOnMatchStmtLine(line: string): boolean {
  const text = line.trim();
  if (text.length === 0) return false;
  for (const stmt of splitStatements(text)) {
    const t = stmt.trim();
    if (t.length === 0) continue;
    // R23 F2 — the prior substring regex accepted `echo exit 0` and
    // `printf 'return 0'` as allow-on-match because `\bexit 0\b` matched
    // the string argument. Use head-position parsing so only a real command
    // `exit 0` / `return 0` qualifies, and drop `return` entirely at top
    // level (R23 F1: top-level `return` is not a terminator in a POSIX
    // script).
    if (/^exit[ \t]+0(?=[\s;|&]|$)/.test(t)) return true;
    const blockMatch = t.match(/^\{([^}]*)\}/);
    if (blockMatch !== null) {
      const body = blockMatch[1] ?? '';
      for (const inner of body.split(/[;\n]/)) {
        const sub = inner.trim();
        if (sub.length === 0) continue;
        if (/^exit[ \t]+0(?=[\s;|&]|$)/.test(sub)) return true;
      }
    }
  }
  return false;
}

/**
 * True when `line` contains a head-position `exit` or `return` statement
 * with ANY exit status (or none). Used to invalidate a pending
 * fall-through-miss-block expectation in `hasAuditCheck` form (c) — if a
 * top-level terminator runs before a later blocking `exit N`, the blocker
 * becomes unreachable on the audit-miss path and the hook is no longer
 * proved to be audit-enforcing.
 *
 * Grouped-block inner terminators are also recognized so
 * `{ cleanup; exit 0; }` invalidates a pending expectation.
 */
function isHeadTerminatorStmtLine(line: string): boolean {
  const text = line.trim();
  if (text.length === 0) return false;
  for (const stmt of splitStatements(text)) {
    const t = stmt.trim();
    if (t.length === 0) continue;
    if (/^exit(?:[ \t]+\d+)?(?=[\s;|&]|$)/.test(t)) return true;
    // R23 F1 — top-level `return` is NOT a script terminator in a POSIX
    // hook. Excluded here so it does not falsely clear a pending
    // fall-through expectation.
    const blockMatch = t.match(/^\{([^}]*)\}/);
    if (blockMatch !== null) {
      const body = blockMatch[1] ?? '';
      for (const inner of body.split(/[;\n]/)) {
        const sub = inner.trim();
        if (sub.length === 0) continue;
        if (/^exit(?:[ \t]+\d+)?(?=[\s;|&]|$)/.test(sub)) return true;
      }
    }
  }
  return false;
}

function isBlockingStmtLine(line: string, _loopDepth: number): boolean {
  // R18 F2: `continue`/`break` are no longer treated as blocking on their
  // own. Both only affect loop control — the shell still falls through to
  // whatever follows the enclosing `done`, which may well be `exit 0`.
  // The shipped husky gate used `continue` paired with `block_push=1` +
  // a post-loop `if [ "$block_push" -ne 0 ]; then exit 1; fi`; that
  // accumulator pattern is outside the scope of this text-level parser,
  // so we now require an explicit `exit N` or `return N` inside the
  // miss-path body and have restructured the shipped hook accordingly.
  //
  // R20 F1: the substring regex `\bexit[ \t]+[1-9]\d*\b` accepted any
  // occurrence of `exit 1` in the statement, so `echo exit 1` and
  // `printf 'exit 1'` were mistakenly treated as blocking. Switch to
  // head-token parsing via `isHeadExitStmt`, which only accepts the
  // terminator at command-head position (and inside grouped blocks).
  const text = line.trim();
  if (text.length === 0) return false;
  for (const stmt of splitStatements(text)) {
    if (isHeadExitStmt(stmt)) return true;
  }
  return false;
}

/**
 * Join POSIX shell line continuations so the rest of the parser sees one
 * logical line per command. A trailing backslash immediately before `\n`
 * (no intervening whitespace — POSIX rule) is the continuation token.
 *
 * Using a single space as the join character preserves token boundaries so
 * downstream regexes (which rely on `\b`) still match correctly across the
 * former line break.
 */
function joinLineContinuations(content: string): string {
  return content.replace(/\\\r?\n/g, ' ');
}

/**
 * Replace every function-body line with an empty line so downstream
 * classifiers only see top-level (reachable) shell. A function definition
 * with no call site is dead code — any `exec <gate>` / `GATE=...; exec
 * "$GATE"` / etc. inside it MUST be ignored, otherwise the classifier
 * accepts uncalled helper functions as proof of gate delegation (R18 F1
 * + R19 F2).
 *
 * Recognizes both POSIX and bash-style function definitions:
 *   name() { body; }
 *   name() {
 *     body
 *   }
 *   function name { body; }
 *   function name() { body; }
 *
 * Brace counting strips `${...}` parameter expansions first so they don't
 * skew the depth counter. Approximate but fail-closed: a pathological
 * unbalanced `{` inside a heredoc would leak into a "still-in-function"
 * state, erasing more content than necessary — that errs toward
 * under-accepting, never over-accepting.
 */
function stripFunctionBodies(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let funcBraceDepth = 0;
  const funcDefRe =
    /^(?:function[ \t]+[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*\([ \t]*\))?|[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\))[ \t]*\{?[ \t]*$/;
  for (const raw of lines) {
    const line = raw.trimStart();
    if (funcBraceDepth === 0) {
      const stripped = line.replace(/\$\{[^}]*\}/g, '');
      if (funcDefRe.test(stripped)) {
        funcBraceDepth++;
        out.push('');
        continue;
      }
    }
    if (funcBraceDepth > 0) {
      const stripped = line.replace(/\$\{[^}]*\}/g, '');
      const opens = (stripped.match(/\{/g) ?? []).length;
      const closes = (stripped.match(/\}/g) ?? []).length;
      funcBraceDepth = Math.max(0, funcBraceDepth + opens - closes);
      out.push('');
      continue;
    }
    out.push(raw);
  }
  return out.join('\n');
}

/**
 * Strip a trailing `# ...` comment (hash preceded by whitespace and outside
 * of quoted strings) from a line. Preserves `#` inside single- or double-
 * quoted segments — a pragmatic but non-complete quoting parser that is
 * sufficient for hook-script shapes (no `$(...)` command substitution
 * nesting is handled). Without this, an attacker could hide a swallower
 * behind a comment boundary during manual code review, though not from the
 * shell itself; stripping here keeps the classifier aligned with the
 * shell's view of the line.
 */
function stripTrailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const prev = i > 0 ? line[i - 1] : '';
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (
      c === '#' &&
      !inSingle &&
      !inDouble &&
      (prev === ' ' || prev === '\t')
    ) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/**
 * True when `line` uses any construct that silently discards the grep's
 * non-zero exit when no `codex.review` record matches. Applies to the
 * logical line containing the audit-check grep (continuations already joined).
 *
 * NOTE: `grep ...; then` (the shipped husky gate's shape, as the condition
 * of `if ! grep ...; then`) is accepted — `then` is a control keyword.
 */
function isSwallowingAuditCheck(line: string): boolean {
  // `\b` only matches at a word/non-word boundary, which excludes `:` when
  // followed by end-of-line or whitespace (both non-word). Use `(?!\w)`
  // instead so `|| :`, `|| true`, `|| /bin/true` all match regardless of
  // what trails.
  if (/\|\|\s*(true|:|\/bin\/true|\/usr\/bin\/true)(?!\w)/.test(line))
    return true;
  // `|| exit` with no numeric argument falls through to `$?` which can be
  // 0; `|| exit 0` (and `exit 00` etc.) explicitly allows the push.
  if (/\|\|\s*exit(\s+0+\b|\s*$|\s*;)/.test(line)) return true;
  // Bare `&` that is not part of `&&` and not an fd-redirect piece. Strip
  // POSIX fd redirects first so `2>&1`, `1>&2`, `<&0`, and bash `&>` forms
  // do not look like backgrounding.
  const stripped = line.replace(/\d*[<>]&\d*-?/g, ' ').replace(/&>>?/g, ' ');
  if (/(?<!&)&(?!&)/.test(stripped)) return true;
  // `;` followed by a non-control command word. Control keywords close an
  // `if`/`while`/`until`/`case`/`for` construct and are safe. A trailing
  // comment (`;` followed by `#`) is also safe — nothing more runs.
  const postSemi = line.match(/;\s*(\S+)/);
  if (postSemi && postSemi[1] !== undefined) {
    const first = postSemi[1];
    if (!first.startsWith('#')) {
      const controlKeywords = new Set([
        'then',
        'do',
        'fi',
        'done',
        'else',
        'elif',
        'esac',
      ]);
      if (!controlKeywords.has(first)) return true;
    }
  }
  return false;
}

/**
 * True when every pipeline segment's last command is a grep-family match.
 * For single-command lines (no `|`) returns true trivially.
 *
 * Under POSIX `/bin/sh`, a pipeline's exit is the LAST command's, so
 * `grep ... .rea/audit.jsonl | cat` returns 0 on miss. Requiring the tail
 * to be a grep (or rg) keeps enforcement meaningful while permitting the
 * shipped husky gate's `grep -E ... | grep -qF ...` form.
 */
function isGrepOnlyPipeline(line: string): boolean {
  const segments: string[] = [];
  let buf = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1] ?? '';
    if (c === '|' && next !== '|') {
      segments.push(buf);
      buf = '';
    } else if (c === '|' && next === '|') {
      buf += c + next;
      i++;
    } else {
      buf += c;
    }
  }
  if (buf.length > 0) segments.push(buf);
  if (segments.length <= 1) return true;
  const grepCmd = /(^|\s)(grep|egrep|fgrep|rg)\b/;
  const last = segments[segments.length - 1];
  if (last === undefined) return true;
  return grepCmd.test(last);
}

/**
 * True when `content` contains a REAL shell invocation of
 * `push-review-gate.sh`. Used as a softer signal that a consumer-owned
 * pre-push still wires the shared gate (e.g. a husky 9 file that runs
 * lint AND execs the gate). Combined with "exists AND executable", a
 * gate-referencing foreign hook is a legitimate integration point —
 * doctor reports `pass`, install skips.
 *
 * Accepts (positive-match allowlist):
 *   - Bare invocation: `.claude/hooks/push-review-gate.sh "$@"`
 *   - POSIX exec keyword: `exec`, `.`, `sh`, `bash`, `zsh` followed by the
 *     gate path. The bash-only `source` keyword is NOT accepted — the POSIX
 *     equivalent `.` (dot) is.
 *   - Quoted/expanded path prefix: `exec "$REA_ROOT"/.claude/hooks/push-review-gate.sh "$@"`
 *     — double- or single-quoted variable expansions before the literal path
 *     are treated as part of the path, not as a mention context.
 *   - Trailing `;` after `exec <gate>`: `exec gate.sh "$@";` — exec replaces
 *     the shell, so the `;` and anything after it never runs; gate exit IS
 *     the hook's exit status.
 *   - Variable indirection: `GATE=<path-containing-gate>` on one line plus
 *     `exec "$GATE"` / `. "$GATE"` / etc. on a later line.
 *
 * Rejects:
 *   - Comment lines starting with `#`
 *   - Shell tests: `[ -x .claude/hooks/push-review-gate.sh ]`
 *   - File tests: `test -f .claude/hooks/push-review-gate.sh`
 *   - Chmod / cp / mv / cat / printf / echo mentioning the path
 *   - String literals inside quoted arguments to non-invocation commands
 *   - Invocations inside `if`/`for`/`while`/`case` blocks (conditional —
 *     not guaranteed to run)
 *   - Invocations after an unconditional top-level `exit`
 *   - Non-`exec` invocations followed by `||`, `&&`, `;`, or trailing `&`
 *     (status-swallowing operators)
 *
 * This is a pragmatic heuristic, not a full shell parser. R12 F2 broadened
 * the allowlist to match the forms Codex flagged as valid but previously
 * rejected; narrower patterns silently hard-failed `rea doctor` on
 * correctly-governed consumer repos.
 */
export function referencesReviewGate(content: string): boolean {
  // R19 F2: Pre-strip function bodies before ANY detection pass. Both the
  // literal-path line walker and the variable-indirection helper must agree
  // that content inside an uncalled function is dead code. Previously the
  // variable-indirection path ran first (early return) and bypassed the
  // function-scope guard that only the literal-path walker applied.
  const topLevel = stripFunctionBodies(content);

  // First pass: variable indirection. If the caller wrote the path into a
  // shell variable and execs the variable, same-line matching won't catch it.
  // Scan for assignment + later invocation of the same variable.
  if (hasVariableGateInvocation(topLevel)) return true;

  const lines = topLevel.split(/\r?\n/);
  let exitedBeforeGate = false;
  let depth = 0;
  // R18 F1: function bodies are a separate scope that was not depth-tracked.
  // A hook like `run_gate() { exec .claude/hooks/push-review-gate.sh; }` with
  // no call site for `run_gate` previously passed because the exec sat at
  // depth 0 by line-level accounting. We now treat any content inside a
  // function body as "not top-level" and reject invocations there.
  let funcBraceDepth = 0;
  const funcDefRe =
    /^(?:function[ \t]+[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*\([ \t]*\))?|[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\))[ \t]*\{?[ \t]*$/;
  for (const raw of lines) {
    let line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    const hashIdx = line.indexOf('#');
    if (hashIdx > 0) {
      const before = line[hashIdx - 1];
      if (before === ' ' || before === '\t') {
        line = line.slice(0, hashIdx).trimEnd();
      }
    }
    // Function-body tracking. Enter when a function definition line is seen;
    // exit when the matching `}` arrives on its own line. Nested braces
    // (e.g. brace-expansion `${VAR:-default}`) are stripped first so they
    // don't throw off the counter.
    const stripped = line.replace(/\$\{[^}]*\}/g, '');
    if (funcBraceDepth === 0 && funcDefRe.test(stripped)) {
      funcBraceDepth++;
      if (!line.includes('{')) {
        // Body opens on a subsequent line — leave counter at 1, the next
        // line's `{` will be absorbed by brace-balance below.
      }
      continue;
    }
    if (funcBraceDepth > 0) {
      const opens = (stripped.match(/\{/g) ?? []).length;
      const closes = (stripped.match(/\}/g) ?? []).length;
      funcBraceDepth = Math.max(0, funcBraceDepth + opens - closes);
      continue;
    }
    if (/^(if|for|while|until|case)\b/.test(line)) depth++;
    if (/^(fi|done|esac)\b/.test(line)) depth = Math.max(0, depth - 1);
    if (depth === 0 && isTopLevelExit(line)) {
      exitedBeforeGate = true;
    }
    if (!line.includes(GATE_DELEGATION_TOKEN)) continue;

    if (
      looksLikeGateInvocation(line) &&
      depth === 0 &&
      !hasContinuationOperator(line) &&
      !exitedBeforeGate
    )
      return true;
  }
  return false;
}

/**
 * True when `content` contains a variable assignment whose value contains
 * the gate token, followed (later in the file) by an `exec`/`.`/`sh`/`bash`/
 * `zsh` invocation of that same variable. Handles the idiomatic defensive
 * form Codex flagged:
 *
 *   GATE=.claude/hooks/push-review-gate.sh
 *   exec "$GATE" "$@"
 *
 * Same guards apply to the invocation line (unconditional, top-level, no
 * status-swallowing operators) — we do NOT accept a variable invocation
 * that sits inside an `if` block or is followed by `&&` / `||` / `;`.
 *
 * R12 F2: previous `referencesReviewGate` only checked same-line literal
 * path forms. A valid delegating hook that routed through a variable was
 * classified as foreign, causing `rea doctor` to hard-fail on governed
 * repos.
 */
function hasVariableGateInvocation(content: string): boolean {
  // R16 F3: track each variable's CURRENT value at exec time, not just
  // whether the name has EVER appeared on the LHS of a gate-carrying
  // assignment. A spoof like `GATE=gate.sh\nGATE=/bin/true\nexec "$GATE"`
  // previously passed because the classifier only checked the first
  // assignment and considered the variable "gate-carrying" for the rest of
  // the file. We now process statements in order and update each variable's
  // gate-carrying state on every assignment (including inside blocks).
  //
  // Conservative model: an assignment inside a conditional branch reassigns
  // the variable unconditionally in the tracker. This is imprecise (the
  // branch may not fire at runtime) but fail-closed — it causes us to
  // under-accept, never to over-accept. An operator whose valid gate
  // delegation accidentally trips this pattern can hoist the assignment to
  // top level to recover recognition.
  const varIsGateCarrying = new Map<string, boolean>();
  const assignRe =
    /^(?:export[ \t]+|readonly[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

  let depth = 0;
  let exitedBeforeGate = false;

  for (const stmt of statementsOf(content)) {
    const { head, full } = stmt;

    if (/^(if|for|while|case|until)\b/.test(head)) depth++;
    if (/^(fi|done|esac)\b/.test(head)) depth = Math.max(0, depth - 1);

    // Some branch keywords (then/else/elif/do) may prefix a statement — strip
    // them so the assignment match can see the underlying VAR=value shape.
    const body = full
      .replace(/^(then|else|elif|do)[ \t]+/, '')
      .trimStart();

    const m = body.match(assignRe);
    if (m) {
      const name = m[1];
      const rhs = m[2];
      if (name !== undefined && rhs !== undefined) {
        varIsGateCarrying.set(name, rhs.includes(GATE_DELEGATION_TOKEN));
      }
      continue;
    }

    if (depth === 0 && isTopLevelExit(full)) {
      exitedBeforeGate = true;
      continue;
    }

    for (const [v, isGate] of varIsGateCarrying) {
      if (!isGate) continue;
      const pattern = new RegExp(
        `^(exec|sh|bash|zsh|\\.)[ \\t]+["']?\\$\\{?${v}\\}?["']?(?=[ \\t;|&"'()]|$)`,
      );
      if (!pattern.test(body)) continue;
      if (depth !== 0) continue;
      if (exitedBeforeGate) continue;

      const execLed = /^exec\b/.test(body);
      const varIdx = body.search(new RegExp(`\\$\\{?${v}\\}?`));
      if (varIdx === -1) continue;
      const afterVar = body
        .slice(varIdx)
        .replace(new RegExp(`^\\$\\{?${v}\\}?["']?`), '');
      const tail = afterVar
        .replace(/\d*[<>]&\d*-?/g, ' ')
        .replace(/&>>?/g, ' ');
      if (/\|/.test(tail)) continue;
      if (execLed) {
        if (/&&/.test(tail) || /&\s*$/.test(tail)) continue;
      } else {
        if (/&&|;/.test(tail) || /&\s*$/.test(tail)) continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Returns true when `line` contains a shell status-swallowing operator after
 * the gate filename. Swallowing operators:
 *   - `||` / `&&` — the gate's exit is masked by the follow-up command
 *   - `;`         — the sequential-command separator; the LAST command's
 *                   exit becomes the line's (only problematic for non-exec
 *                   invocations — exec REPLACES the shell, so anything
 *                   after `exec gate "$@" ;` is dead code and the `;` is
 *                   harmless).
 *   - `|` / `|&`  — pipeline. Under POSIX `/bin/sh`, a pipeline's exit
 *                   status is that of the LAST command in the pipe, so
 *                   `gate "$@" | cat` returns `cat`'s status (always 0),
 *                   silently dropping gate failures. Bash's
 *                   `pipefail` option fixes this, but we cannot assume
 *                   `set -o pipefail` is in effect (it is not POSIX and
 *                   the shipped gate does not set it for consumers).
 *                   Applies to both exec-led and non-exec-led lines —
 *                   `exec gate | cat` is still a pipe whose exit comes
 *                   from the right-hand side.
 *   - trailing `&` — background job (line exits 0 regardless of gate)
 *
 * Not swallowing:
 *   - POSIX fd redirects: `2>&1`, `>&2`, `&>/dev/null` — contain `&` but
 *     do not change exit propagation. Stripped before the check.
 *   - `;` after `exec gate` — exec REPLACES the current shell with the
 *     command, so no code after the exec statement runs. The gate's exit
 *     IS the hook's exit status.
 *
 * R10 F2: stripped fd duplications before checking `&`.
 * R12 F2: treat a trailing `;` as harmless when the line begins with `exec`.
 * R14 F1: reject single `|` (pipe) — the pipeline's last-command exit is
 *   never the gate's, so the gate's failure is silently dropped.
 */
/**
 * True when the trimmed `line` is a top-level `exit` or `return` statement
 * that terminates (or short-circuits) the script. Accepts the forms Codex
 * R15 F2 called out as gaps in the earlier `^(exit|return)(\s+\d+)?$`
 * regex, all of which must mark the script as having already exited so
 * later gate-invocation lines are treated as dead code:
 *
 *   - `exit`        / `return`
 *   - `exit 0`      / `return 1`
 *   - `exit 0;`     / `return 1;`        — trailing semicolon
 *   - `exit 0 # x`  / `return 1 # x`     — trailing comment
 *   - `exit 0; # x` / `exit 0 ; # x`     — semicolon then comment
 *   - `exit 0; foo`                       — multi-statement; first is exit,
 *                                            so the shell never reaches `foo`
 *
 * We split on the first `;` and test the leading statement. This mirrors
 * how a POSIX shell executes the line: it evaluates statements left-to-
 * right, and `exit`/`return` unwinds before any right-hand statements run.
 *
 * R15 F2: the earlier anchored regex missed every non-bare form above, so
 * a spoof like `exit 0;` followed by `exec .claude/hooks/push-review-gate.sh`
 * was classified as valid delegation — dead code reported as governance.
 */
function isTopLevelExit(line: string): boolean {
  const trimmed = stripTrailingComment(line).trimEnd();
  if (trimmed.length === 0) return false;
  // R17 F3: split on `;`, `&&`, and `||`. Once `exit`/`return` runs, the
  // shell unwinds — all three list operators leave their right-hand side
  // unreachable. The previous `split(';')[0]` missed `exit 0 && cmd` and
  // `return 1 || :`, allowing a later gate invocation to be classified
  // reachable when it was actually dead code.
  const firstStmt = trimmed.split(/;|&&|\|\|/)[0]?.trim() ?? '';
  return /^(exit|return)(\s+\d+)?$/.test(firstStmt);
}

function hasContinuationOperator(line: string): boolean {
  const gateIdx = line.indexOf(GATE_DELEGATION_TOKEN);
  if (gateIdx === -1) return false;
  let tail = line.slice(gateIdx + GATE_DELEGATION_TOKEN.length);
  tail = tail.replace(/\d*[<>]&\d*-?/g, ' ');
  tail = tail.replace(/&>>?/g, ' ');
  // `\|` matches any pipe character, which covers both `||` (logical OR)
  // and a single `|` (pipeline). Both swallow the gate's exit status:
  // `||` masks via fallback-chaining, `|` masks via POSIX pipeline
  // last-command semantics. Listing them together means we never have to
  // disambiguate `|` from `||` — either is a rejection.
  const PIPE_OR_LOGICAL_OR = /\|/;
  if (PIPE_OR_LOGICAL_OR.test(tail)) return true;
  const execLed = /^\s*exec\b/.test(line);
  if (execLed) {
    // Under exec, `;` and anything after it is unreachable. `&&` still
    // applies to exec-failure (command-not-found) and DOES swallow.
    return /&&/.test(tail) || /&\s*$/.test(tail);
  }
  return /&&|;/.test(tail) || /&\s*$/.test(tail);
}

/**
 * Positive-match only: does `line` actually invoke the gate?
 *
 * Returns `true` ONLY in two forms:
 *   1. Bare line-start invocation — the gate path (possibly quoted, possibly
 *      with a path prefix) is the first token on the line. Examples:
 *        `.claude/hooks/push-review-gate.sh "$@"`
 *        `"/abs/path/.claude/hooks/push-review-gate.sh"`
 *   2. Explicit POSIX delegation keyword immediately before the path —
 *      exactly one of `exec`, `.`, `sh`, `bash`, or `zsh` followed only by
 *      whitespace and then the gate path (again, optionally quoted/prefixed).
 *      `source` is NOT accepted: it is bash-only and not in POSIX sh, so
 *      hooks shebanged `#!/bin/sh` would fail silently on dash/busybox.
 *      Use `.` (dot) — the POSIX equivalent — instead.
 *      Examples:
 *        `exec .claude/hooks/push-review-gate.sh "$@"`
 *        `. .claude/hooks/push-review-gate.sh`
 *        `sh .claude/hooks/push-review-gate.sh`
 *
 * Everything else returns `false`. Specifically, command words like `test`,
 * `[`, `[[`, `chmod`, `cp`, `mv`, `cat`, `echo`, `printf`, `if`, `while`,
 * `#` (comment — already filtered by caller) etc. before the gate path are
 * NOT invocation forms and return `false`.
 *
 * This is a deliberate positive-match (allowlist) approach; a blocklist is
 * insufficient because any new "mention" form would be a false positive until
 * explicitly blocked. The allowlist is stable: the set of ways to actually
 * exec a shell script does not grow.
 */
function looksLikeGateInvocation(line: string): boolean {
  // The character class for path prefixes was previously
  //   [A-Za-z0-9_./${}~-]*
  // which rejected quoted variable expansions in the middle of a path —
  // the idiomatic defensive form `exec "$REA_ROOT"/.claude/hooks/...`
  // contains a `"` after `$REA_ROOT` that was not in the class, so the
  // match stopped before reaching the literal path.
  //
  // R12 F2: extend the char class to include `"` and `'` so that quoted
  // mid-path expansions are consumed as part of the path. This accepts:
  //   - `exec "$REA_ROOT"/.claude/hooks/push-review-gate.sh`
  //   - `exec "$HOME"/project/.claude/hooks/push-review-gate.sh`
  //   - `"$A"'/'.claude/hooks/push-review-gate.sh` (pathological; still works)
  // The false-positive surface is limited: ANY line that begins with a
  // quoted string and then contains the literal gate path will be accepted,
  // but that is exactly the invocation shape we want to recognize — a
  // line like `echo "$X/.claude/hooks/push-review-gate.sh"` would not
  // match because it begins with `echo`, not a path/quoted-prefix.
  const pathChars = '["\'$A-Za-z0-9_./${}~-]';

  // Form 1: gate path (optionally prefixed by quoted/expanded chars) is the
  // first thing on the (already-trimmed) line.
  const bareInvocationRe = new RegExp(
    `^${pathChars}*\\.claude\\/hooks\\/push-review-gate\\.sh(?=\\s|$|[;|&"'()])`,
  );
  if (bareInvocationRe.test(line)) return true;

  // Form 2: POSIX delegation keyword + gate path. `source` is bash-only and
  // excluded; the POSIX equivalent `.` is accepted.
  const delegationRe = new RegExp(
    `^(exec|sh|bash|zsh|\\.)\\s+${pathChars}*\\.claude\\/hooks\\/push-review-gate\\.sh(?=\\s|$|[;|&"'()])`,
  );
  if (delegationRe.test(line)) return true;

  // Form 3 (R22 F3) — absolute interpreter path or `env`-based interpreter.
  // Real hooks commonly invoke the gate as `/bin/sh gate`, `/usr/bin/env sh
  // gate`, or `exec /bin/bash gate`. All of these are unconditional and
  // safe delegations, but forms 1 and 2 rejected them because the
  // command-head token was a path (`/bin/sh`) instead of a bare word.
  //   `/bin/sh .claude/hooks/push-review-gate.sh`
  //   `/usr/bin/sh .claude/hooks/push-review-gate.sh`
  //   `/usr/bin/env sh .claude/hooks/push-review-gate.sh`
  //   `exec /bin/bash .claude/hooks/push-review-gate.sh`
  //
  // The `\/[^\s;|&()]+\/` prefix requires an absolute path with at least one
  // path component, which rejects `/sh` (unlikely on any real system but
  // not a valid interpreter invocation shape). The `env` form accepts either
  // bare `env` (relies on PATH) or an absolute `/usr/bin/env` path.
  const interpreterRe = new RegExp(
    `^(?:exec\\s+)?` +
      `(?:` +
      `(?:\\/[^\\s;|&()]+\\/)?env\\s+(?:sh|bash|zsh)` +
      `|` +
      `\\/[^\\s;|&()]+\\/(?:sh|bash|zsh)` +
      `)` +
      `\\s+${pathChars}*\\.claude\\/hooks\\/push-review-gate\\.sh(?=\\s|$|[;|&"'()])`,
  );
  if (interpreterRe.test(line)) return true;

  return false;
}

/**
 * Classification of an on-disk pre-push file relative to rea governance.
 * Mirrors the decision tree in the module header.
 *
 * `absent` vs `not-a-file` is a deliberate split: when re-checking the
 * destination in the TOCTOU guard we accept `absent` as "safe to proceed
 * with install" but treat a directory/symlink-to-directory that raced
 * into place as a write-path obstruction we must refuse to stomp.
 *
 * `rea-managed-husky` is distinct from `rea-managed`: both represent
 * rea governance-carrying hooks, but the Husky gate is the canonical
 * `.husky/pre-push` that rea copies via `rea init`. It must NEVER be
 * refreshed or overwritten by the fallback installer — the install path
 * maps it to `skip/active-pre-push-present`. `rea-managed` (the fallback
 * marker variant) maps to `refresh` because that file IS the fallback
 * artifact and re-running `rea init` should keep it current.
 */
type HookClassification =
  | { kind: 'rea-managed' }
  | { kind: 'rea-managed-husky' }
  | { kind: 'gate-delegating' }
  | { kind: 'absent' }
  | { kind: 'foreign'; reason: 'no-marker' | 'unreadable' | 'not-a-file' | 'symlink' };

/**
 * Read `hookPath` and classify. Does not consult file mode — callers are
 * expected to combine this with an executable-bit check where relevant.
 *
 * A directory, symlink (regardless of target type), or unreadable file is
 * "foreign" so that we never silently clobber anything we cannot inspect
 * or own. A missing path returns the distinct `absent` kind so the install
 * re-check can distinguish "safe to write here" from "something non-file
 * raced into place".
 *
 * R25 F1 — symlink handling.
 *
 * The previous implementation used `stat()`, which silently follows
 * symlinks. If a repository intentionally pointed `.git/hooks/pre-push` at
 * a centrally-managed hook (a common shared-infra pattern, or the Husky
 * `core.hooksPath` setup where a symlink proxies to a hook under `.husky/`),
 * `stat` would report the target file and classify based on its body. The
 * refresh path then writes via `rename(tmp, dst)` — which replaces the
 * *symlink itself* with a regular file, breaking the central-managed link
 * forever with no operator warning.
 *
 * We now `lstat()` first and treat any symlink as `foreign/symlink`. The
 * caller (`classifyPrePushInstall`) maps `foreign` to `skip` on the install
 * path, so a consumer with a central-hook symlink keeps their setup
 * untouched. Operators who want rea to manage the hook must remove the
 * symlink first — an explicit opt-in that preserves central infra intent.
 */
async function classifyExistingHook(
  hookPath: string,
): Promise<HookClassification> {
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(hookPath);
  } catch (err) {
    // ENOENT is the expected state during an `install` flow. Any other
    // lstat error (permission denied, I/O) is treated as a "not-a-file"
    // foreign signal so we never proceed with a write.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'foreign', reason: 'not-a-file' };
  }
  if (stat.isSymbolicLink()) {
    // R25 F1 — symlinks are intentionally never refreshed. Treat as
    // foreign so the install path skips and the consumer decides whether
    // to unlink manually and re-run `rea init`.
    return { kind: 'foreign', reason: 'symlink' };
  }
  if (!stat.isFile()) {
    return { kind: 'foreign', reason: 'not-a-file' };
  }
  let content: string;
  try {
    content = await fsPromises.readFile(hookPath, 'utf8');
  } catch {
    return { kind: 'foreign', reason: 'unreadable' };
  }
  if (isReaManagedHuskyGate(content)) return { kind: 'rea-managed-husky' };
  // R21 F1: pre-0.4 rea `.husky/pre-push` shape. Same governance, no
  // line-2 marker. Fold into `rea-managed-husky` so upgrade paths treat
  // the legacy hook as a known rea artifact (skip/active rather than
  // foreign) and the canonical manifest reconciler handles the refresh.
  if (isLegacyReaManagedHuskyGate(content)) return { kind: 'rea-managed-husky' };
  if (isReaManagedFallback(content)) return { kind: 'rea-managed' };
  if (referencesReviewGate(content)) return { kind: 'gate-delegating' };
  return { kind: 'foreign', reason: 'no-marker' };
}

/**
 * Content of the fallback hook. Intentionally minimal: delegates all real
 * work to `.claude/hooks/push-review-gate.sh`, which is the shared gate
 * already covered by tests. The only logic here is the "which gate to
 * call" resolution.
 *
 * The stdin contract of git's native pre-push (one line per refspec) is
 * passed through to the gate verbatim. The gate already knows how to parse
 * that shape — see `parse_prepush_stdin` in `push-review-gate.sh`.
 *
 * IMPORTANT: The first two lines are fixed and must remain byte-identical
 * to `FALLBACK_PRELUDE`. `isReaManagedFallback` anchors on them.
 */
function fallbackHookContent(): string {
  return `#!/bin/sh
${FALLBACK_MARKER}
#
# Fallback pre-push hook installed by \`rea init\` when Husky is not the
# active git hook path. Do NOT edit by hand: re-run \`rea init\` to refresh.
#
# This file delegates to .claude/hooks/push-review-gate.sh so there is
# exactly one implementation of the push-review logic across rea, Husky,
# and vanilla git installs. Removing this file disables the protected-path
# Codex gate for terminal-initiated pushes; prefer switching to Husky
# instead.

set -eu

REA_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
GATE="\${REA_ROOT}/${GATE_DELEGATION_TOKEN}"

if [ ! -x "\$GATE" ]; then
  printf 'rea: push-review-gate missing or not executable at %s\\n' "\$GATE" >&2
  printf '  Run \`rea init\` to reinstall, or \`pnpm build\` if rea was built from source.\\n' >&2
  exit 1
fi

exec "\$GATE" "\$@"
`;
}

/**
 * Read `core.hooksPath` via `git config --get`. Mirrors the helper in
 * `commit-msg.ts` — we consult git, never regex-match `.git/config` —
 * so section-scoped keys (`[worktree]`, `[alias]`, includes) resolve the
 * same way git itself resolves them.
 */
async function readHooksPathFromGit(targetDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', targetDir, 'config', '--get', 'core.hooksPath'],
      { encoding: 'utf8' },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a configured `core.hooksPath` (possibly relative) to an absolute
 * path relative to `targetDir`, or `null` if the key is unset.
 */
export async function resolveHooksDir(
  targetDir: string,
): Promise<{ dir: string | null; configured: boolean }> {
  const configured = await readHooksPathFromGit(targetDir);
  if (configured === null) {
    return { dir: null, configured: false };
  }
  const absolute = path.isAbsolute(configured)
    ? configured
    : path.join(targetDir, configured);
  return { dir: absolute, configured: true };
}

export type InstallDecision =
  /** Active pre-push already present and governance-carrying. */
  | { action: 'skip'; reason: 'active-pre-push-present'; hookPath: string }
  /** Consumer owns a non-rea pre-push; refusing to stomp it. */
  | { action: 'skip'; reason: 'foreign-pre-push'; hookPath: string }
  /** Write a fresh hook. */
  | { action: 'install'; hookPath: string }
  /** Refresh an existing rea-managed hook (marker match). */
  | { action: 'refresh'; hookPath: string };

/**
 * Resolve the git-managed hook path for a named hook (e.g. `pre-push`) via
 * `git rev-parse --git-path hooks/<name>`. Returns the absolute path git
 * itself would look at when `core.hooksPath` is unset.
 *
 * This is the correct way to locate `.git/hooks/<name>` in ALL repo shapes:
 *   - Vanilla repo: `<repo>/.git/hooks/<name>`
 *   - Linked worktree: `.git` is a FILE pointing at the worktree's gitdir,
 *     and `git rev-parse --git-path hooks/<name>` returns the per-worktree
 *     hooks directory (shared across worktrees in modern git — see
 *     `extensions.worktreeConfig`). Hard-coding `<repo>/.git/hooks/<name>`
 *     in that shape points at a path that does not exist.
 *   - Submodule: `.git` is a file pointing into the superproject's modules/
 *     dir. `git rev-parse --git-path` resolves to the correct location
 *     inside that gitdir.
 *
 * Returns `null` when `targetDir` is not a git repo or the git binary is
 * unreachable; the caller already short-circuits the non-repo case via
 * `fs.existsSync(.git)`, but we fall back defensively so this seam never
 * throws.
 */
async function resolveGitHookPath(
  targetDir: string,
  hookName: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', targetDir, 'rev-parse', '--git-path', `hooks/${hookName}`],
      { encoding: 'utf8' },
    );
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return null;
    return path.isAbsolute(trimmed) ? trimmed : path.join(targetDir, trimmed);
  } catch {
    return null;
  }
}

/**
 * Resolve the hook path we would target given the current git config and
 * on-disk state. Split out so `installPrePushFallback` can re-resolve it
 * immediately before the write to close the classify → write TOCTOU window.
 *
 * When `core.hooksPath` is unset we ask git for the real hook path rather
 * than hard-coding `<targetDir>/.git/hooks/pre-push`. In a linked worktree
 * `<targetDir>/.git` is a FILE (pointing at the worktree's gitdir), so the
 * hard-coded form resolves to a non-existent path and every classify call
 * would report `absent` against the wrong location — silently installing
 * (or refusing to install) in the wrong place.
 */
async function resolveTargetHookPath(targetDir: string): Promise<{
  hookPath: string;
  hooksPathConfigured: boolean;
}> {
  const hooksInfo = await resolveHooksDir(targetDir);
  if (hooksInfo.configured && hooksInfo.dir !== null) {
    return {
      hookPath: path.join(hooksInfo.dir, 'pre-push'),
      hooksPathConfigured: true,
    };
  }
  const gitHookPath = await resolveGitHookPath(targetDir, 'pre-push');
  if (gitHookPath !== null) {
    return { hookPath: gitHookPath, hooksPathConfigured: false };
  }
  // Last-resort fallback for non-git-repo edge cases (caller's existsSync
  // already guards production paths, but keep behavior stable if git is
  // unreachable).
  return {
    hookPath: path.join(targetDir, '.git', 'hooks', 'pre-push'),
    hooksPathConfigured: false,
  };
}

/**
 * Classify what we should do at `targetDir` based on current state. Pure —
 * reads the filesystem and git config but performs no writes. Split out so
 * tests can drive every branch without going through the write path.
 *
 * NOTE: The result is a snapshot. `installPrePushFallback` re-resolves and
 * re-classifies immediately before writing to defend against a husky
 * install or concurrent `rea init` running between classify and write.
 */
export async function classifyPrePushInstall(
  targetDir: string,
): Promise<InstallDecision> {
  const { hookPath } = await resolveTargetHookPath(targetDir);

  // A file exists at the target. Classify before deciding. We skip the
  // older `fs.existsSync` fast path because `classifyExistingHook` already
  // distinguishes `absent` from foreign-non-file — collapsing both checks
  // into one also removes a tiny TOCTOU window where a file could be
  // unlinked between existsSync and stat.
  const classification = await classifyExistingHook(hookPath);
  if (classification.kind === 'absent') {
    return { action: 'install', hookPath };
  }
  if (classification.kind === 'rea-managed') {
    return { action: 'refresh', hookPath };
  }
  if (classification.kind === 'rea-managed-husky') {
    // The canonical `.husky/pre-push` governance gate. It is the authoritative
    // rea-authored hook for Husky installs and must NEVER be overwritten by the
    // fallback installer. Treat it as governance-carrying (like gate-delegating)
    // so doctor reports `ok` — but map to skip/active-pre-push-present so
    // `installPrePushFallback` never touches it.
    return { action: 'skip', reason: 'active-pre-push-present', hookPath };
  }

  // Non-rea file present. Whether we call it "active governance hook" or
  // "foreign" depends on whether it (a) looks like a real executable git
  // hook AND (b) actually invokes the shared review gate. Mere existence
  // of SOMETHING at the path does NOT satisfy governance — that was the
  // 0.2.x hole where a lint-only husky hook silently bypassed the Codex
  // audit gate.
  let executable = false;
  try {
    const stat = await fsPromises.stat(hookPath);
    executable = stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    executable = false;
  }

  if (executable && classification.kind === 'gate-delegating') {
    // Consumer-owned executable hook that wires the gate. Applies equally
    // to a `.husky/pre-push` under a hooksPath-configured repo AND a
    // user-authored `.git/hooks/pre-push` in a vanilla repo — git will
    // fire whichever one is active, and either one is allowed to own the
    // governance contract as long as it actually execs the gate. We
    // intentionally do NOT gate this on `hooksPathConfigured`: doing so
    // regressed the vanilla-repo case where a user already wired the
    // gate into `.git/hooks/pre-push` themselves (and `rea doctor`
    // correctly reports `ok` on that shape — the two must agree).
    return {
      action: 'skip',
      reason: 'active-pre-push-present',
      hookPath,
    };
  }

  // Everything else is foreign — warn, leave alone, let doctor surface it.
  return {
    action: 'skip',
    reason: 'foreign-pre-push',
    hookPath,
  };
}

export interface PrePushInstallResult {
  decision: InstallDecision;
  /** Absolute path of the file written, if any. */
  written?: string;
  /** User-facing warnings accumulated during install. */
  warnings: string[];
}

/**
 * Remove any stale `.rea-tmp-*` siblings left over from a crashed previous
 * install. Best-effort; non-fatal if scanning fails. Siblings are scoped to
 * the same directory as `dst` so we only touch files we would have created.
 *
 * A previous implementation used a deterministic PID-based suffix which
 * could (a) collide across concurrent installs in the same process, and
 * (b) leave a predictable 0o755 sibling on crash. Random suffixes plus
 * proactive cleanup closes both windows.
 */
async function cleanupStaleTempFiles(dst: string): Promise<void> {
  const dir = path.dirname(dst);
  const prefix = `${path.basename(dst)}.rea-tmp-`;
  let entries: string[];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return; // dir doesn't exist yet — nothing to clean.
  }
  // R24 F1 — verify provenance BEFORE unlinking. The naming convention
  // alone is not enough: a concurrent tool or an adversarial user could
  // drop `pre-push.rea-tmp-XXX` files that we would otherwise delete.
  //
  // Ownership proof is three-fold:
  //   1. `lstat` rejects anything that is not a regular file (symlink,
  //      directory, fifo, socket). We never created a non-file tmp, so
  //      anything else is not ours.
  //   2. The file must be readable and begin with `#!/bin/sh` — our
  //      `writeExecutable` always writes this header as the first line.
  //   3. The body must contain one of our canonical markers
  //      (`HUSKY_GATE_MARKER` or `FALLBACK_MARKER`). Any temp file we
  //      created while crashing mid-write contains exactly these bytes.
  //
  // A 0-byte or partial-write tmp that predates either marker is left
  // alone — if the installer crashes before writing any content, the
  // caller's next run re-opens a fresh random UUID-suffixed file so the
  // leftover is a harmless orphan. We would rather leak an orphan than
  // delete someone else's file.
  const candidates = entries.filter((e) => e.startsWith(prefix));
  await Promise.all(
    candidates.map(async (name) => {
      const abs = path.join(dir, name);
      try {
        const st = await fsPromises.lstat(abs);
        if (!st.isFile()) return;
      } catch {
        return;
      }
      let body: string;
      try {
        body = await fsPromises.readFile(abs, 'utf8');
      } catch {
        return;
      }
      if (!body.startsWith('#!/bin/sh')) return;
      if (
        !body.includes(HUSKY_GATE_MARKER) &&
        !body.includes(FALLBACK_MARKER)
      ) {
        return;
      }
      await fsPromises.unlink(abs).catch(() => undefined);
    }),
  );
}

/**
 * Compare-and-swap guard for the refresh write path. Captures the
 * identity-sensitive stat fields of a rea-managed destination immediately
 * after the safety re-check so that `writeExecutable` can verify the file
 * has not been swapped out before the final rename. Set `kind: 'absent'`
 * for the install (non-refresh) path — no dst file exists at re-check.
 *
 * R14 F2: the refresh path used to blind-rename onto `dst`, so a consumer
 * editor or another installer that replaced the file between classify and
 * write would be silently stomped. `dev+ino+mtimeMs+size` is sufficient to
 * detect any common replacement (rename, remove+recreate, in-place rewrite);
 * the irreducible window is the stat→rename gap, which is microseconds.
 */
type RefreshGuard =
  | { kind: 'absent' }
  | {
      kind: 'present';
      dev: number;
      ino: number;
      mtimeMs: number;
      size: number;
    };

/**
 * Atomically write `content` to `dst` with executable bits set.
 *
 * When `exclusive` is true (new installs): primary path is `link(tmp, dst)`
 * — POSIX guarantees the hardlink creation is atomic: `dst` does not exist
 * until the operation succeeds, and then it points to the FULLY-WRITTEN
 * temp file. A concurrent reader (e.g. git firing the hook) either sees
 * the file absent or the complete content, never a partial write. Fails
 * with EEXIST if a file appeared at `dst` after the caller's re-check.
 *
 * Codex R21 F2: the previous implementation used
 * `copyFile(tmp, dst, COPYFILE_EXCL)`, which opens dst with
 * `O_CREAT|O_EXCL|O_WRONLY` and then writes content through it. The
 * create IS atomic but the subsequent write is not — `dst` is observable
 * empty/partial by concurrent readers during the copy, and a crash mid-
 * copy leaves a broken live hook. For a governance primitive that's a
 * real bypass window. `link()` closes it.
 *
 * On `EXDEV`, `EPERM`, or `ENOSYS` (cross-device mounts, some network
 * filesystems, sandboxes that disable `link(2)`), fall back to
 * `copyFile(COPYFILE_EXCL)`. The fallback is strictly worse but
 * unavoidable when the kernel refuses the primary path; the warning
 * accompanying this code is documentation, not configuration.
 *
 * When `exclusive` is false (refreshes): uses `rename()` — the destination
 * is expected to exist and be rea-managed. Immediately before the rename,
 * re-stats `dst` and verifies (dev, ino, mtimeMs, size) match `guard`.
 * Mismatch throws an error with `code = 'REA_REFRESH_RACE'` so the caller
 * can downgrade to a foreign-pre-push skip instead of stomping an
 * unexpected replacement. Falls back to `copyFile()` on EXDEV with the
 * same guard applied against a stat taken just before the copy.
 *
 * R14 F2: the previous implementation used `rename(tmp, dst)` without any
 * final destination check. Even with the lock-scoped re-check upstream, a
 * concurrent writer outside the lock (Husky, a user editor, another tool)
 * could rewrite `dst` between the re-check and the rename; the blind
 * rename would silently replace their hook with ours. The guard closes
 * every detectable race window short of the kernel-level atomic swap
 * (renameat2 RENAME_EXCHANGE) which Node does not expose.
 */
class RefreshRaceError extends Error {
  code = 'REA_REFRESH_RACE' as const;
  constructor(dst: string) {
    super(
      `refresh aborted: ${dst} was modified by another writer between ` +
        `the safety re-check and the rename. Re-run \`rea init\` to re-evaluate.`,
    );
    this.name = 'RefreshRaceError';
  }
}

async function verifyRefreshGuard(
  dst: string,
  guard: RefreshGuard,
): Promise<void> {
  if (guard.kind === 'absent') return;
  let current: fs.Stats;
  try {
    current = await fsPromises.stat(dst);
  } catch {
    // File vanished — a consumer removed it. Aborting the refresh is
    // safer than re-creating a file where one no longer exists; the user
    // can re-run `rea init` to land a fresh install.
    throw new RefreshRaceError(dst);
  }
  if (
    current.dev !== guard.dev ||
    current.ino !== guard.ino ||
    current.mtimeMs !== guard.mtimeMs ||
    current.size !== guard.size
  ) {
    throw new RefreshRaceError(dst);
  }
}

export interface WriteExecutableResult {
  /**
   * R25 F2 — set to true when the install path had to use a non-atomic
   * fallback (copyFile after link() refused). Callers surface this as a
   * warning to the operator so they know publication was best-effort on
   * this filesystem rather than atomic.
   */
  degradedFromAtomic: boolean;
}

async function writeExecutable(
  dst: string,
  content: string,
  exclusive: boolean,
  guard: RefreshGuard = { kind: 'absent' },
): Promise<WriteExecutableResult> {
  await fsPromises.mkdir(path.dirname(dst), { recursive: true });
  // Random suffix + `wx` open flag: PID was observed to collide during
  // concurrent installs in the same process (e.g. two worktrees running
  // `rea init` back-to-back, or a test harness driving the function in
  // parallel). UUIDs are collision-free for our purposes and `wx` fails
  // loudly if anything we didn't expect is in the way.
  const tmp = `${dst}.rea-tmp-${crypto.randomUUID()}`;
  // `open` with `'wx'` == O_WRONLY|O_CREAT|O_EXCL. Mode bits on the open
  // call itself so the file is executable the moment it appears on disk.
  const handle = await fsPromises.open(tmp, 'wx', 0o755);
  try {
    await handle.writeFile(content, 'utf8');
    // Some platforms ignore the open-time mode argument; force the bits
    // again before finalize for belt-and-suspenders.
    await handle.chmod(0o755);
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    if (exclusive) {
      // R21 F2: link-first for ATOMIC publication. `link(2)` atomically
      // creates `dst` pointing at the fully-written `tmp`; a concurrent
      // reader either sees the file absent or the complete content, never
      // a partial write. EEXIST still propagates if dst appeared after
      // our safety re-check (exclusive semantics preserved).
      try {
        await fsPromises.link(tmp, dst);
        await fsPromises.unlink(tmp).catch(() => undefined);
        return { degradedFromAtomic: false };
      } catch (linkErr) {
        const e = linkErr as NodeJS.ErrnoException;
        // EEXIST is the one exclusive-violation case we MUST propagate —
        // another writer won the race, we must abort the install.
        if (e.code === 'EEXIST') throw linkErr;
        // EXDEV: cross-device mount (link doesn't span filesystems).
        // EPERM / ENOSYS: some network filesystems and sandboxes refuse
        //                  or don't implement link(2).
        if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'ENOSYS') {
          throw linkErr;
        }
        // R25 F2 — non-atomic fallback. `copyFile(..., COPYFILE_EXCL)`
        // still refuses to clobber an existing `dst`, so the
        // exclusive-semantic half of the atomic contract is preserved,
        // but the copy itself is not instantaneous: a crash or concurrent
        // reader CAN observe a partially-written live hook. We return
        // `degradedFromAtomic: true` so the caller can surface a warning
        // to the operator. This is the narrow, explicitly-signaled
        // escape hatch for filesystems where link(2) is unavailable;
        // we deliberately do not fail closed (which would make rea
        // unusable on e.g. cross-mount `.git` dirs) but we also refuse
        // to silently lose the atomicity guarantee.
        await fsPromises.copyFile(tmp, dst, fs.constants.COPYFILE_EXCL);
        await fsPromises.unlink(tmp).catch(() => undefined);
        return { degradedFromAtomic: true };
      }
    }
    // Refresh: verify dst still matches the identity captured at the
    // re-check before the atomic replace. Rename is atomic on the same
    // filesystem.
    await verifyRefreshGuard(dst, guard);
    try {
      await fsPromises.rename(tmp, dst);
      return { degradedFromAtomic: false };
    } catch (renameErr) {
      const e = renameErr as NodeJS.ErrnoException;
      if (e.code !== 'EXDEV') throw renameErr;
      // Cross-device mount: verify again, then fall back to copy+unlink.
      // The extra verify is cheap and narrows the window further.
      // Non-atomic — same R25 F2 rationale applies on refresh.
      await verifyRefreshGuard(dst, guard);
      await fsPromises.copyFile(tmp, dst);
      await fsPromises.unlink(tmp).catch(() => undefined);
      return { degradedFromAtomic: true };
    }
  } catch (err) {
    await fsPromises.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Options controlling `installPrePushFallback`. Exposed primarily for
 * tests — production callers get sensible defaults.
 */
export interface InstallPrePushOptions {
  /**
   * Serialize concurrent installs via an advisory lockfile under `.git/`.
   * Defaults to `true`. Tests that simulate concurrent races must keep
   * this on; the only reason to turn it off is unit-testing a specific
   * write branch in isolation.
   */
  useLock?: boolean;
  /**
   * Called exactly once inside the advisory lock, after classification
   * and before re-resolution + write. Test-only seam that lets a race
   * partner drop a file in between those two steps so we can assert on
   * the re-check behavior. Invoked with the classified target path.
   * Production callers never set this.
   */
  onBeforeReresolve?: (hookPath: string) => Promise<void> | void;
  /**
   * Called inside the lock, after the safety re-check passes but
   * immediately before `writeExecutable`. Test-only seam: creates a
   * file at the hook path to exercise the EEXIST-from-link path that
   * guards the remaining TOCTOU window. Production callers never set this.
   */
  onBeforeWrite?: (hookPath: string) => Promise<void> | void;
}

/**
 * Resolve the actual git common directory for `targetDir`. In a linked
 * worktree or submodule, `<targetDir>/.git` is a FILE that points at the
 * real git dir (`gitdir: /path/to/..../git/worktrees/<name>`), and the
 * "common" directory — where locks and shared state belong — lives one
 * level up via `git rev-parse --git-common-dir`. In a vanilla repo the
 * common dir is just `<targetDir>/.git`.
 *
 * Returns `null` if `targetDir` is not a git repo (the caller already
 * short-circuits this via `fs.existsSync(.git)`, but we handle the
 * fallback anyway so we never throw from the lock seam).
 */
async function resolveGitCommonDir(targetDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', targetDir, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8' },
    );
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return null;
    return path.isAbsolute(trimmed) ? trimmed : path.join(targetDir, trimmed);
  } catch {
    return null;
  }
}

/**
 * Acquire a short-lived advisory lock under the git common directory so
 * two concurrent `rea init` runs do not race on the same pre-push hook.
 *
 * The lock lives under `<git-common-dir>/rea-pre-push-install.lock`. In
 * a vanilla repo that's `<repo>/.git/rea-pre-push-install.lock`; in a
 * linked worktree `.git` is a FILE, not a directory, so we resolve via
 * `git rev-parse --git-common-dir` to find the real writable location.
 * Writing inside the .git FILE would throw ENOTDIR and regress the very
 * worktree/submodule cases husky is most common in.
 *
 * proper-lockfile is already a runtime dep (audit chain uses it). Stale
 * timeout is deliberately short — install is a few hundred milliseconds
 * in the worst case, and a crashed run should not block the next one for
 * long.
 *
 * If the git common dir cannot be resolved (unreachable git binary, not a
 * repo, etc.), run without a lock rather than throwing. The outer caller
 * already verified `.git` exists, so this is a belt-and-suspenders path.
 */
async function withInstallLock<T>(
  targetDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const commonDir = await resolveGitCommonDir(targetDir);
  if (commonDir === null) {
    // No lock available, but the work is still safe — we still do the
    // TOCTOU re-check plus `wx` open. Concurrency hardening degrades to
    // best-effort in this edge case.
    return fn();
  }

  // Ensure the common dir exists before proper-lockfile tries to create
  // a lockfile inside it. `git rev-parse --git-common-dir` returning a
  // path is not a promise the path currently exists (submodules mid-init,
  // etc.), so mkdir defensively.
  await fsPromises.mkdir(commonDir, { recursive: true });

  const release = await properLockfile.lock(commonDir, {
    stale: 10_000,
    retries: {
      retries: 20,
      factor: 1.3,
      minTimeout: 15,
      maxTimeout: 200,
      randomize: true,
    },
    realpath: false,
    lockfilePath: path.join(commonDir, 'rea-pre-push-install.lock'),
  });
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // Release can legitimately fail if stale-detection already freed
      // the lockfile. Work completed; swallow.
    }
  }
}

/**
 * Install (or refresh, or skip) the fallback pre-push hook at `targetDir`.
 * Idempotent: safe to call on every `rea init`, including re-runs over an
 * existing install. Never overwrites a foreign hook.
 *
 * Requires `targetDir/.git` to exist. Non-git directories are skipped with
 * a warning — same shape as `installCommitMsgHook`.
 */
export async function installPrePushFallback(
  targetDir: string,
  options: InstallPrePushOptions = {},
): Promise<PrePushInstallResult> {
  const result: PrePushInstallResult = {
    decision: { action: 'install', hookPath: '' },
    warnings: [],
  };

  const gitDir = path.join(targetDir, '.git');
  if (!fs.existsSync(gitDir)) {
    result.warnings.push(
      '.git/ not found — skipping pre-push fallback (not a git repo?)',
    );
    // Return a synthetic skip decision so callers can log uniformly.
    result.decision = {
      action: 'skip',
      reason: 'foreign-pre-push',
      hookPath: path.join(targetDir, '.git', 'hooks', 'pre-push'),
    };
    return result;
  }

  const useLock = options.useLock !== false;
  const run = async (): Promise<PrePushInstallResult> => {
    // Classify once for the caller-visible decision. We re-resolve
    // immediately before the write to close the TOCTOU window.
    const decision = await classifyPrePushInstall(targetDir);
    result.decision = decision;

    switch (decision.action) {
      case 'install':
      case 'refresh': {
        // R24 F1 — stale-temp cleanup runs ONLY on write paths. Running
        // it unconditionally (pre-R24 behavior) meant a `skip/foreign` or
        // `skip/active-pre-push-present` decision still scanned and
        // unlinked any sibling matching `pre-push.rea-tmp-*` — which
        // under an adversarial or concurrent-tool scenario could delete
        // unrelated files. The cleanup is only a hygiene step for
        // recovery from a crashed write, so scope it to the branches
        // that actually write.
        await cleanupStaleTempFiles(decision.hookPath);
        if (options.onBeforeReresolve !== undefined) {
          await options.onBeforeReresolve(decision.hookPath);
        }

        // Re-resolve hooksPath and re-inspect the destination just before
        // the rename. Between the classification above and this point,
        // `husky install` could have flipped `core.hooksPath`, or a second
        // `rea init` could have landed a file. Bail out safely if anything
        // unexpected appeared; the user can re-run to converge.
        const resolved = await resolveTargetHookPath(targetDir);
        if (resolved.hookPath !== decision.hookPath) {
          result.warnings.push(
            `core.hooksPath changed during install — expected ${decision.hookPath}, ` +
              `now ${resolved.hookPath}. Re-run \`rea init\` to install into the current location.`,
          );
          result.decision = {
            action: 'skip',
            reason: 'foreign-pre-push',
            hookPath: resolved.hookPath,
          };
          return result;
        }

        // Re-classify the destination. For `install` the fast rule is
        // "must still be absent" — a regular file, directory, symlink, or
        // unreadable entry that raced into place is all equally unsafe to
        // stomp, and refusing early avoids a rename() that would either
        // succeed silently against a foreign file or fail noisily against
        // a non-file. For `refresh` the rule is "still rea-managed"; a
        // file that got replaced by a consumer between classify and write
        // must not be clobbered.
        const reCheck = await classifyExistingHook(decision.hookPath);
        if (decision.action === 'install') {
          if (reCheck.kind !== 'absent') {
            // Something appeared at the path (regular file, directory,
            // symlink, or unreadable entry). Do NOT stomp.
            result.warnings.push(
              `pre-push hook at ${decision.hookPath} appeared during install — ` +
                `leaving it untouched. Re-run \`rea init\` to re-evaluate.`,
            );
            result.decision = {
              action: 'skip',
              reason: 'foreign-pre-push',
              hookPath: decision.hookPath,
            };
            return result;
          }
        } else {
          // refresh
          if (reCheck.kind === 'rea-managed-husky') {
            // R11 F2: a canonical Husky gate replaced the fallback between
            // classify and write. Do NOT proceed to writeExecutable — the
            // Husky gate is the authoritative rea-authored hook and must
            // never be clobbered by the fallback. Terminal skip.
            result.decision = {
              action: 'skip',
              reason: 'active-pre-push-present',
              hookPath: decision.hookPath,
            };
            return result;
          }
          if (reCheck.kind !== 'rea-managed') {
            result.warnings.push(
              `pre-push hook at ${decision.hookPath} is no longer rea-managed — ` +
                `leaving it untouched.`,
            );
            result.decision = {
              action: 'skip',
              reason: 'foreign-pre-push',
              hookPath: decision.hookPath,
            };
            return result;
          }
        }

        // R14 F2: capture the identity of the destination as it stood at
        // re-check time. `writeExecutable` will re-verify right before the
        // rename so a replacement landed by a concurrent writer (outside
        // our install lock) cannot be silently stomped. Only refreshes
        // need a guard; installs use `COPYFILE_EXCL` which is inherently
        // race-safe against new files appearing at `dst`.
        let refreshGuard: RefreshGuard = { kind: 'absent' };
        if (decision.action === 'refresh') {
          try {
            const s = await fsPromises.stat(decision.hookPath);
            refreshGuard = {
              kind: 'present',
              dev: s.dev,
              ino: s.ino,
              mtimeMs: s.mtimeMs,
              size: s.size,
            };
          } catch {
            // The file vanished between reCheck and this stat. Abort the
            // refresh — a missing file at refresh time means something
            // outside our control removed it; re-running `rea init` will
            // re-install fresh.
            result.warnings.push(
              `pre-push hook at ${decision.hookPath} disappeared before refresh — ` +
                `re-run \`rea init\` to re-install.`,
            );
            result.decision = {
              action: 'skip',
              reason: 'foreign-pre-push',
              hookPath: decision.hookPath,
            };
            return result;
          }
        }

        if (options.onBeforeWrite !== undefined) {
          await options.onBeforeWrite(decision.hookPath);
        }

        try {
          const writeResult = await writeExecutable(
            decision.hookPath,
            fallbackHookContent(),
            decision.action === 'install',
            refreshGuard,
          );
          if (writeResult.degradedFromAtomic) {
            // R25 F2 — link(2) unavailable on this filesystem; publication
            // used copyFile(EXCL) which is exclusive-safe but not atomic.
            // A concurrent reader or a crash mid-copy could observe the
            // hook in a partially-written state. Operators should be
            // aware so they can weigh whether to run `rea init` again or
            // relocate `.git` to a filesystem that supports hardlinks.
            result.warnings.push(
              `pre-push hook at ${decision.hookPath} was published non-atomically ` +
                `(link(2) unavailable on this filesystem). The file is in place and ` +
                `correct, but a crash mid-install could leave a partial hook. ` +
                `Consider moving the repo to a filesystem that supports hardlinks ` +
                `for atomic publication.`,
            );
          }
        } catch (writeErr) {
          const e = writeErr as NodeJS.ErrnoException;
          if (e.code === 'EEXIST') {
            // A file appeared between the re-check and the copyFile(EXCL).
            // Bail safely.
            result.warnings.push(
              `pre-push hook appeared at ${decision.hookPath} after the safety check — ` +
                `leaving it untouched. Re-run \`rea init\` to re-evaluate.`,
            );
            result.decision = {
              action: 'skip',
              reason: 'foreign-pre-push',
              hookPath: decision.hookPath,
            };
            return result;
          }
          if (e.code === 'REA_REFRESH_RACE') {
            // R14 F2: the destination changed between the safety re-check
            // and the rename — a consumer or another installer landed a
            // file at the hook path outside our advisory lock. Fail
            // closed: do not stomp the replacement. The user can re-run
            // `rea init` to re-evaluate.
            result.warnings.push(
              `pre-push hook at ${decision.hookPath} was modified during refresh — ` +
                `leaving the current file in place. Re-run \`rea init\` to re-evaluate.`,
            );
            result.decision = {
              action: 'skip',
              reason: 'foreign-pre-push',
              hookPath: decision.hookPath,
            };
            return result;
          }
          throw writeErr;
        }
        result.written = decision.hookPath;
        if (decision.action === 'refresh') {
          // Informational — refreshing our own marker is the idempotent
          // path, not a warning condition.
          warn(`refreshed rea-managed pre-push at ${decision.hookPath}`);
        }
        return result;
      }
      case 'skip': {
        if (decision.reason === 'foreign-pre-push') {
          result.warnings.push(
            `pre-push hook at ${decision.hookPath} is not rea-managed — ` +
              `leaving it untouched. Add \`exec ${GATE_DELEGATION_TOKEN} "$@"\` ` +
              `to it manually to wire the Codex audit gate.`,
          );
        }
        // 'active-pre-push-present' is the happy husky path — no warning.
        return result;
      }
    }
  };

  if (!useLock) return run();
  return withInstallLock(targetDir, run);
}

/**
 * Doctor check: at least one pre-push hook (Husky OR git fallback OR the
 * configured hooksPath location) must exist AND be executable AND carry
 * governance (rea marker or gate delegation). Returns a small record the
 * doctor module can turn into a CheckResult.
 *
 * "Executable" is defined as having any of the user/group/other exec bits
 * set, matching the existing `checkHooksInstalled` convention. A file that
 * is executable but does not wire the Codex review gate is intentionally
 * classified as non-governing: `ok=false` + `activeForeign=true`, which
 * doctor turns into a `warn`, not a `pass`.
 */
export interface PrePushDoctorState {
  /** Every candidate path we consulted, with its live status on disk. */
  candidates: Array<{
    path: string;
    exists: boolean;
    executable: boolean;
    /** `true` when the file content carries our anchored rea prelude. */
    reaManaged: boolean;
    /** `true` when the body references the shared review gate. */
    delegatesToGate: boolean;
  }>;
  /**
   * The candidate path git would actually fire right now, given current
   * `core.hooksPath`. May or may not exist.
   */
  activePath: string;
  /**
   * True when the active candidate exists, is executable, AND carries
   * governance (rea marker OR references the review gate).
   */
  ok: boolean;
  /**
   * True when the active candidate exists + is executable but does NOT
   * carry governance. This is the "silent bypass" case doctor surfaces as
   * a warn. Distinct from `ok=false + absent` (which is a hard fail).
   */
  activeForeign: boolean;
}

export async function inspectPrePushState(
  targetDir: string,
): Promise<PrePushDoctorState> {
  const candidatePaths: string[] = [];
  const hooksInfo = await resolveHooksDir(targetDir);
  // Resolved via `git rev-parse --git-path hooks/pre-push` so linked
  // worktrees (where `.git` is a FILE, not a directory) are handled
  // correctly. Fall back to the hard-coded form only when git cannot
  // answer — the inspect path must never throw.
  const gitHookPath =
    (await resolveGitHookPath(targetDir, 'pre-push')) ??
    path.join(targetDir, '.git', 'hooks', 'pre-push');

  // Priority order matches install policy:
  //   1. Configured hooksPath (husky or custom)
  //   2. `.git/hooks/pre-push` (fallback target, via git-path resolution)
  //   3. `.husky/pre-push` (source-of-truth copy, may be inert if husky
  //      isn't wired up yet)
  if (hooksInfo.configured && hooksInfo.dir !== null) {
    candidatePaths.push(path.join(hooksInfo.dir, 'pre-push'));
  }
  candidatePaths.push(gitHookPath);
  candidatePaths.push(path.join(targetDir, '.husky', 'pre-push'));

  // De-duplicate while preserving order (hooksPath may already point at
  // `.husky/` on husky projects).
  const seen = new Set<string>();
  const uniq = candidatePaths.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  const candidates: PrePushDoctorState['candidates'] = [];
  for (const p of uniq) {
    let exists = false;
    let executable = false;
    let reaManaged = false;
    let delegatesToGate = false;
    try {
      const stat = await fsPromises.stat(p);
      exists = stat.isFile();
      if (exists) {
        executable = (stat.mode & 0o111) !== 0;
        try {
          const content = await fsPromises.readFile(p, 'utf8');
          reaManaged =
            isReaManagedFallback(content) ||
            isReaManagedHuskyGate(content) ||
            isLegacyReaManagedHuskyGate(content);
          delegatesToGate = referencesReviewGate(content);
        } catch {
          // unreadable — leave both false
        }
      }
    } catch {
      // ENOENT or other stat failure — leave defaults.
    }
    candidates.push({ path: p, exists, executable, reaManaged, delegatesToGate });
  }

  // A candidate only counts as "active" when git would actually fire it.
  // If core.hooksPath is set, only the candidate inside that directory is
  // active. Otherwise only `.git/hooks/pre-push` is active. `.husky/pre-push`
  // on its own, without hooksPath pointing at `.husky/`, never fires —
  // report it for context but do not let it satisfy `ok`.
  const activePath =
    hooksInfo.configured && hooksInfo.dir !== null
      ? path.join(hooksInfo.dir, 'pre-push')
      : gitHookPath;
  const active = candidates.find((c) => c.path === activePath);
  const activeExistsExec =
    active !== undefined && active.exists && active.executable;
  const activeGoverns =
    active !== undefined && (active.reaManaged || active.delegatesToGate);
  const ok = activeExistsExec && activeGoverns;
  const activeForeign = activeExistsExec && !activeGoverns;
  // R13 F3: the earlier `activeSuspect` field downgraded active-foreign
  // doctor results to WARN when the file substring-mentioned the gate path.
  // That was unsafe: any comment, echo, or dead string mentioning the path
  // triggered the downgrade, so `rea doctor` could exit 0 on an ungoverned
  // hook. The classifier must fail closed — either the parser confirms a
  // real invocation (and `delegatesToGate` is already true) or doctor
  // reports `fail`.
  return { candidates, activePath, ok, activeForeign };
}
