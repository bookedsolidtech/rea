/**
 * Typed error set for the review-gate modules (G — push-review/commit-review
 * TypeScript port).
 *
 * The bash core signals outcomes via exit codes + stderr banners. The TS port
 * expresses each outcome as a typed error so callers can branch on class
 * instead of parsing banner text, and so the eventual CLI entry point can
 * translate a thrown error into the same exit code + banner the bash core
 * emitted (preserving external contract per design §2, non-goals).
 *
 * Every error subclass carries:
 *   - a stable `code` (for programmatic dispatch in tests + the CLI shim)
 *   - an `exitCode` (matches the bash core's `exit N` semantics)
 *   - the operator-facing `message` composed by `banner.ts`
 *
 * This module is intentionally dependency-free so unit tests can import it
 * without dragging in fs/child_process. The CLI entry point is the single
 * place that translates these to `process.exit(N)`.
 */

/**
 * Stable discriminator used by tests and the CLI dispatch layer. String literals
 * (not enum) so they survive JSON serialization in audit metadata.
 */
export type ReviewGateErrorCode =
  | 'PUSH_BLOCKED_DELETE'
  | 'PUSH_BLOCKED_HEAD_REFSPEC'
  | 'PUSH_BLOCKED_SOURCE_UNRESOLVABLE'
  | 'PUSH_BLOCKED_NO_REFSPECS'
  | 'PUSH_BLOCKED_REMOTE_OBJECT_MISSING'
  | 'PUSH_BLOCKED_NO_MERGE_BASE'
  | 'PUSH_BLOCKED_NO_BASE_RESOLVABLE'
  | 'PUSH_BLOCKED_DIFF_FAILED'
  | 'PUSH_BLOCKED_REV_LIST_FAILED'
  | 'PUSH_BLOCKED_PROTECTED_PATHS'
  | 'PUSH_BLOCKED_SKIP_REFUSED_IN_CI'
  | 'PUSH_BLOCKED_SKIP_NO_ACTOR'
  | 'PUSH_BLOCKED_SKIP_AUDIT_FAILED'
  | 'PUSH_BLOCKED_SKIP_NOT_BUILT'
  | 'PUSH_BLOCKED_SKIP_METADATA_FAILED'
  | 'PUSH_BLOCKED_CACHE_MKTEMP_UNAVAILABLE'
  | 'PUSH_BLOCKED_NOT_IN_REPO'
  | 'PUSH_BLOCKED_DEPENDENCY_MISSING'
  | 'PUSH_REVIEW_REQUIRED';

/**
 * Base class. All review-gate errors derive from this so a CLI dispatch layer
 * can `catch (e) { if (e instanceof ReviewGateError) ... }`.
 */
export class ReviewGateError extends Error {
  public readonly code: ReviewGateErrorCode;
  public readonly exitCode: number;
  public readonly details: Record<string, unknown>;

  constructor(
    code: ReviewGateErrorCode,
    message: string,
    exitCode: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReviewGateError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    // Node gives us a stable prototype chain via Error; no need to hack it.
  }
}

/**
 * Blocked-push errors (exit 2). The bash core uses exit 2 for every blocked
 * condition; we preserve that invariant so the shim's exit code is unchanged.
 */
export class BlockedError extends ReviewGateError {
  constructor(code: ReviewGateErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(code, message, 2, details);
    this.name = 'BlockedError';
  }
}

/**
 * Deletion detected anywhere in the push (defect J). Must fail-closed even
 * when a sibling refspec would have been reviewable.
 */
export class DeletionBlockedError extends BlockedError {
  constructor() {
    super(
      'PUSH_BLOCKED_DELETE',
      'refspec is a branch deletion.\n' +
        '\n' +
        '  Branch deletions are sensitive operations and require explicit\n' +
        '  human action outside the agent. Perform the deletion manually.\n',
    );
    this.name = 'DeletionBlockedError';
  }
}

/**
 * A refspec with `HEAD` as destination is operator error (design §3.1,
 * `pr_resolve_argv_refspecs`). Carry the refspec in details for banner render.
 */
export class HeadRefspecBlockedError extends BlockedError {
  constructor(spec: string) {
    super(
      'PUSH_BLOCKED_HEAD_REFSPEC',
      `refspec resolves to HEAD (from ${JSON.stringify(spec)})\n` +
        '\n' +
        '  `git push <remote> HEAD:<branch>` or similar is almost always\n' +
        '  operator error in this context. Name the destination branch\n' +
        '  explicitly so the review gate can diff against it.\n',
      { spec },
    );
    this.name = 'HeadRefspecBlockedError';
  }
}

/**
 * Invalid `--delete` refspec (empty destination or HEAD destination).
 * Distinct from the general HEAD-refspec error because bash emits a
 * different operator banner for the delete-mode case — the remediation
 * text is "name the branch you meant to delete" rather than the HEAD
 * destination error. See push-review-core.sh §161-168.
 */
export class InvalidDeleteRefspecError extends BlockedError {
  constructor(spec: string) {
    super(
      'PUSH_BLOCKED_HEAD_REFSPEC',
      `--delete refspec resolves to HEAD or empty (from ${JSON.stringify(spec)})\n`,
      { spec, mode: 'delete' },
    );
    this.name = 'InvalidDeleteRefspecError';
  }
}

/**
 * Defect N completion (landed in phase 4, type reserved in phase 1 so
 * `base-resolve.ts` can throw it later without schema churn).
 */
export class NoBaseResolvableError extends BlockedError {
  constructor(source: string) {
    super(
      'PUSH_BLOCKED_NO_BASE_RESOLVABLE',
      `cannot resolve base branch for ${source}; run ` +
        '`git branch --set-upstream-to=origin/<target>` or ' +
        '`git config branch.' +
        source +
        '.base <ref>`',
      { source },
    );
    this.name = 'NoBaseResolvableError';
  }
}
