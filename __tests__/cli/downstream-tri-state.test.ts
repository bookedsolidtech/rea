/**
 * 0.28.0 helix-025 F1 — gateway tri-state for `last_error`.
 *
 * The helix consumer reported: when a downstream's connection silently
 * fails, both `connected: false` and `last_error: null` is ambiguous —
 * is the link merely unattempted, or did it fail with no renderable
 * error string? The fix is an explicit `connection_state` field on
 * `DownstreamHealth` (and propagated through `LiveDownstreamState`):
 *
 *   - `'never'`   — connect() has not yet been called
 *   - `'ok'`      — most recent attempt cleared lastError
 *   - `'errored'` — connect / call failed; or lastError is set
 *
 * These tests pin the state machine. We use a stub registry server
 * with a deliberately broken command so `connect()` raises before the
 * supervisor wires its hooks; the connection should still report
 * `connection_state: 'errored'` (not `'never'`) because we DID try.
 */

import { describe, it, expect } from 'vitest';
import { DownstreamPool } from '../../src/gateway/downstream-pool.js';
import { DownstreamConnection } from '../../src/gateway/downstream.js';
import type { Registry, RegistryServer } from '../../src/registry/types.js';

function makeRegistry(servers: RegistryServer[]): Registry {
  return { version: '1', servers };
}

function brokenServer(name: string): RegistryServer {
  // A command that does not exist on PATH — connect() throws ENOENT
  // before MCP hand-shake, exercising the failure path.
  return {
    name,
    enabled: true,
    command: '/dev/null/no-such-binary-rea-helix-025',
    args: [],
    env: {},
  };
}

describe('helix-025 F1 — DownstreamConnection.connectionState tri-state', () => {
  it('reports `never` before connect() has run', () => {
    const conn = new DownstreamConnection(brokenServer('alpha'));
    expect(conn.connectionState).toBe('never');
  });

  it('reports `errored` after a failed connect()', async () => {
    const conn = new DownstreamConnection(brokenServer('beta'));
    await expect(conn.connect()).rejects.toThrow();
    expect(conn.connectionState).toBe('errored');
    // last_error should still be populated for diagnostic value.
    expect(conn.lastError).not.toBeNull();
  });

  it('healthSnapshot surfaces connection_state for every downstream', async () => {
    const pool = new DownstreamPool(makeRegistry([brokenServer('gamma'), brokenServer('delta')]));
    // Before any connect attempt, both report 'never'.
    const beforeSnap = pool.healthSnapshot();
    expect(beforeSnap).toHaveLength(2);
    for (const h of beforeSnap) {
      expect(h.connection_state).toBe('never');
      expect(h.connected).toBe(false);
      expect(h.last_error).toBeNull();
    }
    // After connectAll, every server's connect failed → 'errored'.
    // connectAll does not throw with mixed failure unless ALL servers
    // fail; we have 2/2 failing so it WILL throw — wrap.
    await expect(pool.connectAll()).rejects.toThrow(/all downstream connections failed/);
    const afterSnap = pool.healthSnapshot();
    for (const h of afterSnap) {
      expect(h.connection_state).toBe('errored');
    }
  });

  it('distinguishes never-attempted from errored even when last_error is null', () => {
    // Construction-only path: a brand-new connection has both
    // last_error: null AND connected: false. Pre-fix these two fields
    // alone gave the consumer no way to tell "never tried" from
    // "tried, failed silently". The tri-state IS the distinguisher.
    const conn = new DownstreamConnection(brokenServer('epsilon'));
    expect(conn.lastError).toBeNull();
    expect(conn.isConnected).toBe(false);
    expect(conn.connectionState).toBe('never');
  });
});
