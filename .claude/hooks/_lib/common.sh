#!/bin/bash
# hooks/_lib/common.sh — shared utilities for rea hooks
# Source via: source "$(dirname "$0")/_lib/common.sh"

# Find the .rea/ directory by walking up from CLAUDE_PROJECT_DIR or cwd
rea_root() {
  local dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  while [[ "$dir" != "/" ]]; do
    if [[ -d "$dir/.rea" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  # Fallback to CLAUDE_PROJECT_DIR or cwd
  printf '%s' "${CLAUDE_PROJECT_DIR:-$(pwd)}"
}

# Exit with code 2 if .rea/HALT exists
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

# Verify jq is available, exit 2 if not
require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    printf 'REA ERROR: jq is required but not installed.\n' >&2
    printf 'Install: brew install jq  OR  apt-get install -y jq\n' >&2
    exit 2
  fi
}

# Build a structured JSON response for hook output
# Usage: json_output "status" "message" ["decision"]
#   status: "block" | "allow" | "advisory"
#   message: human-readable description
#   decision: optional additionalContext for the agent
json_output() {
  local status="$1"
  local message="$2"
  local decision="${3:-}"

  if [[ "$status" == "block" ]]; then
    printf '%s\n' "$message" >&2
    if [[ -n "$decision" ]]; then
      printf '%s\n' "$decision" >&2
    fi
    exit 2
  elif [[ "$status" == "advisory" ]]; then
    printf '%s\n' "$message" >&2
    exit 0
  else
    exit 0
  fi
}

# Exit 0 (skip) if the project's tech_profile does not match the expected type.
# Usage: check_project_type "lit-wc"
# Reads tech_profile from .rea/policy.yaml; if absent or mismatched, exits 0.
check_project_type() {
  local expected_type="$1"
  local root
  root=$(rea_root)
  local policy="${root}/.rea/policy.yaml"
  if [[ ! -f "$policy" ]]; then
    exit 0
  fi
  local actual_type
  actual_type=$(grep -E '^tech_profile:' "$policy" 2>/dev/null | sed 's/^tech_profile:[[:space:]]*//' | tr -d '"' || echo "")
  if [[ -z "$actual_type" || "$actual_type" != "$expected_type" ]]; then
    exit 0
  fi
}

# Score a diff for triage purposes
# Reads from stdin (expects unified diff output)
# Returns: "trivial" (<20 lines), "standard" (20-200), "significant" (>200)
# Also checks for sensitive paths — upgrades to "significant" if found
triage_score() {
  local diff_input
  diff_input=$(cat)
  local line_count
  # Defect K (rea#62) sibling: see `hooks/commit-review-gate.sh` for the
  # full bug rationale. `|| echo "0"` captures "0\n0" on no-match, which
  # breaks arithmetic comparisons downstream. `|| true` + bash default keeps
  # the branch arithmetic-safe.
  line_count=$(printf '%s' "$diff_input" | grep -cE '^\+[^+]|^-[^-]' 2>/dev/null || true)
  line_count="${line_count:-0}"

  # Check for sensitive paths
  local sensitive=0
  if printf '%s' "$diff_input" | grep -qE '^\+\+\+ .*(\.rea/|\.claude/|\.env|auth|security|\.github/workflows)'; then
    sensitive=1
  fi

  if [[ $sensitive -eq 1 ]] || [[ $line_count -gt 200 ]]; then
    printf 'significant'
  elif [[ $line_count -ge 20 ]]; then
    printf 'standard'
  else
    printf 'trivial'
  fi
}
