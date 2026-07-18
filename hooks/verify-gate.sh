#!/bin/bash
# PreToolUse hook: verify-gate.sh
# 0.54.0+ — Node-binary shim for `rea hook verify-gate` (Artifact Gate G2).
#
# G2 verification-gate: refuses a Write/Edit to `.rea/tasks.jsonl` that
# transitions any task to `completed` without recorded `evidence`. The
# gate is policy-driven and DEFAULT-OFF (off|shadow|enforce via
# `policy.artifact_gates.g2_verify.mode`), so this shim is FAIL-OPEN:
# a missing/unbuilt CLI must NOT block task-store writes in a repo that
# never opted in. Full logic in `src/hooks/verify-gate/index.ts`.
#
# # Relevance pre-gate (round-13 F2: symlink-aware)
#
# Scan `tool_input.file_path` ONLY (not the raw payload), so a Write to
# some other file whose CONTENT mentions `.rea/tasks.jsonl` does not trip
# the shim. Beyond the literal name, RESOLVE the realpath of file_path
# (following symlinks; tolerating a not-yet-existing leaf) and forward when
# it points at the real store — otherwise a Write/Edit to an alias like
# `tasklog -> .rea/tasks.jsonl` would be gated out before the symlink-aware
# core (`resolvesToTasksJsonl`) ever runs. Portable to bash 3.2 / macOS: no
# GNU `realpath`/`readlink -f` — a `cd && pwd -P` + single-level `readlink`
# resolver. When jq is absent (cannot isolate file_path) the shim FAILS OPEN
# toward forwarding so an alias is never silently missed.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="verify-gate"
SHIM_INTRODUCED_IN="0.54.0"
SHIM_FAIL_OPEN=1
SHIM_REFUSAL_NOUN="task-completion verification"

# Canonicalize $1: follow symlinks, tolerate a missing leaf. Relative paths
# resolve against REA_ROOT (mirrors the core's path.resolve(reaRoot, fp)).
# Depth-guarded against symlink cycles. Echoes the resolved absolute path, or
# returns non-zero when the parent dir cannot be resolved.
_vg_resolve() {
  local p="$1" depth="${2:-0}" d b rd full tgt
  [ "$depth" -ge 40 ] && return 1
  case "$p" in
    /*) : ;;
    *) p="${REA_ROOT}/$p" ;;
  esac
  d=$(dirname "$p")
  b=$(basename "$p")
  rd=$(cd "$d" 2>/dev/null && pwd -P) || return 1
  full="$rd/$b"
  if [ -L "$full" ]; then
    tgt=$(readlink "$full" 2>/dev/null) || return 1
    case "$tgt" in
      /*) _vg_resolve "$tgt" "$((depth + 1))" ;;
      *) _vg_resolve "$rd/$tgt" "$((depth + 1))" ;;
    esac
  else
    printf '%s' "$full"
  fi
}

shim_is_relevant() {
  local fp
  if command -v jq >/dev/null 2>&1; then
    fp=$(printf '%s' "$INPUT" | jq -r '(.tool_input.file_path // .tool_input.notebook_path // "")' 2>/dev/null || true)
  else
    # No jq to isolate file_path — cannot rule out a symlink alias to the
    # store, so FAIL OPEN (forward) rather than miss it. The core is the
    # authoritative, fail-open gate.
    return 0
  fi
  [ -n "$fp" ] || return 1
  # Fast path: file_path literally names the store.
  case "$fp" in
    *.rea/tasks.jsonl) return 0 ;;
  esac
  # Symlink-aware: forward when file_path resolves to the real store.
  local rp rs
  rp=$(_vg_resolve "$fp") || return 1
  rs=$(_vg_resolve "${REA_ROOT}/.rea/tasks.jsonl") || return 1
  [ -n "$rp" ] && [ "$rp" = "$rs" ] && return 0
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
