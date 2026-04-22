/**
 * Codex-review gate composition.
 *
 * ## What this module owns
 *
 * The Phase 2a `audit.ts` module ships `hasValidCodexReview()` — a pure
 * scan over `.rea/audit.jsonl` that returns true iff a qualifying
 * `codex.review` receipt exists for a given `head_sha`. That primitive
 * is the right shape for unit tests but too low-level for the gate
 * itself: the gate cares about a composite predicate that folds in
 *
 *   - policy (`review.codex_required` — when false, the Codex gate is a
 *     no-op regardless of what's in the audit log)
 *   - the `REA_SKIP_CODEX_REVIEW` waiver (when set with a non-empty
 *     reason AND `codex_required=true`, the gate emits a
 *     `codex.review.skipped` audit record and considers the protected-
 *     path requirement satisfied for this push — §5c in the bash core)
 *   - CI refusal (when `CI` env is set and `review.allow_skip_in_ci` is
 *     not true, the waiver is refused — bash core §371-389)
 *   - actor identity (a waiver without a resolvable `git config user.email`
 *     / `user.name` is refused because the audit record would have no
 *     actor — bash core §397-408)
 *
 * This module is the composition of those concerns into a single
 * `evaluateCodexGate()` call that the `runPushReviewGate()` composition
 * invokes once per push.
 *
 * ## Why split it out
 *
 * Three reasons:
 *
 *   1. The bash core lumps waiver-emission, CI-refusal, and receipt-
 *      lookup into one 170-line chunk (§540-673). Splitting the
 *      composition into its own module gives each concern a dedicated
 *      unit test and removes the waiver-sets-a-flag-checked-later
 *      pattern that made the bash version hard to reason about.
 *   2. The `runCommitReviewGate` composition needs the SAME waiver and
 *      receipt semantics for commit-time protected-path checks (design
 *      §11 open-question 2). Extracting the logic here means both
 *      composers call into the same place rather than drifting.
 *   3. Defect P (forgery rejection) and defect U (streaming-parse
 *      tolerance) are enforced by the underlying `audit.ts` primitives;
 *      this module's job is to decide *whether* to consult them at
 *      all, not to reimplement the predicate. Keeping the two concerns
 *      separate preserves the unit-test surface area exactly as the
 *      design doc §9 requires.
 *
 * ## Phase 2b — composition only
 *
 * No new behavioral surface beyond what the bash core already emits.
 * The `emitCodexReviewSkipped()` helper from `audit.ts` writes the
 * receipt; `collectSkipActor()` in this module captures the git
 * identity; `readSkipEnv()` from `policy.ts` reads the env var. The
 * shim swap in Phase 4 will wire these into the CLI entry point.
 */

import type { GitRunner } from './diff.js';
import { readGitActor } from './diff.js';
import {
  emitCodexReviewSkipped,
  hasValidCodexReview,
  type SkipCodexReviewAuditInput,
} from './audit.js';
import {
  BlockedError,
  type ReviewGateErrorCode,
} from './errors.js';
import {
  isCiContext,
  readSkipEnv,
  resolveReviewPolicy,
  type ResolvedPolicy,
  type SkipEnv,
} from './policy.js';

/**
 * The decision the Codex gate hands back to the caller. A discriminated
 * union so the composition can branch cleanly without re-reading env /
 * policy a second time downstream.
 *
 *   - `not_required` — `review.codex_required` is false. The caller
 *     bypasses the protected-path scan entirely. Identical to the
 *     bash core's "CODEX_REQUIRED=false → no per-refspec check" path.
 *   - `waiver_active` — `REA_SKIP_CODEX_REVIEW` was set, the waiver
 *     passed all refusal checks, and a `codex.review.skipped` audit
 *     record was successfully emitted. Protected-path refspecs pass
 *     without consulting the audit log. The bash core sets
 *     `CODEX_WAIVER_ACTIVE=1`; we return a discriminator instead.
 *   - `required` — `codex_required=true` and no waiver. The caller
 *     scans the audit log via `verifyCodexReceipt()` on every
 *     protected-path refspec.
 */
