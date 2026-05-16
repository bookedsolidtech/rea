#!/bin/bash
# PreToolUse hook: blocked-paths-enforcer.sh
# 0.35.0+ — Node-binary shim for `rea hook blocked-paths-enforcer`.
#
# Pre-0.35.0 the gate's full body lived here as bash (284 LOC). The
# full bash body is preserved at
# `__tests__/hooks/parity/baselines/blocked-paths-enforcer.sh.pre-0.35.0`.
#
# Migration moves the enforcement logic (path normalization, traversal
# reject, glob/prefix/exact matching, symlink resolution, agent-
# writable allow-list) into `src/hooks/blocked-paths-enforcer/index.ts`.
# This shim is the Claude Code dispatcher's view of the hook — it
# forwards stdin to the CLI and exits with whatever the CLI returns.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on allow,
# exit 2 on HALT / blocked-paths match / malformed payload.
#
# # CLI-resolution trust boundary
#
# Mirrors the 0.32.0 final shim shape.
#
# # Fail-closed posture
#
# blocked-paths-enforcer is a Write/Edit/MultiEdit/NotebookEdit tier
# security gate. The pre-0.35.0 bash body refused on uncertainty.
# Early-exit branches fail closed AFTER the relevance pre-gate passes.
#
# # Relevance pre-gate
#
# Extract file_path / notebook_path from the payload, substring-scan
# against the policy's blocked_paths entries. When CLI is missing AND
# no policy.blocked_paths entry matches, exit 0. Empty/missing policy
# → no enforcement, exit 0.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Capture stdin once.
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

# 3b. Relevance pre-gate. Only used when the CLI is missing.
if [ "${#REA_ARGV[@]}" -eq 0 ]; then
  CLI_MISSING_FILE_PATH=""
  if command -v jq >/dev/null 2>&1; then
    CLI_MISSING_FILE_PATH=$(printf '%s' "$INPUT" | jq -r '
      (.tool_input.file_path // .tool_input.notebook_path // "") | tostring
    ' 2>/dev/null || true)
  else
    CLI_MISSING_FILE_PATH="$INPUT"
  fi
  if [ -z "$CLI_MISSING_FILE_PATH" ]; then
    exit 0
  fi
  POLICY_FILE="${REA_ROOT}/.rea/policy.yaml"
  if [ ! -f "$POLICY_FILE" ]; then
    exit 0
  fi
  # 0.37.0: route blocked_paths reads through the unified
  # policy-reader (Tier 1 CLI → Tier 2 python3 → Tier 3 awk
  # block-form). Pre-0.37.0 the inline awk parser missed flow-form
  # arrays (`blocked_paths: [.env, .env.*, ...]`), silently allowing
  # writes to those paths when the CLI was unreachable. The 4-tier
  # ladder closes the bypass via Tier 2 when python3 + PyYAML are
  # reachable; Tier 3 preserves the pre-0.37.0 block-only posture as
  # a no-dep fallback.
  # shellcheck source=_lib/policy-reader.sh
  source "$(dirname "$0")/_lib/policy-reader.sh"
  CLI_MISSING_RELEVANT=0
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    # Substring scan — for directory prefixes the entry ends with /
    # and any file_path under it matches. Glob entries fall back to
    # the same substring test (over-trigger is fine — the CLI does
    # the precise evaluation when reachable).
    base="$entry"
    case "$base" in
      */) base="${base%/}" ;;
    esac
    # Strip glob wildcards for substring testing — `src/*.ts` becomes
    # `src/` + `.ts`. The simplest safe form is to scan the literal
    # part before the first `*`.
    case "$base" in
      *'*'*) base="${base%%\**}" ;;
    esac
    [ -z "$base" ] && continue
    case "$CLI_MISSING_FILE_PATH" in
      *"$base"*) CLI_MISSING_RELEVANT=1; break ;;
    esac
  done < <(policy_reader_get_list blocked_paths 2>/dev/null)
  if [ "$CLI_MISSING_RELEVANT" -eq 0 ]; then
    exit 0
  fi
  printf 'rea: blocked-paths-enforcer cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  printf 'This shim fails closed because the pre-0.35.0 bash body enforced blocked_paths refusal without a CLI.\n' >&2
  exit 2
fi

# 4. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: blocked-paths-enforcer cannot run — `node` is not on PATH.\n' >&2
  printf 'Install Node 22+ (engines.node) to restore blocked_paths refusal.\n' >&2
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
  // Codex round-1 P1 fix: enforce dist/cli/index.js shape (see
  // settings-protection.sh).
  const expectedEnd = path.join("dist", "cli", "index.js");
  if (!real.endsWith(path.sep + expectedEnd) && real !== "/" + expectedEnd) {
    process.stdout.write("bad:cli-shape"); process.exit(1);
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
  printf 'rea: blocked-paths-enforcer FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 5. Version-probe.
probe_out=$("${REA_ARGV[@]}" hook blocked-paths-enforcer --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'blocked-paths-enforcer'; then
  printf 'rea: this shim requires the `rea hook blocked-paths-enforcer` subcommand (introduced in 0.35.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 6. Forward stdin (already captured up-front).
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook blocked-paths-enforcer
exit $?
