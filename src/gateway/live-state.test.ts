/**
 * Unit tests for LiveStatePublisher (BUG-005, 0.9.0).
 *
 * Concerns covered:
 *   - Snapshot payload reflects per-downstream circuit state, connected,
 *     healthy, last_error, tools_count, and session-blocker counters.
 *   - Debounced writes coalesce a storm of `scheduleUpdate()` calls into
 *     ≤1 flush.
 *   - `flushNow()` is synchronous and produces valid JSON on disk.
 *   - A write failure is logged, not thrown.
 *   - `stop()` silences subsequent scheduled updates.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';
import { DownstreamPool } from './downstream-pool.js';
import { LiveStatePublisher } from './live-state.js';
import { SessionBlockerTracker } from './session-blocker.js';
import type { Registry } from '../registry/types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-live-state-'));
}

function makeRegistry(names: string[]): Registry {
  return {
    version: '1',
    servers: names.map((n) => ({
      name: n,
      command: 'node',
      args: [],
      env: {},
      enabled: true,
    })),
  };
}

describe('LiveStatePublisher', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = tmpDir();
    statePath = path.join(dir, 'serve.state.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makePublisher(serverNames: string[]): {
    publisher: LiveStatePublisher;
    pool: DownstreamPool;
    breaker: CircuitBreaker;
    blocker: SessionBlockerTracker;
  } {
    const registry = makeRegistry(serverNames);
    // Build without attempting to spawn — we never call connectAll in this test.
    const pool = new DownstreamPool(registry);
    const breaker = new CircuitBreaker({ cooldownMs: 10_000, failureThreshold: 3 });
    const blocker = new SessionBlockerTracker('S-TEST');
    const publisher = new LiveStatePublisher({
      baseDir: dir,
      stateFilePath: statePath,
      sessionId: 'S-TEST',
      startedAt: '2026-04-20T00:00:00Z',
      metricsPort: 9090,
      pool,
      breaker,
      sessionBlocker: blocker,
      debounceMs: 20,
    });
    return { publisher, pool, breaker, blocker };
  }

  it('initial snapshot includes every pool member with closed circuit', () => {
    const { publisher } = makePublisher(['alpha', 'beta']);
    publisher.flushNow();

    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    expect(raw.session_id).toBe('S-TEST');
    expect(raw.metrics_port).toBe(9090);
    const ds = raw.downstreams as Array<Record<string, unknown>>;
    expect(ds).toHaveLength(2);
    const names = new Set(ds.map((d) => d.name));
    expect(names).toEqual(new Set(['alpha', 'beta']));
    for (const d of ds) {
      expect(d.circuit_state).toBe('closed');
      expect(d.retry_at).toBeNull();
      expect(d.open_transitions).toBe(0);
      expect(d.session_blocker_emitted).toBe(false);
    }
  });

  it('reflects circuit-open state with a retry_at timestamp', () => {
    const { publisher, breaker } = makePublisher(['alpha']);
    // Force open by recording threshold failures.
    for (let i = 0; i < 3; i++) breaker.recordFailure('alpha');
    publisher.flushNow();

    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const alpha = (raw.downstreams as Array<Record<string, unknown>>)[0];
    expect(alpha?.circuit_state).toBe('open');
    expect(typeof alpha?.retry_at).toBe('string');
    // retry_at must be a valid ISO timestamp in the future.
    expect(() => new Date(alpha?.retry_at as string).toISOString()).not.toThrow();
  });

  it('scheduleUpdate debounces a storm of calls into ≤1 flush', async () => {
    const { publisher } = makePublisher(['alpha']);

    // Spy on writeFileSync to count writes. `writeFileAtomic` calls it once
    // per flush plus the rename, but the rename uses renameSync not
    // writeFileSync — so writeFileSync count == flush count.
    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      for (let i = 0; i < 50; i++) publisher.scheduleUpdate();
      expect(spy).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 40));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('session-blocker emissions flow into the snapshot', () => {
    const { publisher, blocker } = makePublisher(['alpha']);
    // Three opens → threshold 3 crossed (default in tracker is 3).
    blocker.recordCircuitTransition({ server: 'alpha', from: 'closed', to: 'open' });
    blocker.recordCircuitTransition({ server: 'alpha', from: 'half-open', to: 'open' });
    blocker.recordCircuitTransition({ server: 'alpha', from: 'half-open', to: 'open' });

    publisher.flushNow();
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const alpha = (raw.downstreams as Array<Record<string, unknown>>)[0];
    expect(alpha?.open_transitions).toBe(3);
    expect(alpha?.session_blocker_emitted).toBe(true);
  });

  it('flushNow tolerates write failure without throwing', () => {
    const { publisher } = makePublisher(['alpha']);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => publisher.flushNow()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('stop() prevents further scheduled flushes', async () => {
    const { publisher } = makePublisher(['alpha']);
    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      publisher.stop();
      publisher.scheduleUpdate();
      await new Promise((r) => setTimeout(r, 40));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
