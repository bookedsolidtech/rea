/**
 * `rea audit top-blocks [--since=DUR] [--limit=N] [--json]` — 0.47.0
 * charter item 3.
 *
 * Surface the most recent refusal events from the audit log. Designed
 * for the question "why was that refused?" — operators see the latest
 * blocks at a glance with enough context (timestamp, tool, reason) to
 * grep the offending Bash/Edit/Write call site or fix the policy that
 * tripped the gate.
 *
 * A "refusal" in the rea audit schema is any record whose
 * `InvocationStatus` is NOT `Allowed` — that's `Denied` (policy
 * refused) OR `Error` (middleware exception or downstream failure).
 * Both are interesting to operators debugging "why didn't this run".
 *
 * # Walk scope
 *
 * Mirrors `audit summary` / `audit by-tool` / `audit timeline`: the
 * current `.rea/audit.jsonl` PLUS every rotated `audit-…jsonl` segment
 * is walked regardless of `--since` (the per-record timestamp filter
 * inside the main loop decides what counts). Rotated filename stamps
 * mark the rotation INSTANT, not the earliest record contained
 * (0.41.0 round-3 P2 / 0.42.0 charter item 3) — pruning by filename
 * would silently drop in-window records from conservatively-rotated
 * logs. Walking every segment is the only sound shape.
 *
 * # Output (default)
 *
 *     rea audit top-blocks (last 24h, limit 20)
 *     ─────────────────────────────────────────
 *     a1b2c3d4  2026-05-17T12:34:56.789Z  Bash    rm -rf bypass attempted (...)
 *     deadbeef  2026-05-17T11:20:01.123Z  Write   blocked-path .env write
 *     …
 *     total: 4 refusal events in window
 *     files scanned: 2
 *
 * # JSON output
 *
 *     {
 *       "schema_version": 1,
 *       "since": "24h",
 *       "limit": 20,
 *       "window": { "seconds": 86400, "start": "...", "end": "..." },
 *       "total_matched": 4,
 *       "events": [
 *         { "hash": "a1b2c3d4...", "timestamp": "...", "tool": "Bash",
 *           "status": "denied", "reason": "rm -rf bypass attempted (...)" },
 *         …
 *       ],
 *       "files_scanned": ["/abs/path/.rea/audit.jsonl"]
 *     }
 *
 * `total_matched` is the pre-limit count so dashboards can show "20 of
 * 47 refusals in window". `events` is sorted newest-first and capped at
 * `limit`.
 */

import fs from 'node:fs/promises';
import { resolveReaRoots } from '../lib/worktree-roots.js';
import path from 'node:path';
import type { Command } from 'commander';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';
import { listRotatedAuditFiles } from './audit-specialists.js';
import {
  AuditSummarySinceError,
  parseDurationSeconds,
} from './audit-summary.js';
import { AUDIT_FILE, REA_DIR, err } from './utils.js';

export const AUDIT_TOP_BLOCKS_SCHEMA_VERSION = 1;

/** Default `--limit` value. 20 fits a debugging session's eyeballable window. */
export const DEFAULT_LIMIT = 20;

/**
 * Hard ceiling on `--limit`. Refusal events are typically a small slice
 * of total traffic, but a 1000 cap keeps the renderer / JSON output
 * bounded under a runaway misconfiguration that's denying everything.
 */
export const MAX_LIMIT = 1000;

/** Max characters of refusal reason to display per row before truncation. */
const REASON_TRUNCATE = 80;

/** Short-hash prefix length for the displayed event ID. */
const SHORT_HASH_LEN = 8;

/**
 * Thrown when `--limit` is outside [1, MAX_LIMIT] or `--since` fails to
 * parse. The commander wrapper catches and exits 1. Distinct from
 * `AuditByToolOptionError` / `AuditTimelineOptionError` so the
 * caller-facing message names the right flag.
 */
export class AuditTopBlocksOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditTopBlocksOptionError';
  }
}

export interface AuditTopBlocksEvent {
  /** Full sha256 hash from the audit record — stable cross-tool ID. */
  hash: string;
  /** Raw ISO-8601 timestamp from the record. */
  timestamp: string;
  /** Tool name as recorded; `(unknown)` for missing/empty. */
  tool: string;
  /** Raw `status` value (`denied` / `error`). */
  status: string;
  /**
   * Best-effort human-readable reason. Sourced from the record's
   * `error` field when present, else a synthesized "<status>: <tool>"
   * fallback so the row carries SOMETHING informative even when the
   * middleware didn't attach an error message.
   */
  reason: string;
  /** Session ID from the record; useful for cross-referencing. */
  session_id: string;
}

