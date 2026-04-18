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
 * ## Concurrency (G1)
 *
 * Writes are serialized two ways:
 *
 *   1. Per-process: a module-scoped queue keyed by the canonical path
 *      preserves linear ordering within a single Node process.
 *   2. Cross-process: each `doAppend` call is wrapped in a `proper-lockfile`
 *      lock on `.rea/`. Stale locks are reclaimed after 10s. Two processes
 *      appending concurrently serialize cleanly; the hash chain stays linear.
 *
 * Rotation (`maybeRotate`) runs BEFORE the append lock is taken, so a full
 * audit file is rotated out of the way transparently. The rotation marker
 * record preserves hash-chain continuity across the boundary.
 *
 * @see {@link file://./codex-event.ts} for the canonical `codex.review` shape.
 * @see {@link file://../gateway/audit/rotator.ts} for rotation semantics.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Tier, InvocationStatus } from '../policy/types.js';
import type { Policy } from '../policy/types.js';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';
import {
  GENESIS_HASH,
  computeHash,
  fsyncFile,
  readLastRecord,
  withAuditLock,
} from './fs.js';
import { maybeRotate } from '../gateway/audit/rotator.js';

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
  /**
   * Optional policy for rotation decisions. When absent, rotation is
   * disabled (back-compat). Callers that want rotation pass the already-
   * loaded policy; the helper does not re-read `.rea/policy.yaml` on every
   * append — that would be a surprise cost for consumers.
   */
  policy?: Policy;
}

/** Per-file write queue to preserve linear hash-chain order within a process. */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Resolve a baseDir to a stable, process-wide canonical form. Two callers that
 * pass `'.'` and `process.cwd()` for the same project must land on the same
 * queue key — otherwise the per-process serialization promise in this module's
 * header is broken and concurrent appends can interleave, corrupting the hash
 * chain.
 *
 * Strategy:
 *   1. `path.resolve(baseDir)` — makes relative paths absolute against the
 *      CURRENT `process.cwd()`. This must run every call; caching by the raw
 *      input key would return a stale absolute path after a `process.chdir()`,
 *      which is how rea's audit helper gets used across repos in long-lived
 *      processes. (See finding R2-3.)
 *   2. Best-effort `fs.realpath(resolvedBase)` — unwraps symlinks (e.g. macOS
 *      `/tmp` → `/private/tmp`). If it throws (directory doesn't exist yet on
 *      first write, permission error, etc.), fall back to the `path.resolve`
 *      result. The directory will be created in `doAppend` via `mkdir`.
 *
 * NOTE: no caching here. `path.resolve` is microseconds and `fs.realpath` is a
 * single `lstat` syscall; audit append is not a hot path. A previous revision
 * keyed a cache by the raw `baseDir` string, which returned stale absolute
 * paths across `chdir` — a brand-new regression worse than the cost it saved.
 * If a future profiler demands caching, key it by `path.resolve(baseDir)` and
 * only cache already-absolute inputs.
 */
async function resolveBaseDir(baseDir: string): Promise<string> {
  const absolute = path.resolve(baseDir);
  try {
    return await fs.realpath(absolute);
  } catch {
    // Directory doesn't exist yet, or realpath isn't permitted here. Fall back
    // to the path.resolve'd absolute form — still stable per input, still
    // collapses `'.' === cwd` via the absolute path.
    return absolute;
  }
}

async function doAppend(
  resolvedBase: string,
  input: AppendAuditInput,
): Promise<AuditRecord> {
  const reaDir = path.join(resolvedBase, REA_DIR);
  const auditFile = path.join(reaDir, AUDIT_FILE);

  await fs.mkdir(reaDir, { recursive: true });

  // Rotate BEFORE acquiring our append lock. maybeRotate takes its own lock
  // internally and is idempotent; callers that race simply observe a fresh
  // file with the rotation marker as their chain anchor.
  await maybeRotate(auditFile, input.policy);

  return withAuditLock(auditFile, async () => {
    const { hash: prevHash } = await readLastRecord(auditFile);
    const effectivePrev = prevHash || GENESIS_HASH;
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
      prev_hash: effectivePrev,
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
  });
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
