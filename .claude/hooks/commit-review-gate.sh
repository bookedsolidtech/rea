#!/bin/bash
# PreToolUse hook: commit-review-gate.sh
# Fires BEFORE every Bash tool call that matches "git commit".
# Implements a triage-based review gate:
#   - trivial (<20 changed lines, non-sensitive paths) → pass immediately
#   - standard (20-200 lines) → check review cache, pass if cached
#   - significant (>200 lines or sensitive paths) → block, request agent review
#
# Exit codes:
#   0 = allow (trivial change, or cached review found)
#   2 = block (needs review — returns additionalContext for agent)

set -uo pipefail

# ── 1. Read ALL stdin immediately ─────────────────────────────────────────────
INPUT=$(cat)

# ── 1a. Cross-repo guard (must come FIRST — before any rea-scoped check) ──────
# BUG-012 (0.6.2) — mirror of push-review-gate.sh §1a. Script-location
# anchor (not CLAUDE_PROJECT_DIR) owns the trust decision. See the
# push-gate comment and THREAT_MODEL.md § CLAUDE_PROJECT_DIR for the full
# rationale. In short: CLAUDE_PROJECT_DIR is caller-controlled, cannot be
# trusted for authorization, and the hook's own filesystem location is the
# only forge-resistant anchor available to a bash script.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd -P 2>/dev/null)"
# Walk up from SCRIPT_DIR looking for `.rea/policy.yaml`. Matches every
# reasonable install topology (see push-review-gate.sh §1a for the full
# rationale). A hard-coded `../..` breaks the source-path invocation
# (`bash hooks/commit-review-gate.sh`) and silently reads .rea state from
# the WRONG directory.
REA_ROOT=""
_anchor_candidate="$SCRIPT_DIR"
for _ in 1 2 3 4; do
  _anchor_candidate="$(cd -- "$_anchor_candidate/.." && pwd -P 2>/dev/null || true)"
  if [[ -n "$_anchor_candidate" && -f "$_anchor_candidate/.rea/policy.yaml" ]]; then
    REA_ROOT="$_anchor_candidate"
    break
  fi
done
if [[ -z "$REA_ROOT" ]]; then
  printf 'rea-hook: no .rea/policy.yaml found within 4 parents of %s\n' \
    "$SCRIPT_DIR" >&2
  printf 'rea-hook:   is this an installed rea hook, or is `.rea/policy.yaml`\n' >&2
  printf 'rea-hook:   nested more than 4 directories above the hook script?\n' >&2
  exit 2
fi
unset _anchor_candidate

if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
  CPD_REAL=$(cd -- "${CLAUDE_PROJECT_DIR}" 2>/dev/null && pwd -P 2>/dev/null || true)
  if [[ -n "$CPD_REAL" && "$CPD_REAL" != "$REA_ROOT" ]]; then
    printf 'rea-hook: ignoring CLAUDE_PROJECT_DIR=%s — anchoring to script location %s\n' \
      "$CLAUDE_PROJECT_DIR" "$REA_ROOT" >&2
  fi
fi

