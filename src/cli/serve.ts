import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '../policy/loader.js';
import { loadRegistry } from '../registry/loader.js';
import { createGateway } from '../gateway/server.js';
import { CodexProbe } from '../gateway/observability/codex-probe.js';
import {
  MetricsRegistry,
  resolveMetricsPort,
  startMetricsServer,
  type MetricsServer,
} from '../gateway/observability/metrics.js';
import { buildRegexRedactor, createLogger, resolveLogLevel } from '../gateway/log.js';
import { SECRET_PATTERNS } from '../gateway/middleware/redact.js';
import { currentSessionId } from '../gateway/session.js';
import {
  HALT_FILE,
  POLICY_FILE,
  REA_DIR,
  REGISTRY_FILE,
  SERVE_PID_FILE,
  SERVE_STATE_FILE,
  err,
  exitWithMissingPolicy,
  log,
  reaPath,
  warn,
} from './utils.js';

/**
 * State-file shape. `session_id` is the ownership key used by
 * `cleanupStateIfOwned` during shutdown — a shutting-down instance
 * that finds a different session_id in the file leaves it alone, so a
 * later `rea serve` that has raced in and rewritten the breadcrumbs
 * is never unexpectedly unlinked.
 */
interface ServeState {
  session_id: string;
  started_at: string;
  metrics_port: number | null;
}

/**
 * Atomic file write: stage to a per-pid temp name, then rename(2). The
 * rename is atomic on POSIX within the same filesystem, so readers never
 * see a half-written buffer. The unique-per-pid temp prefix ensures two
 * overlapping `rea serve` processes don't clobber each other's stage
 * files during the brief window between stage and rename.
 */
function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignored */
    }
    throw e;
  }
}

/**
 * Write the `.rea/serve.pid` breadcrumb atomically. `rea status` reads
 * it and independently `kill(pid, 0)`s before trusting liveness. Stamping
 * with `process.pid` is what lets `cleanupPidIfOwned` refuse to unlink a
 * breadcrumb that a newer instance has already claimed.
 */
function writePidfile(baseDir: string): string {
  const reaDir = path.join(baseDir, REA_DIR);
  if (!fs.existsSync(reaDir)) fs.mkdirSync(reaDir, { recursive: true });
  const pidPath = reaPath(baseDir, SERVE_PID_FILE);
  writeFileAtomic(pidPath, String(process.pid));
  return pidPath;
}

function writeStateFile(baseDir: string, state: ServeState): string {
  const p = reaPath(baseDir, SERVE_STATE_FILE);
  writeFileAtomic(p, JSON.stringify(state, null, 2) + '\n');
  return p;
}

/**
 * Remove the pidfile ONLY if it still carries this process's pid. A
 * shutting-down instance that finds a newer pid leaves the breadcrumb
 * intact so the newer instance's `rea status` users still see "running".
 * Any read/parse error is treated as "not mine" — we never unlink a file
 * we cannot prove we own.
 */
function cleanupPidIfOwned(pidPath: string): void {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (pid === process.pid) {
      try {
        fs.unlinkSync(pidPath);
      } catch {
        /* already gone */
      }
    }
  } catch {
    // Missing, unreadable, mid-rename — nothing to clean up safely.
  }
}

/**
 * Remove the state file ONLY if its `session_id` matches ours. Keyed on
 * session id (not pid) because the state payload already carries the
 * session; reusing that avoids a second cross-file lookup and keeps the
 * ownership signal local to the file being deleted.
 */
function cleanupStateIfOwned(statePath: string, ownSessionId: string): void {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ServeState>;
    if (parsed.session_id === ownSessionId) {
      try {
        fs.unlinkSync(statePath);
      } catch {
        /* already gone */
      }
    }
  } catch {
    // Missing, unreadable, mid-rename — leave alone.
  }
}

/**
 * `rea serve` — start the MCP gateway.
 *
 * Loads `.rea/policy.yaml` and `.rea/registry.yaml`, builds the middleware
 * chain, spawns downstream children from the registry, and connects an upstream
 * stdio MCP server that clients (Claude Code, Helix, etc.) can talk to.
 *
 * G5 additions:
 *   - Writes a pidfile + session state breadcrumb for `rea status`.
 *   - Boots a loopback `/metrics` HTTP endpoint when `REA_METRICS_PORT` is set.
 *   - Emits structured log records through the gateway logger.
 *
 * Breadcrumb race posture:
 *   - Writes are atomic (`writeFileSync` → `rename(2)`) so readers never see
 *     a half-written file.
 *   - Shutdown cleanup is ownership-aware: we only unlink `serve.pid` if its
 *     pid matches ours, and only unlink `serve.state.json` if its session_id
 *     matches ours. This prevents a second overlapping `rea serve` from
 *     losing its breadcrumbs to the first instance's SIGTERM path.
 *
 * Signals: SIGTERM and SIGINT both trigger a graceful shutdown. We do NOT exit
 * on uncaughtException — that path is owned by `src/cli/index.ts`. If the
 * gateway itself throws during startup we log and exit 1.
 */
