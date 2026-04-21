#!/bin/bash
# PreToolUse hook: settings-protection.sh
# Fires BEFORE every Write or Edit tool call.
# Blocks modifications to critical configuration files that, if tampered with,
# would disable the entire hook safety layer.
#
# Protected paths (security controls and hook infrastructure ONLY):
#   .claude/settings.json       — hook configuration
#   .claude/settings.local.json — local hook overrides
#   .claude/hooks/*             — hook scripts themselves
#   .husky/*                    — git hook scripts
#   .rea/policy.yaml        — autonomy/blocking policy
#   .rea/HALT               — kill switch file
#
# NOT protected (operational files agents may legitimately write):
#   .rea/review-cache.json  — cache file, writable by CLI and agents
#   .rea/tasks.jsonl        — task store, managed by task MCP tools
#
# Exit codes:
#   0 = allow (path not protected)
#   2 = block (protected path modification attempt)

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

# ── 5. Normalize path for comparison ──────────────────────────────────────────
# Convert to relative path from project root for consistent matching
normalize_path() {
  local p="$1"
  local root="$REA_ROOT"

  # Strip project root prefix if present
  if [[ "$p" == "$root"/* ]]; then
    p="${p#$root/}"
  fi

  # URL decode common sequences
  p=$(printf '%s' "$p" | sed 's/%2[Ff]/\//g; s/%2[Ee]/./g; s/%20/ /g')

  # Collapse path traversals
  # Remove ./ components
  p=$(printf '%s' "$p" | sed 's|\./||g')

  # Remove leading ./
  p="${p#./}"

  printf '%s' "$p"
}

NORMALIZED=$(normalize_path "$FILE_PATH")

# ── 5b. Hook-patch session (Defect I / rea#76) ───────────────────────────────
# When REA_HOOK_PATCH_SESSION is set to a non-empty reason, allow edits under
# .claude/hooks/ and hooks/ for this session. The session boundary IS the
# expiry — a new shell requires a fresh opt-in. Every allowed edit is audited
# as hooks.patch.session so the bypass is never silent.
#
# Only unblocks hook directories. .rea/policy.yaml, .rea/HALT,
# .claude/settings.json, and .claude/settings.local.json remain protected —
# this is a hook-maintenance escape hatch, not a policy-editing one.
if [[ -n "${REA_HOOK_PATCH_SESSION:-}" ]]; then
  case "$NORMALIZED" in
    .claude/hooks/*|hooks/*)
      # Emit audit record before allowing the edit. Best-effort: if jq or the
      # audit file writer fails, still allow — the audit trail is advisory,
      # not gating. Captures sha_before when the file exists so the audit
      # surface shows what was on disk prior to the edit.
      AUDIT_FILE="${REA_ROOT}/.rea/audit.jsonl"
      SHA_BEFORE=""
      if [[ -f "$FILE_PATH" ]]; then
        if command -v sha256sum >/dev/null 2>&1; then
          SHA_BEFORE=$(sha256sum "$FILE_PATH" 2>/dev/null | awk '{print $1}')
        elif command -v shasum >/dev/null 2>&1; then
          SHA_BEFORE=$(shasum -a 256 "$FILE_PATH" 2>/dev/null | awk '{print $1}')
        elif command -v openssl >/dev/null 2>&1; then
          SHA_BEFORE=$(openssl dgst -sha256 "$FILE_PATH" 2>/dev/null | awk '{print $NF}')
        fi
      fi
      if [[ -d "$(dirname "$AUDIT_FILE")" ]] && command -v jq >/dev/null 2>&1; then
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
        ACTOR_NAME=$(git -C "$REA_ROOT" config user.name 2>/dev/null || printf 'unknown')
        ACTOR_EMAIL=$(git -C "$REA_ROOT" config user.email 2>/dev/null || printf 'unknown')
        jq -n -c \
          --arg ts "$TIMESTAMP" \
          --arg session "${CLAUDE_SESSION_ID:-external}" \
          --arg tool "hooks.patch.session" \
          --arg server "rea" \
          --arg reason "${REA_HOOK_PATCH_SESSION}" \
          --arg file "$NORMALIZED" \
          --arg sha_before "$SHA_BEFORE" \
          --arg actor_name "$ACTOR_NAME" \
          --arg actor_email "$ACTOR_EMAIL" \
          --argjson pid "$$" \
          --argjson ppid "$PPID" \
          '{timestamp:$ts, session_id:$session, tool_name:$tool, server_name:$server,
            tier:"write", status:"allowed", autonomy_level:"unknown", duration_ms:0,
            metadata:{reason:$reason, file:$file, sha_before:$sha_before,
                      actor:{name:$actor_name, email:$actor_email}, pid:$pid, ppid:$ppid}}' \
          >> "$AUDIT_FILE" 2>/dev/null || true
      fi
      printf 'REA_HOOK_PATCH_SESSION: allowing edit to %s (reason: %s)\n' "$NORMALIZED" "${REA_HOOK_PATCH_SESSION}" >&2
      exit 0
      ;;
  esac
fi

# ── 6. Protected path patterns ────────────────────────────────────────────────
PROTECTED_PATTERNS=(
  '.claude/settings.json'
  '.claude/settings.local.json'
  '.claude/hooks/'
  '.husky/'
  '.rea/policy.yaml'
  '.rea/HALT'
)

for pattern in "${PROTECTED_PATTERNS[@]}"; do
  # Exact match
  if [[ "$NORMALIZED" == "$pattern" ]]; then
    {
      printf 'SETTINGS PROTECTION: Modification blocked\n'
      printf '\n'
      printf '  File: %s\n' "$FILE_PATH"
      printf '  Rule: This file is protected from agent modification.\n'
      printf '\n'
      printf '  Protected files include hook scripts, settings, policy,\n'
      printf '  and kill switch files. These must be modified by humans\n'
      printf '  via rea CLI or direct editing.\n'
      printf '\n'
      printf '  Use: rea init (to update hooks/settings)\n'
      printf '       rea freeze/unfreeze (for HALT file)\n'
      printf '       Edit .rea/policy.yaml manually\n'
    } >&2
    exit 2
  fi

  # Directory prefix match (patterns ending in /)
  if [[ "$pattern" == */ ]] && [[ "$NORMALIZED" == "$pattern"* ]]; then
    {
      printf 'SETTINGS PROTECTION: Modification blocked\n'
      printf '\n'
      printf '  File: %s\n' "$FILE_PATH"
      printf '  Rule: Files under %s are protected from agent modification.\n' "$pattern"
      printf '\n'
      printf '  These files control the hook safety layer and must be\n'
      printf '  modified by humans via rea CLI or direct editing.\n'
    } >&2
    exit 2
  fi
done

# ── 7. Case-insensitive fallback check ────────────────────────────────────────
# Catch case-manipulation bypass attempts (e.g., .Claude/Settings.json)
LOWER_NORM=$(printf '%s' "$NORMALIZED" | tr '[:upper:]' '[:lower:]')
for pattern in "${PROTECTED_PATTERNS[@]}"; do
  LOWER_PATTERN=$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')
  if [[ "$LOWER_NORM" == "$LOWER_PATTERN" ]]; then
    {
      printf 'SETTINGS PROTECTION: Modification blocked (case-insensitive match)\n'
      printf '\n'
      printf '  File: %s\n' "$FILE_PATH"
      printf '  Matched: %s\n' "$pattern"
    } >&2
    exit 2
  fi
  if [[ "$LOWER_PATTERN" == */ ]] && [[ "$LOWER_NORM" == "$LOWER_PATTERN"* ]]; then
    {
      printf 'SETTINGS PROTECTION: Modification blocked (case-insensitive match)\n'
      printf '\n'
      printf '  File: %s\n' "$FILE_PATH"
      printf '  Matched: %s*\n' "$pattern"
    } >&2
    exit 2
  fi
done

exit 0
