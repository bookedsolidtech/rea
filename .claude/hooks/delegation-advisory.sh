#!/bin/bash
# PostToolUse hook: delegation-advisory.sh
# 0.31.0+ — delegation-telemetry completion (the *nudge*).
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Fires AFTER every write-class tool call. ALWAYS exits 0 except under
# HALT. The CLI maintains a per-session write-class counter; first
# crossing of `policy.delegation_advisory.threshold` with zero recorded
# delegation signals prints a one-time stderr advisory.
#
# # Synchronous, NOT detached
#
# Unlike delegation-capture.sh, this hook runs the CLI synchronously
# so the advisory text reaches stderr BEFORE the hook returns. The
# default `shim_default_forward` already does this — no override needed.
#
# # No version probe (codex round-1 P2)
#
# SHIM_SKIP_VERSION_PROBE=1: this hook runs on EVERY write-class
# PostToolUse (matcher `Bash|Edit|Write|MultiEdit|NotebookEdit`), so
# the hot path is hot. The pre-port body had NO version probe — it
# went straight from sandbox check to forward. Adding a probe doubles
# Node startups on every tool call (`--help` invocation + the real
# forward), which noticeably regresses interactive latency during
# long sessions. Skip the probe; a stale CLI without the subcommand
# will still fail at forward time, which is fine for an advisory-tier
# nudge (the operator will run `pnpm install` to fix it).

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="delegation-advisory"
SHIM_INTRODUCED_IN="0.31.0"
SHIM_FAIL_OPEN=1
SHIM_SKIP_VERSION_PROBE=1
SHIM_REFUSAL_NOUN="the delegation-advisory nudge"

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
