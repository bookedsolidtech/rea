#!/bin/bash
# PreToolUse hook: env-file-protection.sh
# 0.33.0+ — Node-binary shim for `rea hook env-file-protection`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Blocking-tier: refuses Bash commands that source/cp/cat .env. Full
# segment splitter + utility-vs-.env co-occurrence logic in
# `src/hooks/env-file-protection/index.ts`.
#
# # Relevance pre-gate
#
# 2026-05-15 codex round-2 P2 fix: scan `tool_input.command` ONLY, not
# the raw JSON payload — otherwise `git commit -m "stop reading .env"`
# (where `.env` appears inside the commit message ARG) hits fail-closed
# on a fresh checkout.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="env-file-protection"
SHIM_INTRODUCED_IN="0.33.0"
SHIM_FAIL_OPEN=0
SHIM_REFUSAL_NOUN=".env protection"

shim_is_relevant() {
  local probe
  if command -v jq >/dev/null 2>&1; then
    probe=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
    if printf '%s' "$probe" | grep -qE '\.env'; then
      return 0
    fi
  else
    if printf '%s' "$INPUT" | grep -qE '\.env'; then
      return 0
    fi
  fi
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
