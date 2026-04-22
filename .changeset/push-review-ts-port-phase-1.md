---
'@bookedsolid/rea': patch
---

G Phase 1 — TypeScript port of push-review-core.sh / commit-review-gate.sh, pure
primitives.

Adds `src/hooks/review-gate/` with the unit-testable halves of the review-gate
contract: refspec parsing (`args`), SHA-256 hashing (`hash`), banner composition
(`banner`), OS identity capture (`metadata`), policy resolution (`policy`),
protected-path detection (`protected-paths`), typed error set (`errors`), and
the cache-key contract (`cache-key`). The bash core at
`hooks/_lib/push-review-core.sh` continues to run in production — Phase 1 is
internal refactor only.

Closes the open questions from the 0.11.0 design doc with ship-fast defaults:

- Phase 4 will clean-remove the shared-core shim (no forward-compat stub).
- Commit-gate co-port is in scope for G; the shared module tree serves both.
- Phase 4 also lands the T self-check widen to audit-middleware + rotator.
- `src/hooks/review-gate/__fixtures__/cache-keys.json` records the 0.10.1
  cache-key expectations across six scenarios (bare push, multi-refspec,
  force-push, deletion, new-branch, cross-repo, unicode-filename); every
  phase runs a byte-exact compat assertion against this fixture.

Coverage on the new module: 96.7% lines / 93.02% branches / 100% functions
across 142 unit tests.
