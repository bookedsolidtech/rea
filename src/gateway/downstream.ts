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
 * ## Supervisor / child-death detection (0.9.0, BUG-002..003)
 *
 * The SDK `StdioClientTransport` exposes `onclose` + `onerror` callbacks that
 * fire when the child process exits or the stdio pipe errors outside a
 * caller-initiated `close()`. We wire both and treat an unexpected close as
 * "child is dead" — the next `callTool` must force a fresh connect rather
 * than calling into a stale `Client` that will reply `Not connected`.
 *
 * Before 0.9.0 the supervisor was reactive only: a dead child was not noticed
 * until the NEXT tool call tried to use it, at which point the circuit could
 * flap open → half-open → open with the child still dead because the
 * half-open probe re-used the zombie client. 0.9.0 makes death detection
 * eager: `onclose` nulls `this.client` so the very next call takes the
 * `connect()` branch and actually respawns the child.
 *
 * "Not connected" error messages from the SDK (our in-flight fallback) are
 * now also treated as fatal for the current client — we null it before the
 * one-shot reconnect path so we spawn fresh rather than retrying with the
 * same dead handle.
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

/**
 * Event emitted by {@link DownstreamConnection} when the supervisor observes
 * a lifecycle transition worth surfacing. Consumers (the pool, the
 * SESSION_BLOCKER tracker, observability sinks) subscribe via
 * {@link DownstreamConnection.onSupervisorEvent}.
 *
 * The `kind` is a narrow closed set so sinks can switch exhaustively. `reason`
 * carries the operator-readable detail; it is already bounded by
 * `boundedDiagnosticString` at the call site.
 */
export type DownstreamSupervisorEvent =
  | {
      kind: 'child_died_unexpectedly';
      server: string;
      reason: string;
    }
  | {
      kind: 'respawned';
      server: string;
    }
  | {
      /**
       * A non-transition health change. Fires whenever a visible field in
       * {@link DownstreamHealth} (health, last_error, tools_count) mutates
       * WITHOUT being accompanied by a breaker transition or respawn event.
       *
       * Codex 0.9.0 pass-2 P2a: without this event, the first failed call/
       * reconnect below the breaker threshold (or a successful `listTools`
       * that updates the cached tool count) never reaches the live state
       * publisher, so `rea status` would show stale data until some later,
       * unrelated circuit or respawn event finally flushed a snapshot.
       *
       * Firing is best-effort from the connection class; the pool additionally
       * emits this kind after `listAllTools` updates `lastToolsCount` so a
       * tool-catalog change is always visible in the next debounced snapshot.
       */
      kind: 'health_changed';
      server: string;
    };

/**
 * Substring marker for "the SDK thinks the client is still alive but the
 * child transport is already gone" errors. Matches the exact message the
 * MCP SDK throws from `Client` method calls after `onclose` has fired but
 * before our own code has re-connected. Kept as a constant so tests can
 * assert against it without string duplication.
 */
const NOT_CONNECTED_MARKER = 'Not connected';

