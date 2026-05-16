#!/bin/bash
# PostToolUse hook: architecture-review-gate.sh
# 0.33.0+ — Node-binary shim for `rea hook architecture-review-gate`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Advisory-tier: ALWAYS exit 0 (except HALT). Fires on every Write/
# Edit PostToolUse; the Node body short-circuits when policy patterns
# are unset/empty so the cost on the hot path is bounded.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="architecture-review-gate"
SHIM_INTRODUCED_IN="0.33.0"
SHIM_FAIL_OPEN=1
SHIM_REFUSAL_NOUN="the architecture-review advisory"

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
