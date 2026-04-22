/**
 * Public entry point for the review-gate TypeScript port (G).
 *
 * ## Scope after Phase 2a (0.10.3)
 *
 * - Phase 1 primitives (args, banner, cache-key, constants, errors,
 *   hash, metadata, policy, protected-paths) — pure, dependency-free.
 * - Phase 2a supporting modules (base-resolve, diff, audit, cache) —
 *   wrap git subprocesses, wrap audit append/scan, wrap the review-
 *   cache lookup. No top-level gate yet; composition lands in Phase 2b.
 *
 * The bash core in `hooks/_lib/push-review-core.sh` continues to run in
 * production until phase 4. These exports are library-level primitives
 * that tests and Phase 2b compose; no behavioral surface is registered
 * for external callers here.
 *
 * See `docs/design/push-review-ts-port.md` for the full plan.
 */

// Phase 1 primitives
export * from './args.js';
export * from './banner.js';
export * from './cache-key.js';
export * from './constants.js';
export * from './errors.js';
export * from './hash.js';
export * from './metadata.js';
export * from './policy.js';
export * from './protected-paths.js';

// Phase 2a supporting modules — re-export explicit names to avoid
// double-exporting `computeCacheKey` (which lives in both cache-key.ts
// and cache.ts; cache.ts's is a strict re-export of Phase 1's).
export {
  currentBranch,
  diffNameStatus,
  fullDiff,
  gitCommonDir,
  hasCommitLocally,
  mergeBase,
  readGitActor,
  readGitConfig,
  refExists,
  resolveHead,
  resolveRefToSha,
  resolveRemoteDefaultRef,
  resolveUpstream,
  revListCount,
  spawnGit,
  type DiffResult,
  type GitRunResult,
  type GitRunner,
  type NameStatusResult,
} from './diff.js';
export {
  computeInitialTargetLabel,
  resolveBaseForRefspec,
  resolveNewBranchBase,
  stripRefsHeadsOnly,
  type ResolveBaseDeps,
  type ResolvedBase,
} from './base-resolve.js';
export {
  CODEX_REVIEW_SKIPPED_TOOL,
  ESCAPE_HATCH_SERVER,
  PUSH_REVIEW_CACHE_ERROR_TOOL,
  PUSH_REVIEW_CACHE_HIT_TOOL,
  PUSH_REVIEW_SERVER,
  PUSH_REVIEW_SKIPPED_TOOL,
  emitCodexReviewSkipped,
  emitPushReviewSkipped,
  hasValidCodexReview,
  isQualifyingCodexReview,
  type SkipCodexReviewAuditInput,
  type SkipPushReviewAuditInput,
} from './audit.js';
export {
  checkReviewCache,
  type CacheOutcome,
  type CheckReviewCacheInput,
} from './cache.js';
