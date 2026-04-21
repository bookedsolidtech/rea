/**
 * Pool of downstream MCP connections. Owns lookup + tool-name prefixing.
 *
 * Tool names exposed to the upstream MCP client are `<serverName>__<toolName>`.
 * The gateway splits on the FIRST `__` — downstream tools that themselves
 * contain `__` in their name continue to work because the split is one-shot.
 */

import {
  DownstreamConnection,
  type DownstreamSupervisorEvent,
  type DownstreamToolInfo,
} from './downstream.js';
import type { Registry } from '../registry/types.js';
import type { Logger } from './log.js';

export interface PrefixedTool extends DownstreamToolInfo {
  /** Server name, not prefixed. */
  server: string;
  /** Full prefixed name, as exposed to the upstream client. */
  name: string;
}

/**
 * Per-downstream state surfaced by the `__rea__health` meta-tool. Kept
 * separate from the richer internal state so we only expose what a caller
 * can actually reason about.
 */
export interface DownstreamHealth {
  name: string;
  /** Registered in the registry (always true for entries present in the pool). */
  enabled: boolean;
  /** Underlying MCP client currently connected. */
  connected: boolean;
  /** Gateway considers this downstream healthy enough to route calls to. */
  healthy: boolean;
  /** Last error observed, or null if the connection is clean or never errored. */
  last_error: string | null;
  /**
   * Number of tools advertised by the downstream on the most recent
   * successful `tools/list`, or null when never listed / listing failed.
   */
  tools_count: number | null;
}

export class DownstreamPool {
  private readonly connections = new Map<string, DownstreamConnection>();
  /**
   * Cached tool counts from the most recent successful `listAllTools` cycle,
   * keyed by server name. Surfaced via `healthSnapshot()` so the meta-tool
   * can report per-server counts even when the current listing pass fails
   * or is skipped. Stale but truthful > absent.
   */
  private readonly lastToolsCount = new Map<string, number>();
  /**
   * Optional supervisor event listener wired by the gateway. The pool
   * re-emits per-connection events through this single sink so the
   * SESSION_BLOCKER tracker + state publisher only need to subscribe once.
   */
  private supervisorListener: ((event: DownstreamSupervisorEvent) => void) | null = null;

  constructor(registry: Registry, logger?: Logger) {
    for (const server of registry.servers) {
      if (!server.enabled) continue;
      const conn = new DownstreamConnection(server, logger);
      conn.onSupervisorEvent((event) => {
        this.supervisorListener?.(event);
      });
      this.connections.set(server.name, conn);
    }
  }

  /**
   * Register a supervisor-event sink. Replaces any previously registered
   * listener. Intended for the gateway to wire the SESSION_BLOCKER tracker
   * and live state publisher.
   */
  onSupervisorEvent(listener: ((event: DownstreamSupervisorEvent) => void) | null): void {
    this.supervisorListener = listener;
  }

  get size(): number {
    return this.connections.size;
  }

  async connectAll(): Promise<void> {
    const errors: string[] = [];
    await Promise.all(
      [...this.connections.values()].map(async (conn) => {
        try {
          await conn.connect();
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }),
    );
    if (errors.length > 0 && this.connections.size > 0 && errors.length === this.connections.size) {
      // Total failure — the gateway is useless. Bubble up.
      throw new Error(`all downstream connections failed:\n  - ${errors.join('\n  - ')}`);
    }
  }

  /**
   * Aggregate tools from every healthy downstream with prefixed names.
   * Unhealthy or unconnected connections are skipped — the upstream client
   * will see a smaller catalog rather than a crash.
   */
  async listAllTools(): Promise<PrefixedTool[]> {
    const out: PrefixedTool[] = [];
    for (const [server, conn] of this.connections) {
      if (!conn.isHealthy) continue;
      try {
        const tools = await conn.listTools();
        this.lastToolsCount.set(server, tools.length);
        for (const t of tools) {
          const prefixed: PrefixedTool = {
            ...t,
            server,
            name: `${server}__${t.name}`,
          };
          out.push(prefixed);
        }
      } catch {
        // Listing is best-effort — omit this server's tools this cycle.
      }
    }
    return out;
  }

  /**
   * Snapshot per-server connection state for the `__rea__health` meta-tool.
   * Pure / non-blocking — no MCP I/O — so it can be called while HALT is
   * active or while other tool calls are in-flight.
   */
  healthSnapshot(): DownstreamHealth[] {
    const out: DownstreamHealth[] = [];
    for (const [name, conn] of this.connections) {
      const cached = this.lastToolsCount.get(name);
      const connected = conn.isConnected;
      const healthy = conn.isHealthy;
      // Only surface the cached tool count when the connection is BOTH
      // connected AND healthy right now. Codex F1 caught that a dead
      // downstream was showing its last-successful count alongside
      // `healthy: false`, which is a worse-than-null diagnostic — operators
      // would read "5 tools reachable" from a server that is reachable
      // through exactly zero tools.
      const tools_count =
        connected && healthy && typeof cached === 'number' ? cached : null;
      out.push({
        name,
        enabled: true,
        connected,
        healthy,
        last_error: conn.lastError,
        tools_count,
      });
    }
    return out;
  }

  /**
   * Split a prefixed tool name and dispatch. Returns the raw result from the
   * downstream (the gateway response handler shapes it for the upstream reply).
   */
  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<unknown> {
    const { server, tool } = splitPrefixed(prefixedName);
    const conn = this.connections.get(server);
    if (conn === undefined) {
      throw new Error(`unknown downstream server "${server}" for tool "${prefixedName}"`);
    }
    return conn.callTool(tool, args);
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => c.close()));
    this.connections.clear();
  }

  /** Visible for tests: get a connection by server name. */
  getConnection(serverName: string): DownstreamConnection | undefined {
    return this.connections.get(serverName);
  }
}

export function splitPrefixed(prefixedName: string): { server: string; tool: string } {
  const idx = prefixedName.indexOf('__');
  if (idx === -1) {
    throw new Error(
      `tool name "${prefixedName}" is missing the server prefix — expected "<server>__<tool>"`,
    );
  }
  return {
    server: prefixedName.slice(0, idx),
    tool: prefixedName.slice(idx + 2),
  };
}
