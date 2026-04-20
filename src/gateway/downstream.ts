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
import { interpolateEnv } from '../registry/interpolate.js';
import type { RegistryServer } from '../registry/types.js';
import type { Logger } from './log.js';
import { boundedDiagnosticString } from './meta/health.js';

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
 *   allowlist → registry env_passthrough → interpolated registry env.
 * Later entries win. Missing host values are skipped so `process.env[name]`
 * being undefined does not serialize as the literal string "undefined".
 *
 * The explicit `env:` map may contain `${VAR}` placeholders (see
 * `registry/interpolate.ts` for the exact grammar). Placeholders referencing
 * unset host vars are returned via the `missing` array — the caller MUST
 * refuse to spawn the server if `missing.length > 0`, otherwise the child
 * receives unresolved `${...}` strings which are nearly always wrong.
 *
 * Exported for testing.
 */
export interface BuiltChildEnv {
  /** Fully resolved env to pass to the child transport. */
  env: Record<string, string>;
  /**
   * Names of `${VAR}` references that were not set in `hostEnv`. When
   * non-empty, the caller MUST NOT spawn the child — mark the connection
   * unhealthy and log each entry.
   */
  missing: string[];
  /**
   * Keys in `env` whose value is secret-bearing (either because the key
   * name matches the secret-name heuristic, or because one of its
   * interpolated `${VAR}` references did). Callers MUST NOT log the
   * corresponding values.
   */
  secretKeys: string[];
}

