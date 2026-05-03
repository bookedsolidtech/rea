#!/bin/bash
# PreToolUse hook: protected-paths-bash-gate.sh
# Fires BEFORE every Bash tool call.
# Refuses Bash commands that write to PROTECTED_PATTERNS via shell
# redirection or write-flag utilities — the kill-switch and policy
# files MUST be unreachable via any tool surface, including Bash.
#
# Pre-0.15.0, settings-protection.sh §6 protected `.rea/HALT`,
# `.rea/policy.yaml`, `.claude/settings.json`, `.husky/*` against
# Write/Edit/MultiEdit tool calls. But shell redirects bypassed it
# entirely:
#
#   printf '...' > .rea/HALT          # bypass — Bash matcher only
#   tee .rea/policy.yaml < new.yaml   # bypass
#   cp new-settings.json .claude/settings.json
#   sed -i '' '/foo/d' .husky/pre-push
#   dd of=.rea/HALT
#
# This hook closes that gap by detecting redirect/write patterns
# whose target matches the same `_lib/protected-paths.sh` allowlist.
#
# Exit codes:
#   0 = no protected-path write detected — allow
#   2 = protected-path write via Bash detected — block

set -uo pipefail

# shellcheck source=_lib/protected-paths.sh
source "$(dirname "$0")/_lib/protected-paths.sh"
# shellcheck source=_lib/cmd-segments.sh
source "$(dirname "$0")/_lib/cmd-segments.sh"

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  printf 'REA ERROR: jq is required but not installed.\n' >&2
  exit 2
fi

REA_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# HALT check — uniform with other hooks.
HALT_FILE="${REA_ROOT}/.rea/HALT"
if [ -f "$HALT_FILE" ]; then
  printf 'REA HALT: %s\nAll agent operations suspended. Run: rea unfreeze\n' \
    "$(head -c 1024 "$HALT_FILE" 2>/dev/null || echo 'Reason unknown')" >&2
  exit 2
fi

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [[ -z "$CMD" ]]; then
  exit 0
fi

