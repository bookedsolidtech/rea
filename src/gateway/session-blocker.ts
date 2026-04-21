/**
 * SESSION_BLOCKER tracker (BUG-004, 0.9.0).
 *
 * When a downstream MCP server fails repeatedly in a single session the
 * operator needs one LOUD signal — not a log stream full of identical
 * circuit-open records. This module owns the per-(session_id, server_name)
 * counter and emits exactly one `SESSION_BLOCKER` event once a threshold is
 * crossed; the event is replayed neither on continued failure nor on a
 * circuit-breaker flap. Recovery (downstream returns to healthy) resets the
 * counter and re-arms the emission.
 *
 * ## Why this lives separately from CircuitBreaker
 *
 * The circuit breaker tracks CONSECUTIVE CALL-LEVEL failures per server —
 * it is wire-hot and opens/closes many times across a long session. The
 * session blocker tracks OPEN-LEVEL failures per session: every
 * circuit-open transition counts as ONE. A downstream that flaps
 * open→closed→open three times in ten minutes is already a blocker from an
 * operator perspective — it should be surfaced once, not muted by the
 * breaker's own internal recoveries.
 *
 * ## Emission semantics
 *
 *   - Increment on every circuit transition to `open`.
 *   - When the counter for (session, server) crosses `threshold`, fire
 *     ONE `SESSION_BLOCKER` record (structured log + audit append). The
 *     counter keeps incrementing — subsequent opens do NOT re-fire.
 *   - On circuit recovery (transition to `closed`) the counter resets and
 *     the "already emitted" flag clears; the next threshold crossing will
 *     fire a fresh record.
 *   - On session change (new session_id) every counter is dropped — a new
 *     `rea serve` instance starts fresh.
 *
 * ## Why audit
 *
 * The hash-chained audit log is the single place an operator can look for a
 * forensic record of persistent downstream outages. A `SESSION_BLOCKER`
 * record in the audit trail pinpoints the session + downstream that went
 * dark, independent of whichever log sink the operator had configured.
 *
 * Audit appends are best-effort; a failure to write never breaks the
 * gateway. The log-side emission happens first and unconditionally.
 */

import type { Logger } from './log.js';

/**
 * Event shape observed by the tracker. Only `from` → `to` and `server` are
 * needed; the tracker does not care about retryAt/reason.
 */
export interface CircuitTransitionEvent {
  server: string;
  from: 'closed' | 'open' | 'half-open';
  to: 'closed' | 'open' | 'half-open';
}

/**
 * Structured record emitted when a session-level block threshold is
 * crossed. Exposed so tests and audit-append helpers can construct the
 * canonical shape without re-declaring the fields.
 */
export interface SessionBlockerEvent {
  event: 'SESSION_BLOCKER';
  session_id: string;
  server_name: string;
  open_transitions: number;
  threshold: number;
  /** ISO timestamp at emission. */
  emitted_at: string;
  message: string;
}

/**
 * Callback the tracker invokes when a SESSION_BLOCKER fires. The gateway
 * wires this to `appendAuditRecord` so forensic capture survives logger
 * downtime. Errors raised by the sink are swallowed — a broken audit
 * pipeline must never break state tracking.
 */
export type SessionBlockerAuditSink = (event: SessionBlockerEvent) => Promise<void> | void;

export interface SessionBlockerOptions {
  /**
   * Number of open-transitions required to fire the event. Default: 3 —
   * matches Jake's "after N consecutive same-downstream failures in one
   * session" from the bug report. Low enough to catch real outages quickly,
   * high enough that a single noisy reconnect doesn't spuriously fire.
   */
  threshold?: number;
}

interface EntryState {
  openTransitions: number;
  alreadyEmitted: boolean;
}

/**
 * Per-(session_id, server_name) SESSION_BLOCKER tracker.
 *
 * Stateful and single-instance per gateway process. The circuit breaker's
 * `onStateChange` listener plus the pool's respawn events feed it; the
 * tracker decides whether to emit.
 */
