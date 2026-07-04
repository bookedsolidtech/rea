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
# Used ONLY by the CLI-PRESENT relevance pre-gate (`shim_is_relevant`),
# where an over-trigger just spawns the CLI (which then applies the precise
# channel-restricted BILLING_RE and no-ops on benign input) — cheap, and
# breadth is REQUIRED so the perf gate never drops a real signal.
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

# PROVIDER-SPECIFIC billing match — the full multi-word phrases from the
# CLI's BILLING_RE, matched as complete substrings. Used ONLY by the
# CLI-MISSING fail-closed path, where an over-trigger causes a FALSE HALT
# (exit 2) with no CLI to disambiguate.
#
# History of the precision/recall tuning:
#   - round-2 P2: a BARE-WORD set (`insufficient`, `billing`) false-blocked
#     `insufficient permissions` / a failed `cat billing-report.txt`.
#   - round-3 P1: a too-narrow set dropped walls the CLI matched.
#   - round-7 P2: `payment required` / `insufficient funds|credits|balance`
#     are ambiguous (paywall/402 + business-domain output), so BILLING_RE
#     itself dropped them — this set mirrors that. Until PR2's endpoint
#     scoping, only unambiguous PROVIDER billing walls fail closed.
# MUST stay in sync with BILLING_RE (`src/hooks/billing-cap-halt/index.ts`)
# — the parity test in `billing-cap-halt-shim.test.ts` enforces it. Takes
# already-lower-cased text on $1. bash 3.2 `case`.
_billing_kw_strict() {
  # ERE MIRROR of the CLI's BILLING_RE (src/hooks/billing-cap-halt/
  # index.ts), so the CLI-missing path catches the SAME provider walls the
  # compiled hook does — including the GAPPED `billing (hard )?(cap|limit)
  # … exceeded/reached` form (e.g. "billing limit for this project
  # exceeded") that fixed substrings missed (codex round-8 P1). bash 3.2
  # `=~` uses ERE; the pattern is lower-case because $1 is pre-lower-cased.
  # `[^.]{0,40}` mirrors BILLING_RE's bounded gap (newline handling differs
  # slightly — a coarse backstop errs toward CATCHING the wall). MUST stay
  # in sync with BILLING_RE; the parity test enforces it.
  local re='spending cap|prepayment credits (are )?depleted|billing (hard )?(cap|limit)[^.]{0,40}(exceeded|reached)|credit balance is too low|insufficient_quota'
  [[ "$1" =~ $re ]]
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
# command whose TEXT or STDOUT merely mentions a billing phrase (`rg
# "billing" .`, `cat THREAT_MODEL.md`, or `grep -R "spending cap" docs
# missing_dir`) does NOT get a false refusal when the rea CLI is unbuilt
# (codex 0.51.0 round-1 P2 / round-4 P1). We use node (available in this
# runtime) ONLY to EXTRACT the same channel the TS hook scans — STDERR
# ONLY — then apply the shared strict phrase set. No BILLING_RE is
# duplicated into bash; the CLI stays the authoritative matcher when
# present. If node is unavailable we cannot isolate the channel, so we fall
# back to the coarse whole-payload scan against the STRICT set (fail-closed
# in a doubly-degraded no-node-no-CLI environment).
shim_cli_missing_relevant() {
  if ! command -v node >/dev/null 2>&1; then
    local lower=""
    lower=$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]' 2>/dev/null || printf '%s' "$INPUT")
    _billing_kw_strict "$lower"
    return $?
  fi
  local errout=""
  errout=$(printf '%s' "$INPUT" | node -e '
    let d="";
    process.stdin.on("data",c=>d+=c).on("end",()=>{
      let p; try { p = JSON.parse(d); } catch { process.exit(0); }
      if (!p || typeof p !== "object" || Array.isArray(p)) process.exit(0);
      const tr = p.tool_response;
      // STDERR of a FAILED command only — mirrors the TS hook (round-4 +
      // round-7 P1/P3). Emit nothing on success so a passing command that
      // merely logs a phrase to stderr never fails closed. A bare-string
      // tool_response is stdout-equivalent (success) → contributes nothing.
      let stderr = "", errored = false;
      if (tr && typeof tr === "object" && !Array.isArray(tr)) {
        if (typeof tr.stderr === "string") stderr = tr.stderr;
        if (tr.success === false) errored = true;
        if (tr.is_error === true || tr.isError === true) errored = true;
        if (tr.error === true || (typeof tr.error === "string" && tr.error.length)) errored = true;
        if (tr.interrupted === true) errored = true;
        for (const k of ["exit_code","exitCode","code","returncode","status"]) if (typeof tr[k] === "number" && tr[k] !== 0) errored = true;
      }
      process.stdout.write(errored ? stderr : "");
    });
  ' 2>/dev/null) || return 0
  local lower=""
  lower=$(printf '%s' "$errout" | tr '[:upper:]' '[:lower:]' 2>/dev/null || printf '%s' "$errout")
  _billing_kw_strict "$lower"
}

# Policy short-circuit — honor an explicit OPT-OUT even when the CLI is
# unbuilt (codex round-8 P2). shim-runtime step 6 calls this BEFORE the
# CLI-missing / node-missing banners, using the CLI-independent policy
# reader (Tier 2 python3 / Tier 3 awk), so a repo that set
# `spend_governance.enabled: false` or `billing_error_response: off` no
# longer gets a fail-closed exit-2 refusal during the upgrade window.
#
# OPT-OUT semantics (mirrors readSpendGovernance): short-circuit (return 0
# → exit 0) ONLY on a POSITIVE opt-out. An absent block / unreadable value
# (e.g. a nested read the Tier 3 awk fallback can't resolve) is ON by
# default, so we return 1 and let the fail-closed relevance decision run —
# a spend guard must not vanish just because the value was unreadable.
shim_policy_short_circuit() {
  # MISSING policy file → disabled, matching readSpendGovernance
  # (ENOENT → no rea config → no-op). Without this the CLI-missing path
  # would fail closed on a checkout that has the hook registered but no
  # policy file, diverging from the built hook (codex round-10 P3). Base
  # dir mirrors readSpendGovernance's reaRoot (CLAUDE_PROJECT_DIR else the
  # resolved REA_ROOT).
  local proj_dir="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"
  if [ ! -e "$proj_dir/.rea/policy.yaml" ]; then
    return 0
  fi
  # shellcheck source=_lib/policy-reader.sh
  source "$(dirname "$0")/_lib/policy-reader.sh"
  local sg_enabled sg_mode
  sg_enabled=$(policy_reader_get spend_governance.enabled 2>/dev/null || true)
  if [ "$sg_enabled" = "false" ]; then
    return 0
  fi
  # SEED default is `warn` (round-12 P1): only an EXPLICIT `halt` should
  # fail closed (exit 2) in the CLI-missing window, since only `halt` blocks
  # at all. `warn` (banner, exit 0), `off`, and the absent-default `warn`
  # must NOT refuse the command. The shim can't emit the warn banner without
  # the CLI, so the correct degraded behavior for every non-halt mode is to
  # short-circuit (exit 0). Only `halt` proceeds to the fail-closed match.
  sg_mode=$(policy_reader_get spend_governance.billing_error_response 2>/dev/null || true)
  if [ "$sg_mode" != "halt" ]; then
    return 0
  fi
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
