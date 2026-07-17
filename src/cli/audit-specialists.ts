/**
 * `rea audit specialists` — reader CLI for delegation-telemetry
 * (0.29.0; `--since` / `--session` added 0.31.0).
 *
 * Walks `.rea/audit.jsonl` (plus any rotated files when `--since` is
 * given), filters records by `tool_name === 'rea.delegation_signal'`,
 * groups by `metadata.subagent_type`, and prints a table (default) or
 * JSON document (`--json`).
 *
 * # Session filtering
 *
 * Three ways to scope, in precedence order:
 *
 *   1. `--session <id>`  — explicit. Filters to records whose
 *      `metadata.session_id_observed` matches `<id>`. The literal
 *      `--session all` disables filtering entirely (show every
 *      session). Wins over the env var.
 *   2. `$CLAUDE_SESSION_ID` — when set and `--session` is omitted,
 *      filters to the current Claude Code session.
 *   3. neither — no filter; every record in the walked files is shown,
 *      and a note tells the operator what they're seeing.
 *
 * # `--since <rotated-file>`
 *
 * By default the reader walks only the current `.rea/audit.jsonl`.
 * `--since audit-YYYYMMDD-HHMMSS.jsonl` extends the walk backward: the
 * named rotated file and every rotated file after it (timestamp-
 * ascending) are scanned, then the current `audit.jsonl` as the tail.
 * Mirrors `rea audit verify --since`. The filename must match the
 * canonical rotated-audit shape or the CLI exits 1.
 *
 * # Output shape
 *
 *   subagent_type            count   last_seen (UTC)
 *   rea-orchestrator         12      2026-05-12T21:30:00Z
 *   code-reviewer             5      2026-05-12T21:28:00Z
 *   deep-dive                 2      2026-05-12T21:14:00Z
 *
 * JSON mode prints `{ session_filter, records, groups, files_scanned }`
 * where `records` is the raw filtered subset (for piping into jq) and
 * `groups` is the per-subagent rollup.
 */

import fs from 'node:fs/promises';
import { resolveReaRoots } from '../lib/worktree-roots.js';
import path from 'node:path';
import type { Command } from 'commander';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';
import {
  DELEGATION_SIGNAL_TOOL_NAME,
  DELEGATION_SIGNAL_SCHEMA_VERSION,
  type DelegationSignalMetadata,
  type DelegationTool,
} from '../audit/delegation-event.js';
import { AUDIT_FILE, REA_DIR, log } from './utils.js';

export interface AuditSpecialistsOptions {
  /** Emit a single JSON document on stdout instead of the table. */
  json?: boolean;
  /**
   * Override session filtering. Production callers omit (the CLI reads
   * `--session` then `CLAUDE_SESSION_ID` from the env). Tests set this
   * so they don't mutate `process.env`.
   *
   * - `string` → filter to records whose `session_id_observed` matches.
   * - `null`   → no filter (show all records).
   * - `undefined` → derive from `--session` flag then env.
   */
  sessionFilter?: string | null;
  /**
   * 0.31.0 — explicit `--session <id>` flag value. Resolution rules:
   *
   *   - `'all'` (case-insensitive) → no filter (equivalent to
   *     `sessionFilter: null`), `session_filter_source: 'option'`.
   *   - any other non-empty string → filter to that session,
   *     `session_filter_source: 'option'`.
   *   - `undefined` → fall through to `sessionFilter`, then env.
   *
   * `sessionFilter` (the test seam) still wins over this when both are
   * set — tests inject `sessionFilter` directly and don't pass
   * `sessionOption`.
   */
  sessionOption?: string;
  /**
   * 0.31.0 — `--since <rotated-file>` flag value. When set, the named
   * rotated audit file plus every later rotated file (timestamp-
   * ascending) are walked before the current `.rea/audit.jsonl`.
   * Must match `audit-YYYYMMDD-HHMMSS(-N).jsonl`. Validation failure
   * throws `AuditSpecialistsSinceError` so the commander wrapper can
   * exit 1 with a clear message.
   */
  since?: string;
  /** Override CWD. Tests set this; production uses `process.cwd()`. */
  baseDir?: string;
}

