/**
 * `rea audit timeline [--bucket=HOUR|DAY|<DUR>] [--since=DUR] [--json]`
 * — 0.46.0 charter item 2.
 *
 * Time-bucketed event counts over the audit log. Useful for spotting
 * activity spikes ("what happened during the 3pm CI build?") and
 * day/week cadence patterns.
 *
 * # Bucket sizes
 *
 *   - `HOUR` (default) — bucket boundaries align to the UTC hour
 *     (`HH:00:00.000Z`)
 *   - `DAY` — bucket boundaries align to the UTC day
 *     (`YYYY-MM-DDT00:00:00.000Z`)
 *   - `<DUR>` (`15m`, `30m`, `1h`, `2h`, `1d`, etc) — arbitrary
 *     duration. Boundaries align to the UTC epoch (multiples of the
 *     bucket size from `1970-01-01T00:00:00Z`). The `<DUR>` form is
 *     useful for sub-hour cadence (`--bucket=15m`) or unusual cuts
 *     (`--bucket=6h` for "morning / afternoon / evening / night").
 *
 * Bucket boundaries are half-open `[start, end)` so a record at
 * `15:00:00.000Z` lands in the `15:00 → 16:00` bucket, not the
 * `14:00 → 15:00` one.
 *
 * # Window
 *
 *   - `--since=DUR` with same shape as `audit summary` / `audit
 *     by-tool` (`24h`, `7d`, etc). When set, the timeline emits a
 *     bucket for every interval intersecting `[now - DUR, now]`, even
 *     zero-count ones — silence is signal too. Without `--since`,
 *     buckets are emitted only for intervals that actually contain a
 *     record (no implicit filler — we don't know the operator's
 *     intended window).
 *
 * # Output (default `--bucket=HOUR`, last 24h)
 *
 *     rea audit timeline (last 24h, hourly)
 *     ──────────────────────────────────────
 *     2026-05-16 14:00  ▁▁▁▁▁                    23 events
 *     2026-05-16 15:00  ▁▁▁▁▁▁▁▁                 47 events
 *     2026-05-16 16:00  ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁       127 events  ← peak
 *     2026-05-16 17:00  ▁▁▁▁▁▁▁▁▁▁▁▁             89 events
 *     …
 *
 * The histogram bar uses a single Unicode block char (▁) repeated
 * proportionally to peak — chosen for terminal friendliness over the
 * staircase forms (▁▂▃▄▅▆▇█) because the staircase forms render
 * unevenly in many terminals and the proportional bar carries the
 * same information at-a-glance. Bar width is capped at 32 chars so
 * the line still fits in a typical 100-col terminal alongside the
 * timestamp and count.
 *
 * Peak marker (`← peak`) sits next to the bucket with the highest
 * count. Ties go to the first occurrence.
 *
 * # JSON output
 *
 *     {
 *       "schema_version": 1,
 *       "bucket": { "raw": "HOUR", "seconds": 3600 },
 *       "window": {
 *         "seconds": 86400,
 *         "start":   "2026-05-16T14:00:00.000Z",
 *         "end":     "2026-05-17T14:00:00.000Z"
 *       },
 *       "buckets": [
 *         { "start": "2026-05-16T14:00:00.000Z",
 *           "end":   "2026-05-16T15:00:00.000Z",
 *           "count": 23 },
 *         …
 *       ],
 *       "total_events": 287,
 *       "peak_index": 2,
 *       "files_scanned": ["/abs/path/.rea/audit.jsonl"]
 *     }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';
import { listRotatedAuditFiles } from './audit-specialists.js';
import {
  AuditSummarySinceError,
  parseDurationSeconds,
} from './audit-summary.js';
import { AUDIT_FILE, REA_DIR, err } from './utils.js';

export const AUDIT_TIMELINE_SCHEMA_VERSION = 1;

/** Histogram bar character. See module docstring for rationale. */
const BAR_CHAR = '▁';

/** Maximum bar width in characters. */
const MAX_BAR_WIDTH = 32;

/**
 * Hard ceiling on the number of buckets the command will produce. A
 * `--since=7d` with `--bucket=1m` would emit 10,080 buckets — well
 * past what a terminal renderer handles gracefully. Capping at 2000
 * still allows `--bucket=15m --since=21d` (`~2016 buckets`) which
 * covers the realistic ops use cases.
 */
