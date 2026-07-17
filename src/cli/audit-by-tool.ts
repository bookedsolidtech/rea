/**
 * `rea audit by-tool [--top=N] [--since=DUR] [--json]` — 0.46.0
 * charter item 1.
 *
 * Surface the audit log's tool-name distribution at higher fidelity
 * than `audit summary`. `summary` caps its `by tool_name` rendering at
 * 12 rows and rolls the rest into `(other)`; `by-tool` is the focused
 * lens — it walks the same files but lets the operator pick a deeper
 * cut (`--top=N` up to 1000) and only emits the tool-name distribution
 * + the surrounding window metadata. Useful for:
 *
 *   - Spotting unexpected tool usage patterns ("why is Write firing
 *     10x more than Edit?")
 *   - Identifying the top consumers of a session's activity
 *   - CI dashboards / monitoring pipelines (the `--json` shape is
 *     stable and minimal)
 *
 * # Walk scope
 *
 * Mirrors `rea audit summary` exactly: the current `.rea/audit.jsonl`
 * PLUS every rotated `audit-YYYYMMDD-HHMMSS(-N).jsonl` segment is
 * walked regardless of whether `--since` is set, and the per-record
 * `timestamp >= now - duration` filter decides what counts (0.42.0
 * charter item 3 / 0.41.0 round-3 P2 — rotated filenames mark the
 * rotation instant, not the earliest record contained). Walking every
 * segment is the only sound way to count tools under a window when a
 * late-rotation may have absorbed days of records under a single
 * trailing filename stamp.
 *
 * # Output (default)
 *
 *     rea audit by-tool (last 24h, top 20)
 *     ─────────────────────────────────────
 *     Bash                   612 (49.1%)
 *     Edit                   289 (23.2%)
 *     Write                  127 (10.2%)
 *     Agent                   47 ( 3.8%)
 *     rea.delegation_signal   42 ( 3.4%)
 *     …
 *
 * Tools beyond `--top` are summarized as `(other: N tools, M events)`
 * so the operator can see the long-tail at a glance without scrolling.
 *
 * # JSON output
 *
 *     {
 *       "schema_version": 1,
 *       "window": {
 *         "seconds": 86400,
 *         "start":   "2026-05-16T13:42:00Z",
 *         "end":     "2026-05-17T13:42:00Z"
 *       },
 *       "total_events": 1247,
 *       "unique_tools": 18,
 *       "top": 20,
 *       "tools": [
 *         { "name": "Bash",  "count": 612, "pct": 49.08 },
 *         { "name": "Edit",  "count": 289, "pct": 23.18 },
 *         …
 *       ],
 *       "files_scanned": ["/abs/path/.rea/audit.jsonl"]
 *     }
 *
 * `pct` is the share of TOTAL events (not the share of the visible
 * top-N) so dashboards can compose multiple windows without re-deriving
 * denominators. `tools` is truncated to `--top`; the long tail's
 * cardinality / event total is computable as `unique_tools - top` /
 * `total_events - sum(top.count)`.
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

export const AUDIT_BY_TOOL_SCHEMA_VERSION = 1;

/**
 * Default `--top` value. 20 is enough to fit a typical session's
 * distinct tool set comfortably while keeping the table short enough
 * to scan at a glance. Operators wanting a deeper cut pass `--top=N`;
 * we cap at `MAX_TOP` to keep the renderer from blowing up on a
 * runaway log.
 */
export const DEFAULT_TOP = 20;

/**
 * Hard ceiling on `--top`. A single audit file shouldn't realistically
 * grow past a few hundred distinct tool_names in normal use; 1000 is
 * a generous limit that still bounds the renderer / JSON output.
 */
export const MAX_TOP = 1000;

/**
 * Thrown when `--top` is outside the [1, MAX_TOP] range or `--since`
 * fails to parse. The commander wrapper catches it and exits 1.
 *
 * We do NOT reuse `AuditSummarySinceError` for `--top` because the
 * caller-facing message names a different flag — keeping the error
 * class distinct keeps the error text from cross-contaminating.
 */
export class AuditByToolOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditByToolOptionError';
  }
}

export interface AuditByToolToolEntry {
  name: string;
  count: number;
  /** Share of TOTAL events (not share of visible top-N). 2 decimals. */
  pct: number;
}

export interface AuditByToolResult {
  schema_version: typeof AUDIT_BY_TOOL_SCHEMA_VERSION;
  window: {
    /** Window length in seconds. `null` when no `--since` filter. */
    seconds: number | null;
    /** Inclusive window start. `null` when no filter. */
    start: string | null;
    /** Window end — always `now` when filter set; `null` otherwise. */
    end: string | null;
  };
  total_events: number;
  /** Cardinality of the FULL tool_name set (not just the top-N). */
  unique_tools: number;
  /** The resolved `--top` value actually used. */
  top: number;
  /** Pre-sorted (desc by count, then alpha on tie) — capped at `top`. */
  tools: AuditByToolToolEntry[];
  /** Absolute paths of audit files actually read. */
  files_scanned: string[];
}

