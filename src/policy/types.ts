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
 * Review policy knobs. G11.2 only needs `codex_required` as an optional
 * signal to the reviewer selector; G11.4 will flesh this out into a full
 * first-class no-Codex mode (profile defaults, init defaults, etc.).
 */
export interface ReviewPolicy {
  /**
   * When `false`, the selector treats ClaudeSelfReviewer as the preferred
   * reviewer (not degraded). When `true` or unset, Codex is preferred and
   * a ClaudeSelfReviewer result is marked `degraded: true` in the audit
   * log. Default when unset is `true` (Codex required).
   */
  codex_required?: boolean;
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
  context_protection?: ContextProtection;
  review?: ReviewPolicy;
  redact?: RedactPolicy;
  audit?: AuditPolicy;
}