export async function runServe(): Promise<void> {
  const baseDir = process.cwd();
  const policyPath = reaPath(baseDir, POLICY_FILE);
  const registryPath = reaPath(baseDir, REGISTRY_FILE);

  let policy;
  try {
    policy = loadPolicy(baseDir);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('not found')) exitWithMissingPolicy(policyPath);
    err(`Failed to load policy: ${message}`);
    process.exit(1);
  }

  let registry;
  try {
    registry = loadRegistry(baseDir);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('not found')) {
      err(`Registry file not found: ${registryPath}`);
      console.error('');
      console.error(
        '  Run `rea init` to create an empty registry, then edit it to declare downstream servers.',
      );
      console.error('');
      process.exit(1);
    }
    err(`Failed to load registry: ${message}`);
    process.exit(1);
  }

  // ── Observability setup (G5) ─────────────────────────────────────────────
  const sessionId = currentSessionId();
  // Use only the built-in SECRET_PATTERNS for the logger redactor. Policy
  // patterns are intentionally excluded: the logger applies regex
  // synchronously on the event-loop thread with no size cap, and downstream
  // error messages are attacker-influenced and can be arbitrarily long.
  // Combining operator-supplied patterns (which may backtrack badly) with
  // large error strings multiplied across the full pattern set could stall
  // the event loop during a failure event. The built-in patterns are
  // anchored and bounded; policy patterns are not guaranteed to be.
  // Field strings are hard-capped at MAX_LOG_FIELD_BYTES before any regex
  // runs — see applyRedactor in log.ts.
  const logRedactor = buildRegexRedactor(SECRET_PATTERNS);
  const logger = createLogger({
    level: resolveLogLevel(process.env['REA_LOG_LEVEL']),
    base: { session_id: sessionId },
    redactField: logRedactor,
  });

  const metricsRegistry = new MetricsRegistry();
  metricsRegistry.markHaltCheck();
  const metricsPort = resolveMetricsPort(process.env['REA_METRICS_PORT'], logger);

  let metricsServer: MetricsServer | undefined;
  if (metricsPort !== null) {
    try {
      metricsServer = await startMetricsServer({
        port: metricsPort,
        registry: metricsRegistry,
        logger,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // We do NOT fail gateway startup because of a metrics-bind failure —
      // observability is best-effort. Log loudly so the operator notices.
      logger.error({
        event: 'metrics.bind_failed',
        message: `failed to start /metrics on port ${metricsPort}: ${message}`,
      });
    }
  }

  const handle = createGateway({ baseDir, policy, registry, logger, metrics: metricsRegistry });

  // ── HALT acknowledgement at startup (G5) ─────────────────────────────────
  const haltPath = reaPath(baseDir, HALT_FILE);
  if (fs.existsSync(haltPath)) {
    logger.info({
      event: 'halt.acknowledged_at_startup',
      message:
        'HALT present at startup — every tool call will be denied until `.rea/HALT` is removed',
    });
  }

  // G11.3 — Codex availability probe. Observational only: a failed probe
  // NEVER fail-closes the gateway at startup. When the policy explicitly
  // opts out of Codex (`review.codex_required: false`), skip the probe
  // entirely — there are no Codex calls to observe, so the probe would be
  // noise on stderr.
  const codexRequired = policy.review?.codex_required !== false;
  let codexProbe: CodexProbe | undefined;
  if (codexRequired) {
    codexProbe = new CodexProbe();
    const initialState = await codexProbe.probe();
    if (!initialState.cli_responsive) {
      warn(
        `Codex probe failed — push-gate will use fallback reviewer path if triggered (${initialState.last_error ?? 'no error detail'})`,
      );
    }
    codexProbe.start();
  }

  // ── Pidfile + state (AFTER metrics boot so we persist the real port) ─────
  const startedAt = new Date().toISOString();
  const pidPath = writePidfile(baseDir);
  const statePath = writeStateFile(baseDir, {
    session_id: sessionId,
    started_at: startedAt,
    metrics_port: metricsServer?.port() ?? null,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    // A second signal (e.g. SIGTERM then SIGINT) must NOT re-enter cleanup —
    // `handle.stop()` is idempotent but `process.exit(0)` racing against
    // still-running unlink calls would be messy. One-shot guard.
    if (shuttingDown) return;
    shuttingDown = true;
    log(`rea serve: received ${signal} — draining and shutting down`);
    codexProbe?.stop();
    try {
      await handle.stop();
    } catch (e) {
      err(`shutdown error: ${e instanceof Error ? e.message : e}`);
    }
    if (metricsServer !== undefined) {
      try {
        await metricsServer.close();
      } catch {
        // Best-effort
      }
    }
    // Remove the breadcrumbs LAST and ONLY if we still own them. Another
    // `rea serve` in the same baseDir may have rewritten them — in that
    // case the newer instance's `rea status` users should keep seeing
    // "running".
    cleanupPidIfOwned(pidPath);
    cleanupStateIfOwned(statePath, sessionId);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log(
    `rea serve: policy profile=${policy.profile}, autonomy=${policy.autonomy_level}, downstream servers=${registry.servers.filter((s) => s.enabled).length}`,
  );
  try {
    await handle.start();
  } catch (e) {
    err(`gateway start failed: ${e instanceof Error ? e.message : e}`);
    // Clean up breadcrumbs before exit — a failed startup should not leave
    // a stale pidfile claiming we're up. Ownership-aware so we don't nuke
    // a sibling's breadcrumbs that raced in during our failing startup.
    cleanupPidIfOwned(pidPath);
    cleanupStateIfOwned(statePath, sessionId);
    if (metricsServer !== undefined) {
      try {
        await metricsServer.close();
      } catch {
        /* ignored */
      }
    }
    process.exit(1);
  }
}

// Exported for unit testing (the serve entry point itself is process-global).
export const __TEST_INTERNALS = {
  writeFileAtomic,
  writePidfile,
  writeStateFile,
  cleanupPidIfOwned,
  cleanupStateIfOwned,
};
