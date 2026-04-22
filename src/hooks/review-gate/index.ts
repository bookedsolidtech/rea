/**
 * Public entry point for the review-gate TypeScript port (G).
 *
 * Phase 1 scope: expose the pure primitives (args, hash, banner, metadata,
 * policy, protected-paths, cache-key, errors, constants) so they can be
 * unit-tested and composed by phase 2's `runPushReviewGate` /
 * `runCommitReviewGate`. No behavioral surface is registered here yet —
 * the bash core in `hooks/_lib/push-review-core.sh` continues to run in
 * production until phase 4.
 *
 * See `docs/design/push-review-ts-port.md` for the full plan.
 */

export * from './args.js';
export * from './banner.js';
export * from './cache-key.js';
export * from './constants.js';
export * from './errors.js';
export * from './hash.js';
export * from './metadata.js';
export * from './policy.js';
export * from './protected-paths.js';
