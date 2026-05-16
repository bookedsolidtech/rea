#!/bin/bash
# PreToolUse hook: attribution-advisory.sh
# 0.32.0+ — Node-binary shim for `rea hook attribution-advisory`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Blocking-tier when `policy.block_ai_attribution: true`. Pre-port body
# was 162 LOC; full migration in `src/hooks/attribution-advisory/index.ts`.
#
# # Relevance pre-gate
#
# Substring match for `git commit` or `gh pr create|edit` ANYWHERE in
# the command string (allow shell prefixes). Plain substring scan is
# used instead of JSON-aware regex because escaped quotes in quoted
# env prefixes (`MODE="x" gh pr create …`) trip JSON-anchored patterns.
# Over-trigger costs one CLI spawn; the Node body handles correctness.
#
# # Policy short-circuit (codex round 2 P1 from 0.37.0)
#
# The block_ai_attribution policy read runs AFTER the sandbox check so
# REA_ARGV is trusted for Tier-1 reads. When the policy is disabled,
# exit 0 cleanly — the pre-port bash body no-op'd when the key was
# absent or false.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="attribution-advisory"
SHIM_INTRODUCED_IN="0.32.0"
SHIM_FAIL_OPEN=0
SHIM_REFUSAL_NOUN="attribution-policy enforcement"

shim_is_relevant() {
  if printf '%s' "$INPUT" | grep -qE '(git[[:space:]]+commit|gh[[:space:]]+pr[[:space:]]+(create|edit))'; then
    return 0
  fi
  return 1
}

shim_policy_short_circuit() {
  # shellcheck source=_lib/policy-reader.sh
  source "$(dirname "$0")/_lib/policy-reader.sh"
  local attr_enabled
  attr_enabled=$(policy_reader_get block_ai_attribution)
  if [ "$attr_enabled" != "true" ]; then
    # Attribution blocking disabled (or unreadable on Tier 3 fallback +
    # missing policy file) — pre-port body exit 0.
    return 0
  fi
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
