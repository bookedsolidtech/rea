#!/bin/bash
# hooks/_lib/shim-runtime.sh — shared Node-binary shim runtime.
# Introduced 0.38.0.
#
# Source via:
#   source "$(dirname "$0")/_lib/shim-runtime.sh"
#   shim_run
#
# # Problem this solves
#
# Releases 0.32.0 → 0.35.0 ported all 14 PreToolUse/PostToolUse hooks
# from bash to Node-binary CLIs. Each port left a ~120-LOC shell shim
# that does the same five things:
#
#   1. HALT check
#   2. Capture stdin
#   3. Resolve the rea CLI through the fixed 2-tier sandboxed order
#   4. Realpath sandbox check (cli inside CLAUDE_PROJECT_DIR + ancestor
#      package.json with `name`=`@bookedsolid/rea`)
#   5. Version-probe `rea hook <NAME> --help`, then forward stdin
#
# Plus standardized fail-closed / fail-open banners. The duplication
# was the single largest source of drift bugs in the marathon — every
# round of codex review found at least one shim that had drifted (e.g.
# settings-protection.sh / blocked-paths-bash-gate.sh / blocked-paths-
# enforcer.sh gained the `dist/cli/index.js` shape check at codex
# round-1 of 0.35.0; pr-issue-link-gate / attribution-advisory got
# the sandbox-before-policy-read fix at codex round-2 of 0.37.0).
#
# 0.38.0 consolidates the duplicated infrastructure into this helper.
# Each shim becomes ~20 LOC of hook-specific customization plus a
# single `shim_run` invocation.
#
# # Public API
#
# Variables the shim sets BEFORE sourcing this lib + calling shim_run:
#
#   SHIM_NAME              (required) — subcommand name like
#                          "dangerous-bash-interceptor". Used in
#                          banners, the `rea hook <name>` invocation,
#                          and the version-probe content match.
#
#   SHIM_INTRODUCED_IN     (required) — version string like "0.34.0".
#                          Used in the version-skew banner ("requires
#                          the … subcommand (introduced in X)").
#
#   SHIM_FAIL_OPEN         (default 0) — 1 = advisory-tier (exit 0
#                          on every CLI-failure branch except HALT);
#                          0 = blocking-tier (exit 2). Advisory shims
#                          (pr-issue-link-gate, architecture-review-
#                          gate, delegation-advisory, delegation-
#                          capture) set this to 1.
#
#   SHIM_ENFORCE_CLI_SHAPE (default 0) — 1 = ALSO require that the
#                          resolved CLI's realpath ends in
#                          `dist/cli/index.js`. Closes the codex
#                          round-1 P1 finding from 0.35.0 (an attacker
#                          who repoints node_modules/@bookedsolid/rea
#                          → arbitrary in-project JS would otherwise
#                          execute that file as the trusted gate CLI).
#                          settings-protection, blocked-paths-bash-
#                          gate, blocked-paths-enforcer, protected-
#                          paths-bash-gate all set this to 1.
#
#   SHIM_REFUSAL_NOUN      (default "protection") — used in the
#                          fail-closed CLI-missing banner ("to restore
#                          $SHIM_REFUSAL_NOUN"). Per-shim wording.
#
#   SHIM_NODE_MISSING_NOUN (default same as SHIM_REFUSAL_NOUN) — used
#                          in the "node not on PATH" banner.
#
#   SHIM_SKIP_VERSION_PROBE (default 0) — 1 = skip the version-probe
#                          step entirely. delegation-capture sets this
#                          because the pre-port body had no probe (the
#                          forward is fire-and-forget; a stale CLI
#                          drops the signal silently rather than
#                          spamming the operator with a probe banner
#                          on every Agent/Skill dispatch).
#
# Optional shim-defined callbacks (functions). Each runs in the same
# process as the shim — they have access to INPUT, REA_ROOT, proj,
# REA_ARGV, RESOLVED_CLI_PATH. To take effect they MUST be defined
# BEFORE `shim_run` is called.
#
#   shim_is_relevant       Return 0 if the payload should pass through
#                          the gate; return 1 to exit 0 immediately
#                          (irrelevant Bash/Write call). Runs AFTER
#                          stdin capture, BEFORE any CLI work. Most
#                          shims define this for the relevance pre-
#                          gate.
#
#   shim_cli_missing_relevant
#                          Called when the CLI is unreachable (no
#                          node_modules/@bookedsolid/rea AND no
#                          dist/cli/index.js). Return 0 to fail-closed
#                          (emit banner + exit 2 or exit 0 per
#                          FAIL_OPEN); return 1 to exit 0 silently
#                          (pre-bash-body behavior allowed the payload
#                          when no rule matched). When this hook is
#                          NOT defined, default behavior is:
#                            - SHIM_FAIL_OPEN=0 → emit banner, exit 2
#                            - SHIM_FAIL_OPEN=1 → exit 0 silently
#                          dangerous-bash-interceptor / secret-scanner
#                          / settings-protection define this to mirror
#                          the pre-port body's keyword-relevance scan.
#
#   shim_policy_short_circuit
#                          Called AFTER sandbox-check, BEFORE version-
#                          probe. Return 0 to exit 0 cleanly (policy
#                          disabled the gate); return 1 to continue
#                          with version-probe + forward. Used by
#                          attribution-advisory (`block_ai_attribution`
#                          check) and security-disclosure-gate
#                          (`REA_DISCLOSURE_MODE=disabled` check).
#                          Can call `policy_reader_get` etc. since
#                          REA_ARGV is sandbox-validated by this point.
#
#   shim_forward           Override the final stdin-forward step.
#                          Default: `printf '%s' "$INPUT" |
#                          "${REA_ARGV[@]}" hook "$SHIM_NAME"; exit $?`.
#                          delegation-capture overrides this to detach
#                          (background + disown). Receives INPUT,
#                          REA_ARGV in env.
#
# # Bash 3.2 compatibility
#
# This lib targets macOS bash 3.2 (and POSIX-ish where possible).
# Avoid: `mapfile`, `read -d`, `${VAR^^}`, associative arrays.
# OK: arrays, indirect expansion (`${!VAR}`), `[[`.
#
# # Trust boundary
#
# `shim_run` is sourced into the same shell as the shim. It assumes
# the shim has set `set -uo pipefail` at the top. It does NOT
# re-source halt-check.sh — the shim does that explicitly so the
# REA_ROOT helper is visible BEFORE the lib is sourced.

