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
  `.husky/pre-push` in place. The eight-test matrix validates the full
  plumbing (protected-path block, clean pass, HALT, waiver,
  `review.codex_required: false`, counterfactual noop hook,
  native-adapter wrapper shape, `.claude/hooks/` PROTECTED_RE
  alternative) — the kind of BUG-008 silent-exit-0 regression that
  slipped past synthesized-stdin unit tests through 0.4.0 would now
  fail loudly.
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
- **Master-default fork support (C1):** new-branch push (remote SHA =
  zero) now probes `origin/HEAD` → `origin/main` → `origin/master` via
  `git rev-parse --verify` before falling back. Earlier versions
  hard-coded `origin/main` as the merge-base anchor, which fails-closed
  noisy on master-default forks. `.husky/pre-push` and
  `hooks/_lib/push-review-core.sh` share the same probe order.
- **Fail-closed on empty merge-base (`.husky/pre-push`):** a genuine
  merge-base resolution failure between two known SHAs (e.g. unrelated
  histories, transient git failure) now blocks the push with a
  diagnostic instead of silently continuing. The bootstrap scenario —
  first push to an empty remote with no remote-tracking ref — is
  distinguished from the failure path and skipped cleanly, since there
  is no baseline to diff against.
- **Zero-SHA regression coverage (C2):** three new tests in
  `push-review-gate-git-adapter.test.ts` exercise the new-branch
  zero-SHA path (`refs/heads/feature <sha> refs/heads/feature 0000...`)
  across all probe permutations — `origin/HEAD` set, `origin/HEAD`
  absent with `origin/main` present, and `origin/HEAD` + `origin/main`
  both absent with `origin/master` present (C1 fallback).
- **Bare-remote tempdir cleanup (C3):** three push-review-gate test
  suites (`no-codex`, `escape-hatch`, `skip-push-review`) now track
  both the scratch repo and its bare remote in the cleanup list. Prior
  versions only cleaned the scratch repo; the bare remote leaked across
  CI runs. A `track(repo)` helper centralizes the pattern.
- **THREAT_MODEL §5.2a:** documents `CLAUDE_PROJECT_DIR` as
  advisory-only — the script-anchor idiom owns the trust decision,
  the env var is kept only for diagnostic signal.
