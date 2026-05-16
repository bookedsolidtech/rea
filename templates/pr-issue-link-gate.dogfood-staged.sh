#!/bin/bash
# PreToolUse hook: pr-issue-link-gate.sh
# 0.32.0+ — Node-binary shim for `rea hook pr-issue-link-gate`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Advisory-tier: nudges operators to link an issue when running
# `gh pr create`. ALWAYS exit 0 except under HALT. The pre-port bash
# body lived here; the matching + advisory logic is now in
# `src/hooks/pr-issue-link-gate/index.ts`.
#
# # CLI-resolution trust boundary
#
# The shared runtime enforces the 2-tier sandboxed CLI resolution
# (node_modules → dist/, PATH intentionally omitted) + the realpath
# sandbox check. See `hooks/_lib/shim-runtime.sh` for the canonical
# trust boundary documentation.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="pr-issue-link-gate"
SHIM_INTRODUCED_IN="0.32.0"
SHIM_FAIL_OPEN=1
SHIM_REFUSAL_NOUN="the pr-issue-link advisory"

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
