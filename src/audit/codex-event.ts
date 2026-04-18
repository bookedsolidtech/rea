/**
 * Single source of truth for the `codex.review` audit event shape.
 *
 * Both the `codex-adversarial` agent (via `@bookedsolid/rea/audit`) and the
 * `push-review-gate.sh` shell hook depend on these constants. If either drifts,
 * the push gate will silently stop detecting Codex reviews. Keep them in lockstep
 * or add a structured parser to the shell gate.
 *
 * The shell gate relies on substring matches against the serialized JSON line —
 * do not reorder fields or change spellings without updating the grep patterns
 * in `hooks/push-review-gate.sh`.
 */
export const CODEX_REVIEW_TOOL_NAME = 'codex.review';
export const CODEX_REVIEW_SERVER_NAME = 'codex';

export type CodexVerdict = 'pass' | 'concerns' | 'blocking' | 'error';

export interface CodexReviewMetadata {
  /** git rev-parse HEAD at the time of the review */
  head_sha: string;
  /** base ref or SHA the review diffed against (typically `main` or a merge-base) */
  target: string;
  /** total count of findings surfaced by Codex */
  finding_count: number;
  /** verdict classification — see {@link CodexVerdict} */
  verdict: CodexVerdict;
  /** optional one-sentence summary from the reviewer */
  summary?: string;
}
