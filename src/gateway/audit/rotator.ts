/**
 * Audit rotation (G1). Size- and age-based rotation for `.rea/audit.jsonl`
 * that preserves hash-chain continuity across the rotation boundary.
 *
 * ## Triggers
 *
 * Rotation fires when EITHER threshold is crossed:
 *
 * - `max_bytes` — the current `audit.jsonl` is at or above this many bytes.
 *   Default when the policy block is present but `max_bytes` is unset:
 *   `DEFAULT_MAX_BYTES` (50 MiB).
 * - `max_age_days` — the first record's `timestamp` is older than this many
 *   days. Default when unset: `DEFAULT_MAX_AGE_DAYS` (30).
 *
 * Back-compat: if the `audit.rotation` policy block is ABSENT entirely,
 * rotation is DISABLED. Defaults only apply when the operator has opted in
 * by declaring the block (even empty). This is deliberate — we do not want
 * a 0.2.x install to observe new file-movement behavior on 0.3.0 upgrade
 * without being asked.
 *
 * ## Rotation marker
 *
 * On rotation, the current file is renamed to `audit-YYYYMMDD-HHMMSS.jsonl`
 * in the same directory. A fresh `audit.jsonl` is created containing EXACTLY
 * one record: a rotation marker.
 *
 *     tool_name:          'audit.rotation'
 *     server_name:        'rea'
 *     status:             'allowed'
 *     tier:               'read'
 *     autonomy_level:     'system'
 *     prev_hash:          hash of the LAST record in the rotated file
 *     metadata.rotated_from: the rotated filename (basename)
 *     metadata.rotated_at:   ISO-8601 instant of rotation
 *
 * The marker's `prev_hash` is the chain bridge — an operator verifying the
 * chain with `rea audit verify --since <rotated-file>` walks rotated →
 * marker → current and every transition must line up.
 *
 * ## Concurrency
 *
 * `maybeRotate` is called BEFORE the per-append lock is acquired. It takes
 * its own short-lived lock on `.rea/` to perform the rename + marker write
 * atomically. Callers that beat the rotator to the lock simply append to
 * the (now fresh) file — correctness is preserved because the rotation
 * marker is a legitimate chain anchor.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Policy, AuditRotationPolicy } from '../../policy/types.js';
import type { AuditRecord } from '../middleware/audit-types.js';
import { Tier, InvocationStatus } from '../../policy/types.js';
import { computeHash, readLastRecord, withAuditLock } from '../../audit/fs.js';

/** 50 MiB. Only applied when the operator has declared `audit.rotation`. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** 30 days. Only applied when the operator has declared `audit.rotation`. */
export const DEFAULT_MAX_AGE_DAYS = 30;

export const ROTATION_TOOL_NAME = 'audit.rotation';
export const ROTATION_SERVER_NAME = 'rea';

export interface RotationResult {
  rotated: boolean;
  /** Absolute path of the rotated file (the `audit-TIMESTAMP.jsonl` file). */
  rotatedTo?: string;
}

/** Resolve effective thresholds from policy. `undefined` thresholds disable that trigger. */
interface EffectiveThresholds {
  maxBytes: number | undefined;
  maxAgeMs: number | undefined;
}

/**
 * Compute the effective rotation thresholds from policy. If the operator has
 * NOT declared an `audit.rotation` block, BOTH thresholds are undefined and
 * rotation is disabled (back-compat with 0.2.x).
 *
 * If the block IS declared but individual knobs are missing, apply the
 * documented defaults.
 */
function effectiveThresholds(policy: Policy | undefined): EffectiveThresholds {
  const rot = policy?.audit?.rotation;
  if (rot === undefined) {
    return { maxBytes: undefined, maxAgeMs: undefined };
  }
  // An explicit `audit.rotation: {}` block opts in to both defaults.
  const maxBytes = rot.max_bytes ?? DEFAULT_MAX_BYTES;
  const maxAgeDays = rot.max_age_days ?? DEFAULT_MAX_AGE_DAYS;
  return { maxBytes, maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000 };
}

