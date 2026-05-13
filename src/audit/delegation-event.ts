/**
 * Single source of truth for the `rea.delegation_signal` audit event shape
 * (0.29.0+).
 *
 * 0.29.0 — delegation-telemetry MVP. Claude Code's PreToolUse hook tree
 * gains a new matcher (`Agent|Skill`) that pipes a redacted, hashed
 * record of every subagent dispatch and skill invocation into
 * `.rea/audit.jsonl`. The signal is observational, not gating — it
 * answers "which specialists is this session actually delegating to,
 * and how often" without altering the autonomy tree.
 *
 * # The two delegation tools
 *
 * Current Claude Code exposes exactly two delegation surfaces:
 *
 *   - `Agent` — dispatches a curated subagent (rea-orchestrator,
 *     code-reviewer, …). The agent name is at
 *     `tool_input.subagent_type`.
 *   - `Skill` — invokes a named skill (deep-dive, /loop, …). The skill
 *     name is at `tool_input.skill`.
 *
 * mcp-protocol-specialist verified BOTH payload paths against current
 * Claude Code. A Skill that internally forks an Agent fires PreToolUse
 * TWICE (Skill then Agent) for the same logical action; v1 records
 * both — deduplication lives in the reader, not the writer.
 *
 * # Not `Task`
 *
 * In current Claude Code the tools are `Agent` and `Skill`. The names
 * `TaskCreate`/`TaskList`/`TaskUpdate` belong to the unrelated todo-list
 * tool surface and MUST NOT match. The settings.json matcher is
 * `Agent|Skill` everywhere — anchored on a `^…$` boundary by the hook
 * runtime, so `Agent` doesn't accidentally collide with hypothetical
 * future tools named `Agentic…`.
 *
 * # Privacy invariant
 *
 * The raw `description` / `prompt` payload NEVER touches `.rea/audit.jsonl`
 * — only its SHA-256 hash. The hash is collision-resistant identification
 * (two identical prompts produce identical hashes, enabling
 * delegation-pattern discovery) without persisting prompt content.
 *
 * The agent / skill name field DOES land in the audit log, but is run
 * through `redactSecrets` first. A subagent_type that contains a
 * planted credential string (synthetic AWS key, GitHub token, …) is
 * replaced with `[REDACTED]` and the matching pattern names are
 * appended to the record's `redacted_fields` envelope.
 *
 * # Provider seam (kept tiny)
 *
 * Unlike `rea.local_review`, this event does NOT have a `provider`
 * field. The producer is always Claude Code's hook runtime and the
 * `emission_source: 'rea-cli'` envelope is sufficient. If a future
 * runtime (e.g. another agent host) wants to emit signals through the
 * same channel, it writes the same shape with the same tool_name and
 * relies on `session_id_observed` / `delegation_tool` for
 * disambiguation.
 *
 * # Schema version
 *
 * The literal `schema_version: 1` is part of the metadata payload. Zod
 * strict-mode rejects unknown fields, so a future v2 producer writing
 * v2-only fields against a v1 consumer fails-loud rather than silently
 * dropping data. Readers filter by `tool_name === 'rea.delegation_signal'`
 * AND `metadata.schema_version === 1`.
 */

import { z } from 'zod';

/**
 * Canonical `tool_name` on the audit record envelope. Readers filter on
 * this exact literal — anything else is a different event class.
 */
export const DELEGATION_SIGNAL_TOOL_NAME = 'rea.delegation_signal' as const;

/**
 * `server_name` envelope value. The signal originates from Claude Code's
 * hook runtime, captured by `rea hook delegation-signal` and appended
 * via the public audit-record API. Naming it `claude-code-hooks` makes
 * the producer surface unambiguous in forensic queries (vs.
 * `'rea'` which is used for first-party rea CLI events like
 * `rea.local_review`).
 */
export const DELEGATION_SIGNAL_SERVER_NAME = 'claude-code-hooks' as const;

/**
 * Schema version literal. Bumped only when the metadata shape gains a
 * non-backwards-compatible change. Adding optional fields does NOT bump
 * the version — zod's strict mode rejects them, so any new field MUST
 * either ship with a major-version bump OR have its zod parser updated
 * in lockstep.
 */
export const DELEGATION_SIGNAL_SCHEMA_VERSION = 1 as const;

/**
 * The two valid delegation-tool values. `Agent` and `Skill` are the
 * exact tool names emitted by Claude Code's PreToolUse hook payload —
 * anything else is a misclassification at the hook layer.
 */
export type DelegationTool = 'Agent' | 'Skill';

