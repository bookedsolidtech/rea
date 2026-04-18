import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { InvocationStatus } from '../../policy/types.js';
import type { Middleware } from './chain.js';

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
export function createKillSwitchMiddleware(baseDir: string): Middleware {
  return async (ctx, next) => {
    const haltPath = path.join(baseDir, REA_DIR, HALT_FILE);

    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(haltPath, fsConstants.O_RDONLY);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        // HALT absent at the moment of check. Decision is final — no re-check.
        ctx.metadata.halt_decision = 'absent';
        ctx.metadata.halt_at_invocation = null;
        await next();
        return;
      }
      // Any other errno (EACCES, EPERM, EISDIR on some platforms, EIO, …) is an
      // unknown state. Fail closed: deny the invocation and surface the errno.
      ctx.status = InvocationStatus.Denied;
      ctx.error = `Kill switch check failed: ${errno ?? 'unknown'} (${(err as Error).message})`;
      ctx.metadata.halt_decision = 'unknown';
      ctx.metadata.halt_at_invocation = null;
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
