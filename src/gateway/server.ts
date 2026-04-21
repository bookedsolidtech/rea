/**
 * Upstream MCP server for `rea serve`.
 *
 * Architecture:
 *
 *   Claude Code (MCP client over stdio)
 *     ↔ this Server (StdioServerTransport)
 *       ↔ middleware chain
 *         ↔ DownstreamPool
 *           ↔ per-server StdioClientTransport
 *             ↔ child MCP processes
 *
 * Every downstream tool call flows through the full middleware chain:
 *
 *   audit → kill-switch → tier → policy → blocked-paths → rate-limit →
 *   circuit-breaker → injection → redact → result-size-cap → terminal
 *
 * The terminal middleware is a thin closure that dispatches to the pool and
 * stores the response on `ctx.result`.
 *
 * Shutdown discipline: SIGTERM / SIGINT → stop accepting new calls, drain
 * in-flight work, close the pool, exit 0. No orphaned child processes.
 *
 * ## Zero-server mode
 *
 * A gateway with zero downstream servers is a valid state — it means the
 * consumer just ran `rea init` and has not yet populated `.rea/registry.yaml`.
 * We boot normally, respond to `listTools` with an empty catalog, and log
 * a pointer. Do not crash — breaking the daemon on an empty registry would
 * turn first-run into a puzzle.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DownstreamPool, splitPrefixed } from './downstream-pool.js';
import {
  boundedDiagnosticString,
  META_HEALTH_TOOL_NAME,
  META_SERVER_NAME,
  META_TOOL_NAME,
  buildHealthSnapshot,
  metaHealthToolDescriptor,
  sanitizeHealthSnapshot,
} from './meta/health.js';
import { appendAuditRecord } from '../audit/append.js';
import { getPkgVersion } from '../cli/utils.js';
import { createAuditMiddleware } from './middleware/audit.js';
import { createKillSwitchMiddleware } from './middleware/kill-switch.js';
import { createTierMiddleware } from './middleware/tier.js';
import { createPolicyMiddleware } from './middleware/policy.js';
import { createBlockedPathsMiddleware } from './middleware/blocked-paths.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';
import { createCircuitBreakerMiddleware } from './middleware/circuit-breaker.js';
import { createInjectionMiddleware } from './middleware/injection.js';
import { createRedactMiddleware, type CompiledSecretPattern } from './middleware/redact.js';
import { wrapRegex } from './redact-safe/match-timeout.js';
import { createResultSizeCapMiddleware } from './middleware/result-size-cap.js';
import { executeChain, type InvocationContext, type Middleware } from './middleware/chain.js';
import { RateLimiter } from './rate-limiter.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { currentSessionId } from './session.js';
import { SessionBlockerTracker, type SessionBlockerEvent } from './session-blocker.js';
import { LiveStatePublisher } from './live-state.js';
import type { Registry } from '../registry/types.js';
import type { Policy } from '../policy/types.js';
import { InvocationStatus, Tier } from '../policy/types.js';
import { log } from '../cli/utils.js';
import { createLogger, type Logger } from './log.js';
import { CIRCUIT_GAUGE, type MetricsRegistry } from './observability/metrics.js';

export interface GatewayOptions {
  baseDir: string;
  policy: Policy;
  registry: Registry;
  /**
   * Optional structured logger. If omitted, a default logger is created that
   * writes to `process.stderr` honoring `REA_LOG_LEVEL`. Tests inject their
   * own logger to capture records.
   */
  logger?: Logger;
  /**
   * Optional metrics registry. When supplied, the terminal middleware and
   * connection lifecycle events increment counters/gauges on it. When
   * omitted, no metrics are recorded — this keeps the gateway usable in
   * tests without bringing in the metrics surface.
   */
  metrics?: MetricsRegistry;
  /**
   * 0.9.0 — when provided, the gateway attaches a live-state publisher that
   * rewrites `.rea/serve.state.json` on circuit-breaker and supervisor
   * events so `rea status --json` can report per-downstream circuit state.
   * Tests that don't care about the state file simply omit this; the
   * gateway still tracks circuit state internally for routing decisions.
   */
  liveStateFilePath?: string;
  /**
   * 0.9.0 — boot-time metadata propagated into `serve.state.json` so
   * `rea status` can surface them alongside the new downstream block.
   * Used only when `liveStateFilePath` is supplied.
   */
  liveStateSessionId?: string;
  liveStateStartedAt?: string;
  liveStateMetricsPort?: number | null;
}

