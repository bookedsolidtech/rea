import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { InvocationStatus } from '../../policy/types.js';
import type { Middleware } from './chain.js';

const MAX_HALT_READ_BYTES = 1024;
const REA_DIR = '.rea';
const HALT_FILE = 'HALT';

/**
 * Checks for `.rea/HALT` file. If present, denies the invocation.
 *
 * SECURITY: Validates HALT is a regular file (not directory/symlink to sensitive file).
 * SECURITY: Symlinks must resolve to a target within `.rea/`.
 * SECURITY: Caps read size to prevent oversized error strings.
 * SECURITY: Fails closed on unexpected errors.
 */
export function createKillSwitchMiddleware(baseDir: string): Middleware {
  return async (ctx, next) => {
    const haltPath = path.join(baseDir, REA_DIR, HALT_FILE);

    try {
      const stat = await fs.stat(haltPath);

      if (!stat.isFile()) {
        ctx.status = InvocationStatus.Denied;
        ctx.error = 'Kill switch active: HALT exists (non-file)';
        return;
      }

      const lstat = await fs.lstat(haltPath);
      if (lstat.isSymbolicLink()) {
        const target = await fs.realpath(haltPath);
        const reaDir = path.join(baseDir, REA_DIR);
        if (!target.startsWith(reaDir)) {
          ctx.status = InvocationStatus.Denied;
          ctx.error = 'Kill switch active: HALT is a symlink outside .rea/';
          return;
        }
      }

      const fh = await fs.open(haltPath, fsConstants.O_RDONLY);
      try {
        const buf = Buffer.alloc(MAX_HALT_READ_BYTES);
        const { bytesRead } = await fh.read(buf, 0, MAX_HALT_READ_BYTES, 0);
        const reason = buf.subarray(0, bytesRead).toString('utf8').trim();
        ctx.status = InvocationStatus.Denied;
        ctx.error = `Kill switch active: ${reason}`;
      } finally {
        await fh.close();
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await next();
        return;
      }
      ctx.status = InvocationStatus.Denied;
      ctx.error = `Kill switch check failed: ${(err as Error).message}`;
    }
  };
}
