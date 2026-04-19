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
import { DownstreamPool, splitPrefixed } from './downstream-pool.js';
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
  const { baseDir, policy } = opts;
  const matchTimeoutMs = policy.redact?.match_timeout_ms ?? 100;
  const userPatterns = compileUserRedactPatterns(policy, matchTimeoutMs);
  return [
    createAuditMiddleware(baseDir, policy),
    createKillSwitchMiddleware(baseDir),
    createTierMiddleware(),
    createPolicyMiddleware(policy, undefined, baseDir),
    createBlockedPathsMiddleware(policy, baseDir),
    createRateLimitMiddleware(new RateLimiter()),
    createCircuitBreakerMiddleware(deps.breaker),
    createInjectionMiddleware(policy.injection_detection === 'warn' ? 'warn' : 'block', {
      matchTimeoutMs,
    }),
    createRedactMiddleware({ matchTimeoutMs, userPatterns }),
    createResultSizeCapMiddleware(),
  ];
}

export function createGateway(opts: GatewayOptions): GatewayHandle {
  const { registry } = opts;
  const logger = opts.logger ?? createLogger({ base: { session_id: currentSessionId() } });
  const metrics = opts.metrics;
  const pool = new DownstreamPool(registry, logger);

  const server = new Server({ name: 'rea', version: '0.2.0' }, { capabilities: { tools: {} } });

  // Build the circuit breaker with observability hooks wired in — state
  // transitions log a structured record AND update the Prometheus gauge.
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
    },
  });

  const staticChain = buildMiddlewareChain(opts, { breaker });

  // ── Handlers ─────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (pool.size === 0) return { tools: [] };
    const prefixed = await pool.listAllTools();
    return {
      tools: prefixed.map((t) => ({
        name: t.name,
        description: t.description ?? `${t.server} → ${t.name.slice(t.server.length + 2)}`,
        inputSchema: t.inputSchema ?? { type: 'object' },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const prefixed = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

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
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ event: 'gateway.shutdown', message: 'gateway stop requested' });
    try {
      await server.close();
    } catch {
      // Best-effort — may already be closed.
    }
    await pool.close();
  }

  return { server, start, stop, pool, logger, metrics };
}

// Prevent TS from complaining about the unused `Tier` import when the file is
// compiled in isolation; keeping the import pins the semantic dependency edge
// for future middleware that may want to inspect the tier in terminal.
void Tier;
