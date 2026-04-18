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

# ── 6. Determine source/target commits for each refspec ──────────────────────
# The authoritative source for which commits are being pushed is the pre-push
# hook stdin contract: one line per refspec, with fields
#     <local_ref> <local_sha> <remote_ref> <remote_sha>
# (https://git-scm.com/docs/githooks#_pre_push). We drive the gate off those
# SHAs directly — NOT off HEAD — so that `git push origin hotfix:main` from a
# checked-out `foo` branch reviews the `hotfix` commits, not `foo`.
#
# Two execution paths:
#   1. Real `git push`: stdin is forwarded from git and contains refspec lines.
#      This is what runs in production.
#   2. Hook invoked outside a real push (manual test, the Bash PreToolUse path
#      where we only see the command string): stdin has no refspec lines. We
#      fall back to parsing the command string and diffing against HEAD, but
#      we refuse to let `src:dst` silently escape — see resolve_argv_refspecs.
#
# The REA PreToolUse wrapper currently delivers the Claude Code tool_input on
# stdin as JSON. If what we read on stdin does not look like pre-push refspec
# lines, we treat it as "no stdin" and use the argv fallback.
ZERO_SHA='0000000000000000000000000000000000000000'
CURRENT_BRANCH=$(cd "$REA_ROOT" && git branch --show-current 2>/dev/null || echo "")

