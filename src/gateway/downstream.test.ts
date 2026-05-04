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

    const { env: out, missing } = buildChildEnv(baseServer(), hostEnv);

    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/tester');
    expect(out.TZ).toBe('UTC');
    // Secrets MUST NOT be in the child env by default.
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(missing).toEqual([]);
  });

  it('skips allowlisted vars that are absent on the host (no "undefined" strings)', () => {
    const hostEnv = { PATH: '/usr/bin' };

    const { env: out } = buildChildEnv(baseServer(), hostEnv);

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

    const { env: out } = buildChildEnv(baseServer({ env_passthrough: ['MY_DEBUG'] }), hostEnv);

    expect(out.MY_DEBUG).toBe('1');
    expect(out.UNRELATED).toBeUndefined();
  });

  it('explicit env: wins over both allowlist and passthrough', () => {
    const hostEnv = { PATH: '/host/bin', MY_DEBUG: 'host-value' };

    const { env: out } = buildChildEnv(
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
    const { env: out, secretKeys } = buildChildEnv(
      baseServer({ env: { GITHUB_TOKEN: 'operator-typed-this' } }),
      {},
    );
    expect(out.GITHUB_TOKEN).toBe('operator-typed-this');
    // Literal values still get flagged on the secretKeys axis because the KEY
    // name matches the secret-name heuristic — downstream logging gates on it.
    expect(secretKeys).toEqual(['GITHUB_TOKEN']);
  });

  it('interpolates ${VAR} placeholders from the host environment', () => {
    const hostEnv = { PATH: '/usr/bin', DISCORD_BOT_TOKEN: 'abc123' };

    const {
      env: out,
      missing,
      secretKeys,
    } = buildChildEnv(baseServer({ env: { BOT_TOKEN: '${DISCORD_BOT_TOKEN}' } }), hostEnv);

    expect(out.BOT_TOKEN).toBe('abc123');
    expect(missing).toEqual([]);
    expect(secretKeys).toEqual(['BOT_TOKEN']);
  });

  it('reports missing vars via `missing`; resolved value keeps placeholder as canary', () => {
    const { env: out, missing } = buildChildEnv(
      baseServer({ env: { BOT_TOKEN: '${DISCORD_BOT_TOKEN}' } }),
      { PATH: '/usr/bin' },
    );

    expect(missing).toEqual(['DISCORD_BOT_TOKEN']);
    // Unresolved placeholder is preserved so an operator who inspects the
    // object sees the raw template. The DownstreamConnection refuses to
    // spawn when missing.length > 0, so this string never reaches the child.
    expect(out.BOT_TOKEN).toBe('${DISCORD_BOT_TOKEN}');
  });

  it('mixes literal + interpolated env entries', () => {
    const hostEnv = { PATH: '/usr/bin', X: 'resolved' };

    const { env: out, missing } = buildChildEnv(
      baseServer({ env: { LOG_LEVEL: 'info', TOKEN: '${X}' } }),
      hostEnv,
    );

    expect(out.LOG_LEVEL).toBe('info');
    expect(out.TOKEN).toBe('resolved');
    expect(missing).toEqual([]);
  });
});

