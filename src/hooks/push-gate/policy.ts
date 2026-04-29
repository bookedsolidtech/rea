/**
 * Push-gate policy resolution.
 *
 * Loads `.rea/policy.yaml` via the shared loader and flattens the subset the
 * gate cares about into a single `ResolvedReviewPolicy`. Env-var overrides
 * (`REA_SKIP_PUSH_GATE`, `REA_ALLOW_CONCERNS`) are NOT consumed here — the
 * gate composition in `./index.ts` inspects them directly after policy load
 * so the audit trail can distinguish "policy says skip" from "env says
 * skip". This module is pure policy.
 *
 * Defaults (when a field is absent or `review:` is missing entirely):
 *   - `codex_required`   → `true`    (safe-by-default: run Codex)
 *   - `concerns_blocks`  → `true`    (safe-by-default: concerns halt the push)
 *   - `timeout_ms`       → 1_800_000 (30 minutes — raised in 0.12.0 from the
 *                                     previous 10-minute default after the
 *                                     helixir migration session 2026-04-26
 *                                     showed realistic feature-branch
 *                                     reviews routinely exceeded 10 minutes
 *                                     on large diffs. Operators who pin
 *                                     `timeout_ms:` in policy.yaml are
 *                                     unaffected by this change.)
 *
 * A missing `.rea/policy.yaml` is treated as "defaults apply" — the
 * operator may not have run `rea init` yet, and the gate's behavior
 * should match the most protective stance available. The caller is free
 * to treat `policyMissing: true` as a doctor finding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadPolicyAsync } from '../../policy/loader.js';
import type { Policy, ReviewPolicy } from '../../policy/types.js';

export interface ResolvedReviewPolicy {
  codex_required: boolean;
  concerns_blocks: boolean;
  timeout_ms: number;
  /**
   * When set, the gate resolves the diff base to `HEAD~N` (see Fix D in
   * 0.12.0). The CLI flag `--last-n-commits N` overrides this; the
   * policy key surfaces here as a runtime knob with the same effect.
   * `undefined` when unset (default-untouched behavior).
   */
  last_n_commits: number | undefined;
  /**
   * Auto-narrow threshold (J / 0.13.0). When the resolved diff base is more
   * than N commits behind HEAD AND no explicit narrowing was pinned, the
   * gate scopes to `PUSH_GATE_DEFAULT_LAST_N_COMMITS_FALLBACK` (10) and
   * emits a stderr warning. Defaults to 30 when unset; 0 disables.
   */
  auto_narrow_threshold: number;
  /** `true` when `.rea/policy.yaml` was absent; defaults apply. */
  policyMissing: boolean;
}

export const PUSH_GATE_DEFAULT_TIMEOUT_MS = 1_800_000;
export const PUSH_GATE_DEFAULT_CODEX_REQUIRED = true;
export const PUSH_GATE_DEFAULT_CONCERNS_BLOCKS = true;
/**
 * Default auto-narrow threshold (J / 0.13.0). When the divergence between
 * the resolved base and HEAD exceeds this count and the operator has not
 * pinned an explicit window, the gate auto-narrows to
 * `PUSH_GATE_DEFAULT_LAST_N_COMMITS_FALLBACK` commits.
 */
export const PUSH_GATE_DEFAULT_AUTO_NARROW_THRESHOLD = 30;
/**
 * Window the gate auto-narrows to when the threshold trips and the operator
 * has not pinned `policy.review.last_n_commits`. Conservative — small
 * enough that Codex review stays fast, large enough to capture meaningful
 * recent work.
 */
export const PUSH_GATE_DEFAULT_LAST_N_COMMITS_FALLBACK = 10;

/**
 * Resolve the push-gate policy for `baseDir`. Never throws — a malformed
 * policy file surfaces as a typed error via the underlying zod validator,
 * which we re-raise. The gate's `runPushGate()` catches that and returns
 * `{ status: 'error', exitCode: 2 }` rather than silently bypassing.
 *
 * Returning a fully-populated object (no `undefined` knobs) means every
 * downstream module can treat the policy as total — no `?? default` dance
 * at each call site.
 */
export async function resolvePushGatePolicy(baseDir: string): Promise<ResolvedReviewPolicy> {
  const policyPath = path.join(baseDir, '.rea', 'policy.yaml');
  if (!fs.existsSync(policyPath)) {
    return {
      codex_required: PUSH_GATE_DEFAULT_CODEX_REQUIRED,
      concerns_blocks: PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
      timeout_ms: PUSH_GATE_DEFAULT_TIMEOUT_MS,
      last_n_commits: undefined,
      auto_narrow_threshold: PUSH_GATE_DEFAULT_AUTO_NARROW_THRESHOLD,
      policyMissing: true,
    };
  }
  const policy: Policy = await loadPolicyAsync(baseDir);
  const review: ReviewPolicy = policy.review ?? {};
  return {
    codex_required: review.codex_required ?? PUSH_GATE_DEFAULT_CODEX_REQUIRED,
    concerns_blocks: review.concerns_blocks ?? PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
    timeout_ms: review.timeout_ms ?? PUSH_GATE_DEFAULT_TIMEOUT_MS,
    last_n_commits: review.last_n_commits,
    auto_narrow_threshold:
      review.auto_narrow_threshold ?? PUSH_GATE_DEFAULT_AUTO_NARROW_THRESHOLD,
    policyMissing: false,
  };
}
