#!/bin/bash
# PreToolUse hook: push-review-gate.sh
# Fires BEFORE every Bash tool call that matches "git push".
# Runs a full diff analysis against the target branch and requests
# security + code review before allowing the push.
#
# Exit codes:
#   0 = allow (no meaningful diff, or review cached, or escape hatch invoked)
#   2 = block (needs review, or escape hatch invoked but audit-append failed)
#
# ── Escape hatch: REA_SKIP_CODEX_REVIEW ──────────────────────────────────────
# Env var `REA_SKIP_CODEX_REVIEW=<reason>` bypasses the protected-path Codex
# adversarial-review requirement. Set to any non-empty value; the value IS
# the reason recorded in the audit record (no default reason is supplied —
# if the operator sets `REA_SKIP_CODEX_REVIEW=1` the reason is literally "1").
#
# The hatch ONLY applies when the diff would otherwise require Codex review
# (i.e. touches a protected path). Unprotected pushes are not affected.
#
# Every invocation appends a `tool_name: "codex.review.skipped"` record to
# `.rea/audit.jsonl` via the public audit helper. This record is intentionally
# NOT named `codex.review` so the existing jq predicate on `.tool_name ==
# "codex.review" and .metadata.verdict in {pass, concerns}` will never match
# a skip — a skipped review is not a review.
#
# Fail-closed contract:
#   - `dist/audit/append.js` missing → exit 2 (build rea first)
#   - Node invocation failure → exit 2
#   - Unable to resolve actor from git config → exit 2
#
# Tracked under G11.1 on the 0.3.0 plan (solidifying features). G11.2–G11.5
# (pluggable reviewer, availability probe, no-Codex first-class config,
# rate-limit telemetry) are future work and are NOT implemented here.

set -uo pipefail

# ── 1. Read ALL stdin immediately ─────────────────────────────────────────────
INPUT=$(cat)

# ── 1a. Cross-repo guard (must come FIRST — before any rea-scoped check) ──────
# BUG-012 (0.6.2) — anchor the install to the SCRIPT'S OWN LOCATION on disk.
# The hook knows where it lives: installed at `<root>/.claude/hooks/<name>.sh`,
# so `<root>` is two levels up from `BASH_SOURCE[0]`. No caller-controlled
# env var participates in the trust decision.
#
# WHY THIS CHANGED in 0.6.2
# The 0.6.1 guard read `REA_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"` before the
# jq/HALT checks. That made `CLAUDE_PROJECT_DIR` a trust boundary: any process
# that could set it to a foreign path bypassed HALT and every other rea
# gate. CLAUDE_PROJECT_DIR is documentation/UX — it tells the wrapper which
# project directory the user opened. It is NOT authentication. Authorization
# must come from something the caller cannot forge, hence the script-path
# anchor. See THREAT_MODEL.md § CLAUDE_PROJECT_DIR.
#
# BEHAVIOR UNDER EACH INSTALL TOPOLOGY
#   Consumer install:  <consumer>/.claude/hooks/push-review-gate.sh
#                      → REA_ROOT = <consumer>
#                      → Guard runs against <consumer>/.rea/policy.yaml.
#   rea dogfood:       /…/rea/.claude/hooks/push-review-gate.sh
#                      → REA_ROOT = /…/rea (this repo itself)
#                      → Guard runs against rea's own policy.yaml.
#
# CLAUDE_PROJECT_DIR, if set, is still TREATED AS ADVISORY: if it names a
# different path, we emit a one-line stderr note and continue with the
# script-derived REA_ROOT. We never short-circuit based on comparing the
# env var against the script location — that would re-open the bypass.
#
# Repo-identity comparison via shared `--git-common-dir`, NOT path-prefix or
# `--show-toplevel`. A linked worktree created by `git worktree add` has a
# different toplevel but the SAME repository (shared object DB / refs /
# history). Any worktree of rea IS rea and must run the gate.
# `--path-format=absolute` (Git ≥ 2.31, March 2021) normalizes the common
# dir so the same repo's common-dir is equal regardless of which worktree
# asked. Engines pin Node ≥20 which ships with a recent-enough Git for dev.
#
# BUG-012 fail-closed: when ONE side is a git checkout and the other is not
# (or the `--git-common-dir` probe errored), we run the gate (treat as
# same-repo). Fail open on probe failure is what 0.6.1 did and it meant a
# transient git quirk inside a legitimate rea worktree could bypass HALT.
# The path-prefix fallback is ONLY used when BOTH sides are non-git — the
# documented 0.5.1 non-git escape-hatch scenario (`data/`, `figgy`).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd -P 2>/dev/null)"
# Walk up from SCRIPT_DIR looking for `.rea/policy.yaml`. This resolves
# correctly for every reasonable topology — installed copy at
# `<root>/.claude/hooks/<name>.sh` (2 up), source-of-truth copy at
# `<root>/hooks/<name>.sh` (1 up, used when rea dogfoods itself or a
# developer runs `bash hooks/push-review-gate.sh` to smoke-test), and any
# future `hooks/_lib/` nesting. A hard-coded `../..` breaks the source-path
# invocation and silently reads .rea state from the WRONG directory.
# Cap at 4 levels so a stray hook dropped in the wrong spot fails fast
# instead of walking to the filesystem root.
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

