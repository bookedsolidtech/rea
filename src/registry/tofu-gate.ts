/**
 * TOFU gate — the startup-time bridge between `classifyServers` and the
 * gateway's downstream pool.
 *
 * Responsibilities:
 *
 *  1. Load the current fingerprint store (or treat missing as first-run).
 *  2. Classify every server in the registry.
 *  3. Emit the side effects a classification implies:
 *       - `first-seen` → audit allowed, LOUD stderr block, log info.
 *       - `unchanged` → silent.
 *       - `drifted` (no bypass) → audit denied, stderr warn, log warn,
 *         and the server is FILTERED OUT of the returned set.
 *       - `drifted` (bypass via REA_ACCEPT_DRIFT) → log info, audit allowed
 *         with `bypassed: true` in metadata; server remains in the set.
 *  4. Persist the updated store.
 *
 * Returns the filtered `RegistryServer[]` the gateway should actually wire
 * into its `DownstreamPool`. Drifted-without-bypass servers are DROPPED here
 * so the pool never has a chance to spawn them — the gateway stays up,
 * other servers remain available, the upstream client just sees a smaller
 * tool catalog.
 */

import type { RegistryServer } from './types.js';
import { Tier, InvocationStatus } from '../policy/types.js';
import { appendAuditRecord } from '../audit/append.js';
import {
  loadFingerprintStore,
  saveFingerprintStore,
} from './fingerprints-store.js';
import {
  classifyServers,
  updateStore,
  type TofuClassification,
} from './tofu.js';
import { createLogger, type Logger } from '../gateway/log.js';

const TOFU_TOOL_NAME = 'rea.tofu';
const TOFU_SERVER_NAME = 'rea';

/** Inner box width (characters between the vertical borders). */
const BOX_INNER_WIDTH = 64;

/**
 * Render a line inside the TOFU banner box. Truncates overlong content with
 * an ellipsis so the right border stays aligned even if a server name or
 * label is unusually long. Pure string formatting — no side effects.
 */
function boxLine(content: string): string {
  const padded = ` ${content}`;
  const truncated =
    padded.length > BOX_INNER_WIDTH ? padded.slice(0, BOX_INNER_WIDTH - 1) + '…' : padded;
  return `  ║${truncated.padEnd(BOX_INNER_WIDTH, ' ')}║`;
}

export interface TofuGateResult {
  accepted: RegistryServer[];
  classifications: TofuClassification[];
}

/**
 * Apply the TOFU gate and return the filtered server set for the pool.
 *
 * Audit, stderr, and structured-log side effects all fire here. The caller
 * (gateway startup) does not need to repeat them.
 *
 * The optional `logger` is the G5 gateway logger threaded from `rea serve`.
 * When omitted (tests, doctor callers without a serve session), a default
 * logger is created so TOFU records always participate in structured output.
 */
export async function applyTofuGate(
  baseDir: string,
  servers: RegistryServer[],
  logger?: Logger,
): Promise<TofuGateResult> {
  const log = logger ?? createLogger();
  const store = await loadFingerprintStore(baseDir);
  const acceptDrift = process.env.REA_ACCEPT_DRIFT;
  const classifications = classifyServers(
    servers,
    store,
    acceptDrift !== undefined ? { acceptDrift } : {},
  );

  const byName = new Map(servers.map((s) => [s.name, s]));
  const accepted: RegistryServer[] = [];

  for (const c of classifications) {
    const server = byName.get(c.server);
    if (server === undefined) continue; // defensive — classifyServers preserves order
    await emitSideEffects(baseDir, c, log);
    if (c.verdict === 'drifted' && !c.bypassed) continue;
    accepted.push(server);
  }

  const nextStore = updateStore(store, classifications);
  await saveFingerprintStore(baseDir, nextStore);

  return { accepted, classifications };
}