set -uo pipefail

# -----------------------------------------------------------------------------
# Defaults — applied by `shim_run` when the shim hasn't set them. We use
# the `:=` operator to assign-if-unset so callers can override.
# -----------------------------------------------------------------------------
_shim_apply_defaults() {
  : "${SHIM_NAME:?shim-runtime: SHIM_NAME must be set before shim_run}"
  : "${SHIM_INTRODUCED_IN:?shim-runtime: SHIM_INTRODUCED_IN must be set before shim_run}"
  : "${SHIM_FAIL_OPEN:=0}"
  : "${SHIM_ENFORCE_CLI_SHAPE:=0}"
  : "${SHIM_REFUSAL_NOUN:=protection}"
  : "${SHIM_NODE_MISSING_NOUN:=$SHIM_REFUSAL_NOUN}"
  : "${SHIM_SKIP_VERSION_PROBE:=0}"
}

# -----------------------------------------------------------------------------
# CLI resolution — fixed 2-tier sandboxed order. PATH is INTENTIONALLY
# OMITTED (agent-controlled $PATH would let a forged `rea` binary
# intercept every hook dispatch).
#
# Sets REA_ARGV (array) and RESOLVED_CLI_PATH (string) on success.
# When neither tier resolves, REA_ARGV stays empty and RESOLVED_CLI_PATH
# stays empty.
# -----------------------------------------------------------------------------
shim_resolve_cli() {
  REA_ARGV=()
  RESOLVED_CLI_PATH=""
  if [ -f "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js" ]; then
    REA_ARGV=(node "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js")
    RESOLVED_CLI_PATH="$proj/node_modules/@bookedsolid/rea/dist/cli/index.js"
  elif [ -f "$proj/dist/cli/index.js" ]; then
    REA_ARGV=(node "$proj/dist/cli/index.js")
    RESOLVED_CLI_PATH="$proj/dist/cli/index.js"
  fi
}

