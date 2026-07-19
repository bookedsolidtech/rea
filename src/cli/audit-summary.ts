/**
 * `rea audit summary` — high-level audit-log overview (0.41.0).
 *
 * The audit log is rich and `rea audit specialists` already exists for
 * one narrow event-class. `rea audit summary` complements it with a
 * broad rollup: total events, counts by `tool_name`, by tier, by
 * session, by status, the time window covered, and a sample-verified
 * chain-integrity check.
 *
 * # Filtering
 *
 * `--since <duration>` accepts a compact duration string
 * (`s`/`m`/`h`/`d`/`w`) and filters records by `timestamp >= now -
 * duration`. Examples: `24h`, `7d`, `90m`, `2w`. This is DIFFERENT
 * from `rea audit verify --since <file>` / `rea audit specialists
 * --since <file>` which take a rotated-file ANCHOR, not a duration —
 * the two `--since` semantics serve different needs (anchor for chain
 * walks, duration for summarization) and we accept the surface area
 * cost. The duration form is what consumers reach for when asking
 * "what happened in the last day?".
 *
 * # Chain integrity
 *
 * `rea audit verify` does the rigorous per-record re-hash. `summary`
 * samples up to `CHAIN_SAMPLE_SIZE` records, evenly spaced through
 * the filtered window, and reports `ok` / `tampered` / `unsampled`
 * (window empty). Operators who suspect tampering should still run
 * `rea audit verify` for an authoritative answer.
 *
 * # JSON output
 *
 *     {
 *       "schema_version": 1,
 *       "window_seconds": 86400,
 *       "window_start": "2026-05-15T13:42:00Z",
 *       "window_end":   "2026-05-16T13:42:00Z",
 *       "files_scanned": ["/abs/path/.rea/audit.jsonl"],
 *       "total_events": 1247,
 *       "by_tool_name": { "Bash": 612, "Edit": 289, … },
 *       "by_tier":      { "read": 683, "write": 416, "destructive": 148 },
 *       "by_status":    { "allowed": 1242, "denied": 5, "error": 0 },
 *       "by_session":   { "session-abc…": 312, "session-def…": 935 },
 *       "session_count": 8,
 *       "earliest_timestamp": "2026-05-15T13:43:01.103Z",
 *       "latest_timestamp":   "2026-05-16T13:41:57.842Z",
 *       "chain_integrity": "ok",
 *       "chain_samples_verified": 12
 *     }
 *
 * # Walk scope
 *
 * v1 walks the current `.rea/audit.jsonl` plus EVERY rotated file
 * whose latest record falls within the window. Older rotated files
 * are skipped — they cannot contain in-window records. When `--since`
 * is omitted, no time filter is applied and the walk covers the
 * current `audit.jsonl` only (operators wanting historical depth
 * should pass `--since <DUR>`).
 */

import fs from 'node:fs/promises';
import { resolveReaRoots } from '../lib/worktree-roots.js';
import path from 'node:path';
import type { Command } from 'commander';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';
import { computeHash, GENESIS_HASH } from '../audit/fs.js';
import { listRotatedAuditFiles } from './audit-specialists.js';
import { AUDIT_FILE, REA_DIR, err, log } from './utils.js';

export const AUDIT_SUMMARY_SCHEMA_VERSION = 1;

/** Hard cap on chain-integrity samples. Keeps `rea audit summary`
 *  fast even on large logs while still surfacing obvious tampering. */
export const CHAIN_SAMPLE_SIZE = 12;

/**
 * Thrown by `computeAuditSummary` when `--since` cannot be parsed.
 * The commander wrapper exits 1.
 */
export class AuditSummarySinceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditSummarySinceError';
  }
}

/** Three-state classification for chain integrity. */
export type ChainIntegrity = 'ok' | 'tampered' | 'unsampled';

