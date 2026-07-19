#!/bin/bash
# PreToolUse hook: protected-paths-bash-gate.sh
# 0.35.0+ — Node-binary shim for `rea hook protected-paths-bash-gate`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Blocking-tier Bash gate. Full bash body preserved at
# `__tests__/hooks/parity/baselines/protected-paths-bash-gate.sh.pre-0.35.0`.
# Migration lives in `src/hooks/protected-paths-bash-gate/index.ts`.
#
# SHIM_ENFORCE_CLI_SHAPE=1: codex round-1 P1 from 0.35.0 — enforce that
# the resolved CLI's realpath ends in dist/cli/index.js so an attacker
# who repoints node_modules/@bookedsolid/rea at an arbitrary in-project
# JS file cannot execute it as the trusted gate CLI.
#
# # Relevance pre-gate (CLI-missing only)
#
# Substring scan over the extracted command for protected-path markers
# AND any policy.protected_writes entry. When the CLI is reachable, the
# Node body does the precise evaluation; the shim's relevance scan is
# only consulted on fresh/unbuilt installs to preserve the pre-port
# bash body's allow-on-no-match posture.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="protected-paths-bash-gate"
SHIM_INTRODUCED_IN="0.35.0"
SHIM_FAIL_OPEN=0
SHIM_ENFORCE_CLI_SHAPE=1
SHIM_REFUSAL_NOUN="protected-path refusal"

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

  # R5-P1 (codex round 5): substring scan is DETERMINATIVE for
  # refusal. Allowlist opens an audited-allow gate but never closes
  # one.
  local matched_protected=0
  case "$cli_missing_cmd" in
    *".claude/"*) matched_protected=1 ;;
    *".husky/"*) matched_protected=1 ;;
    *".rea/policy.yaml"*) matched_protected=1 ;;
    *".rea/HALT"*) matched_protected=1 ;;
    *".rea/last-review"*) matched_protected=1 ;;
    # 0.54.0 round-34 P1: repository-wide shared enforcement state —
    # the audit hash chain, TOFU anchors, and their lock sidecars are
    # cross-root protected in the Node scanner; the CLI-missing
    # fallback must carry the same markers or an unbuilt worktree
    # becomes a bypass lane into the primary checkout.
    *".rea/audit.jsonl"*) matched_protected=1 ;;
    *".rea/fingerprints.json"*) matched_protected=1 ;;
    *".rea/fingerprints.json.lock"*) matched_protected=1 ;;
    *".rea.lock"*) matched_protected=1 ;;
    *".claude\\"*|*".husky\\"*|*".rea\\"*) matched_protected=1 ;;
  esac
  # 0.37.0: route protected_writes reads through the unified
  # policy-reader (Tier 1 CLI → Tier 2 python3 → Tier 3 awk
  # block-form).
  local policy_file="${REA_ROOT}/.rea/policy.yaml"
  if [ "$matched_protected" -eq 0 ] && [ -f "$policy_file" ]; then
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
      case "$cli_missing_cmd" in
        *"$base"*) matched_protected=1; break ;;
      esac
    done < <(policy_reader_get_list protected_writes 2>/dev/null)
  fi

  # shellcheck source=_lib/bootstrap-allowlist.sh
  source "$(dirname "$0")/_lib/bootstrap-allowlist.sh"

  # R7-P1 (codex round 7): 3-state PM-route return. See the
  # blocked-paths shim for the contract.
  _bootstrap_shim_pm_route "protected-paths-bash-gate" "$cli_missing_cmd" "$REA_ROOT"
  case "$?" in
    0) exit 0 ;;
    2) return 0 ;;
  esac

  if [ "$matched_protected" -eq 0 ]; then
    return 1
  fi
  return 0
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
