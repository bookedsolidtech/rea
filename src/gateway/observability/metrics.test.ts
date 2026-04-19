import { describe, expect, it } from 'vitest';
import http from 'node:http';
import {
  CIRCUIT_GAUGE,
  MetricsRegistry,
  resolveMetricsPort,
  startMetricsServer,
} from './metrics.js';

/** Perform a local GET and return (status, body). */
function httpGet(
  host: string,
  port: number,
  path: string,
  method: 'GET' | 'POST' | 'HEAD' = 'GET',
): Promise<{ status: number; body: string; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method,
        // Defensive timeout so a buggy server can't hang the test suite.
        timeout: 3_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            ...(typeof res.headers['content-type'] === 'string'
              ? { contentType: res.headers['content-type'] }
              : {}),
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

describe('MetricsRegistry — render', () => {
  it('renders a parseable Prometheus exposition', () => {
    const reg = new MetricsRegistry();
    reg.incDownstreamCall('slack');
    reg.incDownstreamCall('slack');
    reg.incDownstreamError('slack');
    reg.incDownstreamInFlight('slack');
    reg.incAuditLines(3);
    reg.setCircuitState('slack', CIRCUIT_GAUGE.open);
    reg.markHaltCheck(Date.now() - 5_000);

    const body = reg.render();

    // Every metric has a HELP and TYPE line.
    expect(body).toMatch(/# HELP rea_downstream_calls_total/);
    expect(body).toMatch(/# TYPE rea_downstream_calls_total counter/);
    expect(body).toMatch(/rea_downstream_calls_total\{server="slack"\} 2/);
    expect(body).toMatch(/rea_downstream_errors_total\{server="slack"\} 1/);
    expect(body).toMatch(/rea_downstream_in_flight\{server="slack"\} 1/);
    expect(body).toMatch(/rea_audit_lines_appended_total 3/);
    expect(body).toMatch(/rea_circuit_breaker_state\{server="slack"\} 2/);
    expect(body.endsWith('\n')).toBe(true);
  });

  it('returns -1 for halt-check gauge when never checked', () => {
    const reg = new MetricsRegistry();
    expect(reg.render()).toMatch(/rea_seconds_since_last_halt_check -1/);
  });

  it('clamps in-flight gauge at zero on over-decrement', () => {
    const reg = new MetricsRegistry();
    reg.decDownstreamInFlight('slack');
    reg.decDownstreamInFlight('slack');
    const snap = reg.snapshot();
    expect(snap.downstreamInFlight['slack']).toBe(0);
  });

  it('escapes backslash, quote, and newline in server-label values', () => {
    const reg = new MetricsRegistry();
    reg.incDownstreamCall('weird"\\\nname');
    const body = reg.render();
    // Double-quote becomes \", backslash becomes \\, newline becomes \n.
    expect(body).toMatch(/rea_downstream_calls_total\{server="weird\\"\\\\\\nname"\}/);
  });
});

describe('resolveMetricsPort', () => {
  it('returns null when unset / empty', () => {
    expect(resolveMetricsPort(undefined)).toBeNull();
    expect(resolveMetricsPort('')).toBeNull();
    expect(resolveMetricsPort('   ')).toBeNull();
  });

  it('parses an integer port in range', () => {
    expect(resolveMetricsPort('9464')).toBe(9464);
  });

  it('rejects out-of-range and non-integer values (no server bound)', () => {
    expect(resolveMetricsPort('0')).toBeNull();
    expect(resolveMetricsPort('65536')).toBeNull();
    expect(resolveMetricsPort('oops')).toBeNull();
    expect(resolveMetricsPort('80.5')).toBeNull();
  });
});

describe('startMetricsServer — HTTP behavior', () => {
  it('serves /metrics with exposition text', async () => {
    const reg = new MetricsRegistry();
    reg.incDownstreamCall('s1');
    const server = await startMetricsServer({ port: 0, registry: reg });

    try {
      const res = await httpGet('127.0.0.1', server.port(), '/metrics');
      expect(res.status).toBe(200);
      expect(res.contentType).toMatch(/text\/plain/);
      expect(res.body).toMatch(/rea_downstream_calls_total\{server="s1"\} 1/);
    } finally {
      await server.close();
    }
  });

  it('returns 404 on any path other than /metrics (no path reflection)', async () => {
    const reg = new MetricsRegistry();
    const server = await startMetricsServer({ port: 0, registry: reg });

    try {
      const res = await httpGet('127.0.0.1', server.port(), '/admin');
      expect(res.status).toBe(404);
      // The fixed body must NOT contain the requested path (no reflection).
      expect(res.body).not.toContain('/admin');
      expect(res.body.trim()).toBe('not found');
    } finally {
      await server.close();
    }
  });

  it('ignores query strings on /metrics (still 200, still metrics body)', async () => {
    const reg = new MetricsRegistry();
    reg.incDownstreamCall('s1');
    const server = await startMetricsServer({ port: 0, registry: reg });

    try {
      const res = await httpGet('127.0.0.1', server.port(), '/metrics?evil=%3Cscript%3E');
      expect(res.status).toBe(200);
      expect(res.body).toContain('rea_downstream_calls_total');
      // No reflection of the query string anywhere.
      expect(res.body).not.toContain('script');
    } finally {
      await server.close();
    }
  });

  it('rejects non-GET methods with 405', async () => {
    const reg = new MetricsRegistry();
    const server = await startMetricsServer({ port: 0, registry: reg });

    try {
      const res = await httpGet('127.0.0.1', server.port(), '/metrics', 'POST');
      expect(res.status).toBe(405);
    } finally {
      await server.close();
    }
  });
});
