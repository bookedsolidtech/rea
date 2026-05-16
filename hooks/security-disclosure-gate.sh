#!/bin/bash
# PreToolUse hook: security-disclosure-gate.sh
# 0.32.0+ — Node-binary shim for `rea hook security-disclosure-gate`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Blocking-tier: refuses `gh issue create` payloads carrying
# disclosure keywords. Pre-port body was 339 LOC; migration in
# `src/hooks/security-disclosure-gate/index.ts`.
#
# # Relevance pre-gate
#
# Substring scan for `gh issue create`. Plain (NOT JSON-aware) so
# escaped quotes in quoted env prefixes don't break the match.
#
# # Mode short-circuit (round-6 P2)
#
# `REA_DISCLOSURE_MODE=disabled` exits 0 — pre-port body no-op'd only
# in that mode (advisory + issues modes both enforced). This runs
# BEFORE sandbox check because it reads an env-var, no policy/CLI.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="security-disclosure-gate"
SHIM_INTRODUCED_IN="0.32.0"
SHIM_FAIL_OPEN=0
SHIM_REFUSAL_NOUN="disclosure-policy enforcement"

shim_is_relevant() {
  if ! printf '%s' "$INPUT" | grep -qE 'gh[[:space:]]+issue[[:space:]]+create'; then
    return 1
  fi
  # Mode short-circuit: REA_DISCLOSURE_MODE=disabled bypasses BEFORE
  # any CLI work. Implemented inline (no policy read needed).
  local mode="${REA_DISCLOSURE_MODE:-advisory}"
  if [ "$mode" = "disabled" ]; then
    return 1
  fi
  return 0
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
