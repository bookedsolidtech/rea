export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Callback invoked on every circuit state transition (G5). The constructor
 * can wire this to a structured logger and/or a metrics gauge so state
 * changes are observable without requiring the breaker itself to depend on
 * those modules.
 */
export type CircuitStateChangeListener = (event: {
  server: string;
  from: CircuitState;
  to: CircuitState;
  reason: 'failure_threshold' | 'cooldown_elapsed' | 'recovered' | 'half_open_failed';
  retryAt?: string;
}) => void;

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening the circuit. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait in open state before moving to half-open. Default: 30_000 */
  cooldownMs?: number;
  /** Optional listener for state transitions. See {@link CircuitStateChangeListener}. */
  onStateChange?: CircuitStateChangeListener;
}

export interface CircuitStatus {
  state: CircuitState;
  serverName: string;
  retryAt?: string;
}

/**
 * Internal per-server circuit state. Exported so observability consumers
 * (live-state publisher, tests) can read `openedAt` and `cooldownMs` to
 * compute a `retry_at` timestamp without duplicating the arithmetic.
 * Treat fields as read-only from outside the breaker — mutating them
 * breaks the invariants `recordSuccess` / `recordFailure` enforce.
 */
export interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  failureThreshold: number;
  cooldownMs: number;
}

/**
 * Per-server circuit breaker.
 *
 * State machine:
 *   closed    → open      after N consecutive failures
 *   open      → half-open after cooldown period
 *   half-open → closed    on next success
 *   half-open → open      on next failure
 */
export class CircuitBreaker {
  private circuits = new Map<string, CircuitEntry>();
  private defaultOptions: Required<Omit<CircuitBreakerOptions, 'onStateChange'>>;
  private readonly onStateChange: CircuitStateChangeListener | undefined;

  constructor(defaults: CircuitBreakerOptions = {}) {
    this.defaultOptions = {
      failureThreshold: defaults.failureThreshold ?? 5,
      cooldownMs: defaults.cooldownMs ?? 30_000,
    };
    this.onStateChange = defaults.onStateChange;
  }

  private notify(event: Parameters<CircuitStateChangeListener>[0]): void {
    if (this.onStateChange === undefined) return;
    try {
      this.onStateChange(event);
    } catch {
      // Listeners must never break the breaker. Swallow.
    }
  }

  private getOrCreate(serverName: string): CircuitEntry {
    let entry = this.circuits.get(serverName);
    if (!entry) {
      entry = {
        state: 'closed',
        consecutiveFailures: 0,
        openedAt: null,
        failureThreshold: this.defaultOptions.failureThreshold,
        cooldownMs: this.defaultOptions.cooldownMs,
      };
      this.circuits.set(serverName, entry);
    }
    return entry;
  }

  /**
   * Returns null if the call may proceed, or a CircuitStatus if the circuit is open.
   * Side effect: transitions open → half-open if cooldown has elapsed.
   */
  isAllowed(serverName: string): CircuitStatus | null {
    const entry = this.getOrCreate(serverName);

    if (entry.state === 'closed') return null;

    if (entry.state === 'open') {
      const elapsed = Date.now() - (entry.openedAt ?? 0);
      if (elapsed >= entry.cooldownMs) {
        entry.state = 'half-open';
        entry.consecutiveFailures = 0;
        this.notify({
          server: serverName,
          from: 'open',
          to: 'half-open',
          reason: 'cooldown_elapsed',
        });
        return null;
      }

      const retryAt = new Date((entry.openedAt ?? 0) + entry.cooldownMs).toISOString();
      return {
        state: 'open',
        serverName,
        retryAt,
      };
    }

    return null;
  }

  recordSuccess(serverName: string): void {
    const entry = this.getOrCreate(serverName);
    if (entry.state === 'half-open') {
      entry.state = 'closed';
      entry.consecutiveFailures = 0;
      entry.openedAt = null;
      this.notify({
        server: serverName,
        from: 'half-open',
        to: 'closed',
        reason: 'recovered',
      });
    } else if (entry.state === 'closed') {
      entry.consecutiveFailures = 0;
    }
  }

  recordFailure(serverName: string): void {
    const entry = this.getOrCreate(serverName);

    if (entry.state === 'open') return;

    const previous = entry.state;
    entry.consecutiveFailures++;

    const shouldOpen =
      entry.state === 'half-open' || entry.consecutiveFailures >= entry.failureThreshold;

    if (shouldOpen) {
      entry.state = 'open';
      entry.openedAt = Date.now();
      const retryAt = new Date(entry.openedAt + entry.cooldownMs).toISOString();
      this.notify({
        server: serverName,
        from: previous,
        to: 'open',
        reason: previous === 'half-open' ? 'half_open_failed' : 'failure_threshold',
        retryAt,
      });
    }
  }

  getCircuit(serverName: string): CircuitEntry | undefined {
    return this.circuits.get(serverName);
  }
}