export interface AuditTopBlocksResult {
  schema_version: typeof AUDIT_TOP_BLOCKS_SCHEMA_VERSION;
  /** Raw `--since` value as passed by the caller (`null` when omitted). */
  since: string | null;
  /** Resolved `--limit` actually used. */
  limit: number;
  window: {
    seconds: number | null;
    start: string | null;
    end: string | null;
  };
  /** Pre-limit count of refusal records in window. */
  total_matched: number;
  /** Sorted newest-first; capped at `limit`. */
  events: AuditTopBlocksEvent[];
  /** Absolute paths of audit files actually read. */
  files_scanned: string[];
}

export interface ComputeAuditTopBlocksOptions {
  /** Override CWD. Tests set this; production uses `process.cwd()`. */
  baseDir?: string;
  /** Raw `--since` value (e.g. `24h`, `7d`). Parsed via parseDuration. */
  since?: string;
  /** Raw `--limit` value. Default `DEFAULT_LIMIT`. */
  limit?: number;
  /** Test seam — pin "now" for deterministic window calculations. */
  now?: Date;
}

/**
 * Resolve the audit files to walk. Identical strategy to the sibling
 * audit commands — inlined to keep the public surface of
 * `audit-summary.ts` narrow.
 */
async function resolveTopBlocksFileWalk(baseDir: string): Promise<string[]> {
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
 * Decide whether an audit record represents a refusal. The rea
 * InvocationStatus enum has three values (`allowed`, `denied`,
 * `error`); refusals are the non-`allowed` set. We accept any other
 * string here too so a future status enum extension (or an unusual
 * consumer-emitted status) surfaces in the report rather than silently
 * dropping — the operator can decide whether the new bucket is signal
 * or noise.
 */
function isRefusal(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  return status !== 'allowed';
}

/**
 * Compute the top-blocks list. Pure (read-only). Throws
 * `AuditTopBlocksOptionError` on bad `--since` / `--limit`.
 */
export async function computeAuditTopBlocks(
  options: ComputeAuditTopBlocksOptions = {},
): Promise<AuditTopBlocksResult> {
  // 0.54.0 worktree state: the audit chain is per-REPOSITORY — read
  // it from the common root so `rea audit *` in a worktree sees the
  // shared chain. Degenerate in plain checkouts.
  const baseDir = options.baseDir ?? resolveReaRoots(process.cwd()).commonRoot;
  const now = options.now ?? new Date();

  // Resolve --limit first so a bad value fails fast before any I/O.
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AuditTopBlocksOptionError(
      `--limit: must be an integer between 1 and ${String(MAX_LIMIT)}; got ${JSON.stringify(limit)}.`,
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
        throw new AuditTopBlocksOptionError(e.message);
      }
      throw e;
    }
    windowEnd = now;
    windowStart = new Date(now.getTime() - windowSeconds * 1000);
  }

  const files = await resolveTopBlocksFileWalk(baseDir);
  const filesScanned: string[] = [];
  // Codex round-10 P2 (0.47.0): in a policy-storm scenario (many
  // refusals, verbose `error` strings) the prior shape accumulated
  // every match into a flat array, sorted it, then sliced to
  // `--limit`. Memory + runtime scaled with the total refusal count
  // — exactly the case `top-blocks` was designed to debug. The
  // bounded-buffer shape keeps memory O(limit): we maintain a
  // sorted "top K newest" list of size <= limit and discard the
  // oldest entry whenever a newer one displaces it. `totalMatched`
  // counts every in-window refusal so the JSON shape still
  // communicates "N of M shown".
  const topBuf: Array<{ event: AuditTopBlocksEvent; parsedTime: number }> = [];
  let totalMatched = 0;

  // Insert into the bounded buffer, keeping it sorted newest-first
  // by parsed instant (with hash tiebreaker for determinism). Drop
  // the oldest when capacity exceeded.
  const insertIntoTop = (event: AuditTopBlocksEvent, parsedTime: number): void => {
    // Find insertion point — small linear scan; for limit=20 (the
    // default) this is cheaper than a heap and keeps the code
    // simple. For limit=1000 (the max) we're still O(limit) per
    // insert in the worst case, well under the prior O(N log N)
    // sort across N matches.
    let idx = topBuf.length;
    for (let i = 0; i < topBuf.length; i += 1) {
      const cur = topBuf[i]!;
      if (parsedTime > cur.parsedTime ||
          (parsedTime === cur.parsedTime && event.hash.localeCompare(cur.event.hash) < 0)) {
        idx = i;
        break;
      }
    }
    if (idx < limit) {
      topBuf.splice(idx, 0, { event, parsedTime });
      if (topBuf.length > limit) topBuf.length = limit;
    }
  };

  for (const filePath of files) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') continue;
      // Mirror the sibling audit commands' stance: any non-ENOENT read
      // error is fatal. A silent skip on a rotated segment that may
      // contain in-window refusals would let `top-blocks` exit 0 with
      // the operator's question unanswered.
      throw new Error(
        `rea audit top-blocks: cannot read ${filePath} (${errno ?? 'unknown errno'}). ` +
          `An unreadable audit segment may contain in-window records, so the ` +
          `refusal report would be silently incomplete. Fix permissions ` +
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
        // Malformed line — `rea audit verify` is the right tool. Skip
        // so a single corrupt line doesn't tank the report.
        continue;
      }
      if (!isRefusal(parsed.status)) continue;
      const ts = parseTimestamp(parsed.timestamp);
      if (windowStart !== null && (ts === null || ts < windowStart)) continue;
      if (windowEnd !== null && (ts === null || ts > windowEnd)) continue;
      totalMatched += 1;
      const tool =
        typeof parsed.tool_name === 'string' && parsed.tool_name.length > 0
          ? parsed.tool_name
          : '(unknown)';
      const errorText =
        typeof parsed.error === 'string' && parsed.error.length > 0
          ? parsed.error
          : `${typeof parsed.status === 'string' ? parsed.status : 'refused'}: ${tool}`;
      const event: AuditTopBlocksEvent = {
        hash: typeof parsed.hash === 'string' ? parsed.hash : '',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
        tool,
        status: typeof parsed.status === 'string' ? parsed.status : '(unknown)',
        reason: errorText,
        session_id: typeof parsed.session_id === 'string' ? parsed.session_id : '',
      };
      // Codex round-2 P2 (0.47.0): parse the timestamp before
      // comparing — `appendAuditRecord` accepts any ISO-8601 shape,
      // so `2026-05-17T23:00:00+02:00` (= 21:00:00Z, OLDER) would
      // lex-sort ahead of `2026-05-17T22:30:00Z` (NEWER) under a
      // string compare.
      const parsedTime = Date.parse(event.timestamp);
      insertIntoTop(event, Number.isFinite(parsedTime) ? parsedTime : 0);
    }
  }

  const capped = topBuf.map((entry) => entry.event);

  return {
    schema_version: AUDIT_TOP_BLOCKS_SCHEMA_VERSION,
    since: options.since !== undefined && options.since.length > 0 ? options.since : null,
    limit,
    window: {
      seconds: windowSeconds,
      start: windowStart !== null ? windowStart.toISOString() : null,
      end: windowEnd !== null ? windowEnd.toISOString() : null,
    },
    total_matched: totalMatched,
    events: capped,
    files_scanned: filesScanned,
  };
}

