/**
 * Review-cache adapter for the push-review gate.
 *
 * ## What this module owns
 *
 * 1. Compute the cache key from a diff. **Re-exports** `computeCacheKey`
 *    from the Phase-1 `cache-key.ts` module — this is the same function,
 *    not a reimplementation. The fixture suite (`cache.test.ts`) locks
 *    that invariant via a byte-exact re-run against
 *    `__fixtures__/cache-keys.json`. If the two modules ever diverge,
 *    the 0.10.x → 0.11.0 cache contract is broken and every consumer's
 *    on-disk cache becomes unreachable. See design §8.
 *
 * 2. Wrap `src/cache/review-cache.ts` so callers get a single entry
 *    point — `checkReviewCache({ diff, branch, base })` — that hides
 *    the TTL semantics, the `(sha, branch, base)` key tuple, and the
 *    cache-lookup result shape.
 *
 * 3. Translate the cache lookup into the same three-way outcome the
 *    bash core's §1203 `jq -e '.hit == true and .result == "pass"'`
 *    check emitted:
 *
 *      - `hit_pass`    — cache hit AND result === 'pass'. Gate passes.
 *      - `hit_fail`    — cache hit AND result === 'fail'. Cached
 *                        negative verdict; gate blocks. (Bash §1197-1202
 *                        rejects this; we preserve.)
 *      - `miss`        — no hit / expired / empty file. Gate falls
 *                        through to the review-required banner.
 *      - `query_error` — cache lookup threw. Bash §1180-1196 treated
 *                        this as a `{"hit":false,"reason":"query_error"}`
 *                        cached result; we carry the error body so the
 *                        caller can emit the CACHE CHECK FAILED banner
 *                        with the SANITIZED stderr (defect C0/C1 strip).
 *
 * ## Phase 2a scope
 *
 * This file exports pure functions over the already-TS
 * `review-cache.ts`. No subprocess `spawn`, no CLI fork. The bash
 * core's `rea cache check` subprocess hop is obviated entirely —
 * once Phase 3 swaps the shim we no longer fork/exec node for the
 * cache lookup at all.
 *
 * ## Phase 2b composition
 *
 * `runPushReviewGate` in `index.ts` calls `computeCacheKeyFromDiff` +
 * `checkReviewCache` sequentially; the latter returns a discriminated
 * outcome the gate branches on. No new behavior lands here — that's
 * the `codex-gate.ts` / composition step.
 */

import { lookup, type CacheLookupResult } from '../../cache/review-cache.js';
import { computeCacheKey as computePhase1CacheKey } from './cache-key.js';
import type { HexSha256 } from './hash.js';

/**
 * Compute the cache key for a diff. This is a thin re-export of Phase 1's
 * `computeCacheKey` — exposed on this module so callers can use a single
 * import when they need both the key AND the lookup.
 *
 * The function is UNCHANGED from Phase 1. The fixture suite in
 * `cache.test.ts` proves byte-exact parity against
 * `__fixtures__/cache-keys.json` for all six scenarios.
 */
export function computeCacheKey(diff: string): HexSha256 {
  return computePhase1CacheKey({ diff });
}

/**
 * Discriminated outcome of a cache lookup. Matches the three-way state
 * the bash core's §1203 predicate surfaces, plus a `query_error` kind
 * for the §1180-1196 case.
 */
export type CacheOutcome =
  | { kind: 'hit_pass'; key: HexSha256; recorded_at: string }
  | { kind: 'hit_fail'; key: HexSha256; recorded_at: string; reason?: string }
  | { kind: 'miss'; key: HexSha256; reason: 'no-entry' | 'expired' | 'empty-file' }
  | { kind: 'query_error'; key: HexSha256; error: string };

/**
 * Input for `checkReviewCache`. `diff` is the full `git diff` body; the
 * cache key is derived from it via `computeCacheKey`. `branch` + `base`
 * select which entry in the key-bucket is returned (most-recent match).
 */
export interface CheckReviewCacheInput {
  baseDir: string;
  diff: string;
  branch: string;
  base: string;
  /** Optional override for `Date.now()`-driven TTL expiration — test hook only. */
  nowMs?: number;
  /** Optional override for the TTL (seconds). Defaults to cache-module default. */
  maxAgeSeconds?: number;
}

/**
 * Perform a cache lookup and translate into the discriminated outcome.
 *
 * Does NOT throw on a lookup failure — every known error path routes
 * through the `query_error` variant so the caller's single `switch`
 * handles all four outcomes. This mirrors the bash core's
 * `CACHE_STDOUT || CACHE_EXIT != 0 → {"hit":false,...}` collapse at
 * §1180-1196.
 */
export async function checkReviewCache(input: CheckReviewCacheInput): Promise<CacheOutcome> {
  const key = computeCacheKey(input.diff);
  let result: CacheLookupResult;
  try {
    result = await lookup(input.baseDir, {
      sha: key,
      branch: input.branch,
      base: input.base,
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'query_error', key, error: msg };
  }

  if (!result.hit) {
    // `result.missReason` is always set when `hit` is false (see
    // review-cache.ts's CacheLookupResult contract). The fallback to
    // 'no-entry' is defensive for an ill-formed result we shouldn't see.
    return {
      kind: 'miss',
      key,
      reason: result.missReason ?? 'no-entry',
    };
  }

  // Hit. Branch on verdict — the bash core requires BOTH hit==true AND
  // result==pass. A hit with result==fail is a cached negative verdict
  // and must NOT unblock the push.
  const entry = result.entry;
  if (entry === undefined) {
    // Defensive: `hit: true` without an entry is an ill-formed result.
    return { kind: 'miss', key, reason: 'no-entry' };
  }
  if (entry.result === 'pass') {
    return { kind: 'hit_pass', key, recorded_at: entry.recorded_at };
  }
  // result === 'fail'
  const hitFail: CacheOutcome = {
    kind: 'hit_fail',
    key,
    recorded_at: entry.recorded_at,
  };
  if (entry.reason !== undefined && entry.reason.length > 0) {
    hitFail.reason = entry.reason;
  }
  return hitFail;
}
