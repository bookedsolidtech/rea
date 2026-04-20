---
'@bookedsolid/rea': minor
---

[security] 0.7.0 — Helix blocker clearance (BUG-014, push-review-gate ordering, release-pipeline hardening)

- **BUG-014 (structural defense-in-depth):** `DownstreamConnection.lastErrorMessage` is now an ES-private field (`#lastErrorBacking`) with a bounded setter. 0.6.2 applied `boundedDiagnosticString` at the getter — every assignment site was trusted to eventually flow through the read path. 0.7.0 moves the bound to the setter, so the invariant is structural: every write produces a bounded stored value regardless of how many assignment sites exist or where they live. Includes two new regression tests that verify the bound applies at assignment and that the backing field is unreachable via `as any` casts.
- **push-review-gate ordering (0.7.0 follow-up to BUG-009):** `REA_SKIP_CODEX_REVIEW` now resolves before ref-resolution, so the bypass works on stale checkouts where the remote ref has gone missing (previously a bogus remote SHA would crash the gate before the skip could fire). The skip still honors policy: if `review.codex_required: false`, the env var is a no-op (unchanged G11.4 semantic). Audit metadata is now best-effort — we record the HEAD SHA and file list we can derive without hitting the network, and fall back gracefully when we can't.
- **Release-pipeline hardening (BUG-013 follow-through):** `.github/workflows/release.yml` now (a) rebuilds `dist/` from the shipping HEAD immediately before `changesets/action` and records a SHA-256 tree hash, and (b) post-publish, re-packs the just-published tarball from npm and fails the release if the published tarball's `dist/` tree hash doesn't match the CI-built hash.
- **THREAT_MODEL §5.2a:** documents `CLAUDE_PROJECT_DIR` as advisory-only — the script-anchor idiom owns the trust decision, the env var is kept only for diagnostic signal.
