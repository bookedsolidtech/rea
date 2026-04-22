/**
 * Cache-key computation. This module pins the contract between the push-
 * review gate and the review-cache (`rea cache check` / `rea cache set`).
 *
 * ## The 0.10.1 revert constraint (design §8)
 *
 * An earlier attempt at defect N changed the cache-key input in the bash
 * core and silently invalidated every consumer's existing cache. The
 * failure was: the bash resolver started using the refspec target ref in
 * the cache-key input rather than the merge-base-anchor SHA, so a
 * legitimate cache entry from before the change produced a different key
 * after the upgrade.
 *
 * The TS port makes the contract explicit:
 *
 *   cache_key = sha256_hex( full_git_diff_output )
 *
 * where `full_git_diff_output` is the UTF-8 string returned by
 * `git diff <merge_base>..<source_sha>` with NO added framing. The key
 * is NOT a function of ref names, branch names, or target labels — those
 * are stored in the cache entry as context but do not participate in key
 * derivation.
 *
 * ## Fixture-backed compatibility test
 *
 * `__fixtures__/cache-keys.json` records six scenarios captured from the
 * 0.10.1 bash core (bare push, multi-refspec, force-push, deletion,
 * new-branch, cross-repo). `cache-key.test.ts` asserts byte-exact
 * `computeCacheKey(input) === expected` across all scenarios. Any phase
 * that changes this module without updating the fixture fails the suite.
 */

import { sha256Hex, type HexSha256 } from './hash.js';

export interface CacheKeyInput {
  /** Full `git diff <merge_base>..<source_sha>` output. */
  diff: string;
}

/**
 * Compute the cache key for a push-review entry. Stable, deterministic,
 * pure. The key is the SHA-256 of the UTF-8 bytes of the diff string.
 *
 * @returns the 64-char lowercase hex digest.
 */
export function computeCacheKey(input: CacheKeyInput): HexSha256 {
  return sha256Hex(input.diff);
}

/**
 * Input shape for a cache-lookup call. The key itself is the diff digest
 * from `computeCacheKey`; branch + base are context fields that select
 * which entry within the key-bucket to return. The bash core and the
 * existing `src/cache/review-cache.ts` both key lookups on
 * `(sha, branch, base)`, and the TS port keeps that contract.
 */
export interface CacheLookupContext {
  key: HexSha256;
  branch: string;
  base: string;
}
