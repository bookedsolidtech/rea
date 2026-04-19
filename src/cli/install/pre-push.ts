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
 *                         (exit must appear between `then` and the matching `fi`)
 *
 * Patterns rejected (previously accepted by R11's signature heuristic):
 *   - `[ -f .rea/HALT ] && :`          — no-op stub
 *   - `if [ -f .rea/HALT ]; then :; fi` — no-op stub
 *   - `# check .rea/HALT`               — comment only
 *   - `echo .rea/HALT`                   — print, not enforce
 *
 * R12 F1: the previous `hasHaltTest` regex allowed a no-op body. We now
 * require proof that the HALT match actually exits the script.
 */
function hasHaltEnforcement(content: string): boolean {
  // Strip comments before scanning so block-form patterns that span lines
  // still match, while `# ... exit ...` does not count.
  const stripped = content
    .split(/\r?\n/)
    .map((raw) => {
      const t = raw.trimStart();
      return t.startsWith('#') ? '' : raw;
    })
    .join('\n');

  // Pattern A — short-circuit. The HALT test is followed directly by `&&`
  // and then an `exit` (optionally wrapped in `{ ... exit ...; }`).
  const shortCircuit =
    /(?:\[[ \t]+-f[^\n]*\.rea\/HALT[^\n]*\]|\btest[ \t]+-f[^\n]*\.rea\/HALT)[ \t]*&&[ \t]*(?:\{[^}]*?\bexit\b|\bexit\b)/;
  if (shortCircuit.test(stripped)) return true;

  // Pattern B — block form. Match `if <halt-test>` forward (non-greedy) to
  // the first `fi`, and require `exit` to appear between `then` and `fi`.
  // `[\s\S]` instead of `.` so the match spans newlines.
  const blockForm =
    /\bif\b[ \t]+(?:\[[ \t]+-f[^\n]*\.rea\/HALT[^\n]*\]|test[ \t]+-f[^\n]*\.rea\/HALT[^\n]*)[\s\S]*?\bthen\b[\s\S]*?\bexit\b[\s\S]*?\bfi\b/;
  if (blockForm.test(stripped)) return true;

  return false;
}

/**
 * True when `content` contains a shell command that CAN FAIL on a missing
 * `codex.review` / `.rea/audit.jsonl` match. A bare `echo` / `printf` of
 * those tokens does NOT count — `echo` always returns 0.
 *
 * Check commands accepted (any one of these on a non-comment line that also
 * references `.rea/audit.jsonl` or `codex.review`):
 *   - `grep` / `egrep` / `fgrep`  — classic POSIX pattern match
 *   - `rg`                         — ripgrep
 *   - `awk` / `sed`               — stream editors
 *   - `test` / `[` / `[[`         — POSIX/Bash test conditionals
 *
 * R12 F1: the previous `hasAuditReference` regex accepted ANY non-comment
 * mention. The spoof `echo codex.review .rea/audit.jsonl` satisfied it
 * without ever checking the log. We now require pairing with a command
 * that propagates failure when the expected content is absent.
 */
function hasAuditCheck(content: string): boolean {
  const checkCmd = /\b(grep|egrep|fgrep|rg|awk|sed|test)\b|(^|\s)(\[|\[\[)\s/;
  // `codex\\?\.review` accepts both `codex.review` (literal) and
  // `codex\.review` (the shape used when the token appears inside a grep
  // regex, where the dot is escaped for grep's interpretation). The
  // shipped `.husky/pre-push` uses the latter form.
  const auditToken = /\.rea\/audit\.jsonl|codex\\?\.review/;
  for (const raw of content.split(/\r?\n/)) {
    const t = raw.trimStart();
    if (t.startsWith('#')) continue;
    if (!auditToken.test(t)) continue;
    // The audit token is on this line — require a check command on the
    // same line. Cross-line pairings (e.g., `AUDIT=.rea/audit.jsonl` then
    // `grep ... "$AUDIT"`) are not accepted here because the check
    // command's argument list may not contain the token literal; the
    // shipped `.husky/pre-push` places both on the same line in at least
    // two places, so same-line is a reasonable floor.
    if (checkCmd.test(t)) return true;
  }
  return false;
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
  // First pass: variable indirection. If the caller wrote the path into a
  // shell variable and execs the variable, same-line matching won't catch it.
  // Scan for assignment + later invocation of the same variable.
  if (hasVariableGateInvocation(content)) return true;

  const lines = content.split(/\r?\n/);
  let exitedBeforeGate = false;
  let depth = 0;
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
    if (/^(if|for|while|case)\b/.test(line)) depth++;
    if (/^(fi|done|esac)\b/.test(line)) depth = Math.max(0, depth - 1);
    if (depth === 0 && /^(exit|return)(\s+\d+)?$/.test(line)) {
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
  const lines = content.split(/\r?\n/).map((l) => {
    let t = l.trim();
    if (t.startsWith('#')) return '';
    const hashIdx = t.indexOf('#');
    if (hashIdx > 0) {
      const before = t[hashIdx - 1];
      if (before === ' ' || before === '\t') t = t.slice(0, hashIdx).trimEnd();
    }
    return t;
  });

  // Find variable assignments whose RHS contains the gate token. Shape:
  //   [export ]NAME=<value-with-gate>
  // Value may be quoted with " or ' and may contain $-expansions. The gate
  // literal must be substring-present in the RHS.
  const assignRe = /^(?:export[ \t]+|readonly[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
  const gateVars = new Set<string>();
  for (const line of lines) {
    const m = line.match(assignRe);
    if (!m) continue;
    const name = m[1];
    const rhs = m[2];
    if (name === undefined || rhs === undefined) continue;
    if (rhs.includes(GATE_DELEGATION_TOKEN)) gateVars.add(name);
  }
  if (gateVars.size === 0) return false;

  // Track depth + early-exit gates (same rules as referencesReviewGate).
  let exitedBeforeGate = false;
  let depth = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (/^(if|for|while|case)\b/.test(line)) depth++;
    if (/^(fi|done|esac)\b/.test(line)) depth = Math.max(0, depth - 1);
    if (depth === 0 && /^(exit|return)(\s+\d+)?$/.test(line)) {
      exitedBeforeGate = true;
    }
    // Check whether this line invokes any of the gate variables. Pattern:
    //   ^(exec|sh|bash|zsh|\.)\s+["']?\$\{?VAR\}?["']?
    for (const v of gateVars) {
      const pattern = new RegExp(
        `^(exec|sh|bash|zsh|\\.)[ \\t]+["']?\\$\\{?${v}\\}?["']?(?=[ \\t;|&"'()]|$)`,
      );
      if (!pattern.test(line)) continue;
      if (depth !== 0) continue;
      if (exitedBeforeGate) continue;
      // Apply status-swallowing operator check to the variable-invocation tail.
      // Parse the portion after the closing VAR reference for continuation
      // operators, ignoring a trailing `;` when the line starts with `exec`
      // (exec replaces the shell — anything after is unreachable).
      const execLed = /^exec\b/.test(line);
      // Isolate the tail after the VAR reference for the check.
      const varIdx = line.search(
        new RegExp(`\\$\\{?${v}\\}?`),
      );
      if (varIdx === -1) continue;
      const afterVar = line
        .slice(varIdx)
        .replace(new RegExp(`^\\$\\{?${v}\\}?["']?`), '');
      let tail = afterVar
        .replace(/\d*[<>]&\d*-?/g, ' ')
        .replace(/&>>?/g, ' ');
      if (execLed) {
        if (/\|\||&&/.test(tail) || /&\s*$/.test(tail)) continue;
      } else {
        if (/\|\||&&|;/.test(tail) || /&\s*$/.test(tail)) continue;
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
 */
function hasContinuationOperator(line: string): boolean {
  const gateIdx = line.indexOf(GATE_DELEGATION_TOKEN);
  if (gateIdx === -1) return false;
  let tail = line.slice(gateIdx + GATE_DELEGATION_TOKEN.length);
  tail = tail.replace(/\d*[<>]&\d*-?/g, ' ');
  tail = tail.replace(/&>>?/g, ' ');
  const execLed = /^\s*exec\b/.test(line);
  if (execLed) {
    // Under exec, `;` and anything after it is unreachable. `||` and `&&`
    // still apply to exec-failure (command-not-found) and DO swallow.
    return /\|\||&&/.test(tail) || /&\s*$/.test(tail);
  }
  return /\|\||&&|;/.test(tail) || /&\s*$/.test(tail);
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
  | { kind: 'foreign'; reason: 'no-marker' | 'unreadable' | 'not-a-file' };

/**
 * Read `hookPath` and classify. Does not consult file mode — callers are
 * expected to combine this with an executable-bit check where relevant.
 *
 * A directory, symlink-to-directory, or unreadable file is "foreign/not-
 * a-file" so that we never silently clobber anything we cannot inspect.
 * A missing path returns the distinct `absent` kind so the install
 * re-check can distinguish "safe to write here" from "something non-file
 * raced into place".
 */
async function classifyExistingHook(
  hookPath: string,
): Promise<HookClassification> {
  let stat: fs.Stats;
  try {
    stat = await fsPromises.stat(hookPath);
  } catch (err) {
    // ENOENT is the expected state during an `install` flow. Any other
    // stat error (permission denied, I/O) is treated as a "not-a-file"
    // foreign signal so we never proceed with a write.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'foreign', reason: 'not-a-file' };
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
  await Promise.all(
    entries
      .filter((e) => e.startsWith(prefix))
      .map((e) =>
        fsPromises.unlink(path.join(dir, e)).catch(() => undefined),
      ),
  );
}

/**
 * Atomically write `content` to `dst` with executable bits set.
 *
 * When `exclusive` is true (new installs): uses `copyFile(COPYFILE_EXCL)`
 * which opens dst with O_CREAT|O_EXCL — atomic and works on network
 * filesystems and cross-device mounts (unlike `link()` which fails with
 * EXDEV/EPERM/ENOSYS on those). Fails with EEXIST if a file appeared at
 * `dst` after the caller's re-check.
 *
 * When `exclusive` is false (refreshes): uses `rename()` — the destination
 * is expected to exist and be rea-managed; falls back to `copyFile()` on
 * EXDEV (cross-device rename).
 */
async function writeExecutable(
  dst: string,
  content: string,
  exclusive: boolean,
): Promise<void> {
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
      // COPYFILE_EXCL opens dst with O_CREAT|O_EXCL — fails with EEXIST if
      // dst appeared after our safety re-check; works on network FS and
      // cross-device mounts unlike link().
      await fsPromises.copyFile(tmp, dst, fs.constants.COPYFILE_EXCL);
      await fsPromises.unlink(tmp).catch(() => undefined);
      return;
    }
    // Refresh: rename is atomic on the same filesystem.
    try {
      await fsPromises.rename(tmp, dst);
      return;
    } catch (renameErr) {
      const e = renameErr as NodeJS.ErrnoException;
      if (e.code !== 'EXDEV') throw renameErr;
      // Cross-device mount: fall back to copy then unlink.
      await fsPromises.copyFile(tmp, dst);
      await fsPromises.unlink(tmp).catch(() => undefined);
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

    // Clean up stale temp files from any crashed previous install. Runs
    // on every entry, not only the write branches, so a doctor-mode run
    // or a re-entrance after a crash consistently leaves the dir tidy.
    await cleanupStaleTempFiles(decision.hookPath);

    switch (decision.action) {
      case 'install':
      case 'refresh': {
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

        if (options.onBeforeWrite !== undefined) {
          await options.onBeforeWrite(decision.hookPath);
        }

        try {
          await writeExecutable(
            decision.hookPath,
            fallbackHookContent(),
            decision.action === 'install',
          );
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
  /**
   * True when `activeForeign` is true AND the file mentions the gate path
   * literally somewhere. The parser could not confirm a clean delegating
   * invocation, but the hook clearly references the gate — this is usually
   * an unusual-but-valid invocation shape (exotic variable indirection,
   * command substitution, etc.). Doctor downgrades these to WARN instead
   * of hard FAIL so a governed-but-unparseable hook does not cause a
   * red-light on every `rea doctor` run.
   *
   * R12 F2: the parser's no-match verdict is no longer proof that
   * governance is absent. A mention-but-no-parse signal needs human
   * review, not a blanket failure.
   */
  activeSuspect: boolean;
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
  // Track which active-candidate files merely MENTION the gate token —
  // used downstream to populate `activeSuspect` for the doctor warning
  // downgrade path.
  const mentionsByPath = new Map<string, boolean>();
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
          reaManaged = isReaManagedFallback(content) || isReaManagedHuskyGate(content);
          delegatesToGate = referencesReviewGate(content);
          mentionsByPath.set(p, content.includes(GATE_DELEGATION_TOKEN));
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
  // Suspect = foreign-by-parse BUT the file literally mentions the gate
  // path. Most likely an exotic invocation shape our parser could not
  // confirm (command substitution, eval, unusual indirection). Doctor
  // downgrades these to WARN instead of hard FAIL.
  const activeSuspect =
    activeForeign && mentionsByPath.get(activePath) === true;

  return { candidates, activePath, ok, activeForeign, activeSuspect };
}
