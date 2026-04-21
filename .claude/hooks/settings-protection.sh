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

  # Strip leading ./ components only. We intentionally do NOT strip interior
  # ./ sequences — that transformation corrupts `..` traversals (e.g. `.../`
  # collapsed to `../`, or `../` collapsed to `./`) and hides traversal from
  # the §5a detector.
  while [[ "$p" == ./* ]]; do
    p="${p#./}"
  done

  printf '%s' "$p"
}

# Strip C0/C1 control characters from a string to prevent terminal escape
# injection when we echo protected paths back to the operator. Escape sequences
# in file names could otherwise rewrite lines above the deny message.
sanitize_for_stderr() {
  printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177'
}

NORMALIZED=$(normalize_path "$FILE_PATH")
SAFE_FILE_PATH=$(sanitize_for_stderr "$FILE_PATH")
SAFE_NORMALIZED=$(sanitize_for_stderr "$NORMALIZED")

# ── 5a. Reject path traversal segments (Codex HIGH: Defect I bypass) ─────────
# A path containing `..` segments can be used to bypass the protected-path
# globs in §6 — e.g. `.claude/hooks/../settings.json` would pass the
# `.claude/hooks/*` case-glob in the patch-session allowlist but actually
# refers to `.claude/settings.json`. We refuse any path that contains a `..`
# segment in either the raw input OR the normalized form. The request must
# be reissued with a canonical path.
raw_has_traversal=0
case "/$FILE_PATH/" in
  */../*) raw_has_traversal=1 ;;
esac
norm_has_traversal=0
case "/$NORMALIZED/" in
  */../*) norm_has_traversal=1 ;;
esac
if [[ "$raw_has_traversal" -eq 1 ]] || [[ "$norm_has_traversal" -eq 1 ]]; then
  {
    printf 'SETTINGS PROTECTION: path traversal rejected\n'
    printf '\n'
    printf '  File: %s\n' "$SAFE_FILE_PATH"
    printf "  Rule: path contains a '..' segment; rewrite to a canonical\n"
    printf '        project-relative path without traversal.\n'
  } >&2
  exit 2
fi

# ── 6. Protected path patterns ────────────────────────────────────────────────
# §6 runs BEFORE the patch-session allowlist so hook-patch sessions cannot
# reach .rea/policy.yaml, .rea/HALT, or .claude/settings.json via any glob
# creativity.
PROTECTED_PATTERNS=(
  '.claude/settings.json'
  '.claude/settings.local.json'
  '.husky/'
  '.rea/policy.yaml'
  '.rea/HALT'
)

# Patterns that are protected from general agent edits but can be unlocked by
# REA_HOOK_PATCH_SESSION. Kept separate from the hard-protected list above so
# the patch-session gate in §6b only applies to these directories.
PATCH_SESSION_PATTERNS=(
  '.claude/hooks/'
)

LOWER_NORM=$(printf '%s' "$NORMALIZED" | tr '[:upper:]' '[:lower:]')

# Match $NORMALIZED against PROTECTED_PATTERNS (exact or prefix for patterns
# ending in '/'). Sets $PROTECTED_MATCH to the matched pattern; exit 0 on hit.
match_protected() {
  local pattern
  PROTECTED_MATCH=""
  for pattern in "${PROTECTED_PATTERNS[@]}"; do
    if [[ "$NORMALIZED" == "$pattern" ]]; then
      PROTECTED_MATCH="$pattern"
      return 0
    fi
    if [[ "$pattern" == */ ]] && [[ "$NORMALIZED" == "$pattern"* ]]; then
      PROTECTED_MATCH="$pattern"
      return 0
    fi
  done
  return 1
}

match_protected_ci() {
  local pattern lp
  PROTECTED_MATCH=""
  for pattern in "${PROTECTED_PATTERNS[@]}"; do
    lp=$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')
    if [[ "$LOWER_NORM" == "$lp" ]]; then
      PROTECTED_MATCH="$pattern"
      return 0
    fi
    if [[ "$lp" == */ ]] && [[ "$LOWER_NORM" == "$lp"* ]]; then
      PROTECTED_MATCH="$pattern"
      return 0
    fi
  done
  return 1
}

match_patch_session() {
  local pattern
  PROTECTED_MATCH=""
  for pattern in "${PATCH_SESSION_PATTERNS[@]}"; do
    if [[ "$NORMALIZED" == "$pattern" ]]; then
      PROTECTED_MATCH="$pattern"
      return 0
    fi
    if [[ "$pattern" == */ ]] && [[ "$NORMALIZED" == "$pattern"* ]]; then
      PROTECTED_MATCH="$pattern"
      return 0
    fi
  done
  return 1
}

match_patch_session_ci() {
  local pattern lp
  PROTECTED_MATCH=""
  for pattern in "${PATCH_SESSION_PATTERNS[@]}"; do
    lp=$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')
    if [[ "$LOWER_NORM" == "$lp" ]]; then
      PROTECTED_MATCH="$pattern"
      return 0
    fi
    if [[ "$lp" == */ ]] && [[ "$LOWER_NORM" == "$lp"* ]]; then
      PROTECTED_MATCH="$pattern"
      return 0
    fi
  done
  return 1
}

if match_protected; then
  {
    printf 'SETTINGS PROTECTION: Modification blocked\n'
    printf '\n'
    printf '  File: %s\n' "$SAFE_FILE_PATH"
    printf '  Matched: %s\n' "$PROTECTED_MATCH"
    printf '  Rule: This file is protected from agent modification, including\n'
    printf '        sessions with REA_HOOK_PATCH_SESSION set.\n'
  } >&2
  exit 2
fi

