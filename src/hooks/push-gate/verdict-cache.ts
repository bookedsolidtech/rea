/**
 * Durable verdict cache for the push-gate (helixir #1, #4, #7, #8 / 0.18.1).
 *
 * Pre-0.18.1 the push-gate was strictly stateless: every push of the same
 * `head_sha` invoked `codex exec review` afresh. helixir round 82 reproduced
 * the failure mode — push #1 of `9fbdfb63` returned PASS, push #2 of the
 * IDENTICAL commit returned CONCERNS — 1 P2. The verdict instability is
 * a property of codex's stochastic decoding at `reasoning_effort: high`;
 * rea cannot eliminate it, but rea CAN make a clean PASS DURABLE so the
 * second push of the same SHA doesn't roll the dice again.
 *
 * Design:
 *
 *   .rea/last-review.cache.json
 *   {
 *     schema_version: 2,
 *     entries: {
 *       "<head_sha>": {
 *         verdict: "pass" | "concerns" | "blocking",
 *         finding_count: number,
 *         reviewed_at: ISO8601,
 *         model: string,
 *         reasoning_effort: "low" | "medium" | "high",
 *         ttl_ms: number,                 // policy.review.cache_ttl_ms at write time
 *       },
 *       ...
 *     }
 *   }
 *
 *   - Hit (within TTL): emit `rea.push_gate.cache_hit` audit event, exit
 *     with the cached verdict + finding count; codex is NOT invoked.
 *   - Miss or expired: invoke codex; on success, write the new entry.
 *   - Flip detection: if a new codex result on the same SHA produces a
 *     verdict different from the cached one, set `last-review.json.flip_flag = true`,
 *     emit `rea.push_gate.verdict_flip`, and overwrite the cache with
 *     the fresh result. Operators can detect non-determinism from the
 *     audit log alone (helixir #8).
 *   - REA_SKIP_CODEX_REVIEW short-circuits BEFORE cache lookup (unchanged).
 *
 * 0.19.0 review fixes:
 *   - Concurrent writes are now serialized via `withAuditLock` on the
 *     `.rea/` directory (backend-engineer P1-2; security M3). Two
 *     concurrent push-gate runs no longer race read-modify-write.
 *   - Tmp filenames carry a high-entropy suffix (PID + millis + random)
 *     and are unlinked in finally so a crash mid-write doesn't leave
 *     stale state (backend-engineer P1-3; code-reviewer P2-1).
 *   - All three writers (writeVerdict, clearVerdict, pruneOlderThan,
 *     clearAll) route through one `_atomicWrite` helper — no asymmetry
 *     between paths (code-reviewer P2-2).
 *   - On unrecognized schema_version, reads return undefined AND
 *     writes refuse to overwrite — the v3 cache stays intact for a
 *     future rea version that knows how to read it (code-reviewer P3-5;
 *     backend-engineer P2-2).
 *
 * The cache is OPTIONAL by design: existing callers that don't pass a
 * `cacheImpl` get the legacy stateless path. Tests inject a fake.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { withAuditLock } from '../../audit/fs.js';
import type { Verdict as ReviewVerdict } from './findings.js';

export const VERDICT_CACHE_FILE = 'last-review.cache.json';
export const VERDICT_CACHE_SCHEMA_VERSION = 2 as const;
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24h

export interface VerdictCacheEntry {
  verdict: ReviewVerdict;
  finding_count: number;
  reviewed_at: string;
  model: string;
  reasoning_effort: 'low' | 'medium' | 'high';
  ttl_ms: number;
}

interface VerdictCacheFile {
  schema_version: typeof VERDICT_CACHE_SCHEMA_VERSION;
  entries: Record<string, VerdictCacheEntry>;
}

interface ForeignCacheFile {
  schema_version: number;
  entries: Record<string, unknown>;
}

export interface VerdictCacheLookupResult {
  /** True if a non-expired entry exists for this SHA. */
  hit: boolean;
  /** The entry, present on both hit and miss-of-stale-entry. Used for flip detection. */
  entry?: VerdictCacheEntry;
  /** True if the entry exists but is past TTL. */
  expired?: boolean;
}

