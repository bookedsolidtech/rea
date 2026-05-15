#!/bin/bash
# PreToolUse hook: secret-scanner.sh
# 0.34.0+ — Node-binary shim for `rea hook secret-scanner`.
#
# Pre-0.34.0 the gate's full body lived here as bash (230 LOC, the
# awk line filter + 17-pattern catalog + placeholder-rejection + the
# MultiEdit fragment join). The migration to the Node binary moves
# the pattern catalog + filter + placeholder evaluation into
# `src/hooks/secret-scanner/index.ts`. This shim is the Claude Code
# dispatcher's view of the hook — it forwards stdin to the CLI and
# exits with whatever the CLI returns.
#
# Behavioral contract is preserved byte-for-byte: exit 0 on no-match
# or MEDIUM-only advisory, exit 2 on HALT / HIGH match / malformed
# payload.
#
# # Shim short-circuits (codex round-1 P2 fix)
#
# The 0.34.0 round-0 shim deferred ALL decisions to the CLI, including
# empty-content and `.env.example` suffix exclusion. That regressed
# benign workflows on fresh/unbuilt installs: clearing a file or
# editing an example env file would fail closed when `dist/cli/index.js`
# wasn't built yet.
#
# Round-1 P2 fix: replicate the pre-0.34.0 bash body's three
# short-circuits in the shim BEFORE CLI resolution:
#   - Empty content (no `content`, `new_string`, `edits[]`, or
#     `new_source` in the payload) → exit 0 silently.
#   - file_path / notebook_path with `.env.example` or `.env.sample`
#     suffix → exit 0 silently.
# The full pattern catalog + filter + placeholder rejection still
# lives in the CLI.
#
# # CLI-resolution trust boundary
#
# Mirrors the 0.32.0 final shim shape.
#
# # Fail-closed posture
#
# secret-scanner is Write/Edit/MultiEdit/NotebookEdit tier — the
# pre-0.34.0 bash body refused credential-bearing writes without any
# compiled CLI. Early-exit branches fail closed AFTER the shim
# short-circuits.

set -uo pipefail

# 1. HALT check.
# shellcheck source=_lib/halt-check.sh
source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

proj="${CLAUDE_PROJECT_DIR:-$REA_ROOT}"

# 2. Capture stdin once.
INPUT=$(cat)