export interface GatewayHandle {
  /** Expose the Server for test harnesses that attach InMemoryTransport. */
  server: Server;
  /** Connect the Server to the provided transport (defaults to stdio). */
  start(transport?: unknown): Promise<void>;
  /** Graceful shutdown — drain in-flight, close pool, close server. */
  stop(): Promise<void>;
  /** Exposed for tests. */
  pool: DownstreamPool;
  /** The active logger — shared with serve.ts so startup messages stay in one sink. */
  logger: Logger;
  /** Optional metrics registry (undefined when the caller did not supply one). */
  metrics: MetricsRegistry | undefined;
  /**
   * 0.9.0 — exposed for tests + serve.ts shutdown path so the final flush
   * can be forced before the state file is ownership-cleaned. `null` when
   * the caller did not provide `liveStateFilePath`.
   */
  livePublisher: LiveStatePublisher | null;
  /**
   * 0.9.0 — per-session blocker tracker. Exposed so tests can observe
   * emissions and so a future reload path can reset counters on SIGHUP.
   */
  sessionBlocker: SessionBlockerTracker;
}

/**
 * Build the ordered middleware chain used on every CallToolRequest.
 * Order is prescriptive — DO NOT reorder without reading THREAT_MODEL.md §
 * "Middleware ordering". The existing unit tests in
 * `src/gateway/middleware/chain.test.ts` encode the semantic contract.
 */
/**
 * G3: compile user-supplied redact patterns (already safe-regex-cleared by
 * the policy loader) into `SafeRegex` instances with the configured timeout.
 * The loader guarantees the regex source compiles, so we only catch errors
 * defensively.
 */