/**
 * Read the cache file and look up `head_sha`. Missing file, malformed
 * JSON, missing entry, and unsupported schema_version all resolve to a
 * miss with `entry: undefined` — the caller proceeds to codex.
 */
export function lookupVerdict(
  baseDir: string,
  headSha: string,
  now: Date = new Date(),
): VerdictCacheLookupResult {
  const file = readCacheFile(baseDir);
  if (file === undefined) return { hit: false };
  const entry = file.entries[headSha];
  if (entry === undefined) return { hit: false };
  const reviewedAtMs = Date.parse(entry.reviewed_at);
  if (Number.isNaN(reviewedAtMs)) return { hit: false, entry };
  const ageMs = now.getTime() - reviewedAtMs;
  if (ageMs >= entry.ttl_ms) {
    return { hit: false, entry, expired: true };
  }
  return { hit: true, entry };
}

/**
 * Detect whether a new verdict contradicts a previously-cached verdict
 * on the same SHA. Used by `runPushGate` to set the flip-flag on
 * last-review.json and emit the `verdict_flip` audit event.
 */
export function isFlip(prior: VerdictCacheEntry | undefined, fresh: ReviewVerdict): boolean {
  if (prior === undefined) return false;
  return prior.verdict !== fresh;
}

/**
 * Write a fresh verdict entry. Atomic via tmp-file + rename, serialized
 * via `withAuditLock` on `.rea/`. Refuses to overwrite when the existing
 * cache has an unrecognized schema_version (forward-compat — a v3 cache
 * from a future rea version stays intact for that version to read).
 */
export async function writeVerdict(
  baseDir: string,
  headSha: string,
  entry: VerdictCacheEntry,
): Promise<void> {
  const reaDir = path.join(baseDir, '.rea');
  if (!fs.existsSync(reaDir)) {
    fs.mkdirSync(reaDir, { recursive: true });
  }
  const cachePath = path.join(reaDir, VERDICT_CACHE_FILE);
  await withAuditLock(cachePath, async () => {
    if (foreignSchemaPresent(baseDir)) {
      throw new VerdictCacheForeignSchemaError(cachePath);
    }
    const existing = readCacheFile(baseDir);
    const next: VerdictCacheFile = {
      schema_version: VERDICT_CACHE_SCHEMA_VERSION,
      entries: { ...(existing?.entries ?? {}), [headSha]: entry },
    };
    _atomicWriteJson(cachePath, next);
  });
}

/**
 * Remove a single SHA from the cache. Returns true if the entry existed.
 */
export async function clearVerdict(baseDir: string, headSha: string): Promise<boolean> {
  const cachePath = path.join(baseDir, '.rea', VERDICT_CACHE_FILE);
  return withAuditLock(cachePath, async () => {
    const file = readCacheFile(baseDir);
    if (file === undefined || file.entries[headSha] === undefined) return false;
    const next: VerdictCacheFile = {
      schema_version: VERDICT_CACHE_SCHEMA_VERSION,
      entries: { ...file.entries },
    };
    delete next.entries[headSha];
    _atomicWriteJson(cachePath, next);
    return true;
  });
}

/**
 * Remove ALL entries from the cache. Returns the count of removed entries.
 */
export async function clearAll(baseDir: string): Promise<number> {
  const reaDir = path.join(baseDir, '.rea');
  const cachePath = path.join(reaDir, VERDICT_CACHE_FILE);
  if (!fs.existsSync(reaDir)) {
    fs.mkdirSync(reaDir, { recursive: true });
  }
  return withAuditLock(cachePath, async () => {
    const file = readCacheFile(baseDir);
    const count = file === undefined ? 0 : Object.keys(file.entries).length;
    const empty: VerdictCacheFile = {
      schema_version: VERDICT_CACHE_SCHEMA_VERSION,
      entries: {},
    };
    _atomicWriteJson(cachePath, empty);
    return count;
  });
}