/**
 * Build the rotation timestamp filename. UTC for sortability.
 * Format: `audit-YYYYMMDD-HHMMSS.jsonl`. Collisions (two rotations in the
 * same second) are resolved by appending `-1`, `-2`, etc.
 */
export function rotationFilename(at: Date): string {
  const y = at.getUTCFullYear().toString().padStart(4, '0');
  const m = (at.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = at.getUTCDate().toString().padStart(2, '0');
  const hh = at.getUTCHours().toString().padStart(2, '0');
  const mm = at.getUTCMinutes().toString().padStart(2, '0');
  const ss = at.getUTCSeconds().toString().padStart(2, '0');
  return `audit-${y}${m}${d}-${hh}${mm}${ss}.jsonl`;
}

/**
 * Probe the first record's timestamp WITHOUT loading the whole file into
 * memory as a JSON blob. We read up to the first newline and parse just
 * that line. Returns `undefined` if the file is empty / unreadable / the
 * first line isn't valid JSON with a usable `timestamp` field.
 */
async function readFirstTimestamp(auditFile: string): Promise<Date | undefined> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(auditFile, 'r');
    // 64 KiB is enough for the first record under any realistic schema.
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return undefined;
    const chunk = buf.slice(0, bytesRead).toString('utf8');
    const newline = chunk.indexOf('\n');
    const firstLine = newline === -1 ? chunk : chunk.slice(0, newline);
    if (firstLine.length === 0) return undefined;
    const parsed = JSON.parse(firstLine) as Partial<AuditRecord>;
    if (typeof parsed.timestamp !== 'string') return undefined;
    const ts = Date.parse(parsed.timestamp);
    if (Number.isNaN(ts)) return undefined;
    return new Date(ts);
  } catch {
    return undefined;
  } finally {
    if (fh) await fh.close();
  }
}

/**
 * Decide whether the current audit file has crossed any rotation threshold.
 * Exported for testing.
 */
