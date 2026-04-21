---
'@bookedsolid/rea': patch
---

docs: cumulative 0.3.0 → 0.9.0 catchup

Documentation-only release. The README, threat model, security policy,
contributor guide, project instructions, and the 0.5.0 migration note
had drifted behind the codebase across the 0.3.0 → 0.9.0 window. No
runtime changes.

- **README.md**: full refresh. Live badges (npm, CI, provenance).
  Version status updated to 0.9.x. `rea status` section now documents
  the per-downstream live block (`name`, `circuit_state`,
  `retry_at`, `connected`, `healthy`, `last_error`,
  `tools_count`, `open_transitions`, `session_blocker_emitted`) and
  names `.rea/serve.state.json` as the live source. New sections
  describe the `__rea__health` meta-tool with default-safe payload
  and the `gateway.health.expose_diagnostics` opt-in, the 0.9.0
  gateway supervisor + SESSION_BLOCKER tracker, the 0.6.1 cross-repo
  guard via `git --git-common-dir`, the 0.6.2 script-anchor fallback
  (BUG-012, scoped to the review-gate hooks — the remaining hooks
  still derive `REA_ROOT` from `${CLAUDE_PROJECT_DIR:-$(pwd)}` and
  that caveat is now called out explicitly), the 0.7.0 shared
  push-review core + native git adapter, 0.8.0 Codex-only waiver
  semantics with cache-gate hardening, 0.3.0 `${VAR}` env
  interpolation with redact-by-default, and the 0.3.0 G9 three-tier
  injection classifier (verdicts `clean` / `suspicious` /
  `likely_injection`) with the strict flag. Middleware-chain diagram
  corrected to place `injection` below the EXECUTE bar (it is a
  post-execute middleware that scans `ctx.result`, not arguments).
  Hook inventory corrected: 14 scripts total ship, 12 registered in
  the default `.claude/settings.json`; the remaining two
  (`commit-review-gate.sh` as a `PreToolUse: Bash` hook matching
  `git commit`, and `push-review-gate-git.sh` as a native-git adapter
  sourcing `hooks/_lib/push-review-core.sh` for consumers who wire a
  wrapper-based `.husky/pre-push`) are shipped ready-to-wire but
  intentionally not registered by default. `rea init`'s default
  installer still emits a standalone inline `.husky/pre-push` body
  (`src/cli/install/pre-push.ts`) rather than a wrapper around the
  adapter; shared-core unification for the husky path is tracked as
  follow-up hardening. Protected-path push-review-gate behavior
  described correctly as hard-block (exit 2) rather than
  advisory-warn, with the Codex waiver documented as the only way
  through the protected-path branch without a fresh `codex.review`
  audit entry; the review cache is a separate later check scoped to
  non-protected-path pushes. `rea doctor` description rewritten to
  list actual checks (`.rea/` dir, policy, registry, agents, hooks,
  `.claude/settings.json`, commit-msg, pre-push, Codex, fingerprint
  store); removed false `.mcp.json` and audit-hash-chain claims.
  Policy reference table adds review/injection/gateway/redact knobs.
- **THREAT_MODEL.md**: header bumped to 0.9.x / 2026-04-21.
  §5.8 rewritten to describe current Codex-only waiver semantics;
  cache-gate hardening scoped correctly to the general (non-protected-
  path) gate rather than the protected-path branch. §6 residual-risks
  table marks shipped items, promotes surviving risks, and restores
  "Catalog drift by downstream not detected on reconnect" as an ACTIVE
  residual risk (the G7 TOFU fingerprint pins registry CONFIG, not
  the `tools/list` response, so catalog drift falls through). New
  sections §5.14 (supervisor trust boundary), §5.15 (SESSION_BLOCKER
  audit semantics), §5.16 (`serve.state.json` atomic writer +
  lock-guarded owner_pid handoff), §5.17 (BUG-011 health payload
  sanitization — the opt-in sanitizer collapses any non-`clean`
  diagnostic to the exported `<redacted: suspected injection>`
  placeholder, full diagnostic still flows into the meta-tool audit
  record sourced pre-sanitize from `pool.healthSnapshot()` inside
  `server.ts`), §5.18 (BUG-012 script-anchor trust boundary —
  `CLAUDE_PROJECT_DIR` is advisory-only for the review-gate hooks
  only), §5.19 (BUG-013 tarball-smoke security-claim gate +
  dist-regression; §5.19 husky-e2e description corrected to reflect
  that the shipped `.husky/pre-push` is the inline body emitted by
  `src/cli/install/pre-push.ts`, with one case swapping in a
  wrapper around `push-review-gate-git.sh` as shape-guard for the
  future installer path), §5.20 (G7 TOFU — REWRITTEN to describe the
  path-only registry-config fingerprint that ships in
  `src/registry/fingerprint.ts`: hashes `name` + `command` + `args`
  + env KEY SET + `env_passthrough` + `tier_overrides`, explicitly
  NOT tool-surface and NOT binary), §5.21 (G9 three-tier injection
  classifier — verdicts are `clean` / `suspicious` /
  `likely_injection`). §7 defense-in-depth summary updated to match
  the corrected hook-inventory framing. Source file refs corrected
  to actual paths (`src/gateway/server.ts`,
  `src/gateway/downstream.test.ts`).
- **SECURITY.md**: supported-versions matrix updated to 0.9.x active /
  0.8.x critical-fixes-only / older superseded. Hook count and
  registration nuance aligned with the README. `set -euo pipefail`
  claim tightened to cover the `set -uo pipefail` variant used by
  stdin-JSON hooks. Adds pointer to §5.18 for the script-anchor
  trust model.
- **CLAUDE.md**: managed block reflects current policy state (4
  blocked_paths, not 8). Project status updated to 0.9.x. Hook
  reference now lists the Claude-Code + native-git push adapters
  separately, describes the shared `_lib/push-review-core.sh`, and
  calls out that the default `rea init` husky installer still emits
  an inline pre-push body rather than a wrapper.
- **MIGRATION-0.5.0.md**: forward-pointer added at the top flagging
  the 0.8.0 `REA_SKIP_CODEX_REVIEW` narrowing as the one breaking
  semantic between 0.5.0 and 0.9.0.
- **src/cli/status.ts**: top-of-file docblock updated to describe the
  0.9.0 per-downstream live block and the terminal-escape sanitizer on
  disk-sourced fields.
- **.rea/policy.yaml**: removes `THREAT_MODEL.md`, `SECURITY.md`,
  `CODEOWNERS`, and `.rea/policy.yaml` from the dogfood install's
  `blocked_paths`. Per-file post-change enforcement:
  - `.rea/policy.yaml` — still locally gated by
    `settings-protection.sh` (hardcoded). No change in local
    enforcement.
  - `SECURITY.md`, `THREAT_MODEL.md`, `CODEOWNERS` — local hook gate
    removed. Enforcement is now CODEOWNERS + DCO + branch protection
    at the GitHub layer only. Intentional — these are maintainer-
    authored reference docs and the prior double-gate created a
    chicken-and-egg problem when `THREAT_MODEL.md` itself needed an
    update.

  Always-blocked invariants (`.env`, `.env.*`, `.rea/HALT`,
  `.github/workflows/release.yml`) remain in place.
