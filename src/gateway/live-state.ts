/**
 * Live `serve.state.json` publisher (BUG-005, 0.9.0).
 *
 * Before 0.9.0 `.rea/serve.state.json` was written once at `rea serve` boot
 * and never touched again. `rea status` therefore only surfaced
 * `session_id`, `started_at`, and `metrics_port` — agents planning a
 * multi-downstream workflow had no way to see "is helixir's circuit open
 * right now?" without calling `__rea__health` through the MCP transport
 * (which, ironically, wouldn't work if the gateway was the thing that had
 * wedged).
 *
 * The publisher subscribes to two signals:
 *
 *   1. Circuit-breaker `onStateChange` — transitions to/from open/half-open
 *      update the per-downstream block.
 *   2. Supervisor events from the pool — `child_died_unexpectedly` and
 *      `respawned` update per-downstream liveness.
 *
 * Each update debounces to at most one write per ~250 ms via a trailing
 * timer so a storm of transitions (e.g. open → half-open → open → half-open
 * during a flap) doesn't spam the filesystem.
 *
 * Writes reuse the atomic temp+rename pattern from `serve.ts`. The write
 * carries the same ownership key (`session_id`) as the boot write so a
 * racing second `rea serve` instance is still correctly distinguished at
 * shutdown.
 *
 * ## Why not an IPC endpoint?
 *
 * We briefly considered piggy-backing a `/downstreams.json` route on the
 * metrics HTTP server. Rejected on the grounds of:
 *
 *   - `rea status` works when `REA_METRICS_PORT` is unset (common in local
 *     dev); a disk snapshot keeps it authoritative.
 *   - The write rate is bounded (debounced) and the snapshot is tiny (few
 *     hundred bytes).
 *   - The on-disk file is the one surface a CRASHED gateway leaves behind
 *     — IPC evaporates the moment the process dies, whereas a file survives
 *     for post-mortem inspection.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CircuitBreaker, CircuitState } from './circuit-breaker.js';
import type { DownstreamPool } from './downstream-pool.js';
import type { Logger } from './log.js';
import type { SessionBlockerTracker } from './session-blocker.js';

export interface LiveStateOptions {
  baseDir: string;
  stateFilePath: string;
  sessionId: string;
  startedAt: string;
  metricsPort: number | null;
  pool: DownstreamPool;
  breaker: CircuitBreaker;
  sessionBlocker: SessionBlockerTracker;
  logger?: Logger;
  /**
   * Debounce window for coalesced writes. Default 250 ms. Exposed so tests
   * can force immediate flushes.
   */
  debounceMs?: number;
}

/**
 * Per-downstream block surfaced in `serve.state.json` and echoed by
 * `rea status`. Narrow by design — anything an operator wants beyond this
 * lives in `__rea__health` where the gateway's richer state machine is
 * live.
 */
export interface LiveDownstreamState {
  name: string;
  connected: boolean;
  healthy: boolean;
  circuit_state: CircuitState;
  /** ISO timestamp when the circuit is expected to move to half-open. Only present when `open`. */
  retry_at: string | null;
  last_error: string | null;
  tools_count: number | null;
  /** Cumulative circuit-open transitions counted toward SESSION_BLOCKER. */
  open_transitions: number;
  /** True once SESSION_BLOCKER has fired for this server in the current session. */
  session_blocker_emitted: boolean;
}

export interface LiveServeState {
  session_id: string;
  started_at: string;
  metrics_port: number | null;
  /** Downstream block — added in 0.9.0. Empty array when no servers configured. */
  downstreams: LiveDownstreamState[];
  /** ISO timestamp of this snapshot. Separate from `started_at`. */
  updated_at: string;
}

/** Atomic write helper — duplicated from serve.ts intentionally to keep this module standalone. */
function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignored */
    }
    throw e;
  }
}

interface ResolvedLiveStateOptions {
  baseDir: string;
  stateFilePath: string;
  sessionId: string;
  startedAt: string;
  metricsPort: number | null;
  pool: DownstreamPool;
  breaker: CircuitBreaker;
  sessionBlocker: SessionBlockerTracker;
  debounceMs: number;
  logger?: Logger;
}

