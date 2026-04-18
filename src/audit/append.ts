/**
 * Public audit-append helper — exported from `@bookedsolid/rea/audit`.
 *
 * This is the single hash-chain entry point for external consumers (the
 * `codex-adversarial` agent, Helix's `helix.plan` / `helix.apply` events, and
 * any future plugin that needs to emit structured events through rea's audit
 * trail). Consumers own their event semantics; rea owns the contract.
 *
 * ## Guarantees
 *
 * - Reads the last JSONL line of `.rea/audit.jsonl` to seed `prev_hash`.
 * - Computes a SHA-256 hash over the serialized record minus `hash`.
 * - Appends a single `\n`-terminated JSON line, then fsyncs the file.
 * - Creates `.rea/` and `audit.jsonl` on first use.
 * - Never throws on stat/missing-file conditions; only throws on write failure
 *   (the caller decides how to react).
 *
 * ## Concurrency
 *
 * The helper serializes writes per-process via a module-scoped queue keyed by
 * the resolved audit-file path. Cross-process concurrency on the same file is
 * NOT handled here — writers in separate processes can interleave and break
 * the chain. The current deployment targets (rea's own governance hooks, the
 * Codex agent, Helix) all funnel through a single process at a time. If that
 * changes, add an exclusive-lock file (`audit.jsonl.lock`) before lifting this
 * restriction. Documented risk; do not silently expand the guarantee.
 *
 * @see {@link file://./codex-event.ts} for the canonical `codex.review` shape.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Tier, InvocationStatus } from '../policy/types.js';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';

const GENESIS_HASH = '0'.repeat(64);
const REA_DIR = '.rea';
const AUDIT_FILE = 'audit.jsonl';

/**
 * Input shape for {@link appendAuditRecord}. All fields except `tool_name`
 * and `server_name` are optional; sensible defaults are applied to keep the
 * hash chain uniform across event types.
 */
export interface AppendAuditInput {
  tool_name: string;
  server_name: string;
  status?: InvocationStatus;
  tier?: Tier;
  autonomy_level?: string;
  session_id?: string;
  duration_ms?: number;
  error?: string;
  redacted_fields?: string[];
  metadata?: Record<string, unknown>;
  /** ISO-8601 timestamp; defaults to `new Date().toISOString()` */
  timestamp?: string;
}

/** Per-file write queue to preserve linear hash-chain order within a process. */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Cache of `baseDir → resolved baseDir` so we pay the realpath cost once per
 * unique input. Correctness comes from the fact that we always key the write
 * queue by the resolved path; this map is only here to keep steady-state
 * appends fast. Invalidated implicitly when the process exits.
 */
const resolvedBaseDirCache = new Map<string, string>();

/**
 * Resolve a baseDir to a stable, process-wide canonical form. Two callers that
 * pass `'.'` and `process.cwd()` for the same project must land on the same
 * queue key — otherwise the per-process serialization promise in this module's
 * header is broken and concurrent appends can interleave, corrupting the hash
 * chain.
 *
 * Strategy:
 *   1. `path.resolve(baseDir)` — makes relative paths absolute and normalizes.
 *   2. Best-effort `fs.realpath(resolvedBase)` — unwraps symlinks (e.g. macOS
 *      `/tmp` → `/private/tmp`). If it throws (directory doesn't exist yet on
 *      first write, permission error, etc.), fall back to the `path.resolve`
 *      result. The directory will be created in `doAppend` via `mkdir`.
 *
 * Correctness first, caching second: we only cache on successful realpath. If
 * realpath fails because the dir doesn't exist yet, we don't cache — the next
 * call gets another chance to canonicalize once the dir exists.
 */
async function resolveBaseDir(baseDir: string): Promise<string> {
  const cached = resolvedBaseDirCache.get(baseDir);
  if (cached !== undefined) return cached;

  const absolute = path.resolve(baseDir);
  try {
    const real = await fs.realpath(absolute);
    resolvedBaseDirCache.set(baseDir, real);
    return real;
  } catch {
    // Directory doesn't exist yet, or realpath isn't permitted here. Fall back
    // to the path.resolve'd absolute form — still stable per input, still
    // collapses `'.' === cwd` via the absolute path. Don't cache: once the
    // directory exists, a later call should upgrade to the realpath form.
    return absolute;
  }
}

