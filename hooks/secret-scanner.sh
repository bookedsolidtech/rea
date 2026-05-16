#!/bin/bash
# PreToolUse hook: secret-scanner.sh
# 0.34.0+ — Node-binary shim for `rea hook secret-scanner`.
# 0.38.0+ — migrated to `_lib/shim-runtime.sh` (shared runtime).
#
# Pre-0.34.0 the gate's full body lived here as bash (230 LOC, awk
# line filter + 17-pattern catalog + placeholder-rejection + MultiEdit
# fragment join). Migration in `src/hooks/secret-scanner/index.ts`.
# Behavioral contract preserved byte-for-byte: exit 0 on no-match or
# MEDIUM-only advisory, exit 2 on HALT / HIGH match / malformed payload.
#
# # Shim short-circuits (codex round-1 P2 fix from 0.34.0)
#
# Replicate the pre-0.34.0 bash body's two short-circuits BEFORE CLI
# resolution:
#   - Empty content (no `content`, `new_string`, `edits[]`, or
#     `new_source` in the payload) → exit 0.
#   - file_path / notebook_path with `.env.example` or `.env.sample`
#     suffix → exit 0.
# This unblocks workflows on fresh/unbuilt installs (clearing a file
# or editing an example env file would otherwise fail closed).
#
# # CLI-missing relevance scan (round-7 P1)
#
# When the CLI is missing AND content contains a credential marker
# from the catalog, preserve fail-closed. When no marker matches,
# exit 0 (pre-port body would have allowed).

set -uo pipefail

# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="secret-scanner"
SHIM_INTRODUCED_IN="0.34.0"
SHIM_FAIL_OPEN=0
SHIM_REFUSAL_NOUN="credential refusal"

# Module-level: populated by shim_is_relevant for use by
# shim_cli_missing_relevant (avoids re-parsing INPUT via jq twice).
_SS_CONTENT=""
_SS_FILE_PATH=""
_SS_JQ_PARSE_CLEAN=0

shim_is_relevant() {
  # Two short-circuits: empty content, and *.env.example / *.env.sample
  # suffix. Only honored when BOTH jq probes parse cleanly; on parse
  # failure fall through to the CLI which fails closed via Zod.
  if command -v jq >/dev/null 2>&1; then
    # 0.34.0 round-2 fix: tostring so non-string `new_string`
    # (object/number/null) doesn't trip jq with "Cannot iterate".
    _SS_CONTENT=$(printf '%s' "$INPUT" | jq -r '
      (.tool_input.content // .tool_input.new_string //
        (
          if (.tool_input.edits | type) == "array"
          then (.tool_input.edits | map((.new_string // "") | tostring) | join("\n"))
          else ""
          end
        ) //
        .tool_input.new_source // ""
      ) | tostring
    ' 2>/dev/null)
    local jq_content_status=$?
    _SS_FILE_PATH=$(printf '%s' "$INPUT" | jq -r '
      .tool_input.file_path // .tool_input.notebook_path // ""
    ' 2>/dev/null)
    local jq_path_status=$?
    if [ "$jq_content_status" -eq 0 ] && [ "$jq_path_status" -eq 0 ]; then
      _SS_JQ_PARSE_CLEAN=1
      if [ -z "$_SS_CONTENT" ]; then
        # Empty content — pre-port body exit 0.
        return 1
      fi
      case "$_SS_FILE_PATH" in
        *.env.example|*.env.sample) return 1 ;;
      esac
    fi
  fi
  # Either jq missing OR jq parse failure OR non-excluded payload → relevant.
  return 0
}

shim_cli_missing_relevant() {
  # 0.34.0 round-7 P1: when the CLI is missing AND the content carries
  # a credential marker, preserve fail-closed. When no marker matches,
  # the pre-port bash body would have allowed.
  local content_for_scan
  if [ -n "$_SS_CONTENT" ]; then
    content_for_scan="$_SS_CONTENT"
  else
    # jq missing or parse-failed — substring scan the raw payload.
    content_for_scan="$INPUT"
  fi
  case "$content_for_scan" in
    *"AKIA"*) return 0 ;;
    *"AWS_SECRET_ACCESS_KEY"*|*"aws_secret_access_key"*) return 0 ;;
    *"-----BEGIN"*) return 0 ;;
    *"sk-ant-"*) return 0 ;;
    *"ghp_"*|*"ghs_"*|*"gho_"*|*"ghu_"*|*"ghr_"*) return 0 ;;
    *"github_pat_"*) return 0 ;;
    *"sk_live_"*|*"rk_live_"*|*"pk_live_"*) return 0 ;;
    *"sk_test_"*|*"rk_test_"*|*"pk_test_"*) return 0 ;;
    *"whsec_"*) return 0 ;;
    *"SECRET"*|*"PASSWORD"*|*"PRIVATE_KEY"*|*"API_SECRET"*) return 0 ;;
    *"SUPABASE_SERVICE_ROLE_KEY"*|*"SUPABASE_ANON_KEY"*) return 0 ;;
    *"ANTHROPIC_API_KEY"*|*"STRIPE_SECRET"*|*"DATABASE_URL"*) return 0 ;;
    *"postgresql://"*) return 0 ;;
    *"eyJ"*) return 0 ;;
  esac
  return 1
}

# shellcheck source=_lib/shim-runtime.sh
source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