# Parse pre-push stdin into newline-separated "local_sha|remote_sha|local_ref|remote_ref"
# records on stdout. Exits non-zero without any output if stdin does not match
# the pre-push contract, so the caller can switch to the argv fallback.
#
# Pre-push stdin is plain whitespace-separated text, one line per refspec.
# Every field is either a ref name or a 40-hex SHA. We require at least one
# well-formed line to accept the input. Returning via stdout (instead of bash 4
# namerefs) keeps this portable to macOS /bin/bash 3.2.
parse_prepush_stdin() {
  local raw="$1"
  local accepted=0
  local line local_ref local_sha remote_ref remote_sha rest
  local -a records
  records=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    read -r local_ref local_sha remote_ref remote_sha rest <<<"$line"
    if [[ -z "$local_ref" || -z "$local_sha" || -z "$remote_ref" || -z "$remote_sha" ]]; then
      continue
    fi
    if [[ ! "$local_sha" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$remote_sha" =~ ^[0-9a-f]{40}$ ]]; then
      return 1
    fi
    records+=("${local_sha}|${remote_sha}|${local_ref}|${remote_ref}")
    accepted=1
  done <<<"$raw"
  if [[ "$accepted" -ne 1 ]]; then
    return 1
  fi
  local r
  for r in "${records[@]}"; do
    printf '%s\n' "$r"
  done
}

# Argv fallback: parse `git push [remote] [refspec...]` from the command string
# when stdin has no pre-push lines. Emits newline-separated records as
# "local_sha|remote_sha|local_ref|remote_ref" where `local_sha` is HEAD of the
# named source ref (or HEAD itself for bare refspecs) and `remote_sha` is zero
# so the merge-base logic falls back to merging against the configured default.
# Exits the script with code 2 on operator-error conditions (HEAD target,
# unresolvable source ref) — same fail-closed contract as before.
resolve_argv_refspecs() {
  local cmd="$1"
  local segment
  segment=$(printf '%s' "$cmd" | awk '
    {
      idx = match($0, /git[[:space:]]+push([[:space:]]|$)/)
      if (!idx) exit
      tail = substr($0, idx)
      n = match(tail, /[;&|]|&&|\|\|/)
      if (n > 0) tail = substr(tail, 1, n - 1)
      print tail
    }
  ')

  local -a specs
  specs=()
  local seen_push=0 remote_seen=0 tok
  # shellcheck disable=SC2086
  set -- $segment
  for tok in "$@"; do
    case "$tok" in
      git|push) seen_push=1; continue ;;
      -*) continue ;;
    esac
    [[ "$seen_push" -eq 0 ]] && continue
    if [[ "$remote_seen" -eq 0 ]]; then
      remote_seen=1
      continue
    fi
    specs+=("$tok")
  done

  if [[ "${#specs[@]}" -eq 0 ]]; then
    local upstream dst_ref head_sha
    upstream=$(cd "$REA_ROOT" && git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo "")
    dst_ref="refs/heads/main"
    if [[ -n "$upstream" && "$upstream" == */* ]]; then
      dst_ref="refs/heads/${upstream#*/}"
    fi
    head_sha=$(cd "$REA_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")
    [[ -z "$head_sha" ]] && return 1
    printf '%s|%s|HEAD|%s\n' "$head_sha" "$ZERO_SHA" "$dst_ref"
    return 0
  fi

  local spec src dst src_sha
  for spec in "${specs[@]}"; do
    spec="${spec#+}"
    if [[ "$spec" == *:* ]]; then
      src="${spec%%:*}"
      dst="${spec##*:}"
    else
      src="$spec"
      dst="$spec"
    fi
    if [[ -z "$dst" ]]; then
      dst="${spec##*:}"
      src=""
    fi
    dst="${dst#refs/heads/}"
    dst="${dst#refs/for/}"
    if [[ "$dst" == "HEAD" || -z "$dst" ]]; then
      {
        printf 'PUSH BLOCKED: refspec resolves to HEAD (from %q)\n' "$spec"
        printf '\n'
        # shellcheck disable=SC2016
        printf '  `git push <remote> HEAD:<branch>` or similar is almost always\n'
        printf '  operator error in this context. Name the destination branch\n'
        printf '  explicitly so the review gate can diff against it.\n'
        printf '\n'
      } >&2
      exit 2
    fi
    if [[ -z "$src" ]]; then
      # Deletion via argv; record as all-zeros local_sha.
      printf '%s|%s|(delete)|refs/heads/%s\n' "$ZERO_SHA" "$ZERO_SHA" "$dst"
      continue
    fi
    src_sha=$(cd "$REA_ROOT" && git rev-parse --verify "${src}^{commit}" 2>/dev/null || echo "")
    if [[ -z "$src_sha" ]]; then
      {
        printf 'PUSH BLOCKED: could not resolve source ref %q to a commit.\n' "$src"
      } >&2
      exit 2
    fi
    printf '%s|%s|refs/heads/%s|refs/heads/%s\n' "$src_sha" "$ZERO_SHA" "$src" "$dst"
  done
}

# Collect refspec records. Stdin takes priority; fall back to argv parsing.
# parse_prepush_stdin exits non-zero when stdin is not a pre-push contract
# (most common case: Claude Code PreToolUse wrapper delivering JSON on stdin).
REFSPEC_RECORDS=()
if RECORDS_OUT=$(parse_prepush_stdin "$INPUT") && [[ -n "$RECORDS_OUT" ]]; then
  :
else
  RECORDS_OUT=$(resolve_argv_refspecs "$CMD")
fi
while IFS= read -r _rec; do
  [[ -z "$_rec" ]] && continue
  REFSPEC_RECORDS+=("$_rec")
done <<<"$RECORDS_OUT"

if [[ "${#REFSPEC_RECORDS[@]}" -eq 0 ]]; then
  {
    printf 'PUSH BLOCKED: no push refspecs could be resolved.\n'
    printf '  Refusing to pass without a source commit to review.\n'
  } >&2
  exit 2
fi

# ── 7. Pick the source commit and merge-base to review ───────────────────────
# Across all refspecs, we pick the one whose source commit is furthest from
# its merge-base (i.e. the largest diff). That way a mixed push like
# `foo:main bar:dev` is gated on whichever refspec actually contributes new
# commits. A deletion refspec (local_sha all zeros) is still concerning — we
# check the remote side for protected-path changes against the merge-base of
# the remote sha and the default branch, but the diff body comes from the
# non-delete refspec if present. If every refspec is a delete, we fail-closed
# and require an explicit review.
SOURCE_SHA=""
MERGE_BASE=""
TARGET_BRANCH=""
SOURCE_REF=""
HAS_DELETE=0
for rec in "${REFSPEC_RECORDS[@]}"; do
  IFS='|' read -r local_sha remote_sha local_ref remote_ref <<<"$rec"
  target="${remote_ref#refs/heads/}"
  target="${target#refs/for/}"
  [[ -z "$target" ]] && target="main"

  if [[ "$local_sha" == "$ZERO_SHA" ]]; then
    HAS_DELETE=1
    continue
  fi

  # Merge base: if the remote already has the ref, use remote_sha directly.
  # Otherwise (new branch, remote_sha is zeros), merge-base against the target.
  if [[ "$remote_sha" != "$ZERO_SHA" ]]; then
    mb=$(cd "$REA_ROOT" && git merge-base "$remote_sha" "$local_sha" 2>/dev/null || echo "$remote_sha")
  else
    mb=$(cd "$REA_ROOT" && git merge-base "$target" "$local_sha" 2>/dev/null || echo "")
    if [[ -z "$mb" ]]; then
      # New branch whose target has no merge-base locally. Try the default
      # branch if it exists, otherwise fail-closed.
      mb=$(cd "$REA_ROOT" && git merge-base main "$local_sha" 2>/dev/null || echo "")
    fi
  fi
  if [[ -z "$mb" ]]; then
    continue
  fi

  # Pick the refspec whose merge-base is the oldest ancestor of its local_sha
  # (i.e. the largest diff). Comparing via commit count keeps this simple.
  count=$(cd "$REA_ROOT" && git rev-list --count "${mb}..${local_sha}" 2>/dev/null || echo "0")
  if [[ -z "$SOURCE_SHA" ]] || [[ "$count" -gt "${BEST_COUNT:-0}" ]]; then
    SOURCE_SHA="$local_sha"
    MERGE_BASE="$mb"
    TARGET_BRANCH="$target"
    SOURCE_REF="$local_ref"
    BEST_COUNT="$count"
  fi
done

if [[ -z "$SOURCE_SHA" || -z "$MERGE_BASE" ]]; then
  if [[ "$HAS_DELETE" -eq 1 ]]; then
    {
      printf 'PUSH BLOCKED: refspec is a branch deletion.\n'
      printf '\n'
      printf '  Branch deletions are sensitive operations and require explicit\n'
      printf '  human action outside the agent. Perform the deletion manually.\n'
      printf '\n'
    } >&2
    exit 2
  fi
  {
    printf 'PUSH BLOCKED: could not resolve a merge-base for any push refspec.\n'
    printf '\n'
    printf '  Fetch the remote and retry, or name an explicit destination.\n'
    printf '\n'
  } >&2
  exit 2
fi

DIFF_FULL=$(cd "$REA_ROOT" && git diff "${MERGE_BASE}...${SOURCE_SHA}" 2>/dev/null || echo "")

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

PROTECTED_HITS=$(cd "$REA_ROOT" && git diff --name-status "${MERGE_BASE}...${SOURCE_SHA}" 2>/dev/null)
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
  # The audit entry must be keyed on the commit actually being pushed, not on
  # the working-tree HEAD — `git push origin hotfix:main` from a `foo` checkout
  # must match a Codex review of `hotfix`, not of `foo`.
  REVIEW_SHA="$SOURCE_SHA"

  AUDIT="${REA_ROOT}/.rea/audit.jsonl"
  CODEX_OK=0
  if [[ -f "$AUDIT" ]]; then
    # jq -e exits 0 iff at least one record matches every predicate. Any other
    # exit (including jq parse errors on a corrupt line) is treated as "no
    # proof of review" and we fail-closed.
    #
    # We require verdict to be an explicit allowlisted value. Missing, null,
    # or unknown verdicts fail the predicate — matching on `!=` alone admits
    # forged records with `metadata` lacking a `verdict` field at all.
    if jq -e --arg sha "$REVIEW_SHA" '
        select(
          .tool_name == "codex.review"
          and .metadata.head_sha == $sha
          and (.metadata.verdict == "pass" or .metadata.verdict == "concerns")
        )
      ' "$AUDIT" >/dev/null 2>&1; then
      CODEX_OK=1
    fi
  fi
  if [[ "$CODEX_OK" -eq 0 ]]; then
    {
      printf 'PUSH BLOCKED: protected paths changed — /codex-review required for %s\n' "$REVIEW_SHA"
      printf '\n'
      printf '  Source ref: %s\n' "${SOURCE_REF:-HEAD}"
      printf '  Diff touches one of:\n'
      printf '    - src/gateway/middleware/\n'
      printf '    - hooks/\n'
      printf '    - src/policy/\n'
      printf '    - .github/workflows/\n'
      printf '\n'
      printf '  Run /codex-review against %s, then retry the push.\n' "$REVIEW_SHA"
      printf '  The codex-adversarial agent emits the required audit entry.\n'
      # shellcheck disable=SC2016  # backticks are literal markdown in user-facing message
      printf '  Only `pass` or `concerns` verdicts satisfy this gate.\n'
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
  printf '  Source ref: %s (%s)\n' "${SOURCE_REF:-HEAD}" "${SOURCE_SHA:0:12}"
  printf '  Target: %s\n' "$TARGET_BRANCH"
  printf '  Scope: %s files changed, %s lines\n' "$FILE_COUNT" "$LINE_COUNT"
  printf '\n'
  printf '  Action required:\n'
  printf '  1. Spawn a code-reviewer agent to review: git diff %s...%s\n' "$MERGE_BASE" "$SOURCE_SHA"
  printf '  2. Spawn a security-engineer agent for security review\n'
  printf '  3. After both pass, cache the result:\n'
  printf '     rea cache set %s pass --branch %s --base %s\n' "$PUSH_SHA" "$CURRENT_BRANCH" "$TARGET_BRANCH"
  printf '\n'
} >&2
exit 2
