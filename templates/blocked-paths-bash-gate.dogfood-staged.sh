#!/bin/bash
# PreToolUse hook: blocked-paths-bash-gate.sh
# 0.35.0+ — Node-binary shim for `rea hook blocked-paths-bash-gate`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Tier-1 Bash gate. Full bash body preserved at
# `__tests__/hooks/parity/baselines/blocked-paths-bash-gate.sh.pre-0.35.0`.
# Migration lives in `src/hooks/blocked-paths-bash-gate/index.ts`.
#
# SHIM_ENFORCE_CLI_SHAPE=1: 0.35.0 codex round-1 P1 — enforce
# dist/cli/index.js shape on the resolved CLI.
#
# # Relevance pre-gate (CLI-missing only)
#
# Substring scan over the extracted command against any
# policy.blocked_paths entry. Empty/missing policy → no enforcement,
# exit 0 (matches the pre-port bash body's allow-on-no-policy posture).

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="blocked-paths-bash-gate"
SHIM_INTRODUCED_IN="0.35.0"
SHIM_FAIL_OPEN=0
SHIM_ENFORCE_CLI_SHAPE=1
SHIM_REFUSAL_NOUN="blocked_paths refusal"

shim_cli_missing_relevant() {
  local cli_missing_cmd=""
  if command -v jq >/dev/null 2>&1; then
    cli_missing_cmd=$(printf '%s' "$INPUT" | jq -r '
      (.tool_input.command // "") | tostring
    ' 2>/dev/null || true)
  else
    cli_missing_cmd="$INPUT"
  fi
  if [ -z "$cli_missing_cmd" ]; then
    return 1
  fi
  local policy_file="${REA_ROOT}/.rea/policy.yaml"
  if [ ! -f "$policy_file" ]; then
    return 1
  fi
  # 0.37.0: route blocked_paths reads through the unified policy-reader.
  # shellcheck source=_lib/policy-reader.sh
  source "$(dirname "$0")/_lib/policy-reader.sh"
  local entry
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    case "$cli_missing_cmd" in
      *"$entry"*) return 0 ;;
    esac
  done < <(policy_reader_get_list blocked_paths 2>/dev/null)
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