# Normalize a path token: strip enclosing quotes, strip leading
# `$REA_ROOT/`, strip leading `./`. The result is project-relative
# for matching against REA_PROTECTED_PATTERNS.
_normalize_target() {
  local t="$1"
  # Strip matching surrounding quotes.
  if [[ "$t" =~ ^\"(.*)\"$ ]]; then t="${BASH_REMATCH[1]}"; fi
  if [[ "$t" =~ ^\'(.*)\'$ ]]; then t="${BASH_REMATCH[1]}"; fi
  # Strip $REA_ROOT prefix (with or without trailing slash).
  if [[ "$t" == "$REA_ROOT"/* ]]; then t="${t#"$REA_ROOT"/}"; fi
  # Strip leading ./
  while [[ "$t" == ./* ]]; do t="${t#./}"; done
  printf '%s' "$t"
}

# Refuse and exit 2 with a uniform error message.
_refuse() {
  local pattern="$1" target="$2" segment="$3"
  {
    printf 'PROTECTED PATH (bash): write to a package-managed file blocked\n'
    printf '\n'
    printf '  Pattern matched: %s\n' "$pattern"
    printf '  Resolved target: %s\n' "$target"
    printf '  Segment:         %s\n' "$segment"
    printf '\n'
    printf '  Rule: protected paths (kill-switch, policy.yaml, settings.json,\n'
    printf '        .husky/*) are unreachable via Bash redirects too — not just\n'
    printf '        Write/Edit/MultiEdit. To modify, a human must edit directly.\n'
  } >&2
  exit 2
}

# Inspect one segment for redirect / write patterns and refuse if the
# target matches any protected pattern.
_check_segment() {
  local _raw="$1" segment="$2"
  [[ -z "$segment" ]] && return 0

  local target_token=""
  local detected_form=""

  # bash `[[ =~ ]]` regex literals with `|` and `(...)` parsed inline
  # confuse some bash versions on macOS. Use named variables for each
  # pattern so the literal stays in a string context only.
  local re_redirect='(^|[[:space:]])(&>|2>>|2>|>>|>)[[:space:]]*([^[:space:]&|;<>]+)'
  local re_cpmv='(^|[[:space:]])(cp|mv)[[:space:]]+[^&|;<>]+[[:space:]]([^[:space:]&|;<>]+)[[:space:]]*$'
  local re_sed='(^|[[:space:]])sed[[:space:]]+(-[a-zA-Z]*i[a-zA-Z]*[^[:space:]]*)[[:space:]]+[^&|;<>]+[[:space:]]([^[:space:]&|;<>]+)[[:space:]]*$'
  local re_dd='(^|[[:space:]])dd[[:space:]]+[^&|;<>]*of=([^[:space:]&|;<>]+)'
  # 0.15.0 codex P1 fix: replaced the bash-3.2-broken `(...)*` pattern
  # for tee/truncate flag-skipping with a token-walk approach that
  # works across BSD bash 3.2 and GNU bash 4+. Walks every token after
  # the command, skips flags (single-dash short, double-dash long with
  # optional =value), returns the first non-flag token as the target.

  if [[ "$segment" =~ $re_redirect ]]; then
    target_token="${BASH_REMATCH[3]}"
    detected_form="redirect ${BASH_REMATCH[2]}"
  elif [[ "$segment" =~ $re_cpmv ]]; then
    target_token="${BASH_REMATCH[3]}"
    detected_form="${BASH_REMATCH[2]}"
  elif [[ "$segment" =~ $re_sed ]]; then
    target_token="${BASH_REMATCH[3]}"
    detected_form="sed -i"
  elif [[ "$segment" =~ $re_dd ]]; then
    target_token="${BASH_REMATCH[2]}"
    detected_form="dd of="
  else
    # tee / truncate / install / ln — token-walk for cross-bash safety.
    # Read tokens, find the command, then return the first non-flag arg.
    local prev_word="" found_cmd=""
    local _seg_for_walk="$segment"
    # Strip leading whitespace.
    _seg_for_walk="${_seg_for_walk#"${_seg_for_walk%%[![:space:]]*}"}"
    # shellcheck disable=SC2086
    set -- $_seg_for_walk
    while [ "$#" -gt 0 ]; do
      local tok="$1"
      shift
      if [[ -z "$found_cmd" ]]; then
        case "$tok" in
          tee|truncate|install|ln)
            found_cmd="$tok"
            ;;
        esac
        prev_word="$tok"
        continue
      fi
      # We're inside the command's argv. Skip flags.
      case "$tok" in
        --) continue ;;
        --*=*) continue ;;
        --*)
          # Long flag — may take a value as the NEXT token (we don't
          # know which long options take values). For safety, skip
          # only known no-value long flags; otherwise consume the
          # next token too if it looks like a value.
          case "$tok" in
            --append|--ignore-interrupts|--no-clobber|--force|--no-target-directory|--symbolic|--no-dereference|--reference=*) continue ;;
            *) shift 2>/dev/null || true; continue ;;
          esac
          ;;
        -*)
          # Short flag cluster. Skip. truncate -s SIZE — `-s` is a flag,
          # SIZE is its arg. We're conservative: skip the next token if
          # the flag cluster's last char is one of the size-bearing
          # flags (truncate -s, install -m, ln -t).
          case "$tok" in
            -s*|-m*|-o*|-g*|-t*) shift 2>/dev/null || true ;;
          esac
          continue
          ;;
        *)
          # First non-flag token — this is the target (or, for cp/mv-
          # like commands, the first source; the cpmv detector above
          # handles those separately). We treat ALL non-flag args as
          # potential targets and check each — that catches
          # `tee a b c` where any of a/b/c could be a protected file.
          target_token="$tok"
          detected_form="$found_cmd"
          # Check this token immediately; if not protected, keep
          # walking — there may be more positional args.
          local _t
          _t=$(_normalize_target "$target_token")
          if rea_path_is_protected "$_t"; then
            local matched=""
            for pattern in "${REA_PROTECTED_PATTERNS[@]}"; do
              if [[ "$_t" == "$pattern" ]]; then matched="$pattern"; break; fi
              if [[ "$pattern" == */ && "$_t" == "$pattern"* ]]; then matched="$pattern"; break; fi
            done
            _refuse "$matched" "$_t" "$segment"
          fi
          # Reset target_token so the post-loop check doesn't double-check.
          target_token=""
          ;;
      esac
    done
  fi

  if [[ -z "$target_token" ]]; then
    return 0
  fi

  local target
  target=$(_normalize_target "$target_token")
  if rea_path_is_protected "$target"; then
    # Find the matching pattern for the error message.
    local matched=""
    for pattern in "${REA_PROTECTED_PATTERNS[@]}"; do
      if [[ "$target" == "$pattern" ]]; then matched="$pattern"; break; fi
      if [[ "$pattern" == */ && "$target" == "$pattern"* ]]; then matched="$pattern"; break; fi
    done
    _refuse "$matched" "$target" "$segment"
  fi
  return 0
}

for_each_segment "$CMD" _check_segment

exit 0
