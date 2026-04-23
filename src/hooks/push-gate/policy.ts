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
 *   - `codex_required`   → `true`  (safe-by-default: run Codex)
 *   - `concerns_blocks`  → `true`  (safe-by-default: concerns halt the push)
 *   - `timeout_ms`       → 600_000 (10 minutes)
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
  /** `true` when `.rea/policy.yaml` was absent; defaults apply. */
  policyMissing: boolean;
}

export const PUSH_GATE_DEFAULT_TIMEOUT_MS = 600_000;
export const PUSH_GATE_DEFAULT_CODEX_REQUIRED = true;
export const PUSH_GATE_DEFAULT_CONCERNS_BLOCKS = true;

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
      policyMissing: true,
    };
  }
  const policy: Policy = await loadPolicyAsync(baseDir);
  const review: ReviewPolicy = policy.review ?? {};
  return {
    codex_required: review.codex_required ?? PUSH_GATE_DEFAULT_CODEX_REQUIRED,
    concerns_blocks: review.concerns_blocks ?? PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
    timeout_ms: review.timeout_ms ?? PUSH_GATE_DEFAULT_TIMEOUT_MS,
    policyMissing: false,
  };
}