/**
 * Thrown by `computeAuditSpecialists` when `--since` names something
 * that is not a valid rotated-audit basename, or names a rotated file
 * that does not exist. The commander wrapper catches it and exits 1.
 */
export class AuditSpecialistsSinceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditSpecialistsSinceError';
  }
}

/** Canonical rotated-audit filename shape — mirrors `audit.ts`. */
const ROTATED_AUDIT_RE = /^audit-\d{8}-\d{6}(-\d+)?\.jsonl$/;

interface DelegationGroup {
  subagent_type: string;
  count: number;
  /** Latest envelope timestamp seen in the group. */
  last_seen: string;
  /** Breakdown of which delegation_tool fired (Agent vs. Skill). */
  by_tool: Record<DelegationTool, number>;
}

export interface DelegationRecord {
  timestamp: string;
  session_id_observed: string;
  delegation_tool: DelegationTool;
  subagent_type: string;
  parent_subagent_type: string | null;
  invocation_description_sha256: string;
  hook_event_timestamp?: string;
}

interface AuditSpecialistsResult {
  /** Which session filter was applied. `null` means "no filter". */
  session_filter: string | null;
  /** Was the filter derived from `CLAUDE_SESSION_ID` env? Informational. */
  session_filter_source: 'env' | 'option' | 'none';
  /** Raw matched records, in chain order. */
  records: DelegationRecord[];
  /** Per-subagent rollups, sorted by descending count then by name. */
  groups: DelegationGroup[];
  /**
   * Files actually walked. v1 only walks `.rea/audit.jsonl`; future
   * `--since` rotated-file support extends this.
   */
  files_scanned: string[];
}

/**
 * Type guard for a record that has the delegation-signal shape. Skips
 * envelope shape validation (zod runs at write time); checks only the
 * fields the reader actually uses.
 */
function isDelegationRecord(r: AuditRecord): boolean {
  if (r.tool_name !== DELEGATION_SIGNAL_TOOL_NAME) return false;
  const m = r.metadata as Partial<DelegationSignalMetadata> | undefined;
  if (m === undefined) return false;
  if (m.schema_version !== DELEGATION_SIGNAL_SCHEMA_VERSION) return false;
  if (m.delegation_tool !== 'Agent' && m.delegation_tool !== 'Skill') return false;
  if (typeof m.subagent_type !== 'string') return false;
  return true;
}

/**
 * Sort key for a rotated-audit basename. Returns `[stamp, suffix]`:
 *
 *   - `stamp` — the `YYYYMMDD-HHMMSS` block. Zero-padded fixed-width, so
 *     a plain lexical compare on it IS chronological order.
 *   - `suffix` — the intra-second collision counter (`-N`), parsed as an
 *     integer. The base file (`audit-...jsonl`, no `-N`) is the FIRST
 *     rotation in its second, so its suffix is `0` and it sorts ahead of
 *     `audit-...-1.jsonl`.
 *
 * Round-2 P3: the previous implementation sorted the whole basename
 * lexically, which misorders the `-N` suffix once it reaches two digits
 * (`...-10.jsonl` sorts BEFORE `...-2.jsonl`). A repo that rotates more
 * than 9 times in one second would then have `resolveAuditFileWalk`
 * slice from the wrong index and silently drop later segments — and,
 * post-0.31.0, the delegation-advisory predicate (which reuses this
 * resolution) would miss delegations and fire false-positive nudges.
 */
function rotatedAuditSortKey(name: string): [string, number] {
  // `ROTATED_AUDIT_RE` already guaranteed the shape; capture the parts.
  const m = /^audit-(\d{8}-\d{6})(?:-(\d+))?\.jsonl$/.exec(name);
  if (m === null) {
    // Defensive — callers only pass names that matched ROTATED_AUDIT_RE.
    return [name, 0];
  }
  const stamp = m[1]!;
  const suffix = m[2] !== undefined ? Number.parseInt(m[2], 10) : 0;
  return [stamp, Number.isInteger(suffix) ? suffix : 0];
}

