/**
 * Per-server downstream MCP connection wrapper.
 *
 * Owns the lifecycle of a single `@modelcontextprotocol/sdk` `Client` +
 * `StdioClientTransport` pair. The gateway spawns one of these per entry in
 * `.rea/registry.yaml`.
 *
 * ## Environment inheritance
 *
 * Children do NOT inherit the operator's full `process.env`. Every child gets:
 *
 *   1. A fixed allowlist of neutral OS/runtime vars (`PATH`, `HOME`, `TZ`, …).
 *   2. Any names the registry opts into via `env_passthrough: [...]`. The
 *      schema refuses secret-looking names (TOKEN/KEY/SECRET/…) — the operator
 *      must type secrets explicitly via `env:` so the decision is conscious.
 *   3. Values from the registry's `env:` mapping. Takes precedence over 1 and 2.
 *
 * Rationale: the registry is a plain YAML file — an attacker who can write to
 * `.rea/` (or who lands a malicious template via `rea init`) should not be
 * able to exfiltrate `OPENAI_API_KEY`, `GITHUB_TOKEN`, or customer secrets by
 * spawning a child that reads `process.env`.
 *
 * ## Health / reconnect
 *
 * On a transport-layer failure we attempt exactly ONE reconnect per failure
 * episode. After a successful reconnect + retry the attempt flag resets so a
 * later, unrelated transport error (e.g. an idle socket closed by the OS after
 * hours) also gets one reconnect. A flapping guard refuses the second
 * reconnect if it lands within `RECONNECT_FLAP_WINDOW_MS` of the previous
 * successful reconnect — in that case we mark the connection unhealthy and
 * let the circuit breaker take over.
 *
 * ## Why not request-level retries
 *
 * MCP tool calls are not idempotent by default. Retrying `send_message` after
 * a transport error could double-post. We leave the decision to the caller.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RegistryServer } from '../registry/types.js';
import type { Logger } from './log.js';

export interface DownstreamToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

type Health = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Neutral env vars every child inherits. These are the ones shells/toolchains
 * need to function but carry no secrets in a well-configured environment.
 * Covers macOS, Linux, and Windows-relevant names.
 */
const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'TMPDIR',
  'TEMP',
  'TMP',
];

/**
 * Flapping window. If a transport error arrives within this many ms of the
 * previous successful reconnect, we refuse to reconnect again — the underlying
 * child is clearly unhealthy and the circuit breaker is a better place to
 * handle it.
 */
const RECONNECT_FLAP_WINDOW_MS = 30_000;

/**
 * Build the child env by layering:
 *   allowlist → registry env_passthrough → registry env.
 * Later entries win. Missing host values are skipped so `process.env[name]`
 * being undefined does not serialize as the literal string "undefined".
 *
 * Exported for testing.
 */
export function buildChildEnv(
  config: RegistryServer,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const name of DEFAULT_ENV_ALLOWLIST) {
    const v = hostEnv[name];
    if (typeof v === 'string') out[name] = v;
  }

  if (config.env_passthrough !== undefined) {
    for (const name of config.env_passthrough) {
      const v = hostEnv[name];
      if (typeof v === 'string') out[name] = v;
    }
  }

  // Explicit config.env wins — operator typed these values deliberately.
  for (const [k, v] of Object.entries(config.env)) {
    out[k] = v;
  }

  return out;
}

export class DownstreamConnection {
  private client: Client | null = null;
  /**
   * Whether a reconnect has already been attempted in the CURRENT failure
   * episode. Resets to `false` after a reconnect succeeds (so a later,
   * unrelated failure also gets one shot). A flapping guard prevents this
   * from turning into a reconnect loop.
   */
  private reconnectAttempted = false;
  /** Epoch ms of the last successful reconnect. Used by the flapping guard. */
  private lastReconnectAt = 0;
  private health: Health = 'healthy';

  constructor(
    private readonly config: RegistryServer,
    /**
     * Optional structured logger (G5). When omitted, connection lifecycle
     * events are simply not logged — keeping the class usable in unit tests
     * that don't care about observability.
     */
    private readonly logger?: Logger,
  ) {}

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
      env: buildChildEnv(this.config),
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
   * at most ONE reconnect per failure episode. After a successful reconnect
   * the episode ends and future unrelated failures will be retried again;
   * rapid back-to-back failures within the flap window are refused to avoid
   * a reconnect loop (the circuit breaker takes over in that case).
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.client === null) {
      await this.connect();
    }
    try {
      return await this.client!.callTool({ name: toolName, arguments: args });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const withinFlapWindow =
        this.lastReconnectAt !== 0 && Date.now() - this.lastReconnectAt < RECONNECT_FLAP_WINDOW_MS;

      if (!this.reconnectAttempted && !withinFlapWindow) {
        this.reconnectAttempted = true;
        this.health = 'degraded';
        this.logger?.warn({
          event: 'downstream.reconnect_attempt',
          server_name: this.config.name,
          message: `downstream "${this.config.name}" will reconnect once after error`,
          reason: message,
        });
        try {
          await this.close();
          await this.connect();
          const result = await this.client!.callTool({ name: toolName, arguments: args });
          // Success: episode closed. Reset for the NEXT unrelated failure and
          // stamp the reconnect time so flap-guard can refuse rapid repeats.
          this.reconnectAttempted = false;
          this.lastReconnectAt = Date.now();
          this.logger?.info({
            event: 'downstream.reconnected',
            server_name: this.config.name,
            message: `downstream "${this.config.name}" reconnected successfully`,
          });
          return result;
        } catch (reconnectErr) {
          this.health = 'unhealthy';
          this.logger?.error({
            event: 'downstream.reconnect_failed',
            server_name: this.config.name,
            message: `downstream "${this.config.name}" unhealthy after one reconnect`,
            error: reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr),
          });
          throw new Error(
            `downstream "${this.config.name}" unhealthy after one reconnect: ${reconnectErr instanceof Error ? reconnectErr.message : reconnectErr}`,
          );
        }
      }
      this.health = 'unhealthy';
      this.logger?.error({
        event: 'downstream.call_failed',
        server_name: this.config.name,
        message: `downstream "${this.config.name}" call failed`,
        error: message,
      });
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