export class DownstreamConnection {
  private client: Client | null = null;
  /**
   * Handle to the currently active transport, so our `onclose`/`onerror`
   * hooks can tell "this is the transport we care about" vs "a stale callback
   * firing after we already swapped to a new transport". Cleared in `close()`
   * BEFORE we invoke `client.close()` so our own tear-down does not race the
   * supervisor path.
   */
  private activeTransport: StdioClientTransport | null = null;
  /**
   * Set of transports currently being torn down by an in-flight `close()`.
   * `onclose` / `onerror` callbacks that fire for a transport in this set
   * must NOT be promoted to an "unexpected child death" — they are our own
   * tear-down signal.
   *
   * Codex P2 (0.9.0 review): the earlier `closingIntentionally` boolean was
   * connection-wide. Under concurrent calls, one call's `await this.close()`
   * could overlap with another call's reconnect that had already installed
   * a NEW transport. A genuine `onclose` from the new transport would hit
   * the boolean guard and be silently ignored, reintroducing the stale-
   * handle bug the patch targeted. Per-transport scoping eliminates the
   * race: only the exact transport we asked to close is silenced.
   */
  private readonly closingTransports = new Set<StdioClientTransport>();
  /**
   * Whether a reconnect has already been attempted in the CURRENT failure
   * episode. Resets to `false` after a reconnect succeeds (so a later,
   * unrelated failure also gets one shot). A flapping guard prevents this
   * from turning into a reconnect loop.
   */
  private reconnectAttempted = false;
  /** Epoch ms of the last successful reconnect. Used by the flapping guard. */
  private lastReconnectAt = 0;
  /**
   * Epoch ms of the most recent unexpected child-death event. Stamped by
   * `handleUnexpectedClose()`. 0 means "never died unexpectedly".
   *
   * Codex 0.9.0 pass-5 P2b: when `handleUnexpectedClose` nulls `this.client`,
   * the very next `callTool` takes the top-level `client === null` branch,
   * which normally bypasses the flap-window check entirely (that check lives
   * in the catch branch below, conditioned on `lastReconnectAt`). A downstream
   * that crashes immediately after every spawn would therefore be respawned
   * unconditionally on every incoming call — exactly the loop the flap
   * window is supposed to suppress. Consulting this timestamp in the
   * `client === null` branch lets us refuse the respawn when the previous
   * death is within the flap window, and the caller gets a clear error
   * instead of watching the child die again.
   */
  private unexpectedDeathAt = 0;
  private health: Health = 'healthy';
  /**
   * Optional supervisor-event listener. Set via
   * {@link onSupervisorEvent}. A single subscriber is sufficient — the pool
   * is the one consumer. Listener failures are swallowed; a broken consumer
   * must never break the connection lifecycle.
   */
  private supervisorListener: ((event: DownstreamSupervisorEvent) => void) | null = null;
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
    if (msg !== null && typeof msg !== 'string') {
      // BUG-014 defense-in-depth: the TS type gate is strict, but a future
      // refactor (or an `as unknown as string` cast) could slip a non-string
      // through. `boundedDiagnosticString` calls `.length` / `.slice` on the
      // input — a non-string would throw or silently corrupt the field. Fail
      // loud instead.
      throw new TypeError(
        `DownstreamConnection#lastErrorMessage: expected string | null, got ${typeof msg}`,
      );
    }
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
   * Register a supervisor-event listener. Intended for the pool to wire up
   * SESSION_BLOCKER tracking + observability hooks without the connection
   * class having to know about either. Only one listener is supported — a
   * second call replaces the first. Pass `null` to detach.
   */
  onSupervisorEvent(listener: ((event: DownstreamSupervisorEvent) => void) | null): void {
    this.supervisorListener = listener;
  }

  /**
   * Invoke the supervisor listener if registered. Swallows listener errors —
   * a broken observer must never break the connection state machine.
   */
  private emitSupervisorEvent(event: DownstreamSupervisorEvent): void {
    const listener = this.supervisorListener;
    if (listener === null) return;
    try {
      listener(event);
    } catch {
      // Intentionally swallowed. See JSDoc.
    }
  }

  /**
   * Emit a `health_changed` event. Called from every site that mutates a
   * health/last_error/tools_count-visible field WITHOUT firing one of the
   * louder supervisor events (`child_died_unexpectedly` / `respawned`).
   * Addresses Codex 0.9.0 pass-2 P2a — live-state was only scheduled from
   * breaker transitions and respawns, so transient errors below the breaker
   * threshold would leave `rea status` showing stale data.
   */
  private emitHealthChanged(): void {
    this.emitSupervisorEvent({ kind: 'health_changed', server: this.config.name });
  }

  /**
   * Handle an unexpected transport close. Fires when the child process exits
   * outside a caller-initiated `close()`, or when the stdio pipe errors in a
   * way the SDK surfaces as a close event.
   *
   * Contract:
   *   - Only runs for the currently-active transport (stale callbacks from
   *     an already-swapped transport are ignored).
   *   - Does NOT run when WE initiated the close (the transport is a member
   *     of `closingTransports` for the duration of our own `close()` call).
   *   - Nulls `this.client` so the next `callTool` takes the `connect()`
   *     branch and actually respawns the child.
   *   - Marks the connection unhealthy so the pool knows not to route
   *     traffic to it while we wait for the next call.
   *   - Emits a `child_died_unexpectedly` supervisor event so the pool's
   *     SESSION_BLOCKER tracker can count this even though no callTool has
   *     failed yet (the child may die mid-idle).
   */
  private handleUnexpectedClose(transport: StdioClientTransport, reason: string): void {
    // Stale callback: a previous transport's onclose firing after we've
    // already swapped in a new one. Ignore — the new transport is live and
    // we don't want to clobber it.
    if (this.activeTransport !== transport) return;
    // Per-transport intentional-close filter. Codex P2 (0.9.0 review): a
    // connection-wide boolean would let a late `onclose` from a newly
    // reconnected transport be silenced while an earlier `close()` on the
    // PREVIOUS transport was still in flight. Scoping by transport
    // identity means only the exact transport we asked to close is
    // silenced — a real death on any other transport fires normally.
    if (this.closingTransports.has(transport)) return;

    this.client = null;
    this.activeTransport = null;
    this.health = 'unhealthy';
    this.#lastErrorMessage = `child process exited unexpectedly: ${reason}`;
    // Codex 0.9.0 pass-5 P2b: stamp the death time so `callTool`'s
    // `client === null` branch can consult the flap window and refuse a
    // respawn if the child died within `RECONNECT_FLAP_WINDOW_MS`. Without
    // this, the top-level respawn path bypasses the flap guard entirely.
    this.unexpectedDeathAt = Date.now();
    this.logger?.warn({
      event: 'downstream.child_died',
      server_name: this.config.name,
      message: `downstream "${this.config.name}" child died unexpectedly — next call will respawn`,
      reason,
    });
    this.emitSupervisorEvent({
      kind: 'child_died_unexpectedly',
      server: this.config.name,
      reason,
    });
  }

