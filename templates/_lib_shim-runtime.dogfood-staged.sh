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

# Source the per-session cache helper (0.48.0). This must be sourced
# at the top of shim-runtime.sh because `shim_run` needs all of the
# `shim_cache_*` functions available. The helper itself fails safe —
# no operations fire unless `shim_run` calls them.
# shellcheck source=shim-cache.sh
_SHIM_RUNTIME_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=shim-cache.sh
. "$_SHIM_RUNTIME_DIR/shim-cache.sh"

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

  # 4b. Per-session cache lookup (0.48.0). When the cache is enabled
  #     AND the resolved CLI matches a recent same-session entry, the
  #     sandbox check (step 5) AND version probe (step 8) can both be
  #     skipped — those answers do not change for a stable CLI inside a
  #     stable session. Cache MISS / disabled / corrupt → fall through
  #     to the existing uncached hot path. NEVER fail closed on a cache
  #     error (see hooks/_lib/shim-cache.sh header for the security
  #     contract). The cache check runs AFTER `shim_is_relevant` (per
  #     design memo concern #3) so we never pay a stat-per-fire cost
  #     for irrelevant payloads.
  local _shim_cache_hit=0
  local _shim_cache_key=""
  local _shim_cache_cli_real=""
  local _shim_cache_cli_mtime=""
  local _shim_cache_cli_size=""
  local _shim_cache_pkg_real=""
  local _shim_cache_pkg_mtime=""
  local _shim_cache_pkg_size=""
  local _shim_cache_dist_mtime=""
  local _shim_cache_node_real=""
  local _shim_cache_node_mtime=""
  if [ "${#REA_ARGV[@]}" -gt 0 ] && ! shim_cache_disabled; then
    local _stat_out=""
    local _proj_real=""
    local _euid=""
    local _session_tok=""
    _stat_out=$(shim_cache_mtime_size "$RESOLVED_CLI_PATH" 2>/dev/null || true)
    # 0.48.0 codex round-4 P1 + round-7 P2: capture the ACTUAL node
    # interpreter realpath + mtime via `process.execPath` (node's own
    # path to itself). Pre-round-7 we resolved `command -v node` via
    # `fs.realpathSync` — but version managers like Volta and asdf
    # use STABLE shim scripts (e.g. ~/.volta/bin/node) that resolve
    # to themselves; only the spawned node's `process.execPath`
    # reveals which concrete Node binary the shim ultimately
    # launched (e.g. /Users/foo/.volta/tools/image/node/22.x.x/bin/
    # node). Using execPath catches `volta pin`/`nvm use` interpreter
    # swaps correctly. The mtime field is captured at second
    # precision (consistent with the other mtime fields) — switching
    # Node versions changes the realpath so the mtime alone is not
    # load-bearing.
    _shim_cache_node_real=$(node -e 'process.stdout.write(require("fs").realpathSync(process.execPath))' 2>/dev/null || true)
    if [ -n "$_shim_cache_node_real" ]; then
      local _node_stat=""
      _node_stat=$(shim_cache_mtime_size "$_shim_cache_node_real" 2>/dev/null || true)
      if [ -n "$_node_stat" ]; then
        _shim_cache_node_mtime="${_node_stat%% *}"
      fi
    fi
    _shim_cache_cli_real=$(node -e 'try { process.stdout.write(require("fs").realpathSync(process.argv[1])); } catch (e) { process.exit(1); }' -- "$RESOLVED_CLI_PATH" 2>/dev/null || true)
    _proj_real=$(node -e 'try { process.stdout.write(require("fs").realpathSync(process.argv[1])); } catch (e) { process.exit(1); }' -- "$proj" 2>/dev/null || true)
    _euid=$(id -u 2>/dev/null || true)
    _session_tok=$(shim_cache_session_token 2>/dev/null || true)
    # 0.48.0 codex round-3 P2: ALSO capture the ancestor package.json
    # path + mtime/size. The sandbox check walks upward to find a
    # package.json whose `name` is `@bookedsolid/rea`; without it in
    # the key, a same-session edit to that package.json (renaming, or
    # removing the `name` field) would still see warm cache hits even
    # though the uncached sandbox check would reject the new state.
    # Codex round-3 P1: ALSO capture the dist/cli/ DIR mtime so a
    # rebuild that adds/removes files (most fresh tsc runs after a
    # source-tree change) invalidates the key even if dist/cli/
    # index.js content happens to round to the same ns.
    _shim_cache_pkg_real=$(node -e '
      try {
        const fs = require("fs");
        const path = require("path");
        const real = fs.realpathSync(process.argv[1]);
        let cur = path.dirname(path.dirname(path.dirname(real)));
        for (let i = 0; i < 20 && cur && cur !== path.dirname(cur); i++) {
          const pj = path.join(cur, "package.json");
          if (fs.existsSync(pj)) {
            try {
              const data = JSON.parse(fs.readFileSync(pj, "utf8"));
              if (data && data.name === "@bookedsolid/rea") {
                process.stdout.write(pj);
                process.exit(0);
              }
            } catch (e) {}
          }
          cur = path.dirname(cur);
        }
        process.exit(1);
      } catch (e) { process.exit(1); }
    ' -- "$RESOLVED_CLI_PATH" 2>/dev/null || true)
    if [ -n "$_shim_cache_pkg_real" ]; then
      local _pkg_stat=""
      _pkg_stat=$(shim_cache_mtime_size "$_shim_cache_pkg_real" 2>/dev/null || true)
      if [ -n "$_pkg_stat" ]; then
        _shim_cache_pkg_mtime="${_pkg_stat%% *}"
        _shim_cache_pkg_size="${_pkg_stat##* }"
      fi
    fi
    # 0.48.0 codex round-5/7/9 — the cache key incorporates a hash of
    # every `*.js` file's mtime across the FULL dist tree, not just
    # dist/cli/. Pre-round-9 the hash covered only dist/cli/*.js, but
    # `rea hook` actually executes a much larger module graph:
    # dist/cli/hook.js imports ../hooks/**, ../policy/loader.js,
    # ../audit/**, etc. A same-session rebuild that rewrote one of
    # those imported files in place without touching a top-level
    # dist/cli/*.js file would leave the hash unchanged, the warm
    # cache would survive, and shim_run would skip the version probe
    # against a changed CLI runtime. Hashing dist/**/*.js closes the
    # gap. Cost: ~15ms on the rea dist (141 files) via `find -exec
    # stat +` batched into a single subprocess call.
    local _dist_root=""
    # dist root is two parents above dist/cli/index.js
    _dist_root=$(dirname "$(dirname "$RESOLVED_CLI_PATH")" 2>/dev/null || true)
    if [ -n "$_dist_root" ] && [ -d "$_dist_root" ]; then
      # 0.48.0 codex round-6 P2: pick a hasher that exists. macOS
      # ships `shasum` (perl); GNU coreutils provides `sha256sum`.
      local _hasher=""
      if command -v shasum >/dev/null 2>&1; then
        _hasher="shasum -a 256"
      elif command -v sha256sum >/dev/null 2>&1; then
        _hasher="sha256sum"
      fi
      if [ -n "$_hasher" ]; then
        # 0.48.0 codex round-7 P2: ns-precision mtime so a
        # same-second rewrite is caught. Try macOS `-f` form first;
        # fall through to GNU `-c` on failure. `find -exec stat +`
        # batches all paths into ONE stat call (~15ms total instead
        # of the per-file 365ms loop).
        local _stat_macos=""
        local _stat_gnu=""
        _stat_macos=$(find "$_dist_root" -name '*.js' -type f -exec stat -f "%Fm %z %N" {} + 2>/dev/null || true)
        if [ -n "$_stat_macos" ]; then
          _shim_cache_dist_mtime=$(printf '%s' "$_stat_macos" | sort | $_hasher 2>/dev/null | awk '{print $1}' | cut -c1-32)
        else
          _stat_gnu=$(find "$_dist_root" -name '*.js' -type f -exec stat -c "%.Y %s %n" {} + 2>/dev/null || true)
          if [ -n "$_stat_gnu" ]; then
            _shim_cache_dist_mtime=$(printf '%s' "$_stat_gnu" | sort | $_hasher 2>/dev/null | awk '{print $1}' | cut -c1-32)
          fi
        fi
      fi
      # Last-ditch fallback: just the dist/cli/ dir mtime (round-3
      # behavior). Keeps the cache functional even when find / stat /
      # shasum / sha256sum are all unavailable (truly stripped
      # container) — though that's already the case where the cache
      # layer should fall back to disabled via the session token.
      if [ -z "$_shim_cache_dist_mtime" ]; then
        local _cli_dir=""
        _cli_dir=$(dirname "$RESOLVED_CLI_PATH" 2>/dev/null || true)
        if [ -n "$_cli_dir" ] && [ -d "$_cli_dir" ]; then
          local _dir_stat=""
          _dir_stat=$(shim_cache_mtime_size "$_cli_dir" 2>/dev/null || true)
          if [ -n "$_dir_stat" ]; then
            _shim_cache_dist_mtime="${_dir_stat%% *}"
          fi
        fi
      fi
    fi
    if [ -n "$_stat_out" ] && [ -n "$_shim_cache_cli_real" ] && [ -n "$_proj_real" ] \
       && [ -n "$_euid" ] && [ -n "$_session_tok" ] \
       && [ -n "$_shim_cache_pkg_real" ] && [ -n "$_shim_cache_pkg_mtime" ] \
       && [ -n "$_shim_cache_dist_mtime" ] \
       && [ -n "$_shim_cache_node_real" ] && [ -n "$_shim_cache_node_mtime" ]; then
      _shim_cache_cli_mtime="${_stat_out%% *}"
      _shim_cache_cli_size="${_stat_out##* }"
      # 0.48.0 codex round-1 P1: the key MUST include SHIM_NAME because
      # step 8's version probe is `rea hook $SHIM_NAME --help` — it's
      # hook-specific. Without SHIM_NAME in the key, a cache-warm shim
      # could let a sibling shim with the SAME (session, project, CLI,
      # mtime, size, euid, shape) skip its OWN version-skew check and
      # forward straight to a CLI that does not implement that hook
      # (realistic on a 0.32 CLI + newer secret-scanner shim mismatch).
      #
      # 0.48.0 codex round-3 P1+P2: 3 new key fields cover (a) ancestor
      # package.json mtime/size — invalidates if the rea package.json
      # is renamed or its `name` field is edited; (b) dist/cli/ dir
      # mtime — invalidates when any file in that directory is
      # added/removed (most fresh `tsc` rebuilds do both); (c) the
      # package.json realpath is implicitly part of the key via these
      # mtime/size fields plus the project realpath above.
      _shim_cache_key=$(shim_cache_key "v1" "$_session_tok" "$_proj_real" "$_shim_cache_cli_real" \
                                       "$_shim_cache_cli_mtime" "$_shim_cache_cli_size" "$_euid" \
                                       "$SHIM_ENFORCE_CLI_SHAPE" "$SHIM_NAME" \
                                       "$_shim_cache_pkg_mtime" "$_shim_cache_pkg_size" \
                                       "$_shim_cache_dist_mtime" \
                                       "$_shim_cache_node_real" "$_shim_cache_node_mtime" \
                                       2>/dev/null || true)
      if [ -n "$_shim_cache_key" ]; then
        local _cache_json=""
        _cache_json=$(shim_cache_read "$_shim_cache_key" 2>/dev/null || true)
        if [ -n "$_cache_json" ]; then
          # Parse + validate the entry. Failure → treat as miss.
          local _cache_validate=""
          _cache_validate=$(node -e '
            try {
              const e = JSON.parse(process.argv[1]);
              const now = Math.floor(Date.now() / 1000);
              const ttl = Number(e.ttl_seconds);
              const cachedAt = Number(e.cached_at_unix);
              const cliMtime = String(e.cli_mtime);
              const cliSize = String(e.cli_size_bytes);
              const cliReal = String(e.cli_realpath);
              const pkgMtime = String(e.pkg_mtime);
              const pkgSize = String(e.pkg_size_bytes);
              const distMtime = String(e.dist_mtime);
              const sandboxOk = e.sandbox_ok === true;
              const shapeOk = e.shape_ok === true;
              if (e.schema_version !== "v1") process.exit(1);
              if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 3600) process.exit(1);
              if (!Number.isFinite(cachedAt)) process.exit(1);
              if ((cachedAt + ttl) < now) process.exit(1);
              if (cliMtime !== process.argv[2]) process.exit(1);
              if (cliSize !== process.argv[3]) process.exit(1);
              if (cliReal !== process.argv[4]) process.exit(1);
              // 0.48.0 codex round-3 P1+P2: re-check the package.json
              // mtime/size and the dist/cli/ dir mtime in addition to
              // the CLI itself. Defense-in-depth against an entry
              // whose key happened to collide but whose disk state
              // has drifted.
              if (pkgMtime !== process.argv[5]) process.exit(1);
              if (pkgSize !== process.argv[6]) process.exit(1);
              if (distMtime !== process.argv[7]) process.exit(1);
              // 0.48.0 codex round-4 P1: re-check the resolved node
              // binary realpath + mtime. A same-session interpreter
              // swap (nvm use, volta pin) would otherwise let the
              // warm entry silently forward through a different node.
              const nodeReal = String(e.node_realpath);
              const nodeMtime = String(e.node_mtime);
              if (nodeReal !== process.argv[8]) process.exit(1);
              if (nodeMtime !== process.argv[9]) process.exit(1);
              if (!sandboxOk || !shapeOk) process.exit(1);
              process.stdout.write("ok");
            } catch (e) { process.exit(1); }
          ' -- "$_cache_json" "$_shim_cache_cli_mtime" "$_shim_cache_cli_size" "$_shim_cache_cli_real" "$_shim_cache_pkg_mtime" "$_shim_cache_pkg_size" "$_shim_cache_dist_mtime" "$_shim_cache_node_real" "$_shim_cache_node_mtime" 2>/dev/null || true)
          if [ "$_cache_validate" = "ok" ]; then
            _shim_cache_hit=1
          fi
        fi
      fi
    fi
  fi

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
  local node_missing=0
  if [ "${#REA_ARGV[@]}" -gt 0 ] && [ "$_shim_cache_hit" -eq 0 ]; then
    if ! command -v node >/dev/null 2>&1; then
      # 0.38.1 round-2 P2 fix: pre-fix this branch exited 0/2 IMMEDIATELY
      # without ever calling shim_policy_short_circuit, so a blocking-
      # tier shim whose policy said "disabled" still refused when node
      # was absent (which contradicts the pre-port body's no-op-on-
      # disabled posture). Clear REA_ARGV here so Tier 1 (rea CLI)
      # can't fire — the policy reader degrades to Tier 2 (python3) /
      # Tier 3 (awk), neither of which needs node. Track node-missing
      # separately so the CLI-required branch below can emit the right
      # banner if the policy did NOT short-circuit us out.
      node_missing=1
      REA_ARGV=()
    else
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
  fi

  # 6. Policy short-circuit. Runs BEFORE the CLI-missing / node-missing
  #    banners so a shim whose policy says "disabled" exits 0 cleanly
  #    even when the CLI is unbuilt OR node is absent (matches the
  #    pre-port body's no-op-on-disabled posture). The policy reader's
  #    4-tier ladder produces correct answers when REA_ARGV is empty:
  #    falls back to Tier 2 python3 if available, or Tier 3 awk
  #    (block-form only) otherwise.
  if declare -F shim_policy_short_circuit >/dev/null 2>&1; then
    if shim_policy_short_circuit; then
      exit 0
    fi
  fi

  # 6b. node-missing fail branch — only fires if shim_policy_short_circuit
  #     did NOT exit us out above. Emits the dedicated node-missing
  #     banner for blocking-tier; advisory-tier exits 0 silently.
  if [ "$node_missing" -eq 1 ]; then
    if [ "$SHIM_FAIL_OPEN" -eq 1 ]; then
      exit 0
    fi
    shim_emit_node_missing_banner
    exit 2
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
  #    on every Agent/Skill dispatch). Also skipped on cache hit — the
  #    probe answer was recorded when the entry was written and the
  #    cache key invalidates if mtime / size / realpath changes.
  if [ "$SHIM_SKIP_VERSION_PROBE" -eq 0 ] && [ "$_shim_cache_hit" -eq 0 ]; then
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

  # 8b. Cache write (0.48.0). At this point sandbox + probe both
  #     succeeded — record the answers for the next fire in this
  #     session. Cache write failure NEVER blocks the gate; we ignore
  #     the return value. Skipped on a cache hit (we just used the
  #     entry; rewriting it would be wasted work AND would refresh
  #     `cached_at_unix` past the TTL ceiling, defeating the staleness
  #     bound).
  if [ "$_shim_cache_hit" -eq 0 ] && [ -n "$_shim_cache_key" ]; then
    local _write_payload=""
    _write_payload=$(node -e '
      const args = process.argv.slice(1);
      const now = Math.floor(Date.now() / 1000);
      const entry = {
        schema_version: "v1",
        cli_realpath: args[0],
        cli_mtime: args[1],
        cli_size_bytes: args[2],
        // 0.48.0 codex round-3 P1+P2: record the ancestor package.json
        // mtime/size + dist/cli/ dir mtime so the read-side validator
        // can re-check them on every hit. The cache key includes
        // these too, so a drifted state produces a different key —
        // but persisting them in the entry lets the validator catch
        // a key collision as a stale-entry miss instead of trusting
        // it.
        pkg_mtime: args[3],
        pkg_size_bytes: args[4],
        dist_mtime: args[5],
        // 0.48.0 codex round-4 P1: record the resolved node binary
        // realpath + mtime so the read-side validator can re-check
        // them and refuse a hit when the interpreter swapped.
        node_realpath: args[6],
        node_mtime: args[7],
        sandbox_ok: true,
        shape_ok: true,
        cached_at_unix: now,
        ttl_seconds: 3600,
      };
      process.stdout.write(JSON.stringify(entry));
    ' -- "$_shim_cache_cli_real" "$_shim_cache_cli_mtime" "$_shim_cache_cli_size" "$_shim_cache_pkg_mtime" "$_shim_cache_pkg_size" "$_shim_cache_dist_mtime" "$_shim_cache_node_real" "$_shim_cache_node_mtime" 2>/dev/null || true)
    if [ -n "$_write_payload" ]; then
      shim_cache_write "$_shim_cache_key" "$_write_payload" >/dev/null 2>&1 || true
    fi
  fi

  # 9. Forward stdin.
  if declare -F shim_forward >/dev/null 2>&1; then
    shim_forward
  else
    shim_default_forward
  fi
}
