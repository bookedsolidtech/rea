/**
 * Single source of truth for the `rea.local_review` audit event shape
 * (0.26.0+).
 *
 * The local-first delegation enforcement (CTO directive 2026-05-05)
 * replaces the soft "memory rule + orchestrator routing convention"
 * with three forceful enforcement layers:
 *
 *   1. Bash-tier PreToolUse hook (hooks/local-review-gate.sh) — refuses
 *      `git push`/`git commit` from the agent's Bash tool.
 *   2. Husky pre-push (`exec rea preflight --strict`) — refuses git push
 *      at the terminal layer.
 *   3. `rea preflight` CLI — the workhorse all enforcement layers call.
 *
 * `rea review` writes a `rea.local_review` audit entry. `rea preflight`
 * reads the audit log, finds the most recent matching entry for HEAD,
 * and exits 0/1/2 accordingly.
 *
 * # Provider seam
 *
 * The `provider` field is the LIGHT seam for future review providers
 * (Claude-subagent, Pi, Gemma). Today the only writer is `rea review`
 * with `provider: 'codex'`. Tomorrow a different provider writes the
 * SAME shape with its own `provider:` value, and `rea preflight` reads
 * any of them — no registry, no factory, no swap mechanism.
 *
 * # Skipped variants
 *
 * - `rea.local_review.skipped_override`: env-var bypass; reason logged
 * - `rea.local_review.skipped_unavailable`: codex missing + `mode: off`;
 *   no review run, gate is a no-op
 * - `rea.preflight.review_skipped`: `--no-review-check` CLI escape hatch
 *
 * Both `rea preflight` and any future audit-log reader treat these
 * sibling tool names as INFORMATIONAL — they do NOT cover HEAD. Only
 * the canonical `rea.local_review` entry (or the back-compat
 * `codex.review` entry from pre-0.26.0 audit data) covers HEAD.
 */

export const LOCAL_REVIEW_TOOL_NAME = 'rea.local_review' as const;
export const LOCAL_REVIEW_SKIPPED_OVERRIDE_TOOL_NAME = 'rea.local_review.skipped_override' as const;
export const LOCAL_REVIEW_SKIPPED_UNAVAILABLE_TOOL_NAME =
  'rea.local_review.skipped_unavailable' as const;
export const LOCAL_REVIEW_PREFLIGHT_SKIPPED_TOOL_NAME = 'rea.preflight.review_skipped' as const;

export const LOCAL_REVIEW_SERVER_NAME = 'rea' as const;

/**
 * The verdict shape — same alphabet as the push-gate's CodexVerdict.
 * `error` is reserved for future providers that surface a non-execution
 * outcome (timeout, transport failure, etc.) so `rea preflight` can
 * decide whether to honor a stale error-marker.
 */
export type LocalReviewVerdict = 'pass' | 'concerns' | 'blocking' | 'error';

/**
 * Canonical metadata payload written under `metadata` on a
 * `rea.local_review` audit record. `rea preflight` reads `head_sha`
 * (must match `git rev-parse HEAD`) and `verdict` (must not be `error`
 * for the entry to count as covering HEAD).
 *
 * `provider`, `provider_version`, `model`, `reasoning_effort` are
 * non-semantic identification — the gate doesn't read them, but
 * they're invaluable for forensic analysis ("which review producer
 * did this concerns verdict come from?").
 */
export interface LocalReviewMetadata {
  /**
   * git rev-parse HEAD at review time. Recorded for forensics.
   *
   * 0.26.0 helix-026 finding-1: prior to this release `rea preflight`
   * matched coverage by exact `head_sha`. That keyed coverage to a
   * commit that didn't exist yet at review time (the local-first flow
   * is "review → fix → commit → push" — HEAD changes between review
   * and preflight). Coverage is now matched by `content_token` instead;
   * `head_sha` remains in the payload purely for audit forensics.
   */
  head_sha: string;
  /**
   * Tree SHA of HEAD at review time — the deterministic content
   * fingerprint codex reviewed. `rea preflight` matches coverage on
   * this field. Stable across content-equivalent commits (`--amend` with
   * no edits, fixup rebases). Differs on any real content change.
   *
   * Optional for back-compat: legacy `codex.review` entries (pre-0.26.0)
   * and any future provider that can't compute a tree fingerprint should
   * omit this. `rea preflight` falls back to `head_sha` exact match when
   * `content_token` is absent.
   */
  content_token?: string;
  /** Base ref (or SHA) the review diffed against. */
  base_ref: string;
  /** Verdict alphabet shared with the push-gate. */
  verdict: LocalReviewVerdict;
  /** Total findings extracted from the review prose. */
  finding_count: number;
  /**
   * Logical name of the review provider. Today: `'codex'`. Future:
   * `'claude-subagent'`, `'gemini'`, `'pi'`. Free-form lowercase
   * identifier; the gate doesn't consume it.
   */
  provider: string;
  /** Version string of the provider binary, when available. */
  provider_version?: string;
  /** Model name passed to the provider, when applicable. */
  model?: string;
  /** Reasoning effort, when applicable to the model. */
  reasoning_effort?: string;
  /** Wall-time of the review subprocess in seconds. */
  duration_seconds: number;
  /**
   * Identifier the reviewer attached to this run. Today this is the
   * codex session id; future providers use whatever identifies a
   * single review invocation.
   */
  reviewer_session_id?: string;
}

/**
 * Metadata for the `rea.local_review.skipped_override` event. Carries
 * the reason string from the bypass env-var so audit-log readers can
 * see WHY the gate was bypassed.
 */
export interface LocalReviewSkippedOverrideMetadata {
  head_sha: string;
  /** Verbatim env-var value (the operator's reason). */
  reason: string;
  /** Which env-var was set (configurable via policy). */
  bypass_env_var: string;
}

/**
 * Metadata for the `rea.local_review.skipped_unavailable` event. This
 * fires when codex is absent AND `policy.review.local_review.mode === 'off'`
 * — `rea review` exits 0 silently with this entry recording the no-op.
 */
export interface LocalReviewSkippedUnavailableMetadata {
  head_sha?: string;
  /** Why the run was skipped: `'codex-not-installed'`, etc. */
  reason: string;
  /** Provider that was probed, e.g. `'codex'`. */
  provider: string;
}
