/**
 * G5 blocker fix #4 — audit counter integration.
 *
 * The audit middleware accepts an optional MetricsRegistry. On every
 * successful hash-chained append (post-fsync) it increments
 * `rea_audit_lines_appended_total`. The counter MUST:
 *   1. Advance once per appended line.
 *   2. Never advance when the append failed (so an operator alerting on
 *      counter velocity gets a truthful signal).
 *   3. Never throw into the middleware on registry failure.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditMiddleware } from './audit.js';
import type { InvocationContext } from './chain.js';
import { InvocationStatus, Tier } from '../../policy/types.js';
import { MetricsRegistry } from '../observability/metrics.js';

function freshCtx(overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    tool_name: 'ping',
    server_name: 'test-server',
    arguments: {},
    session_id: 'sess-1',
    status: InvocationStatus.Allowed,
    start_time: Date.now(),
    metadata: {},
    tier: Tier.Read,
    ...overrides,
  };
}

describe('audit middleware — metrics.incAuditLines integration', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rea-audit-metrics-'));
    await fsp.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true });
  });

  it('increments the counter once per successful append', async () => {
    const metrics = new MetricsRegistry();
    const mw = createAuditMiddleware(baseDir, undefined, metrics);

    // Three invocations — three appends, three increments.
    for (let i = 0; i < 3; i++) {
      const ctx = freshCtx();
      await mw(ctx, async () => {
        // happy terminal
      });
    }

    expect(metrics.snapshot().auditLinesAppended).toBe(3);
  });

  it('advances the counter for DENIED invocations too (audit covers all outcomes)', async () => {
    const metrics = new MetricsRegistry();
    const mw = createAuditMiddleware(baseDir, undefined, metrics);

    const ctx = freshCtx({ status: InvocationStatus.Denied, error: 'policy' });
    await mw(ctx, async () => {
      // Do nothing — some upstream middleware already flagged the denial.
    });

    expect(metrics.snapshot().auditLinesAppended).toBe(1);
  });

  it('advances the counter when next() throws (record is still written after fsync)', async () => {
    const metrics = new MetricsRegistry();
    const mw = createAuditMiddleware(baseDir, undefined, metrics);

    const ctx = freshCtx();
    await expect(
      mw(ctx, async () => {
        throw new Error('downstream failed');
      }),
    ).rejects.toThrow('downstream failed');

    // The middleware catches the throw, writes the audit record, increments
    // the counter, THEN re-throws. Contract: counter == 1.
    expect(metrics.snapshot().auditLinesAppended).toBe(1);
  });

  it('does not crash the middleware when incAuditLines throws', async () => {
    // Simulate a registry whose counter method is broken. The audit write
    // should still succeed and the caller should not observe a failure
    // beyond the normal invocation semantics.
    const brokenMetrics = {
      incAuditLines(): void {
        throw new Error('counter boom');
      },
    } as unknown as MetricsRegistry;

    const mw = createAuditMiddleware(baseDir, undefined, brokenMetrics);
    const ctx = freshCtx();
    await expect(
      mw(ctx, async () => {
        /* terminal */
      }),
    ).resolves.not.toThrow();

    // The audit file itself should have one line.
    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    const raw = await fsp.readFile(auditFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });

  it('works with no metrics registry (backward-compat for older callers)', async () => {
    const mw = createAuditMiddleware(baseDir);
    const ctx = freshCtx();
    await expect(
      mw(ctx, async () => {
        /* terminal */
      }),
    ).resolves.not.toThrow();

    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    const raw = await fsp.readFile(auditFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });

  it('still increments counter when first appendFile throws ENOENT and the retry succeeds', async () => {
    const registry = new MetricsRegistry();
    const mw = createAuditMiddleware(baseDir, undefined, registry);

    // Simulate the audit directory being deleted externally between ensureDir()
    // and the first appendFile(). The retry path recreates the dir and retries.
    const realAppendFile = fsp.appendFile.bind(fsp);
    let firstCall = true;
    const spy = vi.spyOn(fsp, 'appendFile').mockImplementation(async (...args) => {
      if (firstCall) {
        firstCall = false;
        const err = Object.assign(new Error('ENOENT (simulated)'), { code: 'ENOENT' });
        throw err;
      }
      return realAppendFile(...(args as Parameters<typeof fsp.appendFile>));
    });

    try {
      const ctx = freshCtx();
      await mw(ctx, async () => { /* terminal */ });
    } finally {
      spy.mockRestore();
    }

    // Counter must advance exactly once even via the retry path.
    expect(registry.snapshot().auditLinesAppended).toBe(1);

    // Retry must have actually written the record.
    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    const raw = await fsp.readFile(auditFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });
});