export interface AuditSummaryResult {
  schema_version: typeof AUDIT_SUMMARY_SCHEMA_VERSION;
  /** Window length in seconds. `null` when no `--since` filter was set. */
  window_seconds: number | null;
  /** Inclusive window start. `null` when no filter; otherwise the
   *  computed cutoff (now - duration). */
  window_start: string | null;
  /** Window end — always `now` when filter is set; `null` otherwise. */
  window_end: string | null;
  /** Absolute paths of audit files walked. */
  files_scanned: string[];
  /**
   * 0.42.0 codex round 4 P2 + round 6 P2 (2026-05-16) — reserved for
   * future use; ALWAYS EMPTY in 0.42.0. The original intent (round 4)
   * was to soft-skip rotated segments that the operator could not
   * read (e.g. EACCES/EPERM after a backup restore). Round 6 showed
   * the soft-skip was unsound: without per-segment time-range
   * metadata we cannot prove a skipped file is out-of-scope for the
   * `--since` window, so a silent skip risks an undercount + a
   * misleading `chain_integrity: ok`. The current implementation
   * therefore throws on any non-ENOENT read error; this field is
   * kept in the public schema so a future release that ships
   * per-segment time-range metadata can populate it without breaking
   * JSON consumers.
   */
  unreadable_segments: string[];
  total_events: number;
  by_tool_name: Record<string, number>;
  by_tier: Record<string, number>;
  by_status: Record<string, number>;
  by_session: Record<string, number>;
  session_count: number;
  /** Earliest in-window `timestamp` seen. `null` when no records. */
  earliest_timestamp: string | null;
  /** Latest in-window `timestamp` seen. `null` when no records. */
  latest_timestamp: string | null;
  chain_integrity: ChainIntegrity;
  /** Number of samples actually verified. Always `<= CHAIN_SAMPLE_SIZE`. */
  chain_samples_verified: number;
}

export interface ComputeAuditSummaryOptions {
  /** Override CWD. Tests set this; production uses `process.cwd()`. */
  baseDir?: string;
  /** Raw `--since` value (e.g. `24h`, `7d`). Parsed via parseDuration. */
  since?: string;
  /** Test seam — pin "now" for deterministic window calculations. */
  now?: Date;
}

/**
 * Parse a compact duration string into seconds. Accepts:
 *
 *   - `<N>s` — seconds
 *   - `<N>m` — minutes
 *   - `<N>h` — hours
 *   - `<N>d` — days
 *   - `<N>w` — weeks (7 days)
 *
 * `N` must be a positive integer with no whitespace. Returns the
 * number of seconds; throws `AuditSummarySinceError` on parse failure.
 *
 * We deliberately do not accept bare numbers (would be ambiguous) or
 * fractional units (no real use case; complicates rendering).
 */
export function parseDurationSeconds(raw: string): number {
  const m = /^(\d+)(s|m|h|d|w)$/i.exec(raw.trim());
  if (m === null) {
    throw new AuditSummarySinceError(
      `--since: cannot parse ${JSON.stringify(raw)}. ` +
        `Expected <N><unit> where unit is s|m|h|d|w (e.g. 24h, 7d, 90m).`,
    );
  }
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AuditSummarySinceError(
      `--since: duration must be a positive integer; got ${JSON.stringify(raw)}.`,
    );
  }
  const unit = m[2]!.toLowerCase();
  const factor: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 60 * 60 * 24,
    w: 60 * 60 * 24 * 7,
  };
  return n * factor[unit]!;
}

/**
 * Resolve the audit files to walk. Always includes the current
 * `audit.jsonl` (when it exists).
 *
 *   - `windowStart === null` (no `--since`): walk EVERY rotated file
 *     PLUS the current `audit.jsonl`. Round-1 P2: the prior shape
 *     dropped rotated history silently while the header still
 *     advertised "all time", undercounting long-lived repos.
 *   - `windowStart` set: walk EVERY rotated file. The per-record
 *     timestamp filter inside `computeAuditSummary` then drops
 *     out-of-window records during the scan. 0.41.0 round-3 P2 +
 *     0.42.0 charter item 3: rotated filenames are NOT authoritative
 *     for "earliest contained record" — they are wall-clock at the
 *     ROTATION INSTANT, which can be days after the file's earliest
 *     contents when the rotation size cap is reached late. Pruning
 *     by filename therefore drops in-window records from
 *     conservatively-rotated logs (a rotated file from 7 days ago can
 *     still contain records from 14 days ago because the previous
 *     rotation event was 14 days ago). The cost of walking every
 *     rotated segment under `--since` is bounded by the rotation cap
 *     × number of segments — comfortably manageable in the
 *     summary-rollup setting where we already read every byte for
 *     the in-window scan; the win is correctness.
 *
 * Sort order is timestamp-ascending (by FILENAME stamp); the current
 * `audit.jsonl` is always appended last (it is the newest segment
 * of the chain).
 */