# -----------------------------------------------------------------------------
# Realpath sandbox check — validates the resolved CLI:
#   1. realpath(CLI) lives INSIDE realpath(CLAUDE_PROJECT_DIR)
#   2. an ancestor package.json has `name`=`@bookedsolid/rea`
#   3. (when SHIM_ENFORCE_CLI_SHAPE=1) realpath ends in dist/cli/index.js
#
# Echoes "ok" on success or "bad:<reason>" on failure. Caller compares
# to "ok".
#
# Args:
#   $1 — resolved CLI path
#   $2 — CLAUDE_PROJECT_DIR
#   $3 — "1" to enforce dist/cli/index.js shape, "0" otherwise
# -----------------------------------------------------------------------------
shim_sandbox_check() {
  local cli_path="$1"
  local proj_dir="$2"
  local enforce_shape="${3:-0}"
  node -e '
    const fs = require("fs");
    const path = require("path");
    const cli = process.argv[1];
    const projDir = process.argv[2];
    const enforceShape = process.argv[3] === "1";
    let real, realProj;
    try { real = fs.realpathSync(cli); } catch (e) {
      process.stdout.write("bad:realpath"); process.exit(1);
    }
    try { realProj = fs.realpathSync(projDir); } catch (e) {
      process.stdout.write("bad:realpath-proj"); process.exit(1);
    }
    const sep = path.sep;
    const projWithSep = realProj.endsWith(sep) ? realProj : realProj + sep;
    if (!(real === realProj || real.startsWith(projWithSep))) {
      process.stdout.write("bad:cli-escapes-project"); process.exit(1);
    }
    if (enforceShape) {
      // 0.35.0 codex round-1 P1 fix: enforce dist/cli/index.js shape so a
      // workspace attacker who repoints node_modules/@bookedsolid/rea or
      // dist at an arbitrary in-project JS file cannot execute it as the
      // trusted gate CLI.
      const expectedEnd = path.join("dist", "cli", "index.js");
      if (!real.endsWith(path.sep + expectedEnd) && real !== "/" + expectedEnd) {
        process.stdout.write("bad:cli-shape"); process.exit(1);
      }
    }
    let cur = path.dirname(path.dirname(path.dirname(real)));
    let found = false;
    for (let i = 0; i < 20 && cur && cur !== path.dirname(cur); i += 1) {
      const pj = path.join(cur, "package.json");
      if (fs.existsSync(pj)) {
        try {
          const data = JSON.parse(fs.readFileSync(pj, "utf8"));
          if (data && data.name === "@bookedsolid/rea") { found = true; break; }
        } catch (e) { /* keep walking */ }
      }
      cur = path.dirname(cur);
    }
    if (!found) { process.stdout.write("bad:no-rea-pkg-json"); process.exit(1); }
    process.stdout.write("ok");
  ' -- "$cli_path" "$proj_dir" "$enforce_shape" 2>/dev/null
}

# -----------------------------------------------------------------------------
# Standardized banners — keep stderr templates identical across shims.
# -----------------------------------------------------------------------------
shim_emit_cli_missing_banner() {
  printf 'rea: %s cannot run — the rea CLI is not built.\n' "$SHIM_NAME" >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore %s.\n' "$SHIM_REFUSAL_NOUN" >&2
  printf 'This shim fails closed because the pre-port bash body enforced %s refusal without a CLI.\n' "$SHIM_NAME" >&2
}

shim_emit_node_missing_banner() {
  printf 'rea: %s cannot run — `node` is not on PATH.\n' "$SHIM_NAME" >&2
  printf 'Install Node 22+ (engines.node) to restore %s.\n' "$SHIM_NODE_MISSING_NOUN" >&2
}

shim_emit_sandbox_failure_banner() {
  local reason="$1"
  printf 'rea: %s FAILED sandbox check (%s) — refusing.\n' "$SHIM_NAME" "$reason" >&2
}

shim_emit_sandbox_skip_banner() {
  local reason="$1"
  printf 'rea: %s skipped (sandbox check: %s)\n' "$SHIM_NAME" "$reason" >&2
}

shim_emit_version_skew_banner_blocking() {
  printf 'rea: this shim requires the `rea hook %s` subcommand (introduced in %s).\n' "$SHIM_NAME" "$SHIM_INTRODUCED_IN" >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
}

shim_emit_version_skew_banner_advisory() {
  printf 'rea: this shim requires the `rea hook %s` subcommand (introduced in %s).\n' "$SHIM_NAME" "$SHIM_INTRODUCED_IN" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; falling through silently.\n' >&2
}

# -----------------------------------------------------------------------------
# Default stdin forward. shim_forward can override (delegation-capture).
# -----------------------------------------------------------------------------
shim_default_forward() {
  printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook "$SHIM_NAME"
  exit $?
}

