#!/bin/bash
# PreToolUse hook: local-review-gate.sh
# 0.34.0+ — Node-binary shim for `rea hook local-review-gate`.
#
# Pre-0.34.0 the gate's full body lived here as bash (460 LOC,
# including the per-trigger inline-bypass walker, multi-segment
# laundering defense, and the friendly refusal banner). The migration
# to the Node binary moves the per-segment trigger detection +
# preflight call into `src/hooks/local-review-gate/index.ts`. This
# shim is the Claude Code dispatcher's view of the hook — it
# forwards stdin to the CLI and exits with whatever the CLI returns.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on
# pass-through / mode=off / bypassed / preflight-allow, exit 2 on
# HALT / preflight-refuse / malformed payload.
#
# # Shim short-circuits (codex round-1 P1+P2 fixes)
#
# The 0.34.0 round-0 shim deferred ALL decisions to the CLI, including
# `mode: off` and the bypass env-var. That regressed two documented
# workflows on fresh/unbuilt installs:
#   - codex-less teams with `policy.review.local_review.mode: off` must
#     still be able to `git push` even when the rea CLI isn't built.
#   - operators with the audited bypass env-var set (default
#     `REA_SKIP_LOCAL_REVIEW=<reason>`) must still be able to push.
# Round-1 P1 fix: read the mode + bypass env-var INLINE in the shim
# BEFORE any CLI resolution. These two short-circuits exit 0 cleanly
# without spawning node. The full enforcement (multi-trigger sweep,
# inline-bypass evaluation, preflight call) still lives in the CLI.
#
# # CLI-resolution trust boundary
#
# Mirrors the 0.32.0 final shim shape. The resolved CLI MUST live
# INSIDE realpath(CLAUDE_PROJECT_DIR) AND have an ancestor
# `package.json` whose `name` is `@bookedsolid/rea`.
#
# # Fail-closed posture
#
# local-review-gate is BLOCKING-tier — the pre-0.34.0 bash body
# refused `git push` (and optionally `git commit`) without a recent
# audit entry. The early-exit branches (CLI missing, node missing,
# sandbox failed, version skew) fail closed AFTER the relevance
# pre-gate passes AND AFTER the mode/bypass short-circuits.
#
# # Relevance pre-gate
#
# Round-1 P2 fix: the substring scan must NOT mark commands as
# relevant when `git push`/`git commit` only appears inside a quoted
# argument body (`echo "remember git push later"`,
# `git commit -m "doc: explain git push --force"`). Pre-fix the
# substring scan saw these as relevant → entered fail-closed branch
# when CLI was missing. Fix: anchor the substring scan on segment
# heads via a stripped-prefix check, matching the CLI's segment-aware
# detector.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Read stdin once. Used by the relevance pre-gate, the bypass
#    short-circuit, AND the CLI forward.
INPUT=$(cat)

# 2b. Early bypass-env-var short-circuit (round-7 P2 fix). The
#     pre-0.34.0 bash body honored the operator-exported bypass var
#     BEFORE any policy read. The round-1+ shim deferred the bypass
#     check to section 6, which sits AFTER the policy-reader spawns
#     the CLI for mode/refuse_at lookups (section 4 + section 5). On
#     unbuilt installs OR when the CLI fails the sandbox check, those
#     policy reads can no-op silently — but the audited bypass should
#     STILL short-circuit so operators can push through the gate.
#
#     We can only check the DEFAULT var name (REA_SKIP_LOCAL_REVIEW)
#     this early because the policy-renamed `bypass_env_var` requires
#     a policy read. The policy-aware re-check at section 6 still runs
#     for renamed vars when the CLI is reachable. Operators who rename
#     the var AND have a broken CLI fall back to the section-6 awk
#     parser (block-form only) — same posture as pre-fix; this early
#     gate only adds coverage for the default-var case.
EARLY_BYPASS_VALUE="${REA_SKIP_LOCAL_REVIEW:-}"
if [ -n "$EARLY_BYPASS_VALUE" ]; then
  exit 0