function compileUserRedactPatterns(
  policy: Policy,
  matchTimeoutMs: number,
): CompiledSecretPattern[] {
  const entries = policy.redact?.patterns ?? [];
  const out: CompiledSecretPattern[] = [];
  for (const entry of entries) {
    try {
      const compiled = new RegExp(entry.regex, entry.flags);
      out.push({
        name: entry.name,
        source: 'user',
        safe: wrapRegex(compiled, { timeoutMs: matchTimeoutMs }),
      });
    } catch (err) {
      // Loader already validated these — warn and drop if an unreachable
      // corner case ever slips through.
      log(
        `[rea] WARN: skipping malformed user redact pattern "${entry.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

interface ChainDeps {
  breaker: CircuitBreaker;
}

function buildMiddlewareChain(opts: GatewayOptions, deps: ChainDeps): Middleware[] {
  const { baseDir, policy, metrics } = opts;
  const matchTimeoutMs = policy.redact?.match_timeout_ms ?? 100;
  const userPatterns = compileUserRedactPatterns(policy, matchTimeoutMs);
  return [
    // Metrics threaded through so `rea_audit_lines_appended_total` advances
    // on every durable audit append and `rea_seconds_since_last_halt_check`
    // reflects per-invocation cadence, not gateway uptime.
    createAuditMiddleware(baseDir, policy, metrics),
    createKillSwitchMiddleware(baseDir, metrics),
    createTierMiddleware(),
    createPolicyMiddleware(policy, undefined, baseDir),
    createBlockedPathsMiddleware(policy, baseDir),
    createRateLimitMiddleware(new RateLimiter()),
    createCircuitBreakerMiddleware(deps.breaker),
    createInjectionMiddleware(
      policy.injection_detection === 'warn' ? 'warn' : 'block',
      (() => {
        // G9 follow-up: preserve the tri-state for `suspiciousBlocksWrites`
        // (true / false / undefined-omitted). With `exactOptionalPropertyTypes`
        // we must omit the key entirely rather than passing `undefined` so
        // the middleware's `?? true` / `?? false` default logic runs for
        // consumers who did not configure the flag. `bst-internal*` profiles
        // pin the flag explicitly.
        const pinned = policy.injection?.suspicious_blocks_writes;
        return pinned === undefined
          ? { matchTimeoutMs }
          : { matchTimeoutMs, suspiciousBlocksWrites: pinned };
      })(),
    ),
    createRedactMiddleware({ matchTimeoutMs, userPatterns }),
    createResultSizeCapMiddleware(),
  ];
}

export function createGateway(opts: GatewayOptions): GatewayHandle {
  const { registry, policy, baseDir } = opts;
  const logger = opts.logger ?? createLogger({ base: { session_id: currentSessionId() } });
  const metrics = opts.metrics;
  const pool = new DownstreamPool(registry, logger);
  const gatewayVersion = getPkgVersion();
  const startedAtMs = Date.now();

  // 0.9.0 — SESSION_BLOCKER tracker. One per gateway process. The audit
  // sink wraps `appendAuditRecord` so a fired record lands in the hash
  // chain for forensic inspection.
  const sessionBlocker = new SessionBlockerTracker(
    currentSessionId(),
    {},
    logger,
    async (event: SessionBlockerEvent) => {
      try {
        await appendAuditRecord(baseDir, {
          tool_name: 'session_blocker',
          server_name: event.server_name,
          status: InvocationStatus.Error,
          tier: Tier.Read,
          autonomy_level: String(policy.autonomy_level),
          session_id: event.session_id,
          duration_ms: 0,
          metadata: {
            event: event.event,
            open_transitions: event.open_transitions,
            threshold: event.threshold,
            emitted_at: event.emitted_at,
          },
        });
      } catch (err) {
        logger.error({
          event: 'session_blocker.audit_failed',
          server_name: event.server_name,
          message: 'failed to append SESSION_BLOCKER audit record — log remains the sole record',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // BUG-011 (0.6.2) — process-lifetime counter of failed audit appends from
  // the `__rea__health` short-circuit. Exposed on the health snapshot as
  // `summary.audit_fail_count` so operators can detect the silent-audit-gap
  // condition without parsing stderr.
  let healthAuditFailCount = 0;

  const server = new Server({ name: 'rea', version: gatewayVersion }, { capabilities: { tools: {} } });

  // Build the circuit breaker with observability hooks wired in — state
  // transitions log a structured record AND update the Prometheus gauge.
  // 0.9.0: also feed SESSION_BLOCKER tracker and live-state publisher so
  // `rea status` and the audit chain surface per-session outages.
  let livePublisher: LiveStatePublisher | null = null;
  const breaker = new CircuitBreaker({
    onStateChange: (event) => {
      const level = event.to === 'open' ? 'warn' : 'info';
      logger[level]({
        event: `circuit.${event.to.replace('-', '_')}`,
        server_name: event.server,
        message: `circuit-breaker: "${event.server}" ${event.from} → ${event.to} (${event.reason})`,
        ...(event.retryAt !== undefined ? { retry_at: event.retryAt } : {}),
      });
      switch (event.to) {
        case 'closed':
          metrics?.setCircuitState(event.server, CIRCUIT_GAUGE.closed);
          break;
        case 'half-open':
          metrics?.setCircuitState(event.server, CIRCUIT_GAUGE.halfOpen);
          break;
        case 'open':
          metrics?.setCircuitState(event.server, CIRCUIT_GAUGE.open);
          break;
      }
      sessionBlocker.recordCircuitTransition({
        server: event.server,
        from: event.from,
        to: event.to,
      });
      livePublisher?.scheduleUpdate();
    },
  });

  const staticChain = buildMiddlewareChain(opts, { breaker });

  // Pool supervisor events (child death + respawn) → live-state publisher.
  // The tracker's own respawn handler is currently a no-op by design; we
  // route the event here so a future policy change (e.g. reset on
  // respawn-after-timeout) has a single wiring site.
  pool.onSupervisorEvent((event) => {
    if (event.kind === 'respawned') sessionBlocker.recordRespawn(event.server);
    livePublisher?.scheduleUpdate();
  });

  if (opts.liveStateFilePath !== undefined) {
    livePublisher = new LiveStatePublisher({
      baseDir,
      stateFilePath: opts.liveStateFilePath,
      sessionId: opts.liveStateSessionId ?? currentSessionId(),
      startedAt: opts.liveStateStartedAt ?? new Date(startedAtMs).toISOString(),
      metricsPort: opts.liveStateMetricsPort ?? null,
      pool,
      breaker,
      sessionBlocker,
      logger,
    });
  }

  // Read `.rea/HALT` without ever throwing. Returns `{halt, reason}` where
  // `reason` is the (trimmed) file contents or null when the file is absent
  // / unreadable. The meta-tool never surfaces I/O errors — health is the one
  // thing that has to keep working when everything else is broken.
  async function readHalt(): Promise<{ halt: boolean; reason: string | null }> {
    try {
      const contents = await fs.readFile(path.join(baseDir, '.rea', 'HALT'), 'utf8');
      const trimmed = contents.trim();
      // Hard-cap the raw read at the diagnostic string budget before it
      // enters the snapshot. An oversize HALT file (operator accident or
      // local attacker) must not cause an O(size) allocation on every
      // `__rea__health` call. `sanitizeHealthSnapshot` also truncates,
      // but capping at ingestion keeps the snapshot itself bounded.
      const bounded = boundedDiagnosticString(trimmed);
      return { halt: true, reason: bounded.length > 0 ? bounded : null };
    } catch {
      return { halt: false, reason: null };
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // The `__rea__health` meta-tool is ALWAYS advertised, regardless of
    // downstream state. This is the systemic answer to the "listTools came
    // back empty, now what?" diagnostic gap — the LLM can always call
    // health to find out why.
    const metaTool = metaHealthToolDescriptor();
    if (pool.size === 0) return { tools: [metaTool] };
    const prefixed = await pool.listAllTools();
    return {
      tools: [
        metaTool,
        ...prefixed.map((t) => ({
          name: t.name,
          description: t.description ?? `${t.server} → ${t.name.slice(t.server.length + 2)}`,
          inputSchema: t.inputSchema ?? { type: 'object' },
        })),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const prefixed = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    // Short-circuit the `__rea__health` meta-tool BEFORE the middleware chain
    // and BEFORE splitPrefixed. Reasons:
    //   - Must be callable while HALT is active (so the operator can
    //     introspect a frozen gateway). The kill-switch middleware would
    //     otherwise deny.
    //   - `deriveBaseTier('health')` defaults to Write, which would deny L0
    //     callers. Health is pure introspection — tier doesn't apply.
    //   - There's no downstream to dispatch to. The middleware chain exists
    //     to reach one safely.
    // We still write an audit record so invocations remain accountable.
    // The `__rea__` prefix is reserved for gateway-internal meta-tools.
    // Reject any unknown name in that namespace with a clear error rather
    // than letting `splitPrefixed` produce the confusing `unknown downstream
    // server ""` message for e.g. `__rea__health ` (trailing space) or a
    // future meta-tool name the client was guessing at.
    if (prefixed.startsWith('__rea__') && prefixed !== META_HEALTH_TOOL_NAME) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `reserved meta-namespace: only "${META_HEALTH_TOOL_NAME}" is defined under __rea__`,
          },
        ],
      };
    }
    if (prefixed === META_HEALTH_TOOL_NAME) {
      const startMs = Date.now();
      const haltState = await readHalt();
      // Internal snapshot carries the raw diagnostic strings — used by the
      // audit record below so operators have the full text in the log even
      // when the MCP response has them stripped/redacted.
      const internalSnapshot = buildHealthSnapshot({
        gatewayVersion,
        startedAtMs,
        policy,
        downstreams: pool.healthSnapshot(),
        halt: haltState.halt,
        haltReason: haltState.reason,
        auditFailCount: healthAuditFailCount,
      });
      // BUG-011 (0.6.2) — sanitize BEFORE serializing to the wire. Strips
      // `halt_reason` + per-downstream `last_error` by default; when
      // `gateway.health.expose_diagnostics: true` applies redactSecrets +
      // injection-scan and replaces any non-clean string with the sentinel.
      const wireSnapshot = sanitizeHealthSnapshot(internalSnapshot, policy);
      // Best-effort audit append. Failures here must never prevent the
      // caller from getting the health response — that would defeat the
      // whole point of a "works when everything else is broken" tool.
      try {
        await appendAuditRecord(baseDir, {
          tool_name: META_TOOL_NAME,
          server_name: META_SERVER_NAME,
          status: InvocationStatus.Allowed,
          tier: Tier.Read,
          autonomy_level: String(policy.autonomy_level),
          session_id: currentSessionId(),
          duration_ms: Date.now() - startMs,
          metadata: {
            halt: internalSnapshot.gateway.halt,
            // BUG-011 (0.6.2) — N-3: the audit log is the authoritative
            // trusted-operator sink for full diagnostic text. Strings are
            // already bounded at ingestion (halt-file read + downstream
            // lastError getter) via `boundedDiagnosticString`, and the
            // audit file is on local disk with hash-chained append-only
            // semantics — not LLM-reachable. Log the pre-sanitize strings
            // here so the `rea doctor` / audit-tail path preserves the
            // text the MCP wire strips under the default policy.
            halt_reason: internalSnapshot.gateway.halt_reason,
            downstreams_registered: internalSnapshot.summary.registered,
            downstreams_healthy: internalSnapshot.summary.healthy,
            downstream_errors: internalSnapshot.downstreams
              .filter((d) => d.last_error !== null)
              .map((d) => ({ name: d.name, last_error: d.last_error })),
          },
        });
      } catch (err) {
        // BUG-011 (0.6.2) — elevated from `warn` to `error`. A dropped
        // meta.health audit entry is an observability gap: the response
        // still goes out but the record of it is missing, which defeats
        // the forensic value of the hash chain for that call. Also bump a
        // process-lifetime counter surfaced on the next snapshot's
        // `summary.audit_fail_count` so operators can detect the condition
        // without parsing stderr.
        healthAuditFailCount += 1;
        logger.error({
          event: 'meta.health.audit_failed',
          message: 'failed to append audit record for __rea__health; serving response anyway',
          error: err instanceof Error ? err.message : String(err),
          audit_fail_count: healthAuditFailCount,
        });
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(wireSnapshot, null, 2),
          },
        ],
      };
    }

    // Split prefix for downstream dispatch; the terminal middleware uses the
    // full prefixed name to call the pool (which re-splits internally).
    let serverName: string;
    let toolName: string;
    try {
      const split = splitPrefixed(prefixed);
      serverName = split.server;
      toolName = split.tool;
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }

    const ctx: InvocationContext = {
      tool_name: toolName,
      server_name: serverName,
      arguments: args,
      session_id: currentSessionId(),
      status: InvocationStatus.Allowed,
      start_time: Date.now(),
      metadata: {},
    };

    const terminal: Middleware = async (context) => {
      if (context.status !== InvocationStatus.Allowed) return;
      if (pool.size === 0) {
        context.status = InvocationStatus.Denied;
        context.error = 'No downstream servers in .rea/registry.yaml — add one to enable proxying';
        return;
      }
      metrics?.incDownstreamCall(serverName);
      metrics?.incDownstreamInFlight(serverName);
      try {
        context.result = await pool.callTool(prefixed, context.arguments);
      } catch (err) {
        metrics?.incDownstreamError(serverName);
        context.status = InvocationStatus.Error;
        context.error = err instanceof Error ? err.message : String(err);
      } finally {
        metrics?.decDownstreamInFlight(serverName);
      }
    };

    try {
      await executeChain([...staticChain, terminal], ctx);
    } catch (err) {
      // executeChain will have run the audit middleware's try/finally; any
      // error that escapes is bubbled here. Convert to an isError response.
      ctx.status = InvocationStatus.Error;
      ctx.error = err instanceof Error ? err.message : String(err);
    }

    // ── Response mapping ──────────────────────────────────────────────────
    if (ctx.status === InvocationStatus.Denied) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: ctx.error ?? 'denied',
          },
        ],
      };
    }
    if (ctx.status === InvocationStatus.Error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: ctx.error ?? 'error',
          },
        ],
      };
    }
    // Allowed — return the downstream's raw result. Most MCP servers return
    // a `{ content: [...] }` object already; if not, wrap in a text content.
    if (
      ctx.result !== null &&
      typeof ctx.result === 'object' &&
      'content' in (ctx.result as Record<string, unknown>)
    ) {
      return ctx.result as Record<string, unknown>;
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: typeof ctx.result === 'string' ? ctx.result : JSON.stringify(ctx.result),
        },
      ],
    };
  });

  let started = false;
  let stopping = false;

  async function start(transport?: unknown): Promise<void> {
    if (started) return;
    started = true;

    // Connect to downstream children first so the `listTools` catalog is ready
    // by the time the upstream client connects.
    if (pool.size === 0) {
      logger.info({
        event: 'gateway.no_downstreams',
        message:
          'no downstream servers in .rea/registry.yaml — running in no-op mode. Add servers to enable proxying.',
      });
    } else {
      for (const s of registry.servers) {
        if (!s.enabled) continue;
        logger.info({
          event: 'downstream.connect_attempt',
          server_name: s.name,
          message: `connecting downstream "${s.name}"`,
        });
      }
      try {
        await pool.connectAll();
        for (const s of registry.servers) {
          if (!s.enabled) continue;
          const conn = pool.getConnection(s.name);
          if (conn !== undefined && conn.isHealthy) {
            logger.info({
              event: 'downstream.connected',
              server_name: s.name,
              message: `downstream "${s.name}" connected`,
            });
            // Every healthy downstream starts in the closed state — record
            // the initial circuit-breaker gauge so scrapers see a baseline.
            metrics?.setCircuitState(s.name, CIRCUIT_GAUGE.closed);
          } else {
            logger.warn({
              event: 'downstream.unhealthy_on_start',
              server_name: s.name,
              message: `downstream "${s.name}" did not come up healthy`,
            });
          }
        }
      } catch (err) {
        logger.error({
          event: 'downstream.connect_failed',
          message: `downstream connect error: ${err instanceof Error ? err.message : err}`,
        });
        // Continue — individual connections may still be healthy.
      }
    }

    const activeTransport = transport ?? new StdioServerTransport();
    await server.connect(activeTransport as Parameters<typeof server.connect>[0]);
    // Publish the initial live-state snapshot so `rea status` sees the
    // `downstreams` block from the first moment the gateway is up, not
    // only after the first circuit transition.
    livePublisher?.flushNow();
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ event: 'gateway.shutdown', message: 'gateway stop requested' });
    // Final flush BEFORE we drop the publisher so any last-moment transition
    // (e.g. a circuit closing as pool.close() quiesces it) is reflected on
    // disk for the very last `rea status` after shutdown.
    livePublisher?.flushNow();
    livePublisher?.stop();
    try {
      await server.close();
    } catch {
      // Best-effort — may already be closed.
    }
    await pool.close();
  }

  return {
    server,
    start,
    stop,
    pool,
    logger,
    metrics,
    livePublisher,
    sessionBlocker,
  };
}
