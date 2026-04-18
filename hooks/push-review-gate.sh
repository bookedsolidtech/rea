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

# ── 6. Determine target branch(es) ───────────────────────────────────────────
# Parse the git push command and collect every destination refspec. We treat
# refspecs of the form `src:dst` as targeting `dst`; a bare refspec (no colon)
# targets itself. Anything that resolves to `HEAD` is rejected outright because
# `git merge-base HEAD HEAD` collapses to the current commit and the diff goes
# empty — an attacker-friendly bypass of this gate.
#
# Fail-closed on parse errors. If we see `git push` but cannot extract at least
# one usable target, we refuse the push rather than allow it through.
CURRENT_BRANCH=$(cd "$REA_ROOT" && git branch --show-current 2>/dev/null || echo "")

# Strip the leading `git push` (and any flags/remote) from the command, then
# tokenize what's left as refspecs. We scope to the first `git push` segment so
# that a chained `git push ... && echo done` does not drag unrelated tokens in.
PUSH_SEGMENT=$(printf '%s' "$CMD" | awk '
  {
    # Match the first `git push` occurrence; stop at shell separators.
    idx = match($0, /git[[:space:]]+push([[:space:]]|$)/)
    if (!idx) exit
    tail = substr($0, idx)
    # Cut at the first shell separator we care about.
    n = match(tail, /[;&|]|&&|\|\|/)
    if (n > 0) tail = substr(tail, 1, n - 1)
    print tail
  }
')

# Drop tokens that are flags (start with `-`), the literal `git`, `push`, and
# the remote (the first non-flag token after `push`). Whatever's left is the
# refspec list. This is deliberately permissive about quoting: the CMD we get
# comes from the Bash tool invocation, which is already shell-split.
PUSH_TARGETS=()
REMOTE_SEEN=0
SEEN_PUSH=0
# shellcheck disable=SC2086
set -- $PUSH_SEGMENT
for tok in "$@"; do
  case "$tok" in
    git|push) SEEN_PUSH=1; continue ;;
    -*) continue ;;  # flag
  esac
  if [[ "$SEEN_PUSH" -eq 0 ]]; then
    continue
  fi
  if [[ "$REMOTE_SEEN" -eq 0 ]]; then
    REMOTE_SEEN=1
    continue
  fi
  PUSH_TARGETS+=("$tok")
done

# Resolve each refspec to its destination branch name.
RESOLVED_TARGETS=()
for spec in "${PUSH_TARGETS[@]+"${PUSH_TARGETS[@]}"}"; do
  # Strip a leading `+` (force-with-colon syntax) — we still refuse force-push
  # to main elsewhere; for gate purposes it's just a destination.
  spec="${spec#+}"
  if [[ "$spec" == *:* ]]; then
    dst="${spec##*:}"
  else
    dst="$spec"
  fi
  # Canonicalize: strip leading refs/heads/ and any remotes/ prefix.
  dst="${dst#refs/heads/}"
  dst="${dst#refs/for/}"  # Gerrit-style; tolerate but treat as branch name
  if [[ -z "$dst" ]]; then
    continue
  fi
  if [[ "$dst" == "HEAD" ]]; then
    {
      printf 'PUSH BLOCKED: refspec resolves to HEAD (from %q)\n' "$spec"
      printf '\n'
      # shellcheck disable=SC2016  # backticks are literal markdown in user-facing message
      printf '  `git push <remote> HEAD:<branch>` or similar is almost always\n'
      printf '  operator error in this context. Name the destination branch\n'
      printf '  explicitly so the review gate can diff against it.\n'
      printf '\n'
    } >&2
    exit 2
  fi
  RESOLVED_TARGETS+=("$dst")
done