export interface ComputeAuditByToolOptions {
  /** Override CWD. Tests set this; production uses `process.cwd()`. */
  baseDir?: string;
  /** Raw `--since` value (e.g. `24h`, `7d`). Parsed via parseDuration. */
  since?: string;
  /** Raw `--top` value. Default `DEFAULT_TOP`. */
  top?: number;
  /** Test seam — pin "now" for deterministic window calculations. */
  now?: Date;
}

/**
 * Resolve the audit files to walk. Identical strategy to
 * `audit-summary.ts` — walk every rotated segment regardless of
 * `--since` (the per-record timestamp filter inside the main loop
 * decides what counts). We inline a small helper instead of importing
 * the summary's `resolveSummaryFileWalk` to keep the public surface of
 * `audit-summary.ts` narrow; the logic is small and unlikely to drift.
 */
async function resolveByToolFileWalk(baseDir: string): Promise<string[]> {
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
 * Compute the by-tool rollup. Pure (read-only). Throws
 * `AuditByToolOptionError` on bad `--since` / `--top`; surfaces
 * everything else via the result.
 */
export async function computeAuditByTool(
  options: ComputeAuditByToolOptions = {},
): Promise<AuditByToolResult> {
  // 0.54.0 worktree state: the audit chain is per-REPOSITORY — read
  // it from the common root so `rea audit *` in a worktree sees the
  // shared chain. Degenerate in plain checkouts.
  const baseDir = options.baseDir ?? resolveReaRoots(process.cwd()).commonRoot;
  const now = options.now ?? new Date();

  // Resolve --top first so a bad value fails fast before any I/O.
  const top = options.top ?? DEFAULT_TOP;
  if (!Number.isInteger(top) || top < 1 || top > MAX_TOP) {
    throw new AuditByToolOptionError(
      `--top: must be an integer between 1 and ${String(MAX_TOP)}; got ${JSON.stringify(top)}.`,
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
        // Re-throw under our own error class so the commander wrapper's
        // catch matches a single type.
        throw new AuditByToolOptionError(e.message);
      }
      throw e;
    }
    windowEnd = now;
    windowStart = new Date(now.getTime() - windowSeconds * 1000);
  }

  const files = await resolveByToolFileWalk(baseDir);
  const byToolName = new Map<string, number>();
  let totalEvents = 0;
  const filesScanned: string[] = [];

  for (const filePath of files) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') continue;
      // Mirror audit-summary's stance: any non-ENOENT read error is
      // fatal. A silent soft-skip on a rotated segment that may
      // contain in-window records would let `by-tool` report a
      // misleading distribution with no signal to the operator.
      throw new Error(
        `rea audit by-tool: cannot read ${filePath} (${errno ?? 'unknown errno'}). ` +
          `An unreadable audit segment may contain in-window records, so the ` +
          `distribution would be silently incomplete. Fix permissions ` +
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
        // Malformed line — `rea audit verify` is the right tool. by-tool
        // skips and continues so a corrupt mid-file line doesn't tank
        // the distribution.
        continue;
      }
      const ts = parseTimestamp(parsed.timestamp);
      if (windowStart !== null && (ts === null || ts < windowStart)) continue;
      totalEvents += 1;
      const toolName =
        typeof parsed.tool_name === 'string' && parsed.tool_name.length > 0
          ? parsed.tool_name
          : '(unknown)';
      byToolName.set(toolName, (byToolName.get(toolName) ?? 0) + 1);
    }
  }

  // Sort desc by count, then alpha on tie. Cap at `top` — the long
  // tail is summarized in the renderer / surfaced via the
  // `unique_tools` field in the JSON shape.
  const sorted: AuditByToolToolEntry[] = Array.from(byToolName.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, top)
    .map(([name, count]) => ({
      name,
      count,
      pct: totalEvents > 0 ? Math.round((count * 10000) / totalEvents) / 100 : 0,
    }));

  return {
    schema_version: AUDIT_BY_TOOL_SCHEMA_VERSION,
    window: {
      seconds: windowSeconds,
      start: windowStart !== null ? windowStart.toISOString() : null,
      end: windowEnd !== null ? windowEnd.toISOString() : null,
    },
    total_events: totalEvents,
    unique_tools: byToolName.size,
    top,
    tools: sorted,
    files_scanned: filesScanned,
  };
}

