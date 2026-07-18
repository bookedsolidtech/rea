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
# # Relevance pre-gate (round-13 F2 + round-17 F1 + round-36 F1)
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
# round-53 P1: FAIL-OPEN by default, but when the repo has OPTED IN —
# artifact_gates.g2_verify.mode ∈ {shadow, enforce} — a missing/unbuilt/too-old
# CLI must NOT silently drop the gate. Fail CLOSED so a Write/Edit that
# transitions a task to completed without evidence cannot bypass an active G2
# just because the CLI is unavailable in this checkout. _shim_gate_active reads
# the mode itself (self-contained awk over .rea/policy.yaml), so this editor-tier
# shim needs no extra policy-reader wiring beyond REA_ROOT.
SHIM_FAIL_CLOSED_WHEN_RELEVANT=1
SHIM_ACTIVE_GATE_KEY="g2_verify"

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
  # Build the set of governed store canonicals for THIS repo: the LOCAL
  # (worktree) root, the COMMON (primary-checkout) root, and — round-36 F1 —
  # every SIBLING worktree root. Mirrors the node gate's
  # resolvesToTasksJsonl(local, common, siblings, cwd, fp): a file_path (or a
  # symlink alias) that resolves to ANY of these stores is relevant and must
  # reach the core, else a no-evidence completion into another stream's store
  # slips past G2 in a linked-worktree setup. file_path is resolved against BOTH
  # the payload cwd AND REA_ROOT (round-17 F1). FAIL OPEN throughout: an
  # unresolvable path is simply skipped, never silently dropped.
  local common rp base store _wt
  local _vg_stores=()
  store=$(_vg_resolve ".rea/tasks.jsonl" "$REA_ROOT"); [ -n "$store" ] && _vg_stores+=("$store")
  common=$(rea_common_root "$REA_ROOT" 2>/dev/null || true)
  if [ -n "$common" ] && [ "$common" != "$REA_ROOT" ]; then
    store=$(_vg_resolve ".rea/tasks.jsonl" "$common"); [ -n "$store" ] && _vg_stores+=("$store")
  fi
  # Sibling worktrees. Spawn `git worktree list` ONLY when worktrees can exist
  # — a linked worktree (`.git` is a FILE) or a primary with a `.git/worktrees/`
  # dir; a plain checkout matches NEITHER and pays ~nothing (no git subprocess).
  # Every `worktree ` line except the local root and the primary (already
  # covered above); resolve each sibling's store with `_vg_resolve`.
  if [ -f "${REA_ROOT}/.git" ] || [ -d "${REA_ROOT}/.git/worktrees" ]; then
    while IFS= read -r _wt; do
      [ -n "$_wt" ] || continue
      [ "$_wt" = "$REA_ROOT" ] && continue
      { [ -n "$common" ] && [ "$_wt" = "$common" ]; } && continue
      store=$(_vg_resolve ".rea/tasks.jsonl" "$_wt"); [ -n "$store" ] && _vg_stores+=("$store")
    done < <(git -C "$REA_ROOT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  fi
  for base in "$cwd" "$REA_ROOT"; do
    [ -n "$base" ] || continue
    rp=$(_vg_resolve "$fp" "$base") || continue
    [ -n "$rp" ] || continue
    if [ "${#_vg_stores[@]}" -gt 0 ]; then
      for store in "${_vg_stores[@]}"; do
        [ "$rp" = "$store" ] && return 0
      done
    fi
  done
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
