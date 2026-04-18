/**
 * Reviewer selector (G11.2).
 *
 * Single source of truth for "which adversarial reviewer should run against
 * this branch?" Downstream callers get back a reviewer handle plus two
 * audit-friendly signals: `degraded` (is this a fallback?) and `reason`
 * (why did we pick this one?).
 *
 * Precedence, high to low:
 *
 *   1. `REA_REVIEWER` env var — explicit operator choice wins over all policy
 *   2. `registry.reviewer` — second-wins operator pin in `.rea/registry.yaml`
 *   3. `policy.review.codex_required === false` — first-class no-Codex mode
 *      (G11.4 semantics). ClaudeSelfReviewer is NOT degraded here because
 *      the operator explicitly chose this lane.
 *   4. Default: prefer Codex, fall back to ClaudeSelfReviewer with
 *      `degraded: true` if Codex is unavailable.
 *   5. Both unavailable → throw. The push gate has an audited escape hatch
 *      (`REA_SKIP_CODEX_REVIEW`, G11.1) for when that's legitimately the
 *      operator's intent.
 *
 * The caller decides what to do with the result. The audit record should
 * always capture `reviewer.name`, `reviewer.version`, `degraded`, and
 * `reason` verbatim.
 */

import type { Policy } from '../../policy/types.js';
import type { Registry, RegistryReviewer } from '../../registry/types.js';
import { ClaudeSelfReviewer } from './claude-self.js';
import { CodexReviewer } from './codex.js';
import type { AdversarialReviewer } from './types.js';

export interface SelectionResult {
  reviewer: AdversarialReviewer;
  /**
   * `true` iff we fell back to a less-preferred reviewer than the operator
   * would have gotten in the default Codex-available case.
   */
  degraded: boolean;
  /** Short machine-readable code — one of the literals below. */
  reason: SelectionReason;
}

/**
 * Closed enum of reasons so downstream code can switch on it without
 * stringly-typed comparisons. Stable — adding a new case is fine; renaming
 * is a breaking change to audit consumers.
 */
export type SelectionReason =
  | 'env:REA_REVIEWER'
  | 'registry.reviewer'
  | 'policy.review.codex_required=false'
  | 'default:codex-available'
  | 'default:codex-unavailable-fallback';

/**
 * Narrow seam so tests can stub reviewer construction without touching
 * process env or the Anthropic SDK.
 */
export interface SelectorDeps {
  makeCodex: () => AdversarialReviewer;
  makeClaudeSelf: () => AdversarialReviewer;
}

const defaultDeps: SelectorDeps = {
  makeCodex: () => new CodexReviewer(),
  makeClaudeSelf: () => new ClaudeSelfReviewer(),
};

/**
 * Thrown when neither Codex nor ClaudeSelfReviewer can run. Keep the
 * message actionable — the operator should know which knobs to flip.
 */
export class NoReviewerAvailableError extends Error {
  constructor() {
    super(
      'No adversarial reviewer is available: Codex CLI is unreachable AND ' +
        'ANTHROPIC_API_KEY is unset. Either install/authenticate the Codex ' +
        'CLI, export ANTHROPIC_API_KEY, or use the REA_SKIP_CODEX_REVIEW ' +
        'audited escape hatch (G11.1) for this push.',
    );
    this.name = 'NoReviewerAvailableError';
  }
}

function isKnownReviewer(value: string): value is RegistryReviewer {
  return value === 'codex' || value === 'claude-self';
}

/**
 * Pick the reviewer for the current branch. Callers MUST await — the
 * Codex availability probe is an exec, not a sync call.
 */
export async function selectReviewer(
  policy: Policy,
  registry: Registry,
  env: NodeJS.ProcessEnv = process.env,
  deps: SelectorDeps = defaultDeps,
): Promise<SelectionResult> {
  // 1. Env override — operator explicitly chose. We do NOT probe
  // availability here; if the operator said "use X", respect it and let
  // the reviewer's own error path surface any config problem.
  const envChoice = env['REA_REVIEWER'];
  if (typeof envChoice === 'string' && envChoice.length > 0) {
    if (!isKnownReviewer(envChoice)) {
      throw new Error(
        `REA_REVIEWER=${envChoice} is not a known reviewer. Valid values: codex, claude-self.`,
      );
    }
    return {
      reviewer: envChoice === 'codex' ? deps.makeCodex() : deps.makeClaudeSelf(),
      degraded: false,
      reason: 'env:REA_REVIEWER',
    };
  }

  // 2. Registry pin — same trust level as env, just written down.
  if (registry.reviewer !== undefined) {
    return {
      reviewer: registry.reviewer === 'codex' ? deps.makeCodex() : deps.makeClaudeSelf(),
      degraded: false,
      reason: 'registry.reviewer',
    };
  }

  // 3. Policy opt-in to no-Codex mode. Per G11.4, this is a first-class
  // choice — NOT degraded. The operator has declared ClaudeSelfReviewer
  // is good enough for this project.
  if (policy.review?.codex_required === false) {
    return {
      reviewer: deps.makeClaudeSelf(),
      degraded: false,
      reason: 'policy.review.codex_required=false',
    };
  }

  // 4. Default path — try Codex first.
  const codex = deps.makeCodex();
  if (await codex.isAvailable()) {
    return { reviewer: codex, degraded: false, reason: 'default:codex-available' };
  }

  // 5. Codex unavailable — fall back to ClaudeSelfReviewer if we can.
  const claude = deps.makeClaudeSelf();
  if (await claude.isAvailable()) {
    return {
      reviewer: claude,
      // Crucial: in this branch the operator wanted Codex and got a
      // same-model fallback instead. Audit must flag it.
      degraded: true,
      reason: 'default:codex-unavailable-fallback',
    };
  }

  throw new NoReviewerAvailableError();
}