export class SessionBlockerTracker {
  private readonly threshold: number;
  private readonly logger: Logger | undefined;
  private readonly auditSink: SessionBlockerAuditSink | undefined;
  private sessionId: string;
  private readonly entries = new Map<string, EntryState>();

  constructor(
    sessionId: string,
    options: SessionBlockerOptions = {},
    logger?: Logger,
    auditSink?: SessionBlockerAuditSink,
  ) {
    this.threshold = Math.max(1, options.threshold ?? 3);
    this.logger = logger;
    this.auditSink = auditSink;
    this.sessionId = sessionId;
  }

  /**
   * Replace the tracked session id and clear all counters. Called from the
   * serve entry when a fresh session boots. In practice `session_id` is
   * assigned once per process — this is here for test determinism and
   * future multi-session transports.
   */
  resetForSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.entries.clear();
  }

  /**
   * Feed a circuit-breaker transition. Fires a SESSION_BLOCKER record when
   * the threshold is crossed for the first time. Subsequent opens increment
   * the counter but do NOT re-fire until recovery resets.
   */
  recordCircuitTransition(event: CircuitTransitionEvent): void {
    const entry = this.getOrCreate(event.server);

    if (event.to === 'closed') {
      // Recovery resets state — a future threshold crossing will fire a
      // fresh record rather than being muted by the prior one.
      entry.openTransitions = 0;
      entry.alreadyEmitted = false;
      return;
    }

    if (event.to !== 'open') return;

    entry.openTransitions += 1;

    if (!entry.alreadyEmitted && entry.openTransitions >= this.threshold) {
      entry.alreadyEmitted = true;
      this.fire(event.server, entry.openTransitions);
    }
  }

  /**
   * Feed a respawn event from the supervisor. A successful respawn is NOT
   * the same as circuit recovery — the circuit closes only after a
   * successful probe tool call, not just after reconnect. We intentionally
   * do nothing here so the respawn path does not mask a live outage.
   * Exposed as a method so the wiring site is obvious at the call graph.
   */
  recordRespawn(_server: string): void {
    // Intentional no-op. See JSDoc.
  }

  /**
   * Snapshot for observability / status — the `rea status` JSON output
   * surfaces per-server transition counts so operators can see "this one
   * has failed twice but hasn't crossed threshold yet".
   */
  snapshot(): Array<{ server: string; open_transitions: number; emitted: boolean }> {
    const out: Array<{ server: string; open_transitions: number; emitted: boolean }> = [];
    for (const [server, state] of this.entries) {
      out.push({
        server,
        open_transitions: state.openTransitions,
        emitted: state.alreadyEmitted,
      });
    }
    return out;
  }

  private getOrCreate(server: string): EntryState {
    let entry = this.entries.get(server);
    if (entry === undefined) {
      entry = { openTransitions: 0, alreadyEmitted: false };
      this.entries.set(server, entry);
    }
    return entry;
  }

  private fire(server: string, count: number): void {
    const event: SessionBlockerEvent = {
      event: 'SESSION_BLOCKER',
      session_id: this.sessionId,
      server_name: server,
      open_transitions: count,
      threshold: this.threshold,
      emitted_at: new Date().toISOString(),
      message:
        `downstream "${server}" has opened the circuit ${count} time(s) in this session ` +
        `(threshold ${this.threshold}). This is a SESSION_BLOCKER — the gateway will keep ` +
        `routing around it, but operator attention is required to restore capacity.`,
    };

    // LOUD structured log at error level. This is the primary surface for
    // live operators tailing stderr; the audit record below is the forensic
    // companion.
    this.logger?.error({
      event: 'session_blocker',
      server_name: server,
      message: event.message,
      session_id: this.sessionId,
      open_transitions: count,
      threshold: this.threshold,
    });

    if (this.auditSink === undefined) return;
    // Fire-and-forget: a slow audit sink must not block the circuit-state
    // transition path. The sink itself is contracted to swallow errors.
    void Promise.resolve()
      .then(() => this.auditSink!(event))
      .catch(() => {
        // All errors are already swallowed in the sink; this is a defensive
        // catch for an unlikely sync throw on the thenable boundary.
      });
  }
}
