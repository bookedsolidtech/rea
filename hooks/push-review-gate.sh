#!/bin/bash
# PreToolUse hook: push-review-gate.sh
# Fires BEFORE every Bash tool call that matches "git push".
# Runs a full diff analysis against the target branch and requests
# security + code review before allowing the push.
#
# Exit codes:
#   0 = allow (no meaningful diff, or review cached)
#   2 = block (needs review)

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

# ── 4. Parse command ──────────────────────────────────────────────────────────
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [[ -z "$CMD" ]]; then
  exit 0
fi

# Only trigger on git push commands
if ! printf '%s' "$CMD" | grep -qiE 'git[[:space:]]+push'; then
  exit 0
fi

# ── 5. Check if quality gates are enabled ─────────────────────────────────────
POLICY_FILE="${REA_ROOT}/.rea/policy.yaml"
if [[ -f "$POLICY_FILE" ]]; then
  if grep -qE 'push_review:[[:space:]]*false' "$POLICY_FILE" 2>/dev/null; then
    exit 0
  fi
fi

# ── 6. Determine target branch ───────────────────────────────────────────────
CURRENT_BRANCH=$(cd "$REA_ROOT" && git branch --show-current 2>/dev/null || echo "")
TARGET_BRANCH="main"

# Try to extract target from push command (git push origin <branch>)
PUSH_TARGET=$(printf '%s' "$CMD" | grep -oE 'git[[:space:]]+push[[:space:]]+[a-zA-Z_-]+[[:space:]]+([a-zA-Z0-9/_-]+)' | awk '{print $NF}' 2>/dev/null || echo "")
if [[ -n "$PUSH_TARGET" ]]; then
  TARGET_BRANCH="$PUSH_TARGET"
fi

# ── 7. Get diff against target ───────────────────────────────────────────────
MERGE_BASE=$(cd "$REA_ROOT" && git merge-base "$TARGET_BRANCH" HEAD 2>/dev/null || echo "")

if [[ -z "$MERGE_BASE" ]]; then
  # Can't determine merge base — fail-open
  exit 0
fi

DIFF_FULL=$(cd "$REA_ROOT" && git diff "$MERGE_BASE"...HEAD 2>/dev/null || echo "")

if [[ -z "$DIFF_FULL" ]]; then
  # No diff — nothing to review
  exit 0
fi

LINE_COUNT=$(printf '%s' "$DIFF_FULL" | grep -cE '^\+[^+]|^-[^-]' 2>/dev/null || echo "0")

# ── 7a. Protected-path Codex adversarial review gate ────────────────────────
# If the diff touches governance-critical directories, require a codex.review
# audit entry for the current HEAD. This enforces the Plan → Build → Review
# loop for the very code that enforces it.
#
# Rationale for gating at push and NOT at commit: commit-review-gate.sh already
# performs cache-based review with triage thresholds. Doubling friction at
# every commit is pointless because nothing lands remote without passing the
# push gate. Leave commit-review-gate alone; do NOT add a mirror of this check
# there.
#
# Format of the match: grep for the CODEX_REVIEW_TOOL_NAME constant
# ("codex.review") co-located with the exact head_sha string on a single
# audit.jsonl line. This is sufficient for MVP — full JSON + chain validation
# via jq is a later pass (noted in src/audit/codex-event.ts).
PROTECTED_RE='(src/gateway/middleware/|hooks/|src/policy/|\.github/workflows/)'
if printf '%s' "$DIFF_FULL" | grep -qE "^\+\+\+ .*${PROTECTED_RE}"; then
  HEAD_SHA=$(cd "$REA_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")
  AUDIT="${REA_ROOT}/.rea/audit.jsonl"
  CODEX_OK=0
  if [ -n "$HEAD_SHA" ] && [ -f "$AUDIT" ]; then
    if grep -F "\"head_sha\":\"${HEAD_SHA}\"" "$AUDIT" 2>/dev/null \
      | grep -q '"tool_name":"codex.review"'; then
      CODEX_OK=1
    fi
  fi
  if [ "$CODEX_OK" -eq 0 ]; then
    {
      printf 'PUSH BLOCKED: protected paths changed — /codex-review required for HEAD %s\n' "$HEAD_SHA"
      printf '\n'
      printf '  Diff touches one of:\n'
      printf '    - src/gateway/middleware/\n'
      printf '    - hooks/\n'
      printf '    - src/policy/\n'
      printf '    - .github/workflows/\n'
      printf '\n'
      printf '  Run /codex-review against HEAD, then retry the push.\n'
      printf '  The codex-adversarial agent emits the required audit entry.\n'
      printf '\n'
    } >&2
    exit 2
  fi
fi

# ── 8. Check review cache ────────────────────────────────────────────────────
PUSH_SHA=$(printf '%s' "$DIFF_FULL" | shasum -a 256 | cut -d' ' -f1 2>/dev/null || echo "")

# Resolve rea CLI (node_modules/.bin first, dist fallback)
REA_CLI_ARGS=()
if [[ -f "${REA_ROOT}/node_modules/.bin/rea" ]]; then
  REA_CLI_ARGS=(node "${REA_ROOT}/node_modules/.bin/rea")
elif [[ -f "${REA_ROOT}/dist/cli/index.js" ]]; then
  REA_CLI_ARGS=(node "${REA_ROOT}/dist/cli/index.js")
fi

if [[ -n "$PUSH_SHA" ]] && [[ ${#REA_CLI_ARGS[@]} -gt 0 ]]; then
  CACHE_RESULT=$("${REA_CLI_ARGS[@]}" cache check "$PUSH_SHA" --branch "$CURRENT_BRANCH" --base "$TARGET_BRANCH" 2>/dev/null || echo '{"hit":false}')
  if printf '%s' "$CACHE_RESULT" | jq -e '.hit == true' >/dev/null 2>&1; then
    # Review was already approved — notify and allow the push through
    DISCORD_LIB="${REA_ROOT}/hooks/_lib/discord.sh"
    if [ -f "$DISCORD_LIB" ]; then
      # shellcheck source=/dev/null
      source "$DISCORD_LIB"
      discord_notify "dev" "Push passed quality gates on \`${CURRENT_BRANCH}\` -- $(cd "$REA_ROOT" && git log -1 --oneline 2>/dev/null)" "green"
    fi
    exit 0
  fi
fi

# ── 9. Block and request review ──────────────────────────────────────────────
FILE_COUNT=$(printf '%s' "$DIFF_FULL" | grep -c '^\+\+\+ ' 2>/dev/null || echo "0")

{
  printf 'PUSH REVIEW GATE: Review required before pushing\n'
  printf '\n'
  printf '  Branch: %s → %s\n' "$CURRENT_BRANCH" "$TARGET_BRANCH"
  printf '  Scope: %s files changed, %s lines\n' "$FILE_COUNT" "$LINE_COUNT"
  printf '\n'
  printf '  Action required:\n'
  printf '  1. Spawn a code-reviewer agent to review: git diff %s...HEAD\n' "$MERGE_BASE"
  printf '  2. Spawn a security-engineer agent for security review\n'
  printf '  3. After both pass, cache the result:\n'
  printf '     rea cache set %s pass --branch %s --base %s\n' "$PUSH_SHA" "$CURRENT_BRANCH" "$TARGET_BRANCH"
  printf '\n'
} >&2
exit 2