fi

# 3. Resolve the rea CLI path early — used (a) by the policy reader
#    fallback below to honor inline `local_review: { mode: ... }`
#    mappings, and (b) by the forward step at the bottom. Stored as
#    REA_ARGV so the same array drives both calls.
POLICY_FILE="$proj/.rea/policy.yaml"
REA_ARGV=()
RESOLVED_CLI_PATH=""
if [ -f "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js" ]; then
  REA_ARGV=(node "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/node_modules/@bookedsolid/rea/dist/cli/index.js"
elif [ -f "$proj/dist/cli/index.js" ]; then
  REA_ARGV=(node "$proj/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/dist/cli/index.js"
fi

# Round-5 P1 fix: sandbox-check the resolved CLI BEFORE any policy-get
# invocation. Pre-fix `_lrg_read_policy()` could spawn the resolved CLI
# (section 4 mode-off check, section 5 refuse_at) BEFORE the section-7
# sandbox validation — a symlinked or swapped `dist/cli/index.js`
# would execute during policy lookup, defeating the realpath /
# package.json trust boundary that the shim is supposed to enforce.
# We now validate the CLI's realpath sits inside CLAUDE_PROJECT_DIR
# AND has an ancestor `package.json` with name `@bookedsolid/rea`
# BEFORE the policy reader is allowed to spawn it. On failure we
# zero out REA_ARGV so the policy reader falls through to the awk
# block-form parser (which never spawns anything), and the eventual
# CLI-forward step at section 7 will refuse with the sandbox banner.
if [ "${#REA_ARGV[@]}" -gt 0 ] && command -v node >/dev/null 2>&1; then
  sandbox_check_early=$(node -e '
    const fs = require("fs");
    const path = require("path");
    const cli = process.argv[1];
    const projDir = process.argv[2];
    let real, realProj;
    try { real = fs.realpathSync(cli); } catch (e) {
      process.stdout.write("bad:realpath"); process.exit(1);
    }
    try { realProj = fs.realpathSync(projDir); } catch (e) {
      process.stdout.write("bad:realpath-proj"); process.exit(1);
    }
    const sep = path.sep;
    const projWithSep = realProj.endsWith(sep) ? realProj : realProj + sep;
    if (!(real === realProj || real.startsWith(projWithSep))) {
      process.stdout.write("bad:cli-escapes-project"); process.exit(1);
    }
    let cur = path.dirname(path.dirname(path.dirname(real)));
    let found = false;
    for (let i = 0; i < 20 && cur && cur !== path.dirname(cur); i += 1) {
      const pj = path.join(cur, "package.json");
      if (fs.existsSync(pj)) {
        try {
          const data = JSON.parse(fs.readFileSync(pj, "utf8"));
          if (data && data.name === "@bookedsolid/rea") { found = true; break; }
        } catch (e) { /* keep walking */ }
      }
      cur = path.dirname(cur);
    }
    if (!found) { process.stdout.write("bad:no-rea-pkg-json"); process.exit(1); }
    process.stdout.write("ok");
  ' -- "$RESOLVED_CLI_PATH" "$proj" 2>/dev/null)
  if [ "$sandbox_check_early" != "ok" ]; then
    # Sandbox failed. Stash the failure reason and clear REA_ARGV so
    # the policy reader falls through to awk. The section-7 forward
    # step will re-run the sandbox check and emit the canonical
    # refusal banner to stderr.
    SANDBOX_EARLY_FAILURE="$sandbox_check_early"
    REA_ARGV=()
  fi
fi

# 0.37.0: route policy reads through the unified policy-reader. The
# pre-0.37.0 helper here was a hand-rolled dual-tier (CLI subtree
# JSON + per-leaf awk block-form parser). The new helper consolidates
# CLI + python3 + awk into a single 4-tier ladder, so inline-form
# mappings like `local_review: { mode: off, refuse_at: commit }` now
# work even on installs where the CLI is unreachable AND python3 +
# PyYAML are available (the previous bash awk fallback missed inline
# forms entirely — silent no-op on stale-CLI installs).
#
# Behavior preserved: empty stdout → "default applies"; the helper
# returns 0 even when the key is unset, so the existing callers'
# `case` statements work unchanged.
#
# Codex round 4 P2 (2026-05-16): local-review-gate fires on EVERY Bash
# PreToolUse event and reads three leaves from `review.local_review`
# (mode + refuse_at + bypass_env_var). The unified reader's CLI tier
# spawns a fresh `rea hook policy-get` per leaf, so the hot path went
# from 1 CLI startup (the pre-0.37.0 subtree call) to 4 (version probe
# + 3 leaves). Restore the subtree-cache shape: fetch
# `review.local_review` as JSON once, then extract leaves locally. Falls
# back to per-leaf reads when the subtree call returns null/empty (e.g.
# Tier 3 awk can't serve subtree — that's documented and the per-leaf
# block-form parser handles those cases via the unified reader's
# fall-through ladder).
# shellcheck source=_lib/policy-reader.sh
source "$(dirname "$0")/_lib/policy-reader.sh"

# Subtree cache: populated lazily on first read. Empty string means
# "not yet attempted"; "null" means "attempted, key unset"; any other
# value is the JSON object.
_LRG_LR_SUBTREE_JSON=""

_lrg_load_local_review_subtree() {
  if [ -n "$_LRG_LR_SUBTREE_JSON" ]; then
    return 0
  fi
  local sub
  sub=$(policy_reader_get_subtree_json review.local_review 2>/dev/null)
  if [ -z "$sub" ]; then
    _LRG_LR_SUBTREE_JSON="null"
  else
    _LRG_LR_SUBTREE_JSON="$sub"
  fi
}

# Extract a leaf from the cached subtree JSON. When subtree retrieval
# failed (e.g. Tier 3 awk fallback), or the leaf isn't present in the
# JSON, returns empty + non-zero so the caller can fall back to a
# per-leaf read.
_lrg_subtree_leaf() {
  local leaf="$1"
  if [ -z "$_LRG_LR_SUBTREE_JSON" ] || [ "$_LRG_LR_SUBTREE_JSON" = "null" ]; then
    return 1
  fi
  # Try jq first; fall back to a python3 one-liner. Same hardened
  # invocation shape as policy-reader.sh's no-jq fallback (env -u +
  # PYTHONSAFEPATH + sys.path scrub).
  if command -v jq >/dev/null 2>&1; then
    local out
    out=$(printf '%s' "$_LRG_LR_SUBTREE_JSON" | jq -r --arg k "$leaf" '
      .[$k] as $v
      | if $v == null then empty
        elif ($v|type) == "string" or ($v|type) == "number" or ($v|type) == "boolean"
          then $v | tostring
        else empty
        end
    ' 2>/dev/null)
    if [ -n "$out" ]; then
      printf '%s' "$out"
      return 0
    fi
    return 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    local out
    out=$(env -u PYTHONPATH -u PYTHONHOME -u PYTHONSTARTUP \
      PYTHONSAFEPATH=1 python3 -c '
import sys
import os
_cwd = os.getcwd()
_cwd_real = os.path.realpath(_cwd)
sys.path[:] = [p for p in sys.path if p not in ("", ".", _cwd, _cwd_real)]
import json
try:
    doc = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
leaf = sys.argv[2]
if isinstance(doc, dict) and leaf in doc:
    v = doc[leaf]
    if isinstance(v, bool):
        sys.stdout.write("true" if v else "false")
    elif isinstance(v, (int, float, str)):
        sys.stdout.write(str(v))
' "$_LRG_LR_SUBTREE_JSON" "$leaf" 2>/dev/null)
    if [ -n "$out" ]; then
      printf '%s' "$out"
      return 0
    fi
  fi
  return 1
}

_lrg_read_policy() {
  # $1 = dotted key (e.g. `review.local_review.mode`)
  #
  # For `review.local_review.*` leaves, try the subtree cache first
  # (one CLI startup serves all three leaves). Fall back to a per-key
  # read for everything else — and for leaves that the subtree cache
  # couldn't produce (e.g. Tier 3 awk fallback where subtree mode is
  # unsupported).
  local key="$1"
  case "$key" in
    review.local_review.*)
      _lrg_load_local_review_subtree
      local leaf="${key##*.}"
      local v
      if v=$(_lrg_subtree_leaf "$leaf"); then
        printf '%s' "$v"
        return 0
      fi
      ;;
  esac
  policy_reader_get "$key" 2>/dev/null
}

# 4. Mode-off short-circuit. Mirrors the bash hook's
#    `policy_get_local_review_mode` check at the top — `off` → silent
#    no-op BEFORE any other work.
LOCAL_REVIEW_MODE=$(_lrg_read_policy review.local_review.mode)
if [ "$LOCAL_REVIEW_MODE" = "off" ]; then
  exit 0
fi

# 5. Read `refuse_at` to scope the relevance pre-gate. Under the
#    default `refuse_at: push`, a `git commit` segment is NOT refused
#    by the CLI — so when the CLI is missing, the shim should let
#    `git commit -m "..."` pass without hitting fail-closed. Mirrors
#    the bash hook's posture: a non-refused git op does not enter
#    the preflight-refuse branch.
REFUSE_AT="push"
POLICY_REFUSE=$(_lrg_read_policy review.local_review.refuse_at)
case "$POLICY_REFUSE" in push|commit|both) REFUSE_AT="$POLICY_REFUSE" ;; esac
# Build trigger-head alternation based on refuse_at.
case "$REFUSE_AT" in
  push)   TRIGGER_RE='git[[:space:]]+push' ;;
  commit) TRIGGER_RE='git[[:space:]]+commit' ;;
  both)   TRIGGER_RE='git[[:space:]]+(push|commit)' ;;
