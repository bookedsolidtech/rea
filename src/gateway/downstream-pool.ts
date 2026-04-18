/**
 * Pool of downstream MCP connections. Owns lookup + tool-name prefixing.
 *
 * Tool names exposed to the upstream MCP client are `<serverName>__<toolName>`.
 * The gateway splits on the FIRST `__` — downstream tools that themselves
 * contain `__` in their name continue to work because the split is one-shot.
 */

import { DownstreamConnection, type DownstreamToolInfo } from './downstream.js';
import type { Registry } from '../registry/types.js';

export interface PrefixedTool extends DownstreamToolInfo {
  /** Server name, not prefixed. */
  server: string;
  /** Full prefixed name, as exposed to the upstream client. */
  name: string;
}

export class DownstreamPool {
  private readonly connections = new Map<string, DownstreamConnection>();

  constructor(registry: Registry) {
    for (const server of registry.servers) {
      if (!server.enabled) continue;
      this.connections.set(server.name, new DownstreamConnection(server));
    }
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
