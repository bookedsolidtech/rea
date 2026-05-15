#!/bin/bash
# PreToolUse hook: changeset-security-gate.sh
# 0.33.0+ — Node-binary shim for `rea hook changeset-security-gate`.
#
# Pre-0.33.0 the gate's full body lived here as bash (172 LOC, frontmatter
# validation + GHSA/CVE scan + MultiEdit-aware tool handling). The
# migration to the parser-backed Node binary moves all of that into
# `src/hooks/changeset-security-gate/index.ts`.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on
# pass-through / non-changeset / valid frontmatter, exit 2 on HALT /
# disclosure leak / malformed frontmatter / malformed payload.
#
# # CLI-resolution trust boundary
#
# Realpath sandbox check + version probe. Same shape as the 0.32.0
# pilots.
#
# # Fail-closed posture
#
# changeset-security-gate is BLOCKING-tier — the pre-0.33.0 bash body
# refused on GHSA/CVE patterns and on malformed frontmatter. Early-exit
# branches fail closed AFTER the relevance pre-gate passes.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Relevance pre-gate. This is a PreToolUse Write/Edit/MultiEdit/
#    NotebookEdit matcher, so the payload always has a `tool_input.
#    file_path` (or `notebook_path`).
#
#    2026-05-15 codex round-2 P2 fix: scan `tool_input.file_path` /
#    `tool_input.notebook_path` ONLY, NOT the raw JSON payload. Pre-fix
#    a Write to `README.md` whose body merely mentions `.changeset/`
#    (e.g. "See .changeset/example.md") tripped the fail-closed branch
#    when the CLI was unbuilt — the substring lived in the
#    tool_input.content blob, not in the target path. The Node body
#    correctly filters by file_path; the shim's pre-gate must match
#    that posture.
INPUT=$(cat)
RELEVANT=0
PROBE=""
if command -v jq >/dev/null 2>&1; then
  PROBE=$(printf '%s' "$INPUT" | jq -r '(.tool_input.file_path // .tool_input.notebook_path // "")' 2>/dev/null || true)
  if printf '%s' "$PROBE" | grep -qE '\.changeset/'; then
    RELEVANT=1
  fi
else
  if printf '%s' "$INPUT" | grep -qE '\.changeset/'; then
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
  printf 'rea: changeset-security-gate cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  exit 2
fi

# 4. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: changeset-security-gate cannot run — `node` is not on PATH.\n' >&2
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
  printf 'rea: changeset-security-gate FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 5. Version-probe.
probe_out=$("${REA_ARGV[@]}" hook changeset-security-gate --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'changeset-security-gate'; then
  printf 'rea: this shim requires the `rea hook changeset-security-gate` subcommand (introduced in 0.33.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 6. Forward stdin.
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook changeset-security-gate
exit $?