function computeHash(record: Omit<AuditRecord, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

async function readLastHash(auditFile: string): Promise<string> {
  let data: string;
  try {
    data = await fs.readFile(auditFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return GENESIS_HASH;
    throw err;
  }
  // Walk the file backwards by newline — the last non-empty line is the tail.
  const trimmed = data.replace(/\n+$/, '');
  if (trimmed.length === 0) return GENESIS_HASH;
  const lastNewline = trimmed.lastIndexOf('\n');
  const lastLine = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1);
  try {
    const parsed = JSON.parse(lastLine) as Partial<AuditRecord>;
    if (typeof parsed.hash === 'string' && parsed.hash.length === 64) {
      return parsed.hash;
    }
  } catch {
    // Corrupt tail line — fall through to genesis. The operator will see this
    // because the chain verify tool (future) will flag the break point. We do
    // not throw: refusing to append would mask every subsequent event.
  }
  return GENESIS_HASH;
}

async function fsyncFile(filePath: string): Promise<void> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    await fh.sync();
  } catch {
    // fsync failure is not fatal — durability is best-effort here; the write
    // itself already succeeded.
  } finally {
    if (fh) await fh.close();
  }
}

async function doAppend(
  resolvedBase: string,
  input: AppendAuditInput,
): Promise<AuditRecord> {
  const reaDir = path.join(resolvedBase, REA_DIR);
  const auditFile = path.join(reaDir, AUDIT_FILE);

  await fs.mkdir(reaDir, { recursive: true });

  const prevHash = await readLastHash(auditFile);
  const now = input.timestamp ?? new Date().toISOString();

  const recordBase: Omit<AuditRecord, 'hash'> = {
    timestamp: now,
    session_id: input.session_id ?? 'external',
    tool_name: input.tool_name,
    server_name: input.server_name,
    tier: input.tier ?? Tier.Read,
    status: input.status ?? InvocationStatus.Allowed,
    autonomy_level: input.autonomy_level ?? 'unknown',
    duration_ms: input.duration_ms ?? 0,
    prev_hash: prevHash,
  };
  if (input.error) recordBase.error = input.error;
  if (input.redacted_fields?.length) recordBase.redacted_fields = input.redacted_fields;
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    recordBase.metadata = input.metadata;
  }

  const hash = computeHash(recordBase);
  const record: AuditRecord = { ...recordBase, hash };
  const line = JSON.stringify(record) + '\n';

  await fs.appendFile(auditFile, line);
  await fsyncFile(auditFile);

  return record;
}

/**
 * Append a structured audit record to `${baseDir}/.rea/audit.jsonl` with a
 * hash chained against the tail of the existing log.
 *
 * @param baseDir - Repo/project root (the directory that contains `.rea/`).
 * @param input   - Event data. `tool_name` and `server_name` are required.
 * @returns The full written record, including the computed `hash`.
 */
export async function appendAuditRecord(
  baseDir: string,
  input: AppendAuditInput,
): Promise<AuditRecord> {
  // Canonicalize the baseDir so every caller targeting the same on-disk
  // directory lands on the same queue key, regardless of whether they passed
  // `'.'`, `process.cwd()`, or a symlinked path. Without this, two callers in
  // the same process can bypass the serialization promise and interleave
  // appends — corrupting the hash chain (finding #6).
  const resolvedBase = await resolveBaseDir(baseDir);
  const key = path.join(resolvedBase, REA_DIR, AUDIT_FILE);

  const prev = writeQueues.get(key) ?? Promise.resolve();
  let record!: AuditRecord;
  const next = prev
    .catch(() => {
      /* previous write's error is owned by that caller */
    })
    .then(async () => {
      record = await doAppend(resolvedBase, input);
    });
  writeQueues.set(
    key,
    next.finally(() => {
      // Keep the queue lean — once this write resolves, drop the reference
      // if nothing newer is chained behind it.
      if (writeQueues.get(key) === next) writeQueues.delete(key);
    }),
  );
  await next;
  return record;
}

export type { AuditRecord } from '../gateway/middleware/audit-types.js';
export { Tier, InvocationStatus } from '../policy/types.js';
export {
  CODEX_REVIEW_TOOL_NAME,
  CODEX_REVIEW_SERVER_NAME,
  type CodexVerdict,
  type CodexReviewMetadata,
} from './codex-event.js';
