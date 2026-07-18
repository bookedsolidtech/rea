#!/usr/bin/env bash
# rea local-first pre-push template (0.26.0+).
#
# This is the SIMPLEST possible local-first pre-push body — pure
# delegation to `rea preflight --strict --operation push`. The real `.husky/pre-push`
# that `rea init`/`rea upgrade` writes is the canonical body in
# `src/cli/install/pre-push.ts::BODY_TEMPLATE`, which ALSO runs
# `rea preflight --strict --operation push` before the push-gate dispatch.
#
# Operators who want a minimal pre-push (no codex on push, just the
# local-review audit-log check) can replace their `.husky/pre-push`
# body with this one.
#
# Behavior:
#   - .rea/HALT present                     → exit 2 (kill-switch)
#   - policy.review.local_review.mode: off  → exit 0 (no-op)
#   - REA_SKIP_LOCAL_REVIEW=<reason> set    → exit 0 (audited)
#   - recent rea.local_review covers HEAD   → exit 0
#   - otherwise                             → exit 2 with helpful msg
#
# See docs/migration/0.26.0.md for the full enforcement story.
set -euo pipefail

# Resolve REA_ROOT — the consumer repo's root, used to locate a local
# rea binary. Git pre-push hooks cd into the repo root before invoking
# the hook, so `pwd` is the right answer here. We deliberately don't
# rely on `core.hooksPath` or `git rev-parse` so this template works
# under both vanilla git and husky 9 layouts.
REA_ROOT="$(pwd)"