/**
 * List rotated audit files in `.rea/`, timestamp-ascending. Filenames
 * follow `audit-YYYYMMDD-HHMMSS(-N).jsonl`. Sorted via
 * `rotatedAuditSortKey` — the `YYYYMMDD-HHMMSS` block lexically (it is
 * fixed-width zero-padded, so lexical == chronological) then the `-N`
 * intra-second suffix NUMERICALLY (a plain lexical sort of the whole
 * basename misorders two-digit suffixes — see `rotatedAuditSortKey`).
 * Mirrors the private helper in `audit.ts` — kept local so this reader
 * doesn't import the verify command's internals.
 *
 * Exported (0.31.0 round-2 P3) so `delegation-advisory.ts` can resolve
 * the rotated-file set without duplicating the `ROTATED_AUDIT_RE` glob:
 * the advisory's "did this session delegate" predicate must scan rotated
 * segments too, or a delegation recorded before an audit rotation is
 * invisible to the nudge and the session gets a false-positive advisory.
 */
export async function listRotatedAuditFiles(reaDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(reaDir);
  } catch {
    return [];
  }
  const rotated = entries.filter((n) => ROTATED_AUDIT_RE.test(n));
  rotated.sort((a, b) => {
    const [stampA, suffixA] = rotatedAuditSortKey(a);
    const [stampB, suffixB] = rotatedAuditSortKey(b);
    if (stampA !== stampB) return stampA < stampB ? -1 : 1;
    return suffixA - suffixB;
  });
  return rotated;
}

/**
 * Resolve the ordered list of absolute audit-file paths to walk.
 *
 * - `since === undefined` → just the current `.rea/audit.jsonl` (when
 *   it exists). Pre-0.31.0 behavior.
 * - `since` set → validate it names a real rotated file, then walk
 *   that file + every later rotated file (timestamp-ascending), with
 *   the current `audit.jsonl` as the tail.
 *
 * The current `audit.jsonl` is included at the END of the walk
 * whenever it exists — it is always the newest segment of the chain.
 * A `--since` that names a non-rotated string, or a rotated file that
 * isn't present on disk, throws `AuditSpecialistsSinceError`.
 */
