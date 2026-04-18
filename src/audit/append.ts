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
  baseDir: string,
  input: AppendAuditInput,
): Promise<AuditRecord> {
  const reaDir = path.join(baseDir, REA_DIR);
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
  const reaDir = path.join(baseDir, REA_DIR);
  const auditFile = path.join(reaDir, AUDIT_FILE);
  const key = auditFile;

  const prev = writeQueues.get(key) ?? Promise.resolve();
  let record!: AuditRecord;
  const next = prev
    .catch(() => {
      /* previous write's error is owned by that caller */
    })
    .then(async () => {
      record = await doAppend(baseDir, input);
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