/**
 * Remove entries whose `reviewed_at` is older than `olderThanMs` from `now`.
 * Returns the count of removed entries.
 */
export async function pruneOlderThan(
  baseDir: string,
  olderThanMs: number,
  now: Date = new Date(),
): Promise<number> {
  const cachePath = path.join(baseDir, '.rea', VERDICT_CACHE_FILE);
  return withAuditLock(cachePath, async () => {
    const file = readCacheFile(baseDir);
    if (file === undefined) return 0;
    const cutoff = now.getTime() - olderThanMs;
    const surviving: Record<string, VerdictCacheEntry> = {};
    let removed = 0;
    for (const [sha, entry] of Object.entries(file.entries)) {
      const reviewedAtMs = Date.parse(entry.reviewed_at);
      if (Number.isNaN(reviewedAtMs) || reviewedAtMs >= cutoff) {
        surviving[sha] = entry;
      } else {
        removed += 1;
      }
    }
    if (removed === 0) return 0;
    const next: VerdictCacheFile = {
      schema_version: VERDICT_CACHE_SCHEMA_VERSION,
      entries: surviving,
    };
    _atomicWriteJson(cachePath, next);
    return removed;
  });
}

/**
 * Read all entries (used by `rea cache stats` / `rea cache show`).
 * Returns empty object on any read error (missing file, malformed JSON,
 * unsupported schema_version).
 */
export function listEntries(baseDir: string): Record<string, VerdictCacheEntry> {
  const file = readCacheFile(baseDir);
  return file?.entries ?? {};
}

/**
 * Thrown by writeVerdict when the existing cache file has an
 * unrecognized schema_version. The caller (push-gate) catches this
 * and treats the write as best-effort failure (log to stderr,
 * continue) rather than overwriting forward-compat data.
 */
export class VerdictCacheForeignSchemaError extends Error {
  readonly kind = 'foreign-schema' as const;
  constructor(public readonly cachePath: string) {
    super(
      `Refused to overwrite ${cachePath}: existing cache has unrecognized schema_version. ` +
        `Either delete the file or run with a newer rea that supports it.`,
    );
    this.name = 'VerdictCacheForeignSchemaError';
  }
}

function readCacheFile(baseDir: string): VerdictCacheFile | undefined {
  const parsed = readForeignCacheFile(baseDir);
  if (parsed === undefined) return undefined;
  if (parsed.schema_version !== VERDICT_CACHE_SCHEMA_VERSION) return undefined;
  // We checked schema_version exactly; entries shape is the v2 contract.
  return parsed as VerdictCacheFile;
}

function readForeignCacheFile(baseDir: string): ForeignCacheFile | undefined {
  const cachePath = path.join(baseDir, '.rea', VERDICT_CACHE_FILE);
  if (!fs.existsSync(cachePath)) return undefined;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const sv = (parsed as { schema_version?: unknown }).schema_version;
    if (typeof sv !== 'number') return undefined;
    const entries = (parsed as { entries?: unknown }).entries;
    if (typeof entries !== 'object' || entries === null) return undefined;
    return parsed as ForeignCacheFile;
  } catch {
    return undefined;
  }
}

function foreignSchemaPresent(baseDir: string): boolean {
  const parsed = readForeignCacheFile(baseDir);
  if (parsed === undefined) return false;
  return parsed.schema_version !== VERDICT_CACHE_SCHEMA_VERSION;
}

/**
 * Atomic JSON write: stringify → write tmp → fsync → rename.
 *
 * Tmp filename: `${target}.tmp.${pid}.${ms}.${random8}` — collision-
 * resistant under concurrent writes, PID reuse, and same-process
 * parallel calls. On any failure, the tmp file is unlinked so a crash
 * mid-write doesn't leave stale state.
 */
function _atomicWriteJson(targetPath: string, payload: unknown): void {
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // Tmp already gone or unlink failed — caller's error is the
      // important signal.
    }
    throw e;
  }
}
