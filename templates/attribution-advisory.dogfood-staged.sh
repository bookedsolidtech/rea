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
#
# Codex round 2 P1 (2026-05-16): the sandbox check now runs BEFORE
# the policy read. The pre-round-2 order called
# `policy_reader_get block_ai_attribution` first; that read invokes
# the resolved CLI through Tier 1 of the unified reader — meaning an
# unsandboxed CLI executed BEFORE the sandbox guard fired. Fixed by
# validating sandbox first; on failure REA_ARGV is cleared so the
# reader degrades to Tier 2 / Tier 3 (both pure file-parse, no
# arbitrary-code-execution).

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

# 2b. Resolve the rea CLI first — the unified policy reader uses
#     REA_ARGV (when populated) as its Tier 1 source. Reordered from
#     the pre-0.37.0 shape (where the CLI was resolved AFTER the policy
#     grep) so the policy short-circuit below can route through Tier 1
#     when the CLI is reachable, falling through Tier 2 (python3 +
#     PyYAML) and Tier 3 (awk block-form) on stale/unbuilt installs.
REA_ARGV=()
RESOLVED_CLI_PATH=""
if [ -f "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js" ]; then
  REA_ARGV=(node "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/node_modules/@bookedsolid/rea/dist/cli/index.js"
elif [ -f "$proj/dist/cli/index.js" ]; then
  REA_ARGV=(node "$proj/dist/cli/index.js")
  RESOLVED_CLI_PATH="$proj/dist/cli/index.js"
fi

# 2c. Realpath sandbox check — MUST run BEFORE any policy read that
#     could route through Tier 1 (CLI). Codex round 2 P1: previously
#     the policy_reader_get call below executed the resolved CLI to
#     read `block_ai_attribution`. An attacker who symlinked
#     dist/cli/index.js → /tmp/forged-tree (or who otherwise compromised
#     the path) would have their forged CLI invoked during policy
#     lookup BEFORE the sandbox check ran — defeating the trust
#     boundary this shim is supposed to enforce.
#
#     Fix: validate the CLI's sandbox shape first. On failure, clear
#     REA_ARGV so the unified policy reader falls back to Tier 2
#     (python3 + PyYAML) / Tier 3 (awk block-form) and the unsafe CLI
#     never runs. The shim then re-evaluates fail-closed posture at
#     §2e below (CLI absent + attribution-enabled → exit 2).
#
#     Other 5 migrated shims (e.g. delegation-advisory) naturally avoid
#     this ordering bug because their policy reads are NESTED inside
#     `if [ "${#REA_ARGV[@]}" -eq 0 ]` (the CLI-absent path). This
#     shim's flow is different — it reads policy unconditionally to
#     decide whether to fail-closed at all.
SANDBOX_CHECK_RESULT=""
if [ "${#REA_ARGV[@]}" -gt 0 ]; then
  if ! command -v node >/dev/null 2>&1; then
    # No node on PATH — cannot run sandbox probe. Clear REA_ARGV so
    # the policy reader skips Tier 1; later §2e will catch the
    # CLI-required-but-absent state and refuse explicitly.
    SANDBOX_CHECK_RESULT="bad:no-node"
    REA_ARGV=()
  else
    SANDBOX_CHECK_RESULT=$(node -e '
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
    if [ "$SANDBOX_CHECK_RESULT" != "ok" ]; then
      # Sandbox failed — drop the unsafe CLI from REA_ARGV BEFORE
      # reading policy. The unified reader will degrade to Tier 2 /
      # Tier 3, both of which only read the policy file (no
      # arbitrary-code-execution risk).
      REA_ARGV=()
    fi
  fi
fi

# 2d. Policy short-circuit (round-6 P2, generalized in 0.37.0). The
#     pre-0.32.0 bash body no-op'd when `block_ai_attribution` was
#     absent or false. Without this check, an unbuilt/stale install
#     would refuse `git commit` even on repos that DELIBERATELY
#     disable the attribution gate.
#
#     0.37.0: route through `policy_reader_get` (4-tier ladder). The
#     pre-0.37.0 grep matched ONLY block-form `block_ai_attribution:
#     true`; inline-form (`block_ai_attribution: true` at any nesting
#     accident) and quoted-form variants were missed. The reader's
#     Tier 1 / Tier 2 paths handle both forms identically to the
#     canonical TS loader; Tier 3 preserves the pre-0.37.0 block-only
#     posture as a graceful-degrade fallback.
#
#     Codex round 2 P1: by the time we reach this line, REA_ARGV is
#     EITHER (a) populated and sandbox-validated, OR (b) empty — never
#     populated-but-untrusted. The policy reader can safely use Tier 1.
# shellcheck source=_lib/policy-reader.sh
source "$(dirname "$0")/_lib/policy-reader.sh"
ATTR_ENABLED=$(policy_reader_get block_ai_attribution)
if [ "$ATTR_ENABLED" != "true" ]; then
  # Attribution blocking disabled (or unreadable on Tier 3 fallback +
  # missing policy file) — pre-0.32.0 bash body would have exited 0
  # here. Don't refuse on stale-install grounds.
  exit 0
fi

# 2e. CLI required from here on — we need the parser-backed Node binary
#     to scan for attribution patterns. If REA_ARGV is empty because
#     either (a) the CLI wasn't installed/built or (b) sandbox check
#     failed and we cleared it above, refuse explicitly with a tailored
#     message.
if [ "${#REA_ARGV[@]}" -eq 0 ]; then
  if [ -n "$SANDBOX_CHECK_RESULT" ] && [ "$SANDBOX_CHECK_RESULT" != "ok" ]; then
    # Sandbox failure path — preserve forensic detail.
    printf 'rea: attribution-advisory FAILED sandbox check (%s) — refusing.\n' "$SANDBOX_CHECK_RESULT" >&2
    exit 2
  fi
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

# 3. Version-probe: confirm the resolved CLI implements
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

# 4. Forward stdin (already captured up-front for the relevance gate).
printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook attribution-advisory
exit $?
