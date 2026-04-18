import type { Tier, InvocationStatus } from '../../policy/types.js';

export interface AuditRecord {
  timestamp: string;
  session_id: string;
  tool_name: string;
  server_name: string;
  tier: Tier;
  status: InvocationStatus;
  autonomy_level: string;
  duration_ms: number;
  account_name?: string;
  error?: string;
  redacted_fields?: string[];
  /**
   * Free-form structured metadata attached by middleware or by callers emitting
   * records through the public `@bookedsolid/rea/audit` helper. Used for first-class
   * event semantics such as `codex.review` (head_sha, verdict, finding_count)
   * and consumer-defined events like `helix.plan` / `helix.apply`.
   *
   * Keys and values must be JSON-serializable. No secrets, no redactable PII —
   * the redaction middleware runs on `ctx.arguments`, not on metadata.
   */
  metadata?: Record<string, unknown>;
  hash: string;
  prev_hash: string;
}