export const MAX_BUCKETS = 2000;

export class AuditTimelineOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditTimelineOptionError';
  }
}

export interface AuditTimelineBucket {
  /** Inclusive start (ISO-8601 UTC). */
  start: string;
  /** Exclusive end (ISO-8601 UTC). `end - start === bucket.seconds`. */
  end: string;
  count: number;
}

export interface AuditTimelineResult {
  schema_version: typeof AUDIT_TIMELINE_SCHEMA_VERSION;
  bucket: {
    /** The raw `--bucket` value (e.g. `HOUR`, `15m`). */
    raw: string;
    /** Resolved bucket size in seconds. */
    seconds: number;
  };
  window: {
    seconds: number | null;
    start: string | null;
    end: string | null;
  };
  buckets: AuditTimelineBucket[];
  total_events: number;
  /** Index of the bucket with the highest count. `-1` when no events. */
  peak_index: number;
  files_scanned: string[];
}

export interface ComputeAuditTimelineOptions {
  /** Override CWD. Tests set this; production uses `process.cwd()`. */
  baseDir?: string;
  /** `--since` (e.g. `24h`, `7d`). Parsed via parseDuration. */
  since?: string;
  /** `--bucket` value (`HOUR`, `DAY`, or duration). Default `HOUR`. */
  bucket?: string;
  /** Test seam — pin "now". */
  now?: Date;
}

/**
 * Resolve `--bucket` to a number of seconds. Accepts:
 *   - `HOUR` / `H` / `1H` (case-insensitive) → 3600
 *   - `DAY`  / `D` / `1D` (case-insensitive) → 86400
 *   - duration form (`15m`, `30s`, `2h`, `1d`, `1w`) → parsed via
 *     `parseDurationSeconds` for shape compatibility with `--since`
 *
 * Bucket size must be >= 1 second; on the upper end we accept any
 * value but `MAX_BUCKETS` will bound the rendered output.
 */
export function resolveBucketSeconds(raw: string): number {
  const t = raw.trim();
  if (t.length === 0) {
    throw new AuditTimelineOptionError('--bucket: must not be empty.');
  }
  const upper = t.toUpperCase();
  if (upper === 'HOUR' || upper === 'H' || upper === '1H') return 3600;
  if (upper === 'DAY' || upper === 'D' || upper === '1D') return 86400;
  // Fall through to duration shape. `parseDurationSeconds` throws
  // `AuditSummarySinceError` on bad input; re-throw under our class.
  try {
    return parseDurationSeconds(t);
  } catch (e) {
    if (e instanceof AuditSummarySinceError) {
      throw new AuditTimelineOptionError(
        `--bucket: ${e.message.replace(/^--since: */, '')}`,
      );
    }
    throw e;
  }
}

