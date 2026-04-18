/**
 * Per-server downstream MCP connection wrapper.
 *
 * Owns the lifecycle of a single `@modelcontextprotocol/sdk` `Client` +
 * `StdioClientTransport` pair. The gateway spawns one of these per entry in
 * `.rea/registry.yaml`.
 *
 * ## Health / reconnect
 *
 * On an unclean exit from the child (transport error, non-zero exit, SIGPIPE),
 * we attempt exactly ONE reconnect. If that fails we mark the connection
 * unhealthy and every subsequent `callTool` raises an error that the
 * circuit-breaker middleware will pick up. Retries beyond that are the
 * circuit-breaker's responsibility, not ours — the pool does not spin
 * children in a tight loop.
 *
 * ## Why not request-level retries
 *
 * MCP tool calls are not idempotent by default. Retrying `send_message` after
 * a transport error could double-post. We leave the decision to the caller.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RegistryServer } from '../registry/types.js';

export interface DownstreamToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

type Health = 'healthy' | 'degraded' | 'unhealthy';

export class DownstreamConnection {
  private client: Client | null = null;
  private reconnectAttempted = false;
  private health: Health = 'healthy';

  constructor(private readonly config: RegistryServer) {}

  get name(): string {
    return this.config.name;
  }

  get isHealthy(): boolean {
    return this.health !== 'unhealthy';
  }

  async connect(): Promise<void> {
    if (this.client !== null) return;
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...process.env, ...this.config.env } as Record<string, string>,
    });
    const client = new Client(
      { name: `rea-gateway-client:${this.config.name}`, version: '0.2.0' },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      this.client = client;
      this.health = 'healthy';
    } catch (err) {
      this.health = 'unhealthy';
      throw new Error(
        `failed to connect to downstream "${this.config.name}" (${this.config.command}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async listTools(): Promise<DownstreamToolInfo[]> {
    if (this.client === null) throw new Error(`downstream "${this.config.name}" not connected`);
    const result = (await this.client.listTools()) as { tools: DownstreamToolInfo[] };
    return Array.isArray(result.tools) ? result.tools : [];
  }

  /**
   * Forward a tool call to the child process. On transport failure, attempt
   * exactly one reconnect, then bubble the error up to the middleware chain.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.client === null) {
      await this.connect();
    }
    try {
      return await this.client!.callTool({ name: toolName, arguments: args });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.reconnectAttempted) {
        this.reconnectAttempted = true;
        this.health = 'degraded';
        try {
          await this.close();
          await this.connect();
          return await this.client!.callTool({ name: toolName, arguments: args });
        } catch (reconnectErr) {
          this.health = 'unhealthy';
          throw new Error(
            `downstream "${this.config.name}" unhealthy after one reconnect: ${reconnectErr instanceof Error ? reconnectErr.message : reconnectErr}`,
          );
        }
      }
      this.health = 'unhealthy';
      throw new Error(`downstream "${this.config.name}" call failed: ${message}`);
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c === null) return;
    try {
      await c.close();
    } catch {
      // Best-effort close — child may already be gone.
    }
  }
}
