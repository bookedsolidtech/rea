/**
 * Gateway-internal `__rea__health` meta-tool.
 *
 * WHY THIS EXISTS
 * ===============
 *
 * The MCP `listTools` catalog the gateway advertises is the UNION of every
 * healthy downstream's own catalog. When all downstreams are unhealthy — or
 * the registry is empty, or fingerprints fail, or an env var is missing — the
 * catalog is empty. From the LLM's perspective this is indistinguishable from
 * a gateway that came up fine but happens to have nothing to proxy, and there
 * is no tool it can call to ask "why is this empty?" because, well, the
 * catalog is empty.
 *
 * This meta-tool closes that diagnostic gap: the gateway ALWAYS exposes
 * `__rea__health` regardless of downstream state, the kill-switch, or the
 * middleware chain. A caller can invoke it to get a snapshot of every
 * registered server's connection state, last error, and tool count.
 *
 * DESIGN CHOICES
 * --------------
 *
 * 1. Name shape: `__rea__health`. The leading `__` (instead of a normal
 *    `<server>__<tool>` prefix) reserves the namespace for gateway-internal
 *    tools. It never collides with a registered server because
 *    `src/registry/loader.ts` restricts `name` to `^[a-z0-9][a-z0-9-]*$` —
 *    no underscores allowed.
 *
 * 2. Short-circuit in `server.ts`: the CallTool handler matches on the
 *    constant below BEFORE calling `splitPrefixed`, and responds directly
 *    without running the middleware chain. Reasons, ordered:
 *      (a) This tool must be callable while HALT is present — otherwise the
 *          operator can't introspect a frozen gateway.
 *      (b) Tier middleware would classify `health` as Write (default for
 *          unlisted names) and deny L0 callers — wrong for read-only
 *          introspection.
 *      (c) There is no downstream to dispatch to — the entire middleware
 *          chain is about getting to one safely.
 *    The short-circuit still writes an audit record via `appendAuditRecord`
 *    so invocations remain accountable.
 *
 * 3. Never throws. Health is the one tool the caller uses when things are
 *    broken. Every field is best-effort; a missing value is surfaced as
 *    `null`, not as an exception.
 */

import type { Policy } from '../../policy/types.js';
import { Tier } from '../../policy/types.js';
import type { DownstreamHealth } from '../downstream-pool.js';
import {
  compileDefaultSecretPatterns,
  redactSecrets,
  REDACT_TIMEOUT_SENTINEL,
  type CompiledSecretPattern,
} from '../middleware/redact.js';
import {
  classifyInjection,
  compileInjectionPatterns,
  scanStringForInjection,
  type InjectionScanResult,
} from '../middleware/injection.js';

/** Canonical MCP tool name exposed by the gateway. */
export const META_HEALTH_TOOL_NAME = '__rea__health';

/** `server_name` recorded in audit entries for this meta-tool. */
export const META_SERVER_NAME = '__rea__';

/** `tool_name` recorded in audit entries for this meta-tool. */
export const META_TOOL_NAME = 'health';

export interface MetaHealthSnapshot {
  /** rea gateway version (from package.json, pinned to the shipped version). */
  gateway: {
    version: string;
    /** Seconds since gateway process started. */
    uptime_s: number;
    /** Whether `.rea/HALT` is present. */
    halt: boolean;
    /** When true, the health tool is the only callable tool right now. */
    halt_reason: string | null;
  };
  policy: {
    profile: string;
    autonomy_level: string;
    max_autonomy_level: string;
    block_ai_attribution: boolean;
    blocked_paths_count: number;
  };
  /** Per-downstream state. Empty array iff the registry is empty. */
  downstreams: DownstreamHealth[];
  /** Rolled-up counts the LLM can act on without walking the array. */
  summary: {
    registered: number;
    connected: number;
    healthy: number;
    total_tools: number;
    /**
     * BUG-011 (0.6.2) — process-lifetime count of `meta.health` audit-append
     * failures. An operator who sees this incrementing is looking at a silent
     * observability gap: the short-circuit response is still being served,
     * but the audit log is losing entries. Surfaced here so the condition is
     * detectable without parsing stderr.
     */
    audit_fail_count: number;
  };
}