# 3. Short-circuit: empty-content / file-suffix exclusion. Mirrors
#    the pre-0.34.0 bash body's `[[ -z "$CONTENT" ]] && exit 0` and
#    the `*.env.example | *.env.sample` suffix check. We do these in
#    the shim so unbuilt installs don't fail closed on benign writes.
if command -v jq >/dev/null 2>&1; then
  # Compose content the same way `parseWriteHookPayload` does:
  # priority content > new_string > join(edits[].new_string) > new_source.
  # 0.34.0 round-2 fix: every value goes through `tostring` so a
  # non-string `new_string` (object/number/null) doesn't trip jq with
  # a "Cannot iterate" error → empty CONTENT → exit 0 bypass. Mirrors
  # the 0.14.0 secret-scanner fix that originally closed this class.
  #
  # 0.34.0 round-4 P2 fix: capture jq's exit code SEPARATELY rather
  # than swallowing it with `|| true`. Pre-fix, invalid JSON or a
  # schema mismatch yielded empty CONTENT → exit 0 silent allow.
  # Post-fix we distinguish:
  #   - jq exit 0 + empty CONTENT  → valid payload, no content (the
  #                                  bash hook also exit 0'd here)
  #   - jq exit 0 + non-empty      → enter suffix-check + CLI forward
  #   - jq exit != 0 (parse fail)  → fall through to CLI forward;
  #                                  the CLI re-parses with Zod and
  #                                  refuses on malformed payload
  # The third branch does NOT exit 0 — we want CLI enforcement to
  # decide. The CLI's parser fails closed.
  CONTENT=$(printf '%s' "$INPUT" | jq -r '
    (.tool_input.content // .tool_input.new_string //
      (
        if (.tool_input.edits | type) == "array"
        then (.tool_input.edits | map((.new_string // "") | tostring) | join("\n"))
        else ""
        end
      ) //
      .tool_input.new_source // ""
    ) | tostring
  ' 2>/dev/null)
  jq_content_status=$?
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '
    .tool_input.file_path // .tool_input.notebook_path // ""
  ' 2>/dev/null)
  jq_path_status=$?
  # Only honor the shim short-circuits when BOTH jq probes parsed
  # cleanly. Otherwise forward to the CLI which fails closed via Zod.
  if [ "$jq_content_status" -eq 0 ] && [ "$jq_path_status" -eq 0 ]; then
    if [ -z "$CONTENT" ]; then
      exit 0
    fi
    # Suffix-based exclusion. Mirrors the bash hook's:
    #   if [[ "$FILE_PATH" == *.env.example || "$FILE_PATH" == *.env.sample ]]; then exit 0; fi
    case "$FILE_PATH" in
      *.env.example|*.env.sample) exit 0 ;;
    esac
  fi
  # jq parse failure → do NOT short-circuit. Fall through to the CLI
  # forward at section 7. The CLI will refuse on malformed payload.
fi
# When jq is unavailable, fall through — the CLI does the same parse
# in TypeScript-space and will short-circuit on empty content there.

# 4. Resolve the rea CLI through the fixed 2-tier sandboxed order.
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
  # 4b. Relevance pre-gate (round-7 P1). The round-0 shim refused ALL
  #     writes when the CLI was missing, but the pre-0.34.0 bash body
  #     only refused writes containing credential patterns. On a fresh
  #     install (`npx rea init` flow, pre-`pnpm build` checkout) the
  #     CLI isn't built yet but consumers need to write files — config,
  #     source, docs, etc. Fix: substring scan the content for the
  #     credential markers in the catalog. When CLI is missing AND no
  #     marker matches, exit 0 (the pre-0.34.0 body would have done
  #     the same — no pattern hit). When CLI is missing AND a marker
  #     DOES match, preserve fail-closed (refuse rather than silently
  #     allow a credential-shaped write).
  #
  #     Substrings cover every entry in SECRET_PATTERNS (catalog in
  #     `src/hooks/secret-scanner/index.ts`). Coarse — over-trigger is
  #     fine, under-trigger is the bypass we MUST avoid. Same posture
  #     as the round-7 dangerous-bash relevance pre-gate.
  CONTENT_FOR_SCAN=""
  if [ -n "${CONTENT:-}" ]; then
    CONTENT_FOR_SCAN="$CONTENT"
  else
    # CONTENT may not have been populated (jq missing, parse failure).
    # Fall back to the raw payload so the substring scan still catches
    # credential markers embedded in JSON-string form.
    CONTENT_FOR_SCAN="$INPUT"
  fi
  CRED_RELEVANT=0
  case "$CONTENT_FOR_SCAN" in
    *"AKIA"*) CRED_RELEVANT=1 ;;
    *"AWS_SECRET_ACCESS_KEY"*|*"aws_secret_access_key"*) CRED_RELEVANT=1 ;;
    *"-----BEGIN"*) CRED_RELEVANT=1 ;;
    *"sk-ant-"*) CRED_RELEVANT=1 ;;
    *"ghp_"*|*"ghs_"*|*"gho_"*|*"ghu_"*|*"ghr_"*) CRED_RELEVANT=1 ;;
    *"github_pat_"*) CRED_RELEVANT=1 ;;
    *"sk_live_"*|*"rk_live_"*|*"pk_live_"*) CRED_RELEVANT=1 ;;
    *"sk_test_"*|*"rk_test_"*|*"pk_test_"*) CRED_RELEVANT=1 ;;
    *"whsec_"*) CRED_RELEVANT=1 ;;
    *"SECRET"*|*"PASSWORD"*|*"PRIVATE_KEY"*|*"API_SECRET"*) CRED_RELEVANT=1 ;;
    *"SUPABASE_SERVICE_ROLE_KEY"*|*"SUPABASE_ANON_KEY"*) CRED_RELEVANT=1 ;;
    *"ANTHROPIC_API_KEY"*|*"STRIPE_SECRET"*|*"DATABASE_URL"*) CRED_RELEVANT=1 ;;
    *"postgresql://"*) CRED_RELEVANT=1 ;;
    *"eyJ"*) CRED_RELEVANT=1 ;;  # JWT prefix — catches Supabase keys
  esac
  if [ "$CRED_RELEVANT" -eq 0 ]; then
    # No credential marker. The pre-0.34.0 bash body would have allowed
    # this write — exit 0 to unblock `npx rea init` and pre-build
    # checkouts.
    exit 0
  fi
  # Credential marker matched. Preserve fail-closed posture.
  printf 'rea: secret-scanner cannot run — the rea CLI is not built.\n' >&2
  printf 'Run `pnpm install && pnpm build` (or `npm install` for a consumer install) to restore protection.\n' >&2
  printf 'This shim fails closed because the pre-0.34.0 bash body enforced secret refusal without a CLI.\n' >&2
  exit 2
fi

# 5. Realpath sandbox check.
if ! command -v node >/dev/null 2>&1; then
  printf 'rea: secret-scanner cannot run — `node` is not on PATH.\n' >&2
  printf 'Install Node 22+ (engines.node) to restore credential refusal.\n' >&2
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
  printf 'rea: secret-scanner FAILED sandbox check (%s) — refusing.\n' "$sandbox_check" >&2
  exit 2
fi

# 6. Version-probe.
probe_out=$("${REA_ARGV[@]}" hook secret-scanner --help 2>&1)
probe_status=$?
if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_out" | grep -q -e 'secret-scanner'; then
  printf 'rea: this shim requires the `rea hook secret-scanner` subcommand (introduced in 0.34.0).\n' >&2
  printf 'The resolved CLI at %s does not implement it.\n' "$RESOLVED_CLI_PATH" >&2
  printf 'Run `pnpm install` (or `npm install`) to sync the CLI; refusing in the meantime to preserve enforcement.\n' >&2
  exit 2
fi

# 7. Forward stdin (already captured up-front).
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook secret-scanner
exit $?