/**
 * Truncate a reason string to `REASON_TRUNCATE` chars for the human
 * renderer. JSON consumers get the full string — they can render at
 * any width.
 *
 * Codex round-10 P3 (0.47.0): refusal reasons often contain embedded
 * newlines (shell stderr, Node stack traces). Writing them straight
 * into a fixed-width row spills a single event across multiple
 * terminal lines and breaks the hash/timestamp/tool columns. Collapse
 * `\r`, `\n`, and tabs to single spaces FIRST, then truncate to the
 * column width. The JSON path preserves the raw `reason` field so
 * consumers see the full multiline message.
 */
function truncateReason(reason: string): string {
  const collapsed = reason.replace(/[\r\n\t]+/g, ' ').replace(/  +/g, ' ').trim();
  if (collapsed.length <= REASON_TRUNCATE) return collapsed;
  return collapsed.slice(0, REASON_TRUNCATE - 1) + '…';
}

/**
 * Short-hash prefix for the displayed event ID. Falls back to the
 * full string when it's shorter than the prefix length (degenerate
 * inputs only — real hashes are always 64 hex chars).
 */
function shortHash(hash: string): string {
  if (hash.length <= SHORT_HASH_LEN) return hash || '(no-hash)';
  return hash.slice(0, SHORT_HASH_LEN);
}