/**
 * Canonical metadata payload for `rea.delegation_signal`. Embedded
 * under `metadata` on the audit record. The audit-record envelope
 * itself supplies `tool_name`, `server_name`, `session_id`, `timestamp`,
 * `prev_hash`, `hash`, `redacted_fields`, etc. — keep those out of
 * metadata.
 */
export interface DelegationSignalMetadata {
  /**
   * Always `1` for the 0.29.0 shape. Carried as a literal so future
   * v2-aware readers can distinguish records they understand from
   * records they don't.
   */
  schema_version: typeof DELEGATION_SIGNAL_SCHEMA_VERSION;
  /**
   * Which Claude Code surface fired the hook — `'Agent'` for the
   * subagent dispatch tool, `'Skill'` for the skill invocation tool.
   * The reader CLI groups records on `subagent_type` regardless of
   * `delegation_tool` (a `deep-dive` skill and a `deep-dive` agent
   * roll into the same bucket), but the field is retained for forensic
   * queries that want to distinguish the two.
   */
  delegation_tool: DelegationTool;
  /**
   * For `Agent`: the value of `tool_input.subagent_type` at the hook
   * (e.g. `'rea-orchestrator'`).
   *
   * For `Skill`: the value of `tool_input.skill` (e.g. `'deep-dive'`).
   *
   * Always passed through `redactSecrets` before landing here. If a
   * planted secret pattern fires, this field is `'[REDACTED]'` and
   * the matching pattern name appears in the record's
   * `redacted_fields` envelope.
   *
   * Reader CLI groups records on this field.
   */
  subagent_type: string;
  /**
   * The session id Claude Code attached to the hook payload — the same
   * value the harness uses for its own correlation. Captured verbatim
   * so a future per-session breakdown (deferred to 0.29.1) can group
   * records without scanning the entire chain.
   *
   * Distinct from the audit envelope's `session_id`, which uses the
   * caller's session ("external" for the CLI subcommand). The
   * envelope's `session_id` says WHO wrote the record; this field says
   * WHO Claude Code thinks is delegating.
   */
  session_id_observed: string;
  /**
   * When the dispatching agent is itself a subagent, this is the
   * parent's subagent_type at hook-fire time. Drawn from
   * `CLAUDE_PARENT_SUBAGENT` / `tool_input.parent_subagent_type` when
   * present; `null` for top-level dispatches.
   *
   * Like `subagent_type`, redacted before landing here.
   */
  parent_subagent_type: string | null;
  /**
   * SHA-256 hex digest of `tool_input.description` (Agent) or
   * `tool_input.prompt` (Skill). When neither is present an empty
   * string is hashed — the resulting digest is the well-known
   * `e3b0c4...` constant, which readers can recognize as "no prompt".
   *
   * # Why hash, not redact
   *
   * The prompt is the actionable content of the delegation — it
   * routinely names files, customers, internal URLs, half-finished
   * thoughts. Redacting it via pattern-matching is best-effort; hashing
   * it is total. The collision-resistance of SHA-256 still lets two
   * identical prompts produce identical hashes, which is enough for
   * the delegation-pattern queries this telemetry exists to support.
   */
  invocation_description_sha256: string;
  /**
   * ISO-8601 timestamp Claude Code attached to the hook event, when
   * present. Distinct from the audit-record envelope's `timestamp`
   * (which is the moment the CLI subcommand wrote the line). Both
   * fields are useful: the envelope timestamp orders the chain,
   * `hook_event_timestamp` orders the underlying events.
   */
  hook_event_timestamp?: string;
}

/**
 * Strict-mode zod schema for the metadata payload. Unknown fields are
 * rejected — a future v2 producer must bump `DELEGATION_SIGNAL_SCHEMA_VERSION`
 * AND update this schema in the same commit, otherwise v1 readers fail
 * loud rather than silently dropping new fields.
 *
 * The schema is exported so the CLI subcommand validates its OWN
 * emitted metadata before passing it to `appendAuditRecord` — defense
 * in depth against a future refactor that wires the field set
 * incorrectly. (Same posture as `loadPolicy` self-validation.)
 */
export const DelegationSignalMetadataSchema = z
  .object({
    schema_version: z.literal(DELEGATION_SIGNAL_SCHEMA_VERSION),
    delegation_tool: z.union([z.literal('Agent'), z.literal('Skill')]),
    subagent_type: z.string(),
    session_id_observed: z.string(),
    parent_subagent_type: z.union([z.string(), z.null()]),
    invocation_description_sha256: z
      .string()
      .regex(
        /^[0-9a-f]{64}$/,
        'invocation_description_sha256 must be a lowercase 64-char hex SHA-256 digest',
      ),
    hook_event_timestamp: z.string().optional(),
  })
  .strict();

export type DelegationSignalMetadataParsed = z.infer<typeof DelegationSignalMetadataSchema>;
