export enum Tier {
  Read = 'read',
  Write = 'write',
  Destructive = 'destructive',
}

export enum AutonomyLevel {
  L0 = 'L0',
  L1 = 'L1',
  L2 = 'L2',
  L3 = 'L3',
}

export enum InvocationStatus {
  Allowed = 'allowed',
  Denied = 'denied',
  Error = 'error',
}

export interface ContextProtection {
  delegate_to_subagent: string[];
  max_bash_output_lines?: number;
}

/**
 * Review policy knobs for the 0.11.0 stateless push-gate.
 *
 * The gate runs `codex exec review --json` on every push and infers a verdict
 * from the streamed findings (see `src/hooks/push-gate/findings.ts`). No
 * cache, no audit-receipt consultation, no SHA-keyed attestation. These
 * knobs shape only the immediate run.
 *
 * The 0.10.x knobs `cache_max_age_seconds` and `allow_skip_in_ci` were
 * removed in 0.11.0. `rea upgrade` strips them from consumer policy files.
 */
export interface ReviewPolicy {
  /**
   * When `true` or unset, `git push` runs `codex exec review` before the
   * push is allowed to proceed. When `false`, the push-gate short-circuits
   * to `disabled` (exit 0, audit event still recorded). No middle state —
   * either we run Codex or we don't.
   *
   * Profile default: `true` in `bst-internal`, `client-engagement`,
   * `lit-wc`, `open-source`. `false` in `*-no-codex` variants.
   */
  codex_required?: boolean;
  /**
   * Whether a `concerns` verdict blocks the push. `true` (default) means any
   * non-trivial Codex finding halts the push; the agent must address the
   * concerns (or re-run with `REA_ALLOW_CONCERNS=1` for a one-push override)
   * before retrying. `false` means only `blocking` verdicts halt — concerns
   * are logged and written to `.rea/last-review.json` but the push proceeds.
   *
   * Added in 0.11.0. Default when unset is `true` — safer posture for
   * consumers who have not thought about it.
   */
  concerns_blocks?: boolean;
  /**
   * Hard cap on the `codex exec review` subprocess in milliseconds. Exceeding
   * this kills the subprocess and the gate returns exit 2 with a timeout
   * error (audited). Default when unset is 600_000 (10 minutes) — matches
   * the upper bound we observe for a 500-line diff review on a slow link.
   *
   * Positive integer only. The loader rejects zero/negative values.
   */
  timeout_ms?: number;
}

/**
 * User-supplied redaction pattern entry. Each pattern has a stable `name` used
 * in audit events, a raw `regex` source string, and optional `flags`. The
 * loader validates every pattern via `safe-regex` at load time (G3) — any
 * pattern flagged unsafe fails the load with a specific error naming the
 * offender. The `regex` source is compiled inside a `SafeRegex` timeout
 * wrapper by the gateway at middleware-creation time.
 */
export interface UserRedactPattern {
  name: string;
  regex: string;
  flags?: string;
}

/**
 * Redaction policy knobs (G3). `match_timeout_ms` bounds every per-call regex
 * execution; `patterns` are user-supplied regexes layered on top of the
 * built-in SECRET_PATTERNS.
 */
export interface RedactPolicy {
  match_timeout_ms?: number;
  patterns?: UserRedactPattern[];
}

/**
 * Audit rotation knobs (G1). Both thresholds are optional; absence of the
 * block leaves rotation inactive (back-compat with 0.2.x behavior).
 *
 * `max_bytes` — when `.rea/audit.jsonl` crosses this size the next append
 * triggers a rotation (size-based). Typical operator setting: 50 MiB.
 *
 * `max_age_days` — when the current `audit.jsonl`'s oldest record is older
 * than this many days, the next append triggers a rotation (age-based). Both
 * triggers are evaluated independently; either crossing threshold rotates.
 *
 * Rotation renames the current file to `audit-YYYYMMDD-HHMMSS.jsonl` in the
 * same directory and seeds a fresh `audit.jsonl` with a single rotation
 * marker record whose `prev_hash` equals the SHA-256 of the last record in
 * the rotated file — preserving hash-chain continuity across the boundary.
 */
export interface AuditRotationPolicy {
  max_bytes?: number;
  max_age_days?: number;
}

export interface AuditPolicy {
  rotation?: AuditRotationPolicy;
}

/**
 * G9 — injection tier escalation knobs. The classifier bucketed matches into
 * `clean` / `suspicious` / `likely_injection`; this block governs what happens
 * to the `suspicious` bucket (a single literal match at write/destructive tier,
 * no base64 escalation). `likely_injection` is ALWAYS a deny regardless of
 * these knobs.
 *
 * `suspicious_blocks_writes` —
 *   `undefined` (omitted): middleware defaults based on `injection_detection`:
 *     block mode defaults to `true` (0.2.x parity — single literal at
 *     write/destructive tier still denies); warn mode defaults to `false`
 *     (preserves 0.2.x warn-only semantics).
 *   `false` (explicit opt-out): suspicious matches warn-only (log + audit
 *     metadata, `status: allowed`), regardless of `injection_detection`.
 *   `true` (pinned in `bst-internal*` and this repo's own policy): suspicious
 *     matches at write/destructive tier deny with verdict `suspicious` in the
 *     audit record.
 *
 * G9 follow-up (post-merge Codex finding #1): the pre-patch schema default
 * of `false` silently loosened 0.2.x `injection_detection: block` behavior
 * for any consumer who upgraded without adding the `injection:` block.
 * Making this field optional and defaulting it at the middleware restores
 * 0.2.x parity.
 */
export interface InjectionPolicy {
  suspicious_blocks_writes?: boolean;
}

/**
 * BUG-011 (0.6.2) — gateway-level policy knobs.
 *
 * `health.expose_diagnostics` governs whether `__rea__health` emits
 * `halt_reason` and per-downstream `last_error` strings in its MCP response
 * (vs. dropping them to `null`). The short-circuit responds BEFORE the
 * middleware chain — so it bypasses `redact` and `injection` middleware by
 * design (the tool must stay callable under HALT). That means downstream
 * error strings, which are populated verbatim from `err.message`, can carry
 * secrets or injection payloads all the way to the caller unless we
 * sanitize in the short-circuit path itself.
 *
 * Default `false` (fields emitted as `null`). The Helix team's explicit
 * preference was "strip, don't redact" — a smaller trust ask than trusting
 * our secret/injection pattern coverage. Operators who accept that trade-off
 * (e.g. single-tenant dev boxes) can flip `expose_diagnostics: true`, at
 * which point the short-circuit applies the same `redactSecrets` +
 * `classifyInjection` pass the middleware chain would. The full untouched
 * values always flow into the audit log regardless — diagnostics remain
 * available via `rea doctor`, just not over the MCP wire.
 */
export interface GatewayHealthPolicy {
  expose_diagnostics?: boolean;
}

export interface GatewayPolicy {
  health?: GatewayHealthPolicy;
}

export interface Policy {
  version: string;
  profile: string;
  installed_by: string;
  installed_at: string;
  autonomy_level: AutonomyLevel;
  max_autonomy_level: AutonomyLevel;
  promotion_requires_human_approval: boolean;
  block_ai_attribution: boolean;
  blocked_paths: string[];
  notification_channel: string;
  injection_detection?: 'block' | 'warn';
  injection?: InjectionPolicy;
  context_protection?: ContextProtection;
  review?: ReviewPolicy;
  redact?: RedactPolicy;
  audit?: AuditPolicy;
  gateway?: GatewayPolicy;
}
