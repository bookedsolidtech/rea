#!/bin/bash
# PostToolUse hook: billing-cap-halt.sh
# 0.51.0+ — Node-binary shim for `rea hook billing-cap-halt`.
#
# Spend-governance E1 seed (INCIDENT-2026-07-04, denial-of-wallet). Fires
# on every Bash PostToolUse. The real logic lives in
# `src/hooks/billing-cap-halt/index.ts`: it scans the just-run command's
# ERROR output for a BILLING-CLASS signature (spending cap / prepayment
# credits depleted / payment required — TERMINAL, distinct from a
# retryable 429) and, per `policy.spend_governance.billing_error_response`,
# writes `.rea/HALT` (the existing kill-switch every middleware + hook
# respects). The CLI is authoritative on CHANNEL selection (stderr always,
# stdout only on failure; never the command text or successful stdout);
# this shim's coarse keyword pre-gate is only a superset relevance filter.
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

# Shared coarse billing-keyword match. Superset of the CLI's BILLING_RE
# (never narrower — an under-trigger would be a missed billing halt).
# Takes already-lower-cased text on $1. bash 3.2 `case` glob match.
_billing_kw_match() {
  case "$1" in
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

# Relevance pre-gate for the CLI-PRESENT path — a pure PERF optimization.
# Scans the whole lower-cased payload (a cheap superset); an over-trigger
# just spawns the CLI, which then applies the precise, channel-restricted
# BILLING_RE and no-ops on benign input. Never misses a real signal.
shim_is_relevant() {
  local lower=""
  lower=$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]' 2>/dev/null || printf '%s' "$INPUT")
  _billing_kw_match "$lower"
}

# CLI-MISSING fail-closed decision — must be CHANNEL-ACCURATE so a benign
# command whose TEXT or SUCCESSFUL stdout merely mentions a billing phrase
# (`rg "billing" .`, `cat THREAT_MODEL.md`) does NOT get a false refusal
# when the rea CLI happens to be unbuilt (codex 0.51.0 round-1 P2). We use
# node (available in this runtime) ONLY to EXTRACT the same channels the TS
# hook scans — stderr always, stdout only on explicit failure — then apply
# the shared coarse keyword set. No BILLING_RE is duplicated into bash; the
# CLI stays the authoritative matcher when present. If node is unavailable
# we cannot split channels, so we fall back to the coarse whole-payload
# scan (fail-closed in a doubly-degraded no-node-no-CLI environment).
shim_cli_missing_relevant() {
  if ! command -v node >/dev/null 2>&1; then
    local lower=""
    lower=$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]' 2>/dev/null || printf '%s' "$INPUT")
    _billing_kw_match "$lower"
    return $?
  fi
  local errout=""
  errout=$(printf '%s' "$INPUT" | node -e '
    let d="";
    process.stdin.on("data",c=>d+=c).on("end",()=>{
      let p; try { p = JSON.parse(d); } catch { process.exit(0); }
      if (!p || typeof p !== "object" || Array.isArray(p)) process.exit(0);
      const tr = p.tool_response;
      let stderr = "", stdout = "", errored = false;
      if (typeof tr === "string") { stdout = tr; }
      else if (tr && typeof tr === "object" && !Array.isArray(tr)) {
        if (typeof tr.stderr === "string") stderr = tr.stderr;
        for (const k of ["stdout","output","content"]) if (typeof tr[k] === "string") stdout += "\n" + tr[k];
        if (tr.is_error === true || tr.isError === true) errored = true;
        if (tr.error === true || (typeof tr.error === "string" && tr.error.length)) errored = true;
        if (tr.interrupted === true) errored = true;
        for (const k of ["exit_code","exitCode","code","returncode","status"]) if (typeof tr[k] === "number" && tr[k] !== 0) errored = true;
      }
      process.stdout.write(errored ? (stderr + "\n" + stdout) : stderr);
    });
  ' 2>/dev/null) || return 0
  local lower=""
  lower=$(printf '%s' "$errout" | tr '[:upper:]' '[:lower:]' 2>/dev/null || printf '%s' "$errout")
  _billing_kw_match "$lower"
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