CWD_REAL=$(pwd -P 2>/dev/null || pwd)
CWD_COMMON=$(git -C "$CWD_REAL" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
REA_COMMON=$(git -C "$REA_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [[ -n "$CWD_COMMON" && -n "$REA_COMMON" ]]; then
  CWD_COMMON_REAL=$(cd "$CWD_COMMON" 2>/dev/null && pwd -P 2>/dev/null || echo "$CWD_COMMON")
  REA_COMMON_REAL=$(cd "$REA_COMMON" 2>/dev/null && pwd -P 2>/dev/null || echo "$REA_COMMON")
  if [[ "$CWD_COMMON_REAL" != "$REA_COMMON_REAL" ]]; then
    exit 0
  fi
elif [[ -z "$CWD_COMMON" && -z "$REA_COMMON" ]]; then
  case "$CWD_REAL/" in
    "$REA_ROOT"/*|"$REA_ROOT"/) : ;;  # inside rea — run the gate
    *) exit 0 ;;                       # outside rea — not our gate
  esac
fi
# Mixed state or probe error → fail CLOSED: run the gate.

# ── 2. Dependency check ──────────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  printf 'REA ERROR: jq is required but not installed.\n' >&2
  printf 'Install: brew install jq  OR  apt-get install -y jq\n' >&2
  exit 2
fi

# ── 3. HALT check ────────────────────────────────────────────────────────────
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

# Only trigger on git commit commands
if ! printf '%s' "$CMD" | grep -qiE 'git[[:space:]]+commit'; then
  exit 0
fi

# Skip --amend (reviewing amendments is a future feature)
if printf '%s' "$CMD" | grep -qiE 'git[[:space:]]+commit.*--amend'; then
  exit 0
fi

# ── 5. Compute diff stats ────────────────────────────────────────────────────
# Get staged diff (what would be committed)
DIFF_OUTPUT=$(cd "$REA_ROOT" && git diff --cached --stat 2>/dev/null || echo "")
DIFF_FULL=$(cd "$REA_ROOT" && git diff --cached 2>/dev/null || echo "")

if [[ -z "$DIFF_OUTPUT" ]]; then
  # No staged changes — let git commit handle the error
  exit 0
fi

# Count changed lines (additions + deletions)
# Defect K (rea#62) sibling: `|| echo "0"` captures "0\n0" into LINE_COUNT
# when grep exits non-zero on a no-match — grep still prints its own `0` and
# `echo "0"` appends another. At this site the concatenated `"0\n0"` is then
# evaluated as arithmetic (`-gt $SIGNIFICANT_THRESHOLD`, `-ge $TRIVIAL_THRESHOLD`
# below) and bash emits a "syntax error in expression" at runtime on any
# rename-only / mode-only / empty-file-add diff. `|| true` + bash-default
# expansion fixes both the banner cosmetic and the arithmetic-unsafe control
# flow in one shot.
LINE_COUNT=$(printf '%s' "$DIFF_FULL" | grep -cE '^\+[^+]|^-[^-]' 2>/dev/null || true)
LINE_COUNT="${LINE_COUNT:-0}"

# Check for sensitive paths
SENSITIVE=0
SENSITIVE_FILES=""
if printf '%s' "$DIFF_FULL" | grep -qE '^\+\+\+ .*(\.rea/|\.claude/|\.env|auth|security|\.github/workflows)'; then
  SENSITIVE=1
  SENSITIVE_FILES=$(printf '%s' "$DIFF_FULL" | grep -oE '^\+\+\+ .*(\.rea/|\.claude/|\.env|auth|security|\.github/workflows)[^ ]*' | sed 's/^\+\+\+ [ab]\//  /' | head -5)
fi

# ── 7. Triage scoring ────────────────────────────────────────────────────────
TRIVIAL_THRESHOLD=20
SIGNIFICANT_THRESHOLD=200

if [[ $SENSITIVE -eq 1 ]] || [[ $LINE_COUNT -gt $SIGNIFICANT_THRESHOLD ]]; then
  SCORE="significant"
elif [[ $LINE_COUNT -ge $TRIVIAL_THRESHOLD ]]; then
  SCORE="standard"
else
  SCORE="trivial"
fi

# ── 8. Trivial → pass immediately ─────────────────────────────────────────────
if [[ "$SCORE" == "trivial" ]]; then
  exit 0
fi

# ── 9. Resolve rea CLI ────────────────────────────────────────────────────
# Try local installs first, then dist build, then global PATH install.
#
# node_modules/.bin/rea is a launcher (pnpm writes a POSIX shell shim, npm
# writes a symlink to dist/cli/index.js with its own `#!/usr/bin/env node`
# shebang). Either way it is NOT a plain JS file, so running `node` on it
# would parse shell syntax as JavaScript and SyntaxError. Execute the shim
# directly — it handles `exec node` itself — and only prepend `node` on the
# dist fallback, which is a real JS module. The `-x` guard picks up both
# pnpm shims (executable regular file) and npm symlinks (executable target).
REA_CLI_ARGS=()
if [[ -x "${REA_ROOT}/node_modules/.bin/rea" ]]; then
  REA_CLI_ARGS=("${REA_ROOT}/node_modules/.bin/rea")
elif [[ -f "${REA_ROOT}/dist/cli/index.js" ]]; then
  REA_CLI_ARGS=(node "${REA_ROOT}/dist/cli/index.js")
elif command -v rea >/dev/null 2>&1; then
  REA_CLI_ARGS=(rea)
fi

# ── 10. Check review cache for all non-trivial commits ────────────────────────
# Compute SHA and branch here so both standard and significant tiers share them.
#
# Defect L (rea#63) sibling: `shasum` is not installed on Alpine, distroless,
# or most minimal Linux CI images — only `sha256sum` is. The prior chain
# silently produced an empty STAGED_SHA, which the cache block then skipped
# AND the banner at §11 rendered as `rea cache set  pass` — a dead-end the
# agent cannot execute. Portable chain mirrors push-review-core.sh §8:
# sha256sum → shasum → openssl. The openssl branch uses `awk '{print $NF}'`
# WITHOUT `-r` to stay compatible with OpenSSL 1.1.x (Debian 11, Ubuntu
# 20.04, RHEL 8, Amazon Linux 2, Alpine 3.13–3.14).
STAGED_SHA=""
if command -v sha256sum >/dev/null 2>&1; then
  STAGED_SHA=$(printf '%s' "$DIFF_FULL" | sha256sum 2>/dev/null | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  STAGED_SHA=$(printf '%s' "$DIFF_FULL" | shasum -a 256 2>/dev/null | awk '{print $1}')
elif command -v openssl >/dev/null 2>&1; then
  STAGED_SHA=$(printf '%s' "$DIFF_FULL" | openssl dgst -sha256 2>/dev/null | awk '{print $NF}')
else
  printf 'rea commit-review: WARN no sha256 hasher found (sha256sum/shasum/openssl); cache disabled\n' >&2
fi
if [[ -n "$STAGED_SHA" && ! "$STAGED_SHA" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'rea commit-review: WARN hasher returned invalid output; cache disabled\n' >&2
  STAGED_SHA=""
fi
BRANCH=$(cd "$REA_ROOT" && git branch --show-current 2>/dev/null || echo "")
CACHE_FILE="${REA_ROOT}/.rea/review-cache.json"

# Codex pass-3 finding #1: `rea cache check` and `rea cache set` both declare
# `--base` as a `requiredOption` in src/cli/index.ts. Prior versions of this
# gate omitted `--base`, so (a) the CLI path exited non-zero and the
# `|| echo '{"hit":false}'` fallback quietly masked the contract error, and
# (b) the section-11 banner instructed the agent to run `rea cache set <sha>
# pass` — also missing `--base`, rejected by the CLI on every retry. A
# successful cache flow was unreachable.
#
# Resolve BASE_BRANCH by the same preference order the push-gate uses in
# push-review-core.sh §7 (lines 778-794): origin/HEAD → origin/main →
# origin/master → empty. If nothing resolves, disable the cache (the
# alternative is emitting a cache command the CLI rejects on every call).
BASE_BRANCH=""
_origin_head=$(cd "$REA_ROOT" && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true)
if [[ -n "$_origin_head" ]]; then
  BASE_BRANCH="${_origin_head#refs/remotes/origin/}"
fi
if [[ -z "$BASE_BRANCH" ]]; then
  # Use `git -C` so the current-shell cwd is never mutated — matches the
  # cross-repo guard at §1a and keeps the file's dominant idiom. Raw
  # `cd "$REA_ROOT" && git …` would leave the hook process sitting in
  # $REA_ROOT, which is safe today but breaks silently if a future edit
  # adds a relative-path command downstream.
  if git -C "$REA_ROOT" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null 2>&1; then
    BASE_BRANCH="main"
  elif git -C "$REA_ROOT" rev-parse --verify --quiet refs/remotes/origin/master >/dev/null 2>&1; then
    BASE_BRANCH="master"
  fi
fi
if [[ -z "$BASE_BRANCH" && -n "$STAGED_SHA" ]]; then
  printf 'rea commit-review: WARN could not resolve base branch (no origin/HEAD, no origin/main, no origin/master); cache disabled\n' >&2
  STAGED_SHA=""
fi
unset _origin_head

if [[ -n "$STAGED_SHA" ]]; then
  CACHE_HIT=false

  # Primary: use CLI when available — handles TTL, expiry, and branch-scoped keys.
  # Cache predicate must require BOTH `.hit == true` AND `.result == "pass"` —
  # a cached `fail` verdict would otherwise satisfy `.hit == true` and let the
  # commit proceed despite a recorded negative review. Mirrors the push-gate
  # predicate at push-review-core.sh §8; the §218-226 direct-cache fallback
  # already enforces `result == "pass"`, so the two paths must agree.
  if [[ ${#REA_CLI_ARGS[@]} -gt 0 ]]; then
    # Defect F (rea#75): surface cache-query errors instead of treating them as
    # legitimate misses. See hooks/_lib/push-review-core.sh for the rationale.
    # SECURITY (Codex LOW 4): require mktemp. Predictable /tmp paths are a
    # TOCTOU surface on shared hosts; fall-loud instead of fall-back.
    if ! CACHE_STDERR_FILE=$(mktemp -t rea-commit-cache-err.XXXXXX 2>/dev/null); then
      printf 'rea commit-review: mktemp unavailable; cannot capture cache-check stderr. Aborting.\n' >&2
      exit 2
    fi
    CACHE_EXIT=0
    CACHE_STDOUT=$("${REA_CLI_ARGS[@]}" cache check "$STAGED_SHA" --branch "$BRANCH" --base "$BASE_BRANCH" 2>"$CACHE_STDERR_FILE") || CACHE_EXIT=$?
    CACHE_STDERR=$(cat "$CACHE_STDERR_FILE" 2>/dev/null || true)
    rm -f "$CACHE_STDERR_FILE"
    if [[ "$CACHE_EXIT" -ne 0 ]]; then
      # SECURITY (Codex LOW 5): strip control chars before echoing CLI stderr.
      CACHE_STDERR_SAFE=$(printf '%s' "$CACHE_STDERR" | LC_ALL=C tr -d '\000-\037\177')
      printf 'rea commit-review: CACHE CHECK FAILED (exit=%d): %s\n' "$CACHE_EXIT" "$CACHE_STDERR_SAFE" >&2
      printf 'rea commit-review: treating as miss; file bookedsolidtech/rea issue if unexpected.\n' >&2
      CACHE_RESULT='{"hit":false,"reason":"query_error"}'
    elif [[ -z "$CACHE_STDOUT" ]]; then
      CACHE_RESULT='{"hit":false,"reason":"cold"}'
    else
      CACHE_RESULT="$CACHE_STDOUT"
    fi
    if printf '%s' "$CACHE_RESULT" | jq -e '.hit == true and .result == "pass"' >/dev/null 2>&1; then
      CACHE_HIT=true
    fi
  fi

  # Fallback: read cache JSON directly — works when rea is not on PATH.
  # Checks branch-scoped key ("branch:sha") first, then bare SHA (empty-branch case).
  if [[ "$CACHE_HIT" == "false" ]] && [[ -f "$CACHE_FILE" ]]; then
    CACHE_KEY="${BRANCH}:${STAGED_SHA}"
    DIRECT_HIT=$(jq -r --arg k1 "$CACHE_KEY" --arg k2 "$STAGED_SHA" \
      '(.entries[$k1] // .entries[$k2]) | if . == null then "miss" elif .result == "pass" then "hit" else "miss" end' \
      "$CACHE_FILE" 2>/dev/null || echo "miss")
    if [[ "$DIRECT_HIT" == "hit" ]]; then
      CACHE_HIT=true
    fi
  fi

  if [[ "$CACHE_HIT" == "true" ]]; then
    exit 0
  fi
fi

# ── 11. Block and request review ──────────────────────────────────────────────
{
  printf 'COMMIT REVIEW GATE: Review required before committing\n'
  printf '\n'
  printf '  Score: %s (%s changed lines)\n' "$SCORE" "$LINE_COUNT"
  if [[ $SENSITIVE -eq 1 ]]; then
    printf '  Sensitive paths detected:\n'
    printf '%s\n' "$SENSITIVE_FILES"
  fi
  printf '\n'
  printf '  YOU (the agent) are the reviewer. Do not ask the user to commit manually.\n'
  printf '  Review the staged diff, make a pass/fail decision, then proceed:\n'
  printf '\n'
  printf '  1. Inspect:  git diff --cached\n'
  printf '  2. Decide:   Is this safe to commit? (initial commits, refactors, and\n'
  printf '               feature work are normal — use judgement, not ceremony)\n'
  # Defect L follow-up: when no sha256 hasher is available STAGED_SHA is empty
  # and `rea cache set  pass` is a dead-end the CLI rejects. Branch the banner
  # to surface an actionable path instead. Unlike push-review-core.sh there is
  # no `REA_SKIP_COMMIT_REVIEW` env escape hatch (the commit gate only fires
  # under Claude Code's Bash `PreToolUse` matcher, so a human direct-shell
  # commit bypasses it entirely). The only remediation is to install a sha256
  # hasher or ask the user to commit directly.
  if [[ -n "$STAGED_SHA" ]]; then
    printf '  3. Approve:  rea cache set %s pass --branch %s --base %s\n' \
      "$STAGED_SHA" "$BRANCH" "$BASE_BRANCH"
    printf '  4. Retry the git commit command\n'
  else
    printf '  3. Cache is DISABLED on this host (no sha256 hasher or no base\n'
    printf '     branch resolvable). Install one of: sha256sum (Linux coreutils),\n'
    printf '     shasum (perl-core), or openssl; or ensure origin/HEAD is set so\n'
    printf '     the gate can identify the merge target. Without these the cache\n'
    printf '     path cannot complete — escalate to the user if neither can be\n'
    printf '     provided.\n'
  fi
  printf '\n'
  printf '  Only escalate to the user if you find a genuine problem in the diff.\n'
} >&2
exit 2
