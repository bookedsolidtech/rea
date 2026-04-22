---
'@bookedsolid/rea': patch
---

chore(hooks): review-gate Phase 2a — supporting TS modules (G)

Add `base-resolve.ts`, `diff.ts`, `audit.ts`, `cache.ts` under
`src/hooks/review-gate/`. These compose with the Phase 1 primitives
(shipped in 0.10.2) to build the runPushReviewGate / runCommitReviewGate
surface in Phase 2b. No behavioral change in this release: the bash
core at `hooks/_lib/push-review-core.sh` continues to run in production;
the new modules are library-level supporting code that Phase 2b wires
into a composition layer.

New modules:

- `diff.ts` — git-subprocess wrappers (rev-parse, merge-base, diff,
  rev-list, cat-file, config, symbolic-ref, common-dir) through a
  mockable `GitRunner` port. Args always passed as an array so refspec
  names containing shell metacharacters are inert.
- `base-resolve.ts` — four-path base-ref resolution: tracked-branch,
  new-branch-with-`branch.<src>.base`-config, new-branch-origin/HEAD,
  bootstrap-empty-tree. Preserves defect N's label-promotion semantic
  (Target: label echoes the resolved anchor only when operator-configured
  base fires). State-isolation across multi-refspec pushes unit-proven.
- `audit.ts` — emitPushReviewSkipped / emitCodexReviewSkipped over the
  existing appendAuditRecord helper; hasValidCodexReview implements
  defect P (emission_source predicate) and defect U (per-line parse
  tolerance) natively. The bash `jq -R 'fromjson?'` scan is obviated.
- `cache.ts` — wraps `review-cache.ts` lookup + discriminated outcome
  (`hit_pass` / `hit_fail` / `miss` / `query_error`). Re-exports Phase
  1's `computeCacheKey` as a single module-wide entry point.

Cache-key contract (design §8): `cache.ts::computeCacheKey` is a strict
re-export of `cache-key.ts::computeCacheKey`. The fixture suite in
`cache.test.ts` proves byte-exact parity against
`__fixtures__/cache-keys.json` for all six scenarios captured from the
0.10.1 bash core — if the two modules ever drift, every consumer's
on-disk cache is broken and the PR is rejected.

104 new unit tests. Coverage: `base-resolve.ts` 100%, `diff.ts` 100%,
`audit.ts` 97.87%, `cache.ts` 95.45% — all above the Phase 2a ≥90%
target.