export async function resolveAuditFileWalk(
  baseDir: string,
  since: string | undefined,
): Promise<string[]> {
  const reaDir = path.join(baseDir, REA_DIR);
  const currentAudit = path.join(reaDir, AUDIT_FILE);
  const files: string[] = [];

  if (since !== undefined && since.length > 0) {
    const sinceName = path.basename(since);
    if (!ROTATED_AUDIT_RE.test(sinceName)) {
      throw new AuditSpecialistsSinceError(
        `--since must name a rotated audit file (audit-YYYYMMDD-HHMMSS.jsonl); got ${JSON.stringify(
          since,
        )}`,
      );
    }
    const allRotated = await listRotatedAuditFiles(reaDir);
    const startIdx = allRotated.indexOf(sinceName);
    if (startIdx === -1) {
      throw new AuditSpecialistsSinceError(
        `Rotated file not found: ${path.join(REA_DIR, sinceName)}`,
      );
    }
    for (const name of allRotated.slice(startIdx)) {
      files.push(path.join(reaDir, name));
    }
  }

  // The current audit.jsonl is always the tail of the walk (when present).
  try {
    const stat = await fs.stat(currentAudit);
    if (stat.isFile()) files.push(currentAudit);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return files;
}

/**
 * Read the audit file(s) and return delegation records (filtered +
 * parsed into a reader-friendly shape). Malformed lines are skipped
 * silently — `rea audit verify` is the right tool for chain integrity.
 *
 * `since` defaults to `undefined` (current `.rea/audit.jsonl` only) so
 * existing callers — including `computeDelegationAdvisory` in
 * `delegation-advisory.ts` — keep their pre-0.31.0 single-file
 * behavior without passing the argument.
 */
export async function loadDelegationRecords(
  baseDir: string,
  sessionFilter: string | null,
  since?: string,
): Promise<{ records: DelegationRecord[]; filesScanned: string[] }> {
  const filesToWalk = await resolveAuditFileWalk(baseDir, since);
  const records: DelegationRecord[] = [];
  const filesScanned: string[] = [];
  for (const auditFile of filesToWalk) {
    let raw: string;
    try {
      raw = await fs.readFile(auditFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    filesScanned.push(auditFile);
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let parsed: AuditRecord;
      try {
        parsed = JSON.parse(line) as AuditRecord;
      } catch {
        continue;
      }
      if (!isDelegationRecord(parsed)) continue;
      const m = parsed.metadata as unknown as DelegationSignalMetadata;
      if (sessionFilter !== null && m.session_id_observed !== sessionFilter) continue;
      const rec: DelegationRecord = {
        timestamp: parsed.timestamp,
        session_id_observed: m.session_id_observed,
        delegation_tool: m.delegation_tool,
        subagent_type: m.subagent_type,
        parent_subagent_type: m.parent_subagent_type,
        invocation_description_sha256: m.invocation_description_sha256,
        ...(m.hook_event_timestamp !== undefined
          ? { hook_event_timestamp: m.hook_event_timestamp }
          : {}),
      };
      records.push(rec);
    }
  }
  return { records, filesScanned };
}

/**
 * Group records by `subagent_type`. Sorts by descending count, then
 * alphabetical on tie. `last_seen` is the latest envelope timestamp in
 * the group.
 */
export function groupBySubagent(records: DelegationRecord[]): DelegationGroup[] {
  const byName = new Map<string, DelegationGroup>();
  for (const r of records) {
    let g = byName.get(r.subagent_type);
    if (g === undefined) {
      g = {
        subagent_type: r.subagent_type,
        count: 0,
        last_seen: r.timestamp,
        by_tool: { Agent: 0, Skill: 0 },
      };
      byName.set(r.subagent_type, g);
    }
    g.count += 1;
    g.by_tool[r.delegation_tool] += 1;
    if (r.timestamp > g.last_seen) g.last_seen = r.timestamp;
  }
  return Array.from(byName.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.subagent_type.localeCompare(b.subagent_type);
  });
}

/**
 * Computation-only entrypoint. Returns the full result so callers
 * (CLI, tests) can render or assert. `runAuditSpecialists` is the thin
 * commander wrapper that prints + exits.
 */
export async function computeAuditSpecialists(
  options: AuditSpecialistsOptions = {},
): Promise<AuditSpecialistsResult> {
  // 0.54.0 worktree state: the audit chain is per-REPOSITORY — read
  // it from the common root so `rea audit *` in a worktree sees the
  // shared chain. Degenerate in plain checkouts.
  const baseDir = options.baseDir ?? resolveReaRoots(process.cwd()).commonRoot;
  let sessionFilter: string | null;
  let source: 'env' | 'option' | 'none';
  // Precedence: explicit `sessionFilter` test seam > `--session` flag >
  // `$CLAUDE_SESSION_ID` env > no filter.
  if (options.sessionFilter !== undefined) {
    sessionFilter = options.sessionFilter;
    source = options.sessionFilter === null ? 'none' : 'option';
  } else if (options.sessionOption !== undefined && options.sessionOption.length > 0) {
    // `--session all` (case-insensitive) means "show every session".
    if (options.sessionOption.toLowerCase() === 'all') {
      sessionFilter = null;
      source = 'none';
    } else {
      sessionFilter = options.sessionOption;
      source = 'option';
    }
  } else {
    const envId = process.env['CLAUDE_SESSION_ID'];
    if (typeof envId === 'string' && envId.length > 0) {
      sessionFilter = envId;
      source = 'env';
    } else {
      sessionFilter = null;
      source = 'none';
    }
  }
  const { records, filesScanned } = await loadDelegationRecords(
    baseDir,
    sessionFilter,
    options.since,
  );
  const groups = groupBySubagent(records);
  return {
    session_filter: sessionFilter,
    session_filter_source: source,
    records,
    groups,
    files_scanned: filesScanned,
  };
}

function renderTable(result: AuditSpecialistsResult): string {
  if (result.groups.length === 0) {
    const note =
      result.session_filter !== null
        ? `No delegation signals recorded for session ${result.session_filter}.`
        : 'No delegation signals recorded.';
    return `${note}\n  (Records are written by the .claude/hooks/delegation-capture.sh PreToolUse hook on every Agent/Skill dispatch.)\n`;
  }
  const headers = ['subagent_type', 'count', 'agent', 'skill', 'last_seen (UTC)'];
  const rows: string[][] = result.groups.map((g) => [
    g.subagent_type,
    String(g.count),
    String(g.by_tool.Agent),
    String(g.by_tool.Skill),
    g.last_seen,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const lines: string[] = [];
  lines.push(headers.map((h, i) => h.padEnd(widths[i]!)).join('  '));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    lines.push(row.map((c, i) => c.padEnd(widths[i]!)).join('  '));
  }
  return lines.join('\n') + '\n';
}

/**
 * Commander entrypoint. Reads, renders, exits 0 on success / 1 when
 * `--since` is malformed or names a missing rotated file. The CLI is
 * read-only — no audit-chain writes.
 */
export async function runAuditSpecialists(options: AuditSpecialistsOptions): Promise<void> {
  let result: AuditSpecialistsResult;
  try {
    result = await computeAuditSpecialists(options);
  } catch (e) {
    if (e instanceof AuditSpecialistsSinceError) {
      process.stderr.write(`rea audit specialists: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  if (options.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (result.session_filter !== null) {
    log(
      `Delegation signals (session=${result.session_filter}, source=${result.session_filter_source}):`,
    );
  } else {
    log(
      'Delegation signals (no session filter — pass --session <id> to scope, ' +
        '--session all to show every session, or set $CLAUDE_SESSION_ID):',
    );
  }
  if (result.files_scanned.length > 1) {
    log(`  scanned ${String(result.files_scanned.length)} audit files (--since walk).`);
  }
  process.stdout.write(renderTable(result));
}

/**
 * Attach the `specialists` subcommand to the `rea audit` command group.
 * Exported as a registrar so `src/cli/index.ts` can wire it next to the
 * existing `rotate` and `verify` subcommands without leaking commander
 * knowledge into this module.
 */
export function registerAuditSpecialistsSubcommand(auditCommand: Command): void {
  auditCommand
    .command('specialists')
    .description(
      'Summarize `rea.delegation_signal` audit records — counts per subagent / skill, last-seen timestamps, agent-vs-skill breakdown. Walks `.rea/audit.jsonl` (plus rotated files with --since). Honors --session / $CLAUDE_SESSION_ID for session scoping.',
    )
    .option(
      '--json',
      'emit JSON (records + groups + files_scanned) instead of the human-readable table. Composes with jq.',
    )
    .option(
      '--session <id>',
      'filter to a specific session_id_observed. Wins over $CLAUDE_SESSION_ID. The literal `all` disables session filtering (shows every session). When omitted, falls back to $CLAUDE_SESSION_ID then no filter.',
    )
    .option(
      '--since <rotated-file>',
      'extend the walk backward through rotated audit files. Names a rotated file (audit-YYYYMMDD-HHMMSS.jsonl); that file and every later rotated file are scanned, then the current audit.jsonl. Mirrors `rea audit verify --since`.',
    )
    .action(async (opts: { json?: boolean; session?: string; since?: string }) => {
      await runAuditSpecialists({
        ...(opts.json === true ? { json: true } : {}),
        ...(opts.session !== undefined ? { sessionOption: opts.session } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      });
    });
}

