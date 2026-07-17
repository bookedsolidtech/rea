#!/bin/bash
# hooks/_lib/halt-check.sh — HALT gate helper for rea hooks
# Source via: source "$(dirname "$0")/_lib/halt-check.sh"
#
# Every hook that can block a tool call must gate on .rea/HALT. When the file
# exists, all agent operations are suspended — the hook must deny the tool
# call with a clear error that surfaces the file's contents so the operator
# knows why the system was frozen.

# NOTE: do NOT set `-e` here. This file is sourced by hooks that
# intentionally tolerate non-zero exits (e.g. secret-scanner.sh runs
# multiple grep passes that may legitimately produce non-zero from
# patterns that don't match). Setting -e in the sourced lib would
# propagate to the caller and cause spurious exit-1s on any benign
# non-zero return. Only set the safer subset.
set -uo pipefail

# Find the .rea/ directory by walking up from CLAUDE_PROJECT_DIR or cwd.
# Falls back to CLAUDE_PROJECT_DIR or the current working directory when no
# .rea/ ancestor is found (which is fine — check_halt will simply no-op).
rea_root() {
  local dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  while [[ "$dir" != "/" ]]; do
    if [[ -d "$dir/.rea" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  printf '%s' "${CLAUDE_PROJECT_DIR:-$(pwd)}"
}

# Exit with code 2 (deny) if .rea/HALT exists.
# Prints the first 1024 bytes of HALT to stderr so the operator sees the
# reason the system was frozen. Safe to call from any hook.
# 0.54.0 worktree state — resolve the COMMON (primary-checkout) root for
# a linked worktree. Discriminator: a linked worktree's `.git` is a FILE
# (plain checkouts have a directory and pay only this -f test, zero git
# subprocesses). One `git rev-parse --git-common-dir` runs only inside a
# worktree. Any failure degrades to the local root — per-worktree
# isolation, the pre-0.54.0 behavior.
rea_common_root() {
  local root="$1"
  if [ ! -f "${root}/.git" ]; then
    printf '%s' "$root"
    return 0
  fi
  local common_dir
  common_dir=$(git -C "$root" rev-parse --git-common-dir 2>/dev/null) || {
    printf '%s' "$root"
    return 0
  }
  case "$common_dir" in
    /*) : ;;
    *) common_dir="${root}/${common_dir}" ;;
  esac
  local candidate
  candidate=$(dirname "$common_dir")
  if [ -d "${candidate}/.rea" ] || [ -e "${candidate}/.git" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  # Round-35 P2 (parity with resolveCommonRoot): a --separate-git-dir
  # primary keeps its metadata OUTSIDE the checkout, so the common
  # dir's parent is not a checkout. Try git's FIRST listed worktree
  # (the main one) before degrading to per-worktree isolation. In
  # practice git reports the metadata dir itself here (no back-pointer
  # exists), but if a future git exposes the real checkout this
  # upgrades automatically — mirroring the Node resolver.
  local main_wt
  main_wt=$(git -C "$root" worktree list --porcelain 2>/dev/null \
    | sed -n 's/^worktree //p' | head -n 1)
  if [ -n "$main_wt" ] && [ "$main_wt" != "$root" ] \
     && { [ -d "${main_wt}/.rea" ] || [ -e "${main_wt}/.git" ]; }; then
    printf '%s' "$main_wt"
    return 0
  fi
  printf '%s' "$root"
}

check_halt() {
  local root
  root=$(rea_root)
  # Repo-wide kill switch (0.54.0): probe the LOCAL worktree root first
  # (legacy per-worktree HALT still freezes its stream), then the COMMON
  # root, where `rea freeze` and the automated reflexes write — a freeze
  # in one worktree stops every stream. Plain checkouts probe once.
  local common
  common=$(rea_common_root "$root")
  local halt_file
  for halt_file in "${root}/.rea/HALT" "${common}/.rea/HALT"; do
    if [ -f "$halt_file" ]; then
      printf 'REA HALT: %s\nAll agent operations suspended. Run: rea unfreeze\n' \
        "$(head -c 1024 "$halt_file" 2>/dev/null || echo 'Reason unknown')" >&2
      exit 2
    fi
    [ "$root" = "$common" ] && break
  done
}
