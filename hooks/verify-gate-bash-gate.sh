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
# round-53 P1: FAIL-OPEN by default (default-off gate), but when the repo has
# OPTED IN — artifact_gates.g2_verify.mode ∈ {shadow, enforce} — a
# missing/unbuilt/too-old CLI must NOT silently drop the gate. Fail CLOSED in
# that case so a raw Bash write to the task store cannot bypass an active G2.
SHIM_FAIL_CLOSED_WHEN_RELEVANT=1
SHIM_ACTIVE_GATE_KEY="g2_verify"

shim_is_relevant() {
  # Cheapest sound gate: policy MODE. `off`/absent/unreadable → not relevant
  # (no-op); only an explicit shadow/enforce opt-in forwards to the scanner.
  local mode
  mode=$(policy_reader_get artifact_gates.g2_verify.mode 2>/dev/null || true)
  case "$mode" in
    shadow | enforce) return 0 ;;
  esac
  # round-53 P1: policy_reader's awk tier (used when no CLI/python3 is present —
  # exactly the CLI-missing scenario this shim now fails CLOSED on) is BLOCK-FORM
  # ONLY, so a nested inline flow map (`artifact_gates: { g2_verify: { mode:
  # enforce } }`) would read as `off` and short-circuit here before the
  # fail-closed logic ever runs. Fall back to the shared robust gate-active
  # detector (block + inline at any depth, fail-closed bias on an unparseable
  # governed policy) so an opted-in inline gate is never missed. `_shim_gate_active`
  # is defined by shim-runtime.sh (sourced below) and resolved at call time.
  _shim_gate_active
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
