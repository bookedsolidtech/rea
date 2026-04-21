---
'@bookedsolid/rea': minor
---

Narrow `REA_SKIP_CODEX_REVIEW` from a whole-gate bypass to a Codex-only waiver (#85).

Through 0.7.0, setting `REA_SKIP_CODEX_REVIEW=<reason>` short-circuited the entire push-review gate after writing the skip audit record — equivalent in scope to `REA_SKIP_PUSH_REVIEW`. Operators reached for it to silence a transient Codex unavailability and accidentally bypassed every other check (HALT, cross-repo guard, ref-resolution, push-review cache).

Starting in 0.8.0, the waiver only satisfies the protected-path Codex-audit requirement (section 7). Every other gate this hook runs still runs:

- **HALT** (`.rea/HALT`) — still blocks.
- **Cross-repo guard** — still blocks.
- **Ref-resolution failures** (missing remote object, unresolvable source ref) — still block, but the skip audit record is written first so the operator's commitment is durable.
- **Push-review cache** — a miss still falls through to the general "Review required" block in section 9.

(Blocked-paths enforcement runs on a separate Edit/Write-tier hook, not this push hook — it was never scoped by `REA_SKIP_CODEX_REVIEW` and is unaffected by this change.)

**Migration.** For the previous whole-gate bypass semantic, use `REA_SKIP_PUSH_REVIEW=<reason>` (unchanged). For a protected-path push where Codex is genuinely unavailable, `REA_SKIP_CODEX_REVIEW=<reason>` combined with a valid push-review cache entry (from `rea cache set <sha> pass ...`) is the new minimum for exit 0.

**Audit.** The skip audit record is still named `codex.review.skipped` and still fails the `codex.review` jq predicate. Banner text changed from `CODEX REVIEW SKIPPED` to `CODEX REVIEW WAIVER active` to reflect the narrower scope.

**Cache gate hardening (same release).** Two composition bugs that became load-bearing under the new waiver semantic were fixed at the same time:

- The cache-hit predicate now requires `.hit == true and .result == "pass"`. Previously `.hit == true` alone was sufficient, which meant a cached `fail` verdict would silently satisfy the gate. Under the 0.7.0 semantic the waiver short-circuited to exit 0 on its own, so the cache lookup was not load-bearing for waiver users; under 0.8.0 the cache is the only path to exit 0 for waiver users, making the permissive predicate a real exposure.
- The cache key is now derived from the PUSHED source ref (from pre-push stdin), not from the checkout branch. `git push origin hotfix:main` from a `feature` checkout now looks up a cache entry keyed on `hotfix`, not `feature`.

Closes the "Codex waiver accidentally bypasses HALT" class of operator footguns. The old semantic was shipped as a workaround in 0.3.x before the general gate composed cleanly; 0.8.0 is the cleanup pass.
