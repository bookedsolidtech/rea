#!/bin/bash
# PostToolUse hook: delegation-advisory.sh
# 0.31.0+ — delegation-telemetry completion (the *nudge*).
#
# Fires AFTER every write-class tool call. The settings.json matcher is
# `Bash|Edit|Write|MultiEdit|NotebookEdit`. Reads the Claude Code hook
# payload from stdin, pipes it to `rea hook delegation-advisory`, and
# exits 0.
#
# 0.29.0 shipped the delegation-telemetry *observability* layer
# (`delegation-capture.sh` + `rea audit specialists`). 0.31.0 closes the
# loop with the *nudge*: `rea hook delegation-advisory` maintains a
# per-session write-class counter and, the FIRST time that counter
# crosses `policy.delegation_advisory.threshold` while the session has
# recorded zero real delegation signals, prints a one-time stderr
# advisory ("this session has done a lot of work without delegating to
# a specialist").
#
# # Advisory, never gating
#
# This hook ALWAYS exits 0 (under normal operation). The advisory is a
# nudge — it never blocks a tool call. The ONLY non-zero exit is 2
# under HALT, to keep the kill-switch contract uniform with the rest of
# the hook tree.
#
# # Synchronous, NOT detached
#
# Unlike `delegation-capture.sh` (which backgrounds `rea hook
# delegation-signal` with `& disown` because the audit write must not
# block tool dispatch), this hook runs the CLI SYNCHRONOUSLY. The
# advisory text must reach the operator's stderr before the hook
# returns — backgrounding it would race the hook's own exit and the
# message could be lost or interleaved with the next tool call's
# output. The CLI is cheap on the hot path: below the threshold it
# only bumps an integer counter file and exits, no audit scan, no
# roster discovery.
#
# # CLI-resolution trust boundary
#
# Same 2-tier sandboxed resolution `delegation-capture.sh`,
# `protected-paths-bash-gate.sh`, and `blocked-paths-bash-gate.sh` use:
#   1. node_modules/@bookedsolid/rea/dist/cli/index.js (consumer-side
#      published artifact)
#   2. dist/cli/index.js under CLAUDE_PROJECT_DIR (the rea repo's own
#      dogfood install)
# PATH lookup is INTENTIONALLY OMITTED — agent-controlled $PATH would
# let a forged `rea` binary intercept this hook on every write-class
# tool call. A realpath sandbox check ensures the resolved CLI lives
# INSIDE realpath(CLAUDE_PROJECT_DIR) with an ancestor package.json
# declaring `@bookedsolid/rea`.
#
# Exit codes:
#   0 — always (under normal operation). Disabled-by-policy,
#       below-threshold, already-fired, just-fired — all exit 0.
#   2 — HALT active.

set -uo pipefail

# 1. HALT check. Even though this hook is advisory, refusing to run
#    while frozen matches the rest of the hook tree and keeps the
#    kill-switch contract uniform.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Resolve the rea CLI through the fixed 2-tier sandboxed order.
#    PATH lookup is omitted on purpose (see header). Other install
#    shapes silently drop the advisory — matching the bash-gate
#    posture; the nudge is a convenience, not a security claim.
REA_ARGV=()
RESOLVED_CLI_PATH=""
if [ -f "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js" ]; then
  REA_ARGV=(node "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/node_modules/@bookedsolid/rea/dist/cli/index.js"
elif [ -f "$proj/dist/cli/index.js" ]; then
  # rea repo dogfood: the project IS @bookedsolid/rea.
  REA_ARGV=(node "$proj/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/dist/cli/index.js"
fi

if [ "${#REA_ARGV[@]}" -eq 0 ]; then
  # No rea CLI in scope — drop the advisory silently. This is the
  # expected state during bootstrap (consumer ran `rea init` but
  # hasn't installed the npm package yet) or in non-rea repos. A
  # noisy stderr warning here would fire on every write-class tool
  # call and drown legitimate output.
  exit 0
fi

# 3. Realpath sandbox check — mirrors delegation-capture.sh §3 and
#    protected-paths-bash-gate.sh §6. The resolved CLI MUST live inside
#    realpath(CLAUDE_PROJECT_DIR) AND have an ancestor package.json
#    declaring `@bookedsolid/rea` as its `name`. Catches symlink-out
#    attacks where an attacker writes
#    node_modules/@bookedsolid/rea → /tmp/forged-tree.
if ! command -v node >/dev/null 2>&1; then
  # Node not on PATH — we can't verify the CLI shape. Fail safe by
  # dropping the advisory (it is not a security claim; the rest of
  # the Bash gate suite refuses on this path).
  exit 0
fi

sandbox_check=$(node -e '
  const fs = require("fs");
  const path = require("path");
  const cli = process.argv[1];
  const projDir = process.argv[2];
  let real, realProj;
  try { real = fs.realpathSync(cli); } catch (e) {
    process.stdout.write("bad:realpath");
    process.exit(1);
  }
  try { realProj = fs.realpathSync(projDir); } catch (e) {
    process.stdout.write("bad:realpath-proj");
    process.exit(1);
  }
  const sep = path.sep;
  const projWithSep = realProj.endsWith(sep) ? realProj : realProj + sep;
  if (!(real === realProj || real.startsWith(projWithSep))) {
    process.stdout.write("bad:cli-escapes-project");
    process.exit(1);
  }
  // Walk up looking for package.json with the protected name.
  let cur = path.dirname(path.dirname(path.dirname(real))); // pkg root
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
  if (!found) {
    process.stdout.write("bad:no-rea-pkg-json");
    process.exit(1);
  }
  process.stdout.write("ok");
' -- "$RESOLVED_CLI_PATH" "$proj" 2>/dev/null)

if [ "$sandbox_check" != "ok" ]; then
  # CLI failed the sandbox check — silent drop. The forensic
  # breadcrumb in stderr is intentional but trimmed so this doesn't
  # become spammy on every tool call.
  printf 'rea: delegation-advisory skipped (sandbox check: %s)\n' "$sandbox_check" >&2
  exit 0
fi

# 4. Read stdin and pipe to the CLI SYNCHRONOUSLY. The advisory must
#    print before this hook returns — see the "Synchronous" note in
#    the header. We pass CLAUDE_PROJECT_DIR through explicitly so the
#    CLI resolves the same REA_ROOT this shim did. The CLI's own exit
#    code is the hook's exit code: 0 normally, 2 under HALT (the CLI
#    re-checks HALT itself for defense-in-depth).
INPUT=$(cat)
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook delegation-advisory
exit $?