/**
 * Compact human duration label for the header. Mirrors
 * `audit-summary.ts`'s `formatDurationShort` — kept local so the two
 * modules don't share rendering internals. `86400` → `last 24h`,
 * `604800` → `last 7d`, etc.
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
 * bypass this; the rendering is intentionally simple (no Unicode bars
 * — that's the `timeline` command's job).
 */
export function renderAuditByTool(result: AuditByToolResult): string {
  const lines: string[] = [];
  const windowLabel =
    result.window.seconds !== null ? formatDurationShort(result.window.seconds) : 'all time';
  lines.push(`rea audit by-tool (${windowLabel}, top ${String(result.top)})`);
  lines.push('─'.repeat(40));
  if (result.total_events === 0) {
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

  const maxNameLen = result.tools.reduce((m, t) => Math.max(m, t.name.length), 0);
  for (const t of result.tools) {
    const pad = ' '.repeat(maxNameLen - t.name.length + 2);
    // Pad pct to a stable 5-char field (e.g. " 4.3" / "49.1") so the
    // columns line up regardless of magnitude.
    const pctStr = t.pct.toFixed(1).padStart(5);
    lines.push(`  ${t.name}${pad}${String(t.count).padStart(6)} (${pctStr}%)`);
  }

  // Long-tail summary — present when more tools exist than the top-N
  // shows, so the operator sees what was elided.
  if (result.unique_tools > result.tools.length) {
    const shownEvents = result.tools.reduce((s, t) => s + t.count, 0);
    const otherTools = result.unique_tools - result.tools.length;
    const otherEvents = result.total_events - shownEvents;
    const otherPct =
      result.total_events > 0 ? ((otherEvents * 100) / result.total_events).toFixed(1) : '0.0';
    lines.push(
      `  (other: ${String(otherTools)} tool${otherTools === 1 ? '' : 's'}, ` +
        `${String(otherEvents)} event${otherEvents === 1 ? '' : 's'}, ${otherPct}%)`,
    );
  }

  lines.push('');
  lines.push(
    `total: ${String(result.total_events)} events across ${String(result.unique_tools)} distinct tool${result.unique_tools === 1 ? '' : 's'}`,
  );
  lines.push(`files scanned: ${String(result.files_scanned.length)}`);
  lines.push('');
  return lines.join('\n');
}

export interface RunAuditByToolOptions {
  since?: string;
  top?: number;
  json?: boolean;
  /** Test seam — pin "now". */
  now?: Date;
}

/** Commander entrypoint. */
export async function runAuditByTool(options: RunAuditByToolOptions): Promise<void> {
  let result: AuditByToolResult;
  try {
    result = await computeAuditByTool({
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.top !== undefined ? { top: options.top } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  } catch (e) {
    if (e instanceof AuditByToolOptionError) {
      err(`rea audit by-tool: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  if (options.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderAuditByTool(result));
}

/**
 * Strict integer parser for the commander `--top <n>` option.
 *
 * Codex round-1 P3 (0.46.0): reject any input that isn't a bare
 * integer. `Number.parseInt` silently truncates `1.5` to `1` and
 * accepts `10abc` as `10`, which would change the requested top-N
 * under the operator's nose without an error signal. We require the
 * raw string to match `^-?\d+$` so the numeric parse can't drop
 * characters. The downstream range validation in `computeAuditByTool`
 * still enforces [1, MAX_TOP].
 *
 * Exported for direct test coverage — commander's option-parser
 * callback shape doesn't compose well with the in-process testing we
 * want here, so we pin the parser as a unit instead.
 */
export function parseTopOption(raw: string): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new AuditByToolOptionError(
      `--top: expected integer; got ${JSON.stringify(raw)}.`,
    );
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) {
    throw new AuditByToolOptionError(
      `--top: expected integer; got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

/**
 * Register `rea audit by-tool` under the `audit` command group.
 */
export function registerAuditByToolCommand(auditCommand: Command): void {
  auditCommand
    .command('by-tool')
    .description(
      'Tool-name distribution at higher fidelity than `audit summary` — `--top=N` (default 20, max 1000), `--since=DUR` window filter, `--json` for dashboards. Read-only.',
    )
    .option(
      '--top <n>',
      `cap the rendered / serialized list to the top N tools by count (default ${String(DEFAULT_TOP)}, max ${String(MAX_TOP)})`,
      parseTopOption,
    )
    .option(
      '--since <duration>',
      'filter to records within the last <duration>. Compact form: <N><unit> where unit is s|m|h|d|w (e.g. 24h, 7d).',
    )
    .option('--json', 'emit a JSON document instead of the human-readable table')
    .action(async (opts: { top?: number; since?: string; json?: boolean }) => {
      await runAuditByTool({
        ...(opts.top !== undefined ? { top: opts.top } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.json === true ? { json: true } : {}),
      });
    });
}