describe('DownstreamConnection startup env refusal', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses to start when a ${VAR} reference is unset', async () => {
    // Isolate process.env so the test is deterministic.
    process.env = { PATH: '/usr/bin' };
    const conn = new DownstreamConnection({
      name: 'needs-token',
      command: 'node',
      args: [],
      env: { BOT_TOKEN: '${MISSING_TOKEN_FOR_TEST}' },
      enabled: true,
    });
    await expect(conn.connect()).rejects.toThrow(
      /refused to start — missing env: MISSING_TOKEN_FOR_TEST/,
    );
    expect(conn.isHealthy).toBe(false);
  });

  it('throws with server context on malformed ${ syntax', async () => {
    const conn = new DownstreamConnection({
      name: 'bad-template',
      command: 'node',
      args: [],
      env: { X: '${unterminated' },
      enabled: true,
    });
    await expect(conn.connect()).rejects.toThrow(
      /failed to resolve env for downstream "bad-template"/,
    );
    expect(conn.isHealthy).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Reconnect semantics — we stub the SDK Client by swapping the private `client`
// field after `connect()` so we don't need a real child process.
// -----------------------------------------------------------------------------

type StubCallTool = (args: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<unknown>;

function makeStubClient(callTool: StubCallTool): {
  callTool: StubCallTool;
  close: () => Promise<void>;
} {
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

  it('clears lastError after reconnect-success (Codex F2)', async () => {
    // Regression for Codex F2: a successful callTool must clear any lingering
    // lastError. Without this, a connection that failed once and recovered
    // on reconnect would forever report the old error via `__rea__health`,
    // misleading operators about live state.
    //
    // Natural failure path: first callTool on `s1` rejects → catch branch
    // stamps `#lastErrorMessage`, then reconnect pops `s2` which succeeds —
    // the reconnect-success branch (downstream.ts line ~355) clears the
    // field. We assert via the public getter that clear happened.
    const s1 = makeStubClient(() => Promise.reject(new Error('transient blip')));
    const s2 = makeStubClient(() => Promise.resolve({ ok: 'pong' }));
    // `s2` is the ONLY queued stub — `s1` is primed directly so the initial
    // callTool path hits it, and after close() the reconnect pops s2.
    const conn = makeConnection([s2]);

    // Prime the connection to `s1` (client != null, skip initial connect()).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = s1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).health = 'healthy';

    const result = await conn.callTool('ping', {});
    expect(result).toEqual({ ok: 'pong' });
    // Reconnect succeeded → lastError cleared.
    expect(conn.lastError).toBeNull();
  });

  it('BUG-014: bound is applied at assignment (no-reconnect flap-window path)', async () => {
    // 0.6.2 bound-at-read: every write site stored raw strings, `get
    // lastError` truncated on the way out. 0.7.0 moves the bound into the
    // `set #lastErrorMessage` setter — every write produces a bounded
    // stored value regardless of how many assignment sites exist.
    //
    // Natural write path (no test seam): use the flap-window branch, which
    // goes `this.#lastErrorMessage = message; throw`. First callTool
    // succeeds via reconnect (stamps `lastReconnectAt`), then a second
    // callTool within the flap window hits the `else` branch at
    // downstream.ts line ~379 and writes a HUGE string to the field.
    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));

    const s1 = makeStubClient(() => Promise.reject(new Error('first fail')));
    const s2 = makeStubClient(() => Promise.resolve({ ok: 'ok' }));
    // `s2` is the ONLY queued stub — `s1` is primed so callTool hits it
    // first, then reconnect pops s2 and the retry succeeds.
    const conn = makeConnection([s2]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = s1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).health = 'healthy';

    // Episode 1: fail + reconnect + success — stamps lastReconnectAt.
    await conn.callTool('ping', {});

    // Within flap window: swap in a failing client with a HUGE error.
    vi.setSystemTime(new Date('2026-04-18T00:00:05Z'));
    const HUGE = 'x'.repeat(10_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = makeStubClient(() => Promise.reject(new Error(HUGE)));

    await expect(conn.callTool('ping', {})).rejects.toThrow(/call failed/);

    // BUG-014 structural property: the stored string is bounded at write.
    // The getter applies a second bound as defense-in-depth, but the
    // invariant under test is that the underlying write was already capped.
    const recorded = conn.lastError!;
    expect(recorded.length).toBeLessThanOrEqual(4096);
    // Reading twice must be idempotent — if the backing store were raw, the
    // getter would return a bounded prefix; since the backing store IS
    // bounded, the getter returns the stored value unchanged.
    expect(conn.lastError).toBe(recorded);
  });

  it('BUG-014: ES-private backing field is not reachable via `as any` property access', () => {
    const conn = makeConnection([]);

    // Fresh connection — no writes have occurred. Property lookups on the
    // instance do NOT hit `#lastErrorBacking` because `#`-prefixed names are
    // not string-indexable properties.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asAny = conn as any;
    expect(asAny.lastErrorMessage).toBeUndefined(); // pre-0.7.0 TS-private name: gone
    expect(asAny.lastErrorBacking).toBeUndefined(); // backing, no # prefix: not a property
    expect(asAny['#lastErrorBacking']).toBeUndefined(); // literal # prefix: not a property
    expect(Object.keys(conn)).not.toContain('#lastErrorBacking');
    expect(Object.keys(conn)).not.toContain('lastErrorMessage');

    // A consumer attempting to forge lastError via `as any` assignment
    // succeeds in creating a public property but does NOT reach the ES-
    // private field — the public getter is unaffected by the forged value.
    asAny.lastErrorMessage = 'forged';
    asAny.lastErrorBacking = 'also forged';
    expect(conn.lastError).toBeNull();
  });

  it('BUG-003: "Not connected" error nulls the client and takes the respawn branch', async () => {
    // Before 0.9.0, a `Not connected` error went through the ordinary
    // reconnect path which called `close() + connect()` — fine, but relied
    // on `close()` to tear down a client that was already dead. The 0.9.0
    // change is defensive: we null the client eagerly on this specific
    // marker so the reconnect unambiguously spawns a new child.
    const s1 = makeStubClient(() => Promise.reject(new Error('Not connected')));
    const s2 = makeStubClient(() => Promise.resolve({ ok: 'respawned' }));
    const conn = makeConnection([s2]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = s1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).health = 'healthy';

    const result = await conn.callTool('ping', {});
    expect(result).toEqual({ ok: 'respawned' });
    // lastError cleared on reconnect success.
    expect(conn.lastError).toBeNull();
  });

  it('BUG-003 / Codex pass-3 P2: "Not connected" still closes the stale client (no transport leak)', async () => {
    // Regression for Codex 0.9.0 pass-3 P2: an earlier fix nulled
    // `this.client` + `this.activeTransport` BEFORE the reconnect branch's
    // `await this.close()`, so close() saw `c === null` and returned
    // without tearing down the transport — the stale child leaked until
    // gateway shutdown. The current code calls `close()` inline on the
    // NOT_CONNECTED branch so the tear-down actually happens.
    let s1Closed = false;
    const s1 = {
      callTool: () => Promise.reject(new Error('Not connected')),
      close: async (): Promise<void> => {
        s1Closed = true;
      },
    };
    const s2 = makeStubClient(() => Promise.resolve({ ok: 'respawned' }));
    const conn = makeConnection([s2]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = s1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).activeTransport = { id: 's1-transport' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).health = 'healthy';

    const result = await conn.callTool('ping', {});
    expect(result).toEqual({ ok: 'respawned' });
    // The stale client was actually closed — no transport leak.
    expect(s1Closed).toBe(true);
  });

  it('BUG-002: supervisor event fires on unexpected transport close', () => {
    // Unit-level: exercise handleUnexpectedClose via the supervisor event
    // plumbing to confirm the contract (null client, unhealthy, emit) rather
    // than relying on a real child-process crash in the unit suite.
    const conn = new DownstreamConnection(baseServer());
    // Install a synthetic transport + client pair so handleUnexpectedClose
    // can see an "active" connection to tear down.
    const fakeTransport = { marker: 'fake' } as unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = makeStubClient(() => Promise.resolve(null));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).activeTransport = fakeTransport;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).health = 'healthy';

    const events: Array<{ kind: string; server: string }> = [];
    conn.onSupervisorEvent((e) => {
      events.push({ kind: e.kind, server: e.server });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).handleUnexpectedClose(fakeTransport, 'test-reason');

    expect(conn.isConnected).toBe(false);
    expect(conn.isHealthy).toBe(false);
    expect(conn.lastError).toMatch(/child process exited unexpectedly: test-reason/);
    expect(events).toEqual([{ kind: 'child_died_unexpectedly', server: 'mock' }]);
  });

  it('BUG-002: intentional close() does NOT fire a death event', async () => {
    const conn = new DownstreamConnection(baseServer());
    const fakeTransport = { marker: 'fake' } as unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = makeStubClient(() => Promise.resolve(null));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).activeTransport = fakeTransport;

    const events: Array<{ kind: string }> = [];
    conn.onSupervisorEvent((e) => {
      events.push({ kind: e.kind });
    });

    // close() must clear activeTransport BEFORE the client's close resolves so
    // a transport.onclose firing during tear-down is recognized as ours.
    await conn.close();

    // Fire a synthetic onclose after close() completed — it must be ignored
    // because activeTransport is already null.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).handleUnexpectedClose(fakeTransport, 'late-callback');

    expect(events).toEqual([]);
  });

  it('BUG-002: stale transport onclose from prior episode is ignored', () => {
    const conn = new DownstreamConnection(baseServer());
    const priorTransport = { id: 'prior' } as unknown;
    const currentTransport = { id: 'current' } as unknown;

    // Simulate: priorTransport was active, then we reconnected and swapped
    // to currentTransport. A late onclose from priorTransport must NOT
    // invalidate currentTransport's client.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = makeStubClient(() => Promise.resolve(null));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).activeTransport = currentTransport;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).health = 'healthy';

    const events: Array<unknown> = [];
    conn.onSupervisorEvent((e) => events.push(e));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).handleUnexpectedClose(priorTransport, 'stale');

    expect(conn.isConnected).toBe(true);
    expect(conn.isHealthy).toBe(true);
    expect(events).toEqual([]);
  });

  it('BUG-004 / Codex P2a: health_changed fires on terminal call failure (no breaker transition)', async () => {
    // Below-threshold failures never reach the breaker's onStateChange, so
    // without a health_changed event the live-state publisher would never
    // flush — `rea status` would show stale healthy=true + last_error=null
    // while the connection was actually in an unhealthy state.
    const s1 = makeStubClient(() => Promise.reject(new Error('transient blip')));
    const s2 = makeStubClient(() => Promise.reject(new Error('reconnect failure — within flap')));
    const conn = makeConnection([s2]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = s1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).health = 'healthy';

    const events: Array<{ kind: string; server: string }> = [];
    conn.onSupervisorEvent((e) => events.push({ kind: e.kind, server: e.server }));

    // Episode 1: first attempt fails → reconnect attempts, also fails → terminal.
    await expect(conn.callTool('ping', {})).rejects.toThrow(/unhealthy after one reconnect/);

    // The reconnect-failure path must emit health_changed so the publisher
    // sees the unhealthy state even before any breaker transition.
    const healthChanges = events.filter((e) => e.kind === 'health_changed');
    expect(healthChanges.length).toBeGreaterThanOrEqual(1);
    expect(healthChanges.every((e) => e.server === 'mock')).toBe(true);
    expect(conn.isHealthy).toBe(false);
  });

  it('BUG-004 / Codex P2a: health_changed on success clears stale lastError', async () => {
    // Recovery path: a previous failure stamped lastError; the next
    // successful call must both clear it AND emit health_changed so the
    // publisher flushes the recovery to disk. Without the event, a user
    // reading `rea status` would see a stale `last_error` for an already-
    // healthy server.
    const s2 = makeStubClient(() => Promise.resolve({ ok: 'recovered' }));
    const conn = makeConnection([]); // no stubs — we won't trigger reconnect
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = s2;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).health = 'healthy';
    // Seed a stale lastError via the natural write path: route a terminal
    // call failure through callTool — the reconnect-attempted + flap-window
    // branch takes the else-terminal branch that writes lastError.
    const badClient = makeStubClient(() => Promise.reject(new Error('seed stale')));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = badClient;
    // Hit a terminal failure without reconnect: set reconnectAttempted true
    // and within flap window so we take the "else" terminal branch that
    // writes lastError and emits health_changed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).reconnectAttempted = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).lastReconnectAt = Date.now();
    await expect(conn.callTool('ping', {})).rejects.toThrow(/call failed/);
    expect(conn.lastError).not.toBeNull();

    // Swap in the recovering client and subscribe AFTER the seed phase so we
    // only observe the recovery emission.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = s2;
    const events: string[] = [];
    conn.onSupervisorEvent((e) => events.push(e.kind));

    const result = await conn.callTool('ping', {});
    expect(result).toEqual({ ok: 'recovered' });
    expect(conn.lastError).toBeNull();
    expect(events).toContain('health_changed');
  });

  it('BUG-004 / Codex P2a: repeated success does NOT spam health_changed', async () => {
    // Once lastError is null, successive successful callTools must not
    // emit health_changed — emitting per-call would burn the debounced
    // write budget for no state change.
    const client = makeStubClient(() => Promise.resolve({ ok: 1 }));
    const conn = makeConnection([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).client = client;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).health = 'healthy';

    const events: string[] = [];
    conn.onSupervisorEvent((e) => events.push(e.kind));

    await conn.callTool('ping', {});
    await conn.callTool('ping', {});
    await conn.callTool('ping', {});

    expect(events).toEqual([]); // no emission on steady-state success
  });

  it('Codex pass-5 P2b: refuses a respawn when the child died within the flap window', async () => {
    // The `client === null` branch at the top of callTool used to respawn
    // unconditionally. If a downstream crashes immediately after each spawn,
    // every incoming call would respawn the zombie without consulting the
    // flap window, reintroducing the reconnect loop the class is supposed
    // to suppress. Pass-5 adds an `unexpectedDeathAt` stamp set by
    // `handleUnexpectedClose` and consulted here.
    //
    // Natural drive: call succeeds, then simulate an unexpected close (via
    // the private method — the alternative is to wire a real transport
    // which unit tests deliberately avoid). A callTool within the flap
    // window must be refused without popping a new stub.
    const s1 = makeStubClient(() => Promise.resolve({ ok: 'first' }));
    const surpriseStub = makeStubClient(() => Promise.resolve({ ok: 'SHOULD-NOT-RESPAWN' }));
    const conn = makeConnection([s1, surpriseStub]);

    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));
    const r1 = await conn.callTool('ping', {});
    expect(r1).toEqual({ ok: 'first' });

    // Simulate the SDK reporting an unexpected child death. We invoke the
    // private handler directly; the real transport-layer wiring is what
    // production uses, but the handler is the single chokepoint we care
    // about for this test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeTransport = {} as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).activeTransport = fakeTransport;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).handleUnexpectedClose(fakeTransport, 'simulated SIGKILL');

    // Only 1 ms has passed — well within the 30 s flap window. The next
    // call MUST refuse to respawn.
    vi.setSystemTime(new Date('2026-04-18T00:00:00.001Z'));
    await expect(conn.callTool('ping', {})).rejects.toThrow(/flap window|refusing to respawn/i);
    expect(conn.isHealthy).toBe(false);
  });

  it('Codex pass-5 P2b: accepts respawn once the flap window has elapsed after a death', async () => {
    // Complement to the previous test: outside the flap window, a death is
    // no longer "rapid" — the next call should respawn normally.
    const s1 = makeStubClient(() => Promise.resolve({ ok: 'first' }));
    const s2 = makeStubClient(() => Promise.resolve({ ok: 'respawned-after-window' }));
    const conn = makeConnection([s1, s2]);

    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));
    await conn.callTool('ping', {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeTransport = {} as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).activeTransport = fakeTransport;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).handleUnexpectedClose(fakeTransport, 'simulated SIGKILL');

    // Advance 60 s — well beyond the 30 s flap window.
    vi.setSystemTime(new Date('2026-04-18T00:01:00Z'));
    const r = await conn.callTool('ping', {});
    expect(r).toEqual({ ok: 'respawned-after-window' });
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