  /**
   * Handle a transport-layer protocol error. onerror does NOT always imply
   * close — the SDK emits it for protocol errors too. We record the error
   * text but leave connection invalidation to the eventual onclose callback,
   * which is guaranteed to follow a fatal transport error on stdio.
   *
   * Codex 0.9.0 pass-6 P2: filter stale/intentional-close callbacks the
   * same way `handleUnexpectedClose` does. Without this, a delayed
   * onerror from a PREVIOUSLY-ACTIVE transport (one we've already torn
   * down or replaced) can clobber the HEALTHY replacement connection's
   * last_error and emit a spurious health_changed, leaving `rea status`
   * showing a stale error on a perfectly live child. The `onclose`
   * hook already enforced this filter; the `onerror` hook did not.
   */
  private handleTransportError(transport: StdioClientTransport, err: Error): void {
    if (this.activeTransport !== transport) return;
    if (this.closingTransports.has(transport)) return;
    this.#lastErrorMessage = err.message;
    this.logger?.warn({
      event: 'downstream.transport_error',
      server_name: this.config.name,
      message: `downstream "${this.config.name}" transport error`,
      error: err.message,
    });
    // Codex 0.9.0 pass-4 P2: surface the new last_error to the live-state
    // publisher immediately. Before this emit, a protocol-level transport
    // error that did NOT trigger a subsequent onclose would update
    // last_error in memory but leave `rea status` showing the previous
    // (stale) value until some unrelated circuit/respawn event flushed.
    this.emitHealthChanged();
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
   * O(length) only if a future intra-class edit writes directly to the
   * backing field instead of going through the setter).
   */
  get lastError(): string | null {
    const raw = this.#lastErrorMessage;
    if (raw === null) return null;
    return boundedDiagnosticString(raw);
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
      this.emitHealthChanged();
      throw new Error(msg);
    }