async function resolveTimelineFileWalk(baseDir: string): Promise<string[]> {
  const reaDir = path.join(baseDir, REA_DIR);
  const currentAudit = path.join(reaDir, AUDIT_FILE);
  const files: string[] = [];
  const rotated = await listRotatedAuditFiles(reaDir);
  for (const name of rotated) files.push(path.join(reaDir, name));
  try {
    const stat = await fs.stat(currentAudit);
    if (stat.isFile()) files.push(currentAudit);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return files;
}

function parseTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Align an epoch-millisecond instant DOWN to a bucket boundary of
 * `bucketSeconds`. The boundary lattice is anchored at the UTC epoch
 * (`1970-01-01T00:00:00Z`) so day/hour buckets fall on natural UTC
 * boundaries and sub-hour buckets (15m / 30m / 5m) align to natural
 * sub-hour boundaries.
 */
function alignToBucket(epochMs: number, bucketSeconds: number): number {
  const bucketMs = bucketSeconds * 1000;
  return Math.floor(epochMs / bucketMs) * bucketMs;
}

/**
 * Compute the bucketed timeline. Pure (read-only). Throws
 * `AuditTimelineOptionError` on bad `--since` / `--bucket`; throws on
 * unreadable rotated segments (mirror of audit-summary's stance).
 */
export async function computeAuditTimeline(
  options: ComputeAuditTimelineOptions = {},
): Promise<AuditTimelineResult> {
  const baseDir = options.baseDir ?? process.cwd();
  const now = options.now ?? new Date();
  const bucketRaw = options.bucket ?? 'HOUR';
  const bucketSeconds = resolveBucketSeconds(bucketRaw);
  if (bucketSeconds < 1) {
    throw new AuditTimelineOptionError(
      `--bucket: resolved bucket size must be >= 1 second; got ${String(bucketSeconds)}.`,
    );
  }

  let windowSeconds: number | null = null;
  let windowStart: Date | null = null;
  let windowEnd: Date | null = null;
  if (options.since !== undefined && options.since.length > 0) {
    try {
      windowSeconds = parseDurationSeconds(options.since);
    } catch (e) {
      if (e instanceof AuditSummarySinceError) {
        throw new AuditTimelineOptionError(e.message);
      }
      throw e;
    }
    windowEnd = now;
    windowStart = new Date(now.getTime() - windowSeconds * 1000);

    // Guard against runaway bucket counts under a wide --since with a
    // tiny --bucket. A simple ceiling is cheaper than rendering 100k
    // empty rows and gives the operator a clear remediation path.
    const projected = Math.ceil(windowSeconds / bucketSeconds);
    if (projected > MAX_BUCKETS) {
      throw new AuditTimelineOptionError(
        `--bucket=${bucketRaw} with --since=${options.since} would emit ` +
          `${String(projected)} buckets (max ${String(MAX_BUCKETS)}). ` +
          `Use a larger --bucket or narrower --since.`,
      );
    }
  }

  const files = await resolveTimelineFileWalk(baseDir);
  // Bucket key is the aligned epoch-ms boundary; value is the count.
  const buckets = new Map<number, number>();
  let totalEvents = 0;
  let earliestRecordMs: number | null = null;
  let latestRecordMs: number | null = null;
  const filesScanned: string[] = [];

  for (const filePath of files) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') continue;
      throw new Error(
        `rea audit timeline: cannot read ${filePath} (${errno ?? 'unknown errno'}). ` +
          `An unreadable audit segment may contain in-window records, so the ` +
          `timeline would be silently incomplete. Fix permissions ` +
          `(e.g. \`chmod u+r ${filePath}\`), or move the file out of \`.rea/\` ` +
          `if you no longer need it.`,
      );
    }
    filesScanned.push(filePath);
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let parsed: AuditRecord;
      try {
        parsed = JSON.parse(line) as AuditRecord;
      } catch {
        continue;
      }
      const ts = parseTimestamp(parsed.timestamp);
      if (ts === null) continue;
      if (windowStart !== null && ts < windowStart) continue;
      // Upper bound: when --since is set, also drop records strictly
      // AFTER `now` so a future-dated record doesn't bend the
      // peak/heat. The summary path counts them; the timeline path
      // would have nowhere coherent to place them under a fixed-end
      // window (their bucket falls outside the rendered range).
      if (windowEnd !== null && ts > windowEnd) continue;
      totalEvents += 1;
      const tsMs = ts.getTime();
      const bucketKey = alignToBucket(tsMs, bucketSeconds);
      buckets.set(bucketKey, (buckets.get(bucketKey) ?? 0) + 1);
      if (earliestRecordMs === null || tsMs < earliestRecordMs) earliestRecordMs = tsMs;
      if (latestRecordMs === null || tsMs > latestRecordMs) latestRecordMs = tsMs;
    }
  }

  // Determine the bucket span we'll emit.
  //   - --since set → emit every bucket from `windowStart`'s aligned
  //     boundary up through `windowEnd`'s aligned boundary, inclusive
  //     of zero-count intervals (silence is signal).
  //   - --since unset → emit only buckets that actually contained a
  //     record (no implicit filler).
  const result: AuditTimelineBucket[] = [];
  if (windowStart !== null && windowEnd !== null) {
    const startKey = alignToBucket(windowStart.getTime(), bucketSeconds);
    const endKey = alignToBucket(windowEnd.getTime(), bucketSeconds);
    const stepMs = bucketSeconds * 1000;
    // Hard re-check after alignment — pathological inputs (huge
    // --since, tiny --bucket) would already have failed at the
    // projected-count guard above, but a runaway here would freeze
    // the renderer.
    const emit = Math.floor((endKey - startKey) / stepMs) + 1;
    if (emit > MAX_BUCKETS) {
      throw new AuditTimelineOptionError(
        `--bucket / --since would emit ${String(emit)} buckets after alignment ` +
          `(max ${String(MAX_BUCKETS)}). Use a larger --bucket or narrower --since.`,
      );
    }
    for (let k = startKey; k <= endKey; k += stepMs) {
      result.push({
        start: new Date(k).toISOString(),
        end: new Date(k + stepMs).toISOString(),
        count: buckets.get(k) ?? 0,
      });
    }
  } else if (buckets.size > 0) {
    const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
    if (keys.length > MAX_BUCKETS) {
      // Without --since the operator hasn't asked for a fixed shape,
      // but a runaway result still needs a guard. Refuse rather than
      // truncate silently.
      throw new AuditTimelineOptionError(
        `Without --since, the audit log spans ${String(keys.length)} ${bucketRaw} buckets ` +
          `(max ${String(MAX_BUCKETS)}). Pass --since to scope, or use a larger --bucket.`,
      );
    }
    const stepMs = bucketSeconds * 1000;
    for (const k of keys) {
      result.push({
        start: new Date(k).toISOString(),
        end: new Date(k + stepMs).toISOString(),
        count: buckets.get(k) ?? 0,
      });
    }
  }

  // Peak index. -1 when no events at all (every bucket is 0 or the
  // list is empty). Ties go to first occurrence — `findIndex` does
  // that for free.
  let peakIndex = -1;
  if (totalEvents > 0) {
    let peakCount = -1;
    for (let i = 0; i < result.length; i += 1) {
      if (result[i]!.count > peakCount) {
        peakCount = result[i]!.count;
        peakIndex = i;
      }
    }
  }

  return {
    schema_version: AUDIT_TIMELINE_SCHEMA_VERSION,
    bucket: { raw: bucketRaw, seconds: bucketSeconds },
    window: {
      seconds: windowSeconds,
      start: windowStart !== null ? windowStart.toISOString() : null,
      end: windowEnd !== null ? windowEnd.toISOString() : null,
    },
    buckets: result,
    total_events: totalEvents,
    peak_index: peakIndex,
    files_scanned: filesScanned,
  };
}