# Advisory-only: warn if the caller set CLAUDE_PROJECT_DIR to a path that
# does not match the script anchor. Never let the env var override the
# decision.
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
  # Both sides are git checkouts. Realpath'd common-dirs match IFF they
  # point at the same underlying repository (main or linked worktree).
  CWD_COMMON_REAL=$(cd "$CWD_COMMON" 2>/dev/null && pwd -P 2>/dev/null || echo "$CWD_COMMON")
  REA_COMMON_REAL=$(cd "$REA_COMMON" 2>/dev/null && pwd -P 2>/dev/null || echo "$REA_COMMON")
  if [[ "$CWD_COMMON_REAL" != "$REA_COMMON_REAL" ]]; then
    exit 0
  fi
elif [[ -z "$CWD_COMMON" && -z "$REA_COMMON" ]]; then
  # Both sides non-git: legitimate 0.5.1 non-git escape-hatch. Fall back to
  # a literal path-prefix match. Quoted expansions prevent glob expansion.
  case "$CWD_REAL/" in
    "$REA_ROOT"/*|"$REA_ROOT"/) : ;;  # inside rea — run the gate
    *) exit 0 ;;                       # outside rea — not our gate
  esac
fi
# Mixed state (one side git, other not) or either probe failed → fail
# CLOSED: run the gate. A transient `--git-common-dir` probe failure in a
# legitimate rea worktree must not silently bypass HALT.

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

# ── 4a. BUG-008: self-detect git's native pre-push contract ───────────────────
# When the hook is wired into `.husky/pre-push`, git invokes it with
#   `$1 = remote name`, `$2 = remote url`
# and delivers one line per refspec on stdin:
#   `<local_ref> <local_sha> <remote_ref> <remote_sha>`
# The Claude Code PreToolUse wrapper instead delivers JSON on stdin, which is
# what the jq parse above targets. When jq returns empty, the stdin may in
# fact be git's pre-push ref-list — sniff the first non-blank line, and if it
# matches the `<ref> <40-hex> <ref> <40-hex>` shape, synthesize CMD as
# `git push <remote>` (from argv $1) so the remainder of the gate runs
# through the pre-push parser in step 6 rather than the argv fallback.
#
# Any other stdin shape (empty, random JSON, a non-push tool call) still
# exits 0 here — the gate is a no-op for non-push Bash calls by design.
FIRST_STDIN_LINE=$(printf '%s' "$INPUT" | awk 'NF { print; exit }')
if [[ -z "$CMD" ]]; then
  if [[ -n "$FIRST_STDIN_LINE" ]] \
     && printf '%s' "$FIRST_STDIN_LINE" \
        | grep -qE '^[^[:space:]]+[[:space:]]+[0-9a-f]{40}[[:space:]]+[^[:space:]]+[[:space:]]+[0-9a-f]{40}[[:space:]]*$'; then
    # Git native pre-push path. Remote comes from argv $1 — falls back to
    # `origin` for safety if the hook was invoked without arguments.
    CMD="git push ${1:-origin}"
  else
    exit 0
  fi
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

# ── 5a. REA_SKIP_PUSH_REVIEW — whole-gate escape hatch ───────────────────────
# An opt-in bypass for the ENTIRE push-review gate (not just the Codex branch).
# Exists to unblock consumers when rea itself is broken (as in BUG-009 pre-0.5.0)
# or a corrupt policy/audit file would otherwise deadlock a push. Requires an
# explicit non-empty reason; the value of REA_SKIP_PUSH_REVIEW is recorded
# verbatim in the audit record as the reason.
#
# Fail-closed contract matches REA_SKIP_CODEX_REVIEW:
#   - missing dist/audit/append.js → exit 2
#   - missing git identity         → exit 2
#   - Node failure                 → exit 2
#
# Audit tool_name is `push.review.skipped`. This is intentionally NOT
# `codex.review` or `codex.review.skipped` — a skip of the whole gate is a
# separately-audited event and does not satisfy the Codex-review jq predicate.
if [[ -n "${REA_SKIP_PUSH_REVIEW:-}" ]]; then
  SKIP_REASON="$REA_SKIP_PUSH_REVIEW"
  AUDIT_APPEND_JS="${REA_ROOT}/dist/audit/append.js"

  if [[ ! -f "$AUDIT_APPEND_JS" ]]; then
    {
      printf 'PUSH BLOCKED: REA_SKIP_PUSH_REVIEW requires rea to be built.\n'
      printf '\n'
      printf '  REA_SKIP_PUSH_REVIEW is set but %s is missing.\n' "$AUDIT_APPEND_JS"
      printf '  Run: pnpm build\n'
      printf '\n'
    } >&2
    exit 2
  fi

  # Codex F2: CI-aware refusal. The skip hatch is ambient — any process that
  # can set env vars can flip the gate off with a forged git identity (git
  # config is mutable repo config). In a CI context, refuse by default; only
  # allow if the policy explicitly opted in via review.allow_skip_in_ci=true.
  if [[ -n "${CI:-}" ]]; then
    ALLOW_CI_SKIP=""
    READ_FIELD_JS="${REA_ROOT}/dist/scripts/read-policy-field.js"
    if [[ -f "$READ_FIELD_JS" ]]; then
      ALLOW_CI_SKIP=$(REA_ROOT="$REA_ROOT" node "$READ_FIELD_JS" review.allow_skip_in_ci 2>/dev/null || echo "")
    fi
    if [[ "$ALLOW_CI_SKIP" != "true" ]]; then
      {
        printf 'PUSH BLOCKED: REA_SKIP_PUSH_REVIEW refused in CI context.\n'
        printf '\n'
        printf '  CI env var is set. An unauthenticated env-var bypass in a shared\n'
        printf '  build agent is not trusted. To enable, set\n'
        printf '    review:\n'
        printf '      allow_skip_in_ci: true\n'
        printf '  in .rea/policy.yaml — explicitly authorizing env-var skips in CI.\n'
        printf '\n'
      } >&2
      exit 2
    fi
  fi

  SKIP_ACTOR=$(cd "$REA_ROOT" && git config user.email 2>/dev/null || echo "")
  if [[ -z "$SKIP_ACTOR" ]]; then
    SKIP_ACTOR=$(cd "$REA_ROOT" && git config user.name 2>/dev/null || echo "")
  fi
  if [[ -z "$SKIP_ACTOR" ]]; then
    {
      printf 'PUSH BLOCKED: REA_SKIP_PUSH_REVIEW requires a git identity.\n'
      printf '\n'
      # shellcheck disable=SC2016  # backticks are literal markdown in user-facing message
      printf '  Neither `git config user.email` nor `git config user.name`\n'
      printf '  is set. The skip audit record would have no actor; refusing\n'
      printf '  to bypass without one.\n'
      printf '\n'
    } >&2
    exit 2
  fi

  SKIP_BRANCH=$(cd "$REA_ROOT" && git branch --show-current 2>/dev/null || echo "")
  SKIP_HEAD=$(cd "$REA_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")

  # Codex F2: record OS identity alongside the (mutable, git-sourced) actor so
  # downstream auditors can reconstruct who REALLY invoked the bypass on a
  # shared host. None of these are forgeable from inside the push process alone.
  SKIP_OS_UID=$(id -u 2>/dev/null || echo "")
  SKIP_OS_WHOAMI=$(whoami 2>/dev/null || echo "")
  SKIP_OS_HOST=$(hostname 2>/dev/null || echo "")
  SKIP_OS_PID=$$
  SKIP_OS_PPID=$PPID
  SKIP_OS_PPID_CMD=$(ps -o command= -p "$PPID" 2>/dev/null | head -c 512 || echo "")
  SKIP_OS_TTY=$(tty 2>/dev/null || echo "not-a-tty")
  SKIP_OS_CI="${CI:-}"

  SKIP_METADATA=$(jq -n \
    --arg head_sha "$SKIP_HEAD" \
    --arg branch "$SKIP_BRANCH" \
    --arg reason "$SKIP_REASON" \
    --arg actor "$SKIP_ACTOR" \
    --arg os_uid "$SKIP_OS_UID" \
    --arg os_whoami "$SKIP_OS_WHOAMI" \
    --arg os_hostname "$SKIP_OS_HOST" \
    --arg os_pid "$SKIP_OS_PID" \
    --arg os_ppid "$SKIP_OS_PPID" \
    --arg os_ppid_cmd "$SKIP_OS_PPID_CMD" \
    --arg os_tty "$SKIP_OS_TTY" \
    --arg os_ci "$SKIP_OS_CI" \
    '{
      head_sha: $head_sha,
      branch: $branch,
      reason: $reason,
      actor: $actor,
      verdict: "skipped",
      os_identity: {
        uid: $os_uid,
        whoami: $os_whoami,
        hostname: $os_hostname,
        pid: $os_pid,
        ppid: $os_ppid,
        ppid_cmd: $os_ppid_cmd,
        tty: $os_tty,
        ci: $os_ci
      }
    }' 2>/dev/null)

  if [[ -z "$SKIP_METADATA" ]]; then
    {
      printf 'PUSH BLOCKED: REA_SKIP_PUSH_REVIEW could not serialize audit metadata.\n' >&2
    } >&2
    exit 2
  fi

  REA_ROOT="$REA_ROOT" REA_SKIP_METADATA="$SKIP_METADATA" \
    node --input-type=module -e "
      const mod = await import(process.env.REA_ROOT + '/dist/audit/append.js');
      const metadata = JSON.parse(process.env.REA_SKIP_METADATA);
      await mod.appendAuditRecord(process.env.REA_ROOT, {
        tool_name: 'push.review.skipped',
        server_name: 'rea.escape_hatch',
        status: mod.InvocationStatus.Allowed,
        tier: mod.Tier.Read,
        metadata,
      });
    " 2>/dev/null
  NODE_STATUS=$?
  if [[ "$NODE_STATUS" -ne 0 ]]; then
    {
      printf 'PUSH BLOCKED: REA_SKIP_PUSH_REVIEW audit-append failed (node exit %s).\n' "$NODE_STATUS"
      printf '  Refusing to bypass the push gate without a receipt.\n'
    } >&2
    exit 2
  fi

  {
    printf '\n'
    printf '==  PUSH REVIEW GATE SKIPPED via REA_SKIP_PUSH_REVIEW\n'
    printf '    Reason:  %s\n' "$SKIP_REASON"
    printf '    Actor:   %s\n' "$SKIP_ACTOR"
    printf '    Branch:  %s\n' "${SKIP_BRANCH:-<detached>}"
    printf '    Head:    %s\n' "${SKIP_HEAD:-<unknown>}"
    printf '    Audited: .rea/audit.jsonl (tool_name=push.review.skipped)\n'
    printf '\n'
    printf '    This is a gate weakening. Every invocation is permanently audited.\n'
    printf '\n'
  } >&2
  exit 0
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
  local seen_push=0 remote_seen=0 delete_mode=0 tok
  # shellcheck disable=SC2086
  set -- $segment
  for tok in "$@"; do
    case "$tok" in
      git|push) seen_push=1; continue ;;
      --delete|-d)
        # Branch deletion. Every subsequent bare refspec is a delete target on
        # the remote, not a source ref on the local side. We flip delete_mode
        # so the consumer loop below emits ZERO_SHA|ZERO_SHA records matching
        # the git pre-push stdin contract for deletions.
        delete_mode=1
        continue
        ;;
      --delete=*)
        # `git push --delete=value` is not actually supported by git, but guard
        # anyway: treat the value as a delete target.
        delete_mode=1
        specs+=("${tok#--delete=}")
        continue
        ;;
      -*) continue ;;
    esac
    [[ "$seen_push" -eq 0 ]] && continue
    if [[ "$remote_seen" -eq 0 ]]; then
      remote_seen=1
      continue
    fi
    if [[ "$delete_mode" -eq 1 ]]; then
      # Tag each delete-mode token with a sentinel prefix so the consumer loop
      # can distinguish it from a normal refspec without another bash array.
      specs+=("__REA_DELETE__${tok}")
    else
      specs+=("$tok")
    fi
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

  local spec src dst src_sha is_delete
  for spec in "${specs[@]}"; do
    is_delete=0
    if [[ "$spec" == __REA_DELETE__* ]]; then
      is_delete=1
      spec="${spec#__REA_DELETE__}"
    fi
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
    if [[ "$is_delete" -eq 1 ]]; then
      # `git push --delete origin doomed` — force the record to match the
      # pre-push stdin contract for deletions: both SHAs zero, local_ref is
      # the sentinel string "(delete)". The downstream HAS_DELETE branch
      # fail-closes out of the agent path.
      if [[ -z "$dst" || "$dst" == "HEAD" ]]; then
        {
          printf 'PUSH BLOCKED: --delete refspec resolves to HEAD or empty (from %q)\n' "$spec"
        } >&2
        exit 2
      fi
      printf '%s|%s|(delete)|refs/heads/%s\n' "$ZERO_SHA" "$ZERO_SHA" "$dst"
      continue
    fi
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
  #
  # Critical: when remote_sha is non-zero but NOT in the local object DB
  # (stale checkout, no recent fetch), older code swallowed `merge-base`
  # failure with `|| echo "$remote_sha"`, assigning a SHA that would make
  # every downstream `rev-list`/`diff` fail. Those failures were then
  # swallowed too, collapsing to an empty DIFF_FULL and fail-open exit 0.
  #
  # Probe object presence up front. Missing object → fail closed with a clear
  # remediation message. No silent fallback.
  if [[ "$remote_sha" != "$ZERO_SHA" ]]; then
    if ! (cd "$REA_ROOT" && git cat-file -e "${remote_sha}^{commit}" 2>/dev/null); then
      {
        printf 'PUSH BLOCKED: remote object %s is not in the local object DB.\n' "$remote_sha"
        printf '\n'
        printf '  The gate cannot compute a review diff without it. Fetch the\n'
        printf '  remote and retry:\n'
        printf '\n'
        printf '    git fetch origin\n'
        printf '    # then retry the push\n'
        printf '\n'
      } >&2
      exit 2
    fi
    mb=$(cd "$REA_ROOT" && git merge-base "$remote_sha" "$local_sha" 2>/dev/null)
    mb_status=$?
    if [[ "$mb_status" -ne 0 || -z "$mb" ]]; then
      {
        printf 'PUSH BLOCKED: no merge-base between remote %s and local %s\n' \
          "${remote_sha:0:12}" "${local_sha:0:12}"
        printf '  The two histories are unrelated; refusing to pass without a\n'
        printf '  reviewable diff.\n'
      } >&2
      exit 2
    fi
  else
    mb=$(cd "$REA_ROOT" && git merge-base "$target" "$local_sha" 2>/dev/null || echo "")
    if [[ -z "$mb" ]]; then
      # New branch whose target has no merge-base locally. Try the default
      # branch if it exists, otherwise fail-closed (handled below).
      mb=$(cd "$REA_ROOT" && git merge-base main "$local_sha" 2>/dev/null || echo "")
    fi
  fi
  if [[ -z "$mb" ]]; then
    continue
  fi

  # Pick the refspec whose merge-base is the oldest ancestor of its local_sha
  # (i.e. the largest diff). Fail closed on rev-list errors rather than
  # substituting 0 — a failed rev-list means we can't trust the comparison.
  count=$(cd "$REA_ROOT" && git rev-list --count "${mb}..${local_sha}" 2>/dev/null)
  count_status=$?
  if [[ "$count_status" -ne 0 ]]; then
    {
      printf 'PUSH BLOCKED: git rev-list --count %s..%s failed (exit %s)\n' \
        "${mb:0:12}" "${local_sha:0:12}" "$count_status"
      printf '  Cannot size the diff; refusing to pass.\n'
    } >&2
    exit 2
  fi
  if [[ -z "$count" ]]; then
    count=0
  fi
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

# Capture git diff exit status explicitly. The previous `|| echo ""` swallowed
# real errors (missing objects, invalid refs) and fell through to the empty-diff
# fail-open below. We now distinguish:
#   exit 0 + empty output  → legitimate no-op push, allow
#   exit 0 + non-empty     → proceed to review
#   exit non-zero          → fail closed, never allow
DIFF_FULL=$(cd "$REA_ROOT" && git diff "${MERGE_BASE}...${SOURCE_SHA}" 2>/dev/null)
DIFF_STATUS=$?
if [[ "$DIFF_STATUS" -ne 0 ]]; then
  {
    printf 'PUSH BLOCKED: git diff %s...%s failed (exit %s)\n' \
      "${MERGE_BASE:0:12}" "${SOURCE_SHA:0:12}" "$DIFF_STATUS"
    printf '  Cannot compute reviewable diff; refusing to pass.\n'
  } >&2
  exit 2
fi

if [[ -z "$DIFF_FULL" ]]; then
  # git exited 0 with no output — legitimate no-op push (e.g. re-push of an
  # already-remote commit). Allow.
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
#
# ── G11.4: honor review.codex_required ───────────────────────────────────────
# When policy.review.codex_required is explicitly false, the operator has
# opted into first-class no-Codex mode. Skip this whole branch — no audit
# entry is required, the escape-hatch is not relevant, and we fall through
# to the normal (non-Codex) push validation. The selector in
# src/gateway/reviewers/select.ts makes the same call for the reviewer pick.
#
# Fail-closed: if the helper fails to parse the policy, treat the field as
# true (safer default) and log a warning. A malformed policy file is an
# operator problem, not a reason to silently weaken the Codex gate.
READ_FIELD_JS="${REA_ROOT}/dist/scripts/read-policy-field.js"
CODEX_REQUIRED="true"
if [[ -f "$READ_FIELD_JS" ]]; then
  FIELD_VALUE=$(REA_ROOT="$REA_ROOT" node "$READ_FIELD_JS" review.codex_required 2>/dev/null)
  FIELD_STATUS=$?
  case "$FIELD_STATUS" in
    0)
      # Field is present and a scalar. Accept only literal `true` / `false`.
      # Anything else is a malformed scalar; fail closed.
      if [[ "$FIELD_VALUE" == "false" ]]; then
        CODEX_REQUIRED="false"
      elif [[ "$FIELD_VALUE" == "true" ]]; then
        CODEX_REQUIRED="true"
      else
        printf 'REA WARN: review.codex_required resolved to non-boolean %q — treating as true\n' "$FIELD_VALUE" >&2
        CODEX_REQUIRED="true"
      fi
      ;;
    1)
      # Field absent (or policy file missing). Documented default is true.
      CODEX_REQUIRED="true"
      ;;
    *)
      # Malformed policy, unexpected helper exit. Fail closed.
      printf 'REA WARN: read-policy-field exited %s — treating review.codex_required as true (fail-closed)\n' "$FIELD_STATUS" >&2
      CODEX_REQUIRED="true"
      ;;
  esac
fi

# [.]github instead of \.github: GNU awk warns on `\.` inside an ERE (it
# treats the escape as plain `.`), which dirties stderr and makes tests that
# assert on gate output brittle. `[.]` is the unambiguous ERE form and is
# silent on every awk we target.
PROTECTED_RE='(src/gateway/middleware/|hooks/|src/policy/|[.]github/workflows/)'

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

if [[ "$CODEX_REQUIRED" == "true" ]] && printf '%s\n' "$PROTECTED_HITS" | awk -v re="$PROTECTED_RE" '
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

  # ── 7a.1 Escape hatch: REA_SKIP_CODEX_REVIEW ──────────────────────────────
  # Consume the hatch ONLY when we would otherwise require Codex review (i.e.
  # we are inside the protected-path branch). This preserves the gate for
  # every non-protected push.
  #
  # Audit record is written BEFORE the stderr banner and BEFORE exit 0. If
  # the audit write fails (missing dist/ build, missing git identity, Node
  # failure), we fail closed — exit 2 — so an operator cannot silently slip
  # a protected-path push with no receipt.
  if [[ -n "${REA_SKIP_CODEX_REVIEW:-}" ]]; then
    SKIP_REASON="$REA_SKIP_CODEX_REVIEW"
    AUDIT_APPEND_JS="${REA_ROOT}/dist/audit/append.js"

    if [[ ! -f "$AUDIT_APPEND_JS" ]]; then
      {
        printf 'PUSH BLOCKED: escape hatch requires rea to be built.\n'
        printf '\n'
        printf '  REA_SKIP_CODEX_REVIEW is set but %s is missing.\n' "$AUDIT_APPEND_JS"
        printf '  Run: pnpm build\n'
        printf '\n'
      } >&2
      exit 2
    fi

    # Actor: prefer git user.email, fall back to user.name. Empty → fail closed.
    SKIP_ACTOR=$(cd "$REA_ROOT" && git config user.email 2>/dev/null || echo "")
    if [[ -z "$SKIP_ACTOR" ]]; then
      SKIP_ACTOR=$(cd "$REA_ROOT" && git config user.name 2>/dev/null || echo "")
    fi
    if [[ -z "$SKIP_ACTOR" ]]; then
      {
        printf 'PUSH BLOCKED: escape hatch requires a git identity.\n'
        printf '\n'
        # shellcheck disable=SC2016  # backticks are literal markdown in user-facing message
        printf '  Neither `git config user.email` nor `git config user.name`\n'
        printf '  is set. The skip audit record would have no actor; refusing\n'
        printf '  to bypass without one.\n'
        printf '\n'
      } >&2
      exit 2
    fi

    # files_changed is a count only (not a list). The raw name-status stream
    # is already processed elsewhere in the hook; paths may be path-sensitive
    # or leak info we'd rather keep out of the audit line.
    SKIP_FILES_CHANGED=$(printf '%s\n' "$PROTECTED_HITS" | awk 'NF { n++ } END { print n+0 }')

    # Build the metadata JSON via jq so any weird characters in reason/actor
    # are properly escaped. All values are passed as --arg (strings) except
    # files_changed which is --argjson (number).
    SKIP_METADATA=$(jq -n \
      --arg head_sha "$SOURCE_SHA" \
      --arg target "$TARGET_BRANCH" \
      --arg reason "$SKIP_REASON" \
      --arg actor "$SKIP_ACTOR" \
      --argjson files_changed "$SKIP_FILES_CHANGED" \
      '{
        head_sha: $head_sha,
        target: $target,
        reason: $reason,
        actor: $actor,
        verdict: "skipped",
        files_changed: $files_changed
      }' 2>/dev/null)

    if [[ -z "$SKIP_METADATA" ]]; then
      {
        printf 'PUSH BLOCKED: escape hatch could not serialize audit metadata.\n' >&2
      } >&2
      exit 2
    fi

    # Write the audit record via the built helper. Pass REA_ROOT and the
    # metadata JSON through env vars (avoids quoting the values into the
    # one-liner; reason may contain literal double-quotes or backslashes).
    REA_ROOT="$REA_ROOT" REA_SKIP_METADATA="$SKIP_METADATA" \
      node --input-type=module -e "
        const mod = await import(process.env.REA_ROOT + '/dist/audit/append.js');
        const metadata = JSON.parse(process.env.REA_SKIP_METADATA);
        await mod.appendAuditRecord(process.env.REA_ROOT, {
          tool_name: 'codex.review.skipped',
          server_name: 'rea.escape_hatch',
          status: mod.InvocationStatus.Allowed,
          tier: mod.Tier.Read,
          metadata,
        });
      " 2>/dev/null
    NODE_STATUS=$?
    if [[ "$NODE_STATUS" -ne 0 ]]; then
      {
        printf 'PUSH BLOCKED: escape hatch audit-append failed (node exit %s).\n' "$NODE_STATUS"
        printf '  Refusing to bypass the Codex-review gate without a receipt.\n'
      } >&2
      exit 2
    fi

    # Audit record is durable on disk. Emit the loud stderr banner and allow
    # the push.
    {
      printf '\n'
      printf '==  CODEX REVIEW SKIPPED via REA_SKIP_CODEX_REVIEW\n'
      printf '    Reason:   %s\n' "$SKIP_REASON"
      printf '    Actor:    %s\n' "$SKIP_ACTOR"
      printf '    Head SHA: %s\n' "$SOURCE_SHA"
      printf '    Audited:  .rea/audit.jsonl (tool_name=codex.review.skipped)\n'
      printf '\n'
      printf '    This is a gate weakening. Every invocation is permanently audited.\n'
      printf '\n'
    } >&2
    exit 0
  fi

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
