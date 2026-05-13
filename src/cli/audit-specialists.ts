/**
 * `rea audit specialists` — 0.29.0 reader CLI for delegation-telemetry.
 *
 * Walks `.rea/audit.jsonl`, filters records by
 * `tool_name === 'rea.delegation_signal'`, groups by
 * `metadata.subagent_type`, and prints a table (default) or JSON
 * document (`--json`).
 *
 * # Current-session-only in v1
 *
 * v1 has NO `--since` flag and NO `--session=ID` flag. The principal-
 * engineer scope-cut deferred both to 0.29.1. The filter is:
 *
 *   - If `CLAUDE_SESSION_ID` is set, include only records whose
 *     `metadata.session_id_observed` matches.
 *   - Otherwise, include all records in the chain and print a note so
 *     the operator knows what they're seeing.
 *
 * # Output shape
 *
 *   subagent_type            count   last_seen (UTC)
 *   rea-orchestrator         12      2026-05-12T21:30:00Z
 *   code-reviewer             5      2026-05-12T21:28:00Z
 *   deep-dive                 2      2026-05-12T21:14:00Z
 *
 * JSON mode prints `{ session_filter, records, groups }` where
 * `records` is the raw filtered subset (for piping into jq) and
 * `groups` is the per-subagent rollup.
 */

import fs from 'node:fs/promises';
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
   * `CLAUDE_SESSION_ID` from the env). Tests set this so they don't
   * mutate `process.env`.
   *
   * - `string` → filter to records whose `session_id_observed` matches.
   * - `null`   → no filter (show all records).
   * - `undefined` → derive from env.
   */
  sessionFilter?: string | null;
  /** Override CWD. Tests set this; production uses `process.cwd()`. */
  baseDir?: string;
}

interface DelegationGroup {
  subagent_type: string;
  count: number;
  /** Latest envelope timestamp seen in the group. */
  last_seen: string;
  /** Breakdown of which delegation_tool fired (Agent vs. Skill). */
  by_tool: Record<DelegationTool, number>;
}

interface DelegationRecord {
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
 * Read the audit file and return delegation records (filtered + parsed
 * into a reader-friendly shape). Malformed lines are skipped silently
 * — `rea audit verify` is the right tool for chain integrity.
 */
export async function loadDelegationRecords(
  baseDir: string,
  sessionFilter: string | null,
): Promise<{ records: DelegationRecord[]; filesScanned: string[] }> {
  const auditFile = path.join(baseDir, REA_DIR, AUDIT_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(auditFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], filesScanned: [] };
    }
    throw e;
  }
  const records: DelegationRecord[] = [];
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
  return { records, filesScanned: [auditFile] };
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
  const baseDir = options.baseDir ?? process.cwd();
  let sessionFilter: string | null;
  let source: 'env' | 'option' | 'none';
  if (options.sessionFilter === undefined) {
    const envId = process.env['CLAUDE_SESSION_ID'];
    if (typeof envId === 'string' && envId.length > 0) {
      sessionFilter = envId;
      source = 'env';
    } else {
      sessionFilter = null;
      source = 'none';
    }
  } else {
    sessionFilter = options.sessionFilter;
    source = options.sessionFilter === null ? 'none' : 'option';
  }
  const { records, filesScanned } = await loadDelegationRecords(baseDir, sessionFilter);
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
 * Commander entrypoint. Reads, renders, exits 0. The CLI is read-only
 * — no audit-chain writes, no exit-code-as-verdict semantics.
 */
export async function runAuditSpecialists(options: AuditSpecialistsOptions): Promise<void> {
  const result = await computeAuditSpecialists(options);
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
      'Delegation signals (no session filter — set $CLAUDE_SESSION_ID to scope; v1 omits --since / --session by design):',
    );
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
      'Summarize `rea.delegation_signal` audit records — counts per subagent / skill, last-seen timestamps, agent-vs-skill breakdown. Reads only the current `.rea/audit.jsonl`. Honors $CLAUDE_SESSION_ID for current-session filtering. v1 omits --since / --session by design (deferred to 0.29.1).',
    )
    .option(
      '--json',
      'emit JSON (records + groups) instead of the human-readable table. Composes with jq.',
    )
    .action(async (opts: { json?: boolean }) => {
      await runAuditSpecialists({ ...(opts.json === true ? { json: true } : {}) });
    });
}

