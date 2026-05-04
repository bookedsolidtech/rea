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
import type { FieldRedactor, Logger } from './log.js';
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
  /**
   * Redactor applied to `last_error` strings before they are written to
   * `serve.state.json`. `rea serve` wires this to the same
   * `buildRegexRedactor` instance the gateway logger uses (policy
   * `redact.patterns` + built-in `SECRET_PATTERNS`) so a credential that
   * leaked into a downstream error message does not end up on disk or on
   * an operator's terminal via `rea status`.
   *
   * Omitting the redactor preserves pre-0.9.0 behavior (no last_error
   * redaction at the publisher layer). Direct embedders of `createGateway`
   * that pass their own logger redactor should also pass this.
   */
  lastErrorRedactor?: FieldRedactor;
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
  /**
   * PID of the process that wrote this snapshot. Added in 0.9.0 pass-4 so
   * a NEW `rea serve` can detect an ABANDONED state file (writer crashed,
   * no one cleaned up) and take over ownership. Without this field,
   * the pass-2 session_id-only ownership check was strictly safer but
   * also strictly one-directional: once an older session wrote, no new
   * session could ever claim the file, and `rea status` would stall on
   * the dead session forever. Optional for backward compatibility with
   * pre-0.9.0 snapshots that lack the field.
   */
  owner_pid?: number;
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
  lastErrorRedactor?: FieldRedactor;
}

/**
 * Backoff for the yield-retry path. When a newly-started publisher finds the
 * state file owned by a live peer, we log once and then poll at this interval
 * so that the moment the peer exits (ESRCH on the next `isStaleLock` check
 * or `ownsStateFile` reclaim path), we actually publish our snapshot.
 *
 * Intentionally far longer than the normal debounce — this is the worst-case
 * "two `rea serve` processes are up at once" path, not the hot path. Kept in
 * seconds-scale so `rea status` eventually reflects the new session without
 * hammering the sidecar lock.
 *
 * Codex 0.9.0 pass-5 P2a: before this retry existed, `flushNow()` yielded
 * silently and never re-tried. The new gateway therefore never published its
 * own snapshot while the old one was still alive; once the old one exited,
 * nothing triggered a fresh write unless an unrelated supervisor event
 * happened to land, leaving `rea status` stuck on a stale view.
 */
const YIELD_RETRY_MS = 2_000;