export function buildChildEnv(
  config: RegistryServer,
  hostEnv: NodeJS.ProcessEnv = process.env,
): BuiltChildEnv {
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

  // Interpolate placeholders in config.env BEFORE layering it on top.
  // `interpolateEnv` is pure — no I/O, throws only on malformed syntax
  // (unterminated brace, empty `${}`, illegal var name). Missing host
  // vars are reported via `result.missing`; the caller decides whether
  // to refuse the spawn.
  const interp = interpolateEnv(config.env, hostEnv);

  // Explicit config.env wins — operator typed these values deliberately.
  for (const [k, v] of Object.entries(interp.resolved)) {
    out[k] = v;
  }

  return { env: out, missing: interp.missing, secretKeys: interp.secretKeys };
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
  /**
   * The most recent error observed on this connection (connect or call
   * failure). Surfaced via `__rea__health` so callers can diagnose an empty
   * tool catalog without digging through stderr logs. Set to `null` after a
   * successful connect/reconnect.
   *
   * BUG-014 (0.7.0): true ECMAScript private field + private accessor pair.
   * Every internal write `this.#lastErrorMessage = x` goes through the
   * setter, which applies `boundedDiagnosticString` at assignment time.
   * This converts the prior "bound-at-read" invariant (see `get lastError`
   * below, which was the single chokepoint before 0.7.0) into a structural
   * property: no matter how many assignment sites exist, every one produces
   * a bounded string. A future refactor can add new sites without needing
   * to know the bound exists — the setter enforces it.
   *
   * The backing field `#lastErrorBacking` is the raw storage; only the
   * setter writes to it. External code cannot reach either name because
   * both are ES-private (`#`), not TS-private.
   */
  #lastErrorBacking: string | null = null;
  get #lastErrorMessage(): string | null {
    return this.#lastErrorBacking;
  }
  set #lastErrorMessage(msg: string | null) {
    this.#lastErrorBacking =
      msg === null ? null : boundedDiagnosticString(msg);
  }

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

  /** True iff the underlying MCP client is currently connected. */
  get isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Last error observed, or null if the connection has never failed (or fully
   * recovered).
   *
   * BUG-011 (0.6.2) → BUG-014 (0.7.0): cap exposure via
   * `boundedDiagnosticString`. 0.6.2 applied the bound at *read*, which
   * meant every assignment site was trusted to eventually flow through
   * this getter. 0.7.0 moves the bound to the private *setter* above, so
   * the invariant is structural — every `this.#lastErrorMessage = x` write
   * is bounded at assignment time regardless of how many assignment sites
   * exist or where they live. We keep the read-side bound as cheap
   * defense-in-depth (it's a no-op for already-bounded strings and costs
   * O(length) in the rare case a buggy subclass seeded the backing field).
   */
  get lastError(): string | null {
    const raw = this.#lastErrorMessage;
    if (raw === null) return null;
    return boundedDiagnosticString(raw);
  }

  /**
   * Test-only seam: seed `#lastErrorMessage` via the bounded setter so
   * regression tests can assert "clear-on-success" semantics without having
   * to stage a real transport failure episode. Routes through the setter
   * (not the backing field) so the BUG-014 structural bound still applies —
   * calling this with a 10MB string still yields a truncated stored value.
   *
   * Do NOT call this outside `*.test.ts`. If product code wants to set
   * lastError, use the assignment sites inside `connect` / `callTool` — they
   * already go through the bounded setter.
   */
  _testOnly_seedLastError(msg: string | null): void {
    this.#lastErrorMessage = msg;
  }

  async connect(): Promise<void> {
    if (this.client !== null) return;

    // Resolve env BEFORE spawning. If any `${VAR}` reference in the registry's
    // explicit env: map is unset at startup, refuse to spawn this server:
    //   - log a clear, secret-safe error (only the var name appears; the
    //     resolved value would not exist anyway since it's missing)
    //   - mark this connection unhealthy so the pool skips it
    //   - leave every other server's spawn path untouched (the gateway as a
    //     whole keeps coming up)
    //
    // Malformed syntax (unterminated brace, `${}`, illegal identifier) throws
    // from interpolateEnv — that's a load-time error and we propagate it so
    // the operator sees it at startup with server context attached.
    let built: BuiltChildEnv;
    try {
      built = buildChildEnv(this.config);
    } catch (err) {
      this.health = 'unhealthy';
      const msg = `failed to resolve env for downstream "${this.config.name}": ${err instanceof Error ? err.message : err}`;
      this.#lastErrorMessage = msg;
      throw new Error(msg);
    }

    if (built.missing.length > 0) {
      this.health = 'unhealthy';
      this.#lastErrorMessage = `missing env: ${built.missing.join(', ')}`;
      // One line per missing var so grep/jq users can find the exact gap.
      // We intentionally do NOT log the env key name's VALUE (there is none —
      // it's unresolved) nor any other env values.
      for (const missingVar of built.missing) {
        console.error(
          `[rea-gateway] refusing to start downstream "${this.config.name}": ` +
            `env references ${'${'}${missingVar}${'}'} but process.env.${missingVar} is not set`,
        );
      }
      throw new Error(
        `downstream "${this.config.name}" refused to start — missing env: ${built.missing.join(', ')}`,
      );
    }

    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: built.env,
    });
    const client = new Client(
      { name: `rea-gateway-client:${this.config.name}`, version: '0.2.0' },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      this.client = client;
      this.health = 'healthy';
      this.#lastErrorMessage = null;
    } catch (err) {
      this.health = 'unhealthy';
      const msg = `failed to connect to downstream "${this.config.name}" (${this.config.command}): ${err instanceof Error ? err.message : err}`;
      this.#lastErrorMessage = msg;
      throw new Error(msg);
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
      const result = await this.client!.callTool({ name: toolName, arguments: args });
      // Clear any lingering error from a previous transient failure. Without
      // this, a connection that failed once and then recovered on the very
      // next call (same client, no reconnect) would forever report the old
      // error via `__rea__health`, misleading operators about live state.
      this.#lastErrorMessage = null;
      return result;
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
          this.#lastErrorMessage = null;
          this.logger?.info({
            event: 'downstream.reconnected',
            server_name: this.config.name,
            message: `downstream "${this.config.name}" reconnected successfully`,
          });
          return result;
        } catch (reconnectErr) {
          this.health = 'unhealthy';
          const errMsg = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
          this.#lastErrorMessage = errMsg;
          this.logger?.error({
            event: 'downstream.reconnect_failed',
            server_name: this.config.name,
            message: `downstream "${this.config.name}" unhealthy after one reconnect`,
            error: errMsg,
          });
          throw new Error(
            `downstream "${this.config.name}" unhealthy after one reconnect: ${errMsg}`,
          );
        }
      }
      this.health = 'unhealthy';
      this.#lastErrorMessage = message;
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
