#!/bin/bash
# PreToolUse hook: env-file-protection.sh
# 0.33.0+ — Node-binary shim for `rea hook env-file-protection`.
#
# Pre-0.33.0 the gate's full body lived here as bash (124 LOC, the
# segment splitter + `source`/`cp` anchor patterns + utility-vs-.env
# co-occurrence check). The migration to the parser-backed Node binary
# moves all of that into `src/hooks/env-file-protection/index.ts`. This
# shim is the Claude Code dispatcher's view of the hook — it forwards
# stdin to the CLI and exits with whatever the CLI returns.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on
# pass-through / no-match, exit 2 on HALT / .env access detected /
# malformed payload (fail-closed).
#
# # CLI-resolution trust boundary
#
# Mirrors the 0.32.0 final shim shape (round-8 of the codex iteration
# on the three Phase 1 pilots). The resolved CLI MUST live INSIDE
# realpath(CLAUDE_PROJECT_DIR) AND have an ancestor `package.json`
# whose `name` is `@bookedsolid/rea`. Defends against symlink-out and
# tarball-replacement attacks on the resolved CLI.
#
# # Fail-closed posture
#
# env-file-protection is a BLOCKING-tier gate — the pre-0.33.0 bash
# body refused on .env access without a compiled CLI. The early-exit
# branches (CLI missing, node missing, sandbox failed, version skew)
# fail closed AFTER the relevance pre-gate passes. Irrelevant Bash
# calls exit 0 regardless of CLI state.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Relevance pre-gate. Capture stdin + check for `.env` substring
#    BEFORE any CLI/sandbox/probe work so unrelated Bash calls
#    (`ls`, `pnpm test`, `git status`, …) exit 0 even when the CLI
#    is missing/stale/sandboxed-out.
#
#    2026-05-15 codex round-2 P2 fix: the substring scan MUST run
#    against `tool_input.command` ONLY, not the raw JSON payload —
#    otherwise a benign `git commit -m "stop reading .env"` (where
#    `.env` appears inside the commit message ARG, NOT as a file
#    target) would hit the fail-closed branch on a fresh checkout
#    where the CLI is unbuilt. Pre-fix the raw scan saw the substring
#    inside the payload's "command" string-quoted body and refused.
#
#    Strategy: extract `tool_input.command` via `jq` (already required
#    by 5 other hooks; trust assumption is consistent). When `jq` is
#    not installed, fall back to scanning the raw payload — the cost
#    is the same over-trigger the bash original had, NOT a new
#    regression. When `jq` IS installed (the common case), the
#    pre-gate is field-scoped.
INPUT=$(cat)
RELEVANT=0
PROBE=""
if command -v jq >/dev/null 2>&1; then
  PROBE=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
  if printf '%s' "$PROBE" | grep -qE '\.env'; then
    RELEVANT=1
  fi
else
  # jq-less fallback — match the pre-0.33.0 over-trigger posture.
  if printf '%s' "$INPUT" | grep -qE '\.env'; then
    RELEVANT=1
  fi
fi
if [ "$RELEVANT" -eq 0 ]; then
  exit 0
fi

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

if [ "${#REA_ARGV[@]}" -eq 0 ]; then
  # Blocking-tier: fail closed. The pre-0.33.0 bash body enforced
  # .env protection without a CLI. Refuse and tell the operator how
  # to restore protection.
  printf 'rea: env-file-protection cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  printf 'This shim fails closed because the pre-0.33.0 bash body enforced .env protection without a CLI.\n' >&2
  exit 2
fi

# 4. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: env-file-protection cannot run — `node` is not on PATH.\n' >&2
  printf 'Install Node 22+ (engines.node) to restore .env protection.\n' >&2
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
  printf 'rea: env-file-protection FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 5. Version-probe.
probe_out=$("${REA_ARGV[@]}" hook env-file-protection --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'env-file-protection'; then
  printf 'rea: this shim requires the `rea hook env-file-protection` subcommand (introduced in 0.33.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 6. Forward stdin (already captured up-front for the relevance gate).
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook env-file-protection
exit $?
