---
'@bookedsolid/rea': minor
---

Extract `_lib/shim-runtime.sh` — shared Node-binary shim runtime.

Releases 0.32.0 → 0.35.0 ported all 14 PreToolUse/PostToolUse hooks
from bash to Node-binary CLIs. Each port left a ~120-LOC shell shim
that did the same five things: HALT check, stdin capture, 2-tier
sandboxed CLI resolution, realpath sandbox check, version probe +
forward. The duplication was the single largest source of drift bugs
in the marathon — every round of codex review found at least one
shim that had drifted from its siblings (e.g. settings-protection.sh
gained the `dist/cli/index.js` shape check at 0.35.0 codex round-1
while three sibling bash-tier shims silently lacked it).

0.38.0 consolidates the duplicated infrastructure into a single
sourced helper: `hooks/_lib/shim-runtime.sh`. Each shim becomes
~20-80 LOC of hook-specific customization plus a one-line
`shim_run` invocation. The shared lib exposes:

- `shim_resolve_cli` — 2-tier sandboxed resolver (node_modules →
  dist/, PATH intentionally omitted).
- `shim_sandbox_check` — realpath + ancestor `package.json` +
  optional `dist/cli/index.js` shape enforcement.
- Standardized banners (`shim_emit_cli_missing_banner`,
  `shim_emit_sandbox_failure_banner`, advisory + blocking version-
  skew banners).
- `shim_run` — the orchestrator: HALT → stdin capture → relevance
  pre-gate → CLI resolution → sandbox check → policy short-circuit
  → version probe → forward.

Customization knobs (env vars):

- `SHIM_NAME` (required) — subcommand name.
- `SHIM_INTRODUCED_IN` (required) — version string for the version-
  skew banner.
- `SHIM_FAIL_OPEN` — 1 = advisory (exit 0 on CLI failures); 0 =
  blocking (exit 2).
- `SHIM_ENFORCE_CLI_SHAPE` — 1 = require `dist/cli/index.js` shape
  on the resolved CLI (closes 0.35.0 codex round-1 P1).
- `SHIM_SKIP_VERSION_PROBE` — 1 = skip the version probe (used by
  delegation-capture which is fire-and-forget).

Optional callbacks (shim defines as bash functions):

- `shim_is_relevant` — early-exit 0 on irrelevant payloads.
- `shim_cli_missing_relevant` — relevance check when CLI is missing
  (mirrors the pre-port body's keyword scan).
- `shim_policy_short_circuit` — disable-by-policy short-circuit
  (used by attribution-advisory).
- `shim_forward` — override the default stdin-forward step (used
  by delegation-capture for fire-and-forget detach).

Migration:

- 14 shims migrated to the shared runtime (avg ~50 LOC each, down
  from ~120 LOC).
- 1 shim kept hand-rolled by design: `local-review-gate.sh` runs the
  CLI sandbox check BEFORE policy reads (round-5 P1) and its
  relevance scan is policy-driven via `review.local_review.refuse_at`
  (round-1 P2). It still uses the shared helpers
  (`shim_resolve_cli`, `shim_sandbox_check`, banner emitters).
- 16 dogfood mirrors staged as `templates/<name>.dogfood-staged.sh`
  for the operator to apply via `git apply` (mirrors are under
  `.claude/hooks/` which is protected).

Net LOC delta: ~−1900 across `hooks/*.sh` (3140 → 1240, including
the new 280-LOC `_lib/shim-runtime.sh`). Every existing shim test
suite passes against the migrated shims (31 tests across
`dangerous-bash-interceptor-shim.test.ts`,
`secret-scanner-shim.test.ts`, `local-review-gate-shim.test.ts`).

New tests: `__tests__/hooks/_lib/shim-runtime.test.ts` (37 cases
covering HALT, relevance, CLI-missing, sandbox, policy short-
circuit, version probe, forward, and the line-budget regression
assertion).
