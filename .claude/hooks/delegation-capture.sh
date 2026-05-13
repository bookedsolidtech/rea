#!/bin/bash
# PreToolUse hook: delegation-capture.sh
# 0.29.0+ — delegation-telemetry MVP.
#
# Fires BEFORE every `Agent` or `Skill` tool call. Reads the Claude
# Code hook payload from stdin, pipes it to
# `rea hook delegation-signal --detach`, and exits 0 immediately.
#
# The signal is OBSERVATIONAL — never gates tool dispatch. Worst-case
# latency budget is ~50ms even when the audit chain is under
# cross-process contention, because the audit append runs in the
# background (via `&`) and the CLI subcommand itself only validates
# the payload before forking the writer.
#
# Matcher: `Agent|Skill` (NOT `Task|Skill` — `TaskCreate`/`TaskList`
# are the unrelated todo-list tools and MUST NOT match).
#
# # CLI-resolution trust boundary
#
# Codex round 3 P1 (2026-05-12): pre-fix this hook resolved the rea
# binary via `$REA_ROOT/node_modules/.bin/rea` then PATH-walked
# `command -v rea`. Either path was attacker-influenced in a consumer
# repo with a forged `node_modules/.bin/rea` symlink or a
# PATH-prepended fake `rea` binary — giving attacker-controlled code
# execution on every Agent/Skill dispatch.
#
# Fix: this hook now uses the same 2-tier sandboxed resolution that
# protected-paths-bash-gate.sh + blocked-paths-bash-gate.sh use:
#   1. node_modules/@bookedsolid/rea/dist/cli/index.js (consumer-side
#      published artifact)
#   2. dist/cli/index.js under CLAUDE_PROJECT_DIR (the rea repo's own
#      dogfood install)
#
# A realpath sandbox check ensures the resolved CLI lives INSIDE
# realpath(CLAUDE_PROJECT_DIR) — catches symlink-out attacks.
#
# Exit codes:
#   0 — always (under normal operation). Failure to write the audit
#       signal must NEVER block Claude Code's tool dispatch. Stderr
#       breadcrumbs surface diagnostic info to the operator. HALT
#       still exits 2 because the kill-switch contract must hold.
#   2 — HALT active.

set -uo pipefail

# 1. HALT check. Even though this hook is observational, refusing to
#    emit signals while frozen matches the rest of the hook tree and
#    keeps the kill-switch contract uniform.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Resolve the rea CLI through the same fixed 2-tier sandboxed order
#    the protected-paths / blocked-paths bash gates use. PATH lookup
#    is INTENTIONALLY OMITTED — agent-controlled $PATH would let a
#    forged `rea` binary on a consumer machine intercept the
#    delegation signal on every Agent/Skill dispatch. The trade-off:
#    consumers MUST have `@bookedsolid/rea` installed under
#    `node_modules` (the common case after `pnpm i`) OR be running
#    against the rea repo's own dogfood (where dist/cli/index.js
#    holds the canonical CLI). Other install shapes silently drop the
#    signal — matching the bash-gate posture.
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
  # No rea CLI in scope — drop the signal silently. This is the
  # expected state during bootstrap (consumer ran `rea init` but
  # hasn't installed the npm package yet) or in non-rea repos. A
  # noisy stderr warning here would fire on every Agent/Skill
  # dispatch and drown legitimate signals.
  exit 0
fi

# 3. Realpath sandbox check — mirrors protected-paths-bash-gate.sh §6.
#    The resolved CLI MUST live inside realpath(CLAUDE_PROJECT_DIR)
#    AND have an ancestor package.json declaring `@bookedsolid/rea`
#    as its `name`. Catches symlink-out attacks where an attacker
#    writes node_modules/@bookedsolid/rea → /tmp/forged-tree.
if ! command -v node >/dev/null 2>&1; then
  # Node not on PATH — we can't verify the CLI shape. Fail safe by
  # dropping the signal (observability is not a security claim; the
  # rest of the Bash gate suite refuses on this path).
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
  # become spammy on every dispatch.
  printf 'rea: delegation-capture skipped (sandbox check: %s)\n' "$sandbox_check" >&2
  exit 0
fi

# 4. Read stdin and pipe to the CLI. `--detach` tells the CLI to
#    suppress stderr output (no parent shell is listening); we ALSO
#    background the whole pipeline with `&` and `disown` so the
#    shell hook returns instantly even if the CLI's own startup
#    takes a few ms.
INPUT=$(cat)
{
  printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook delegation-signal --detach \
    >/dev/null 2>&1 &
  disown 2>/dev/null || true
} 2>/dev/null

exit 0
