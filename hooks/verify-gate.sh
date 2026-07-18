#!/bin/bash
# PreToolUse hook: verify-gate.sh
# 0.54.0+ — Node-binary shim for `rea hook verify-gate` (Artifact Gate G2).
#
# G2 verification-gate: refuses a Write/Edit to `.rea/tasks.jsonl` that
# transitions any task to `completed` without recorded `evidence`. The
# gate is policy-driven and DEFAULT-OFF (off|shadow|enforce via
# `policy.artifact_gates.g2_verify.mode`), so this shim is FAIL-OPEN:
# a missing/unbuilt CLI must NOT block task-store writes in a repo that
# never opted in. Full logic in `src/hooks/verify-gate/index.ts`.
#
# # Relevance pre-gate
#
# Scan `tool_input.file_path` ONLY (not the raw payload), so a Write to
# some other file whose CONTENT mentions `.rea/tasks.jsonl` does not
# trip the shim.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="verify-gate"
SHIM_INTRODUCED_IN="0.54.0"
SHIM_FAIL_OPEN=1
SHIM_REFUSAL_NOUN="task-completion verification"

shim_is_relevant() {
  local probe
  if command -v jq >/dev/null 2>&1; then
    probe=$(printf '%s' "$INPUT" | jq -r '(.tool_input.file_path // .tool_input.notebook_path // "")' 2>/dev/null || true)
  else
    probe="$INPUT"
  fi
  if printf '%s' "$probe" | grep -qE '\.rea/tasks\.jsonl'; then
    return 0
  fi
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
