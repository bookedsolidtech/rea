#!/bin/bash
# PreToolUse hook: dangerous-bash-interceptor.sh
# 0.34.0+ — Node-binary shim for `rea hook dangerous-bash-interceptor`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Pre-0.34.0 the gate's full body lived here as bash (414 LOC: refusal
# classes H1-H17 + M1 plus their bypass-corpus regressions). Migration
# in `src/hooks/dangerous-bash-interceptor/index.ts`. Behavioral
# contract preserved byte-for-byte: exit 0 on pass-through / MEDIUM-only
# advisory, exit 2 on HALT / HIGH match / malformed payload.
#
# # Relevance pre-gate (CLI-missing only)
#
# 0.34.0 round-7 P1 fix: substring scan over the EXTRACTED command for
# destructive-catalog keywords. When CLI is missing AND no keyword
# matches, exit 0 (the pre-port bash body would have done the same —
# no rule to match). When CLI is missing AND a keyword DOES match,
# fail closed.
#
# Keywords cover every rule head H1-H17 + M1. Coarse by design — the
# CLI does the real per-rule evaluation when reachable; over-trigger
# costs one node-spawn, under-trigger is the bypass we MUST avoid.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="dangerous-bash-interceptor"
SHIM_INTRODUCED_IN="0.34.0"
SHIM_FAIL_OPEN=0
SHIM_REFUSAL_NOUN="destructive-command refusal"

shim_cli_missing_relevant() {
  local cli_missing_cmd=""
  if command -v jq >/dev/null 2>&1; then
    cli_missing_cmd=$(printf '%s' "$INPUT" | jq -r '
      (.tool_input.command // "") | tostring
    ' 2>/dev/null || true)
  else
    # jq missing — fall back to scanning the raw payload. Over-trigger
    # by design (the CLI is the source of truth; this is fail-closed
    # only when keywords match).
    cli_missing_cmd="$INPUT"
  fi
  if [ -z "$cli_missing_cmd" ]; then
    # Empty/non-Bash payload → pre-port body would have exit 0'd.
    return 1
  fi
  case "$cli_missing_cmd" in
    *"git "*) return 0 ;;
    *"git	"*) return 0 ;;
    *"rm "*|*"rm	"*) return 0 ;;
    *"psql"*|*"pgcli"*) return 0 ;;
    *"DROP "*|*"DROP	"*) return 0 ;;
    *"kill "*|*"kill	"*|*"killall"*) return 0 ;;
    *"HUSKY="*) return 0 ;;
    *"curl"*|*"wget"*) return 0 ;;
    *"REA_BYPASS"*) return 0 ;;
    *"alias "*|*"function "*) return 0 ;;
    *"core.hooksPath"*|*"core.hookspath"*) return 0 ;;
    *"npm "*|*"pnpm "*|*"yarn "*) return 0 ;;
    *"--no-verify"*|*"--force"*) return 0 ;;
  esac
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
