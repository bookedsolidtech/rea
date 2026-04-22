/**
 * Portable SHA-256 over arbitrary strings. Replaces the bash core's
 * sha256sum → shasum → openssl fallback chain (defect L) with a single
 * Node-stdlib call, removing the Alpine/distroless "no hasher on PATH"
 * regression class entirely.
 *
 * ## Why a dedicated module
 *
 * The cache-key contract (design §8) requires byte-exact parity with the
 * 0.10.1 bash implementation. The bash implementation computes
 * `sha256sum( <full git diff> )` and uses the hex digest as the cache key.
 * `crypto.createHash('sha256').update(s).digest('hex')` is bit-identical to
 * GNU `sha256sum < <(printf '%s' s)` output (neither includes the
 * filename-suffix padding). Regression-tested against the fixture in
 * `__fixtures__/cache-keys.json`.
 *
 * ## Hex-64 validation
 *
 * The bash core validates the hasher output is `^[0-9a-f]{64}$` before using
 * it as a cache key; a partial read or broken pipe would otherwise cache
 * garbage. Node's `createHash` is synchronous and crypto-backed, so the
 * digest is always a valid hex-64. We preserve the validation helper for
 * any future path where user-supplied strings might be treated as SHAs (the
 * bash core does this for push_sha env-pass, which the TS port rejects at
 * the type level instead).
 */

import { createHash } from 'node:crypto';

/** A hex-lowercased SHA-256 digest (64 chars). */
export type HexSha256 = string;

/**
 * Compute a SHA-256 over the UTF-8 bytes of `input`. Returns the lowercase
 * hex digest.
 *
 * This is the one function the cache-key contract depends on — never change
 * the encoding or the digest format without bumping the cache-key version
 * (which none of phases 1–4 are permitted to do, per design §8).
 */
export function sha256Hex(input: string): HexSha256 {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * True iff the input looks like a canonical lowercase SHA-256 hex digest.
 * Used by tests and by defensive callers that accept a string and want to
 * reject malformed input before writing it into the cache.
 */
export function isValidSha256Hex(value: string): value is HexSha256 {
  return /^[0-9a-f]{64}$/.test(value);
}
