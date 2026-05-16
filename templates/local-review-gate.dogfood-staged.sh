#!/bin/bash
# PreToolUse hook: local-review-gate.sh
# 0.34.0+ — Node-binary shim for `rea hook local-review-gate`.
# 0.38.0+ — uses helpers from `_lib/shim-runtime.sh` (shared
#           CLI-resolution, sandbox, and banners). Cannot use the
#           full `shim_run` orchestrator because the hot-path policy
#           reads need to happen AFTER an early sandbox check (round-5
#           P1) and the relevance scan is policy-driven on
#           `review.local_review.refuse_at` (round-1 P2).
#
# Pre-0.34.0 the gate's full body lived here as bash (460 LOC). The
# migration moves per-segment trigger detection + preflight call into
# `src/hooks/local-review-gate/index.ts`. This shim:
#
#   1. HALT check
#   2. Read stdin
#   2b. Early default-bypass-env-var short-circuit (round-7 P2)
#   3. Resolve CLI + EARLY sandbox check (round-5 P1: prevent
#      unsandboxed CLI from running during policy lookup)
#   3b. Subtree-cached policy reads via `_lib/policy-reader.sh`
#   4. Mode-off short-circuit
#   5. Refuse_at + relevance scan
#   6. Policy-driven bypass env-var short-circuit
#   7. CLI-missing handling
#   8. Sandbox check (idempotent re-run; emit banner on failure)
#   9. Version probe
#   10. Forward

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# SHIM_* metadata for shared banner helpers.
SHIM_NAME="local-review-gate"
SHIM_INTRODUCED_IN="0.34.0"
SHIM_FAIL_OPEN=0
SHIM_ENFORCE_CLI_SHAPE=0
SHIM_REFUSAL_NOUN="local-first review enforcement"
SHIM_NODE_MISSING_NOUN="local-first review enforcement"
SHIM_SKIP_VERSION_PROBE=0
# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
_shim_apply_defaults

# 2. Read stdin once.
INPUT=$(cat)

# 2b. Early default-bypass-env-var short-circuit. We can only check the
#     DEFAULT var name (REA_SKIP_LOCAL_REVIEW) this early because the
#     policy-renamed var requires a policy read. The policy-aware
#     re-check at section 6 still runs for renamed vars when the CLI
#     is reachable.
EARLY_BYPASS_VALUE="${REA_SKIP_LOCAL_REVIEW:-}"
if [ -n "$EARLY_BYPASS_VALUE" ]; then
  exit 0
fi

# 3. Resolve CLI early (used by policy reader Tier 1 + final forward).
shim_resolve_cli

# Round-5 P1 fix: sandbox-check the CLI BEFORE any policy-get
# invocation. Pre-fix `_lrg_read_policy()` could spawn the resolved CLI
# for mode-off / refuse_at reads BEFORE the sandbox guard fired — a
# symlinked or swapped dist/cli/index.js would execute during policy
# lookup, defeating the realpath / package.json trust boundary.
SANDBOX_EARLY_FAILURE=""
if [ "${#REA_ARGV[@]}" -gt 0 ] && command -v node >/dev/null 2>&1; then
  sandbox_check_early=$(shim_sandbox_check "$RESOLVED_CLI_PATH" "$proj" "$SHIM_ENFORCE_CLI_SHAPE")
  if [ "$sandbox_check_early" != "ok" ]; then
    SANDBOX_EARLY_FAILURE="$sandbox_check_early"
    REA_ARGV=()
  fi
fi

# 0.37.0: route policy reads through the unified policy-reader. The
# pre-0.37.0 helper was a hand-rolled dual-tier (CLI subtree JSON +
# per-leaf awk block-form parser). The new helper consolidates CLI +
# python3 + awk into a single 4-tier ladder so inline-form mappings
# like `local_review: { mode: off, refuse_at: commit }` work on
# installs where the CLI is unreachable AND python3 + PyYAML are
# available.
#
# Codex round 4 P2 (2026-05-16): local-review-gate fires on EVERY Bash
# PreToolUse and reads three leaves from `review.local_review`. The
# unified reader's CLI tier spawns a fresh `rea hook policy-get` per
# leaf, so the hot path went from 1 CLI startup (pre-0.37.0 subtree
# call) to 4. We restore the subtree-cache shape: fetch
# `review.local_review` as JSON once, then extract leaves locally.
# Falls back to per-leaf reads when the subtree call returns null /
# empty (e.g. Tier 3 awk can't serve subtree).
# shellcheck source=_lib/policy-reader.sh
source "$(dirname "$0")/_lib/policy-reader.sh"

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

_lrg_subtree_leaf() {
  local leaf="$1"
  if [ -z "$_LRG_LR_SUBTREE_JSON" ] || [ "$_LRG_LR_SUBTREE_JSON" = "null" ]; then
    return 1
  fi
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

# 4. Mode-off short-circuit.
LOCAL_REVIEW_MODE=$(_lrg_read_policy review.local_review.mode)
if [ "$LOCAL_REVIEW_MODE" = "off" ]; then
  exit 0
fi

# 5. Read refuse_at to scope the relevance pre-gate.
REFUSE_AT="push"
POLICY_REFUSE=$(_lrg_read_policy review.local_review.refuse_at)
case "$POLICY_REFUSE" in push|commit|both) REFUSE_AT="$POLICY_REFUSE" ;; esac
case "$REFUSE_AT" in
  push)   TRIGGER_RE='git[[:space:]]+push' ;;
  commit) TRIGGER_RE='git[[:space:]]+commit' ;;
  both)   TRIGGER_RE='git[[:space:]]+(push|commit)' ;;
