/**
 * Minimal Prometheus-style metrics for `rea serve` (G5).
 *
 * The gateway exposes an OPT-IN `/metrics` endpoint when `REA_METRICS_PORT`
 * is set. The project rule is "no silent listeners" — without that env var
 * nothing binds to a port, ever. When set, we bind to 127.0.0.1 ONLY and
 * respond in the standard Prometheus text-exposition format.
 *
 * ## What we expose
 *
 *   rea_downstream_calls_total{server="<n>"}             counter
 *   rea_downstream_errors_total{server="<n>"}            counter
 *   rea_downstream_in_flight{server="<n>"}               gauge
 *   rea_audit_lines_appended_total                        counter
 *   rea_circuit_breaker_state{server="<n>"}              gauge (0=closed, 1=half-open, 2=open)
 *   rea_seconds_since_last_halt_check                     gauge
 *
 * Conventions match https://prometheus.io/docs/instrumenting/exposition_formats/
 * — Unix-epoch timestamps omitted, `# HELP` / `# TYPE` lines included.
 *
 * ## What this is NOT
 *
 * - Not full OpenTelemetry. No traces, no histograms, no exemplars. If a user
 *   needs those, they can scrape these metrics and forward, or switch to an
 *   OTel pipeline later — the primitives are isolated in this file.
 * - Not served over TLS. This is loopback-only tooling. Any cross-host scrape
 *   should tunnel through SSH or a reverse proxy.
 * - Not a labelled cardinality bomb. Labels are limited to `server` (the set
 *   of downstreams is fixed by the registry) — we do NOT label by `tool_name`
 *   or anything user-controlled, which would let a downstream blow up the
 *   metrics store.
 *
 * ## Why handcrafted?
 *
 * prom-client is small but pulls its own tree of transitive deps we don't
 * otherwise need. The exposition format is ~30 lines; we keep dep count
 * low and avoid the supply-chain surface.
 */

import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Logger } from '../log.js';

/**
 * Loopback address we bind to. IPv4 first by convention — operators expect
 * `curl http://127.0.0.1:<port>/metrics` to work without dual-stack surprise.
 */
const LOOPBACK = '127.0.0.1';

/**
 * Strict allowlist of host values that `startMetricsServer` will accept.
 * Anything else (0.0.0.0, ::, LAN IPs, hostnames) is rejected at the API
 * boundary so no in-process caller can accidentally expose the
 * unauthenticated /metrics surface to the network.
 *
 * SECURITY: Do NOT add non-loopback entries. If you need off-host scraping,
 * tunnel via SSH or front 127.0.0.1 with a TLS-terminating reverse proxy.
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1']);

/** Path we serve. All other paths get 404. */
const METRICS_PATH = '/metrics';

/**
 * Wall-clock budget for `server.close()`. Past this point any surviving
 * keep-alive sockets are destroyed outright so shutdown never waits on a
 * Prometheus scraper that is holding the connection open.
 */
const CLOSE_DEADLINE_MS = 2_000;

/**
 * Encoded values for the circuit-breaker gauge. Keep numerically ordered by
 * severity so a `max()` query surfaces the worst state.
 */
export const CIRCUIT_GAUGE = {
  closed: 0,
  halfOpen: 1,
  open: 2,
} as const;

export type CircuitGaugeValue = (typeof CIRCUIT_GAUGE)[keyof typeof CIRCUIT_GAUGE];

/**
 * In-process state for the counters and gauges. A single instance is owned
 * by the gateway and passed to any collaborator that needs to record.
 *
 * Methods mutate synchronously and never throw — metrics failures must not
 * interrupt a tool call.
 */
export class MetricsRegistry {
  private readonly downstreamCalls = new Map<string, number>();
  private readonly downstreamErrors = new Map<string, number>();
  private readonly downstreamInFlight = new Map<string, number>();
  private readonly circuitState = new Map<string, CircuitGaugeValue>();
  private auditLinesAppended = 0;
  private lastHaltCheckMs: number | null = null;

  incDownstreamCall(server: string): void {
    this.downstreamCalls.set(server, (this.downstreamCalls.get(server) ?? 0) + 1);
  }

  incDownstreamError(server: string): void {
    this.downstreamErrors.set(server, (this.downstreamErrors.get(server) ?? 0) + 1);
  }

  incDownstreamInFlight(server: string): void {
    this.downstreamInFlight.set(server, (this.downstreamInFlight.get(server) ?? 0) + 1);
  }

  decDownstreamInFlight(server: string): void {
    const next = Math.max(0, (this.downstreamInFlight.get(server) ?? 0) - 1);
    this.downstreamInFlight.set(server, next);
  }