/**
 * Compact human duration label. Mirrors the sibling audit commands.
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

/**
 * Render the result as a human-readable terminal block. JSON callers
 * bypass this; the rendering is intentionally minimal — a fixed-column
 * table that scans cleanly in a typical terminal.
 */
export function renderAuditTopBlocks(result: AuditTopBlocksResult): string {
  const lines: string[] = [];
  const windowLabel =
    result.window.seconds !== null ? formatDurationShort(result.window.seconds) : 'all time';
  lines.push(`rea audit top-blocks (${windowLabel}, limit ${String(result.limit)})`);
  lines.push('─'.repeat(40));

  if (result.total_matched === 0) {
    lines.push(
      result.window.seconds !== null
        ? 'No refusal events in the requested window.'
        : 'No refusal events in the audit log.',
    );
    if (result.files_scanned.length === 0) {
      lines.push('(no audit files found — has `rea serve` ever run?)');
    }
    lines.push('');
    return lines.join('\n');
  }

  // Stable column widths for the table:
  //   short hash (8) + 2  | timestamp (24) + 2 | tool (max in view) + 2 | reason
  const maxToolLen = result.events.reduce((m, ev) => Math.max(m, ev.tool.length), 4);
  for (const ev of result.events) {
    const h = shortHash(ev.hash).padEnd(SHORT_HASH_LEN);
    const ts = ev.timestamp.padEnd(24); // ISO-8601 with ms is 24 chars
    const tool = ev.tool.padEnd(maxToolLen);
    const reason = truncateReason(ev.reason);
    lines.push(`${h}  ${ts}  ${tool}  ${reason}`);
  }

  lines.push('');
  if (result.total_matched > result.events.length) {
    lines.push(
      `total: ${String(result.events.length)} of ${String(result.total_matched)} refusal events shown (--limit=${String(result.limit)})`,
    );
  } else {
    lines.push(
      `total: ${String(result.total_matched)} refusal event${result.total_matched === 1 ? '' : 's'} in window`,
    );
  }
  lines.push(`files scanned: ${String(result.files_scanned.length)}`);
  lines.push('');
  return lines.join('\n');
}

export interface RunAuditTopBlocksOptions {
  since?: string;
  limit?: number;
  json?: boolean;
  /** Test seam — pin "now". */
  now?: Date;
}

/** Commander entrypoint. */
export async function runAuditTopBlocks(options: RunAuditTopBlocksOptions): Promise<void> {
  let result: AuditTopBlocksResult;
  try {
    result = await computeAuditTopBlocks({
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  } catch (e) {
    if (e instanceof AuditTopBlocksOptionError) {
      err(`rea audit top-blocks: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  if (options.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderAuditTopBlocks(result));
}

/**
 * Strict integer parser for the commander `--limit <n>` option.
 *
 * Mirrors the `parseTopOption` discipline in `audit-by-tool.ts`:
 * reject anything that isn't a bare integer so `Number.parseInt`
 * can't silently truncate (`1.5` → `1`, `10abc` → `10`).
 */
export function parseLimitOption(raw: string): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new AuditTopBlocksOptionError(
      `--limit: expected integer; got ${JSON.stringify(raw)}.`,
    );
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) {
    throw new AuditTopBlocksOptionError(
      `--limit: expected integer; got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

/**
 * Register `rea audit top-blocks` under the `audit` command group.
 */
export function registerAuditTopBlocksCommand(auditCommand: Command): void {
  auditCommand
    .command('top-blocks')
    .description(
      'Recent refusal events from the audit log — `--limit=N` (default 20, max 1000), `--since=DUR` window filter, `--json` for dashboards. Read-only.',
    )
    .option(
      '--limit <n>',
      `cap the rendered / serialized list to the most recent N refusals (default ${String(DEFAULT_LIMIT)}, max ${String(MAX_LIMIT)})`,
      parseLimitOption,
    )
    .option(
      '--since <duration>',
      'filter to records within the last <duration>. Compact form: <N><unit> where unit is s|m|h|d|w (e.g. 24h, 7d).',
    )
    .option('--json', 'emit a JSON document instead of the human-readable table')
    .action(async (opts: { limit?: number; since?: string; json?: boolean }) => {
      await runAuditTopBlocks({
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.json === true ? { json: true } : {}),
      });
    });
}