export type CodexGateDecision =
  | { kind: 'not_required' }
  | {
      kind: 'waiver_active';
      reason: string;
      actor: string;
      head_sha: string;
      metadata_source: 'prepush-stdin' | 'local-fallback';
    }
  | { kind: 'required' };

/**
 * Inputs for `evaluateCodexGate()`. All injected so tests enumerate
 * every branch without a real git repo or env.
 */
export interface EvaluateCodexGateInput {
  /** Resolved repo root (the dir containing `.rea/policy.yaml`). */
  baseDir: string;
  /** Injected git runner (for actor lookup). */
  runner: GitRunner;
  /** The HEAD or pushed SHA the waiver record annotates. */
  head_sha: string;
  /** The target label for the waiver metadata (from base-resolve). */
  target: string;
  /**
   * Where the skip metadata came from. `prepush-stdin` when parsed
   * from git's pre-push refspec lines; `local-fallback` when
   * synthesized from HEAD + `@{upstream}`. Bash §594/§606.
   */
  metadata_source: 'prepush-stdin' | 'local-fallback';
  /**
   * Optional override: a pre-resolved policy (used when the composer
   * already loaded the policy for other purposes — avoids a second
   * YAML read). Defaults to a fresh `resolveReviewPolicy(baseDir)`.
   */
  policy?: ResolvedPolicy;
  /**
   * Optional override: pre-read skip-env values. Defaults to
   * `readSkipEnv(process.env)`.
   */
  skipEnv?: SkipEnv;
  /**
   * Optional override: CI context flag. Defaults to `isCiContext()`.
   */
  ci?: boolean;
}

/**
 * Top-level composition of the Codex-review gate decision.
 *
 * Flow (mirrors bash §540-673):
 *
 *   1. Resolve policy. If `codex_required === false`, return
 *      `not_required` immediately — no audit noise, no waiver path.
 *   2. If `REA_SKIP_CODEX_REVIEW` is unset or empty, return `required`.
 *      The caller scans the audit log per-refspec.
 *   3. The waiver is set. Run refusal checks:
 *      a. CI context + `allow_skip_in_ci !== true` → BlockedError.
 *      b. No resolvable actor → BlockedError.
 *   4. Emit the `codex.review.skipped` audit record. On emit failure,
 *      BlockedError (the bash core's "audit-append failed" path at
 *      §647-651).
 *   5. Return `waiver_active`.
 *
 * Throws `BlockedError` when the waiver is refused — the caller
 * translates to exit 2 + banner via `runPushReviewGate`'s top-level
 * catch. Throw rather than return because the policy is
 * fail-closed: a refused waiver IS a blocked push, not a "fall through
 * to the receipt check". The operator has actively opted into a bypass
 * that isn't allowed in their context.
 */
