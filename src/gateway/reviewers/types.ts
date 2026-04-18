/**
 * Adversarial reviewer interface — shared shape for every pluggable reviewer
 * rea knows how to dispatch through `hooks/push-review-gate.sh`.
 *
 * The push gate today hard-codes Codex. G11.2 abstracts the reviewer so we
 * have a real fallback (same-model Claude self-review) when Codex is
 * rate-limited or otherwise unavailable, and so G11.3/G11.4/G11.5 have a
 * stable contract to type-check against.
 *
 * The types live in their own file so callers (the selector, future
 * middleware, docs tooling) can import them without dragging in the runtime
 * adapters (`codex.ts`, `claude-self.ts`).
 */

/** Verdict returned by a reviewer after inspecting a diff. */
export type ReviewVerdict = 'pass' | 'concerns' | 'blocking' | 'error';

/**
 * One finding surfaced by a reviewer. Intentionally loose on optional
 * positional fields — `line` and `start_line` are mutually useful but not
 * every reviewer surfaces both, and we accept either (or neither when the
 * finding is whole-file).
 */
export interface ReviewFinding {
  category: 'security' | 'correctness' | 'edge-case' | 'test-gap' | 'api-design' | 'performance';
  severity: 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  start_line?: number;
  issue: string;
  evidence?: string;
  suggested_fix?: string;
}

/**
 * Single-reviewer result. One of these is what the push gate ultimately acts
 * on. `degraded` is a first-class signal — `false` means the operator is
 * getting the review they asked for; `true` means we fell back (same-model
 * check, truncated diff, etc.) and the audit log should reflect that.
 */
export interface ReviewResult {
  /** Short reviewer id — e.g. `codex`, `claude-self`. Matches the class `name`. */
  reviewer_name: string;
  /** Model / plugin version used to produce this review. */
  reviewer_version: string;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  /** One-sentence summary. */
  summary: string;
  /** `true` when this reviewer is a fallback for a preferred one. */
  degraded: boolean;
  /** Populated when `verdict === 'error'`. Never set on a successful review. */
  error?: string;
}

/** Input shape passed to every reviewer. */
export interface ReviewRequest {
  diff: string;
  commit_log: string;
  branch: string;
  head_sha: string;
  /** Ref the branch was diffed against (e.g. `origin/main`). */
  target: string;
  /** Optional extra paths the reviewer may want to pull into context. */
  context_hints?: string[];
}

/**
 * Implementations live in `codex.ts` and `claude-self.ts`. Future entries
 * (e.g. a cross-model OpenAI GPT-5 reviewer) land as additional classes that
 * conform to this interface — the selector decides which one runs.
 */
export interface AdversarialReviewer {
  /** Short id — `codex`, `claude-self`, etc. Used in audit records. */
  readonly name: string;
  /** Model id or plugin version. Cached at construction. */
  readonly version: string;
  /**
   * Cheap reachability check. MUST be side-effect-free beyond a bounded
   * syscall / env read, and MUST resolve within a couple of seconds so the
   * selector can fall back quickly.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Run the review. Implementations that delegate to an out-of-process agent
   * (see `CodexReviewer`) may throw rather than return `ReviewResult` — the
   * caller is expected to check the reviewer's class before dispatching.
   */
  review(req: ReviewRequest): Promise<ReviewResult>;
}
