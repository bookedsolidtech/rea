/**
 * Shared audit filesystem primitives (G1). Both the gateway audit middleware
 * (`src/gateway/middleware/audit.ts`) and the public append helper
 * (`src/audit/append.ts`) funnel through this module so locking, partial-write
 * recovery, and rotation semantics stay in lockstep.
 *
 * ## Locking
 *
 * Every append acquires a `proper-lockfile` lock on the audit file's parent
 * directory (`.rea/`) — NOT on `audit.jsonl` directly, because `proper-lockfile`
 * refuses to lock a file that does not yet exist. The lock is taken BEFORE the
 * read-last-record → compute-hash → append → fsync sequence, so two processes
 * on the same filesystem can append concurrently without interleaving.
 *
 * Stale-lock detection: `proper-lockfile` handles `EEXIST` with `stale: 10000`
 * (10s). A crashed writer that leaves a stale lockfile frees itself on the
 * next append attempt.
 *
 * ## Partial-write recovery
 *
 * An append that crashes mid-write leaves a trailing line WITHOUT a newline.
 * `readLastRecord()` detects this signal (file doesn't end with `\n`) and
 * truncates the partial line before returning the previous record's hash.
 * This recovery is idempotent and runs on every read.
 *
 * ## Locking contract
 *
 * Callers invoke `withAuditLock(auditFile, async () => { ... })`. The callback
 * MUST perform its read → compute → append → fsync inside the lock scope. On
 * lock acquisition failure the callback does NOT run — the caller receives
 * the error and decides whether to fall back (middleware logs and continues;
 * the public helper propagates).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import properLockfile from 'proper-lockfile';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Lock-file retry envelope. `stale: 10000` lets a crashed holder's lock be
 * reclaimed after 10s of inactivity. Retries are generous because individual
 * appends are cheap (single-digit milliseconds) and under heavy cross-process
 * contention we would rather wait than surface EEXIST to the caller. The
 * budget is bounded (`retries: 40`, max ~300ms per retry) so a truly
 * compromised lockfile still surfaces quickly.
 */
const LOCK_OPTIONS: Parameters<typeof properLockfile.lock>[1] = {
  stale: 10_000,
  retries: {
    retries: 40,
    factor: 1.3,
    minTimeout: 15,
    maxTimeout: 300,
    randomize: true,
  },
  // Lock the parent directory (the audit file may not exist yet on first
  // write). proper-lockfile's `realpath: false` avoids a symlink check that
  // fails when the file itself hasn't been created.
  realpath: false,
};

/**
 * Acquire an exclusive lock on the audit file's parent directory and run
 * `fn` inside it. The parent directory must exist before calling this.
 *
 * The lock is released even if `fn` throws. Lock-acquisition failures
 * surface as the caller's rejection — middleware catches and logs, the
 * public helper propagates.
 */
export async function withAuditLock<T>(
  auditFile: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockTarget = path.dirname(auditFile);
  const release = await properLockfile.lock(lockTarget, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // Releasing a lock can fail if the lockfile was already cleaned up
      // by stale-detection. That's not a correctness problem for the caller
      // — the work already completed. Swallow.
    }
  }
}

export function computeHash(record: Omit<AuditRecord, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/**
 * Read the last complete JSON record from the audit file. Returns the parsed
 * record plus its hash (the value a new append should use for `prev_hash`).
 *
 * Recovers from three tail states:
 *   - File does not exist → genesis.
 *   - File exists but is empty (or only whitespace) → genesis.
 *   - File tail does not end in `\n` → treat the trailing partial line as a
 *     crash signal, truncate it, and return the record before it.
 *
 * Never throws on read-side issues except raw I/O errors (permission, ENOSPC,
 * etc.) that the caller should surface.
 */
export async function readLastRecord(
  auditFile: string,
): Promise<{ record: AuditRecord | null; hash: string }> {
  let data: string;
  try {
    data = await fs.readFile(auditFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { record: null, hash: GENESIS_HASH };
    }
    throw err;
  }

  if (data.length === 0) {
    return { record: null, hash: GENESIS_HASH };
  }

  // Partial-write recovery: a crash mid-append leaves the file without a
  // trailing newline. Truncate the unterminated tail before consulting the
  // chain. This is the only way a partial line can reach disk — every clean
  // append writes `JSON.stringify(record) + '\n'`.
  const endsWithNewline = data.endsWith('\n');
  if (!endsWithNewline) {
    const lastNewline = data.lastIndexOf('\n');
    if (lastNewline === -1) {
      // Whole file is a partial write — truncate to empty.
      await fs.truncate(auditFile, 0);
      return { record: null, hash: GENESIS_HASH };
    }
    // Keep everything through the last newline (inclusive); drop the partial
    // tail. +1 to include the newline itself.
    const keepLength = Buffer.byteLength(data.slice(0, lastNewline + 1), 'utf8');
    await fs.truncate(auditFile, keepLength);
    data = data.slice(0, lastNewline + 1);
  }

  const trimmed = data.replace(/\n+$/, '');
  if (trimmed.length === 0) {
    return { record: null, hash: GENESIS_HASH };
  }

  const lastNewline = trimmed.lastIndexOf('\n');
  const lastLine = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1);

  try {
    const parsed = JSON.parse(lastLine) as Partial<AuditRecord>;
    if (typeof parsed.hash === 'string' && parsed.hash.length === 64) {
      return { record: parsed as AuditRecord, hash: parsed.hash };
    }
  } catch {
    // Corrupt tail — fall through. We do NOT throw: refusing to append would
    // mask every subsequent event. The chain-verify command (`rea audit
    // verify`) will flag the break point for the operator.
  }
  return { record: null, hash: GENESIS_HASH };
}

/**
 * Open-and-fsync the audit file. Called after an append to flush the write
 * to durable storage. fsync failure is not fatal — the append itself
 * already succeeded; durability is best-effort.
 */
export async function fsyncFile(filePath: string): Promise<void> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    await fh.sync();
  } catch {
    // fsync failure is not fatal — the write itself already succeeded.
  } finally {
    if (fh) await fh.close();
  }
}
