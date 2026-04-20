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
import type { DownstreamHealth } from '../downstream-pool.js';

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
    },
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
