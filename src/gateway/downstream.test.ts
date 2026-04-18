/**
 * Unit tests for DownstreamConnection.
 *
 * Two concerns:
 *  1. Environment inheritance policy — the child must NOT silently inherit
 *     the operator's full process.env. Only the allowlist + explicit opt-ins
 *     may flow through.
 *  2. Reconnect semantics — one reconnect per failure EPISODE (not per object
 *     lifetime), with a flap-window guard against rapid reconnect loops.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { RegistryServer } from '../registry/types.js';
import { buildChildEnv, DownstreamConnection } from './downstream.js';

function baseServer(overrides: Partial<RegistryServer> = {}): RegistryServer {
  return {
    name: 'mock',
    command: 'node',
    args: [],
    env: {},
    enabled: true,
    ...overrides,
  };
}

describe('buildChildEnv', () => {
  it('forwards allowlisted OS/runtime vars by default', () => {
    const hostEnv = {
      PATH: '/usr/bin',
      HOME: '/home/tester',
      TZ: 'UTC',
      OPENAI_API_KEY: 'sk-leak-me',
      GITHUB_TOKEN: 'ghp-leak-me',
      ANTHROPIC_API_KEY: 'sk-ant-leak-me',
    };

    const out = buildChildEnv(baseServer(), hostEnv);

    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/tester');
    expect(out.TZ).toBe('UTC');
    // Secrets MUST NOT be in the child env by default.
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('skips allowlisted vars that are absent on the host (no "undefined" strings)', () => {
    const hostEnv = { PATH: '/usr/bin' };

    const out = buildChildEnv(baseServer(), hostEnv);

    // Absent values must be skipped, not serialized as the string "undefined".
    expect(out.HOME).toBeUndefined();
    expect('HOME' in out).toBe(false);
    expect(out.TZ).toBeUndefined();
    expect('TZ' in out).toBe(false);
    // And nothing leaks in as the literal string "undefined".
    for (const v of Object.values(out)) {
      expect(v).not.toBe('undefined');
    }
  });

  it('env_passthrough forwards opt-in names from the host environment', () => {
    const hostEnv = { PATH: '/usr/bin', MY_DEBUG: '1', UNRELATED: 'nope' };

    const out = buildChildEnv(
      baseServer({ env_passthrough: ['MY_DEBUG'] }),
      hostEnv,
    );

    expect(out.MY_DEBUG).toBe('1');
    expect(out.UNRELATED).toBeUndefined();
  });

  it('explicit env: wins over both allowlist and passthrough', () => {
    const hostEnv = { PATH: '/host/bin', MY_DEBUG: 'host-value' };

    const out = buildChildEnv(
      baseServer({
        env_passthrough: ['MY_DEBUG'],
        env: { PATH: '/override/bin', MY_DEBUG: 'explicit-value' },
      }),
      hostEnv,
    );

    expect(out.PATH).toBe('/override/bin');
    expect(out.MY_DEBUG).toBe('explicit-value');
  });

  it('explicit env: can set a secret-looking name (operator made the decision)', () => {
    // The schema refuses secret-name heuristic in env_passthrough, but explicit
    // env: is the escape hatch — test here that buildChildEnv doesn't re-refuse.
    const out = buildChildEnv(
      baseServer({ env: { GITHUB_TOKEN: 'operator-typed-this' } }),
      {},
    );
    expect(out.GITHUB_TOKEN).toBe('operator-typed-this');
  });
});

// -----------------------------------------------------------------------------
// Reconnect semantics — we stub the SDK Client by swapping the private `client`
// field after `connect()` so we don't need a real child process.
// -----------------------------------------------------------------------------

type StubCallTool = (args: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;

function makeStubClient(callTool: StubCallTool): { callTool: StubCallTool; close: () => Promise<void> } {
  return {
    callTool,
    close: async () => {
      // no-op
    },
  };
}

/**
 * Build a DownstreamConnection whose `connect()` installs a caller-supplied
 * stub instead of spawning a real child. Each call to `connect()` pops the
 * next stub from the queue so successive reconnects can return fresh state.
 */
function makeConnection(stubs: Array<ReturnType<typeof makeStubClient>>): DownstreamConnection {
  const conn = new DownstreamConnection(baseServer());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (conn as any).connect = async function patchedConnect(this: DownstreamConnection) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((this as any).client !== null) return;
    const next = stubs.shift();
    if (!next) throw new Error('test bug: no more stubs queued');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).client = next;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).health = 'healthy';
  };
  return conn;
}

describe('DownstreamConnection reconnect semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects once on failure, then recovers for future unrelated failures', async () => {
    // Episode 1: call fails, reconnect, retry succeeds.
    // Episode 2 (much later): call fails, reconnect again, retry succeeds.
    const firstClient = makeStubClient(() => Promise.reject(new Error('transport closed')));
    const secondClient = makeStubClient(() => Promise.resolve({ ok: 'after-reconnect-1' }));
    const thirdClient = makeStubClient(() => Promise.reject(new Error('transport closed again')));
    const fourthClient = makeStubClient(() => Promise.resolve({ ok: 'after-reconnect-2' }));

    const conn = makeConnection([firstClient, secondClient, thirdClient, fourthClient]);

    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));

    // First call: initial connect pops firstClient, call fails, reconnect pops
    // secondClient, retry on secondClient succeeds.
    const r1 = await conn.callTool('ping', {});
    expect(r1).toEqual({ ok: 'after-reconnect-1' });

    // Advance past the flap window.
    vi.setSystemTime(new Date('2026-04-18T00:01:00Z'));

    // On the second call, secondClient is still "current" but its behaviour is
    // fine — so swap it for a failing one by closing + queuing up a new pair.
    // Simplest: close, which clears this.client; next callTool will connect()
    // and pop thirdClient (failing), then reconnect pops fourthClient.
    await conn.close();
    const r2 = await conn.callTool('ping', {});
    expect(r2).toEqual({ ok: 'after-reconnect-2' });
  });

  it('refuses a second reconnect within the flap window', async () => {
    const firstClient = makeStubClient(() => Promise.reject(new Error('transport closed #1')));
    const secondClient = makeStubClient(() => Promise.resolve({ ok: 'reconnect-1-retry' }));
    // Future connects should not be consumed — but queue one just in case so
    // we get a clear test-bug message instead of a silent hang if they are.
    const unexpectedClient = makeStubClient(() => Promise.resolve({ ok: 'SHOULD-NOT-BE-USED' }));

    const conn = makeConnection([firstClient, secondClient, unexpectedClient]);

    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));

    // Episode 1: fail + reconnect + success.
    const r1 = await conn.callTool('ping', {});
    expect(r1).toEqual({ ok: 'reconnect-1-retry' });
    expect(conn.isHealthy).toBe(true);

    // Advance 5 seconds — well within the 30s flap window.
    vi.setSystemTime(new Date('2026-04-18T00:00:05Z'));

    // Replace secondClient's behaviour: swap in a failing stub for the current
    // client so the next call hits a transport error. We do this by rewiring
    // the private field directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = makeStubClient(() =>
      Promise.reject(new Error('transport closed #2 — within flap window')),
    );

    await expect(conn.callTool('ping', {})).rejects.toThrow(/call failed/);
    expect(conn.isHealthy).toBe(false);
  });
});
