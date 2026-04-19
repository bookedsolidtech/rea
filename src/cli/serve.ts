import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '../policy/loader.js';
import { loadRegistry } from '../registry/loader.js';
import { applyTofuGate } from '../registry/tofu-gate.js';
import { createGateway } from '../gateway/server.js';
import { CodexProbe } from '../gateway/observability/codex-probe.js';
import {
  MetricsRegistry,
  resolveMetricsPort,
  startMetricsServer,
  type MetricsServer,
} from '../gateway/observability/metrics.js';
import { createLogger, resolveLogLevel } from '../gateway/log.js';
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
 * Write the `.rea/serve.pid` breadcrumb so `rea status` can detect us.
 * This is NOT a supervisor lock (no stale-detection, no exclusive open) —
 * it's a read-only hint file. `rea status` independently checks
 * `kill(pid, 0)` before trusting it.
 */
function writePidfile(baseDir: string): string {
  const reaDir = path.join(baseDir, REA_DIR);
  if (!fs.existsSync(reaDir)) fs.mkdirSync(reaDir, { recursive: true });
  const pidPath = reaPath(baseDir, SERVE_PID_FILE);
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  return pidPath;
}

function writeStateFile(
  baseDir: string,
  state: { session_id: string; started_at: string; metrics_port: number | null },
): string {
  const p = reaPath(baseDir, SERVE_STATE_FILE);
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return p;
}

function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup — file may already be gone (SIGKILL, double-unlink).
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
  const logger = createLogger({
    level: resolveLogLevel(process.env['REA_LOG_LEVEL']),
    base: { session_id: sessionId },
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

  // G7: TOFU fingerprint gate. Runs BEFORE we build the downstream pool so
  // drifted servers are filtered out at the edge. First-seen and accepted
  // drift fire LOUD stderr + audit + log; the gateway stays up either way.
  // When the registry has zero enabled servers there is nothing to
  // fingerprint — skip the gate entirely to avoid a redundant disk write
  // on zero-server installs.
  let gatedRegistry = registry;
  const enabledServers = registry.servers.filter((s) => s.enabled);
  try {
    if (enabledServers.length > 0) {
      const { accepted } = await applyTofuGate(baseDir, enabledServers, logger);
      const acceptedNames = new Set(accepted.map((s) => s.name));
      gatedRegistry = {
        ...registry,
        servers: registry.servers.filter((s) => !s.enabled || acceptedNames.has(s.name)),
      };
    }
  } catch (e) {
    // Fail-closed on TOFU errors (e.g. corrupt fingerprint store). An attacker
    // who can corrupt the store must not be able to downgrade drift detection
    // by forcing the gateway into a "first-run" fallback. Surface the error
    // and exit — operator can delete the store deliberately to re-bootstrap.
    err(`TOFU gate failed: ${e instanceof Error ? e.message : e}`);
    console.error('');
    console.error('  To intentionally re-bootstrap the fingerprint store:');
    console.error('  1. Inspect .rea/fingerprints.json for tampering');
    console.error('  2. If safe, delete it and re-run `rea serve`');
    console.error('');
    process.exit(1);
  }

  const handle = createGateway({
    baseDir,
    policy,
    registry: gatedRegistry,
    logger,
    metrics: metricsRegistry,
  });

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
    // Remove the breadcrumbs LAST so external observers (rea status) can
    // still see "running" right up until the gateway is really gone.
    removeIfExists(pidPath);
    removeIfExists(statePath);
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
    // a stale pidfile claiming we're up.
    removeIfExists(pidPath);
    removeIfExists(statePath);
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
