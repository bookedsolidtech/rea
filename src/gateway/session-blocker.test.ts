/**
 * Unit tests for SessionBlockerTracker (BUG-004, 0.9.0).
 *
 * Concerns covered:
 *   - Threshold crossing fires exactly one SESSION_BLOCKER event per
 *     (session_id, server_name) arming window.
 *   - Recovery (circuit → closed) resets the counter AND re-arms the emit.
 *   - A session-id change drops every counter (fresh process contract).
 *   - Audit sink failures never break the tracker (fire-and-forget).
 *   - Sub-threshold open transitions do NOT fire the event.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionBlockerTracker, type SessionBlockerEvent } from './session-blocker.js';

function noopLogger(): {
  calls: Array<{ level: string; fields: Record<string, unknown> }>;
  // Matches the Logger interface surface the tracker uses.
  debug: (f: Record<string, unknown>) => void;
  info: (f: Record<string, unknown>) => void;
  warn: (f: Record<string, unknown>) => void;
  error: (f: Record<string, unknown>) => void;
  child: () => never;
} {
  const calls: Array<{ level: string; fields: Record<string, unknown> }> = [];
  return {
    calls,
    debug: (fields) => calls.push({ level: 'debug', fields }),
    info: (fields) => calls.push({ level: 'info', fields }),
    warn: (fields) => calls.push({ level: 'warn', fields }),
    error: (fields) => calls.push({ level: 'error', fields }),
    child: () => {
      throw new Error('not used in these tests');
    },
  };
}

describe('SessionBlockerTracker', () => {
  it('fires exactly one SESSION_BLOCKER when threshold is crossed', async () => {
    const log = noopLogger();
    const fired: SessionBlockerEvent[] = [];
    const sink = (e: SessionBlockerEvent): void => {
      fired.push(e);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracker = new SessionBlockerTracker('S1', { threshold: 3 }, log as any, sink);

    // Three consecutive opens → one fire.
    for (let i = 0; i < 3; i++) {
      tracker.recordCircuitTransition({ server: 'helixir', from: 'closed', to: 'open' });
    }

    // Fire-and-forget: let the microtask flush before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(fired).toHaveLength(1);
    expect(fired[0]?.server_name).toBe('helixir');
    expect(fired[0]?.open_transitions).toBe(3);
    expect(fired[0]?.threshold).toBe(3);
    expect(fired[0]?.session_id).toBe('S1');

    // A fourth open must NOT re-fire.
    tracker.recordCircuitTransition({ server: 'helixir', from: 'half-open', to: 'open' });
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toHaveLength(1);

    // The LOUD error log fires on the same threshold crossing.
    const errorLogs = log.calls.filter((c) => c.level === 'error');
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.fields.event).toBe('session_blocker');
  });

  it('sub-threshold opens do not fire', async () => {
    const fired: SessionBlockerEvent[] = [];
    const tracker = new SessionBlockerTracker('S1', { threshold: 3 }, undefined, (e) => {
      fired.push(e);
    });

    tracker.recordCircuitTransition({ server: 'helixir', from: 'closed', to: 'open' });
    tracker.recordCircuitTransition({ server: 'helixir', from: 'half-open', to: 'open' });

    await Promise.resolve();
    expect(fired).toHaveLength(0);
  });

  it('recovery to closed resets the counter AND re-arms the emit', async () => {
    const fired: SessionBlockerEvent[] = [];
    const tracker = new SessionBlockerTracker('S1', { threshold: 2 }, undefined, (e) => {
      fired.push(e);
    });

    // First outage: 2 opens → fire.
    tracker.recordCircuitTransition({ server: 'helixir', from: 'closed', to: 'open' });
    tracker.recordCircuitTransition({ server: 'helixir', from: 'half-open', to: 'open' });
    await Promise.resolve();
    expect(fired).toHaveLength(1);

    // Recovery.
    tracker.recordCircuitTransition({ server: 'helixir', from: 'half-open', to: 'closed' });

    // Second outage: 2 opens again → fires AGAIN (re-armed).
    tracker.recordCircuitTransition({ server: 'helixir', from: 'closed', to: 'open' });
    tracker.recordCircuitTransition({ server: 'helixir', from: 'half-open', to: 'open' });
    await Promise.resolve();
    expect(fired).toHaveLength(2);
    // Counter started over at 1+1, not accumulated.
    expect(fired[1]?.open_transitions).toBe(2);
  });

  it('session change drops all counters', () => {
    const tracker = new SessionBlockerTracker('S1', { threshold: 3 });
    tracker.recordCircuitTransition({ server: 'helixir', from: 'closed', to: 'open' });
    tracker.recordCircuitTransition({ server: 'helixir', from: 'half-open', to: 'open' });

    const before = tracker.snapshot();
    expect(before[0]?.open_transitions).toBe(2);

    tracker.resetForSession('S2');
    const after = tracker.snapshot();
    expect(after).toHaveLength(0);
  });

  it('tracks per-server state independently', async () => {
    const fired: SessionBlockerEvent[] = [];
    const tracker = new SessionBlockerTracker('S1', { threshold: 2 }, undefined, (e) => {
      fired.push(e);
    });

    // helixir: 2 opens → fire.
    tracker.recordCircuitTransition({ server: 'helixir', from: 'closed', to: 'open' });
    tracker.recordCircuitTransition({ server: 'helixir', from: 'half-open', to: 'open' });
    // obsidian: 1 open → no fire.
    tracker.recordCircuitTransition({ server: 'obsidian', from: 'closed', to: 'open' });

    await Promise.resolve();
    expect(fired).toHaveLength(1);
    expect(fired[0]?.server_name).toBe('helixir');

    const snap = tracker.snapshot();
    const helixir = snap.find((s) => s.server === 'helixir');
    const obsidian = snap.find((s) => s.server === 'obsidian');
    expect(helixir?.open_transitions).toBe(2);
    expect(helixir?.emitted).toBe(true);
    expect(obsidian?.open_transitions).toBe(1);
    expect(obsidian?.emitted).toBe(false);
  });

  it('swallows audit sink errors without breaking state tracking', async () => {
    const sink = vi.fn().mockRejectedValue(new Error('audit pipe dead'));
    const tracker = new SessionBlockerTracker('S1', { threshold: 1 }, undefined, sink);

    // Cross threshold — the sink will reject asynchronously.
    tracker.recordCircuitTransition({ server: 'helixir', from: 'closed', to: 'open' });

    // Let the fire-and-forget rejection settle.
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));

    // Tracker state is still consistent — further calls do not throw.
    expect(() =>
      tracker.recordCircuitTransition({ server: 'helixir', from: 'half-open', to: 'open' }),
    ).not.toThrow();

    // Second open does NOT re-invoke sink (arming still held).
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('respawn is a no-op (does not mute live blockers)', async () => {
    const fired: SessionBlockerEvent[] = [];
    const tracker = new SessionBlockerTracker('S1', { threshold: 2 }, undefined, (e) => {
      fired.push(e);
    });

    tracker.recordCircuitTransition({ server: 'helixir', from: 'closed', to: 'open' });
    tracker.recordRespawn('helixir'); // Deliberately does NOT reset.
    tracker.recordCircuitTransition({ server: 'helixir', from: 'half-open', to: 'open' });
    await Promise.resolve();
    expect(fired).toHaveLength(1);
  });
});