export async function evaluateCodexGate(
  input: EvaluateCodexGateInput,
): Promise<CodexGateDecision> {
  const policy = input.policy ?? resolveReviewPolicy(input.baseDir);
  if (!policy.codex_required) {
    return { kind: 'not_required' };
  }

  const skipEnv = input.skipEnv ?? readSkipEnv(process.env);
  const reason = skipEnv.codex_review_reason;
  if (reason === null) {
    return { kind: 'required' };
  }

  // Waiver path — run refusals in bash-core order (§547-652).
  const ci = input.ci ?? isCiContext(process.env);
  if (ci && !policy.allow_skip_in_ci) {
    throw new BlockedError(
      // No dedicated code for CI-refusal yet; reuse SKIP_REFUSED_IN_CI
      // from errors.ts — it was reserved for exactly this.
      'PUSH_BLOCKED_SKIP_REFUSED_IN_CI' satisfies ReviewGateErrorCode,
      'PUSH BLOCKED: REA_SKIP_CODEX_REVIEW refused in CI context.\n' +
        '\n' +
        '  CI env var is set. An unauthenticated env-var bypass in a shared\n' +
        '  build agent is not trusted. To enable, set\n' +
        '    review:\n' +
        '      allow_skip_in_ci: true\n' +
        '  in .rea/policy.yaml — explicitly authorizing env-var skips in CI.\n',
      { env_var: 'REA_SKIP_CODEX_REVIEW' },
    );
  }

  const actor = readGitActor(input.runner, input.baseDir);
  if (actor.length === 0) {
    throw new BlockedError(
      'PUSH_BLOCKED_SKIP_NO_ACTOR' satisfies ReviewGateErrorCode,
      'PUSH BLOCKED: REA_SKIP_CODEX_REVIEW requires a git identity.\n' +
        '\n' +
        '  Neither `git config user.email` nor `git config user.name`\n' +
        '  is set. The skip audit record would have no actor; refusing\n' +
        '  to bypass without one.\n',
      { env_var: 'REA_SKIP_CODEX_REVIEW' },
    );
  }

  const recordInput: SkipCodexReviewAuditInput = {
    baseDir: input.baseDir,
    head_sha: input.head_sha,
    target: input.target,
    reason,
    actor,
    metadata_source: input.metadata_source,
  };
  try {
    await emitCodexReviewSkipped(recordInput);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BlockedError(
      'PUSH_BLOCKED_SKIP_AUDIT_FAILED' satisfies ReviewGateErrorCode,
      `PUSH BLOCKED: REA_SKIP_CODEX_REVIEW audit-append failed — ${msg}\n` +
        '  Refusing to bypass the Codex-review gate without a receipt.\n',
      { env_var: 'REA_SKIP_CODEX_REVIEW', cause: msg },
    );
  }

  return {
    kind: 'waiver_active',
    reason,
    actor,
    head_sha: input.head_sha,
    metadata_source: input.metadata_source,
  };
}

/**
 * Per-refspec Codex receipt verification.
 *
 * Given the gate decision from `evaluateCodexGate()` and a `head_sha`,
 * return true iff the protected-path Codex requirement is satisfied
 * for that head. This is the decision point inside the per-refspec
 * loop in `runPushReviewGate`:
 *
 *   - `not_required` → true unconditionally. The protected-path scan
 *     itself is skipped upstream; this branch exists defensively so a
 *     future caller that wires the scan without the early exit still
 *     gets the right answer.
 *   - `waiver_active` → true unconditionally. The waiver is a
 *     per-push declaration; it satisfies every protected-path refspec
 *     in the same invocation (bash §931).
 *   - `required` → consult `hasValidCodexReview()`. Defect P + U
 *     tolerance lives in that primitive.
 *
 * The helper is `async` because `hasValidCodexReview` is; callers
 * await in the per-refspec loop.
 */
export async function verifyCodexReceipt(
  decision: CodexGateDecision,
  baseDir: string,
  head_sha: string,
): Promise<boolean> {
  switch (decision.kind) {
    case 'not_required':
      return true;
    case 'waiver_active':
      return true;
    case 'required':
      return hasValidCodexReview(baseDir, head_sha);
  }
}

/**
 * Operator-facing waiver banner text. Emitted to stderr by the CLI
 * after a successful `evaluateCodexGate()` returns `waiver_active`.
 * Pure — CLI does the write.
 *
 * Mirrors bash §654-671 so the fixture-compat snapshot stays byte-
 * identical.
 */
export function renderWaiverBanner(decision: Extract<CodexGateDecision, { kind: 'waiver_active' }>): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('==  CODEX REVIEW WAIVER active (REA_SKIP_CODEX_REVIEW)');
  lines.push(`    Reason:   ${decision.reason}`);
  lines.push(`    Actor:    ${decision.actor}`);
  lines.push(`    Head SHA: ${decision.head_sha.length > 0 ? decision.head_sha : '<unknown>'}`);
  lines.push('    Audited:  .rea/audit.jsonl (tool_name=codex.review.skipped)');
  lines.push('');
  lines.push('    Scope:    waives the protected-path Codex-audit requirement only.');
  lines.push('    Still active: HALT, cross-repo guard, ref-resolution,');
  lines.push('                  push-review cache. For a full-gate bypass');
  lines.push('                  use `REA_SKIP_PUSH_REVIEW=<reason>`.');
  lines.push('');
  lines.push('    This is a gate weakening. The waiver receipt is written BEFORE');
  lines.push('    this banner — seeing this banner means the audit is durable.');
  lines.push('');
  return lines.join('\n') + '\n';
}