async function resolveSummaryFileWalk(
  baseDir: string,
  windowStart: Date | null,
): Promise<string[]> {
  const reaDir = path.join(baseDir, REA_DIR);
  const currentAudit = path.join(reaDir, AUDIT_FILE);
  const files: string[] = [];

  const rotated = await listRotatedAuditFiles(reaDir);
  // Both `windowStart === null` and `windowStart` set: walk every
  // rotated segment. Pre-0.42.0 the `windowStart` branch attempted to
  // prune rotated files by their filename stamp ("rotated at >=
  // windowStart minus one buffer file"). That was wrong: the filename
  // stamp marks the ROTATION event, not the earliest record contained
  // in the file. A rotated file's records can pre-date its filename
  // stamp by days when the previous rotation cycle was long. Walking
  // every rotated file and letting the per-record `timestamp >=
  // windowStart` filter inside `computeAuditSummary` decide is the
  // only correct approach: we never falsely drop an in-window record
  // because of where it happens to live on disk. Reference:
  // 0.41.0 round-3 P2 + 0.42.0 charter item 3.
  //
  // `windowStart === null` (no --since) already walks every rotated
  // segment — same code path.
  void windowStart; // intentionally unused — full-walk is correct in both modes
  for (const name of rotated) files.push(path.join(reaDir, name));
  try {
    const stat = await fs.stat(currentAudit);
    if (stat.isFile()) files.push(currentAudit);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return files;
}

/** Map a rea Tier value (or unknown) to a stable bucket key for the
 *  by_tier table. Unknown values bucket to `'unknown'` so the rollup
 *  surfaces them rather than silently dropping.
 */
function tierBucket(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  return value;
}

function statusBucket(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  return value;
}

/**
 * Parse an ISO-8601 timestamp into a Date. Returns `null` on failure.
 */
function parseTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Sample-verify per-record hash integrity across the IN-WINDOW
 * records only. Returns `ok`, `tampered`, or `unsampled` (no
 * records in window).
 *
 * Sampling: take indices at offsets 0, n/k, 2n/k, …, (k-1)n/k where
 * n is the in-window count and k is `CHAIN_SAMPLE_SIZE`. Always
 * sample the first and last record.
 *
 * Codex round-2 P1: we do NOT verify `prev_hash` linkage between
 * adjacent records in the filtered list. `appendAuditRecord` accepts
 * caller-supplied timestamps, so a valid chain can look like
 * `in-window → out-of-window → in-window`; in that case the second
 * in-window record's `prev_hash` points to the filtered-out entry,
 * not the previous survivor in our filtered view, and a linkage
 * check would false-positive `tampered` on a healthy log. The
 * authoritative chain walk lives in `rea audit verify`; summary
 * stays advisory.
 */
function sampleChainIntegrity(
  records: AuditRecord[],
): { result: ChainIntegrity; samplesVerified: number } {
  if (records.length === 0) return { result: 'unsampled', samplesVerified: 0 };

  const sampleIndices = new Set<number>();
  const k = Math.min(CHAIN_SAMPLE_SIZE, records.length);
  for (let i = 0; i < k; i += 1) {
    const idx = Math.floor((i * records.length) / k);
    sampleIndices.add(idx);
  }
  sampleIndices.add(records.length - 1);

  let samplesVerified = 0;
  for (const i of sampleIndices) {
    const r = records[i]!;
    const { hash, ...rest } = r;
    const recomputed = computeHash(rest);
    if (recomputed !== hash) {
      return { result: 'tampered', samplesVerified };
    }
    samplesVerified += 1;
  }
  return { result: 'ok', samplesVerified };
}

/**
 * Compute the summary. Pure (read-only). Throws
 * `AuditSummarySinceError` on bad `--since`; everything else is
 * surfaced via the result.
 */
export async function computeAuditSummary(
  options: ComputeAuditSummaryOptions = {},
): Promise<AuditSummaryResult> {
  // 0.54.0 worktree state: the audit chain is per-REPOSITORY — read
  // it from the common root so `rea audit *` in a worktree sees the
  // shared chain. Degenerate in plain checkouts.
  const baseDir = options.baseDir ?? resolveReaRoots(process.cwd()).commonRoot;
  const now = options.now ?? new Date();
  let windowSeconds: number | null = null;
  let windowStart: Date | null = null;
  let windowEnd: Date | null = null;
  if (options.since !== undefined && options.since.length > 0) {
    windowSeconds = parseDurationSeconds(options.since);
    windowEnd = now;
    windowStart = new Date(now.getTime() - windowSeconds * 1000);
  }

  const files = await resolveSummaryFileWalk(baseDir, windowStart);

  const byToolName: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const bySession: Record<string, number> = {};
  let totalEvents = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  // We only feed in-window records to the chain-sample check.
  const inWindowRecords: AuditRecord[] = [];
  // 0.42.0 codex round 4 P2 + round 6 P2 (2026-05-16): reserved for
  // future per-segment time-range metadata that would let us prove a
  // skipped file is out of scope. Always empty under 0.42.0 — see
  // the AuditSummaryResult.unreadable_segments docstring.
  const unreadableSegments: string[] = [];
  // We rebuild the actually-read file list as we go so the summary
  // never claims to have scanned a file that was silently skipped.
  // (Currently identical to `files` minus ENOENT entries since every
  // other read error throws — kept as a separate accumulator so the
  // shape stays correct when the future `unreadable_segments`
  // soft-skip path lands.)
  const actuallyScanned: string[] = [];

  for (const filePath of files) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') continue;
      // 0.42.0 codex round 4 P2 + round 5 P2 + round 6 P2 (2026-05-16):
      // earlier rounds attempted to soft-skip unreadable rotations to
      // accommodate backup-restore artifacts. Round 6 caught that the
      // soft-skip is unsound: `resolveSummaryFileWalk` now enqueues
      // every rotated segment under `--since` (filename-stamp pruning
      // was correctly removed because the stamp marks the rotation
      // event, not the earliest record contained), so we CANNOT prove
      // an unreadable file is out of scope without reading it. A
      // silent skip would mean `rea audit summary` could exit 0 with
      // an undercount AND `chain_integrity: ok` while real in-window
      // records went uncounted.
      //
      // Throwing with a precise, actionable error is the right call:
      // the operator can chmod the file, move it out of .rea/, or
      // delete it. `unreadable_segments` in the result is reserved
      // for the never-reached future case where we can prove a file
      // is genuinely out of scope (we'd need rotation start/end
      // metadata for that — out of scope here).
      throw new Error(
        `rea audit summary: cannot read ${filePath} (${errno ?? 'unknown errno'}). ` +
          `An unreadable audit segment may contain in-window records, so the summary ` +
          `would be silently incomplete. Fix permissions (e.g. \`chmod u+r ${filePath}\`), ` +
          `or move the file out of \`.rea/\` if you no longer need it. The current ` +
          `audit.jsonl is always required.`,
      );
    }
    actuallyScanned.push(filePath);
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let parsed: AuditRecord;
      try {
        parsed = JSON.parse(line) as AuditRecord;
      } catch {
        // Malformed line — `rea audit verify` is the tool for that.
        // Summary just skips and moves on.
        continue;
      }
      const ts = parseTimestamp(parsed.timestamp);
      if (windowStart !== null && (ts === null || ts < windowStart)) continue;
      // upper bound is `now`; future-dated records (skew, replay) are
      // still counted — they're real records that landed in the file.
      totalEvents += 1;
      const toolName =
        typeof parsed.tool_name === 'string' && parsed.tool_name.length > 0
          ? parsed.tool_name
          : '(unknown)';
      byToolName[toolName] = (byToolName[toolName] ?? 0) + 1;
      const tier = tierBucket(parsed.tier);
      byTier[tier] = (byTier[tier] ?? 0) + 1;
      const status = statusBucket(parsed.status);
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      const session =
        typeof parsed.session_id === 'string' && parsed.session_id.length > 0
          ? parsed.session_id
          : '(unknown)';
      bySession[session] = (bySession[session] ?? 0) + 1;

      const tsRaw = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
      if (tsRaw !== null) {
        if (earliest === null || tsRaw < earliest) earliest = tsRaw;
        if (latest === null || tsRaw > latest) latest = tsRaw;
      }
      inWindowRecords.push(parsed);
    }
  }

  const { result: chainIntegrity, samplesVerified } = sampleChainIntegrity(inWindowRecords);

  // Suppress unused-variable warning for genesis hash by referencing
  // it: the chain-sample check uses it implicitly via the relaxed
  // first-record rule. Kept as an import-time anchor for the linkage
  // contract documented in `sampleChainIntegrity`.
  void GENESIS_HASH;

  return {
    schema_version: AUDIT_SUMMARY_SCHEMA_VERSION,
    window_seconds: windowSeconds,
    window_start: windowStart !== null ? windowStart.toISOString() : null,
    window_end: windowEnd !== null ? windowEnd.toISOString() : null,
    // 0.42.0 codex round 4 P2: report only the files actually read.
    // Unreadable rotations are reported separately under
    // `unreadable_segments` so consumers can tell the difference
    // between "scanned and empty" and "skipped because permissions".
    files_scanned: actuallyScanned,
    unreadable_segments: unreadableSegments,
    total_events: totalEvents,
    by_tool_name: byToolName,
    by_tier: byTier,
    by_status: byStatus,
    by_session: bySession,
    session_count: Object.keys(bySession).length,
    earliest_timestamp: earliest,
    latest_timestamp: latest,
    chain_integrity: chainIntegrity,
    chain_samples_verified: samplesVerified,
  };
}

