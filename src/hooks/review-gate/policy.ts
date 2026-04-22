/**
 * Policy accessors for the review-gate modules.
 *
 * The bash core resolves `review.codex_required` via `node dist/scripts/read-
 * policy-field.js` and evaluates `REA_SKIP_PUSH_REVIEW` / `REA_SKIP_CODEX_REVIEW`
 * directly from env vars. The TS port composes the same behavior over the
 * already-TS `loadPolicy` helper, removing the fork/exec hop and the
 * exit-code-parsing that came with it.
 *
 * Fail-closed: when the policy file is malformed or unreadable, the
 * returned `codex_required` is `true`. This matches the bash core's
 * "treating as true" path (design §2, security carry-forward).
 */

import { loadPolicy } from '../../policy/loader.js';
import type { Policy } from '../../policy/types.js';

export interface ResolvedPolicy {
  /** Resolved `review.codex_required`; true when malformed/absent. */
  codex_required: boolean;
  /** Resolved `review.allow_skip_in_ci`; false when absent. */
  allow_skip_in_ci: boolean;
  /** Full policy (undefined when load failed — caller emits a WARN). */
  policy: Policy | null;
  /** Warning text from the loader, if any — surfaced to stderr by the caller. */
  warning: string | null;
}

/**
 * Resolve review-related policy fields. Never throws — any error path
 * returns `codex_required: true` with a `warning` populated so the caller
 * can decide whether to echo it.
 */
export function resolveReviewPolicy(baseDir: string): ResolvedPolicy {
  try {
    const policy = loadPolicy(baseDir);
    const review = policy.review;
    const codex_required = review?.codex_required === false ? false : true;
    const allow_skip_in_ci = review?.allow_skip_in_ci === true;
    return {
      codex_required,
      allow_skip_in_ci,
      policy,
      warning: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Policy-file-not-found is a first-run condition for consumers running
    // the gate before `rea init`; treat codex_required as true and surface
    // the warning so the operator knows what state the gate is in.
    return {
      codex_required: true,
      allow_skip_in_ci: false,
      policy: null,
      warning: `review-gate: could not load .rea/policy.yaml — ${msg}. Treating codex_required=true (fail-closed).`,
    };
  }
}

/**
 * Skip-env evaluation. The bash core reads `REA_SKIP_PUSH_REVIEW` +
 * `REA_SKIP_CODEX_REVIEW` with simple non-empty semantics. We preserve
 * that exactly: any non-empty value triggers the skip path, and the
 * VALUE is used as the skip reason. Empty or unset = no skip.
 */
export interface SkipEnv {
  /** `REA_SKIP_PUSH_REVIEW` value or null. */
  push_review_reason: string | null;
  /** `REA_SKIP_CODEX_REVIEW` value or null. */
  codex_review_reason: string | null;
}

export function readSkipEnv(env: NodeJS.ProcessEnv = process.env): SkipEnv {
  const pr = env['REA_SKIP_PUSH_REVIEW'];
  const cr = env['REA_SKIP_CODEX_REVIEW'];
  return {
    push_review_reason: typeof pr === 'string' && pr.length > 0 ? pr : null,
    codex_review_reason: typeof cr === 'string' && cr.length > 0 ? cr : null,
  };
}

/**
 * True iff `CI` env is set to a non-empty value. The bash core checks
 * `[[ -n "${CI:-}" ]]` — we match that.
 */
export function isCiContext(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['CI'];
  return typeof v === 'string' && v.length > 0;
}

/**
 * Legacy-bash kill switch (design §11.2). When `REA_LEGACY_PUSH_REVIEW=1`,
 * the CLI entry point delegates to the preserved bash core for one
 * release window. Advertised in `rea doctor`; sunset after 90 days of
 * clean 0.11.x running on canaries.
 */
export function isLegacyBashKillSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['REA_LEGACY_PUSH_REVIEW'];
  return typeof v === 'string' && v.length > 0 && v !== '0';
}