export class LiveStatePublisher {
  private readonly opts: ResolvedLiveStateOptions;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: LiveStateOptions) {
    // Build the resolved options defensively. `exactOptionalPropertyTypes`
    // refuses to accept `logger: undefined` against `logger?: Logger`, so
    // we branch on presence instead of assigning `undefined`.
    const base: Omit<ResolvedLiveStateOptions, 'logger'> = {
      baseDir: opts.baseDir,
      stateFilePath: opts.stateFilePath,
      sessionId: opts.sessionId,
      startedAt: opts.startedAt,
      metricsPort: opts.metricsPort,
      pool: opts.pool,
      breaker: opts.breaker,
      sessionBlocker: opts.sessionBlocker,
      debounceMs: opts.debounceMs ?? 250,
    };
    this.opts = opts.logger !== undefined ? { ...base, logger: opts.logger } : base;
  }

  /**
   * Schedule a write. Coalesces multiple calls within the debounce window
   * into a single flush. Safe to call from circuit-breaker and supervisor
   * event paths without worrying about write rate.
   */
  scheduleUpdate(): void {
    if (this.stopped) return;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, this.opts.debounceMs);
    // Allow the Node process to exit even if a pending debounce timer is
    // scheduled — cleanup on shutdown will flush explicitly.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * Write the current snapshot synchronously, bypassing the debounce.
   * Called on boot (to publish the initial downstream block) and on
   * shutdown (to flush any pending updates before the state file is
   * ownership-cleaned).
   *
   * ## Ownership handoff (Codex P1 + P2b)
   *
   * The ownership check + rename is performed under a sidecar lockfile
   * (`serve.state.json.lock`) created with `O_EXCL` (`wx`). This converts
   * what was two non-atomic steps into a serialized critical section.
   *
   * Flow:
   *
   *   1. Acquire the lock (`open(path, 'wx')`). If EEXIST, a concurrent
   *      writer — either another publisher in THIS process (not possible
   *      given the debounce, but cheap to defend against) or another
   *      `rea serve` instance with overlapping lifetime — holds it. Skip
   *      this flush silently; the debounce timer will try again, and on
   *      shutdown the concurrent writer's own state will be authoritative.
   *   2. Under the lock: re-read the on-disk `session_id`. If it belongs
   *      to a DIFFERENT session, another instance has already claimed the
   *      breadcrumb. Release the lock and yield (log-only).
   *   3. Under the lock: atomically rename our temp file over the target.
   *      Because the concurrent writer cannot execute step 3 until we
   *      release the lock, and we only reach step 3 after confirming the
   *      on-disk session matches ours, the "older clobbers newer"
   *      race Codex flagged is closed.
   *   4. Release the lock (unlink the sidecar) in a finally block.
   *
   * Stale locks from a crashed process with the same PID would deadlock
   * the critical section forever — so the acquire step checks the lock
   * file's contents (written as our PID + random nonce) and, if the
   * owning PID is no longer running, steals it. The steal path is
   * intentionally narrow (PID-check only, no timestamp TTL) because
   * holding the lock longer than a single flushNow invocation is a bug.
   */
  flushNow(): void {
    if (this.stopped) return;
    let lockFd: number | null = null;
    try {
      lockFd = this.acquireLock();
      if (lockFd === null) {
        // A concurrent writer holds the lock. Skip this flush; a later
        // debounced scheduleUpdate or the shutdown flushNow will retry.
        return;
      }
      if (!this.ownsStateFile()) {
        // A different session has stamped the file. Yield ownership
        // silently; the newer instance is the authoritative writer.
        this.opts.logger?.info({
          event: 'live_state.yielded',
          message:
            'another rea serve session owns serve.state.json — yielding live-state writes for this process',
        });
        return;
      }
      const snapshot = this.buildSnapshot();
      writeFileAtomic(this.opts.stateFilePath, JSON.stringify(snapshot, null, 2) + '\n');
    } catch (err) {
      // Publishing the live state is best-effort — a write failure (disk
      // full, permission changed under us) must never break the gateway's
      // tool-routing path. Log and continue.
      this.opts.logger?.warn({
        event: 'live_state.write_failed',
        message: 'failed to update serve.state.json — rea status may show stale downstream data',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (lockFd !== null) this.releaseLock(lockFd);
    }
  }

  /** Path to the sidecar lockfile. Resolved once per call; trivial cost. */
  private lockFilePath(): string {
    return `${this.opts.stateFilePath}.lock`;
  }

  /**
   * Try to acquire the sidecar lock. Returns the lock file descriptor on
   * success, or `null` on contention. Throws only on unexpected I/O errors
   * (permissions, disk full) — those propagate out of `flushNow`'s try
   * block and land in the `write_failed` log path.
   *
   * Stale-lock recovery: if a lockfile exists but its recorded PID is not
   * currently running, the file is unlinked and one retry is issued. This
   * covers the case where a previous `rea serve` SIGKILL'd mid-flush and
   * left a dangling lockfile.
   */
  private acquireLock(): number | null {
    const lockPath = this.lockFilePath();
    const payload = `${process.pid} ${crypto.randomUUID()}\n`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeSync(fd, payload);
        return fd;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;
        // Someone holds the lock. Check if the holder is a live process;
        // if not, steal it exactly once.
        if (attempt === 0 && this.isStaleLock(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Best-effort; another racer may have already unlinked. Loop
            // around and attempt the open again regardless.
          }
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * Release the sidecar lock. Best-effort — if the unlink fails, the next
   * flushNow will see a dangling lock and the stale-lock recovery path
   * will clean it up. We MUST still close the fd so we don't leak it.
   */
  private releaseLock(fd: number): void {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignored */
    }
    try {
      fs.unlinkSync(this.lockFilePath());
    } catch {
      /* ignored — stale-lock recovery on next flush will handle it */
    }
  }

  /**
   * Returns true iff the lock file's recorded PID is not currently alive.
   * Uses `process.kill(pid, 0)` which sends no signal but errors with
   * ESRCH when the PID is gone. Any parse error or unexpected kill error
   * is treated as "not stale" to err on the side of NOT stealing a live
   * peer's lock.
   */
  private isStaleLock(lockPath: string): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch {
      return false;
    }
    const match = /^(\d+)\s/.exec(raw);
    if (match === null) return false;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (pid === process.pid) {
      // Our own process already holds the lock — this should be impossible
      // given `flushNow` runs single-threaded on the event loop, but don't
      // steal from ourselves.
      return false;
    }
    try {
      process.kill(pid, 0);
      return false; // Process is alive — lock is not stale.
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH: no such process. EPERM: process exists but we can't signal
      // it (different uid) — treat as NOT stale because the holder is
      // alive from someone else's perspective.
      return code === 'ESRCH';
    }
  }

  /**
   * Returns true iff the on-disk state file either (a) does not exist,
   * (b) cannot be parsed, or (c) carries a `session_id` matching ours.
   * Returning `true` on unparseable/missing is deliberate — the very first
   * boot write HAS to proceed, and a corrupt legacy file is better
   * overwritten by a valid new one than preserved indefinitely.
   *
   * Reading the file on every flush is acceptable cost: writes are
   * debounced to ~4 Hz maximum, the file is tiny (few hundred bytes), and
   * the check avoids the "older instance clobbers newer instance's
   * breadcrumb" hazard Codex flagged.
   */
  private ownsStateFile(): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(this.opts.stateFilePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT is expected on the very first write.
      if (code === 'ENOENT') return true;
      // Any other read error (permissions, EIO) — fall through and try to
      // write; the write will surface the real error via the outer
      // try/catch. We do NOT want to silently suppress writes on a
      // transient read hiccup.
      return true;
    }
    try {
      const parsed = JSON.parse(raw) as { session_id?: unknown };
      if (typeof parsed.session_id !== 'string') return true;
      return parsed.session_id === this.opts.sessionId;
    } catch {
      // Unparseable file — treat as "not owned by anyone", safe to overwrite.
      return true;
    }
  }

  /**
   * Stop further scheduled writes. Called from the gateway shutdown path
   * AFTER the final flush. Clears any pending timer; no more writes will
   * occur after this returns.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests. Builds the canonical payload from live sources. */
  buildSnapshot(): LiveServeState {
    const downstreams = this.buildDownstreamBlock();
    return {
      session_id: this.opts.sessionId,
      started_at: this.opts.startedAt,
      metrics_port: this.opts.metricsPort,
      downstreams,
      updated_at: new Date().toISOString(),
    };
  }

  private buildDownstreamBlock(): LiveDownstreamState[] {
    const health = this.opts.pool.healthSnapshot();
    const blockerSnapshot = new Map<string, { open_transitions: number; emitted: boolean }>();
    for (const entry of this.opts.sessionBlocker.snapshot()) {
      blockerSnapshot.set(entry.server, {
        open_transitions: entry.open_transitions,
        emitted: entry.emitted,
      });
    }
    const out: LiveDownstreamState[] = [];
    for (const h of health) {
      const circuitEntry = this.opts.breaker.getCircuit(h.name);
      const circuitState: CircuitState = circuitEntry?.state ?? 'closed';
      let retryAt: string | null = null;
      if (circuitState === 'open' && circuitEntry?.openedAt != null) {
        retryAt = new Date(circuitEntry.openedAt + circuitEntry.cooldownMs).toISOString();
      }
      const blocker = blockerSnapshot.get(h.name);
      out.push({
        name: h.name,
        connected: h.connected,
        healthy: h.healthy,
        circuit_state: circuitState,
        retry_at: retryAt,
        last_error: h.last_error,
        tools_count: h.tools_count,
        open_transitions: blocker?.open_transitions ?? 0,
        session_blocker_emitted: blocker?.emitted ?? false,
      });
    }
    return out;
  }
}
