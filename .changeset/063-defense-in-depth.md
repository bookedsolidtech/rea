---
'@bookedsolid/rea': patch
---

[security] 0.6.3 — defense-in-depth hardening + hook UX fix + release-pipeline hardening

No new public API. Every change is a structural strengthening of an
already-bounded surface, a UX regression fix, or CI-only. Patch bump.

- **BUG-014 (structural defense-in-depth):** `DownstreamConnection.lastError` is now bounded at write, not at read. 0.6.2 applied `boundedDiagnosticString` at the getter — every assignment site was trusted to eventually flow through the read path. 0.6.3 moves the bound into a `set #lastErrorMessage` setter on a true ES-private backing field, so the invariant is structural: every write produces a bounded stored value regardless of how many assignment sites exist or where they live. The setter also rejects non-string inputs with `TypeError` instead of silently corrupting the field. Public API is unchanged (`get lastError(): string | null`).
- **push-review-gate ordering (0.6.3 follow-up to BUG-009):** `REA_SKIP_CODEX_REVIEW` now resolves before ref-resolution, so the bypass works on stale checkouts where the remote ref has gone missing (previously a bogus remote SHA would crash the gate before the skip could fire). The skip still honors policy: if `review.codex_required: false`, the env var is a no-op (unchanged G11.4 semantic). Skip audit metadata is now parsed from the pre-push stdin contract (`<local_ref> <local_sha> <remote_ref> <remote_sha>`) rather than guessed from `git rev-parse HEAD`, so `git push origin hotfix:main` from a `feature` checkout now correctly records the `hotfix` SHA in the skip receipt. `files_changed` in skip records is `null` (authoritative push window is unavailable pre-ref-resolution); a new `metadata_source` field tags the record as `prepush-stdin` or `local-fallback`.
- **Release-pipeline hardening (BUG-013 follow-through):** `.github/workflows/release.yml` now (a) rebuilds `dist/` from the shipping HEAD immediately before `changesets/action` and records a SHA-256 tree hash to `$RUNNER_TEMP/rea-dist-hash`, and (b) post-publish, re-packs the just-published tarball from npm and fails the release if the published tarball's `dist/` tree hash doesn't match the CI-built hash. The hash file lives in CI scratch space so it cannot be accidentally committed by `changesets/action`'s `git add .`.
- **THREAT_MODEL §5.2a:** documents `CLAUDE_PROJECT_DIR` as advisory-only — the script-anchor idiom owns the trust decision, the env var is kept only for diagnostic signal.