export interface BuildHealthSnapshotDeps {
  /** Gateway version (so we can test deterministically without reading package.json). */
  gatewayVersion: string;
  /** Gateway boot time in epoch ms. `uptime_s` is computed from this. */
  startedAtMs: number;
  /** Frozen policy snapshot — we do not re-read `.rea/policy.yaml` here. */
  policy: Policy;
  /** Per-downstream state from the pool. */
  downstreams: DownstreamHealth[];
  /** Whether `.rea/HALT` is present at snapshot time. */
  halt: boolean;
  /**
   * HALT reason, if any. `null` when HALT is absent OR when the file exists
   * but the caller couldn't read its contents — we never surface an I/O
   * exception through this tool.
   */
  haltReason: string | null;
  /** Current epoch ms. Injected for determinism in tests. */
  nowMs?: number;
  /**
   * BUG-011 (0.6.2) — process-lifetime audit-append failure counter.
   * Injected from `server.ts` so the snapshot reports a live value.
   * Absent → surfaces as 0 in the snapshot.
   */
  auditFailCount?: number;
}

/**
 * Pure function that builds the snapshot from injected state. All I/O happens
 * in the caller (`server.ts`) — keeps this testable and keeps "health never
 * throws" a local invariant rather than a chain-wide claim.
 */
export function buildHealthSnapshot(deps: BuildHealthSnapshotDeps): MetaHealthSnapshot {
  const now = deps.nowMs ?? Date.now();
  const uptime_s = Math.max(0, Math.floor((now - deps.startedAtMs) / 1000));

  let connected = 0;
  let healthy = 0;
  let total_tools = 0;
  for (const d of deps.downstreams) {
    if (d.connected) connected += 1;
    if (d.healthy) healthy += 1;
    if (typeof d.tools_count === 'number') total_tools += d.tools_count;
  }

  return {
    gateway: {
      version: deps.gatewayVersion,
      uptime_s,
      halt: deps.halt,
      halt_reason: deps.haltReason,
    },
    policy: {
      profile: deps.policy.profile,
      autonomy_level: String(deps.policy.autonomy_level),
      max_autonomy_level: String(deps.policy.max_autonomy_level),
      block_ai_attribution: deps.policy.block_ai_attribution,
      blocked_paths_count: deps.policy.blocked_paths.length,
    },
    downstreams: deps.downstreams,
    summary: {
      registered: deps.downstreams.length,
      connected,
      healthy,
      total_tools,
      audit_fail_count: deps.auditFailCount ?? 0,
    },
  };
}

/**
 * BUG-011 (0.6.2) — placeholder the sanitizer writes into any string whose
 * injection classification comes back non-clean under `expose_diagnostics`.
 * Exported so tests can assert the exact token.
 */
export const INJECTION_REDACTED_PLACEHOLDER = '<redacted: suspected injection>';

/**
 * BUG-011 (0.6.2) — max code-units of diagnostic text surfaced through the
 * meta-tool wire under `expose_diagnostics: true`. Upstream MCP error
 * messages and HALT-file contents are ADVERSARY-CONTROLLABLE (a downstream
 * can throw `new Error(huge_string)`); without a cap, an attacker can force
 * `__rea__health` responses into the hundreds of MB, DoS-ing the one tool
 * designed to remain callable when everything else is broken. 4096 UTF-16
 * code units is plenty to diagnose a real failure and cheap to keep on the
 * wire — even in the worst-case all-surrogate-pair scenario the UTF-8 byte
 * length stays under ~16 KiB. Named `_CHARS` because JavaScript string
 * `.length` and `.slice` are code-unit operations, not byte operations;
 * Codex review C-11.1 flagged the previous `_BYTES` naming as misleading.
 * Truncation happens BEFORE redact/inject scanning so those routines
 * always see bounded input.
 */
