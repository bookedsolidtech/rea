import type { Tier, InvocationStatus } from '../../policy/types.js';

/**
 * Emission-path discriminator for the audit record (defect P).
 *
 * The push-review gate trusts `tool_name: "codex.review"` records to certify
 * a real Codex adversarial review ran on the given commit SHA. Before this
 * field existed, any script with filesystem access to `node_modules` could
 * call `appendAuditRecord(...)` with a `codex.review` tool name and forge
 * the certification — the governance promise was a convention, not enforced.
 *
 * `emission_source` tags the code path that wrote the record:
 *
 *   - `"rea-cli"`   — emitted by the `rea` CLI itself (e.g. `rea audit
 *                     record codex-review`). The rea CLI is classified by
 *                     `reaCommandTier()` (defect E) and is an audited,
 *                     policy-governed entry point.
 *   - `"codex-cli"` — emitted by the Codex adversarial review path itself,
 *                     the authoritative source.
 *   - `"other"`     — every other caller of the public
 *                     `appendAuditRecord()` helper (consumer plugins,
 *                     ad-hoc scripts, tests). Legitimate for event types
 *                     OTHER than `codex.review`; REJECTED by the
 *                     push-review cache gate for `codex.review` lookups.
 *
 * The field is part of the hashed record body — it cannot be altered after
 * the fact without breaking the chain.
 */
export type EmissionSource = 'rea-cli' | 'codex-cli' | 'other';

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
  /**
   * Defect P (0.10.1). Discriminates the emission path: `"rea-cli"` for
   * rea's own CLI, `"codex-cli"` for the Codex adversarial reviewer,
   * `"other"` for every other caller of the public audit helper. Required
   * field; the push-review gate refuses to accept `codex.review` records
   * whose source is `"other"` (or missing, for pre-0.10.1 legacy records).
   */
  emission_source: EmissionSource;
  hash: string;
  prev_hash: string;
}