if match_protected_ci; then
  {
    printf 'SETTINGS PROTECTION: Modification blocked (case-insensitive match)\n'
    printf '\n'
    printf '  File: %s\n' "$SAFE_FILE_PATH"
    printf '  Matched: %s\n' "$PROTECTED_MATCH"
  } >&2
  exit 2
fi

# ── 6b. Hook-patch session (Defect I / rea#76) ───────────────────────────────
# When REA_HOOK_PATCH_SESSION is set to a non-empty reason, allow edits under
# .claude/hooks/ and hooks/ for this session. The session boundary IS the
# expiry — a new shell requires a fresh opt-in. Every allowed edit is audited
# as hooks.patch.session so the bypass is never silent.
#
# SECURITY: runs AFTER §5a (traversal reject) and §6 (hard-protected denies),
# so no glob creativity can reach policy/HALT/settings files from here.
if [[ -n "${REA_HOOK_PATCH_SESSION:-}" ]]; then
  if match_patch_session; then
    SAFE_REASON=$(sanitize_for_stderr "${REA_HOOK_PATCH_SESSION}")
    # Audit record via the TypeScript chain so the hash chain stays intact.
    # If the append fails, block the edit — silent failure would let an
    # attacker disable audit logging and then patch hooks unobserved.
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
    ACTOR_NAME=$(git -C "$REA_ROOT" config user.name 2>/dev/null || printf 'unknown')
    ACTOR_EMAIL=$(git -C "$REA_ROOT" config user.email 2>/dev/null || printf 'unknown')

    AUDIT_PAYLOAD=$(
      REA_AUDIT_REASON="${REA_HOOK_PATCH_SESSION}" \
      REA_AUDIT_FILE="$NORMALIZED" \
      REA_AUDIT_SHA="$SHA_BEFORE" \
      REA_AUDIT_ACTOR_NAME="$ACTOR_NAME" \
      REA_AUDIT_ACTOR_EMAIL="$ACTOR_EMAIL" \
      REA_AUDIT_PID="$$" \
      REA_AUDIT_PPID="$PPID" \
      REA_AUDIT_SESSION="${CLAUDE_SESSION_ID:-external}" \
      node --input-type=module -e '
        import("'"${REA_ROOT}"'/dist/audit/append.js").then(async (mod) => {
          try {
            await mod.appendAuditRecord("'"${REA_ROOT}"'", {
              session_id: process.env.REA_AUDIT_SESSION,
              tool_name: "hooks.patch.session",
              server_name: "rea",
              tier: "write",
              status: "allowed",
              autonomy_level: "unknown",
              duration_ms: 0,
              metadata: {
                reason: process.env.REA_AUDIT_REASON,
                file: process.env.REA_AUDIT_FILE,
                sha_before: process.env.REA_AUDIT_SHA,
                actor: {
                  name: process.env.REA_AUDIT_ACTOR_NAME,
                  email: process.env.REA_AUDIT_ACTOR_EMAIL,
                },
                pid: Number(process.env.REA_AUDIT_PID),
                ppid: Number(process.env.REA_AUDIT_PPID),
              },
            });
            process.exit(0);
          } catch (e) {
            process.stderr.write("audit append failed: " + (e && e.message ? e.message : e) + "\n");
            process.exit(1);
          }
        }).catch((e) => {
          process.stderr.write("audit import failed: " + (e && e.message ? e.message : e) + "\n");
          process.exit(1);
        });
      ' 2>&1
    )
    AUDIT_EXIT=$?
    if [[ "$AUDIT_EXIT" -ne 0 ]]; then
      # dist may not be present (fresh checkout, install-time). Fall back to
      # a jq-formatted append ONLY to keep the hook usable in those cases —
      # but still refuse to allow the edit if neither path produces an entry.
      if [[ -d "$(dirname "$AUDIT_FILE")" ]] && command -v jq >/dev/null 2>&1; then
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
        if jq -n -c \
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
                      actor:{name:$actor_name, email:$actor_email}, pid:$pid, ppid:$ppid,
                      fallback:"no-dist"}}' \
          >> "$AUDIT_FILE" 2>/dev/null; then
          :
        else
          {
            printf 'SETTINGS PROTECTION: audit-append failed; refusing hook-patch edit\n'
            printf '  File: %s\n' "$SAFE_FILE_PATH"
          } >&2
          exit 2
        fi
      else
        {
          printf 'SETTINGS PROTECTION: audit-append failed; refusing hook-patch edit\n'
          printf '  File: %s\n' "$SAFE_FILE_PATH"
          printf '  Detail: %s\n' "$(sanitize_for_stderr "$AUDIT_PAYLOAD")"
        } >&2
        exit 2
      fi
    fi
    printf 'REA_HOOK_PATCH_SESSION: allowing edit to %s (reason: %s)\n' \
      "$SAFE_NORMALIZED" "$SAFE_REASON" >&2
    exit 0
  fi
fi

# ── 6c. Patch-session patterns are still blocked when env var is NOT set ─────
if match_patch_session; then
  {
    printf 'SETTINGS PROTECTION: Modification blocked\n'
    printf '\n'
    printf '  File: %s\n' "$SAFE_FILE_PATH"
    printf '  Matched: %s\n' "$PROTECTED_MATCH"
    printf '  Rule: Files under this path are protected. To apply an upstream\n'
    printf '        hook finding, set REA_HOOK_PATCH_SESSION=<reason> and retry.\n'
  } >&2
  exit 2
fi

if match_patch_session_ci; then
  {
    printf 'SETTINGS PROTECTION: Modification blocked (case-insensitive match)\n'
    printf '\n'
    printf '  File: %s\n' "$SAFE_FILE_PATH"
    printf '  Matched: %s\n' "$PROTECTED_MATCH"
  } >&2
  exit 2
fi

exit 0