interface BucketDescriptor {
  /** Header label. */
  title: string;
  /** Pre-sorted (desc by count) list of `[name, count]`. */
  entries: Array<[string, number]>;
  /** Optional cap on entries shown — extras roll into an `(other)` row. */
  limit?: number;
}

function sortBucket(bucket: Record<string, number>): Array<[string, number]> {
  return Object.entries(bucket).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
}

function renderBucket(d: BucketDescriptor, total: number): string {
  const lines: string[] = [];
  lines.push(`${d.title}:`);
  const visible = d.limit !== undefined ? d.entries.slice(0, d.limit) : d.entries;
  const overflow = d.limit !== undefined ? d.entries.slice(d.limit) : [];
  const maxNameLen = visible.reduce((m, [n]) => Math.max(m, n.length), 0);
  for (const [name, count] of visible) {
    const pad = ' '.repeat(maxNameLen - name.length + 2);
    const pct =
      total > 0 ? ` (${((count * 100) / total).toFixed(1)}%)` : '';
    lines.push(`  ${name}${pad}${String(count).padStart(6)}${pct}`);
  }
  if (overflow.length > 0) {
    const overflowSum = overflow.reduce((s, [, n]) => s + n, 0);
    const pad = ' '.repeat(Math.max(0, maxNameLen - 7) + 2);
    const pct =
      total > 0 ? ` (${((overflowSum * 100) / total).toFixed(1)}%)` : '';
    lines.push(`  (other)${pad}${String(overflowSum).padStart(6)}${pct}`);
  }
  return lines.join('\n');
}

