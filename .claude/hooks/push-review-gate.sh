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
# ── Architecture (0.7.0 BUG-008 cleanup) ─────────────────────────────────────
# This file is now a thin ADAPTER. All logic lives in
# `hooks/_lib/push-review-core.sh` (see `pr_core_run`). The adapter's only
# job is to (a) capture stdin, and (b) hand its own script path + stdin +
# argv to the core so the cross-repo anchor walks up from the RIGHT script
# location.
#
# Two adapters share the core:
#   - push-review-gate.sh      ← this file, Claude Code PreToolUse stdin (JSON)
#   - push-review-gate-git.sh  ← native `.husky/pre-push` stdin (git refspec)
# The core's BUG-008 sniff makes either stdin shape work from either adapter,
# so in practice a consumer can wire THIS file into `.husky/pre-push` and it
# just works. The `-git` adapter exists for clarity of install intent.
#
# ── Escape hatch: REA_SKIP_CODEX_REVIEW ──────────────────────────────────────
# Env var `REA_SKIP_CODEX_REVIEW=<reason>` bypasses the Codex adversarial-
# review requirement. Set to any non-empty value; the value IS the reason
# recorded in the audit record (no default reason is supplied — if the
# operator sets `REA_SKIP_CODEX_REVIEW=1` the reason is literally "1").
#
# ORDERING (0.7.0): the hatch fires AFTER the HALT check but BEFORE ref-
# resolution and protected-path detection. Prior to 0.7.0 the check ran
# inside the protected-path branch and only fired when the diff touched a
# protected path — which meant an operator who wanted to skip Codex review
# got blocked by a transient ref-resolution failure (missing remote object,
# unresolvable source ref, etc.) before the skip ever fired. The new
# ordering mirrors REA_SKIP_PUSH_REVIEW: if the operator has committed to
# the bypass (accepting the audit record), ref-resolution failures should
# not strand the skip. Tradeoff: the skip now fires on every push when set,
# not just protected-path pushes. The audit receipt makes the operator
# accountable either way, and REA_SKIP_CODEX_REVIEW keeps its distinct
# tool_name so it never satisfies the `codex.review` jq predicate.
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

set -uo pipefail

# Read ALL stdin immediately. The core's BUG-008 sniff decides whether this
# is Claude Code JSON or git's native pre-push refspec list.
INPUT=$(cat)

# Resolve the core library from this adapter's own on-disk location. Using
# BASH_SOURCE (not argv $0) so `bash hooks/push-review-gate.sh` and
# `.../.claude/hooks/push-review-gate.sh` both find `_lib/` next to the
# adapter. Consistent with the BUG-012 script-anchor rationale in core.
_adapter_script="${BASH_SOURCE[0]:-$0}"
_adapter_dir="$(cd -- "$(dirname -- "$_adapter_script")" && pwd -P 2>/dev/null)"
_core_lib="${_adapter_dir}/_lib/push-review-core.sh"
if [[ ! -f "$_core_lib" ]]; then
  printf 'rea-hook: push-review-core.sh not found next to %s\n' \
    "$_adapter_script" >&2
  printf 'rea-hook:   expected at %s\n' "$_core_lib" >&2
  exit 2
fi
# shellcheck source=_lib/push-review-core.sh
source "$_core_lib"

pr_core_run "$_adapter_script" "$INPUT" "$@"
