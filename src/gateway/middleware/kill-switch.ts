import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { InvocationStatus } from '../../policy/types.js';
import type { Middleware } from './chain.js';
import type { MetricsRegistry } from '../observability/metrics.js';

const MAX_HALT_READ_BYTES = 1024;
const REA_DIR = '.rea';
const HALT_FILE = 'HALT';

/**
 * HALT semantic guarantee:
 *   - HALT is read exactly once per invocation, at the top of this middleware layer.
 *   - Decision is final for the remainder of the chain; downstream middleware and
 *     the terminal never re-check HALT.
 *   - Creating HALT mid-flight does NOT cancel in-flight invocations. Remove HALT
 *     to re-enable new invocations; outstanding ones complete.
 *   - This layer is first in the chain so the decision frames every other layer's
 *     view. Do not reorder.
 *
 * Implementation:
 *   - Exactly ONE syscall on the HALT file per invocation: `fs.open(path, O_RDONLY)`.
 *     There is no preceding stat/exists/lstat call, so there is no TOCTOU window
 *     between a check and a subsequent open.
 *   - ENOENT on open  → HALT absent → proceed with the chain.
 *   - Open succeeds   → HALT present → deny. The file descriptor is then used
 *     (best-effort) to read the reason string for the error message, with the
 *     read size capped at {@link MAX_HALT_READ_BYTES}. The denial does NOT depend
 *     on the read succeeding.
 *   - Any other errno → unknown state → deny (fail-closed).
 *   - The decision is recorded on `ctx.metadata.halt_decision` for audit and is
 *     never re-consulted by downstream middleware.
 */
export function createKillSwitchMiddleware(
  baseDir: string,
  /**
   * 0.54.0 worktree state: the COMMON (primary-checkout) root. `rea
   * freeze` writes there so a freeze from ANY worktree stops a gateway
   * serving this one; the LOCAL probe stays first (legacy per-worktree
   * HALT). Defaults to `baseDir` — plain checkouts keep the exactly-one-
   * syscall-per-invocation contract; worktrees pay one extra open only
   * when the local probe misses.
   */
  commonDir?: string,
  /**
   * Optional metrics registry. When supplied, every invocation marks the
   * `rea_seconds_since_last_halt_check` gauge with a fresh timestamp so the
   * exposed gauge reflects real per-call check cadence rather than the
   * startup-time mark `rea serve` sets once. When omitted, no metric is
   * emitted.
   */
  metrics?: MetricsRegistry,
): Middleware {
  return async (ctx, next) => {
    const haltPath = path.join(baseDir, REA_DIR, HALT_FILE);
    const commonHaltPath =
      commonDir !== undefined && commonDir !== baseDir
        ? path.join(commonDir, REA_DIR, HALT_FILE)
        : null;

    // Record the HALT-check attempt BEFORE we probe the filesystem so the
    // gauge reflects "how long since we last looked", regardless of whether
    // this check succeeds or fails. Fresh on every invocation; failure to
    // update metrics must not crash the gateway.
    try {
      metrics?.markHaltCheck();
    } catch {
      // Metrics registry implementations are expected to be infallible,
      // but we refuse to let them take down the chain in any case.
    }

    // Probe order (0.54.0): LOCAL root first (legacy per-worktree HALT),
    // then the COMMON root (where `rea freeze` writes — a freeze issued
    // from any worktree stops this gateway). Plain checkouts have no
    // common path and keep the exactly-one-syscall contract. ENOENT on a
    // probe advances to the next; any other errno is an unknown state →
    // fail closed. `fh` non-null after the loop ⇒ HALT present.
    let fh: fs.FileHandle | undefined;
    const probePaths = commonHaltPath !== null ? [haltPath, commonHaltPath] : [haltPath];
    for (const probe of probePaths) {
      try {
        fh = await fs.open(probe, fsConstants.O_RDONLY);
        break;
      } catch (err) {
        const errno = (err as NodeJS.ErrnoException).code;
        if (errno === 'ENOENT') {
          continue;
        }
        // EACCES, EPERM, EISDIR on some platforms, EIO, … — unknown
        // state. Fail closed: deny the invocation and surface the errno.
        ctx.status = InvocationStatus.Denied;
        ctx.error = `Kill switch check failed: ${errno ?? 'unknown'} (${(err as Error).message})`;
        ctx.metadata.halt_decision = 'unknown';
        ctx.metadata.halt_at_invocation = null;
        return;
      }
    }
    if (fh === undefined) {
      // HALT absent at the moment of check. Decision is final — no re-check.
      ctx.metadata.halt_decision = 'absent';
      ctx.metadata.halt_at_invocation = null;
      await next();
      return;
    }

    // Open succeeded → HALT is present → decision is locked to DENY.
    // The subsequent read is best-effort only; it shapes the error message but
    // does NOT influence the decision. Timestamp reflects the moment the
    // decision was made, not the file's mtime.
    ctx.metadata.halt_decision = 'present';
    ctx.metadata.halt_at_invocation = new Date().toISOString();

    let reason = '';
    try {
      const buf = Buffer.alloc(MAX_HALT_READ_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_HALT_READ_BYTES, 0);
      reason = buf.subarray(0, bytesRead).toString('utf8').trim();
    } catch {
      // Read failed (e.g., EISDIR on Linux when HALT is a directory). The
      // denial still stands — we just fall back to a generic reason string.
      reason = '';
    } finally {
      await fh.close().catch(() => {
        /* closing a dead fd is not actionable — denial already recorded */
      });
    }

    ctx.status = InvocationStatus.Denied;
    ctx.error = reason ? `Kill switch active: ${reason}` : 'Kill switch active: HALT present';
  };
}