esac

# Relevance pre-gate. Anchor on the trigger regex at the head of each
# ;/&&/||/| separated segment — this matches the CLI's segment-aware
# detector and avoids false-positives on quoted arguments like
# `git commit -m "doc: git push later"`.
#
# The check is approximate (it uses a coarse quote masker that the CLI
# does properly via mvdan-sh) because if it errs on the side of
# relevant→true, the CLI's real segment walker will sort it out. We
# only want to short-circuit confidently-non-relevant cases (where
# there's NO trigger head in any segment) so unbuilt installs don't
# fail closed on benign Bash calls.
#
# 0.34.0 round-2 P1 fix: the env-prefix-strip MUST accept quoted
# values. Pre-fix the strip pattern was
# `[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+`, which silently
# missed shapes like `GIT_SSH_COMMAND="ssh -i ~/.ssh/id"  git push`
# because the `[^[:space:]]+` value group stops at the first space
# inside the quotes. We mirror the segments.ts `matchEnvAssignLength`
# helper — accept value shapes `"..."`, `'...'`, `\S*` (zero-or-more
# so bare `FOO= cmd` resolves too). The strip runs ITERATIVELY so
# stacked env prefixes (`A="x" B='y' C=z git push`) all get peeled.
RELEVANT=0
PROBE=""
JQ_PARSE_FAILED=0
# 0.34.0 round-4 P2 fix: capture jq's exit code SEPARATELY rather than
# swallowing it with `|| true`. Malformed PreToolUse payload (invalid
# JSON, schema mismatch) pre-fix → empty PROBE → RELEVANT=0 fast path
# → silent bypass. Post-fix we distinguish:
#   - jq exit 0 + non-empty stdout → use as PROBE (the normal path)
#   - jq exit 0 + empty stdout     → non-Bash payload / empty cmd, RELEVANT=0
#   - jq exit != 0 (parse failure) → JQ_PARSE_FAILED=1, force RELEVANT=1
#                                    so we skip the awk pre-gate and
#                                    forward straight to the CLI body
#                                    which fails closed on malformed
#                                    payloads via Zod. Substring-only
#                                    fallback was insufficient because
#                                    raw JSON often won't contain
#                                    `git push` literally and would
#                                    still short-circuit to exit 0.
if command -v jq >/dev/null 2>&1; then
  PROBE=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
  jq_status=$?
  if [ "$jq_status" -ne 0 ]; then
    JQ_PARSE_FAILED=1
  fi
