#!/bin/bash
# PreToolUse hook: dangerous-bash-interceptor.sh
# 0.34.0+ — Node-binary shim for `rea hook dangerous-bash-interceptor`.
#
# Pre-0.34.0 the gate's full body lived here as bash (414 LOC, every
# refusal class H1-H17 + M1 plus their bypass-corpus regressions). The
# migration to the parser-backed Node binary moves all of that into
# `src/hooks/dangerous-bash-interceptor/index.ts`. This shim is the
# Claude Code dispatcher's view of the hook — it forwards stdin to
# the CLI and exits with whatever the CLI returns.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on
# pass-through / MEDIUM-only advisory, exit 2 on HALT / HIGH rule
# match / malformed payload (fail-closed).
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
# dangerous-bash-interceptor is the agent-runaway gate — the pre-0.34.0
# bash body refused destructive commands without any compiled CLI. The
# early-exit branches (CLI missing, node missing, sandbox failed,
# version skew) fail closed AFTER the relevance pre-gate passes.
# Irrelevant Bash calls exit 0 regardless of CLI state.
#
# # Relevance pre-gate
#
# 0.34.0 round-7 P1 fix: the pre-0.34.0 bash body refused destructive
# commands without any compiled CLI. The round-0 shim preserved that
# fail-closed-on-CLI-missing posture for ALL Bash, but that's stricter
# than the pre-0.34.0 body which only refused commands matching the
# destructive catalog. On a fresh / unbuilt install (`npx rea init`,
# pre-`pnpm build` checkout) the shim blocked benign Bash like `ls`,
# `mkdir`, `pnpm install` — defeating the install path itself.
#
# Fix: substring pre-gate over the EXTRACTED command (not raw payload —
# the local-review-gate round-2 lesson). When CLI is missing AND no
# destructive-keyword appears in the extracted command, exit 0 (the
# pre-0.34.0 bash body would have done the same — there's no rule to
# match). When CLI is missing AND a destructive-keyword DOES appear,
# preserve the original fail-closed posture (we'd rather refuse than
# silently allow a destructive command).
#
# The keyword list is coarse — it over-triggers (e.g. `git status` hits
# `git` substring) but that's fine: the CLI does the real evaluation
# and lets benign forms through. Over-trigger costs one node-spawn;
# under-trigger is the bypass we MUST avoid. Same posture as the
# 0.32.0 secret-scanner `gh issue create` substring fix.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Capture stdin once. The CLI consumes it via stdin pipe below.
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

# 3b. Relevance pre-gate (round-7 P1). Only used when the CLI is
#     missing — when present, every Bash call goes through the CLI.
#     Extract the command string from the payload, then substring-scan
#     it for destructive-catalog keywords. Mirrors the H1-H17 + M1
#     rule heads.
if [ "${#REA_ARGV[@]}" -eq 0 ]; then
  CLI_MISSING_CMD=""
  if command -v jq >/dev/null 2>&1; then
    # Match the CLI's payload schema: tool_input.command. tostring so
    # a non-string value (object/number) doesn't blow up jq.
    CLI_MISSING_CMD=$(printf '%s' "$INPUT" | jq -r '
      (.tool_input.command // "") | tostring
    ' 2>/dev/null || true)
  else
    # jq missing — fall back to scanning the raw payload. Over-trigger
    # by design (the CLI is the source of truth; this is fail-closed
    # only when keywords match). Substring scan still catches the
    # destructive forms in JSON-string-encoded payloads.
    CLI_MISSING_CMD="$INPUT"
  fi
  # If we couldn't extract a command, treat as relevant (fail closed).
  CLI_MISSING_RELEVANT=0
  if [ -z "$CLI_MISSING_CMD" ]; then
    # Empty command (or non-Bash payload). The pre-0.34.0 bash body
    # would have exited 0 here — no command, no rule match.
    exit 0
  fi
  # Substring scan. Keywords cover every rule head H1-H17 + M1. Coarse
  # by design — we're a safety net, not the source of truth. The CLI
  # does the precise per-rule evaluation when reachable.
  case "$CLI_MISSING_CMD" in
    *"git "*) CLI_MISSING_RELEVANT=1 ;;
    *"git	"*) CLI_MISSING_RELEVANT=1 ;;  # tab after git
    *"rm "*|*"rm	"*) CLI_MISSING_RELEVANT=1 ;;
    *"psql"*|*"pgcli"*) CLI_MISSING_RELEVANT=1 ;;
    *"DROP "*|*"DROP	"*) CLI_MISSING_RELEVANT=1 ;;
    *"kill "*|*"kill	"*|*"killall"*) CLI_MISSING_RELEVANT=1 ;;
    *"HUSKY="*) CLI_MISSING_RELEVANT=1 ;;
    *"curl"*|*"wget"*) CLI_MISSING_RELEVANT=1 ;;
    *"REA_BYPASS"*) CLI_MISSING_RELEVANT=1 ;;
    *"alias "*|*"function "*) CLI_MISSING_RELEVANT=1 ;;
    *"core.hooksPath"*|*"core.hookspath"*) CLI_MISSING_RELEVANT=1 ;;
    *"npm "*|*"pnpm "*|*"yarn "*) CLI_MISSING_RELEVANT=1 ;;
    *"--no-verify"*|*"--force"*) CLI_MISSING_RELEVANT=1 ;;
  esac
  if [ "$CLI_MISSING_RELEVANT" -eq 0 ]; then
    # No destructive-keyword in the extracted command. The pre-0.34.0
    # bash body would have allowed this — exit 0 to preserve install-
    # path / unbuilt-checkout workflows.
    exit 0
  fi
  # Keyword matched. Preserve fail-closed posture — the pre-0.34.0
  # bash body would have evaluated this command and potentially refused.
  printf 'rea: dangerous-bash-interceptor cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  printf 'This shim fails closed because the pre-0.34.0 bash body enforced destructive-command refusal without a CLI.\n' >&2
  exit 2
fi

# 4. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: dangerous-bash-interceptor cannot run — `node` is not on PATH.\n' >&2
  printf 'Install Node 22+ (engines.node) to restore destructive-command refusal.\n' >&2
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
  printf 'rea: dangerous-bash-interceptor FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 5. Version-probe.
probe_out=$("${REA_ARGV[@]}" hook dangerous-bash-interceptor --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'dangerous-bash-interceptor'; then
  printf 'rea: this shim requires the `rea hook dangerous-bash-interceptor` subcommand (introduced in 0.34.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 6. Forward stdin (already captured up-front).
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook dangerous-bash-interceptor
exit $?
