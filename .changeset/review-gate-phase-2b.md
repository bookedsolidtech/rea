---
'@bookedsolid/rea': patch
---

review-gate Phase 2b — push/commit gate composition (G)

Adds `runPushReviewGate()` and `runCommitReviewGate()` as the top-level
TypeScript composers over the Phase 1 primitives (args, banner, cache-key,
constants, errors, hash, metadata, policy, protected-paths) and Phase 2a
supporting modules (base-resolve, diff, audit, cache). Also adds the
`codex-gate.ts` module that folds the `review.codex_required` policy field,
the `REA_SKIP_CODEX_REVIEW` waiver env var, CI refusal, actor resolution,
and audit-record emission into a single `evaluateCodexGate()` call that
both composers share.

No behavioral surface is wired to the hook entry points yet — the bash
core at `hooks/_lib/push-review-core.sh` continues to run in production.
Phase 3 wires the TS composers to `rea hook push-review-gate` / `rea hook
commit-review-gate` CLI subcommands; Phase 4 swaps the shims over and
deletes the bash core. See `docs/design/push-review-ts-port.md` §11.1.

Coverage includes integration-shaped tests for the five security
invariants — defect J (mixed-push deletion guard), defect P (Codex-receipt
forgery rejection), defect U (streaming-parse tolerance), C0/C1
control-character stripping, and protected-path prefix-match integrity
against crafted paths.
