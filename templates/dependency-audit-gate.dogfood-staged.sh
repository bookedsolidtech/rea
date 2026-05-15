#!/bin/bash
# PreToolUse hook: dependency-audit-gate.sh
# 0.33.0+ — Node-binary shim for `rea hook dependency-audit-gate`.
#
# Pre-0.33.0 the gate's full body lived here as bash (179 LOC, the
# segment splitter + install-pattern detection + per-package
# `npm view` probe). The migration to the parser-backed Node binary
# moves all of that into `src/hooks/dependency-audit-gate/index.ts`.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on
# pass-through / all-packages-verified, exit 2 on HALT / any package
# missing / malformed payload.
#
# # CLI-resolution trust boundary
#
# Realpath sandbox check + version probe. Same shape as the 0.32.0
# pilots and the env-file-protection shim above.
#
# # Fail-closed posture
#
# dependency-audit-gate is BLOCKING-tier — the pre-0.33.0 bash body
# refused on missing packages. Early-exit branches (CLI missing,
# node missing, sandbox failed, version skew) fail closed AFTER the
# relevance pre-gate passes.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Relevance pre-gate. Look for any install-pattern keyword.
#
#    2026-05-15 codex round-2 P2 fix: scan `tool_input.command` ONLY,
#    not the raw JSON payload. Pre-fix `git commit -m "docs: run pnpm
#    install foo before start"` triggered the fail-closed branch on a
#    fresh checkout (the install-pattern regex hit the substring
#    inside the commit-message ARG of the git command, not a real
#    install invocation). The Node body's segment-anchored matcher
#    correctly distinguishes between the two — the shim's pre-gate
#    must match that posture.
#
#    `jq`-less fallback preserves the pre-0.33.0 over-trigger shape.
INPUT=$(cat)
RELEVANT=0
PROBE=""
if command -v jq >/dev/null 2>&1; then
  PROBE=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
  if printf '%s' "$PROBE" | grep -qE '(npm[[:space:]]+(install|i|add)|pnpm[[:space:]]+(add|install|i)|yarn[[:space:]]+add)[[:space:]]'; then
    RELEVANT=1
  fi
else
  if printf '%s' "$INPUT" | grep -qE '(npm[[:space:]]+(install|i|add)|pnpm[[:space:]]+(add|install|i)|yarn[[:space:]]+add)[[:space:]]'; then
    RELEVANT=1
  fi
fi
if [ "$RELEVANT" -eq 0 ]; then
  exit 0
fi

# 3. Resolve the rea CLI.
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
  printf 'rea: dependency-audit-gate cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  exit 2
fi

# 4. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: dependency-audit-gate cannot run — `node` is not on PATH.\n' >&2
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
  printf 'rea: dependency-audit-gate FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 5. Version-probe.
probe_out=$("${REA_ARGV[@]}" hook dependency-audit-gate --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'dependency-audit-gate'; then
  printf 'rea: this shim requires the `rea hook dependency-audit-gate` subcommand (introduced in 0.33.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 6. Forward stdin.
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook dependency-audit-gate
exit $?