else
  # 0.34.0 round-6 P1 fix: pre-fix the shim set `PROBE="$INPUT"` (the
  # raw JSON payload) when jq was missing, then ran the awk relevance
  # scan over JSON instead of a bare command. A payload containing
  # `git push origin main` came through as e.g.
  # `{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}`
  # → the `^git push` anchor never matched → RELEVANT=0 → silent
  # bypass on every jq-less machine. Fix: treat jq-missing the same
  # as a parse failure — force RELEVANT=1 and let the CLI body decide.
  # The CLI uses native Node JSON parsing so jq is not required for
  # the actual enforcement.
  JQ_PARSE_FAILED=1
fi
# Split on shell separators then look for a segment whose head is
# the configured trigger. The awk here masks chars inside `"..."`
# and `'...'` spans before splitting — same posture as the CLI's
# `splitSegments` but coarser (no nested-shell unwrap; the CLI handles
# that). For relevance-pre-gate purposes the masker is sufficient.
#
# IMPORTANT: the env-prefix strip runs on the UNMASKED `seg` (post
# substring split) so the value's original quote characters are still
# present. Strip patterns accept quoted (`"..."`, `'...'`) AND
# unquoted (`\S*`) values so quoted env prefixes don't hide the
# trigger.
# Round-4 P2: if jq couldn't parse the payload, skip the awk pre-gate
# entirely and force RELEVANT=1 so the CLI body decides. The CLI's Zod
# parser fails closed on schema violations.
if [ "$JQ_PARSE_FAILED" -eq 1 ]; then
  RELEVANT=1
