export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening the circuit. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait in open state before moving to half-open. Default: 30_000 */
  cooldownMs?: number;
}

export interface CircuitStatus {
  state: CircuitState;
  serverName: string;
  retryAt?: string;
}

interface CircuitEntry {
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
  private defaultOptions: Required<CircuitBreakerOptions>;

  constructor(defaults: CircuitBreakerOptions = {}) {
    this.defaultOptions = {
      failureThreshold: defaults.failureThreshold ?? 5,
      cooldownMs: defaults.cooldownMs ?? 30_000,
    };
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
        console.error(
          `[rea] circuit-breaker: "${serverName}" transitioned open → half-open (probing recovery)`,
        );
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
      console.error(`[rea] circuit-breaker: "${serverName}" recovered — circuit closed`);
    } else if (entry.state === 'closed') {
      entry.consecutiveFailures = 0;
    }
  }

  recordFailure(serverName: string): void {
    const entry = this.getOrCreate(serverName);

    if (entry.state === 'open') return;

    entry.consecutiveFailures++;

    const shouldOpen =
      entry.state === 'half-open' || entry.consecutiveFailures >= entry.failureThreshold;

    if (shouldOpen) {
      entry.state = 'open';
      entry.openedAt = Date.now();
      const retryAt = new Date(entry.openedAt + entry.cooldownMs).toISOString();
      console.error(
        `[rea] circuit-breaker: "${serverName}" OPENED after ${entry.consecutiveFailures} failure(s) — will retry at ${retryAt}`,
      );
    }
  }

  getCircuit(serverName: string): CircuitEntry | undefined {
    return this.circuits.get(serverName);
  }
}
