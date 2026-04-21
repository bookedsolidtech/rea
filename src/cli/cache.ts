/**
 * `rea cache` — push-review cache operator subcommands (BUG-009).
 *
 * Four verbs:
 *   - `check <sha> --branch <b> --base <b>` — JSON to stdout ONLY; never
 *     diagnostics. `hooks/push-review-gate.sh` reads this via
 *     `printf '%s' "$CACHE_RESULT" | jq -e '.hit == true'`, so any stray
 *     text on stdout would poison the hook's JSON parse.
 *   - `set <sha> pass|fail --branch <b> --base <b> [--reason <s>]` — record
 *     a review outcome.
 *   - `clear <sha>` — drop every entry for a sha (dev convenience).
 *   - `list [--branch <b>]` — pretty-print entries.
 *
 * The TTL used by `check` reads `review.cache_max_age_seconds` from
 * `.rea/policy.yaml` when present, falling back to
 * {@link DEFAULT_CACHE_MAX_AGE_SECONDS} (1 hour) when the policy file or
 * field is absent. An unreadable/malformed policy file is NOT fatal for
 * `check` — it degrades to the default so a broken policy never deadlocks
 * the push gate; other commands that don't consume the TTL ignore the policy
 * entirely.
 */

import { loadPolicy } from '../policy/loader.js';
import {
  DEFAULT_CACHE_MAX_AGE_SECONDS,
  appendEntry,
  clear as clearEntries,
  list as listEntries,
  lookup,
  type CacheResult,
} from '../cache/review-cache.js';
import type { CodexVerdict } from '../audit/codex-event.js';
import { err, log } from './utils.js';

export interface CacheCheckOptions {
  sha: string;
  branch: string;
  base: string;
}

export interface CacheSetOptions {
  sha: string;
  result: CacheResult;
  branch: string;
  base: string;
  reason?: string;
}

export interface CacheClearOptions {
  sha: string;
}

export interface CacheListOptions {
  branch?: string;
}

function resolveMaxAgeSeconds(baseDir: string): number {
  try {
    const policy = loadPolicy(baseDir);
    const configured = policy.review?.cache_max_age_seconds;
    if (typeof configured === 'number' && configured > 0) return configured;
    return DEFAULT_CACHE_MAX_AGE_SECONDS;
  } catch {
    // Missing or malformed policy must not block the push gate — degrade to
    // the default. `rea doctor` is the canonical surface for flagging a
    // broken policy file; the cache is not the place to re-diagnose it.
    return DEFAULT_CACHE_MAX_AGE_SECONDS;
  }
}

/**
 * Print the cache-check JSON to stdout. Hook contract: stdout is ONLY JSON.
 * On a miss we still exit 0 with `{"hit":false}` — the hook interprets
 * non-zero as "rea broken, force re-review" via its `|| echo '{"hit":false}'`
 * fallback.
 */
export async function runCacheCheck(options: CacheCheckOptions): Promise<void> {
  const baseDir = process.cwd();
  const maxAgeSeconds = resolveMaxAgeSeconds(baseDir);
  const result = await lookup(baseDir, {
    sha: options.sha,
    branch: options.branch,
    base: options.base,
    maxAgeSeconds,
  });

  if (result.hit && result.entry !== undefined) {
    const payload = {
      hit: true,
      result: result.entry.result,
      branch: result.entry.branch,
      base: result.entry.base,
      recorded_at: result.entry.recorded_at,
      ...(result.entry.reason !== undefined ? { reason: result.entry.reason } : {}),
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ hit: false }) + '\n');
}

export async function runCacheSet(options: CacheSetOptions): Promise<void> {
  const baseDir = process.cwd();
  const entry = await appendEntry(baseDir, {
    sha: options.sha,
    branch: options.branch,
    base: options.base,
    result: options.result,
    ...(options.reason !== undefined && options.reason.length > 0
      ? { reason: options.reason }
      : {}),
  });
  log(
    `Recorded ${entry.result} for ${entry.sha.slice(0, 12)} (${entry.branch} → ${entry.base}).`,
  );
}

export async function runCacheClear(options: CacheClearOptions): Promise<void> {
  const baseDir = process.cwd();
  const removed = await clearEntries(baseDir, options.sha);
  if (removed === 0) {
    log(`No entries found for ${options.sha.slice(0, 12)}.`);
    return;
  }
  log(`Cleared ${removed} entr${removed === 1 ? 'y' : 'ies'} for ${options.sha.slice(0, 12)}.`);
}

export async function runCacheList(options: CacheListOptions): Promise<void> {
  const baseDir = process.cwd();
  const entries = await listEntries(baseDir, {
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
  });
  if (entries.length === 0) {
    log('No review-cache entries.');
    return;
  }
  for (const e of entries) {
    const shortSha = e.sha.slice(0, 12);
    const reason = e.reason !== undefined ? `  — ${e.reason}` : '';
    console.log(
      `${e.recorded_at}  ${e.result.padEnd(4)}  ${shortSha}  ${e.branch} → ${e.base}${reason}`,
    );
  }
}

/** Parse-and-validate helper for `set` — surfaces a clean error on bad input.
 *
 * Accepts the two historical cache values (`pass`, `fail`) AND the four
 * canonical Codex verdicts (`pass`, `concerns`, `blocking`, `error`) per
 * Defect D (rea#77). Codex verdicts are mapped to cache semantics at the CLI
 * boundary: `pass|concerns` → gate-satisfying `pass`; `blocking|error` →
 * gate-failing `fail`. The cache internal vocabulary stays binary
 * (`pass`/`fail` = "gate-satisfying?") while the CLI accepts the full Codex
 * vocabulary so agents can copy the `/codex-review` verdict verbatim.
 */
export function parseCacheResult(raw: string): CacheResult {
  if (raw === 'pass' || raw === 'fail') return raw;
  if (raw === 'concerns') return 'pass';
  if (raw === 'blocking' || raw === 'error') return 'fail';
  err(
    `result must be 'pass', 'fail', 'concerns', 'blocking', or 'error'; got ${JSON.stringify(
      raw,
    )}`,
  );
  process.exit(1);
}

/** Shape returned by {@link codexVerdictToCacheResult}: the binary cache result
 * plus an optional machine-readable `reason` string that records the source
 * Codex verdict. `reason` is populated for non-`pass` verdicts so downstream
 * listings expose WHY a cache fail was recorded. */
export interface CodexVerdictCacheEffect {
  result: CacheResult;
  reason?: string | undefined;
}

/** Map a Codex verdict to the binary cache result the gate compares against.
 *
 * Mapping rationale:
 *   - `pass` → cache `pass` (clean review, gate should pass)
 *   - `concerns` → cache `pass` (non-blocking findings, gate should pass;
 *     reviewer captured concerns in the audit record `metadata.summary`)
 *   - `blocking` → cache `fail` (must address findings before merge)
 *   - `error` → cache `fail` (Codex itself errored; no clean-bill-of-health)
 *
 * Kept separate from `parseCacheResult` so callers that already have a typed
 * `CodexVerdict` (e.g. `rea audit record codex-review --also-set-cache`) don't
 * round-trip through string parsing.
 */
export function codexVerdictToCacheResult(verdict: CodexVerdict): CodexVerdictCacheEffect {
  switch (verdict) {
    case 'pass':
      return { result: 'pass' };
    case 'concerns':
      return { result: 'pass', reason: 'codex:concerns' };
    case 'blocking':
      return { result: 'fail', reason: 'codex:blocking' };
    case 'error':
      return { result: 'fail', reason: 'codex:error' };
  }
}
