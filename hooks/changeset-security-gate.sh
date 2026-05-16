#!/bin/bash
# PreToolUse hook: changeset-security-gate.sh
# 0.33.0+ — Node-binary shim for `rea hook changeset-security-gate`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Blocking-tier: frontmatter validation + GHSA/CVE scan over
# .changeset/ writes. Full logic in
# `src/hooks/changeset-security-gate/index.ts`.
#
# # Relevance pre-gate
#
# 2026-05-15 codex round-2 P2 fix: scan `tool_input.file_path` /
# `tool_input.notebook_path` ONLY, not the raw JSON payload, so a
# Write to README.md mentioning `.changeset/` in its content body
# doesn't trip the fail-closed branch.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="changeset-security-gate"
SHIM_INTRODUCED_IN="0.33.0"
SHIM_FAIL_OPEN=0
SHIM_REFUSAL_NOUN="changeset disclosure refusal"

shim_is_relevant() {
  local probe
  if command -v jq >/dev/null 2>&1; then
    probe=$(printf '%s' "$INPUT" | jq -r '(.tool_input.file_path // .tool_input.notebook_path // "")' 2>/dev/null || true)
  else
    probe="$INPUT"
  fi
  if printf '%s' "$probe" | grep -qE '\.changeset/'; then
    return 0
  fi
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
