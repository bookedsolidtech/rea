#!/bin/bash
# PreToolUse hook: delegation-capture.sh
# 0.29.0+ — delegation-telemetry MVP.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Fires BEFORE every `Agent` or `Skill` tool call. Pipes the payload to
# `rea hook delegation-signal --detach`, BACKGROUNDED so the hook
# returns instantly even when the CLI's startup takes a few ms. The
# signal is OBSERVATIONAL — never gates tool dispatch.
#
# Matcher: `Agent|Skill` (NOT `Task|Skill`).
#
# # CLI subcommand differs from SHIM_NAME
#
# The forward target is `rea hook delegation-signal`, not `rea hook
# delegation-capture` — the hook name and the CLI subcommand differ.
# We use shim_forward to invoke the correct subcommand.
#
# # No version probe
#
# SHIM_SKIP_VERSION_PROBE=1: the pre-port body had no probe; a stale
# CLI drops the signal silently rather than emit a probe-skew banner
# on every Agent/Skill dispatch.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="delegation-capture"
SHIM_INTRODUCED_IN="0.29.0"
SHIM_FAIL_OPEN=1
SHIM_SKIP_VERSION_PROBE=1
SHIM_REFUSAL_NOUN="the delegation telemetry signal"

shim_forward() {
  # Pipe to `rea hook delegation-signal --detach`. `--detach` tells the
  # CLI to suppress stderr; the whole pipeline is backgrounded with
  # `& disown` so the shell hook returns instantly.
  {
    printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook delegation-signal --detach \
      >/dev/null 2>&1 &
    disown 2>/dev/null || true
  } 2>/dev/null
  exit 0
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
