---
'@bookedsolid/rea': minor
---

feat(0.33.0): Node-binary hook playbook — 4 tier-1 advisory/single-purpose ports

Continues the 0.32.0 Phase 1 playbook (which ported `pr-issue-link-gate`,
`security-disclosure-gate`, and `attribution-advisory` from bash to a
parser-backed Node binary + 120-line shim). This release ports the
tier-1 (lowest-risk) advisory and single-purpose gates: pure mechanical
application of the playbook, no new surfaces.

## Hooks ported

| Hook | Pre-0.33.0 LOC | Mode | Network |
|------|----------------|------|---------|
| `env-file-protection.sh` | 124 | PreToolUse Bash | no |
| `dependency-audit-gate.sh` | 179 | PreToolUse Bash | yes (`npm view`) |
| `changeset-security-gate.sh` | 172 | PreToolUse Write/Edit/MultiEdit/NotebookEdit | no |
| `architecture-review-gate.sh` | 101 | PostToolUse Write/Edit | no |

For each: archived pre-0.33.0 bash body under
`__tests__/hooks/parity/baselines/<name>.sh.pre-0.33.0`, added
`src/hooks/<name>/index.ts` (pure async `runX(opts): Promise<{ exitCode,
stderr }>`), wired `rea hook <name>` subcommand, replaced
`hooks/<name>.sh` with a 130-line shim using the 0.32.0 round-8 shape
(HALT → relevance pre-gate → CLI resolution → realpath sandbox →
version probe → forward stdin), and staged the dogfood `.claude/`
mirror as `templates/<name>.dogfood-staged.sh`.

## Phase 0 primitive extensions

Two extensions to the shared `_lib/`:

- `parseWriteHookPayload(raw)` in `_lib/payload.ts` — content-tier
  payload extraction across Write/Edit/MultiEdit/NotebookEdit with the
  same priority order as the bash hook's `payload-read.sh::extract_
  write_content` (content > new_string > edits[].new_string joined >
  new_source). Type-guarded and fail-closed on malformed JSON.
- `anySegmentMatchesBoth(cmd, A, B)` in `_lib/segments.ts` — required
  by `env-file-protection` to enforce same-segment co-occurrence of a
  text-reading utility AND a `.env*` filename (closes the helix-017 P2
  multi-segment false-positive class).

Additionally, `splitSegments` now recurses into `bash -c|-lc PAYLOAD`
and `sh -c PAYLOAD` wrappers and emits the inner payload as additional
segments (mirrors `_rea_unwrap_nested_shells`). This closes the
helix-017 #3 nested-shell bypass for `dependency-audit-gate` and
provides defense-in-depth for the 0.32.0 pilots which previously had
no nested-shell coverage at the segment layer. Depth-bounded at 8 to
prevent adversarial recursion.

## Fail-closed posture

`env-file-protection`, `dependency-audit-gate`, and `changeset-security-gate`
are BLOCKING-tier hooks — the pre-0.33.0 bash bodies refused on policy.
Their early-exit branches (CLI missing, node missing, sandbox failed,
version skew) fail closed AFTER the relevance pre-gate passes. Same
posture as `security-disclosure-gate` in 0.32.0.

`architecture-review-gate` is ADVISORY-only — never refused. All
early-exit branches in its shim exit 0; only HALT can produce exit 2.

## Test coverage

- 89 new unit tests across the 4 modules (env-file: 28, dependency-audit:
  26, changeset: 22, architecture: 13)
- 6 new tests for `parseWriteHookPayload` priority ordering and
  type-guard fail-closure
- 6 new tests for `anySegmentMatchesBoth` same-segment semantics
- 6 new tests for nested-shell unwrapping (helix-017 #3 parity)
- 17 new bash↔node parity tests (`__tests__/hooks/parity/node-parity.
  test.ts`) using the same harness as the 0.32.0 pilots
- Existing `__tests__/hooks/bash-tier-corpus.test.ts` (10 env-file +
  10 dependency-audit cases) still passes against the new shims

Total: ~144 net new tests.

## Out of scope for 0.33.0

- `.claude/hooks/*` dogfood mirror is canonical-content-staged under
  `templates/<name>.dogfood-staged.sh`; the four `.claude/hooks/*.sh`
  files must be patched in by Jake via `git apply` (their existing
  bodies are still the pre-0.33.0 bash bodies). The dogfood mirror is
  protected at the harness level.
- `EXPECTED_HOOKS` already lists all four (no doctor change).
- `.claude/settings.json` registrations already point at the shim
  paths (no settings change).
- 0.34.0 will port the medium-risk batch (3 hooks: `secret-scanner`,
  `delegation-capture`, `local-review-gate`).
- 0.35.0 will port the paired scanner-backed batch (4 hooks:
  `dangerous-bash-interceptor`, `settings-protection`,
  `blocked-paths-bash-gate`, `protected-paths-bash-gate`).
