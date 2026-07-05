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

/**
 * 0.50.x — `provider: both` shadow record (parity test, Phase 5A).
 *
 * When `policy.review.provider === 'both'`, the AUTHORITATIVE Codex
 * outcome is written under the canonical `LOCAL_REVIEW_TOOL_NAME`, and
 * the OpenRouter outcome is written under THIS distinct informational
 * tool name. It is a sibling of the `skipped_*` variants: `rea preflight`
 * treats it as INFORMATIONAL — it does NOT cover HEAD.
 *
 * Correctness requirement (spec r2 § 5): if the gpt-oss outcome were
 * written under the canonical name, `findRecentLocalReview` (which takes
 * the most-recent matching entry) would accept a gpt-oss `pass` as
 * coverage and Codex would NOT actually be authoritative. Writing under
 * a distinct tool name — which `preflight.ts`'s accept-list at the
 * `findRecentLocalReview` walk does NOT include — is what makes "shadow"
 * real. Pinned by a regression test (T-SHADOW-02) that asserts a
 * shadow-only audit log produces `status: 'refuse'` from preflight.
 */
export const LOCAL_REVIEW_SHADOW_TOOL_NAME = 'rea.local_review.shadow' as const;

/**
 * 0.50.x — external-lane refusal record (security-architect §1.5).
 *
 * Written BEFORE the external (OpenRouter) lane falls back to its
 * declared local lane when the path-guard / redaction / backend-pin
 * chokepoint refuses to send the diff off-machine. Informational sibling
 * of the `skipped_*` variants — auto-excluded from preflight's coverage
 * accept-list, so it never covers HEAD on its own (the fallback lane's
 * own `rea.local_review` record provides coverage).
 *
 * Carries ONLY non-sensitive forensic fields — NEVER a raw sensitive
 * path value or any diff content (see `LocalReviewRefusedExternalMetadata`).
 */
export const LOCAL_REVIEW_REFUSED_EXTERNAL_TOOL_NAME = 'rea.local_review.refused_external' as const;

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
  /**
   * 0.50.x — the OpenRouter serving backend that produced the verdict
   * (e.g. `'fireworks'`), captured from the response's `provider` field.
   * `provider` stays `'openrouter'`; this records WHICH backend OpenRouter
   * routed to, for forensics + backend-pin verification.
   *
   * OMITTED on the codex path (codex records never carry this key, so
   * codex audit lines stay byte-identical). NEVER read by `rea preflight`
   * — purely informational, like `model`/`reasoning_effort`.
   */
  served_by?: string;
  /**
   * 0.50.x round-8 (M1) — accuracy class closure: the data-policy posture is
   * REQUESTED, not VERIFIED. `data_collection: 'deny'` is a routing constraint
   * OpenRouter enforces on ITS side; there is NO per-response no-training
   * acknowledgment. So the record states two things honestly:
   *
   *   - `data_policy_requested`: what rea ASKED for on the outbound request —
   *     always `'deny'` on an openrouter success.
   *   - `data_policy_enforced`: the DERIVED posture —
   *       `'pin-verified'`     when a non-empty `backend_pin` is set AND the
   *                            response's `served_by` is a member of it (the
   *                            operator's asserted vetted-no-train allowlist);
   *       `'routing-requested'` otherwise (the default `backend_pin: []` case)
   *                            — NOT a verified guarantee.
   *
   * Both are DERIVED in `executeOpenRouterReview` (where served_by + pin are
   * in scope) and carried on `ReviewOutcome`; review.ts does NOT recompute.
   * The literal `'deny-training'` string is gone from records. BOTH fields are
   * OMITTED on codex-only records AND on refusal/fallback records (openrouter
   * produced no kept outcome) — so codex audit lines stay byte-identical.
   */
  data_policy_requested?: string;
  /** See `data_policy_requested`. The derived enforcement posture. */
  data_policy_enforced?: 'pin-verified' | 'routing-requested';
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

/**
 * Metadata for the `rea.local_review.refused_external` event (0.50.x —
 * security-architect §1.5). Written BEFORE the external lane falls back
 * to its declared local lane when the outbound-safety chokepoint refuses
 * to send the diff to OpenRouter.
 *
 * SECURITY: carries ONLY non-sensitive forensic fields. It NEVER carries a
 * raw sensitive path value (only the `matched_rule` — the RULE that
 * matched, e.g. `'evidentiary:strawn-legal/**'`) and NEVER any diff
 * content. `changed_path_count` is a count, not the paths themselves.
 */
export interface LocalReviewRefusedExternalMetadata {
  /** Provider that was refused, e.g. `'openrouter'`. */
  attempted_provider: string;
  /**
   * Lane the run ACTUALLY fell back to. `'codex'` ONLY when codex is available
   * and will actually run; `'none'` when codex is absent and the run instead
   * skips (`mode: off`) or errors (`mode: enforced`).
   *
   * 0.50.x round-8 (M2) — accuracy class closure: probed at the TOP of
   * `fallbackToCodex` BEFORE the refusal record is written, so the record can
   * never claim a codex fallback that never runs.
   */
  fallback_provider: 'codex' | 'none' | string;
  /**
   * Why the external lane was refused. One of the security-architect's
   * refusal classes: `'path-guard'`, `'redact-timeout'`,
   * `'diff-too-large'`, `'backend-pin-violation'`,
   * `'data-policy-violation'`, `'served-by-undeterminable'`,
   * `'git-enumeration-error'`, `'path-override'`.
   */
  refusal_class: string;
  /**
   * The RULE that matched, NEVER the raw path value. For path-guard
   * refusals this is the matched pattern (e.g. `'evidentiary:strawn-legal/**'`
   * or `'blocked_paths:.env'`). Omitted for non-path refusal classes.
   */
  matched_rule?: string;
  /** Number of changed paths in the diff — a count, never the paths. */
  changed_path_count: number;
  /** git rev-parse HEAD at refusal time. */
  head_sha?: string;
  /** Base ref the review would have diffed against. */
  base_ref?: string;
}
