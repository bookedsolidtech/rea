#!/bin/bash
# PreToolUse hook: blocked-paths-enforcer.sh
# Fires BEFORE every Write or Edit tool call.
# Reads blocked_paths from .rea/policy.yaml and blocks matching writes.
#
# This enforces the policy layer at the hook level — even if an agent ignores
# the CLAUDE.md rules or skips the orchestrator, the hook will catch it.
#
# Exit codes:
#   0 = allow (path not blocked)
#   2 = block (path matches a blocked_paths entry)

set -uo pipefail

# ── 1. Read ALL stdin immediately ─────────────────────────────────────────────
INPUT=$(cat)

# ── 2. Dependency check ──────────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  printf 'REA ERROR: jq is required but not installed.\n' >&2
  printf 'Install: brew install jq  OR  apt-get install -y jq\n' >&2
  exit 2
fi

# ── 3. HALT check ────────────────────────────────────────────────────────────
# 0.16.0: HALT check sourced from shared _lib/halt-check.sh.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

# ── 4. Extract file path from payload ─────────────────────────────────────────
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# ── 5. Load blocked_paths from policy ─────────────────────────────────────────
POLICY_FILE="${REA_ROOT}/.rea/policy.yaml"

if [[ ! -f "$POLICY_FILE" ]]; then
  exit 0
fi

# Parse blocked_paths using grep + sed (avoid yaml parser dependency)
# Handles both inline array [] and block sequence - "..." formats
BLOCKED_PATHS=()
IN_BLOCK=0
while IFS= read -r line; do
  # Check if we're entering blocked_paths section
  if printf '%s' "$line" | grep -qE '^blocked_paths:'; then
    # Check for inline empty array
    if printf '%s' "$line" | grep -qE 'blocked_paths:[[:space:]]*\[\]'; then
      break
    fi
    # Check for inline array with values
    if printf '%s' "$line" | grep -qE 'blocked_paths:[[:space:]]*\['; then
      # Extract inline array items
      items=$(printf '%s' "$line" | sed 's/.*\[//; s/\].*//; s/,/ /g')
      for item in $items; do
        cleaned=$(printf '%s' "$item" | sed "s/^[[:space:]]*[\"']//; s/[\"'][[:space:]]*$//")
        if [[ -n "$cleaned" ]]; then
          BLOCKED_PATHS+=("$cleaned")
        fi
      done
      break
    fi
    IN_BLOCK=1
    continue
  fi

  if [[ $IN_BLOCK -eq 1 ]]; then
    # Block sequence items start with "  - "
    if printf '%s' "$line" | grep -qE '^[[:space:]]+-'; then
      cleaned=$(printf '%s' "$line" | sed 's/^[[:space:]]*-[[:space:]]*//; s/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//')
      if [[ -n "$cleaned" ]]; then
        BLOCKED_PATHS+=("$cleaned")
      fi
    else
      # Non-indented line means we've left the block
      break
    fi
  fi
done < "$POLICY_FILE"