async function emitSideEffects(
  baseDir: string,
  c: TofuClassification,
  log: Logger,
): Promise<void> {
  if (c.verdict === 'unchanged') return;

  if (c.verdict === 'first-seen') {
    // LOUD stderr — deliberately eye-catching. An attacker landing a poisoned
    // registry at first install is the exact case this surface defends.
    process.stderr.write(
      [
        '',
        `  ╔${'═'.repeat(BOX_INNER_WIDTH)}╗`,
        boxLine(' rea TOFU: NEW DOWNSTREAM SERVER RECORDED'),
        `  ╠${'═'.repeat(BOX_INNER_WIDTH)}╣`,
        boxLine(` name:        ${c.server}`),
        boxLine(` fingerprint: ${c.current.slice(0, 16)}…`),
        boxLine(''),
        boxLine(' If you did not add this server, STOP and inspect'),
        boxLine(' .rea/registry.yaml before any tool call executes.'),
        `  ╚${'═'.repeat(BOX_INNER_WIDTH)}╝`,
        '',
      ].join('\n'),
    );
    log.info({
      event: 'registry.tofu.first_seen',
      message: `TOFU: new downstream server "${c.server}" recorded on first start`,
      server_name: c.server,
      fingerprint: c.current,
    });
    await safeAudit(baseDir, log, {
      status: InvocationStatus.Allowed,
      metadata: {
        event: 'tofu.first_seen',
        server: c.server,
        fingerprint: c.current,
      },
    });
    return;
  }

  // verdict === 'drifted'
  if (c.bypassed) {
    // Intentionally quieter than the unbypassed block: the operator set
    // REA_ACCEPT_DRIFT, so this is authorized rotation and does not need
    // the blocking banner. A single stderr line + warn-level log + audit
    // entry is the documented UI for accepted drift.
    process.stderr.write(
      `[rea] TOFU: accepting drift for "${c.server}" (REA_ACCEPT_DRIFT set) — fingerprint rotated.\n`,
    );
    log.warn({
      event: 'registry.tofu.drift_accepted',
      message: `TOFU: accepted fingerprint drift for "${c.server}" (REA_ACCEPT_DRIFT bypass)`,
      server_name: c.server,
      stored: c.stored,
      current: c.current,
    });
    await safeAudit(baseDir, log, {
      status: InvocationStatus.Allowed,
      metadata: {
        event: 'tofu.drift_accepted',
        server: c.server,
        stored_fingerprint: c.stored,
        current_fingerprint: c.current,
        bypassed: true,
      },
    });
    return;
  }

  process.stderr.write(
    [
      '',
      `  ╔${'═'.repeat(BOX_INNER_WIDTH)}╗`,
      boxLine(' rea TOFU: FINGERPRINT DRIFT — SERVER BLOCKED'),
      `  ╠${'═'.repeat(BOX_INNER_WIDTH)}╣`,
      boxLine(` name:    ${c.server}`),
      boxLine(` stored:  ${(c.stored ?? '').slice(0, 16)}…`),
      boxLine(` current: ${c.current.slice(0, 16)}…`),
      boxLine(''),
      boxLine(' The server will NOT connect. Other servers remain up.'),
      boxLine(' After a legitimate registry edit:'),
      boxLine(`   rea tofu accept ${c.server} --reason "<why>"`),
      boxLine(' One-shot bypass (not recommended):'),
      boxLine(`   REA_ACCEPT_DRIFT=${c.server} rea serve`),
      `  ╚${'═'.repeat(BOX_INNER_WIDTH)}╝`,
      '',
    ].join('\n'),
  );
  log.warn({
    event: 'registry.tofu.drift_blocked',
    message: `TOFU: server fingerprint changed for "${c.server}" — possible proxy poisoning, server blocked`,
    server_name: c.server,
    stored: c.stored,
    current: c.current,
  });
  await safeAudit(baseDir, log, {
    status: InvocationStatus.Denied,
    error: `fingerprint drift for "${c.server}" — server blocked (set REA_ACCEPT_DRIFT to accept)`,
    metadata: {
      event: 'tofu.drift_blocked',
      server: c.server,
      stored_fingerprint: c.stored,
      current_fingerprint: c.current,
    },
  });
}

/**
 * Append a TOFU audit record. Errors in the audit path are logged but
 * never propagated — an audit-log outage must not take down the gateway.
 */
async function safeAudit(
  baseDir: string,
  log: Logger,
  entry: {
    status: InvocationStatus;
    error?: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const input = {
      tool_name: TOFU_TOOL_NAME,
      server_name: TOFU_SERVER_NAME,
      status: entry.status,
      tier: Tier.Read,
      metadata: entry.metadata,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    };
    await appendAuditRecord(baseDir, input);
  } catch (err) {
    log.error({
      event: 'registry.tofu.audit_failed',
      message: 'TOFU: audit append failed — gateway continues, record lost',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