/**
 * Format a bucket-start timestamp for the human renderer. Uses
 * `YYYY-MM-DD HH:MM` (UTC) so the columns stay narrow.
 */
function formatBucketTimestamp(iso: string, bucketSeconds: number): string {
  const d = new Date(iso);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  // Day buckets don't need the HH:MM noise (always `00:00`); show
  // just the date to reduce visual clutter.
  if (bucketSeconds % 86400 === 0) return `${yyyy}-${mm}-${dd}`;
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function bucketLabel(seconds: number, raw: string): string {
  // Honor explicit `HOUR` / `DAY` so the header reads naturally.
  const upper = raw.toUpperCase();
  if (upper === 'HOUR' || upper === 'H' || upper === '1H') return 'hourly';
  if (upper === 'DAY' || upper === 'D' || upper === '1D') return 'daily';
  // Duration form — show the raw value the operator typed.
  return `every ${raw}`;
}

function formatWindowLabel(seconds: number | null): string {
  if (seconds === null) return 'all time';
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

/**
 * Render the result as a human-readable terminal block with inline
 * histogram bars. See module docstring for the rendering choices.
 */
export function renderAuditTimeline(result: AuditTimelineResult): string {
  const lines: string[] = [];
  const windowLabel = formatWindowLabel(result.window.seconds);
  const cadenceLabel = bucketLabel(result.bucket.seconds, result.bucket.raw);
  lines.push(`rea audit timeline (${windowLabel}, ${cadenceLabel})`);
  lines.push('─'.repeat(40));
  // Codex round-1 P2 (0.46.0): the zero-events case has two distinct
  // shapes and the renderer must NOT collapse them.
  //
  //   - `--since` set + zero events + `buckets.length > 0` — operator
  //     asked for an explicit window; we already built the zero-filled
  //     bucket lattice in computeAuditTimeline. Show it so silence is
  //     visible as flat ▁-less rows rather than a generic
  //     "No events" line. That's the WHOLE POINT of the timeline
  //     command under --since: distinguish "idle window" from "command
  //     never ran".
  //   - Otherwise (no --since, or --since with `buckets.length === 0`
  //     which means the operator gave us nothing to draw) — render the
  //     concise no-events notice. The empty `buckets` path also
  //     handles the truly-empty-repo case.
  if (result.total_events === 0 && result.buckets.length === 0) {
    lines.push(
      result.window.seconds !== null
        ? 'No events in the requested window.'
        : 'No events in the audit log.',
    );
    if (result.files_scanned.length === 0) {
      lines.push('(no audit files found — has `rea serve` ever run?)');
    }
    lines.push('');
    return lines.join('\n');
  }

  // Compute peak count for bar scaling. Default to 1 when all buckets
  // are empty so the bar-width math below stays well-defined (0 / 1
  // = 0 → empty bar, which is what we want in the idle-window case).
  const peakCount =
    result.buckets.reduce((m, b) => (b.count > m ? b.count : m), 0) || 1;
  // Stable timestamp-column width based on the bucket cadence.
  const sampleTs = formatBucketTimestamp(
    result.buckets[0]!.start,
    result.bucket.seconds,
  );
  const tsWidth = sampleTs.length;
  // Stable count-column width — widest count in the result.
  const maxCountWidth = result.buckets.reduce(
    (m, b) => Math.max(m, String(b.count).length),
    1,
  );

  for (let i = 0; i < result.buckets.length; i += 1) {
    const b = result.buckets[i]!;
    const ts = formatBucketTimestamp(b.start, result.bucket.seconds).padEnd(tsWidth);
    const barWidth =
      b.count === 0
        ? 0
        : Math.max(1, Math.round((b.count * MAX_BAR_WIDTH) / peakCount));
    const bar = BAR_CHAR.repeat(barWidth).padEnd(MAX_BAR_WIDTH);
    const count = String(b.count).padStart(maxCountWidth);
    // Codex round-1 P2 (0.46.0) follow-up: peak marker only when
    // there were actual events. peak_index is -1 when total_events
    // is 0, but be defensive — never mark a 0-count bucket as peak.
    const peakMarker =
      i === result.peak_index && b.count > 0 ? '  ← peak' : '';
    lines.push(
      `${ts}  ${bar}  ${count} event${b.count === 1 ? ' ' : 's'}${peakMarker}`,
    );
  }

  lines.push('');
  lines.push(`total: ${String(result.total_events)} events across ${String(result.buckets.length)} bucket${result.buckets.length === 1 ? '' : 's'}`);
  lines.push(`files scanned: ${String(result.files_scanned.length)}`);
  lines.push('');
  return lines.join('\n');
}

export interface RunAuditTimelineOptions {
  since?: string;
  bucket?: string;
  json?: boolean;
  /** Test seam — pin "now". */
  now?: Date;
}

/** Commander entrypoint. */
export async function runAuditTimeline(options: RunAuditTimelineOptions): Promise<void> {
  let result: AuditTimelineResult;
  try {
    result = await computeAuditTimeline({
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.bucket !== undefined ? { bucket: options.bucket } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  } catch (e) {
    if (e instanceof AuditTimelineOptionError) {
      err(`rea audit timeline: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  if (options.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderAuditTimeline(result));
}

/**
 * Register `rea audit timeline` under the `audit` command group.
 */
export function registerAuditTimelineCommand(auditCommand: Command): void {
  auditCommand
    .command('timeline')
    .description(
      'Time-bucketed event counts — `--bucket=HOUR|DAY` (or duration like `15m`), `--since=DUR`, `--json`. Histogram bar inline. Read-only.',
    )
    .option(
      '--bucket <size>',
      'bucket size — `HOUR` (default), `DAY`, or a duration like `15m`, `30m`, `1h`, `1d`',
    )
    .option(
      '--since <duration>',
      'filter to records within the last <duration>. Compact form: <N><unit> where unit is s|m|h|d|w (e.g. 24h, 7d).',
    )
    .option('--json', 'emit a JSON document instead of the human-readable histogram')
    .action(async (opts: { bucket?: string; since?: string; json?: boolean }) => {
      await runAuditTimeline({
        ...(opts.bucket !== undefined ? { bucket: opts.bucket } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.json === true ? { json: true } : {}),
      });
    });
}