esac

# 0.34.0 round-4 P2 fix: capture jq exit code separately rather than
# swallowing with `|| true`. Malformed payload pre-fix → empty PROBE →
# RELEVANT=0 → silent bypass. Post-fix: jq parse failure forces
# RELEVANT=1 so the CLI body decides (Zod fails closed on schema
# violations).
RELEVANT=0
PROBE=""
JQ_PARSE_FAILED=0
if command -v jq >/dev/null 2>&1; then
  PROBE=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
  jq_status=$?
  if [ "$jq_status" -ne 0 ]; then
    JQ_PARSE_FAILED=1
  fi
else
  # 0.34.0 round-6 P1 fix: pre-fix the shim set `PROBE="$INPUT"` (raw
  # JSON payload) when jq was missing, then ran the awk relevance scan
  # over JSON instead of a bare command. Fix: treat jq-missing the
  # same as a parse failure — force RELEVANT=1 and let the CLI decide.
  JQ_PARSE_FAILED=1
fi
# Split on shell separators then look for a segment whose head is the
# configured trigger. The awk here masks chars inside "..." and '...'
# spans before splitting — same posture as the CLI splitSegments but
# coarser (no nested-shell unwrap; the CLI handles that). For
# relevance-pre-gate purposes the masker is sufficient.
#
# IMPORTANT: the env-prefix strip runs on the UNMASKED `seg` so the
# value's original quote characters are still present. Strip patterns
# accept quoted ("...", '...') AND unquoted (\S*) values so quoted env
# prefixes don't hide the trigger.
#
# 0.34.0 round-2 P1: env-prefix strip MUST accept quoted values.
# 0.34.0 round-5 P1: iteratively strip stacked env prefixes AND
# keyword prefixes (sudo / time / etc).
# 0.34.0 round-6 P2: only force relevance on shell-wrappers when a
# -c-class flag is present (so `bash scripts/setup.sh` doesn't trip).
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
      sub(/^[[:space:]]+/, "", seg)
      # Iteratively strip env-var assignment prefix VAR=<value> +
      # one-or-more spaces. <value> may be a double-quoted string, a
      # single-quoted string, or a bare token (zero-or-more non-space
      # chars). Quote characters in this comment are intentionally
      # avoided — see round-4 P1 fix: a literal single-quote inside an
      # awk comment inside a single-quoted shell heredoc terminates
      # the bash string and causes "awk: syntax error" at runtime.
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
      kchanged = 1
      while (kchanged) {
        kchanged = 0
        if (sub(/^(sudo|exec|time|then|do|else|fi|nice|nohup|stdbuf|env)[[:space:]]+/, "", seg)) {
          kchanged = 1
        }
      }
      # Round-5 P1 + round-6 P2: if the head is a shell wrapper WITH a
      # -c-class flag, FORCE relevance and let the CLI walk the payload.
      # Comments here avoid bare single-quote characters to prevent
      # terminating the surrounding bash single-quoted string at
      # runtime — see round-4 P1 lesson.
      if (match(seg, /^(bash|sh|zsh|dash|ksh|mksh|oksh|posh|yash|csh|tcsh|fish)[[:space:]]+(-([a-z]*c[a-z]*)|--c)([[:space:]]|$)/)) {
        print "1"
        exit
      }
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
  case "$RELEVANT" in 0|1) ;; *) RELEVANT=1 ;; esac
fi
if [ "$RELEVANT" -eq 0 ]; then
  exit 0
fi

# 6. Bypass env-var short-circuit. Policy-driven var name; default
#    REA_SKIP_LOCAL_REVIEW. Only honor POSIX-identifier-shaped names.
BYPASS_VAR="REA_SKIP_LOCAL_REVIEW"
POLICY_VAR=$(_lrg_read_policy review.local_review.bypass_env_var)
if printf '%s' "$POLICY_VAR" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
  BYPASS_VAR="$POLICY_VAR"
fi
BYPASS_VALUE="${!BYPASS_VAR:-}"
if [ -n "$BYPASS_VALUE" ]; then
  exit 0
fi

# 7. CLI required. If REA_ARGV is empty either (a) the CLI wasn't
#    built/installed, OR (b) the early sandbox check cleared it.
#    Distinguish.
if [ "${#REA_ARGV[@]}" -eq 0 ]; then
  if [ -n "$SANDBOX_EARLY_FAILURE" ]; then
    shim_emit_sandbox_failure_banner "$SANDBOX_EARLY_FAILURE"
    exit 2
  fi
  shim_emit_cli_missing_banner
  exit 2
fi

# 8. (Redundant on the success path — the early sandbox already passed
#    and cleared REA_ARGV on failure — but we re-emit the node-missing
#    banner explicitly because node could have disappeared between
#    section 3 and now in pathological setups.)
if ! command -v node >/dev/null 2>&1; then
  shim_emit_node_missing_banner
  exit 2
fi

# 9. Version probe.
probe_out=$("${REA_ARGV[@]}" hook "$SHIM_NAME" --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e "$SHIM_NAME"; then
  shim_emit_version_skew_banner_blocking
  exit 2
fi

# 10. Forward stdin.
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook "$SHIM_NAME"
exit $?