export const DIAGNOSTIC_STRING_MAX_CHARS = 4096;

const TRUNCATION_SUFFIX = '… [truncated]';

/**
 * Drop a trailing lone high-surrogate so the result is valid UTF-16 that
 * round-trips cleanly through UTF-8 encoders. `String.prototype.slice` cuts
 * at an arbitrary code-unit index — when that index falls between a
 * surrogate pair, the naive result ends with U+D800–U+DBFF on its own and
 * `Buffer.from(s, 'utf8')` silently replaces it with U+FFFD, corrupting
 * the diagnostic. Codex review C-11.2 / N-1.
 */
function dropTrailingHighSurrogate(s: string): string {
  if (s.length === 0) return s;
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/**
 * Bound a diagnostic string at `DIAGNOSTIC_STRING_MAX_CHARS` without
 * emitting a lone high-surrogate. Exported so every site that ingests an
 * adversary-controllable diagnostic string (`downstream.ts#lastError`,
 * `server.ts` HALT-file read, the sanitizer itself) shares one definition
 * of "bounded diagnostic string". Codex review N-1 (2026-04-20).
 *
 * Callers that want the `… [truncated]` sentinel appended should use
 * `truncateForDiagnostics`; callers that just need a hard upper bound
 * (audit-tap sites where a sentinel would be noise) use this directly.
 */
export function boundedDiagnosticString(s: string): string {
  if (s.length <= DIAGNOSTIC_STRING_MAX_CHARS) return s;
  return dropTrailingHighSurrogate(s.slice(0, DIAGNOSTIC_STRING_MAX_CHARS));
}

/**
 * Truncate `raw` to at most `DIAGNOSTIC_STRING_MAX_CHARS` code units
 * (including the suffix). After slicing at an arbitrary code-unit index
 * we may be left with a lone high-surrogate (U+D800–U+DBFF) — drop it
 * so downstream UTF-8 encoders don't silently replace it with U+FFFD.
 */
function truncateForDiagnostics(raw: string): string {
  if (raw.length <= DIAGNOSTIC_STRING_MAX_CHARS) return raw;
  const sliced = dropTrailingHighSurrogate(
    raw.slice(0, DIAGNOSTIC_STRING_MAX_CHARS - TRUNCATION_SUFFIX.length),
  );
  return sliced + TRUNCATION_SUFFIX;
}

/**
 * BUG-011 (0.6.2) — sanitize a snapshot before it crosses the MCP wire.
 *
 * The `__rea__health` short-circuit in `server.ts` responds BEFORE the
 * middleware chain so the tool stays callable under HALT. That bypasses the
 * normal `redact` and `injection` middleware by design — but `last_error`
 * and `halt_reason` are populated verbatim from upstream error messages
 * (`err.message` / `String(err)`) and from the HALT file contents. Both can
 * contain secrets (a downstream MCP that echoes an API key in its error
 * path) or prompt-injection payloads (any adversarial downstream).
 *
 * Sanitization strategy, gated by `policy.gateway.health.expose_diagnostics`:
 *
 *   - `undefined` or `false` (default): STRIP. `halt_reason` → `null`;
 *     every `downstreams[].last_error` → `null`. Consumers who want the raw
 *     text read the audit log (`event: meta.health`) or `rea doctor`.
 *
 *   - `true` (explicit opt-in): REDACT. Apply `redactSecrets` (default
 *     secret-pattern list, 100ms match budget per pattern) to the string;
 *     then run `classifyInjection` at `Tier.Read` (the short-circuit tier
 *     for meta-tool reads). If the classification is anything other than
 *     `clean`, replace the entire string with
 *     `INJECTION_REDACTED_PLACEHOLDER` — the post-redact output cannot be
 *     trusted as human-readable text when injection markers are present.
 *
 * Pure — no I/O, no logging, no mutation of the input snapshot. The caller
 * passes the pre-built snapshot; this returns a fresh object.
 */
export function sanitizeHealthSnapshot(
  snapshot: MetaHealthSnapshot,
  policy: Policy,
): MetaHealthSnapshot {
  const expose = policy.gateway?.health?.expose_diagnostics === true;

  if (!expose) {
    return {
      ...snapshot,
      gateway: { ...snapshot.gateway, halt_reason: null },
      downstreams: snapshot.downstreams.map((d) => ({ ...d, last_error: null })),
    };
  }

  // expose_diagnostics === true: redact + injection-scan every diagnostic
  // string. Compile patterns per-call — this path fires only when the LLM
  // (or an operator) invokes `__rea__health`, which is rare enough that the
  // allocation cost is irrelevant and the bounded freshness is a net win.
  const secretPatterns: CompiledSecretPattern[] = compileDefaultSecretPatterns({
    timeoutMs: 100,
  });
  const injectionPatterns = compileInjectionPatterns(100);

  const clean = (raw: string | null): string | null => {
    if (raw === null) return null;
    // Truncate BEFORE scanning: an adversarial downstream can produce
    // arbitrarily long error strings, and the sanitizer must not spend
    // O(n) per-pattern time on attacker-chosen n.
    const bounded = truncateForDiagnostics(raw);
    // Codex review C-11.3: `redactSecrets` returns `timedOut: true` and
    // replaces the full input with REDACT_TIMEOUT_SENTINEL when a pattern's
    // match budget is exceeded. Treat that exactly like a non-clean
    // injection verdict — the output cannot be trusted as human-readable
    // text and must not distinguish timeout-hit from pattern-hit on the
    // wire.
    //
    // N-2 defense-in-depth: also collapse when the post-redact output
    // HAPPENS to equal the sentinel (e.g., a downstream echoes the string
    // in its error text). The sentinel is a gateway-internal token; its
    // presence on the meta-tool wire is always a failure signal, not a
    // diagnostic. Collapsing to the injection placeholder keeps the
    // on-wire output indistinguishable from a real timeout.
    const { output, timedOut } = redactSecrets(bounded, secretPatterns);
    if (timedOut || output === REDACT_TIMEOUT_SENTINEL) {
      return INJECTION_REDACTED_PLACEHOLDER;
    }
    const scan: InjectionScanResult = {
      literalMatches: new Set(),
      base64DecodedMatches: new Set(),
    };
    scanStringForInjection(output, scan, injectionPatterns);
    // Tier.Read: any literal match AT ALL classifies to `likely_injection`
    // under the decision table (rule 4). That's the right bar here — a
    // meta-tool response is a read-tier surface by construction.
    const verdict = classifyInjection(scan, Tier.Read);
    if (verdict.verdict !== 'clean') return INJECTION_REDACTED_PLACEHOLDER;
    return output;
  };

  return {
    ...snapshot,
    gateway: { ...snapshot.gateway, halt_reason: clean(snapshot.gateway.halt_reason) },
    downstreams: snapshot.downstreams.map((d) => ({
      ...d,
      last_error: clean(d.last_error),
    })),
  };
}

/**
 * The descriptor the gateway advertises via `tools/list`. No arguments —
 * callers request a snapshot by calling with `{}`. Keeping the surface
 * argument-free makes the tool trivially safe for any autonomy level.
 */
export function metaHealthToolDescriptor(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: META_HEALTH_TOOL_NAME,
    description:
      'rea gateway self-diagnostic. Returns the gateway version, HALT state, policy summary, ' +
      'and per-downstream connection/health/tool-count. Always available, even when every ' +
      'downstream is unhealthy or HALT is active — this is the tool you call when listTools ' +
      'comes back empty or suspicious.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}