export async function shouldRotate(
  auditFile: string,
  thresholds: EffectiveThresholds,
  now: Date = new Date(),
): Promise<boolean> {
  if (thresholds.maxBytes === undefined && thresholds.maxAgeMs === undefined) {
    return false;
  }

  let size: number;
  try {
    const stat = await fs.stat(auditFile);
    if (!stat.isFile()) return false;
    size = stat.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  // Empty files never rotate — rotating an empty file would create a chain
  // anchored on genesis with a dangling predecessor.
  if (size === 0) return false;

  if (thresholds.maxBytes !== undefined && size >= thresholds.maxBytes) {
    return true;
  }

  if (thresholds.maxAgeMs !== undefined) {
    const firstTs = await readFirstTimestamp(auditFile);
    if (firstTs !== undefined) {
      const ageMs = now.getTime() - firstTs.getTime();
      if (ageMs >= thresholds.maxAgeMs) return true;
    }
  }

  return false;
}

/**
 * Pick a rotation filename that doesn't collide with an existing file.
 * Returns the absolute path.
 */
async function pickRotationPath(reaDir: string, at: Date): Promise<string> {
  const base = rotationFilename(at);
  const baseNoExt = base.replace(/\.jsonl$/, '');
  let candidate = path.join(reaDir, base);
  let suffix = 1;
  while (true) {
    try {
      await fs.access(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return candidate;
      }
      throw err;
    }
    candidate = path.join(reaDir, `${baseNoExt}-${suffix}.jsonl`);
    suffix += 1;
    if (suffix > 1000) {
      throw new Error(`Unable to pick rotation filename in ${reaDir} — 1000 collisions`);
    }
  }
}

/**
 * Perform the rotation unconditionally. Assumes the caller has already
 * determined rotation is warranted and holds (or is about to acquire) any
 * outer locks. `performRotation` takes its own lock on `.rea/` to make the
 * rename + marker write atomic w.r.t. other append-path lockers.
 *
 * Returns `{ rotated: false }` if the audit file is empty or missing — an
 * empty file is a no-op by design (see `rea audit rotate` empty-case).
 */
export async function performRotation(
  auditFile: string,
  now: Date = new Date(),
): Promise<RotationResult> {
  const reaDir = path.dirname(auditFile);

  // Ensure the parent exists so withAuditLock can place a lock file. The
  // caller normally creates this; we mkdir defensively for the force-rotate
  // path (`rea audit rotate` on a green-field install).
  await fs.mkdir(reaDir, { recursive: true });

  return withAuditLock(auditFile, async () => {
    // Re-check the file under the lock. Another writer may have rotated
    // between the caller's decision and our lock acquisition.
    let size: number;
    try {
      const stat = await fs.stat(auditFile);
      if (!stat.isFile()) return { rotated: false };
      size = stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rotated: false };
      throw err;
    }
    if (size === 0) return { rotated: false };

    // Pull the last record's hash BEFORE renaming — so we can anchor the
    // marker's prev_hash on the old chain's tail. readLastRecord also
    // performs partial-write recovery under our lock (idempotent).
    const { hash: tailHash } = await readLastRecord(auditFile);

    const rotatedPath = await pickRotationPath(reaDir, now);
    await fs.rename(auditFile, rotatedPath);

    // Write the rotation marker into a fresh audit.jsonl. The marker's
    // prev_hash is the old tail's hash — operators can walk rotated →
    // marker and the chain holds.
    const markerBase: Omit<AuditRecord, 'hash'> = {
      timestamp: now.toISOString(),
      session_id: 'system',
      tool_name: ROTATION_TOOL_NAME,
      server_name: ROTATION_SERVER_NAME,
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      autonomy_level: 'system',
      duration_ms: 0,
      prev_hash: tailHash,
      metadata: {
        rotated_from: path.basename(rotatedPath),
        rotated_at: now.toISOString(),
      },
    };
    const markerHash = computeHash(markerBase);
    const marker: AuditRecord = { ...markerBase, hash: markerHash };
    const line = JSON.stringify(marker) + '\n';
    await fs.writeFile(auditFile, line, { flag: 'w' });

    return { rotated: true, rotatedTo: rotatedPath };
  });
}

/**
 * Called by the append path BEFORE acquiring its own lock. Cheap when no
 * rotation is due (one stat, maybe one 64 KiB read for age check); idempotent
 * when rotation IS due (performRotation re-checks under the lock).
 *
 * Never throws. On any error, logs to stderr and returns `rotated: false`
 * — a broken rotator must NOT break the audit append.
 */
export async function maybeRotate(
  auditFile: string,
  policy: Policy | undefined,
  now: Date = new Date(),
): Promise<RotationResult> {
  try {
    const thresholds = effectiveThresholds(policy);
    if (thresholds.maxBytes === undefined && thresholds.maxAgeMs === undefined) {
      return { rotated: false };
    }
    const due = await shouldRotate(auditFile, thresholds, now);
    if (!due) return { rotated: false };
    return await performRotation(auditFile, now);
  } catch (err) {
    console.error(
      '[rea] AUDIT ROTATION FAILED:',
      err instanceof Error ? err.message : String(err),
    );
    return { rotated: false };
  }
}

/**
 * CLI-invoked force rotation (`rea audit rotate`). Unlike `maybeRotate` this
 * DOES ignore thresholds — the operator asked explicitly — but empty files
 * are still a no-op because rotating an empty chain produces a marker with
 * no predecessor.
 */
export async function forceRotate(
  auditFile: string,
  now: Date = new Date(),
): Promise<RotationResult> {
  return performRotation(auditFile, now);
}

/**
 * Exposed for tests/callers that already know the policy shape. Tests that
 * want to stub thresholds can call `performRotation` directly.
 */
export { effectiveThresholds as _effectiveThresholds };
export type { EffectiveThresholds, AuditRotationPolicy };
