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
_shim_try_cli_root() {
  # Attempt the 2-tier in-project resolution against one root. Sets
  # REA_ARGV / RESOLVED_CLI_PATH / CLI_RESOLVE_ROOT on success.
  local _r="$1"
  if [ -f "$_r/node_modules/@bookedsolid/rea/dist/cli/index.js" ]; then
    REA_ARGV=(node "$_r/node_modules/@bookedsolid/rea/dist/cli/index.js")
    RESOLVED_CLI_PATH="$_r/node_modules/@bookedsolid/rea/dist/cli/index.js"
    CLI_RESOLVE_ROOT="$_r"
    return 0
  elif [ -f "$_r/dist/cli/index.js" ]; then
    REA_ARGV=(node "$_r/dist/cli/index.js")
    RESOLVED_CLI_PATH="$_r/dist/cli/index.js"
    CLI_RESOLVE_ROOT="$_r"
    return 0
  fi
  return 1
}

shim_resolve_cli() {
  REA_ARGV=()
  RESOLVED_CLI_PATH=""
  CLI_RESOLVE_ROOT="$proj"
  # Rounds 19+21 (0.54.0 worktree state): the ACCEPTED enforcement root
  # (REA_ROOT — the worktree the session actually works in) resolves
  # FIRST, so branch B's hooks run branch B's CLI even when the primary
  # checkout also has an install; the primary is the fallback for
  # worktrees without their own node_modules/dist. The sandbox
  # containment check below runs against CLI_RESOLVE_ROOT — the root
  # the CLI was actually resolved from — so both tiers get identical
  # escape/realpath vetting.
  if [ -n "${REA_ROOT:-}" ] && [ "$REA_ROOT" != "$proj" ] && [ -d "${REA_ROOT}/.rea" ]; then
    _shim_try_cli_root "$REA_ROOT" && return 0
  fi
  _shim_try_cli_root "$proj" && return 0
  # Round-25 P2: after a sibling handoff (worktree A anchor → payload
  # worktree B) neither B nor A may carry an install when only the
  # PRIMARY checkout is built — the repository's common root is the
  # last in-project tier before cli-missing / the global tier.
  if [ -n "${REA_ROOT:-}" ]; then
    _shim_common_cli_root=$(rea_common_root "$REA_ROOT")
    if [ -n "$_shim_common_cli_root" ] \
       && [ "$_shim_common_cli_root" != "$proj" ] \
       && [ "$_shim_common_cli_root" != "$REA_ROOT" ] \
       && [ -d "${_shim_common_cli_root}/.rea" ]; then
      _shim_try_cli_root "$_shim_common_cli_root" && return 0
    fi
  fi
  return 0
}

# -----------------------------------------------------------------------------
# Realpath sandbox check — validates the resolved CLI:
#   1. realpath(CLI) lives INSIDE realpath(CLAUDE_PROJECT_DIR)
#   2. an ancestor package.json has `name`=`@bookedsolid/rea`
#   3. (when SHIM_ENFORCE_CLI_SHAPE=1) realpath ends in dist/cli/index.js
#
# Echoes "ok:<realpath>" on success or "bad:<reason>" on failure.
# Callers branch on the `ok:` prefix (bash 3.2: `case "$x" in ok:*)`)
# and use the realpath tail for realpath-exec (shim_run step 4a). The
# realpath is the same fs.realpathSync the sandbox already computed, so
# executing it shrinks the TOCTOU window to the in-place-swap residual
# the in-project tier already carries — it is NOT a same-inode
# guarantee (a rename-swap of the realpath after validation remains
# possible).
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
    // TOCTOU precursor: emit the validated realpath so the caller can
    // execute it instead of the literal (possibly-symlinked) cli path.
    // `real` is the fs.realpathSync(cli) computed at the top of this
    // program. The `bad:<reason>` outputs above are byte-unchanged.
    process.stdout.write("ok:" + real);
  ' -- "$cli_path" "$proj_dir" "$enforce_shape" 2>/dev/null
}

