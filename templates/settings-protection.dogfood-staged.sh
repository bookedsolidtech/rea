#!/bin/bash
# PreToolUse hook: settings-protection.sh
# 0.35.0+ — Node-binary shim for `rea hook settings-protection`.
#
# Pre-0.35.0 this was the LARGEST hook in the repo at 582 LOC of bash:
# §5a `..` traversal reject, §5a-bis interior `/./` reject, §5b
# extension-surface allow-list (with final-component + intermediate-
# directory symlink refusal), §6 hard-protected pattern resolution
# (PROTECTED_PATTERNS sourced from `_lib/protected-paths.sh` with
# `protected_writes` override + `protected_paths_relax` subtractor),
# §6c intermediate-symlink resolution against the hard-protected list,
# §6b REA_HOOK_PATCH_SESSION unlock for .claude/hooks/ with hash-
# chained audit append (fail-closed). The full bash body is preserved
# at `__tests__/hooks/parity/baselines/settings-protection.sh.pre-0.35.0`.
#
# The migration moves every section into
# `src/hooks/settings-protection/index.ts`. This shim is the Claude Code
# dispatcher's view of the hook — it forwards stdin to the CLI and
# exits with whatever the CLI returns.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on allow,
# exit 2 on HALT / traversal-reject / interior-dot-reject / protected
# match / patch-session-mismatch / malformed payload.
#
# # CLI-resolution trust boundary
#
# Mirrors the 0.32.0 final shim shape.
#
# # Fail-closed posture
#
# settings-protection is THE gate protecting the entire governance layer
# from agent self-disable. Pre-0.35.0 the bash body enforced refusal
# without any compiled CLI; the Node-binary port preserves that — early-
# exit branches fail closed AFTER the relevance pre-gate passes.
#
# # Relevance pre-gate
#
# Substring scan over the extracted file_path / notebook_path for the
# protected-path markers (.claude/, .husky/, .rea/policy.yaml, .rea/HALT,
# the verdict cache paths, plus any policy.blocked_paths entry). When
# CLI is missing AND none of these substrings appear in the payload's
# file path, exit 0. The pre-0.35.0 bash body would have allowed.
#
# # Bootstrap safety
#
# This shim is ITSELF protected by `settings-protection.sh`. The new
# shim must not block legitimate writes — the `bash -n` syntax check
# in the test:bash-syntax script catches parse errors BEFORE the
# install lands them. The relevance pre-gate keeps benign writes (like
# editing `src/foo.ts`) exiting 0 even when the CLI is missing.

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
  CLI_MISSING_RELEVANT=0
  case "$CLI_MISSING_FILE_PATH" in
    *".claude/settings"*) CLI_MISSING_RELEVANT=1 ;;
    *".claude/hooks/"*) CLI_MISSING_RELEVANT=1 ;;
    *".husky/"*) CLI_MISSING_RELEVANT=1 ;;
    *".rea/policy.yaml"*) CLI_MISSING_RELEVANT=1 ;;
    *".rea/HALT"*) CLI_MISSING_RELEVANT=1 ;;
    *".rea/last-review"*) CLI_MISSING_RELEVANT=1 ;;
    *".claude\\"*|*".husky\\"*|*".rea\\"*) CLI_MISSING_RELEVANT=1 ;;
    *"..%2F"*|*"%2E%2E"*) CLI_MISSING_RELEVANT=1 ;;
  esac
  # Codex round-1 P2 fix: scan policy.protected_writes entries too so a
  # consumer-defined protected path isn't silently allowed when the CLI
  # is missing.
  if [ "$CLI_MISSING_RELEVANT" -eq 0 ]; then
    POLICY_FILE="${REA_ROOT}/.rea/policy.yaml"
    if [ -f "$POLICY_FILE" ]; then
      while IFS= read -r entry; do
        [ -z "$entry" ] && continue
        base="$entry"
        case "$base" in
          */) base="${base%/}" ;;
        esac
        [ -z "$base" ] && continue
        case "$CLI_MISSING_FILE_PATH" in
          *"$base"*) CLI_MISSING_RELEVANT=1; break ;;
        esac
      done < <(awk '
        /^protected_writes:/ { in_block=1; next }
        in_block && /^[[:space:]]*-/ {
          sub(/^[[:space:]]*-[[:space:]]*/, "")
          gsub(/^["'\'']/, "")
          gsub(/["'\'']$/, "")
          print
          next
        }
        in_block && /^[^[:space:]-]/ { in_block=0 }
      ' "$POLICY_FILE" 2>/dev/null)
    fi
  fi
  if [ "$CLI_MISSING_RELEVANT" -eq 0 ]; then
    exit 0
  fi
  printf 'rea: settings-protection cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  printf 'This shim fails closed because the pre-0.35.0 bash body enforced protected-path refusal without a CLI.\n' >&2
  exit 2
fi

# 4. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: settings-protection cannot run — `node` is not on PATH.\n' >&2
  printf 'Install Node 22+ (engines.node) to restore protected-path refusal.\n' >&2
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
  // Codex round-1 P1 fix: enforce dist/cli/index.js shape so a
  // workspace attacker who repoints node_modules/@bookedsolid/rea or
  // dist at an arbitrary in-project JS file cannot execute it as the
  // trusted gate CLI. Pre-0.35.0 shims had this check; the 0.34.0
  // round-8 template dropped it; restored here.
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
  printf 'rea: settings-protection FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 5. Version-probe.
probe_out=$("${REA_ARGV[@]}" hook settings-protection --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'settings-protection'; then
  printf 'rea: this shim requires the `rea hook settings-protection` subcommand (introduced in 0.35.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 6. Forward stdin (already captured up-front).
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook settings-protection
exit $?
