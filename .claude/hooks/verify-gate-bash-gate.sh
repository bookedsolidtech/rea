#!/bin/bash
# PreToolUse hook: verify-gate-bash-gate.sh
# 0.54.0+ — Node-binary shim for `rea hook verify-gate-bash-gate` (Artifact Gate G2, bash-tier).
#
# G2 verification-gate (Bash-tier): the editor-tier verify-gate.sh guards
# Write/Edit to `.rea/tasks.jsonl`, but a raw Bash redirect
# (`echo ... > .rea/tasks.jsonl`, `tee`, `cp`/`mv`) bypasses it. This shim
# forwards store-naming Bash commands to `rea hook verify-gate-bash-gate`,
# which — under `policy.artifact_gates.g2_verify.mode` shadow/enforce —
# refuses a shell write to the task store and directs the agent to the
# sanctioned `rea tasks` CLI. The gate is policy-driven and DEFAULT-OFF, so
# this shim is FAIL-OPEN: a missing/unbuilt CLI must NOT block Bash in a repo
# that never opted in. Full logic in `src/hooks/verify-gate-bash-gate/index.ts`.
#
# # Relevance pre-gate
#
# Scan `tool_input.command` ONLY. The filename `tasks.jsonl` cannot be
# obfuscated away, so requiring BOTH `tasks` and `jsonl` substrings bounds
# the CLI spawn to plausibly-relevant commands while staying robust to
# path-prefix quoting tricks.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="verify-gate-bash-gate"
SHIM_INTRODUCED_IN="0.54.0"
SHIM_FAIL_OPEN=1
SHIM_REFUSAL_NOUN="task-store write verification"

shim_is_relevant() {
  local probe
  if command -v jq >/dev/null 2>&1; then
    probe=$(printf '%s' "$INPUT" | jq -r '(.tool_input.command // "")' 2>/dev/null || true)
  else
    probe="$INPUT"
  fi
  if printf '%s' "$probe" | grep -qi 'tasks' && printf '%s' "$probe" | grep -qi 'jsonl'; then
    return 0
  fi
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
