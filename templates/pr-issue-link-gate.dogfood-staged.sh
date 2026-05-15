#!/bin/bash
# PreToolUse hook: pr-issue-link-gate.sh
# 0.32.0+ — Node-binary shim for `rea hook pr-issue-link-gate`.
#
# Pre-0.32.0 the gate's full body lived here as bash; the migration to
# the parser-backed Node binary moves the matching + advisory logic
# into `src/hooks/pr-issue-link-gate/index.ts`. This shim is the
# Claude Code dispatcher's view of the hook — it forwards stdin to the
# CLI and exits with whatever the CLI returns.
#
# Behavioral contract is preserved byte-for-byte: ALWAYS exit 0 except
# under HALT (exit 2) or a malformed payload (exit 2, fail-closed).
#
# # CLI-resolution trust boundary
#
# Codex round 1 P1 (2026-05-15): mirrors the realpath sandbox check
# from `delegation-advisory.sh` §3 and `protected-paths-bash-gate.sh`
# §6. The resolved CLI MUST live INSIDE realpath(CLAUDE_PROJECT_DIR)
# AND have an ancestor `package.json` whose `name` is
# `@bookedsolid/rea`. Pre-fix the shim executed
# `node_modules/@bookedsolid/rea/dist/cli/index.js` directly without
# realpathing the target, which would let an attacker who controlled
# `node_modules/@bookedsolid/rea` (symlink-out, postinstall script,
# tarball-replacement) ship forged review code that intercepts every
# Bash dispatch.
#
# Sandboxed resolution order (PATH is INTENTIONALLY OMITTED):
#   1. node_modules/@bookedsolid/rea/dist/cli/index.js (consumer-side)
#   2. dist/cli/index.js under CLAUDE_PROJECT_DIR (dogfood)
#
# When NO rea CLI is reachable through the sandboxed order, this hook
# falls through to allow (exit 0) — the advisory is a nudge, not a
# security claim. The bash-tier path gates fail-closed because they
# protect write surfaces; this gate only emits prose.
#
# # Version skew
#
# Codex round 1 P1 (2026-05-15): a fresh `rea init` against a stale
# `node_modules/@bookedsolid/rea` would deliver this 0.32.0 shim while
# the installed CLI lacks the `hook pr-issue-link-gate` subcommand —
# every Bash dispatch would then fail with `unknown command` (exit 1).
# Probe the subcommand's `--help` output before propagating the exit
# code; on probe failure, advise the operator to `pnpm install` and
# fall through silently so the workspace stays usable.

set -uo pipefail

# 1. HALT check. Even though the CLI re-checks for defense-in-depth,
#    short-circuit here so we never spawn `node` while frozen.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Resolve the rea CLI through the fixed 2-tier sandboxed order.
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

# 3. Realpath sandbox check — mirrors delegation-advisory.sh §3.
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
  printf 'rea: pr-issue-link-gate skipped (sandbox check: %s)\n' "$sandbox_check" >&2
  exit 0
fi

# 4. Version-probe: confirm the resolved CLI implements the
#    `hook pr-issue-link-gate` subcommand. A stale node_modules from
#    a fresh `rea init` against an older installed version would
#    otherwise turn every Bash dispatch into a hard failure.
probe_out=$("${REA_ARGV[@]}" hook pr-issue-link-gate --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'pr-issue-link-gate'; then
  printf 'rea: this shim requires the `rea hook pr-issue-link-gate` subcommand (introduced in 0.32.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI to the version this shim expects.\n' >&2
  exit 0
fi

# 5. Forward stdin to the CLI synchronously. The advisory text must
#    reach the operator's stderr before this hook returns; the CLI's
#    own exit code is the hook's exit code (0 normally, 2 under HALT
#    or malformed payload).
INPUT=$(cat)
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook pr-issue-link-gate
exit $?