elif [ -n "$PROBE" ]; then
  RELEVANT=$(printf '%s' "$PROBE" | awk '
    BEGIN {
      mode = 0  # 0=plain, 1=dquote, 2=squote
    }
    {
      line = $0
      out  = ""
      i    = 1
      n    = length(line)
      while (i <= n) {
        ch = substr(line, i, 1)
        if (mode == 0) {
          if (ch == "\\" && i < n) { out = out " "; i += 2; continue }
          if (ch == "\"") { mode = 1; out = out ch; i++; continue }
          if (ch == "\047") { mode = 2; out = out ch; i++; continue }
          out = out ch
          i++
        } else if (mode == 1) {
          if (ch == "\\" && i < n) { out = out "x"; i += 2; continue }
          if (ch == "\"") { mode = 0; out = out ch; i++; continue }
          out = out "x"
          i++
        } else {
          if (ch == "\047") { mode = 0; out = out ch; i++; continue }
          out = out "x"
          i++
        }
      }
      print out
    }
  ' | tr ';|&' '\n\n\n' | awk -v trigger="^${TRIGGER_RE}([[:space:]]|$)" '
    {
      seg = $0
      # Strip leading whitespace and common prefixes (sudo, exec,
      # time, VAR=value). Coarse — the CLI does this properly.
      sub(/^[[:space:]]+/, "", seg)
      # Iteratively strip env-var assignment prefix VAR=<value> +
      # one-or-more spaces. <value> may be a double-quoted string,
      # a single-quoted string, or a bare token (zero-or-more
      # non-space chars). Quote characters in this comment are
      # intentionally avoided — see round-4 P1 fix: a literal
      # single-quote inside an awk comment inside a single-quoted
      # shell heredoc terminates the bash string and causes
      # "awk: syntax error" at runtime, swallowed by `|| true`.
      # Try quoted shapes first; bare last. Run until no more prefixes
      # match (POSIX-legal stacked-env-prefix support).
      changed = 1
      while (changed) {
        changed = 0
        if (match(seg, /^[A-Za-z_][A-Za-z0-9_]*="[^"]*"[[:space:]]+/)) {
          seg = substr(seg, RLENGTH + 1); changed = 1; continue
        }
        if (match(seg, /^[A-Za-z_][A-Za-z0-9_]*='\''[^'\'']*'\''[[:space:]]+/)) {
          seg = substr(seg, RLENGTH + 1); changed = 1; continue
        }
        if (match(seg, /^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+/)) {
          seg = substr(seg, RLENGTH + 1); changed = 1; continue
        }
      }
      # Iteratively strip keyword prefixes. Round-5 P1 fix: the pre-
      # fix `sub` only stripped ONE keyword, so `time sudo git push`
      # left `sudo git push` and missed the trigger. Loop until no
      # more keyword prefixes match. Coarse — the CLI does this
      # properly with full builtin-tokenization.
      kchanged = 1
      while (kchanged) {
        kchanged = 0
        if (sub(/^(sudo|exec|time|then|do|else|fi|nice|nohup|stdbuf|env)[[:space:]]+/, "", seg)) {
          kchanged = 1
        }
      }
      # Round-5 P1 fix: if the (post-strip) segment head is a known
      # shell wrapper WITH a `-c`-class flag (so there IS a payload
      # to inspect), FORCE relevance and let the CLI walk it. Pre-
      # round-5-P1 `bash -c "git push ..."` had its payload masked
      # by the quote masker → no trigger at head → exit 0 silent
      # bypass. The CLI does full nested-shell unwrapping via
      # mvdan-sh; the shim should not try to compete.
      #
      # Round-6 P2 fix: the round-5 pattern matched ANY segment
      # whose head started with a shell name, including benign
      # bash-script-execution like `bash scripts/setup.sh`. That
      # hit the fail-closed branch on unbuilt installs with "rea
      # CLI is not built", even though the pre-0.34 hook only
      # gated actual git push / git commit commands. Fix: require
      # a -c-class flag (combined form -c, -lc, -lic, -cl, -cli,
      # -li, -il, -ic — the bash WRAP pattern set) OR a separated
      # --c flag, before forcing relevance.
      # IMPORTANT: comments here avoid bare single-quote characters
      # to prevent terminating the surrounding bash single-quoted
      # string at runtime — see round-4 P1 lesson (awk: syntax
      # error swallowed by `|| true`).
      if (match(seg, /^(bash|sh|zsh|dash|ksh|mksh|oksh|posh|yash|csh|tcsh|fish)[[:space:]]+(-([a-z]*c[a-z]*)|--c)([[:space:]]|$)/)) {
        print "1"
        exit
      }
      # Pre-flag variants: bash -l -c PAYLOAD, bash --noprofile -c
      # PAYLOAD. Match shell then one-or-more flags then a -c-class
      # flag. Comments deliberately have no inline quotes (round-4
      # P1 lesson).
      if (match(seg, /^(bash|sh|zsh|dash|ksh|mksh|oksh|posh|yash|csh|tcsh|fish)([[:space:]]+(-[a-z]+|--[a-z]+))+[[:space:]]+(-([a-z]*c[a-z]*)|--c)([[:space:]]|$)/)) {
        print "1"
        exit
      }
      if (seg ~ trigger) {
        print "1"
        exit
      }
    }
    END { print "0" }
  ' | head -1)
  # Fallback for environments without awk (vanishingly rare on the
  # platforms rea supports): default to relevant=1 — over-trigger is
  # safer than under-trigger.
  case "$RELEVANT" in 0|1) ;; *) RELEVANT=1 ;; esac
