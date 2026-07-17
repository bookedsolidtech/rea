#!/bin/bash
# PreToolUse hook: settings-protection.sh
# 0.35.0+ — Node-binary shim for `rea hook settings-protection`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Pre-0.35.0 this was the LARGEST hook in the repo at 582 LOC of bash;
# the full bash body is preserved at
# `__tests__/hooks/parity/baselines/settings-protection.sh.pre-0.35.0`.
# Migration in `src/hooks/settings-protection/index.ts`.
#
# THE gate protecting the entire governance layer from agent self-
# disable. SHIM_ENFORCE_CLI_SHAPE=1 closes the 0.35.0 codex round-1 P1
# (forged in-project JS as the trusted gate CLI).
#
# # Relevance pre-gate (CLI-missing only)
#
# Substring scan over file_path / notebook_path for protected-path
# markers (.claude/, .husky/, .rea/policy.yaml, .rea/HALT, the
# verdict cache paths), plus any policy.protected_writes entry. Empty
# / missing policy is OK — the static marker set still catches the
# canonical protected paths.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="settings-protection"
SHIM_INTRODUCED_IN="0.35.0"
SHIM_FAIL_OPEN=0
SHIM_ENFORCE_CLI_SHAPE=1
SHIM_REFUSAL_NOUN="protected-path refusal"

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
  case "$cli_missing_file_path" in
    *".claude/settings"*) return 0 ;;
    *".claude/hooks/"*) return 0 ;;
    *".husky/"*) return 0 ;;
    *".rea/policy.yaml"*) return 0 ;;
    *".rea/HALT"*) return 0 ;;
    *".rea/last-review"*) return 0 ;;
    # 0.54.0 round-34 P1: repository-wide shared enforcement state —
    # the audit hash chain, TOFU anchors, and their lock sidecars are
    # cross-root protected in the Node scanner; the CLI-missing
    # fallback must carry the same markers or an unbuilt worktree
    # becomes a bypass lane into the primary checkout.
    *".rea/audit"*) return 0 ;;
    *".rea/fingerprints.json"*) return 0 ;;
    *".rea.lock"*) return 0 ;;
    *".claude\\"*|*".husky\\"*|*".rea\\"*) return 0 ;;
    *"..%2F"*|*"%2E%2E"*) return 0 ;;
  esac
  # 0.37.0: route protected_writes reads through the unified policy-reader.
  local policy_file="${REA_ROOT}/.rea/policy.yaml"
  if [ -f "$policy_file" ]; then
    # shellcheck source=_lib/policy-reader.sh
    source "$(dirname "$0")/_lib/policy-reader.sh"
    local entry base
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      base="$entry"
      case "$base" in
        */) base="${base%/}" ;;
      esac
      [ -z "$base" ] && continue
      case "$cli_missing_file_path" in
        *"$base"*) return 0 ;;
      esac
    done < <(policy_reader_get_list protected_writes 2>/dev/null)
  fi
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
