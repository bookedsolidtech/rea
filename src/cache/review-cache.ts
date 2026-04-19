/**
 * Review cache (BUG-009). The push-review-gate hook (`hooks/push-review-gate.sh`)
 * has shipped since 0.3.x calling `rea cache check <sha>` to skip re-review on
 * a previously-approved diff, and `rea cache set <sha> pass ...` as the
 * operator's advertised way to complete the gate. Neither subcommand existed
 * in the CLI through 0.4.0. Once BUG-008's pre-push stdin adapter lands and
 * the gate actually fires, a protected-path push has no completion path
 * without this cache — hence "paired ship blocker."
 *
 * ## File layout
 *
 * `.rea/review-cache.jsonl` — one JSON object per line, terminated with `\n`.
 * Each entry:
 *
 *   {
 *     "sha": "<diff-sha256>",
 *     "branch": "<feature-branch>",
 *     "base": "<target-branch>",
 *     "result": "pass" | "fail",
 *     "recorded_at": "<ISO-8601>",
 *     "reason"?: "<free text>"   // optional, populated on fail or on skip
 *   }
 *
 * The `sha` is whatever the caller supplies — the hook happens to use a
 * SHA-256 of the full diff, but the cache does not interpret or validate the
 * value. Hash-chained is intentionally NOT required: this is a keyed cache,
 * not an append-only integrity log. The audit log at `.rea/audit.jsonl`
 * remains the integrity story.
 *
 * ## Concurrency
 *
 * Every write takes the same `proper-lockfile` lock on the `.rea/` parent
 * directory that the audit helpers use (`withAuditLock`). This means a
 * concurrent audit append and cache write serialize against each other — a
 * negligible cost given cache writes happen once per push gate completion.
 *
 * ## Idempotency
 *
 * `appendEntry` writes a new line unconditionally. `lookup` returns the most
 * recent entry matching `(sha, branch, base)`. This "last write wins" keeps
 * the write path O(1) and the read path O(n) over the file; n is bounded by
 * typical review frequency (dozens per week, not millions). If a future
 * operator needs a compact file, `rea cache clear <sha>` drops matching
 * entries and a separate `rea cache compact` (not in 0.5.0) could rewrite.
 *
 * ## TTL
 *
 * `lookup` honors `review.cache_max_age_seconds` (default 3600). Entries
 * older than the window are treated as a miss. Expired entries are not
 * garbage-collected on read — `rea cache clear` or `rea cache compact`
 * is the operator tool for shrinking.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { withAuditLock } from '../audit/fs.js';

/** Default TTL when policy does not supply one. */
export const DEFAULT_CACHE_MAX_AGE_SECONDS = 3600;

/**
 * Tolerated clock skew for future-dated entries. A `recorded_at` more than
 * this far in the future relative to `nowMs` is treated as tampered or
 * severely-drifted and forces a miss (re-review). 60s covers NTP jitter on
 * well-synced hosts; anything beyond that is noise we do not trust.
 */
const FUTURE_SKEW_ALLOWANCE_MS = 60_000;

export type CacheResult = 'pass' | 'fail';

export interface CacheEntry {
  sha: string;
  branch: string;
  base: string;
  result: CacheResult;
  recorded_at: string;
  reason?: string;
}

export interface CacheLookupInput {
  sha: string;
  branch: string;
  base: string;
  /** Epoch ms used as the "now" reference for TTL comparison. Defaults to `Date.now()`. */
  nowMs?: number;
  /** TTL in seconds; defaults to {@link DEFAULT_CACHE_MAX_AGE_SECONDS}. */
  maxAgeSeconds?: number;
}

export interface CacheLookupResult {
  hit: boolean;
  entry?: CacheEntry;
  /** Reason for a miss. One of `'no-entry' | 'expired' | 'empty-file'`. Always set when `hit === false`. */
  missReason?: 'no-entry' | 'expired' | 'empty-file';
}

export interface CacheAppendInput {
  sha: string;
  branch: string;
  base: string;
  result: CacheResult;
  reason?: string;
  /** ISO-8601 timestamp. Defaults to `new Date().toISOString()`. */
  timestamp?: string;
}

const CACHE_FILENAME = 'review-cache.jsonl';
const REA_DIRNAME = '.rea';

export function resolveCacheFile(baseDir: string): string {
  return path.join(baseDir, REA_DIRNAME, CACHE_FILENAME);
}