# -----------------------------------------------------------------------------
# Main entry point. Reads SHIM_* variables, runs the standard flow.
# -----------------------------------------------------------------------------
shim_run() {
  _shim_apply_defaults

  # 1. HALT check — the shim is expected to have sourced halt-check.sh
  #    and called `check_halt` BEFORE sourcing this lib, so REA_ROOT is
  #    already set. We just use it.
  : "${REA_ROOT:?shim-runtime: REA_ROOT must be set (source halt-check.sh + call check_halt first)}"
  proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

  # 2. Capture stdin once.
  INPUT=$(cat)

  # 3. Relevance pre-gate. If the shim defined `shim_is_relevant`, call it.
  if declare -F shim_is_relevant >/dev/null 2>&1; then
    if ! shim_is_relevant; then
      exit 0
    fi
  fi

  # 4. Resolve CLI.
  shim_resolve_cli

  # 5. Sandbox check (when CLI was resolved). On failure clear REA_ARGV
  #    + stash the reason so the eventual CLI-required branch can emit
  #    the correct banner. Running the sandbox check BEFORE the policy
  #    short-circuit prevents an unsandboxed CLI from being invoked by
  #    Tier-1 of the policy reader (0.37.0 codex round-2 P1: applies to
  #    shims like attribution-advisory whose policy_short_circuit may
  #    use `policy_reader_get`).
  #
  #    Advisory-tier: a sandbox failure exits 0 with the skip banner —
  #    nothing to enforce for nudges. Blocking-tier: deferred to the
  #    CLI-required branch below so we emit ONE banner per refusal
  #    (instead of double-emitting sandbox + cli-missing).
  local sandbox_result=""
  local sandbox_failed=0
  if [ "${#REA_ARGV[@]}" -gt 0 ]; then
    if ! command -v node >/dev/null 2>&1; then
      if [ "$SHIM_FAIL_OPEN" -eq 1 ]; then
        exit 0
      fi
      # Blocking-tier: node missing means we cannot sandbox-validate the
      # CLI — refuse with the dedicated banner.
      shim_emit_node_missing_banner
      exit 2
    fi
    sandbox_result=$(shim_sandbox_check "$RESOLVED_CLI_PATH" "$proj" "$SHIM_ENFORCE_CLI_SHAPE")
    if [ "$sandbox_result" != "ok" ]; then
      sandbox_failed=1
      if [ "$SHIM_FAIL_OPEN" -eq 1 ]; then
        shim_emit_sandbox_skip_banner "$sandbox_result"
        exit 0
      fi
      # Blocking-tier: clear REA_ARGV so Tier-1 policy reads (in
      # shim_policy_short_circuit) degrade to Tier 2 / Tier 3 instead
      # of invoking the untrusted CLI.
      REA_ARGV=()
    fi
  fi

  # 6. Policy short-circuit. Runs BEFORE the CLI-missing branch so a
  #    shim whose policy says "disabled" exits 0 cleanly even when the
  #    CLI is unbuilt (matches the pre-port body's no-op-on-disabled
  #    posture). The policy reader's 4-tier ladder produces correct
  #    answers even when REA_ARGV is empty (falls back to Tier 2
  #    python3 / Tier 3 awk).
  if declare -F shim_policy_short_circuit >/dev/null 2>&1; then
    if shim_policy_short_circuit; then
      exit 0
    fi
  fi

  # 7. CLI-required branch. If REA_ARGV is empty either (a) the CLI
  #    wasn't installed/built, OR (b) the sandbox check failed and we
  #    cleared it above. Distinguish.
  if [ "${#REA_ARGV[@]}" -eq 0 ]; then
    if [ "$sandbox_failed" -eq 1 ]; then
      shim_emit_sandbox_failure_banner "$sandbox_result"
      exit 2
    fi
    if declare -F shim_cli_missing_relevant >/dev/null 2>&1; then
      if ! shim_cli_missing_relevant; then
        # CLI missing AND payload is not relevant per shim's keyword
        # scan — the pre-port bash body would have allowed this.
        exit 0
      fi
    fi
    # Either no callback defined OR the callback said "yes, relevant".
    if [ "$SHIM_FAIL_OPEN" -eq 1 ]; then
      # Advisory tier — drop the gate silently. No banner; advisory
      # hooks are nudges, not security claims.
      exit 0
    fi
    shim_emit_cli_missing_banner
    exit 2
  fi

  # 8. Version probe (skipped when SHIM_SKIP_VERSION_PROBE=1, used by
  #    delegation-capture whose pre-port body had no probe — a stale
  #    CLI drops the signal silently rather than spamming the operator
  #    on every Agent/Skill dispatch).
  if [ "$SHIM_SKIP_VERSION_PROBE" -eq 0 ]; then
    local probe_out probe_status
    probe_out=$("${REA_ARGV[@]}" hook "$SHIM_NAME" --help 2>&1)
    probe_status=$?
    if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e "$SHIM_NAME"; then
      if [ "$SHIM_FAIL_OPEN" -eq 1 ]; then
        shim_emit_version_skew_banner_advisory
        exit 0
      fi
      shim_emit_version_skew_banner_blocking
      exit 2
    fi
  fi

  # 9. Forward stdin.
  if declare -F shim_forward >/dev/null 2>&1; then
    shim_forward
  else
    shim_default_forward
  fi
}
