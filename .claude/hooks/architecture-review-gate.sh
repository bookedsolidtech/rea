#!/bin/bash
# PostToolUse hook: architecture-review-gate.sh
# 0.33.0+ — Node-binary shim for `rea hook architecture-review-gate`.
#
# Pre-0.33.0 the gate's full body lived here as bash (101 LOC, policy-
# driven prefix-match against `architecture_review.patterns`). The
# migration moves all of that into `src/hooks/architecture-review-gate/
# index.ts`.
#
# Behavioral contract is preserved byte-for-byte: ALWAYS exit 0
# (advisory-only) except under HALT (exit 2). The hook fires for ALL
# Write/Edit PostToolUse events, but the Node body short-circuits to
# exit 0 when patterns are unset/empty — so the cost of running the
# CLI on every write is bounded.
#
# # CLI-resolution trust boundary
#
# Realpath sandbox check + version probe. Same shape as the 0.32.0
# pilots.
#
# # Fail-OPEN posture
#
# architecture-review-gate is ADVISORY-only — the pre-0.33.0 bash body
# never refused (exit 0 only). The early-exit branches (CLI missing,
# node missing, sandbox failed, version skew) all exit 0 silently
# because there is nothing to "preserve protection" for. The HALT
# check is the only path to exit 2.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. No relevance pre-gate — architecture-review-gate fires on every
#    Write/Edit, and the cost of the Node body's early-out (load
#    policy, check patterns array, prefix-match) is well under the
#    cost of a sandbox/probe pair. Capture stdin once.
INPUT=$(cat)

# 3. Resolve the rea CLI. Advisory-tier: exit 0 silently on missing
#    CLI — nothing to enforce.
REA_ARGV=()
RESOLVED_CLI_PATH=""
if [ -f "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js" ]; then
  REA_ARGV=(node "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/node_modules/@bookedsolid/rea/dist/cli/index.js"
elif [ -f "$proj/dist/cli/index.js" ]; then
  REA_ARGV=(node "$proj/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/dist/cli/index.js"
fi

if [ "${#REA_ARGV[@]}" -eq 0 ]; then
  exit 0
fi

# 4. Realpath sandbox check. Advisory-tier: exit 0 silently on
#    sandbox failure (with a single-line breadcrumb to stderr).
if ! command -v node >/dev/null 2>&1; then
  exit 0
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
  printf 'rea: architecture-review-gate skipped (sandbox check: %s)\n' "$sandbox_check" >&2
  exit 0
fi

# 5. Version-probe. Advisory-tier: exit 0 on probe failure.
probe_out=$("${REA_ARGV[@]}" hook architecture-review-gate --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'architecture-review-gate'; then
  printf 'rea: this shim requires the `rea hook architecture-review-gate` subcommand (introduced in 0.33.0).\n' >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; falling through silently.\n' >&2
  exit 0
fi

# 6. Forward stdin.
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook architecture-review-gate
exit $?
