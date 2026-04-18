import { loadPolicy } from '../policy/loader.js';
import { loadRegistry } from '../registry/loader.js';
import { createGateway } from '../gateway/server.js';
import { CodexProbe } from '../gateway/observability/codex-probe.js';
import {
  POLICY_FILE,
  REGISTRY_FILE,
  err,
  exitWithMissingPolicy,
  log,
  reaPath,
  warn,
} from './utils.js';

/**
 * `rea serve` — start the MCP gateway.
 *
 * Loads `.rea/policy.yaml` and `.rea/registry.yaml`, builds the middleware
 * chain, spawns downstream children from the registry, and connects an upstream
 * stdio MCP server that clients (Claude Code, Helix, etc.) can talk to.
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
      console.error('  Run `rea init` to create an empty registry, then edit it to declare downstream servers.');
      console.error('');
      process.exit(1);
    }
    err(`Failed to load registry: ${message}`);
    process.exit(1);
  }

  const handle = createGateway({ baseDir, policy, registry });

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

  const shutdown = async (signal: string): Promise<void> => {
    log(`rea serve: received ${signal} — draining and shutting down`);
    codexProbe?.stop();
    try {
      await handle.stop();
    } catch (e) {
      err(`shutdown error: ${e instanceof Error ? e.message : e}`);
    }
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
    process.exit(1);
  }
}
