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
# # Relevance pre-gate (round-13 F2 + round-17 F1)
#
# Scan `tool_input.file_path` ONLY (not the raw payload), so a Write to some
# other file whose CONTENT mentions `.rea/tasks.jsonl` does not trip the shim.
# Beyond the literal name, RESOLVE the realpath of file_path (following
# symlinks; tolerating a not-yet-existing leaf) and forward when it points at
# the real store — otherwise a Write/Edit to an alias like
# `tasklog -> .rea/tasks.jsonl` would be gated out before the symlink-aware
# core (`resolvesToTasksJsonl`) ever runs.
#
# round-17 F1: mirror the node gate's resolution EXACTLY — resolve file_path
# against BOTH the payload `cwd` (a cwd-relative `../../.rea/tasks.jsonl` from a
# subdirectory) AND `REA_ROOT`, and match against the store of BOTH the local
# (worktree) root AND the common (primary-checkout) root. Without this, editing
# the store from a subdir or a sibling worktree path bypassed the shim.
#
# Portable to bash 3.2 / macOS: no GNU `realpath`/`readlink -f` — a
# `cd && pwd -P` + single-level `readlink` resolver, base as a parameter. When
# jq is absent (cannot isolate file_path/cwd) the shim FAILS OPEN toward
# forwarding so an alias/relative path is never silently missed.

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="verify-gate"
SHIM_INTRODUCED_IN="0.54.0"
SHIM_FAIL_OPEN=1
SHIM_REFUSAL_NOUN="task-completion verification"

# Canonicalize $1: follow symlinks, tolerate a missing leaf. A relative path
# resolves against $2 (its base). Depth-guarded against symlink cycles. Echoes
# the resolved absolute path, or returns non-zero when the parent dir cannot be
# resolved. (round-17 F1: base is now a parameter so a cwd-relative file_path
# can resolve against the PAYLOAD CWD, not just REA_ROOT.)
_vg_resolve() {
  local p="$1" base="$2" depth="${3:-0}" d b rd full tgt
  [ "$depth" -ge 40 ] && return 1
  case "$p" in
    /*) : ;;
    *) p="${base}/$p" ;;
  esac
  d=$(dirname "$p")
  b=$(basename "$p")
  rd=$(cd "$d" 2>/dev/null && pwd -P) || return 1
  full="$rd/$b"
  if [ -L "$full" ]; then
    tgt=$(readlink "$full" 2>/dev/null) || return 1
    # A symlink target that is relative resolves against the link's own dir.
    case "$tgt" in
      /*) _vg_resolve "$tgt" "/" "$((depth + 1))" ;;
      *) _vg_resolve "${rd}/${tgt}" "/" "$((depth + 1))" ;;
    esac
  else
    printf '%s' "$full"
  fi
}

shim_is_relevant() {
  local fp cwd
  if command -v jq >/dev/null 2>&1; then
    fp=$(printf '%s' "$INPUT" | jq -r '(.tool_input.file_path // .tool_input.notebook_path // "")' 2>/dev/null || true)
    # round-17 F1: read the payload cwd exactly as the node gate does, so a
    # cwd-relative file_path (e.g. `../../.rea/tasks.jsonl` from a subdir) is
    # resolved against the right base.
    cwd=$(printf '%s' "$INPUT" | jq -r '(.cwd // "")' 2>/dev/null || true)
  else
    # No jq to isolate file_path — cannot rule out an alias / subdir-relative
    # path to the store, so FAIL OPEN (forward) rather than miss it. The core
    # is the authoritative, fail-open gate.
    return 0
  fi
  [ -n "$fp" ] || return 1
  # Fast path: file_path literally names the store.
  case "$fp" in
    *.rea/tasks.jsonl) return 0 ;;
  esac
  # round-17 F1: resolve the store for BOTH the local (worktree) root AND the
  # common (primary-checkout) root, and resolve file_path against BOTH the
  # payload cwd AND REA_ROOT — mirrors the node gate's
  # resolvesToTasksJsonl(local, common, cwd, fp). A subdir- or sibling-worktree-
  # relative path that lands on either store is relevant.
  local common rs_local rs_common rp base
  rs_local=$(_vg_resolve ".rea/tasks.jsonl" "$REA_ROOT")
  common=$(rea_common_root "$REA_ROOT" 2>/dev/null || true)
  if [ -n "$common" ] && [ "$common" != "$REA_ROOT" ]; then
    rs_common=$(_vg_resolve ".rea/tasks.jsonl" "$common")
  else
    rs_common=""
  fi
  for base in "$cwd" "$REA_ROOT"; do
    [ -n "$base" ] || continue
    rp=$(_vg_resolve "$fp" "$base") || continue
    [ -n "$rp" ] || continue
    if [ -n "$rs_local" ] && [ "$rp" = "$rs_local" ]; then return 0; fi
    if [ -n "$rs_common" ] && [ "$rp" = "$rs_common" ]; then return 0; fi
  done
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