export class LiveStatePublisher {
  private readonly opts: ResolvedLiveStateOptions;
  private timer: NodeJS.Timeout | null = null;
  /**
   * Separate timer for the yield-retry path. Kept distinct from `timer` so a
   * scheduled debounce doesn't cancel the retry and vice-versa — they serve
   * different purposes (coalesce vs. poll). Cleared by `stop()`.
   */
  private yieldRetryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: LiveStateOptions) {
    // Build the resolved options defensively. `exactOptionalPropertyTypes`
    // refuses to accept `logger: undefined` against `logger?: Logger`, so
    // we branch on presence instead of assigning `undefined`. Same treatment
    // for `lastErrorRedactor`.
    const base: Omit<ResolvedLiveStateOptions, 'logger' | 'lastErrorRedactor'> = {
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
    const withLogger: Omit<ResolvedLiveStateOptions, 'lastErrorRedactor'> =
      opts.logger !== undefined ? { ...base, logger: opts.logger } : base;
    this.opts =
      opts.lastErrorRedactor !== undefined
        ? { ...withLogger, lastErrorRedactor: opts.lastErrorRedactor }
        : withLogger;
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
        // Codex 0.9.0 pass-5 P2a: schedule a longer-interval retry so that
        // when the live peer exits, this process DOES eventually publish
        // its own snapshot instead of leaving `rea status` stuck on the
        // previous owner's session. Without this, the only way a yielding
        // gateway ever reclaims is if some unrelated event happens to land
        // a `scheduleUpdate()` — which may be never on an idle gateway.
        this.scheduleYieldRetry();
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
   * Returns true iff this publisher is allowed to write the on-disk state
   * file on behalf of its session. The check runs under the sidecar lock
   * (see `flushNow`) so the read + subsequent rename form one serialized
   * critical section.
   *
   * Ownership resolves against three buckets:
   *
   *   1. **Safe-to-write**: the file is absent, corrupt, or has a missing/
   *      malformed `session_id`. No competing session is on disk, so we
   *      write without hesitation.
   *   2. **We own it**: the stored `session_id` matches ours. Normal
   *      steady-state — every flush lands here.
   *   3. **Another session owns it**: the stored `session_id` differs
   *      from ours. Before 0.9.0 pass-4 this was an unconditional yield,
   *      which was strictly safer but broke the crash-recovery case —
   *      a NEW `rea serve` launched after an unclean shutdown would
   *      observe the crashed session's id and yield forever, leaving
   *      `rea status` permanently stuck. Codex pass-4 P1 flagged this.
   *
   *      The 0.9.0 `owner_pid` field exists exactly to disambiguate this
   *      bucket. If `owner_pid` is alive, an overlapping writer is still
   *      running and we yield (silent). If `owner_pid` is gone (ESRCH)
   *      or missing from the payload (pre-0.9.0 file or same-process
   *      write), we treat the file as abandoned and take over.
   *
   * `process.kill(pid, 0)` returns ESRCH for a missing PID, EPERM for a
   * live PID we cannot signal. We treat EPERM as "alive from someone's
   * perspective" and yield — never steal a file the kernel is uncertain
   * about.
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
    let parsed: { session_id?: unknown; owner_pid?: unknown };
    try {
      parsed = JSON.parse(raw) as { session_id?: unknown; owner_pid?: unknown };
    } catch {
      // Unparseable file — treat as "not owned by anyone", safe to overwrite.
      return true;
    }
    if (typeof parsed.session_id !== 'string') return true;
    if (parsed.session_id === this.opts.sessionId) return true;
    // Foreign session_id. Use owner_pid to decide whether to yield or steal.
    if (
      typeof parsed.owner_pid !== 'number' ||
      !Number.isFinite(parsed.owner_pid) ||
      parsed.owner_pid <= 0
    ) {
      // Pre-0.9.0 file (no owner_pid recorded) or malformed value. We
      // cannot prove the writer is alive, and refusing to write forever
      // is the bigger hazard — claim the file. This is the same
      // conservative "better a stale snapshot gets replaced by a valid
      // one" rule the old code applied to unparseable files.
      this.opts.logger?.info({
        event: 'live_state.reclaimed',
        message:
          'serve.state.json has a foreign session_id without owner_pid — treating as abandoned',
      });
      return true;
    }
    const ownerPid = parsed.owner_pid;
    try {
      process.kill(ownerPid, 0);
      // PID is alive — another `rea serve` instance is still writing.
      return false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        // Writer is gone. File is abandoned; steal ownership.
        this.opts.logger?.info({
          event: 'live_state.reclaimed',
          message: `serve.state.json previous owner pid ${ownerPid} is gone — reclaiming for session ${this.opts.sessionId}`,
        });
        return true;
      }
      // EPERM or any other signal error — the PID exists but we can't
      // signal it. Err on the side of yielding; do not steal from a
      // possibly-live peer.
      return false;
    }
  }

  /**
   * Schedule a longer-interval retry of `flushNow`. Used by the yield path
   * so a new gateway waiting on a live peer eventually reclaims the file
   * when the peer exits. Idempotent — if a retry is already pending, this
   * call is a no-op.
   *
   * Distinct from `scheduleUpdate()` because:
   *   - The debounce timer coalesces rapid events; this timer polls at a
   *     slow cadence for ownership changes.
   *   - Scheduling yield retries on the debounce timer would mean one
   *     supervisor event during the wait cancels the retry, and the
   *     debounce timer ALSO can't be re-scheduled while `timer !== null`.
   */
  private scheduleYieldRetry(): void {
    if (this.stopped) return;
    if (this.yieldRetryTimer !== null) return;
    this.yieldRetryTimer = setTimeout(() => {
      this.yieldRetryTimer = null;
      this.flushNow();
    }, YIELD_RETRY_MS);
    if (typeof this.yieldRetryTimer.unref === 'function') this.yieldRetryTimer.unref();
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
    if (this.yieldRetryTimer !== null) {
      clearTimeout(this.yieldRetryTimer);
      this.yieldRetryTimer = null;
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
      // Stamp the owning PID so a future `rea serve` can distinguish
      // "another live session is writing this file" from "the previous
      // writer crashed and left orphaned breadcrumbs". See `ownsStateFile`.
      owner_pid: process.pid,
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
      // Run `last_error` through the optional redactor before persistence.
      // Null passes through unchanged; absent redactor = pre-0.9.0 behavior.
      const lastError =
        h.last_error !== null && this.opts.lastErrorRedactor
          ? this.opts.lastErrorRedactor(h.last_error)
          : h.last_error;
      out.push({
        name: h.name,
        connected: h.connected,
        healthy: h.healthy,
        circuit_state: circuitState,
        retry_at: retryAt,
        last_error: lastError,
        tools_count: h.tools_count,
        open_transitions: blocker?.open_transitions ?? 0,
        session_blocker_emitted: blocker?.emitted ?? false,
      });
    }
    return out;
  }
}