    if (built.missing.length > 0) {
      this.health = 'unhealthy';
      this.#lastErrorMessage = `missing env: ${built.missing.join(', ')}`;
      this.emitHealthChanged();
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
    // BUG-002/003: wire supervisor hooks BEFORE connect so we never miss a
    // close event that fires during the initial handshake. The hooks only
    // act on the transport we hand them — a stale callback from a previous
    // transport is ignored in `handleUnexpectedClose`.
    transport.onclose = (): void => {
      this.handleUnexpectedClose(transport, 'transport closed');
    };
    transport.onerror = (err: Error): void => {
      this.handleTransportError(transport, err);
    };

    const client = new Client(
      { name: `rea-gateway-client:${this.config.name}`, version: '0.2.0' },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      this.client = client;
      this.activeTransport = transport;
      this.health = 'healthy';
      this.#lastErrorMessage = null;
      this.emitHealthChanged();
    } catch (err) {
      this.health = 'unhealthy';
      const msg = `failed to connect to downstream "${this.config.name}" (${this.config.command}): ${err instanceof Error ? err.message : err}`;
      this.#lastErrorMessage = msg;
      // The transport may have partially started and set up child pipes —
      // tell the SDK to tear it down so we don't leak the zombie child.
      try {
        await transport.close();
      } catch {
        // Best-effort.
      }
      this.emitHealthChanged();
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
      // Codex 0.9.0 pass-5 P2b: if the previous death was inside the flap
      // window, refuse the respawn and surface the flap-window error instead.
      // This keeps a crash-on-spawn child from being respawned on every
      // incoming call — the same guarantee the `catch` branch provides for
      // transport errors on a live client. The timestamp is stamped by
      // `handleUnexpectedClose`; if the client was nulled by some other
      // path (our own `close()`, initial cold start, etc.) `unexpectedDeathAt`
      // is 0 and the check is a no-op.
      const deathWithinFlapWindow =
        this.unexpectedDeathAt !== 0 &&
        Date.now() - this.unexpectedDeathAt < RECONNECT_FLAP_WINDOW_MS;
      if (deathWithinFlapWindow) {
        this.health = 'unhealthy';
        const msg =
          `downstream "${this.config.name}" unhealthy — child died within ` +
          `flap window, refusing to respawn`;
        this.#lastErrorMessage = msg;
        this.logger?.error({
          event: 'downstream.respawn_refused_flap',
          server_name: this.config.name,
          message: msg,
          last_death_ms_ago: Date.now() - this.unexpectedDeathAt,
        });
        this.emitHealthChanged();
        throw new Error(msg);
      }
      await this.connect();
      // A successful spawn after a death ends the episode — clear the stamp
      // so future unrelated deaths get their own flap window rather than
      // inheriting this one.
      this.unexpectedDeathAt = 0;
      // Successful respawn counts as recovery for the supervisor — emit it
      // so observability sinks can reset per-server session-blocker counts.
      this.emitSupervisorEvent({ kind: 'respawned', server: this.config.name });
    }
    try {
      const result = await this.client!.callTool({ name: toolName, arguments: args });
      // Clear any lingering error from a previous transient failure. Without
      // this, a connection that failed once and then recovered on the very
      // next call (same client, no reconnect) would forever report the old
      // error via `__rea__health`, misleading operators about live state.
      //
      // Codex 0.9.0 pass-2 P2a: only emit `health_changed` when we actually
      // cleared something — the common success path runs through here every
      // call, so noisy emission would burn debounced writes. A same-value
      // write is a no-op for live-state purposes.
      const hadError = this.#lastErrorMessage !== null;
      this.#lastErrorMessage = null;
      if (hadError) this.emitHealthChanged();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const withinFlapWindow =
        this.lastReconnectAt !== 0 && Date.now() - this.lastReconnectAt < RECONNECT_FLAP_WINDOW_MS;

      // BUG-003: "Not connected" means the SDK's idea of the client state
      // has diverged from reality — usually because the child exited between
      // calls and the `onclose` hook hasn't fired yet (or raced this call).
      // Force a proper tear-down NOW so the next branch either reconnects
      // against a clean slate (reconnect branch) or leaves a null client so
      // the NEXT callTool's guard spawns fresh (terminal branch). Codex
      // 0.9.0 pass-3 P2: an earlier implementation nulled `this.client` +
      // `this.activeTransport` inline here, which made the subsequent
      // `await this.close()` below a no-op (`c` was already null) — the
      // stale child would leak until gateway shutdown. Calling `close()`
      // eagerly ensures the transport is actually closed.
      if (message.includes(NOT_CONNECTED_MARKER)) {
        try {
          await this.close();
        } catch {
          // Best-effort — close() already swallows transport close errors,
          // but belt-and-braces for any unexpected throw.
        }
      }

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
          // For non-NOT_CONNECTED paths we still need to tear down the old
          // client. When we DID take the NOT_CONNECTED branch above, `close()`
          // is idempotent: `c === null` short-circuits cleanly.
          await this.close();
          await this.connect();
          this.emitSupervisorEvent({ kind: 'respawned', server: this.config.name });
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
          this.emitHealthChanged();
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
      this.emitHealthChanged();
      throw new Error(`downstream "${this.config.name}" call failed: ${message}`);
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    // Capture the transport being closed BEFORE we null `activeTransport`,
    // so a synchronously-firing `onclose` during `c.close()` can be matched
    // against this specific transport instead of whichever transport is
    // "current" at the moment the callback lands. Codex P2 (0.9.0 review):
    // the earlier implementation used a connection-wide boolean, which
    // under concurrent calls could silence a legitimate death event for a
    // newer transport while we were still tearing down an older one.
    const closingTransport = this.activeTransport;
    if (closingTransport !== null) {
      this.closingTransports.add(closingTransport);
    }
    this.client = null;
    this.activeTransport = null;
    try {
      if (c === null) return;
      try {
        await c.close();
      } catch {
        // Best-effort close — child may already be gone.
      }
    } finally {
      if (closingTransport !== null) {
        this.closingTransports.delete(closingTransport);
      }
    }
  }
}