  incAuditLines(n = 1): void {
    this.auditLinesAppended += Math.max(0, n | 0);
  }

  setCircuitState(server: string, value: CircuitGaugeValue): void {
    this.circuitState.set(server, value);
  }

  markHaltCheck(nowMs: number = Date.now()): void {
    this.lastHaltCheckMs = nowMs;
  }

  /** Snapshot for tests / diagnostics. */
  snapshot(): {
    downstreamCalls: Record<string, number>;
    downstreamErrors: Record<string, number>;
    downstreamInFlight: Record<string, number>;
    circuitState: Record<string, CircuitGaugeValue>;
    auditLinesAppended: number;
    lastHaltCheckMs: number | null;
  } {
    return {
      downstreamCalls: Object.fromEntries(this.downstreamCalls),
      downstreamErrors: Object.fromEntries(this.downstreamErrors),
      downstreamInFlight: Object.fromEntries(this.downstreamInFlight),
      circuitState: Object.fromEntries(this.circuitState),
      auditLinesAppended: this.auditLinesAppended,
      lastHaltCheckMs: this.lastHaltCheckMs,
    };
  }

  /**
   * Render the Prometheus text exposition. Every metric gets HELP + TYPE
   * headers even when its table is empty — that makes the output stable
   * across scrapes and easier to diff.
   */
  render(nowMs: number = Date.now()): string {
    const lines: string[] = [];

    const emitCounter = (name: string, help: string, rows: Map<string, number>): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [server, v] of rows) {
        lines.push(`${name}{server="${escapeLabel(server)}"} ${v}`);
      }
    };

    const emitGauge = (name: string, help: string, rows: Map<string, number>): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const [server, v] of rows) {
        lines.push(`${name}{server="${escapeLabel(server)}"} ${v}`);
      }
    };

    emitCounter(
      'rea_downstream_calls_total',
      'Total tool calls dispatched to each downstream server.',
      this.downstreamCalls,
    );

    emitCounter(
      'rea_downstream_errors_total',
      'Total failed tool calls per downstream server.',
      this.downstreamErrors,
    );

    emitGauge(
      'rea_downstream_in_flight',
      'Tool calls currently executing against each downstream server.',
      this.downstreamInFlight,
    );

    lines.push('# HELP rea_audit_lines_appended_total Audit lines appended since gateway start.');
    lines.push('# TYPE rea_audit_lines_appended_total counter');
    lines.push(`rea_audit_lines_appended_total ${this.auditLinesAppended}`);

    emitGauge(
      'rea_circuit_breaker_state',
      'Circuit breaker state per server (0=closed, 1=half-open, 2=open).',
      this.circuitState,
    );

    lines.push(
      '# HELP rea_seconds_since_last_halt_check Seconds since the middleware last consulted .rea/HALT.',
    );
    lines.push('# TYPE rea_seconds_since_last_halt_check gauge');
    const secondsSince =
      this.lastHaltCheckMs === null ? -1 : Math.max(0, (nowMs - this.lastHaltCheckMs) / 1000);
    lines.push(`rea_seconds_since_last_halt_check ${secondsSince}`);

    // Prometheus requires a trailing newline.
    return lines.join('\n') + '\n';
  }
}

/**
 * Sanitize label values per Prometheus rules (escape `\`, `"`, and newlines).
 * Server names come from the registry which already restricts the allowed
 * charset, but defense-in-depth costs nothing.
 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export interface MetricsServer {
  /** Returns the port actually bound (useful for tests that pass port 0). */
  port(): number;
  close(): Promise<void>;
}

export interface StartMetricsServerOptions {
  port: number;
  registry: MetricsRegistry;
  logger?: Logger;
  /**
   * Override the bind host. Only loopback values (`127.0.0.1`, `::1`) are
   * accepted; any other value — including `localhost`, `0.0.0.0`, `::`, or
   * any LAN IP — throws a TypeError before a socket is opened. The
   * /metrics endpoint has no auth, so binding a non-loopback interface
   * would expose gateway internals to the network.
   *
   * Default: `127.0.0.1`.
   */
  host?: string;
}

/**
 * Start a loopback-only HTTP server that serves `/metrics`.
 *
 * Security posture:
 *   - Binds to 127.0.0.1 by default. Callers cannot override to a public
 *     interface from the CLI; the `host` option exists for test injection.
 *   - Rejects every non-GET request with 405 (Prometheus scrapers only GET).
 *   - Rejects every path ≠ `/metrics` with 404. The body is a fixed string —
 *     we do NOT echo the request path, which would allow response splitting
 *     or reflected content.
 *   - No query-string parsing, no request body read, no cookies.
 */