fi
if [ "$RELEVANT" -eq 0 ]; then
  exit 0
fi

# 6. Bypass env-var short-circuit. The bash hook honored the
#    operator-exported `REA_SKIP_LOCAL_REVIEW` (or the policy-renamed
#    var) BEFORE invoking preflight. We mirror that here so an
#    audited bypass works even when the CLI isn't built.
#
#    Policy-driven var name: read `policy.review.local_review.bypass_env_var`
#    if present; default to `REA_SKIP_LOCAL_REVIEW`. The CLI does its
#    own per-segment inline-bypass evaluation; the shim only checks
#    the operator-exported (process-env) form.
BYPASS_VAR="REA_SKIP_LOCAL_REVIEW"
POLICY_VAR=$(_lrg_read_policy review.local_review.bypass_env_var)
# Only honor POSIX-identifier-shaped names. Junk falls back to default.
if printf '%s' "$POLICY_VAR" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
  BYPASS_VAR="$POLICY_VAR"
fi
# Read the configured env-var via indirect expansion (bash 3.2 compatible).
BYPASS_VALUE="${!BYPASS_VAR:-}"
if [ -n "$BYPASS_VALUE" ]; then
  # Operator-exported bypass — allow. The CLI's per-segment inline
  # bypass and multi-trigger laundering defense run when the CLI is
  # reached; this shim short-circuit only covers the global
  # process-env shape.
  exit 0
