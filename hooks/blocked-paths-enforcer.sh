#!/bin/bash
# PreToolUse hook: blocked-paths-enforcer.sh
# 0.35.0+ — Node-binary shim for `rea hook blocked-paths-enforcer`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Write/Edit/MultiEdit/NotebookEdit-tier blocking gate. Full bash body
# preserved at
# `__tests__/hooks/parity/baselines/blocked-paths-enforcer.sh.pre-0.35.0`.
# Migration in `src/hooks/blocked-paths-enforcer/index.ts`.
#
# SHIM_ENFORCE_CLI_SHAPE=1: 0.35.0 codex round-1 P1 — enforce
# dist/cli/index.js shape.
#
# # Relevance pre-gate (CLI-missing only)
#
# Extract file_path / notebook_path; substring-scan against any
# policy.blocked_paths entry. Empty/missing policy → exit 0.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="blocked-paths-enforcer"
SHIM_INTRODUCED_IN="0.35.0"
SHIM_FAIL_OPEN=0
SHIM_ENFORCE_CLI_SHAPE=1
SHIM_REFUSAL_NOUN="blocked_paths refusal"

shim_cli_missing_relevant() {
  local cli_missing_file_path=""
  if command -v jq >/dev/null 2>&1; then
    cli_missing_file_path=$(printf '%s' "$INPUT" | jq -r '
      (.tool_input.file_path // .tool_input.notebook_path // "") | tostring
    ' 2>/dev/null || true)
  else
    cli_missing_file_path="$INPUT"
  fi
  if [ -z "$cli_missing_file_path" ]; then
    return 1
  fi
  local policy_file="${REA_ROOT}/.rea/policy.yaml"
  if [ ! -f "$policy_file" ]; then
    return 1
  fi
  # 0.37.0: route blocked_paths reads through the unified policy-reader.
  # shellcheck source=_lib/policy-reader.sh
  source "$(dirname "$0")/_lib/policy-reader.sh"
  local entry base
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    # Substring scan — for directory prefixes the entry ends with /
    # and any file_path under it matches. Glob entries fall back to
    # the same substring test (over-trigger is fine — the CLI does
    # the precise evaluation when reachable).
    base="$entry"
    case "$base" in
      */) base="${base%/}" ;;
    esac
    case "$base" in
      *'*'*) base="${base%%\**}" ;;
    esac
    [ -z "$base" ] && continue
    case "$cli_missing_file_path" in
      *"$base"*) return 0 ;;
    esac
  done < <(policy_reader_get_list blocked_paths 2>/dev/null)
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