/**
 * Render the result as a human-readable terminal block. Designed for
 * the default `rea audit summary` invocation; `--json` callers bypass
 * this entirely.
 */
export function renderAuditSummary(result: AuditSummaryResult): string {
  const lines: string[] = [];
  const windowLabel =
    result.window_seconds !== null ? formatDurationShort(result.window_seconds) : 'all time';
  lines.push(`rea audit summary (${windowLabel})`);
  lines.push('─'.repeat(40));
  lines.push(`total events:       ${String(result.total_events).padStart(6)}`);
  lines.push(`sessions:           ${String(result.session_count).padStart(6)}`);
  if (result.session_count > 0) {
    const avg = result.total_events / result.session_count;
    lines.push(`events/session avg: ${avg.toFixed(1).padStart(6)}`);
  }
  lines.push('');
  if (result.total_events === 0) {
    lines.push(
      result.window_seconds !== null
        ? 'No events in the requested window.'
        : 'No events in the audit log.',
    );
    lines.push('');
    if (result.files_scanned.length === 0) {
      lines.push('(no audit files found — has `rea serve` ever run?)');
      lines.push('');
    }
    // 0.42.0 codex round 4 P2: even in the zero-events early-return,
    // surface unreadable segments so the operator sees the gap.
    if (result.unreadable_segments.length > 0) {
      lines.push(
        `unreadable rotated segments: ${String(result.unreadable_segments.length)} ` +
          `(see stderr for paths; fix permissions and re-run to include them)`,
      );
      lines.push('');
    }
    return lines.join('\n');
  }
  const total = result.total_events;
  lines.push(
    renderBucket(
      { title: 'by tool_name', entries: sortBucket(result.by_tool_name), limit: 12 },
      total,
    ),
  );
  lines.push('');
  lines.push(renderBucket({ title: 'by tier', entries: sortBucket(result.by_tier) }, total));
  lines.push('');
  lines.push(
    renderBucket({ title: 'by status', entries: sortBucket(result.by_status) }, total),
  );
  lines.push('');
  // Sessions can balloon — limit to 5 by default.
  lines.push(
    renderBucket(
      { title: 'top sessions', entries: sortBucket(result.by_session), limit: 5 },
      total,
    ),
  );
  lines.push('');
  if (result.earliest_timestamp !== null && result.latest_timestamp !== null) {
    lines.push(`window: ${result.earliest_timestamp} → ${result.latest_timestamp}`);
  }
  const chainLabel =
    result.chain_integrity === 'ok'
      ? `ok (${String(result.chain_samples_verified)} sample${result.chain_samples_verified === 1 ? '' : 's'} verified)`
      : result.chain_integrity === 'tampered'
        ? 'TAMPERED — run `rea audit verify` for the exact break'
        : 'unsampled (no records in window)';
  lines.push(`chain integrity: ${chainLabel}`);
  lines.push(`files scanned:   ${String(result.files_scanned.length)}`);
  // 0.42.0 codex round 4 P2 (2026-05-16): surface unreadable rotated
  // segments so an operator scanning the rendered summary doesn't
  // miss a skipped archive that the JSON consumers can see.
  if (result.unreadable_segments.length > 0) {
    lines.push(
      `unreadable rotated segments: ${String(result.unreadable_segments.length)} ` +
        `(see stderr for paths; fix permissions and re-run to include them)`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Compact human duration label for the header. `86400` → `last 24h`,
 * `604800` → `last 7d`, etc. We pick the coarsest single unit that
 * yields an integer; otherwise fall back to seconds.
 */
function formatDurationShort(seconds: number): string {
  const units: Array<[string, number]> = [
    ['w', 60 * 60 * 24 * 7],
    ['d', 60 * 60 * 24],
    ['h', 60 * 60],
    ['m', 60],
    ['s', 1],
  ];
  for (const [unit, factor] of units) {
    if (seconds % factor === 0) {
      return `last ${String(seconds / factor)}${unit}`;
    }
  }
  return `last ${String(seconds)}s`;
}

export interface RunAuditSummaryOptions {
  since?: string;
  json?: boolean;
  /** Test seam — pin "now". */
  now?: Date;
}

/** Commander entrypoint. */
export async function runAuditSummary(options: RunAuditSummaryOptions): Promise<void> {
  let result: AuditSummaryResult;
  try {
    result = await computeAuditSummary({
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  } catch (e) {
    if (e instanceof AuditSummarySinceError) {
      err(`rea audit summary: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  if (options.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderAuditSummary(result));
  if (result.chain_integrity === 'tampered') {
    // Non-zero exit gives CI users a single signal for "something is
    // off"; the JSON path stays exit 0 so machine consumers can react
    // to the integrity field directly.
    log('summary complete with tampered chain — see message above.');
    process.exit(1);
  }
}

/**
 * Register `rea audit summary` under the `audit` command group.
 */
export function registerAuditSummaryCommand(auditCommand: Command): void {
  auditCommand
    .command('summary')
    .description(
      'High-level audit-log summary — counts by tool_name, tier, session, status; window timestamps; sample-verified chain integrity. Read-only.',
    )
    .option(
      '--since <duration>',
      'Filter to records within the last <duration>. Compact form: <N><unit> where unit is s|m|h|d|w (e.g. 24h, 7d). Distinct from `rea audit verify --since <file>` which anchors on a rotated file.',
    )
    .option('--json', 'emit a JSON document instead of the human-readable table')
    .action(async (opts: { since?: string; json?: boolean }) => {
      await runAuditSummary({
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.json === true ? { json: true } : {}),
      });
    });
}
