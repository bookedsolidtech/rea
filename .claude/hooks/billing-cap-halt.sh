#!/bin/bash
# PostToolUse hook: billing-cap-halt.sh
# 0.51.0+ — Node-binary shim for `rea hook billing-cap-halt`.
#
# Spend-governance E1 seed (INCIDENT-2026-07-04, denial-of-wallet). Fires
# on every Bash PostToolUse. The real logic lives in
# `src/hooks/billing-cap-halt/index.ts`: it scans the just-run command AND
# its output for a BILLING-CLASS signature (spending cap / prepayment
# credits depleted / payment required — TERMINAL, distinct from a
# retryable 429) and, per `policy.spend_governance.billing_error_response`,
# writes `.rea/HALT` (the existing kill-switch every middleware + hook
# respects).
#
# # Fail posture — FAIL-CLOSED (SHIM_FAIL_OPEN=0)
#
# A billing reflex that silently disappears is the incident. So when the
# rea CLI is unreachable AND the payload carries a billing signature, this
# shim refuses loudly (banner + exit 2) rather than passing through. That
# is the whole point: the one place we must NOT fail-open is the spend
# wall. The payload-integrity failure mode (malformed JSON) is fail-SAFE
# and handled inside the CLI body (exit 0, no freeze) — see its header.
#
# # Relevance pre-gate (cost + fail-closed shaping)
#
# `shim_is_relevant` lower-cases the raw payload and looks for a COARSE
# SUPERSET of the billing phrases the CLI's `BILLING_RE` can match. When
# none is present the shim exits 0 immediately WITHOUT spawning node — so
# the common case (ordinary Bash output) costs nothing. When a keyword IS
# present the shim proceeds to the CLI for a precise match; and if the CLI
# is missing at that point, the FAIL_OPEN=0 no-CLI terminal fires the
# fail-closed banner. The keyword set MUST stay a superset of `BILLING_RE`
# — any phrase the CLI can match must also trip this coarse gate, or a
# real signal could be dropped before the CLI ever sees it.
#
# # bash 3.2 (macOS default) compatible.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="billing-cap-halt"
SHIM_INTRODUCED_IN="0.51.0"
SHIM_FAIL_OPEN=0
SHIM_REFUSAL_NOUN="the billing-cap-halt reflex"

# Coarse billing-keyword pre-gate. Superset of the CLI's BILLING_RE. Runs
# on the lower-cased raw payload (which includes tool_response output), so
# casing in vendor error strings ("Spending Cap", "SPENDING CAP") is
# normalized. Over-trigger is cheap (one node spawn); under-trigger would
# be a missed billing halt, so keep this list wider than BILLING_RE.
shim_is_relevant() {
  local lower=""
  lower=$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]' 2>/dev/null || printf '%s' "$INPUT")
  case "$lower" in
    *"spending cap"*) return 0 ;;
    *"prepayment credit"*) return 0 ;;
    *"credit balance"*) return 0 ;;
    *"insufficient"*) return 0 ;;
    *"payment required"*) return 0 ;;
    *"billing"*) return 0 ;;
    *"402 payment"*) return 0 ;;
  esac
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