export function startMetricsServer(opts: StartMetricsServerOptions): Promise<MetricsServer> {
  return new Promise((resolve, reject) => {
    // Track every live socket so shutdown can guarantee a bounded wall-clock.
    // `server.close()` on its own only stops accepting NEW connections —
    // keep-alive sessions (like a sticky Prometheus scraper) drain on their
    // own schedule. We destroy tracked sockets past the deadline.
    const sockets = new Set<Socket>();

    const server = http.createServer((req, res) => {
      // Defensive: if the url is missing or non-string we treat it as 404.
      const url = typeof req.url === 'string' ? req.url : '';
      // Strip any query string; exposition format endpoints ignore it.
      const pathOnly = url.split('?')[0] ?? '';

      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Allow', 'GET');
        res.end('method not allowed\n');
        return;
      }

      if (pathOnly !== METRICS_PATH) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        // Fixed body — never echo `url` here. XSS via a text/plain body is
        // limited but avoiding reflection costs nothing.
        res.end('not found\n');
        return;
      }

      try {
        const body = opts.registry.render();
        res.statusCode = 200;
        // Prometheus convention: version=0.0.4 exposition format is served as
        // text/plain. No charset is strictly required by the standard but
        // utf-8 is safe.
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.end(body);
      } catch (err) {
        // Don't leak stack or internals. Log for the operator.
        opts.logger?.error({
          event: 'metrics.render_failed',
          message: 'failed to render metrics',
          error: err instanceof Error ? err.message : String(err),
        });
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('internal error\n');
      }
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
      });
    });

    server.on('error', (err) => {
      reject(err);
    });

    // Resolve the bind host with defense-in-depth:
    //   1. The public `host` option is validated against a strict loopback
    //      allowlist. Non-loopback values throw synchronously BEFORE a socket
    //      opens — a caller bug cannot silently bind 0.0.0.0 and expose the
    //      unauthenticated endpoint.
    //   2. Default when unset: 127.0.0.1.
    let host: string;
    if (opts.host === undefined) {
      host = LOOPBACK;
    } else if (ALLOWED_HOSTS.has(opts.host)) {
      host = opts.host;
    } else {
      reject(
        new TypeError(
          `rea metrics: refusing to bind host "${opts.host}" — only loopback (127.0.0.1, ::1) is permitted; the endpoint has no auth`,
        ),
      );
      return;
    }

    server.listen(opts.port, host, () => {
      const addr = server.address();
      const actualPort =
        addr !== null && typeof addr === 'object' ? (addr as AddressInfo).port : opts.port;

      opts.logger?.info({
        event: 'metrics.listening',
        message: `metrics endpoint bound on ${host}:${actualPort}${METRICS_PATH}`,
        port: actualPort,
        host,
      });

      resolve({
        port: () => actualPort,
        close: (): Promise<void> =>
          new Promise((closeResolve) => {
            let settled = false;
            const finish = (): void => {
              if (settled) return;
              settled = true;
              clearTimeout(deadline);
              closeResolve();
            };

            // Happy path: server.close() fires when all in-flight requests
            // plus their underlying sockets have drained naturally.
            server.close(() => finish());

            // Fallback path: after CLOSE_DEADLINE_MS, destroy any surviving
            // sockets so the close callback can fire. `closeIdleConnections`
            // handles idle keep-alive sessions first (Node 18.2+), then we
            // destroy whatever is left — including in-flight requests, which
            // a stalled scraper could pin indefinitely otherwise.
            const deadline = setTimeout(() => {
              try {
                (
                  server as http.Server & { closeIdleConnections?: () => void }
                ).closeIdleConnections?.();
              } catch {
                // Best-effort — method is optional on older Node.
              }
              for (const sock of sockets) {
                try {
                  sock.destroy();
                } catch {
                  // Sockets may already be closing.
                }
              }
              sockets.clear();
              // Some platforms don't deliver the close() callback after a
              // forced socket shutdown — settle directly.
              finish();
            }, CLOSE_DEADLINE_MS);
            // Don't let the timer hold the process open if shutdown beats it.
            deadline.unref();
          }),
      });
    });
  });
}

/**
 * Parse and validate `REA_METRICS_PORT`. Returns the numeric port, or `null`
 * if the env var is unset / malformed. An out-of-range or non-numeric value
 * logs a warning and also returns null — we never silently bind on a default.
 */
export function resolveMetricsPort(raw: string | undefined, logger?: Logger): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    logger?.warn({
      event: 'metrics.port_invalid',
      message: `REA_METRICS_PORT="${raw}" is not a valid TCP port; metrics endpoint will NOT start`,
    });
    return null;
  }
  return n;
}
