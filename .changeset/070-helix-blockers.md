---
'@bookedsolid/rea': minor
---

0.7.0 — BUG-008 cleanup, BUG-013/014 defense-in-depth, release-pipeline hardening, CI regression guards

- **BUG-008 cleanup — shared push-review core + native git adapter.** The
  700-line `push-review-gate.sh` and `commit-review-gate.sh` hooks shared
  no implementation. Two bugs in the same body of logic meant two fixes
  in two places. 0.7.0 extracts the common logic into
  `hooks/_lib/push-review-core.sh` (sourced by thin adapters) and ships
  a new `hooks/push-review-gate-git.sh` that consumers wire into
  `.husky/pre-push` directly. The adapter consumes git's native pre-push
  stdin (`<ref> <sha> <ref> <sha>` per line) without needing the
  BUG-008 sniff in the generic adapter. Existing consumers of
  `push-review-gate.sh` are unaffected — the sniff still works. Full
  parity test matrix verifies the two adapters produce identical
  exit codes + load-bearing stderr across every core branch.
- **BUG-014 (structural defense-in-depth):** `DownstreamConnection.lastError`
  is now bounded at write, not at read. 0.6.2 applied
  `boundedDiagnosticString` at the getter — every assignment site was
  trusted to eventually flow through the read path. 0.7.0 moves the
  bound into a `set #lastErrorMessage` setter on a true ES-private
  backing field, so the invariant is structural: every write produces
  a bounded stored value regardless of how many assignment sites exist
  or where they live. The setter also rejects non-string inputs with
  `TypeError` instead of silently corrupting the field. Public API is
  unchanged (`get lastError(): string | null`).
- **Release-pipeline hardening (BUG-013 follow-through):**
  `.github/workflows/release.yml` now (a) rebuilds `dist/` from the
  shipping HEAD immediately before `changesets/action` and records a
  SHA-256 tree hash to `$RUNNER_TEMP/rea-dist-hash`, and (b)
  post-publish, re-packs the just-published tarball from npm and fails
  the release if the published tarball's `dist/` tree hash doesn't
  match the CI-built hash. The hash file lives in CI scratch space so
  it cannot be accidentally committed by `changesets/action`'s
  `git add .`.
- **Class-level dist/ regression gate (generalizes BUG-013):** new
  `scripts/dist-regression-gate.sh` + `dist-regression` CI job fire on
  every PR and every push:main. If `src/` has changed vs the last
  published tag but the rebuilt `dist/` tree hashes identically to the
  published tarball, CI fails. The 0.6.0 → 0.6.1 "src changed, dist
  didn't" regression class is now caught BEFORE the release branch,
  not only at publish time. Skip surface designed so registry outages
  and malformed prior releases don't pin CI into red.
- **Husky e2e regression guard:** new
  `__tests__/hooks/husky-e2e.test.ts` invokes a REAL `git push` against
  a bare remote via `core.hooksPath=.husky`, with the SHIPPED
  `.husky/pre-push` in place. The six-test matrix validates the full
  plumbing (protected-path block, clean pass, HALT, waiver,
  `review.codex_required: false`, counterfactual noop hook) — the
  kind of BUG-008 silent-exit-0 regression that slipped past
  synthesized-stdin unit tests through 0.4.0 would now fail loudly.
- **push-review-gate ordering (0.7.0 follow-up to BUG-009):**
  `REA_SKIP_CODEX_REVIEW` now resolves before ref-resolution, so the
  bypass works on stale checkouts where the remote ref has gone
  missing (previously a bogus remote SHA would crash the gate before
  the skip could fire). The skip still honors policy: if
  `review.codex_required: false`, the env var is a no-op (unchanged
  G11.4 semantic). Skip audit metadata is now parsed from the pre-push
  stdin contract (`<local_ref> <local_sha> <remote_ref> <remote_sha>`)
  rather than guessed from `git rev-parse HEAD`, so
  `git push origin hotfix:main` from a `feature` checkout now
  correctly records the `hotfix` SHA in the skip receipt.
  `files_changed` in skip records is `null` (authoritative push window
  is unavailable pre-ref-resolution); a new `metadata_source` field
  tags the record as `prepush-stdin` or `local-fallback`.
- **THREAT_MODEL §5.2a:** documents `CLAUDE_PROJECT_DIR` as
  advisory-only — the script-anchor idiom owns the trust decision,
  the env var is kept only for diagnostic signal.