# -----------------------------------------------------------------------------
# Global tier — A5 entry gate (registry ∧ membership) + resolve. 0.49.0
# Phase 1b. Derives the per-user trust root from the PASSWORD DATABASE
# (os.userInfo().homedir → libuv getpwuid_r), NEVER from $HOME / $XDG_* —
# an agent can set those in-process, so an env-derived root is the N3
# redirect surface this tier closes. A trust root an agent can move is not
# a trust root.
#
# Registry-ONLY (codex design-gate P1-1): NO policy read in this pre-CLI
# window. policy.yaml is NOT scanner-protected while no CLI is resolved, so
# the optional `allow_global_cli` veto lands POST-resolution in a later
# phase (registry can only ENABLE; policy can only further-RESTRICT — the
# asymmetry holds).
#
# Every A5 / registry-unusable / not-installed condition prints
# "unavailable" (codex P1-3: SILENT in the hot path — an un-blessed
# checkout MUST stay byte-identical to feature-absent; a loud
# `bad:global-registry-*` banner would perturb every CLI-less checkout via
# shared per-user state). Loud diagnosis lives only in `rea doctor`.
#
# Output:
#   success → "<candidate_path>\n<g_root_path>" (literal probed paths)
#   else    → "unavailable"
#
# Args: $1 — CLAUDE_PROJECT_DIR (agent-controllable; spoofing only causes
#            the TRUSTED global CLI to run — A5 is a consent gate, not a
#            containment gate).
# -----------------------------------------------------------------------------
shim_global_entry_gate() {
  local proj_dir="$1"
  node -e '
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const projDir = process.argv[1];
    function unavailable() { process.stdout.write("unavailable"); process.exit(0); }
    // A5.1 — passwd-derived home. NEVER $HOME / $XDG_*.
    let pwDir;
    try { pwDir = os.userInfo().homedir; } catch (e) { unavailable(); }
    if (!pwDir || typeof pwDir !== "string" || pwDir.charAt(0) !== "/") unavailable();
    const euid = process.geteuid();
    const reaDir = path.join(pwDir, ".rea");
    const gRoot = path.join(reaDir, "cli");
    const registry = path.join(reaDir, "trusted-projects");
    // A5.3a — validate <pw_dir>/.rea (lstat; never lstat pwDir or above:
    // firmlinks / BSD /home symlinks legitimately exist there).
    let rs;
    try { rs = fs.lstatSync(reaDir); } catch (e) { unavailable(); }
    if (rs.isSymbolicLink() || !rs.isDirectory()) unavailable();
    if (rs.uid !== euid) unavailable();
    if ((rs.mode & 0o022) !== 0) unavailable();
    // A5.3b — validate the registry file: regular, not a symlink, owner,
    // strict 0600 mask (NOT the 0o022 dir mask), single link (codex P2-7:
    // a hardlinked registry is a same-uid mutation primitive).
    let regs;
    try { regs = fs.lstatSync(registry); } catch (e) { unavailable(); }
    if (regs.isSymbolicLink() || !regs.isFile()) unavailable();
    if (regs.uid !== euid) unavailable();
    if ((regs.mode & 0o077) !== 0) unavailable();
    if (regs.nlink !== 1) unavailable();
    // A5.4 — project realpath (same resolution the writer anchors trust on).
    let projReal;
    try { projReal = fs.realpathSync(projDir); } catch (e) { unavailable(); }
    // A5.5 — membership: fixed-string, full-line match (grep -Fxq). No
    // parser ever (membership is decided pre-CLI-resolution); comment/blank
    // lines are inert because realpath queries start with "/".
    let content;
    try { content = fs.readFileSync(registry, "utf8"); } catch (e) { unavailable(); }
    const lines = content.split("\n");
    let member = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] === projReal) { member = true; break; }
    }
    if (!member) unavailable();
    // Resolve — probe (1) node_modules shape then (2) bare-drop fallback.
    const c1 = path.join(gRoot, "node_modules", "@bookedsolid", "rea", "dist", "cli", "index.js");
    const c2 = path.join(gRoot, "dist", "cli", "index.js");
    let cand = "";
    if (fs.existsSync(c1)) cand = c1;
    else if (fs.existsSync(c2)) cand = c2;
    if (!cand) unavailable(); // blessed-but-not-installed
    process.stdout.write(cand + "\n" + gRoot);
  ' -- "$proj_dir" 2>/dev/null
}

# -----------------------------------------------------------------------------
# Global tier — A1–A4 sandbox over a resolved candidate. 0.49.0 Phase 1b.
# Echoes "ok:<realpath>" on success (consistent with shim_sandbox_check),
# "bad:global-<reason>" on a fatal tier failure (blessed-but-hostile tree),
# or "unavailable" when realpath throws (ENOENT / automount — NOT a
# refusal). Evaluation order is cheapest/most-decisive first.
#
#   A2  per-component lstat walk from the candidate UP to AND INCLUDING
#       <rea_dir> (= dirname(g_root)); STOP there (never lstat pw_dir or
#       above). Rejects ANY symlink component (an inside-pointing symlink
#       is still a same-uid repoint primitive), foreign owner, group/other
#       write, OR a device-number change vs g_root (mount/bind/automount
#       aliasing, codex P2-6). The candidate index.js must have nlink===1
#       (codex P2-7).
#   A1  realpath(candidate) contained in realpath(g_root).
#   A4  realpath ends sep+"dist/cli/index.js" — ALWAYS-on for global,
#       independent of SHIM_ENFORCE_CLI_SHAPE.
#   A3  ancestor package.json#name==="@bookedsolid/rea" (walk ≤20); that
#       package.json must also have nlink===1.
#
# Args:
#   $1 — candidate CLI path (literal, as probed)
#   $2 — g_root (<pw_dir>/.rea/cli)
# -----------------------------------------------------------------------------
shim_sandbox_check_global() {
  local cand="$1"
  local g_root="$2"
  node -e '
    const fs = require("fs");
    const path = require("path");
    const cand = process.argv[1];
    const gRoot = process.argv[2];
    function bad(r) { process.stdout.write("bad:global-" + r); process.exit(1); }
    function unavailable() { process.stdout.write("unavailable"); process.exit(1); }
    function ok(r) { process.stdout.write("ok:" + r); process.exit(0); }
    const euid = process.geteuid();
    const reaDir = path.dirname(gRoot); // walk stops here; never above
    const sep = path.sep;
    // Capture g_root device number for the mount/bind aliasing check.
    let gRootDev;
    try { gRootDev = fs.lstatSync(gRoot).dev; } catch (e) { unavailable(); }
    // A2 — per-component lstat walk: candidate UP to AND INCLUDING reaDir.
    let comp = cand;
    let first = true;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 128) bad("perm"); // pathological depth — fail to tier
      let st;
      try { st = fs.lstatSync(comp); } catch (e) { unavailable(); }
      if (st.isSymbolicLink()) bad("symlink");
      if (st.uid !== euid) bad("perm");
      if ((st.mode & 0o022) !== 0) bad("perm");
      if (st.dev !== gRootDev) bad("perm");
      if (first) {
        // The candidate (index.js) must be a single-link regular file.
        if (st.nlink !== 1) bad("hardlink");
        first = false;
      }
      if (comp === reaDir) break;
      const parent = path.dirname(comp);
      if (parent === comp) break; // reached fs root without reaDir
      comp = parent;
    }
    // A1 — realpath containment.
    let real, realRoot;
    try { real = fs.realpathSync(cand); } catch (e) { unavailable(); }
    try { realRoot = fs.realpathSync(gRoot); } catch (e) { unavailable(); }
    const rootSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (!(real === realRoot || real.startsWith(rootSep))) bad("escapes-root");
    // A4 — dist/cli/index.js shape (ALWAYS-on for global).
    const endWith = path.join("dist", "cli", "index.js");
    if (!(real.endsWith(sep + endWith) || real === sep + endWith)) bad("shape");
    // A3 — ancestor package.json with the rea name + nlink===1.
    let cur = path.dirname(path.dirname(path.dirname(real)));
    let pkg = "";
    for (let i = 0; i < 20 && cur && cur !== path.dirname(cur); i += 1) {
      const pj = path.join(cur, "package.json");
      if (fs.existsSync(pj)) {
        try {
          const data = JSON.parse(fs.readFileSync(pj, "utf8"));
          if (data && data.name === "@bookedsolid/rea") { pkg = pj; break; }
        } catch (e) { /* keep walking */ }
      }
      cur = path.dirname(cur);
    }
    if (!pkg) bad("no-rea-pkg");
    let ps;
    try { ps = fs.lstatSync(pkg); } catch (e) { bad("no-rea-pkg"); }
    if (ps.nlink !== 1) bad("hardlink");
    ok(real);
  ' -- "$cand" "$g_root" 2>/dev/null
}