# No refspec on the command line means git uses the upstream / push.default.
# Fall back to the current branch's tracking target, or `main` if none.
if [[ "${#RESOLVED_TARGETS[@]}" -eq 0 ]]; then
  UPSTREAM=$(cd "$REA_ROOT" && git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo "")
  if [[ -n "$UPSTREAM" && "$UPSTREAM" == */* ]]; then
    RESOLVED_TARGETS+=("${UPSTREAM#*/}")
  else
    RESOLVED_TARGETS+=("main")
  fi
fi

# ── 7. Get diff against target(s) ────────────────────────────────────────────
# Pick the merge-base closest to HEAD across all targets. That way, if someone
# pushes `main dev` simultaneously, we capture every commit not yet on any of
# them. If no target has a resolvable merge-base, fail-closed — we'd rather
# block a stray push than diff against nothing.
MERGE_BASE=""
TARGET_BRANCH=""
for target in "${RESOLVED_TARGETS[@]}"; do
  MB=$(cd "$REA_ROOT" && git merge-base "$target" HEAD 2>/dev/null || echo "")
  if [[ -z "$MB" ]]; then
    continue
  fi
  if [[ -z "$MERGE_BASE" ]]; then
    MERGE_BASE="$MB"
    TARGET_BRANCH="$target"
    continue
  fi
  # Prefer the merge-base that is an ancestor of the other (i.e. the one closer
  # to HEAD). If they're unrelated, keep the first — conservative.
  if (cd "$REA_ROOT" && git merge-base --is-ancestor "$MERGE_BASE" "$MB" 2>/dev/null); then
    MERGE_BASE="$MB"
    TARGET_BRANCH="$target"
  fi
done

if [[ -z "$MERGE_BASE" ]]; then
  {
    printf 'PUSH BLOCKED: could not resolve a merge-base for any push target.\n'
    printf '\n'
    printf '  Targets tried: %s\n' "${RESOLVED_TARGETS[*]}"
    printf '  Fetch the remote and retry, or name an explicit destination.\n'
    printf '\n'
  } >&2
  exit 2
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
# Path match: we use `git diff --name-status` against the merge-base rather
# than scraping `+++`/`---` patch headers. Patch headers alone miss file
# deletions (the `+++` line is `/dev/null` for a deletion of a protected path),
# which is a trivial bypass. `--name-status` reports both the old and new path
# columns for every change type (A/C/D/M/R/T/U), so a protected path can be
# matched regardless of whether the change adds, removes, renames, or modifies.
#
# Proof-of-review match: we use `jq -e` with a structured predicate against
# top-level `tool_name` and `metadata.{head_sha, verdict}`. Substring greps
# against raw JSON lines are forgeable — the audit-append API accepts arbitrary
# `metadata`, so a record with `{"metadata":{"note":"tool_name:\"codex.review\""}}`
# would satisfy two independent greps. Match on the parsed structure instead.
PROTECTED_RE='(src/gateway/middleware/|hooks/|src/policy/|\.github/workflows/)'

PROTECTED_HITS=$(cd "$REA_ROOT" && git diff --name-status "$MERGE_BASE"...HEAD 2>/dev/null)
PROTECTED_DIFF_STATUS=$?
if [[ "$PROTECTED_DIFF_STATUS" -ne 0 ]]; then
  {
    printf 'PUSH BLOCKED: git diff --name-status failed (exit %s)\n' "$PROTECTED_DIFF_STATUS"
    printf '  Base: %s\n' "$MERGE_BASE"
    printf '  Cannot determine whether protected paths changed; refusing to pass.\n'
  } >&2
  exit 2
fi

if printf '%s\n' "$PROTECTED_HITS" | awk -v re="$PROTECTED_RE" '
    # Each line is: STATUS<TAB>PATH1[<TAB>PATH2]
    # Status is one or two letters (single letter for A/M/D/T/U; R/C are
    # followed by a similarity score like R100). We check every PATH column
    # against the protected-path regex so deletions, renames, and copies are
    # all caught.
    {
      status = $1
      if (status !~ /^[ACDMRTU]/) next
      for (i = 2; i <= NF; i++) {
        if ($i ~ re) { found = 1; next }
      }
    }
    END { exit found ? 0 : 1 }
  '; then
  HEAD_SHA=$(cd "$REA_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")
  if [[ -z "$HEAD_SHA" ]]; then
    {
      printf 'PUSH BLOCKED: could not resolve HEAD for Codex-review lookup.\n'
    } >&2
    exit 2
  fi

  AUDIT="${REA_ROOT}/.rea/audit.jsonl"
  CODEX_OK=0
  if [[ -f "$AUDIT" ]]; then
    # jq -e exits 0 iff at least one record matches every predicate. Any other
    # exit (including jq parse errors on a corrupt line) is treated as "no
    # proof of review" and we fail-closed.
    if jq -e --arg sha "$HEAD_SHA" '
        select(
          .tool_name == "codex.review"
          and .metadata.head_sha == $sha
          and .metadata.verdict != "blocking"
          and .metadata.verdict != "error"
        )
      ' "$AUDIT" >/dev/null 2>&1; then
      CODEX_OK=1
    fi
  fi
  if [[ "$CODEX_OK" -eq 0 ]]; then
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
      # shellcheck disable=SC2016  # backticks are literal markdown in user-facing message
      printf '  A `blocking` or `error` verdict does NOT satisfy this gate.\n'
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
