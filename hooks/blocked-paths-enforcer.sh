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
REA_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
HALT_FILE="${REA_ROOT}/.rea/HALT"
if [ -f "$HALT_FILE" ]; then
  printf 'REA HALT: %s\nAll agent operations suspended. Run: rea unfreeze\n' \
    "$(head -c 1024 "$HALT_FILE" 2>/dev/null || echo 'Reason unknown')" >&2
  exit 2
fi

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

normalize_path() {
  local p="$1"
  local root="$REA_ROOT"
  if [[ "$p" == "$root"/* ]]; then
    p="${p#$root/}"
  fi
  # 0.15.0 fix: include `\` (and `%5C` percent-encoded form) in the
  # normalization. Without this, a path like
  # `.github\workflows\release.yml` under Windows / Git Bash reaches
  # that file but compares as a different string than
  # `.github/workflows/release.yml`, missing the literal blocked-paths
  # match. Mirrors settings-protection.sh §4 which has had backslash
  # normalization since 0.10.x.
  p=$(printf '%s' "$p" | sed 's/%2[Ff]/\//g; s/%2[Ee]/./g; s/%20/ /g; s/%5[Cc]/\\/g')
  p=$(printf '%s' "$p" | tr '\\\\' '/')
  p="${p#./}"
  printf '%s' "$p"
}

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

exit 0
