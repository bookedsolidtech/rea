#!/bin/bash
# PreToolUse hook: dependency-audit-gate.sh
# 0.33.0+ — Node-binary shim for `rea hook dependency-audit-gate`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Blocking-tier: refuses install commands when any requested package
# isn't published on the registry (pre-port behavior). The full
# segment splitter + per-package `npm view` probe is in
# `src/hooks/dependency-audit-gate/index.ts`.
#
# # Relevance pre-gate
#
# 2026-05-15 codex round-2 P2 fix: scan `tool_input.command` ONLY,
# not the raw JSON payload. Pre-fix `git commit -m "docs: run pnpm
# install foo"` triggered fail-closed on fresh checkout (the regex hit
# the substring inside the commit-message ARG). The jq-less fallback
# preserves the pre-0.33.0 over-trigger shape.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="dependency-audit-gate"
SHIM_INTRODUCED_IN="0.33.0"
SHIM_FAIL_OPEN=0
SHIM_REFUSAL_NOUN="dependency-audit refusal"

shim_is_relevant() {
  local probe
  if command -v jq >/dev/null 2>&1; then
    probe=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
  else
    probe="$INPUT"
  fi
  if printf '%s' "$probe" | grep -qE '(npm[[:space:]]+(install|i|add)|pnpm[[:space:]]+(add|install|i)|yarn[[:space:]]+add)[[:space:]]'; then
    return 0
  fi
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
