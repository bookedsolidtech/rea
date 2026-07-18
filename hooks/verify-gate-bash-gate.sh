#!/bin/bash
# PreToolUse hook: verify-gate-bash-gate.sh
# 0.54.0+ — Node-binary shim for `rea hook verify-gate-bash-gate` (Artifact Gate G2, bash-tier).
#
# G2 verification-gate (Bash-tier): the editor-tier verify-gate.sh guards
# Write/Edit to `.rea/tasks.jsonl`, but a raw Bash redirect
# (`echo ... > .rea/tasks.jsonl`, `tee`, `cp`/`mv`) bypasses it. This shim
# forwards Bash commands to `rea hook verify-gate-bash-gate`, which — under
# `policy.artifact_gates.g2_verify.mode` shadow/enforce — refuses a shell write
# to the task store (the AST scanner resolves symlink aliases) and directs the
# agent to the sanctioned `rea tasks` CLI. The gate is policy-driven and
# DEFAULT-OFF, so this shim is FAIL-OPEN: a missing/unbuilt CLI must NOT block
# Bash in a repo that never opted in. Full logic in
# `src/hooks/verify-gate-bash-gate/index.ts`.
#
# # Relevance pre-gate (round-13 F3: MODE, not keywords)
#
# The pre-0.13 pre-filter forwarded only when the command text contained BOTH
# `tasks` and `jsonl` — UNSOUND for symlink aliases (`tee tasklog` names
# neither), so it short-circuited before the symlink-resolving AST scanner
# ran. This gate now keys on POLICY MODE instead: read
# `artifact_gates.g2_verify.mode` cheaply via the shared policy-reader; `off`
# (the default) → no-op, so an un-opted-in repo pays only one scalar read;
# `shadow`/`enforce` → forward the command to the CLI, which scans it (alias
# resolution included) regardless of keywords. Only opted-in repos pay the
# scan. Residual: a fully-dynamic write target that never names the store
# statically is still out of scope (documented in the CLI header).

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

# shellcheck source=_lib/policy-reader.sh
source "$(dirname "$0")/_lib/policy-reader.sh"

SHIM_NAME="verify-gate-bash-gate"
SHIM_INTRODUCED_IN="0.54.0"
SHIM_FAIL_OPEN=1
SHIM_REFUSAL_NOUN="task-store write verification"

shim_is_relevant() {
  # Cheapest sound gate: policy MODE. `off`/absent/unreadable → not relevant
  # (no-op); only an explicit shadow/enforce opt-in forwards to the scanner.
  local mode
  mode=$(policy_reader_get artifact_gates.g2_verify.mode 2>/dev/null || true)
  case "$mode" in
    shadow | enforce) return 0 ;;
    *) return 1 ;;
  esac
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
