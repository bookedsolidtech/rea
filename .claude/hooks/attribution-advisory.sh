#!/bin/bash
# PreToolUse hook: attribution-advisory.sh
# 0.32.0+ — Node-binary shim for `rea hook attribution-advisory`.
#
# Pre-0.32.0 the gate's full body lived here as bash (162 LOC,
# including the AI-attribution pattern catalog and segment-relevance
# gating). The migration to the parser-backed Node binary moves all
# of that into `src/hooks/attribution-advisory/index.ts`. This shim
# is the Claude Code dispatcher's view of the hook — it forwards
# stdin to the CLI and exits with whatever the CLI returns.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on
# disabled-policy / non-relevant / clean-command, exit 2 on HALT /
# attribution detected / malformed payload (fail-closed).
#
# # CLI-resolution trust boundary
#
# Codex round 1 P1 (2026-05-15): realpath sandbox check + version
# probe. Mirrors delegation-advisory.sh §3. Defends against
# symlink-out + tarball-replacement attacks on the resolved CLI AND
# stale-node_modules version skew that would otherwise turn every
# Bash dispatch into a hard failure.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Relevance pre-gate (0.32.0 round-5 P1, round-6 fix). PreToolUse
#    Bash matchers fire on EVERY shell command, but this hook only
#    enforces against `git commit` / `gh pr create|edit`. Capture
#    stdin + check relevance FIRST so unrelated commands (ls,
#    pnpm test, …) exit 0 even when the CLI is missing/stale/
#    sandboxed-out.
#
#    Match the pattern ANYWHERE in the command string (after the
#    opening quote, then `[^"]*` for any leading shell prefix —
#    `sudo`, `time`, env assignments like `FOO=x git commit …`).
#    Round-6 P1: prior round-5 pattern anchored at the start of the
#    JSON value and missed all prefixed forms.
INPUT=$(cat)
# Substring scan (NOT JSON-aware). Round-7 P2: any JSON-aware regex
# anchored on `"command":"...` gets tripped by escaped quotes in
# quoted env prefixes (`FOO="two words" git commit …` → the payload
# carries `\"two words\"` and `[^"]*` stops at the escaped quote).
# Plain substring match has no such edge: it over-triggers only on
# the rare case where the pattern appears inside a quoted argument
# (`echo "gh pr create"`), and the Node body handles that correctly.
# This hook only fires on `tool_name=Bash`, so we don't risk matching
# unrelated payload shapes.
RELEVANT=0
if printf '%s' "$INPUT" | grep -qE '(git[[:space:]]+commit|gh[[:space:]]+pr[[:space:]]+(create|edit))'; then
  RELEVANT=1
fi
if [ "$RELEVANT" -eq 0 ]; then
  # Irrelevant Bash call — nothing the pre-0.32.0 body would have
  # processed. Always exit 0 regardless of CLI state.
  exit 0
fi

# 2b. Policy short-circuit (round-6 P2). The pre-0.32.0 bash body
#     no-op'd when `block_ai_attribution` was absent or false. Without
#     this check, an unbuilt/stale install would refuse `git commit`
#     even on repos that DELIBERATELY disable the attribution gate.
#     Read the policy via a simple grep — the canonical loader
#     handles inline forms but we only need block form here, and a
#     conservative "true-and-only-true counts" rule matches the
#     intent (false / absent / inline-only all → no enforcement).
POLICY_FILE="$REA_ROOT/.rea/policy.yaml"
if [ ! -f "$POLICY_FILE" ] || ! grep -qE '^block_ai_attribution:[[:space:]]*true([[:space:]]|$)' "$POLICY_FILE"; then
  # Attribution blocking disabled — pre-0.32.0 bash body would have
  # exited 0 here. Don't refuse on stale-install grounds.
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
  # 0.32.0 round-4 P2: when `block_ai_attribution: true`, this hook is
  # blocking-tier — the pre-0.32.0 bash body enforced the policy
  # without a compiled CLI. Falling through to exit 0 would silently
  # let AI-attribution patterns through every git commit / gh pr
  # create-or-edit until the operator rebuilds. Fail closed and tell
  # the operator how to restore protection.
  printf 'rea: attribution-advisory cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  printf 'This shim fails closed because the pre-0.32.0 bash body enforced attribution policy without a CLI.\n' >&2
  exit 2
fi

# 3. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: attribution-advisory cannot run — `node` is not on PATH.\n' >&2
  printf 'Install Node 22+ (engines.node) to restore enforcement.\n' >&2
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
  # 0.32.0 round-4 P2: fail closed (blocking-tier when policy enables —
  # see top-of-file rationale). Sandbox failure means the CLI cannot
  # be authenticated; refuse rather than silently bypass.
  printf 'rea: attribution-advisory FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 4. Version-probe: confirm the resolved CLI implements
#    `hook attribution-advisory`. Codex round 1 P1.
probe_out=$("${REA_ARGV[@]}" hook attribution-advisory --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'attribution-advisory'; then
  # 0.32.0 round-4 P2: stale/older CLI without the new subcommand is
  # NOT advisory-tier fall-through — the bash body it replaces
  # enforced when policy enabled. Fail closed and tell the operator
  # exactly how to fix.
  printf 'rea: this shim requires the `rea hook attribution-advisory` subcommand (introduced in 0.32.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 5. Forward stdin (already captured up-front for the relevance gate).
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook attribution-advisory
exit $?