# 0.54.0 round-35 P1: a linked worktree frequently has no local install
# (node_modules/dist live only in the PRIMARY checkout). Resolve the
# CLI from ONE seam: the worktree first, then the primary checkout
# (.git-file discriminator), then the PATH/npx tiers below unchanged.
# REA_ROOT itself stays the worktree — HALT and policy are resolved
# against it; only CLI dispatch follows REA_CLI_ROOT.
REA_CLI_ROOT="$REA_ROOT"
if [ ! -x "${REA_ROOT}/node_modules/.bin/rea" ] && [ ! -f "${REA_ROOT}/dist/cli/index.js" ] \
   && [ -f "${REA_ROOT}/.git" ]; then
  _rea_common_dir=$(git -C "$REA_ROOT" rev-parse --git-common-dir 2>/dev/null || true)
  case "$_rea_common_dir" in
    "") : ;;
    /*) : ;;
    *) _rea_common_dir="${REA_ROOT}/${_rea_common_dir}" ;;
  esac
  if [ -n "$_rea_common_dir" ]; then
    _rea_common=$(dirname "$_rea_common_dir")
    # Round-3 P2: verify the dirname candidate is the SAME repository
    # (its git-common-dir resolves to ours) — a bare/separate-git-dir
    # layout nesting metadata under an UNRELATED checkout must not have
    # its CLI executed against this repo's push.
    _rea_same_repo=0
    if [ -d "${_rea_common}/.rea" ] || [ -e "${_rea_common}/.git" ]; then
      _cc=$(git -C "$_rea_common" rev-parse --git-common-dir 2>/dev/null || true)
      case "$_cc" in "") : ;; /*) : ;; *) _cc="${_rea_common}/${_cc}" ;; esac
      if [ -n "$_cc" ]; then
        _x=$(cd "$_cc" 2>/dev/null && pwd -P) || _x="$_cc"
        _y=$(cd "$_rea_common_dir" 2>/dev/null && pwd -P) || _y="$_rea_common_dir"
        [ "$_x" = "$_y" ] && _rea_same_repo=1
      fi
    fi
    # Round-36 P2: a foreign nested checkout (verification failed) OR a
    # --separate-git-dir primary whose metadata is external — fall back
    # to git's first listed worktree (THIS repo's main one).
    if [ "$_rea_same_repo" = "0" ]; then
      _rea_common=$(git -C "$REA_ROOT" worktree list --porcelain 2>/dev/null \
        | sed -n 's/^worktree //p' | head -n 1)
    fi
    if [ -n "$_rea_common" ] && [ "$_rea_common" != "$REA_ROOT" ] \
       && { [ -d "${_rea_common}/.rea" ] || [ -e "${_rea_common}/.git" ]; } \
       && { [ -x "${_rea_common}/node_modules/.bin/rea" ] \
            || { [ -f "${_rea_common}/dist/cli/index.js" ] && [ -f "${_rea_common}/package.json" ] \
                 && grep -q '"name": *"@bookedsolid/rea"' "${_rea_common}/package.json" 2>/dev/null; }; }; then
      REA_CLI_ROOT="$_rea_common"
    fi
  fi
fi

# Round-27 F5 fix: inline the same rea-CLI resolution ladder used by
# the canonical BODY_TEMPLATE in src/cli/install/pre-push.ts. Pre-fix
# the body was `exec rea preflight --strict --operation push`, which assumed `rea` was
# on PATH. Git hooks run with the user's interactive PATH MINUS
# `node_modules/.bin` (npm doesn't extend PATH for hook subprocesses
# the way it does for `npm run` scripts), so devDependency-only
# installs got `rea: not found` on every push.
#
# Resolution order (matches BODY_TEMPLATE exactly):
#   1. ${REA_CLI_ROOT}/node_modules/.bin/rea  — local devDependency.
#   2. ${REA_CLI_ROOT}/dist/cli/index.js      — rea's own dogfood repo.
#   3. PATH-resolved rea                  — global install.
#   4. npx --no-install                    — last-resort npm cache hit.
# Round-34 F2 / round-50-51 P1 (mirrors round-32 F1 + round-50/51 in the
# canonical BODY_TEMPLATE of src/cli/install/pre-push.ts — these two are kept
# in sync BY HAND; they do NOT share a generator, so any change here must be
# replicated there and vice versa; the two `_rea_preflight` +
# `_rea_review_gate_active` pairs MUST be behaviorally identical). The
# `--operation` flag is NEWER than some resolvable rea binaries (a project
# pinned below this release, or a stale global/PATH install). Such a CLI exits
# `unknown option '--operation'` and would HARD-BLOCK every push.
# `_rea_preflight` tries the current invocation; on an unknown-option /
# unknown-command error it RETRIES the pre-0.26 `preflight --strict` form so
# the gate STILL RUNS on the older CLI.
#
# When even the retry is `unknown command` (a CLI too old to have `preflight`
# at ALL), the disposition is MODE-AWARE tri-state (round-54 — shadow is
# OBSERVE-ONLY and must NEVER block):
#   - review gate ENFORCE → FAIL CLOSED (exit 2 + CONFIG-ERROR).
#   - review gate SHADOW  → WARN to stderr + ALLOW (non-blocking).
#   - review gate OFF / unconfigured → ALLOW silently.
# A pure `unknown option` at the retry stage (flag mismatch on an otherwise
# preflight-capable CLI) ALWAYS allows regardless of mode. A GENUINE refusal
# (exit 2, no unknown-* marker) propagates unchanged. bash-3.2 / BSD-safe. $@ is
# the resolved CLI prefix.
#
# _rea_review_gate_mode: ECHOES the STRONGEST review-gate mode configured in
# THIS repo's LOCAL policy at ${REA_ROOT}/.rea/policy.yaml — `enforce`,
# `shadow`, or `off` (across review.local_review.mode AND
# artifact_gates.g3_review.mode; enforce > shadow > off). REA_ROOT is the
# consumer repo root resolved above (`$(pwd)`); policy is per-branch/worktree,
# so the LOCAL policy governs. Dependency-free (awk only), BSD/GNU/bash-3.2
# safe, single pass. Dispositions:
#   - policy ABSENT                       → `off`  (ALLOW)
#   - policy present, no shadow/enforce   → `off`  (ALLOW)
#   - policy present, mode shadow         → `shadow` (WARN + ALLOW)
#   - policy present, mode enforce        → `enforce` (FAIL CLOSED)
#   - policy present but awk unavailable  → `enforce` (cannot parse a governed
#                                            policy → bias fail-CLOSED)
# Parse recognizes a mode in EITHER form: (a) block form — `local_review:`/
# `g3_review:` on its own line with a `mode:` value on an indented line inside
# the block (indentation-disarmed so a sibling block's `mode:` cannot
# false-trip); OR (b) inline flow map on a SINGLE logical line at ANY nesting
# depth — `local_review: { mode: enforce }`, `local_review:{mode:enforce}`, and
# `review: { local_review: { mode: enforce } }`. Value matching strips non-alpha
# so `enforce`, `"enforce"`, `'enforce'`, `enforce # note` all match. Known
# limit: no full YAML parse — a broken policy read as no-mode maps to `off`.
_rea_review_gate_mode() {
  _rea_pol="${REA_ROOT}/.rea/policy.yaml"
  [ -f "$_rea_pol" ] || { printf 'off'; return 0; }
  command -v awk >/dev/null 2>&1 || { printf 'enforce'; return 0; }
  _rea_m=$(awk '
    function ind(str,   n){ n=0; while (substr(str,n+1,1)==" ") n++; return n }
    function modeval(str,   v){
      if (str !~ /mode:/) return ""
      v=str; sub(/.*mode:/,"",v); gsub(/[^A-Za-z]/,"",v)
      if (v ~ /^enforce/) return "enforce"
      if (v ~ /^shadow/) return "shadow"
      return ""
    }
    function bump(m){ if (m=="enforce") best=2; else if (m=="shadow" && best<1) best=1 }
    BEGIN { best=0; inlinep="(local_review|g3_review)[^A-Za-z_].*mode:"; opener="^(local_review|g3_review):" }
    {
      s=$0; sub(/^[ \t]*/,"",s)
      if (s=="" || substr(s,1,1)=="#") next
      if (s ~ inlinep) bump(modeval(s))
      i=ind($0)
      if (s ~ opener) { bump(modeval(s)); blk=1; bi=i; next }
      if (blk) {
        if (i <= bi) blk=0
        else if (s ~ /^mode:/) bump(modeval(s))
      }
    }
    END { if (best==2) print "enforce"; else if (best==1) print "shadow" }
  ' "$_rea_pol" 2>/dev/null)
  case "$_rea_m" in
    enforce) printf 'enforce' ;;
    shadow) printf 'shadow' ;;
    *) printf 'off' ;;
  esac
}
_rea_preflight() {
  _pf_out=$("$@" preflight --strict --operation push 2>&1) && _pf_rc=0 || _pf_rc=$?
  if [ "$_pf_rc" -ne 0 ]; then
    case "$_pf_out" in
      *"unknown option"* | *"unknown command"*)
        _pf_out=$("$@" preflight --strict 2>&1) && _pf_rc=0 || _pf_rc=$?
        case "$_pf_out" in
          *"unknown command"*)
            # CLI lacks `preflight` entirely. Round-54 tri-state:
            #   enforce → FAIL CLOSED; shadow → WARN + ALLOW; off → ALLOW.
            case "$(_rea_review_gate_mode)" in
              enforce)
                printf 'rea: CONFIG-ERROR — pre-push blocked (fail-closed).\n' >&2
                printf '  The resolved rea CLI has no `preflight` command, but this repo has an\n' >&2
                printf '  ENFORCE review gate (review.local_review.mode or artifact_gates.g3_review.mode\n' >&2
                printf '  = enforce). Refusing to push without a coverage check. Fix one:\n' >&2
                printf '    - upgrade rea (e.g. `npm i -g @bookedsolid/rea`), or\n' >&2
                printf '    - set the gate mode to `off` in .rea/policy.yaml, or\n' >&2
                printf '    - bypass this one push with REA_SKIP_LOCAL_REVIEW="<reason>".\n' >&2
                _pf_out=""; _pf_rc=2 ;;
              shadow)
                printf 'rea: WARN — review gate (shadow) could not run: resolved rea CLI has no `preflight` command; not blocking.\n' >&2
                _pf_out=""; _pf_rc=0 ;;
              *)
                _pf_out=""; _pf_rc=0 ;;
            esac
            ;;
          *"unknown option"*)
            # Pure flag incompatibility on a preflight-capable CLI — never block.
            _pf_out=""; _pf_rc=0 ;;
        esac
        ;;
    esac
  fi
  if [ -n "$_pf_out" ]; then printf '%s\n' "$_pf_out" >&2; fi
  return "$_pf_rc"
}
if (
  if [ -x "${REA_CLI_ROOT}/node_modules/.bin/rea" ]; then
    _rea_preflight "${REA_CLI_ROOT}/node_modules/.bin/rea"
  elif [ -f "${REA_CLI_ROOT}/dist/cli/index.js" ] \
     && [ -f "${REA_CLI_ROOT}/package.json" ] \
     && grep -q '"name": *"@bookedsolid/rea"' "${REA_CLI_ROOT}/package.json" 2>/dev/null; then
    # rea's own repo (dogfood) — the package is not installed under
    # node_modules here because we ARE the package. Gate this branch on
    # `package.json` declaring `@bookedsolid/rea` so a consumer repo that
    # happens to ship its own `dist/cli/index.js` does not get this hook
    # executing the consumer's unrelated build.
    _rea_preflight node "${REA_CLI_ROOT}/dist/cli/index.js"
  elif command -v rea >/dev/null 2>&1; then
    _rea_preflight rea
  elif command -v npx >/dev/null 2>&1; then
    # Last resort: npx will resolve the package from npm or the cache.
    # Pass `--no-install` so a rare cache-cold machine surfaces a clear
    # error instead of silently downloading at push time.
    _rea_preflight npx --no-install @bookedsolid/rea
  else
    printf 'rea: cannot locate the rea CLI for preflight. Install locally (`pnpm add -D @bookedsolid/rea`) or set policy.review.local_review.mode=off.\n' >&2
    exit 2
  fi
); then
  exit 0
else
  exit "$?"
fi