/**
 * Load every entry from the cache file. Returns `[]` when the file does not
 * exist or is empty. Malformed lines are skipped — we never throw on a
 * corrupt line, because the cache is advisory and a bad write (e.g. a
 * half-written line from a crashed host) must not block a subsequent push.
 */
async function loadEntries(cacheFile: string): Promise<CacheEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(cacheFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (raw.length === 0) return [];
  const entries: CacheEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<CacheEntry>;
      if (
        typeof parsed.sha === 'string' &&
        typeof parsed.branch === 'string' &&
        typeof parsed.base === 'string' &&
        (parsed.result === 'pass' || parsed.result === 'fail') &&
        typeof parsed.recorded_at === 'string'
      ) {
        entries.push(parsed as CacheEntry);
      }
    } catch {
      // Skip malformed line.
    }
  }
  return entries;
}

/**
 * Append an entry to the cache. Writes are serialized through the shared
 * `.rea/` directory lock so audit writes and cache writes do not interleave.
 */
export async function appendEntry(
  baseDir: string,
  input: CacheAppendInput,
): Promise<CacheEntry> {
  const cacheFile = resolveCacheFile(baseDir);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });

  const entry: CacheEntry = {
    sha: input.sha,
    branch: input.branch,
    base: input.base,
    result: input.result,
    recorded_at: input.timestamp ?? new Date().toISOString(),
    ...(input.reason !== undefined && input.reason.length > 0
      ? { reason: input.reason }
      : {}),
  };

  await withAuditLock(cacheFile, async () => {
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(cacheFile, line);
  });

  return entry;
}

/**
 * Find the most-recent entry matching `(sha, branch, base)` within the TTL
 * window. Idempotent and side-effect free.
 */
export async function lookup(
  baseDir: string,
  input: CacheLookupInput,
): Promise<CacheLookupResult> {
  const cacheFile = resolveCacheFile(baseDir);
  const entries = await loadEntries(cacheFile);
  if (entries.length === 0) return { hit: false, missReason: 'empty-file' };

  // Walk from the tail so the first match is the newest.
  let matched: CacheEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.sha === input.sha && e.branch === input.branch && e.base === input.base) {
      matched = e;
      break;
    }
  }
  if (matched === undefined) return { hit: false, missReason: 'no-entry' };

  const nowMs = input.nowMs ?? Date.now();
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_CACHE_MAX_AGE_SECONDS;
  const recordedMs = Date.parse(matched.recorded_at);
  if (Number.isNaN(recordedMs)) {
    // Corrupt timestamp — treat as an expired miss so the caller re-reviews.
    return { hit: false, missReason: 'expired', entry: matched };
  }
  if (recordedMs > nowMs + FUTURE_SKEW_ALLOWANCE_MS) {
    return { hit: false, missReason: 'expired', entry: matched };
  }
  if ((nowMs - recordedMs) / 1000 > maxAgeSeconds) {
    return { hit: false, missReason: 'expired', entry: matched };
  }
  return { hit: true, entry: matched };
}

/**
 * Remove every entry matching `sha`. Returns the count removed. A `0` return
 * is a valid outcome (sha not present). Writes back via the same lock as
 * `appendEntry`, so concurrent sets do not lose entries.
 *
 * Writes use temp-file + `fs.rename` (atomic within a single directory on
 * POSIX) so unlocked readers (`lookup`, `list`) can never observe a torn or
 * empty intermediate state. Codex F4 on the 0.5.0 PR1 review.
 */
export async function clear(baseDir: string, sha: string): Promise<number> {
  const cacheFile = resolveCacheFile(baseDir);
  return withAuditLock(cacheFile, async () => {
    const entries = await loadEntries(cacheFile);
    const kept = entries.filter((e) => e.sha !== sha);
    const removed = entries.length - kept.length;
    if (removed === 0) return 0;
    const out =
      kept.length === 0 ? '' : kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const tmpFile = `${cacheFile}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmpFile, out);
    await fs.rename(tmpFile, cacheFile);
    return removed;
  });
}

/**
 * Return every entry, optionally filtered by branch. Entries are returned in
 * file order (oldest first). Callers that want "newest first" should reverse.
 */
export async function list(
  baseDir: string,
  options: { branch?: string } = {},
): Promise<CacheEntry[]> {
  const cacheFile = resolveCacheFile(baseDir);
  const entries = await loadEntries(cacheFile);
  if (options.branch === undefined) return entries;
  return entries.filter((e) => e.branch === options.branch);
}