# -----------------------------------------------------------------------------
# Global tier resolver. Called by shim_run ONLY when the in-project tiers
# missed (in-project ALWAYS wins; the registry is NEVER consulted when an
# in-project CLI resolved). On success sets REA_ARGV + RESOLVED_CLI_PATH +
# TRUST_TIER=global + _SHIM_GLOBAL_G_ROOT; on a fatal A1–A4 failure sets
# _SHIM_GLOBAL_BAD_REASON; on a silent A5 / registry / resolve miss leaves
# everything empty (byte-identical to feature-absent).
# -----------------------------------------------------------------------------
shim_resolve_cli_global() {
  _SHIM_GLOBAL_BAD_REASON=""
  _SHIM_GLOBAL_G_ROOT=""
  # node is required for passwd derivation + lstat walk + realpath. No node
  # → tier silently unavailable (same terminal as feature-absent).
  command -v node >/dev/null 2>&1 || return 0
  local gate=""
  # Round-22 P1 (0.54.0 worktree state): the trust registry's exact-path
  # membership check runs against the ACTIVE enforcement root — the
  # worktree actually executing the hook — not the pinned primary
  # checkout. A trusted primary must not authorize the global CLI
  # inside an untrusted worktree, and a worktree trusted via
  # `rea trust` must not fail closed just because the primary was
  # never trusted. Mirrors the shim_resolve_cli tier order.
  local _trust_root="$proj"
  if [ -n "${REA_ROOT:-}" ] && [ "$REA_ROOT" != "$proj" ] && [ -d "${REA_ROOT}/.rea" ]; then
    _trust_root="$REA_ROOT"
  fi
  gate=$(shim_global_entry_gate "$_trust_root" 2>/dev/null)
  case "$gate" in
    unavailable|"") return 0 ;; # silent A5 / registry / resolve miss
  esac
  # Success form is "<candidate>\n<g_root>". Parse the two lines (bash 3.2:
  # ANSI-C $'\n' parameter-expansion trim — no `mapfile`).
  local candidate="" g_root=""
  candidate="${gate%%$'\n'*}"
  g_root="${gate#*$'\n'}"
  # Defensive: both must be non-empty absolute paths; else treat as silent.
  case "$candidate" in /*) ;; *) return 0 ;; esac
  case "$g_root" in /*) ;; *) return 0 ;; esac
  local result=""
  result=$(shim_sandbox_check_global "$candidate" "$g_root" 2>/dev/null)
  case "$result" in
    ok:*)
      local real=""
      real="${result#ok:}"
      REA_ARGV=(node "$real")
      RESOLVED_CLI_PATH="$real"
      TRUST_TIER="global"
      _SHIM_GLOBAL_G_ROOT="$g_root"
      ;;
    bad:*)
      _SHIM_GLOBAL_BAD_REASON="$result"
      ;;
    *)
      # "unavailable" (realpath threw) — silent, parity preserved.
      ;;
  esac
}

# -----------------------------------------------------------------------------
# Global-tier veto decision (0.50.0 Phase 2b). The A5 registry gate can only
# ENABLE the per-user global CLI; a project's OWN policy may further-RESTRICT
# it via `runtime.allow_global_cli` — the enable/restrict asymmetry the design
# turns on. This is the SINGLE source of truth for that decision, shared by
# BOTH shim_run (step-4-global-veto) and local-review-gate.sh (push/commit
# gate), so the 14 shims and the push gate cannot drift.
#
# Reads the veto THROUGH the sandbox-validated REA_ARGV CLI (the exact trust
# level shim_policy_short_circuit relies on post-sandbox). MUST be called ONLY
# when TRUST_TIER=global — that guarantees REA_ARGV is the non-empty validated
# global CLI, so "${REA_ARGV[@]}" is safe under set -u.
#
# TWO-STEP + TYPE-STRICT + fail-closed on malformed config. `rea hook
# policy-get` only PARSES YAML — it does NOT run the strict zod schema
# loadPolicy() / `rea doctor` apply, so ANY shape the strict loader would
# REJECT must never silently ENABLE the tier:
#
#   1. Read the PARENT `runtime` block (policy-get runtime --json). Verified
#      shapes against the built CLI:
#        runtime: {allow_global_cli: …} → {"allow_global_cli":…}  (valid object)
#        runtime: []                    → []                       (malformed)
#        runtime: "off"                 → "off"                    (malformed)
#        runtime: 42                    → 42                        (malformed)
#        runtime absent                 → null
#        malformed YAML                 → null, exit 1
#      Classify:
#        non-zero exit                  → fail-closed VETO
#        null                           → runtime absent → ALLOW
#        starts with `{`                → valid object → step 2
#        anything else ([, ", number …) → malformed runtime block → fail-closed VETO
#   2. Read the LEAF `runtime.allow_global_cli --json` (TYPE-PRESERVING: JSON
#      boolean `true` vs the string `"true"` vs `null`):
#        non-zero exit                  → fail-closed VETO
#        true                           → ALLOW
#        null                           → allow_global_cli absent → ALLOW
#        anything else (false, "true", "yes", garbage) → VETO
#
# Return: 0 = VETO (refuse the global tier), 1 = ALLOW (proceed).
# -----------------------------------------------------------------------------
shim_global_tier_vetoed() {
  local _rt_out="" _rt_status=0
  _rt_out=$("${REA_ARGV[@]}" hook policy-get runtime --json 2>/dev/null); _rt_status=$?
  if [ "$_rt_status" -ne 0 ]; then
    return 0  # policy-get errored / unparseable policy → fail-closed veto
  fi
  case "$_rt_out" in
    null)
      return 1  # runtime block absent → allow
      ;;
    '{'*)
      # Valid OBJECT — but the strict loader (`.strict()`) also rejects a
      # runtime block carrying any key OUTSIDE its schema (e.g.
      # `runtime: { allow_global_cli: true, typo: 1 }` or `{ typo: 1 }`).
      # `policy-get` only PARSES YAML; it does NOT run the strict schema, so
      # without this an unknown-key block would fall through to the leaf
      # read and ENABLE the tier even though `loadPolicy()` would refuse the
      # whole policy. The veto contract is to fail closed on any shape the
      # strict loader would reject (codex #211 review P1). Reject any key
      # beyond the RuntimePolicySchema allowlist. MUST stay in sync with
      # `RuntimePolicySchema` in `src/policy/loader.ts` — currently the sole
      # permitted key is `allow_global_cli`. node is guaranteed here (the
      # global tier already required it to resolve).
      local _rt_shape=""
      _rt_shape=$(printf '%s' "$_rt_out" | node -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c)).on("end", () => {
          try {
            const o = JSON.parse(d);
            if (!o || typeof o !== "object" || Array.isArray(o)) {
              process.stdout.write("bad"); return;
            }
            const allowed = new Set(["allow_global_cli"]);
            for (const k of Object.keys(o)) {
              if (!allowed.has(k)) { process.stdout.write("extra"); return; }
            }
            process.stdout.write("ok");
          } catch { process.stdout.write("bad"); }
        });
      ' 2>/dev/null || printf 'bad')
      if [ "$_rt_shape" != "ok" ]; then
        return 0  # unknown key / unparseable object → strict loader rejects → veto
      fi
      ;;
    *)
      # runtime present with the WRONG TYPE ([], "off", 42, …) — a shape the
      # strict loader REJECTS. Fail closed rather than ENABLE the tier.
      return 0
      ;;
  esac
  local _av_out="" _av_status=0
  _av_out=$("${REA_ARGV[@]}" hook policy-get runtime.allow_global_cli --json 2>/dev/null); _av_status=$?
  if [ "$_av_status" -ne 0 ]; then
    return 0  # fail-closed veto
  fi
  case "$_av_out" in
    true|null) return 1 ;;  # JSON boolean true, or null (allow_global_cli absent) → allow
    *) return 0 ;;          # false | "true" | "yes" | any string / garbage → fail-closed veto
  esac
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

# Global tier — one-line advisory when a BLESSED project resolves a global
# CLI tree that fails A1–A4 (hostile/malformed). Never fired by an
# un-blessed project (which degrades silently), so it cannot perturb the
# feature-absent parity surface.
shim_emit_global_tier_banner() {
  local reason="$1"
  printf 'rea: %s — global rea CLI tier rejected (%s); falling back to no-CLI.\n' "$SHIM_NAME" "$reason" >&2
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
# 0.54.0 worktree state — payload-root handoff (round-23 P1: extracted
# from shim_run so local-review-gate.sh, the one shim that bypasses the
# orchestrator, applies the SAME guarded ladder). Reads $INPUT; may
# rewrite REA_ROOT (exported) and proj; exits 2 on a HALT discovered at
# the accepted root. Call after INPUT is captured and before any
# policy read or CLI resolution.
# -----------------------------------------------------------------------------
# Round-43 P2: canonical directory spelling for same-repo comparisons —
# /var vs /private/var (macOS) or a symlinked checkout path must not
# classify a repo's own worktree as foreign. `cd && pwd -P` is the
# portable realpath; failure keeps the input verbatim.
_rea_canon_dir() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
}

shim_worktree_handoff() {
  # 2b. 0.54.0 worktree state: once the payload is in hand, re-derive
  #     REA_ROOT from its top-level `cwd` when that resolves to a
  #     directory that actually carries `.rea/` — the same guarded
  #     ladder the Node tier uses (`resolveHookRoots`). In a Claude
  #     worktree session CLAUDE_PROJECT_DIR pins the PRIMARY checkout,
  #     so without this every bash-tier policy read (policy-read.sh /
  #     policy-reader.sh honor a pre-set REA_ROOT) would consult the
  #     wrong worktree's policy. Guards: a REAL JSON parser present
  #     (round-32 P1: jq → python3 → node — never a regex scrape, which
  #     an embedded '"cwd":"..."' inside tool_input.command could
  #     spoof into pointing enforcement at a hostile root), cwd
  #     non-empty, `.rea/` exists at the resolved root — any miss
  #     keeps the halt-check-derived REA_ROOT (plain-checkout
  #     behavior).
  _payload_cwd=""
  if command -v jq >/dev/null 2>&1; then
    _payload_cwd=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    _payload_cwd=$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    c = d.get("cwd") if isinstance(d, dict) else None
    sys.stdout.write(c if isinstance(c, str) else "")
except Exception:
    pass
' 2>/dev/null || true)
  elif command -v node >/dev/null 2>&1; then
    _payload_cwd=$(printf '%s' "$INPUT" | node -e '
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  try {
    const d = JSON.parse(raw);
    if (d !== null && typeof d === "object" && typeof d.cwd === "string") {
      process.stdout.write(d.cwd);
    }
  } catch {}
});
' 2>/dev/null || true)
  fi
  if [ -n "$_payload_cwd" ]; then
    if [ -d "$_payload_cwd" ]; then
      _payload_root="$_payload_cwd"
      while [ "$_payload_root" != "/" ]; do
        if [ -d "${_payload_root}/.rea" ]; then
          # Round-8 P1: SAME-REPOSITORY pin (mirrors resolveHookRoots).
          # A payload root from a FOREIGN rea-managed repo must not
          # replace the session anchor — a `cd` into repo B mid-session
          # would otherwise enforce B's policy in the pre-CLI
          # short-circuits and silently disable A's gates. Worktrees of
          # the same repo share a common root and still qualify.
          # The pin only applies when the anchor is itself a rea root —
          # with no rea-rooted anchor the payload IS the session repo
          # (mirrors the Node ladder's no-anchor acceptance).
          _stale_anchor=0
          if [ -d "${REA_ROOT}/.rea" ]; then
            _anchor_common=$(_rea_canon_dir "$(rea_common_root "$REA_ROOT")")
            _payload_common=$(_rea_canon_dir "$(rea_common_root "$_payload_root")")
            if [ "$_payload_common" != "$_anchor_common" ] \
               && [ "$(_rea_canon_dir "$_payload_root")" != "$(_rea_canon_dir "$REA_ROOT")" ]; then
              # Round-18 P1: before pinning to the anchor, test whether
              # the anchor is STALE — a shell that still exports repo
              # A's REA_ROOT/CLAUDE_PROJECT_DIR while the process is
              # physically running in the payload's repository. Live
              # Claude sessions run hooks with cwd = the project dir
              # (cwd agrees with the anchor), so a physical cwd whose
              # .rea root shares the payload's common root means the
              # payload IS the session repo — hand over instead of
              # enforcing repo A's policy against repo B's files.
              _phys_root=$(pwd -P 2>/dev/null || pwd)
              while [ -n "$_phys_root" ] && [ "$_phys_root" != "/" ]; do
                [ -d "${_phys_root}/.rea" ] && break
                _phys_root=$(dirname "$_phys_root")
              done
              if [ -d "${_phys_root}/.rea" ] \
                 && [ "$(_rea_canon_dir "$(rea_common_root "$_phys_root")")" = "$_payload_common" ]; then
                _stale_anchor=1
              else
                break
              fi
            fi
            # (The round-9 sibling pin — a worktree-anchored session
            # keeping its anchor against a SAME-repo sibling payload —
            # was removed in round-19 P1: relative paths resolve
            # against the worktree the command physically runs in, so
            # the payload worktree must win; the anchor's own governed
            # state stays protected via the sibling cross-root
            # coverage in the Node scanners.)
          fi
          # REA_ROOT (policy reads) follows the payload. `proj` (the
          # CLI-resolution sandbox) stays on CLAUDE_PROJECT_DIR when the
          # anchor is a rea repo — the primary checkout may be the only
          # one with node_modules installed — but when the session had
          # NO rea-rooted anchor at all (round-15 P2), the payload repo
          # IS the session root and CLI resolution must search there,
          # or every shim reports the CLI missing in the exact shape
          # this handoff supports.
          if [ ! -d "${REA_ROOT}/.rea" ] || [ "$_stale_anchor" = "1" ]; then
            proj="$_payload_root"
          fi
          REA_ROOT="$_payload_root"
          # Exported so `rea hook policy-get` (spawned by the policy
          # readers) resolves the same worktree policy this shim does.
          export REA_ROOT
          # Round-4 P2 + round-13 P1: the pre-stdin check_halt derived
          # its root from CLAUDE_PROJECT_DIR and cannot see a LEGACY
          # per-worktree HALT — and when the session started OUTSIDE any
          # .rea root it never probed this repository at all. Re-probe
          # BOTH the accepted root's local HALT and its repository
          # (common) HALT.
          _accepted_common=$(rea_common_root "$REA_ROOT")
          for _halt_probe in "${REA_ROOT}/.rea/HALT" "${_accepted_common}/.rea/HALT"; do
            if [ -f "$_halt_probe" ]; then
              printf 'REA HALT: %s\nAll agent operations suspended. Run: rea unfreeze\n' \
                "$(head -c 1024 "$_halt_probe" 2>/dev/null || echo 'Reason unknown')" >&2
              exit 2
            fi
            [ "$REA_ROOT" = "$_accepted_common" ] && break
          done
          break
        fi
        _payload_root=$(dirname "$_payload_root")
      done
    fi
  fi
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

  # 2b. Worktree payload-root handoff (shared with local-review-gate.sh).
  shim_worktree_handoff

  # 3. Relevance pre-gate. If the shim defined `shim_is_relevant`, call it.
  if declare -F shim_is_relevant >/dev/null 2>&1; then
    if ! shim_is_relevant; then
      exit 0
    fi
  fi

  # 4. Resolve CLI. In-project tiers ALWAYS win (byte-identical to today).
  shim_resolve_cli
  local TRUST_TIER="project"

  # 4-global (0.49.0 Phase 1b). ONLY when both in-project tiers missed do we
  # consult the opt-in global tier. Registry membership is the SOLE gate
  # (codex design-gate P1-1: NO policy read in this pre-CLI window). An
  # un-blessed project leaves REA_ARGV empty + emits nothing, so the no-CLI
  # terminal below is byte-identical to feature-absent. A5 + global
  # resolution complete (and TRUST_TIER is final) BEFORE the cache block at
  # step 4b builds its key — a HARD design invariant (codex P3-9): the
  # cache's trust_tier + registry mtime/size fields are only sound if the
  # live registry gate ran first.
  if [ "${#REA_ARGV[@]}" -eq 0 ]; then
    shim_resolve_cli_global
  fi

  # 4-global-veto (0.50.0 Phase 2b). OPTIONAL in-project veto over the global
  # tier, via the SHARED shim_global_tier_vetoed helper (single source of
  # truth for the decision — see its header for the two-step type-strict +
  # fail-closed-on-malformed logic). Runs ONLY when the global tier actually
  # resolved (TRUST_TIER=global ⇒ REA_ARGV is the sandbox-validated global
  # CLI, so the helper's "${REA_ARGV[@]}" reads are safe under set -u).
  #
  # Placement is deliberate: this sits BEFORE the step-4b cache block and
  # therefore fires on EVERY invocation, warm-cache fires included.
  # `runtime.allow_global_cli` is intentionally kept OUT of the cache key
  # (design memo) precisely so a mid-session edit adding
  # `allow_global_cli: false` is honored on the very NEXT fire instead of
  # surviving inside a warm entry. Gating this read behind the cache would
  # reintroduce exactly the stale-consent hole the key-omission avoids. It
  # also completes BEFORE the step-4b cache-key build, so TRUST_TIER is
  # still final when that key is constructed (extends the step-4 invariant).
  #
  # On veto: behave EXACTLY like "project not in registry" / no-CLI — clear
  # REA_ARGV, revert TRUST_TIER to project, and DO NOT set
  # _SHIM_GLOBAL_BAD_REASON. A veto is a legitimate project CHOICE, not a
  # security signal, so it stays SILENT — no bad:global-* advisory. The
  # existing step-7 relevance-gated no-CLI terminal then makes a vetoed
  # project byte-identical to an un-blessed / no-CLI project (harmless
  # payload → exit 0 silent; relevant payload on a blocking shim →
  # cli-missing banner + exit 2).
  if [ "$TRUST_TIER" = "global" ] && shim_global_tier_vetoed; then
    REA_ARGV=()
    TRUST_TIER="project"
  fi

  # 4a. Sandbox check (0.48.1 — moved earlier from step 5). Runs BEFORE
  #     the cache-key-prep block so the dist-tree `find` walk (added in
  #     0.48.0) never recurses an out-of-project symlink target. Pre-
  #     0.48.1 ordering was: cache prep → cache lookup → sandbox check;
  #     codex 0.48.0 round-10 P2 caught that a hostile workspace whose
  #     `node_modules/@bookedsolid/rea` (or `dist`) symlinks outside
  #     CLAUDE_PROJECT_DIR caused the find walk to traverse the external
  #     tree before step 5 refused at `bad:cli-escapes-project`. Moving
  #     sandbox earlier preserves the cheap-refusal posture the
  #     pre-0.48.0 hot path had.
  #
  #     Tradeoff vs 0.48.0: a warm cache hit no longer skips sandbox
  #     (pre-fix the `_shim_cache_hit` guard at this site bypassed it).
  #     Sandbox is a single `node -e` (~30ms warm) so the lost
  #     optimization is acceptable; the cache's primary win is skipping
  #     the version probe at step 8 (which is a full CLI spawn,
  #     materially more expensive).
  local sandbox_result=""
  local sandbox_failed=0
  local node_missing=0
  local real=""
  # 0.49.0 Phase 1b: gated on TRUST_TIER=project. The global tier already
  # ran its own A1–A4 sandbox (incl. the per-component lstat walk, st_dev,
  # nlink, realpath containment, and the always-on dist/cli/index.js shape)
  # inside shim_resolve_cli_global, and REA_ARGV already points at the
  # validated realpath. Re-running the IN-PROJECT check here would reject a
  # global CLI with bad:cli-escapes-project (it legitimately lives outside
  # CLAUDE_PROJECT_DIR). node was already required for the global resolve,
  # so the node-missing branch below is project-tier-only too.
  if [ "${#REA_ARGV[@]}" -gt 0 ] && [ "$TRUST_TIER" = "project" ]; then
    if ! command -v node >/dev/null 2>&1; then
      # 0.38.1 round-2 P2 fix: pre-fix this branch exited 0/2 IMMEDIATELY
      # without ever calling shim_policy_short_circuit, so a blocking-
      # tier shim whose policy said "disabled" still refused when node
      # was absent (which contradicts the pre-port body's no-op-on-
      # disabled posture). Clear REA_ARGV here so Tier 1 (rea CLI)
      # cannot fire — the policy reader degrades to Tier 2 (python3) /
      # Tier 3 (awk), neither of which needs node. Track node-missing
      # separately so the CLI-required branch below can emit the right
      # banner if the policy did NOT short-circuit us out.
      node_missing=1
      REA_ARGV=()
    else
      sandbox_result=$(shim_sandbox_check "$RESOLVED_CLI_PATH" "${CLI_RESOLVE_ROOT:-$proj}" "$SHIM_ENFORCE_CLI_SHAPE")
      # TOCTOU precursor: shim_sandbox_check now echoes `ok:<realpath>`
      # on success. Execute the VALIDATED realpath instead of the
      # literal RESOLVED_CLI_PATH so the version probe (step 8) and the
      # forward (step 9) run the exact path the sandbox vetted. This
      # shrinks the TOCTOU window to the same in-place-swap residual the
      # in-project tier already has — it is NOT a same-inode guarantee
      # (a rename-swap of the realpath after validation remains
      # possible). bash 3.2: `case` glob match, no `[[ =~ ]]`.
      case "$sandbox_result" in
        ok:*)
          real="${sandbox_result#ok:}"
          REA_ARGV=(node "$real")
          RESOLVED_CLI_PATH="$real"
          ;;
        *)
          # bad:<reason> — sandbox refused.
          sandbox_failed=1
          if [ "$SHIM_FAIL_OPEN" -eq 1 ]; then
            shim_emit_sandbox_skip_banner "$sandbox_result"
            exit 0
          fi
          # Blocking-tier: clear REA_ARGV so Tier-1 policy reads (in
          # shim_policy_short_circuit) degrade to Tier 2 / Tier 3 instead
          # of invoking the untrusted CLI.
          REA_ARGV=()
          ;;
      esac
    fi
  fi

  # 4b. Per-session cache lookup (0.48.0). When the cache is enabled
  #     AND the resolved CLI matches a recent same-session entry, the
  #     version probe (step 8) can be skipped — that answer does not
  #     change for a stable CLI inside a stable session. Cache MISS /
  #     disabled / corrupt → fall through to the existing uncached hot
  #     path. NEVER fail closed on a cache error (see
  #     hooks/_lib/shim-cache.sh header for the security contract). The
  #     cache check runs AFTER `shim_is_relevant` (per design memo
  #     concern #3) so we never pay a stat-per-fire cost for irrelevant
  #     payloads. 0.48.1: also runs AFTER step 4a sandbox check so the
  #     dist-tree hash walk never traverses a symlinked-out CLI tree.
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
  # 0.49.0 Phase 1b cache-key v2 fields.
  local _registry_mtime=""
  local _registry_size=""
  local _effective_shape="$SHIM_ENFORCE_CLI_SHAPE"
  # 0.48.1: gated on `sandbox_failed -eq 0` so a sandbox refusal
  # short-circuits BEFORE the dist-tree hash walk runs (was running
  # against a possibly-symlinked-out target pre-0.48.1).
  #
  # 0.48.1 round-1 P2-A: also gated on SHIM_SKIP_VERSION_PROBE -eq 0.
  # Skip-probe shims (delegation-advisory, delegation-capture) cannot
  # write a cache entry (the step-8b write block also gates on
  # SHIM_SKIP_VERSION_PROBE -eq 0 — 0.48.1 SOUNDNESS fix), so any
  # cache-key prep + lookup is pure overhead with zero possible hit.
  # Pre-fix the highest-frequency hooks paid dist-tree find/stat/hash
  # + several `node -e` calls on EVERY write-class fire for nothing.
  if [ "${#REA_ARGV[@]}" -gt 0 ] && [ "$sandbox_failed" -eq 0 ] \
     && [ "$SHIM_SKIP_VERSION_PROBE" -eq 0 ] && ! shim_cache_disabled; then
    local _stat_out=""
    local _proj_real=""
    local _euid=""
    local _session_tok=""
    # TOCTOU precursor cache-stability note: step 4a may have rewritten
    # RESOLVED_CLI_PATH to its realpath. That does NOT drift the cache
    # key value — `_shim_cache_cli_real` below runs realpathSync, so
    # realpath-of-realpath is byte-identical to realpath-of-symlink, and
    # `_stat_out` lstat reads the same underlying file (intermediate
    # symlinks are kernel-resolved either way).
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
    # 0.49.0 Phase 1b — tier-aware key inputs. The global tier enforces the
    # dist/cli/index.js shape unconditionally (A4), so the effective
    # enforce_cli_shape key field is "1" there regardless of
    # SHIM_ENFORCE_CLI_SHAPE. The registry mtime/size pin the trust source
    # so an untrust mid-session (atomic rename → new mtime; removed line →
    # smaller size — two invalidators defeat `touch -r`) misses a warm
    # global entry. Stat failure → leave them empty → the completeness gate
    # below produces a clean miss (fail-safe, NEVER fail-closed).
    if [ "$TRUST_TIER" = "global" ]; then
      _effective_shape="1"
      if [ -n "${_SHIM_GLOBAL_G_ROOT:-}" ]; then
        local _reg_path=""
        _reg_path="$(dirname "$_SHIM_GLOBAL_G_ROOT")/trusted-projects"
        local _reg_stat=""
        _reg_stat=$(shim_cache_mtime_size "$_reg_path" 2>/dev/null || true)
        if [ -n "$_reg_stat" ]; then
          _registry_mtime="${_reg_stat%% *}"
          _registry_size="${_reg_stat##* }"
        fi
      fi
    fi
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
       && [ -n "$_shim_cache_node_real" ] && [ -n "$_shim_cache_node_mtime" ] \
       && { [ "$TRUST_TIER" != "global" ] || { [ -n "$_registry_mtime" ] && [ -n "$_registry_size" ]; }; }; then
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
      # 0.49.0 Phase 1b: schema "v1"→"v2"; enforce_cli_shape carries the
      # EFFECTIVE value; trust_tier + registry mtime/size appended
      # (positions 15-17). v1 entries become a clean miss at the read-side
      # schema check (hard cutover).
      _shim_cache_key=$(shim_cache_key "v2" "$_session_tok" "$_proj_real" "$_shim_cache_cli_real" \
                                       "$_shim_cache_cli_mtime" "$_shim_cache_cli_size" "$_euid" \
                                       "$_effective_shape" "$SHIM_NAME" \
                                       "$_shim_cache_pkg_mtime" "$_shim_cache_pkg_size" \
                                       "$_shim_cache_dist_mtime" \
                                       "$_shim_cache_node_real" "$_shim_cache_node_mtime" \
                                       "$TRUST_TIER" "$_registry_mtime" "$_registry_size" \
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
              const trustTier = String(e.trust_tier);
              const regMtime = String(e.registry_mtime);
              const regSize = String(e.registry_size);
              const sandboxOk = e.sandbox_ok === true;
              const shapeOk = e.shape_ok === true;
              if (e.schema_version !== "v2") process.exit(1);
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
              // 0.49.0 Phase 1b: re-check trust_tier + registry mtime/size.
              // These are in the key too (a drifted state produces a
              // different key), but persisting + re-validating them catches
              // a key collision as a stale-entry miss instead of trusting
              // it — and makes the cross-tier non-collision explicit.
              if (trustTier !== process.argv[10]) process.exit(1);
              if (regMtime !== process.argv[11]) process.exit(1);
              if (regSize !== process.argv[12]) process.exit(1);
              if (!sandboxOk || !shapeOk) process.exit(1);
              process.stdout.write("ok");
            } catch (e) { process.exit(1); }
          ' -- "$_cache_json" "$_shim_cache_cli_mtime" "$_shim_cache_cli_size" "$_shim_cache_cli_real" "$_shim_cache_pkg_mtime" "$_shim_cache_pkg_size" "$_shim_cache_dist_mtime" "$_shim_cache_node_real" "$_shim_cache_node_mtime" "$TRUST_TIER" "$_registry_mtime" "$_registry_size" 2>/dev/null || true)
          if [ "$_cache_validate" = "ok" ]; then
            _shim_cache_hit=1
          fi
        fi
      fi
    fi
  fi

  # 5. (0.48.1: sandbox check moved to step 4a — before cache prep — so
  #    a hostile workspace cannot make the dist-tree hash walk traverse
  #    a symlinked-out target. The original step-5 block lived between
  #    cache prep and policy short-circuit; that location was sound for
  #    correctness but the cache code regressed the cheap-refusal
  #    posture against symlink workspaces. See step 4a comment.)

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
    # 0.49.0 Phase 1b: a BLESSED project resolved a global CLI tree that
    # failed A1–A4 (hostile/malformed). This MUST behave EXACTLY like "no
    # CLI" for the relevance decision — otherwise a broken ~/.rea/cli would
    # turn a harmless Bash/Write call into a repo-wide lockout for opted-in
    # users on the relevance-gated blocking shims (dangerous-bash-
    # interceptor, secret-scanner, settings-protection, blocked-paths-*,
    # protected-paths-bash-gate). The relevance + tier exit logic below is
    # SHARED between the plain CLI-missing and the bad-global-tree cases;
    # the only difference is that a bad global tree emits its one-line
    # advisory (which REPLACES the generic cli-missing banner) once we are
    # past the not-relevant-allow exit. An irrelevant payload is therefore
    # allowed SILENTLY, byte-identical to the pre-Phase-1b no-CLI path. Do
    # NOT escalate advisory hooks to a hard block on a global plant (A2
    # already proved only euid wrote the tree). Un-blessed projects never
    # reach here (they degrade silently). The bad reason is unset when
    # in-project resolved, so guard with :- for set -u.
    if declare -F shim_cli_missing_relevant >/dev/null 2>&1; then
      if ! shim_cli_missing_relevant; then
        # CLI missing — or a bad global tree, treated identically — AND the
        # payload is not relevant per the shim's keyword scan. The pre-port
        # bash body would have allowed this. Silent, no advisory.
        exit 0
      fi
    fi
    # Past here the payload IS relevant (or no callback is defined) → the
    # gate would act. Surface the global-tier diagnostic ONCE if a bad
    # global tree is the cause (it replaces the generic cli-missing banner).
    if [ -n "${_SHIM_GLOBAL_BAD_REASON:-}" ]; then
      shim_emit_global_tier_banner "$_SHIM_GLOBAL_BAD_REASON"
    fi
    if [ "$SHIM_FAIL_OPEN" -eq 1 ]; then
      # Advisory tier — drop the gate. Any global-bad advisory was already
      # emitted; advisory hooks are nudges, not security claims.
      exit 0
    fi
    # Relevant + blocking: refuse. The generic cli-missing banner only when
    # a bad global tree did NOT already explain the refusal.
    if [ -z "${_SHIM_GLOBAL_BAD_REASON:-}" ]; then
      shim_emit_cli_missing_banner
    fi
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
  #
  #     0.48.1 SOUNDNESS: also skipped when SHIM_SKIP_VERSION_PROBE=1
  #     (delegation-capture path). Pre-fix the cache write proceeded
  #     after a skipped probe, recording `shape_ok: true` from
  #     defaulted-true logic without the probe having actually run.
  #     On the next fire a cache hit would read that entry and trust
  #     a version-probe answer that was never produced. The cache MUST
  #     only persist real probe results; if the probe was bypassed,
  #     the next fire pays the cost of running it for real.
  if [ "$_shim_cache_hit" -eq 0 ] && [ -n "$_shim_cache_key" ] \
     && [ "$SHIM_SKIP_VERSION_PROBE" -eq 0 ]; then
    local _write_payload=""
    _write_payload=$(node -e '
      const args = process.argv.slice(1);
      const now = Math.floor(Date.now() / 1000);
      const entry = {
        schema_version: "v2",
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
        // 0.49.0 Phase 1b: trust_tier + registry mtime/size (the read-side
        // validator re-checks all three). registry_* are "" on the project
        // tier; sandbox_ok/shape_ok are the tier-appropriate results — for
        // global, A4 shape was enforced unconditionally during resolution.
        trust_tier: args[8],
        registry_mtime: args[9],
        registry_size: args[10],
        sandbox_ok: true,
        shape_ok: true,
        cached_at_unix: now,
        ttl_seconds: 3600,
      };
      process.stdout.write(JSON.stringify(entry));
    ' -- "$_shim_cache_cli_real" "$_shim_cache_cli_mtime" "$_shim_cache_cli_size" "$_shim_cache_pkg_mtime" "$_shim_cache_pkg_size" "$_shim_cache_dist_mtime" "$_shim_cache_node_real" "$_shim_cache_node_mtime" "$TRUST_TIER" "$_registry_mtime" "$_registry_size" 2>/dev/null || true)
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
