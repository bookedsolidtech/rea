import type { GatewayConfig } from '../config/types.js';

export interface LimitExceededError {
  type: 'concurrency' | 'rate';
  serverName: string;
  current: number;
  limit: number;
  message: string;
}

interface ServerState {
  activeCalls: number;
  callTimestamps: number[];
  maxConcurrent: number;
  callsPerMinute: number;
}

const WINDOW_MS = 60_000;

/**
 * In-memory per-server rate limiter and concurrency cap.
 *
 * Concurrency: tracks active in-flight calls. If at the limit, new calls
 * are rejected immediately with a structured error.
 *
 * Rate: sliding window — calls in the last 60 seconds must not exceed the
 * configured calls_per_minute. 0 means unlimited for either dimension.
 */
export class RateLimiter {
  private state = new Map<string, ServerState>();

  constructor(gatewayConfig?: GatewayConfig) {
    if (!gatewayConfig) return;
    for (const [name, serverCfg] of Object.entries(gatewayConfig.servers)) {
      this.state.set(name, {
        activeCalls: 0,
        callTimestamps: [],
        maxConcurrent: serverCfg.max_concurrent_calls ?? 0,
        callsPerMinute: serverCfg.calls_per_minute ?? 0,
      });
    }
  }

  /**
   * Try to acquire a slot for a call to `serverName`.
   * Returns null on success, or a LimitExceededError if rejected.
   */
  tryAcquire(serverName: string): LimitExceededError | null {
    let s = this.state.get(serverName);
    if (!s) {
      s = {
        activeCalls: 0,
        callTimestamps: [],
        maxConcurrent: 0,
        callsPerMinute: 0,
      };
      this.state.set(serverName, s);
    }

    const now = Date.now();
    s.callTimestamps = s.callTimestamps.filter((t) => now - t < WINDOW_MS);

    if (s.callsPerMinute > 0 && s.callTimestamps.length >= s.callsPerMinute) {
      return {
        type: 'rate',
        serverName,
        current: s.callTimestamps.length,
        limit: s.callsPerMinute,
        message: `Rate limit exceeded for server "${serverName}": ${s.callTimestamps.length}/${s.callsPerMinute} calls in the last 60s`,
      };
    }

    if (s.maxConcurrent > 0 && s.activeCalls >= s.maxConcurrent) {
      return {
        type: 'concurrency',
        serverName,
        current: s.activeCalls,
        limit: s.maxConcurrent,
        message: `Concurrency limit exceeded for server "${serverName}": ${s.activeCalls}/${s.maxConcurrent} active calls`,
      };
    }

    s.activeCalls++;
    s.callTimestamps.push(now);
    return null;
  }

  /** Release a previously acquired concurrency slot. No-op for unknown servers. */
  release(serverName: string): void {
    const s = this.state.get(serverName);
    if (!s) return;
    if (s.activeCalls > 0) s.activeCalls--;
  }

  getState(serverName: string): ServerState | undefined {
    return this.state.get(serverName);
  }
}
