#!/bin/bash
# PreToolUse hook: security-disclosure-gate.sh
# 0.32.0+ — Node-binary shim for `rea hook security-disclosure-gate`.
#
# Pre-0.32.0 the gate's full body lived here as bash (339 LOC including
# the awk body-file resolver, security-patterns array, and mode-aware
# routing). The migration to the parser-backed Node binary moves all of
# that into `src/hooks/security-disclosure-gate/index.ts`. This shim is
# the Claude Code dispatcher's view of the hook — it forwards stdin
# AND the REA_DISCLOSURE_MODE env var to the CLI and exits with
# whatever the CLI returns.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on
# pass-through / no-match, exit 2 on HALT / pattern match / traversal
# refusal / malformed payload (fail-closed).
#
# # CLI-resolution trust boundary
#
# Codex round 1 P1 (2026-05-15): realpath sandbox check matches
# delegation-advisory.sh §3. The resolved CLI MUST live INSIDE
# realpath(CLAUDE_PROJECT_DIR) AND have an ancestor `package.json`
# whose `name` is `@bookedsolid/rea`. Defends against symlink-out
# and tarball-replacement attacks that could otherwise forge the
# pattern matcher and either suppress real findings or leak a
# vulnerability through the disclosure gate.
#
# Sandboxed resolution order (PATH is INTENTIONALLY OMITTED):
#   1. node_modules/@bookedsolid/rea/dist/cli/index.js (consumer-side)
#   2. dist/cli/index.js under CLAUDE_PROJECT_DIR (dogfood)
#
# When NO rea CLI is reachable, the hook falls through to allow —
# same posture as the bash-resident version, which `source`d
# _lib/common.sh first and exited cleanly if the lib was missing.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Relevance pre-gate (0.32.0 round-5 P1, round-6 fix). PreToolUse
#    Bash matchers fire on EVERY shell command, but this hook only
#    enforces against `gh issue create` payloads carrying disclosure
#    keywords. Capture stdin + check relevance FIRST so unrelated
#    commands exit 0 even when the CLI is missing/stale.
#
#    Match `gh issue create` ANYWHERE in the command string (allow
#    shell prefixes — `sudo`, env assignments). Round-6 P1.
INPUT=$(cat)
# Substring scan (NOT JSON-aware). Round-7 P1: any JSON-aware regex
# anchored on `"command":"...` gets tripped by escaped quotes in
# quoted env prefixes (`MODE="internal" gh issue create …`). Plain
# substring match has no such edge — and false-positives just defer
# to the Node body which handles correctly.
RELEVANT=0
if printf '%s' "$INPUT" | grep -qE 'gh[[:space:]]+issue[[:space:]]+create'; then
  RELEVANT=1
fi
if [ "$RELEVANT" -eq 0 ]; then
  exit 0
fi

# 2b. Mode short-circuit (round-6 P2). The pre-0.32.0 bash body
#     no-op'd ONLY when `REA_DISCLOSURE_MODE=disabled` — `advisory`
#     mode and the `issues` mode (default) BOTH enforced. Without
#     this check, an unbuilt/stale install would refuse every relevant
#     `gh issue create` even when the operator has deliberately set
#     mode=disabled.
MODE="${REA_DISCLOSURE_MODE:-advisory}"
if [ "$MODE" = "disabled" ]; then
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
  # 0.32.0 round-4 P1: this is a blocking-tier gate — the pre-0.32.0
  # bash body enforced the disclosure policy WITHOUT a compiled CLI.
  # Falling through to exit 0 here would silently disable security-
  # keyword blocking on `gh issue create` until the operator runs
  # `pnpm install` / `pnpm build`. Fail closed: refuse the operation
  # and tell the operator how to restore protection.
  printf 'rea: security-disclosure-gate cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  printf 'This shim fails closed because the pre-0.32.0 bash body enforced disclosure policy without a CLI.\n' >&2
  exit 2
fi

# 3. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: security-disclosure-gate cannot run — `node` is not on PATH.\n' >&2
  printf 'Install Node 22+ (engines.node) to restore disclosure-policy enforcement.\n' >&2
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
  # 0.32.0 round-4 P1: fail closed (blocking-tier — see exit-0 → exit-2
  # rationale at the top). A failed sandbox check means the CLI we
  # would run cannot be authenticated as the rea binary; refusing is
  # both the safest posture AND preserves the pre-0.32.0 bash-body
  # contract that this hook always enforces policy.
  printf 'rea: security-disclosure-gate FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 4. Version-probe: confirm the resolved CLI implements
#    `hook security-disclosure-gate`. Codex round 1 P1.
probe_out=$("${REA_ARGV[@]}" hook security-disclosure-gate --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'security-disclosure-gate'; then
  # 0.32.0 round-4 P1: a stale/older CLI without the new subcommand is
  # NOT a "harmless availability fallback" for this hook — the bash
  # body it replaces always enforced. Fail closed and tell the
  # operator exactly how to fix.
  printf 'rea: this shim requires the `rea hook security-disclosure-gate` subcommand (introduced in 0.32.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 5. Forward stdin (already captured up-front for the relevance gate).
#    REA_DISCLOSURE_MODE is in env already; the Node binary reads it
#    directly.
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook security-disclosure-gate
exit $?
