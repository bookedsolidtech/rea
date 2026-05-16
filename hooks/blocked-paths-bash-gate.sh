#!/bin/bash
# PreToolUse hook: blocked-paths-bash-gate.sh
# 0.35.0+ — Node-binary shim for `rea hook blocked-paths-bash-gate`.
#
# Pre-0.35.0 this was a thin bash shim over `rea hook scan-bash --mode
# blocked` (the parser-backed AST walker that closes 9 bypass classes
# from helix-023 + discord-ops Round 13 — see `src/hooks/bash-scanner/`).
# The full bash body is preserved at
# `__tests__/hooks/parity/baselines/blocked-paths-bash-gate.sh.pre-0.35.0`.
#
# This shim now resolves the CLI through the same 2-tier sandboxed
# resolver as the 0.32.0+ pilots and calls `rea hook blocked-paths-
# bash-gate` directly — eliminating the shim → CLI → scanner-module
# subprocess hop entirely.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on allow,
# exit 2 on HALT / verdict block / malformed payload / sandbox fail.
#
# # CLI-resolution trust boundary
#
# Mirrors the 0.32.0 final shim shape. The resolved CLI MUST live
# INSIDE realpath(CLAUDE_PROJECT_DIR) AND have an ancestor
# `package.json` whose `name` is `@bookedsolid/rea`. Defends against
# symlink-out and tarball-replacement attacks on the resolved CLI.
#
# # Fail-closed posture
#
# blocked-paths-bash-gate is a Tier-1 security gate (PreToolUse Bash).
# The pre-0.35.0 bash body refused on uncertainty for every failure
# class. Early-exit branches (CLI missing, node missing, sandbox failed,
# version skew) fail closed AFTER the relevance pre-gate passes.
# Irrelevant Bash calls exit 0 regardless of CLI state.
#
# # Relevance pre-gate
#
# Same posture as 0.34.0 dangerous-bash + secret-scanner. When the CLI
# is missing, refuse only when the extracted command MENTIONS a path
# from `policy.blocked_paths`. Empty policy → no enforcement, exit 0.
# This unblocks the install path itself: `npx rea init`, pre-`pnpm build`
# checkouts can still run benign Bash like `ls`/`mkdir`/`pnpm install`.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Capture stdin once.
INPUT=$(cat)

# 3. Resolve the rea CLI through the fixed 2-tier sandboxed order.
REA_ARGV=()
RESOLVED_CLI_PATH=""
if [ -f "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js" ]; then
  REA_ARGV=(node "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/node_modules/@bookedsolid/rea/dist/cli/index.js"
elif [ -f "$proj/dist/cli/index.js" ]; then
  REA_ARGV=(node "$proj/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/dist/cli/index.js"
fi

# 3b. Relevance pre-gate. Only used when the CLI is missing.
if [ "${#REA_ARGV[@]}" -eq 0 ]; then
  CLI_MISSING_CMD=""
  if command -v jq >/dev/null 2>&1; then
    CLI_MISSING_CMD=$(printf '%s' "$INPUT" | jq -r '
      (.tool_input.command // "") | tostring
    ' 2>/dev/null || true)
  else
    CLI_MISSING_CMD="$INPUT"
  fi
  if [ -z "$CLI_MISSING_CMD" ]; then
    # Empty/non-Bash payload → pre-0.35.0 body would have exited 0.
    exit 0
  fi
  # Empty policy.blocked_paths → no enforcement, exit 0.
  POLICY_FILE="${REA_ROOT}/.rea/policy.yaml"
  if [ ! -f "$POLICY_FILE" ]; then
    exit 0
  fi
  # 0.37.0: route blocked_paths reads through the unified
  # policy-reader (Tier 1 CLI → Tier 2 python3 → Tier 3 awk
  # block-form). Pre-0.37.0 the per-shim awk parser missed flow-form
  # arrays (`blocked_paths: [.env, .env.*, ...]`), silently exiting 0
  # on relevant Bash calls when the CLI was unreachable. The
  # 4-tier ladder closes that bypass via Tier 2 whenever python3 +
  # PyYAML are available (common on macOS Homebrew + most Linux
  # distros); falls through to Tier 3 (block-form only) otherwise.
  # shellcheck source=_lib/policy-reader.sh
  source "$(dirname "$0")/_lib/policy-reader.sh"
  # Substring scan: does the command mention any blocked_paths entry?
  # Coarse — over-trigger is fine, under-trigger is the bypass we MUST
  # avoid.
  CLI_MISSING_RELEVANT=0
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    case "$CLI_MISSING_CMD" in
      *"$entry"*) CLI_MISSING_RELEVANT=1; break ;;
    esac
  done < <(policy_reader_get_list blocked_paths 2>/dev/null)
  if [ "$CLI_MISSING_RELEVANT" -eq 0 ]; then
    exit 0
  fi
  printf 'rea: blocked-paths-bash-gate cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  printf 'This shim fails closed because the pre-0.35.0 bash body enforced blocked_paths refusal without a CLI.\n' >&2
  exit 2
fi

# 4. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: blocked-paths-bash-gate cannot run — `node` is not on PATH.\n' >&2
  printf 'Install Node 22+ (engines.node) to restore blocked_paths refusal.\n' >&2
  exit 2
fi

sandbox_check=$(node -e '
  const fs = require("fs");
  const path = require("path");
  const cli = process.argv[1];
  const projDir = process.argv[2];
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
  // Codex round-1 P1 fix: enforce dist/cli/index.js shape (see
  // settings-protection.sh).
  const expectedEnd = path.join("dist", "cli", "index.js");
  if (!real.endsWith(path.sep + expectedEnd) && real !== "/" + expectedEnd) {
    process.stdout.write("bad:cli-shape"); process.exit(1);
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
' -- "$RESOLVED_CLI_PATH" "$proj" 2>/dev/null)

if [ "$sandbox_check" != "ok" ]; then
  printf 'rea: blocked-paths-bash-gate FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 5. Version-probe.
probe_out=$("${REA_ARGV[@]}" hook blocked-paths-bash-gate --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'blocked-paths-bash-gate'; then
  printf 'rea: this shim requires the `rea hook blocked-paths-bash-gate` subcommand (introduced in 0.35.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 6. Forward stdin (already captured up-front).
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook blocked-paths-bash-gate
exit $?
