import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuditRecord } from './audit-types.js';
import type { Policy } from '../../policy/types.js';
import { Tier, InvocationStatus } from '../../policy/types.js';
import type { Middleware } from './chain.js';
import { computeHash, fsyncFile, readLastRecord, withAuditLock } from '../../audit/fs.js';
import { maybeRotate } from '../audit/rotator.js';
import type { MetricsRegistry } from '../observability/metrics.js';

/**
 * Post-execution middleware: appends a hash-chained JSONL audit record.
 *
 * SECURITY: Each audit middleware instance maintains its own hash chain.
 * SECURITY: Audit write failures are logged to stderr but do NOT crash the gateway.
 * SECURITY: Wraps next() in try/finally to ensure audit runs even on middleware exceptions.
 * SECURITY: Placed as outermost middleware so audit records ALL invocations, including denials.
 * PERFORMANCE: All fs operations are async to avoid blocking the event loop.
 *
 * CONCURRENCY (G1):
 *   - Per-process: the writeQueue below serializes writes within the Node process.
 *   - Cross-process: each write acquires a `proper-lockfile` lock on `.rea/`.
 *     Stale locks are reclaimed after 10s. Lock-acquisition failure falls back
 *     to the current best-effort behavior — the tool call proceeds and the
 *     failure is logged. Breaking the invocation because the auditor failed
 *     would let an audit outage take down the gateway.
 *
 * ROTATION (G1):
 *   - `maybeRotate` runs before each write's lock acquisition. Rotation writes
 *     a marker record whose `prev_hash` preserves hash-chain continuity across
 *     the rotation boundary. When no `audit.rotation` block is set in policy,
 *     rotation is a no-op — 0.2.x behavior is preserved.
 */
export function createAuditMiddleware(
  baseDir: string,
  policy?: Policy,
  /**
   * Optional metrics registry. When supplied, the
   * `rea_audit_lines_appended_total` counter is incremented on every
   * successful append (post-fsync). When omitted, no metrics are emitted —
   * keeps the middleware usable in unit tests that don't exercise the
   * observability surface.
   */
  metrics?: MetricsRegistry,
): Middleware {
  // REA writes to a single .rea/audit.jsonl file (not dated per-day files).
  const reaDir = path.join(baseDir, '.rea');
  const auditFile = path.join(reaDir, 'audit.jsonl');
  let dirEnsured = false;
  // SECURITY: Use a write queue to serialize audit writes, ensuring the hash chain is linear.
  let writeQueue: Promise<void> = Promise.resolve();

  async function ensureDir(): Promise<void> {
    if (!dirEnsured) {
      await fs.mkdir(reaDir, { recursive: true });
      dirEnsured = true;
    }
  }

  return async (ctx, next) => {
    let nextError: Error | undefined;

    try {
      await next();
    } catch (err) {
      // Capture the error but still write the audit record
      nextError = err instanceof Error ? err : new Error(String(err));
      ctx.status = InvocationStatus.Error;
      ctx.error = nextError.message;
    }

    // Build audit record — always runs, even after exceptions.
    // SECURITY: autonomy_level from ctx.metadata reflects the hot-reloaded policy (set by policy
    // middleware inside next()). Falls back to the startup policy if metadata was not set (e.g.,
    // kill-switch denied before policy middleware ran).
    const duration_ms = Date.now() - ctx.start_time;
    const autonomyLevel =
      (ctx.metadata.autonomy_level as string) ?? policy?.autonomy_level ?? 'unknown';

    // Cap ctx.error before writing the audit record. A downstream MCP server
    // can produce arbitrarily long error strings; if the audit record grows
    // beyond ~64 KiB, `rea status` misreports it as corrupt because the tail
    // window in summarizeAudit cannot contain the full record. 4096 bytes is
    // generous for any legitimate error description.
    const MAX_AUDIT_ERROR_BYTES = 4096;
    if (ctx.error && ctx.error.length > MAX_AUDIT_ERROR_BYTES) {
      ctx.error = ctx.error.slice(0, MAX_AUDIT_ERROR_BYTES) + '\u2026[truncated]';
    }

    // Serialize audit writes via a queue to maintain hash chain linearity under concurrency.
    // Each write awaits the previous one before running its lock-scoped append.
    const writePromise = writeQueue.then(async () => {
      try {
        await ensureDir();

        // G1: Attempt rotation BEFORE acquiring the append lock. No-op when the
        // policy's audit.rotation block is absent. Errors are swallowed inside
        // maybeRotate so rotation can never take down the gateway.
        await maybeRotate(auditFile, policy);

        await withAuditLock(auditFile, async () => {
          const { hash: prevHash } = await readLastRecord(auditFile);
          const now = new Date().toISOString();

          const recordBase: Omit<AuditRecord, 'hash'> = {
            timestamp: now,
            session_id: ctx.session_id,
            tool_name: ctx.tool_name,
            server_name: ctx.server_name,
            tier: ctx.tier ?? Tier.Write,
            status: ctx.status,
            autonomy_level: autonomyLevel,
            duration_ms,
            prev_hash: prevHash,
            // Defect P: gateway middleware records every proxied tool call.
            // rea itself is the writer — tag as rea-cli so the schema is
            // consistent. "rea-cli" here is a misnomer (the gateway isn't a
            // CLI) but is part of the stable 0.10.1 discriminator set;
            // semantically it means "written by @bookedsolid/rea itself".
            emission_source: 'rea-cli',
          };

          if (ctx.error) {
            recordBase.error = ctx.error;
          }
          if (ctx.redacted_fields?.length) {
            recordBase.redacted_fields = ctx.redacted_fields;
          }
          // Attach caller-supplied metadata when the middleware context carries any.
          // The `autonomy_level` key is reserved for internal bookkeeping (see above)
          // and is excluded from the exported metadata payload.
          if (ctx.metadata !== undefined) {
            const exported: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(ctx.metadata)) {
              if (k === 'autonomy_level') continue;
              exported[k] = v;
            }
            if (Object.keys(exported).length > 0) {
              recordBase.metadata = exported;
            }
          }

          const hash = computeHash(recordBase);
          const record: AuditRecord = { ...recordBase, hash };
          const line = JSON.stringify(record) + '\n';

          try {
            await fs.appendFile(auditFile, line);
          } catch {
            // Directory may have been deleted externally — retry once with mkdir
            dirEnsured = false;
            await ensureDir();
            await fs.appendFile(auditFile, line);
          }
          await fsyncFile(auditFile);
          // Only increment after fsync — a counter advance for a line that
          // was never durable on disk would be a lie.
          try {
            metrics?.incAuditLines(1);
          } catch {
            // Metrics failures must never crash the gateway.
          }
        });
      } catch (auditErr) {
        // SECURITY: Never crash the gateway on audit failure — log to stderr.
        // This catches lock-acquisition failures, EEXIST-without-stale, and
        // any other I/O failure. The tool call itself continues.
        dirEnsured = false;
        console.error(
          '[rea] AUDIT WRITE FAILED:',
          auditErr instanceof Error ? auditErr.message : auditErr,
        );
      }
    });
    writeQueue = writePromise;
    await writePromise;

    // Re-throw the original error if next() failed
    if (nextError) {
      throw nextError;
    }
  };
}