fi

# 7. CLI sandbox + forward. REA_ARGV / RESOLVED_CLI_PATH were resolved
#    at section 3 above (they're needed by the policy-get fallback for
#    inline-form support). If they're empty, the CLI isn't built — OR
#    the early sandbox check (round-5 P1) cleared them. Distinguish.
if [ "${#REA_ARGV[@]}" -eq 0 ]; then
  if [ -n "${SANDBOX_EARLY_FAILURE:-}" ]; then
    printf 'rea: local-review-gate FAILED sandbox check (%s) — refusing.\n' "$SANDBOX_EARLY_FAILURE" >&2
    exit 2
  fi
  printf 'rea: local-review-gate cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  printf 'This shim fails closed because the pre-0.34.0 bash body enforced local-first review without a CLI.\n' >&2
  exit 2
fi

# 8. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: local-review-gate cannot run — `node` is not on PATH.\n' >&2
  printf 'Install Node 22+ (engines.node) to restore local-first review enforcement.\n' >&2
  exit 2
fi

sandbox_check=$(node -e '
  const fs = require("fs");
  const path = require("path");
  const cli = process.argv[1];
  const projDir = process.argv[2];
  let real, realProj;
  try { real = fs.realpathSync(cli); } catch (e) {
    process.stdout.write("bad:realpath"); process.exit(1);
  }
  try { realProj = fs.realpathSync(projDir); } catch (e) {
    process.stdout.write("bad:realpath-proj"); process.exit(1);
  }
  const sep = path.sep;
  const projWithSep = realProj.endsWith(sep) ? realProj : realProj + sep;
  if (!(real === realProj || real.startsWith(projWithSep))) {
    process.stdout.write("bad:cli-escapes-project"); process.exit(1);
  }
  let cur = path.dirname(path.dirname(path.dirname(real)));
  let found = false;
  for (let i = 0; i < 20 && cur && cur !== path.dirname(cur); i += 1) {
    const pj = path.join(cur, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const data = JSON.parse(fs.readFileSync(pj, "utf8"));
        if (data && data.name === "@bookedsolid/rea") { found = true; break; }
      } catch (e) { /* keep walking */ }
    }
    cur = path.dirname(cur);
  }
  if (!found) { process.stdout.write("bad:no-rea-pkg-json"); process.exit(1); }
  process.stdout.write("ok");
' -- "$RESOLVED_CLI_PATH" "$proj" 2>/dev/null)

if [ "$sandbox_check" != "ok" ]; then
  printf 'rea: local-review-gate FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 9. Version-probe.
probe_out=$("${REA_ARGV[@]}" hook local-review-gate --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'local-review-gate'; then
  printf 'rea: this shim requires the `rea hook local-review-gate` subcommand (introduced in 0.34.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 10. Forward stdin (already captured up-front).
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook local-review-gate
exit $?
