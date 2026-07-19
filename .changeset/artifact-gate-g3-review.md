---
'@bookedsolid/rea': minor
---

Artifact Gate G3 (review-gate) — express the existing local-review-gate as the
artifact-gates-consistent `artifact_gates.g3_review.mode` (off|shadow|enforce)
and add the missing SHADOW tier. Shadow runs the same verdict-coverage probe and
logs a `rea.gate.g3.shadow` would-block without refusing; enforce refuses at the
push/commit boundary and audits `rea.gate.g3` (matching G1/G2 vocabulary). When
`g3_review.mode` is absent, behavior is byte-identical to today (driven by
`review.local_review`) — the load-bearing invariant. `refuse_at` / `bypass_env_var`
continue to come from `review.local_review`. Checks the artifact only, never a
model; acts solely at the push boundary (overnight-safe).