if [[ ${#BLOCKED_PATHS[@]} -eq 0 ]]; then
  exit 0
fi

# ── 6. Agent-writable allowlist ───────────────────────────────────────────────
# These paths under .rea/ must always be writable by agents regardless of
# what blocked_paths says. Blocking the whole .rea/ directory in policy
# is a common default, but tasks.jsonl is the PM data store — agents must
# write there. Settings-protection.sh guards the sensitive files explicitly.
AGENT_WRITABLE=(
  '.rea/tasks.jsonl'
  '.rea/audit/'
)

# 0.16.0: normalize_path migrated to shared `_lib/path-normalize.sh`.
# Both this hook AND settings-protection.sh consume the same helper
# so URL-decoding / backslash-translation / `./`-stripping cannot
# drift between them again.
# shellcheck source=_lib/path-normalize.sh
source "$(dirname "$0")/_lib/path-normalize.sh"

NORMALIZED=$(normalize_path "$FILE_PATH")

# ── 5a. Path-traversal rejection (0.14.0 iron-gate fix) ───────────────────────
# Reject any path containing a `..` segment BEFORE the literal-match below.
# Without this, `foo/../CODEOWNERS` would get past `normalize_path()` (which
# only strips leading project root + URL-decodes) and the literal-match
# loop would compare `foo/../CODEOWNERS` against the literal `CODEOWNERS`
# entry — which doesn't match, so the policy lets the write through. The
# downstream Write/Edit tool then resolves the traversal and writes to
# `CODEOWNERS` anyway, defeating the gate.
#
# Mirrors settings-protection.sh §5a (which has had this guard since
# 0.10.x). Both pre- and post-decode forms are checked because
# normalize_path() URL-decodes earlier and an attacker could split the
# traversal across encodings (`%2E%2E/`, `..%2F`, etc.).
raw_has_traversal=0
norm_has_traversal=0
case "/$FILE_PATH/" in
  */../*) raw_has_traversal=1 ;;
esac
case "/$NORMALIZED/" in
  */../*) norm_has_traversal=1 ;;
esac
# Also catch URL-encoded traversal in case some tool routes raw-encoded
# paths through here (e.g. file:// inputs). normalize_path()'s decoder
# only handles a fixed set; an unrecognized encoding would slip past.
case "$FILE_PATH" in
  *%2[Ee]%2[Ee]*|*%2[Ee].*|*.%2[Ee]*) raw_has_traversal=1 ;;
esac
if [[ "$raw_has_traversal" -eq 1 ]] || [[ "$norm_has_traversal" -eq 1 ]]; then
  {
    printf 'BLOCKED PATH: path traversal rejected\n'
    printf '\n'
    printf '  File: %s\n' "$FILE_PATH"
    printf "  Rule: path contains a '..' segment; rewrite to a canonical\n"
    printf '        project-relative path without traversal.\n'
  } >&2
  exit 2
fi

# ── 5a-bis. Reject interior single-dot segments (0.29.0 helix-/./-class) ─────
# Parallel to the `..` guard above. `normalize_path` does NOT collapse
# interior `./` segments — that would corrupt `..` traversals — which leaves
# a bypass class. A blocked entry of `.env` does not match `foo/./.env`
# (the literal-comparison loop is byte-for-byte), so an attacker who can
# influence the file_path string can dodge the policy entry.
#
# The conservative closure (per Jake 2026-05-12): treat any interior `/./`
# segment exactly like `..`. The NORMALIZED form is the safe surface for
# the check — `normalize_path` already stripped leading `./` segments, so
# any `/./` that survives is interior by construction. A raw-form check
# would false-positive on benign `./foo` paths (codex round 1 P2: a path
# like `%2E%2Fsrc/foo.ts` decodes to `./src/foo.ts` which is the same
# leading-`./` allowed shape the comment at the top of `normalize_path`
# documents — guarding against it on the raw form would block legit
# writes under `src/` and friends).
#
# URL-encoded companion: `.%2F` / `%2E/` / `%2E%2F` decode to `./` via
# `normalize_path` (which knows `%2E` → `.` and `%2F` → `/`). After
# URL-decode + leading-`./` strip, any encoded INTERIOR form hits the
# normalized `*/./* ` check. No raw-form encoded guard is needed — the
# normalize_path path already covers every encoded shape the helper
# decodes, and shapes it doesn't decode wouldn't resolve to an interior
# `./` segment on disk either.
norm_has_dot_segment=0
case "/$NORMALIZED/" in
  */./*) norm_has_dot_segment=1 ;;
esac
if [[ "$norm_has_dot_segment" -eq 1 ]]; then
  {
    printf 'BLOCKED PATH: interior dot-segment rejected\n'
    printf '\n'
    printf '  File: %s\n' "$FILE_PATH"
    printf "  Rule: path contains an interior '/./' segment; rewrite to a\n"
    printf '        canonical project-relative path without dot segments.\n'
  } >&2
  exit 2
fi

for writable in "${AGENT_WRITABLE[@]}"; do
  if [[ "$NORMALIZED" == "$writable" ]] || [[ "$NORMALIZED" == "$writable"* && "$writable" == */ ]]; then
    exit 0
  fi
done

# ── 7. Match against blocked_paths ───────────────────────────────────────────
LOWER_NORM=$(printf '%s' "$NORMALIZED" | tr '[:upper:]' '[:lower:]')

for blocked in "${BLOCKED_PATHS[@]}"; do
  LOWER_BLOCKED=$(printf '%s' "$blocked" | tr '[:upper:]' '[:lower:]')

  # Directory match (blocked path ends with /)
  if [[ "$LOWER_BLOCKED" == */ ]]; then
    if [[ "$LOWER_NORM" == "$LOWER_BLOCKED"* ]] || [[ "$LOWER_NORM" == "${LOWER_BLOCKED%/}" ]]; then
      {
        printf 'BLOCKED PATH: Write denied by policy\n'
        printf '\n'
        printf '  File: %s\n' "$FILE_PATH"
        printf '  Blocked by: %s\n' "$blocked"
        printf '  Source: .rea/policy.yaml → blocked_paths\n'
        printf '\n'
        printf '  This path is protected by policy. To modify it, a human must\n'
        printf '  either update blocked_paths in policy.yaml or edit the file directly.\n'
      } >&2
      exit 2
    fi
    continue
  fi

  # Glob pattern match (contains *)
  if [[ "$blocked" == *'*'* ]]; then
    # Convert glob to regex: . → \., * → .*
    regex=$(printf '%s' "$LOWER_BLOCKED" | sed 's/\./\\./g; s/\*/.*/g')
    if printf '%s' "$LOWER_NORM" | grep -qE "^${regex}$"; then
      {
        printf 'BLOCKED PATH: Write denied by policy\n'
        printf '\n'
        printf '  File: %s\n' "$FILE_PATH"
        printf '  Blocked by: %s (glob pattern)\n' "$blocked"
        printf '  Source: .rea/policy.yaml → blocked_paths\n'
      } >&2
      exit 2
    fi
    continue
  fi

  # Exact match
  if [[ "$LOWER_NORM" == "$LOWER_BLOCKED" ]]; then
    {
      printf 'BLOCKED PATH: Write denied by policy\n'
      printf '\n'
      printf '  File: %s\n' "$FILE_PATH"
      printf '  Blocked by: %s\n' "$blocked"
      printf '  Source: .rea/policy.yaml → blocked_paths\n'
    } >&2
    exit 2
  fi
done

# ── 0.16.0 fix H.2: intermediate-symlink resolution ──────────────────────────
# Same shape as Helix Finding 2 against blocked_paths policy entries.
# If `secrets/` is in blocked_paths and an attacker creates
# `pretty/ -> ../secrets/`, then writes `pretty/foo`, the literal-match
# loop above sees `pretty/foo` (no match) and exits 0 — the downstream
# Write tool follows the symlink and lands the body in `secrets/foo`.
# Mirrors settings-protection.sh §6c.
if [[ -e "$FILE_PATH" || -d "$(dirname -- "$FILE_PATH")" ]]; then
  parent_dir=$(dirname -- "$FILE_PATH")
  if [[ -d "$parent_dir" ]]; then
    resolved_parent=$(cd -P -- "$parent_dir" 2>/dev/null && pwd -P 2>/dev/null) || resolved_parent=""
    if [[ -n "$resolved_parent" && "$resolved_parent" == "$REA_ROOT"/* ]]; then
      relative_resolved="${resolved_parent#"$REA_ROOT"/}"
      resolved_target="${relative_resolved}/$(basename -- "$FILE_PATH")"
      resolved_target_lc=$(printf '%s' "$resolved_target" | tr '[:upper:]' '[:lower:]')
      for blocked in "${BLOCKED_PATHS[@]}"; do
        blocked_lc=$(printf '%s' "$blocked" | tr '[:upper:]' '[:lower:]')
        if [[ "$resolved_target_lc" == "$blocked_lc" ]] || \
           { [[ "$blocked_lc" == */ ]] && [[ "$resolved_target_lc" == "$blocked_lc"* ]]; }; then
          {
            printf 'BLOCKED PATH: intermediate-symlink resolution blocked\n'
            printf '\n'
            printf '  Logical:  %s\n' "$FILE_PATH"
            printf '  Resolved: %s\n' "$resolved_target"
            printf '  Blocked by: %s\n' "$blocked"
            printf '  Source: .rea/policy.yaml → blocked_paths\n'
            printf '\n'
            printf '  Rule: an intermediate directory of the path is a symlink\n'
            printf '        whose target falls inside a blocked policy entry.\n'
          } >&2
          exit 2
        fi
      done
    fi
  fi
fi

exit 0
