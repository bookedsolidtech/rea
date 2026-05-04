/**
 * `rea tofu` — operator-facing recovery surface for TOFU fingerprint drift
 * (defect S).
 *
 * The TOFU gate in `src/registry/tofu-gate.ts` fail-closes on drift: an
 * enabled downstream whose canonical fingerprint no longer matches the stored
 * baseline is silently dropped from the spawn set. The only documented
 * recovery path used to be `REA_ACCEPT_DRIFT=<name>` as a startup env var,
 * which is useless when the gateway is spawned indirectly (e.g. by Claude
 * Code via `.mcp.json`) — there is no operator-reachable env in that path.
 *
 * This module provides two verbs:
 *
 *   - `list`            — print every declared server's current-vs-stored
 *                         fingerprint verdict so the operator can see drift
 *                         before reaching for `accept`.
 *   - `accept <name>`   — recompute the current fingerprint for `<name>` and
 *                         write it to `.rea/fingerprints.json`. Emits a
 *                         `tofu.drift_accepted_by_cli` audit record so the
 *                         action is on the hash chain.
 *
 * Both verbs are pure CLI surface — they do NOT speak to a running `rea
 * serve`. The next gateway boot re-runs `applyTofuGate` against the updated
 * store and classifies the server as `unchanged` with no banner.
 *
 * ## Trust model
 *
 * `accept` updates the stored baseline to match whatever the YAML currently
 * says. It is a **deliberate operator action**: anyone who can run `rea`
 * could already edit `.rea/fingerprints.json` by hand. The CLI is an
 * audit-recording wrapper over that capability, not a privilege expansion.
 *
 * The audit record captures BOTH fingerprints (stored + current) and the
 * registry canonical shape at accept-time, so a forensic re-hash of the
 * registry after the fact can confirm the operator accepted the shape they
 * intended to accept.
 */

import { appendAuditRecord } from '../audit/append.js';
import { InvocationStatus, Tier } from '../policy/types.js';
import { fingerprintServer } from '../registry/fingerprint.js';
import {
  FINGERPRINT_STORE_VERSION,
  loadFingerprintStore,
  saveFingerprintStore,
} from '../registry/fingerprints-store.js';
import { loadRegistry } from '../registry/loader.js';
import type { RegistryServer } from '../registry/types.js';
import { err, log } from './utils.js';

export type TofuVerdictLabel = 'first-seen' | 'unchanged' | 'drifted';

export interface TofuRow {
  name: string;
  enabled: boolean;
  current: string;
  stored: string | undefined;
  verdict: TofuVerdictLabel;
}

/** Pure classifier used by both `list` and `accept` — keep free of I/O. */
export function classifyRows(servers: RegistryServer[], stored: Record<string, string>): TofuRow[] {
  return servers.map((s) => {
    const current = fingerprintServer(s);
    const prior = stored[s.name];
    let verdict: TofuVerdictLabel;
    if (prior === undefined) verdict = 'first-seen';
    else if (prior === current) verdict = 'unchanged';
    else verdict = 'drifted';
    return {
      name: s.name,
      enabled: s.enabled !== false,
      current,
      stored: prior,
      verdict,
    };
  });
}

export interface RunTofuListOptions {
  json?: boolean;
}

export async function runTofuList(options: RunTofuListOptions = {}): Promise<void> {
  const baseDir = process.cwd();
  const registry = loadRegistry(baseDir);
  const store = await loadFingerprintStore(baseDir);
  const rows = classifyRows(registry.servers, store.servers);

  if (options.json === true) {
    process.stdout.write(JSON.stringify({ servers: rows }, null, 2) + '\n');
    return;
  }

  if (rows.length === 0) {
    log('No servers declared in .rea/registry.yaml.');
    return;
  }

  log('TOFU fingerprint status:');
  log('');
  for (const row of rows) {
    const shortCur = row.current.slice(0, 12);
    const shortPrior = row.stored !== undefined ? row.stored.slice(0, 12) : '—';
    const flag = row.enabled ? '' : ' (disabled)';
    log(
      `  ${row.verdict.padEnd(10)} ${row.name.padEnd(20)} stored=${shortPrior}  current=${shortCur}${flag}`,
    );
  }
  log('');
  const drifted = rows.filter((r) => r.verdict === 'drifted');
  if (drifted.length > 0) {
    log(
      `  ${drifted.length} drifted — run \`rea tofu accept <name>\` to rebase the stored fingerprint (emits an audit record).`,
    );
  }
}

export interface RunTofuAcceptOptions {
  name: string;
  reason?: string;
}

export async function runTofuAccept(options: RunTofuAcceptOptions): Promise<void> {
  const baseDir = process.cwd();
  const registry = loadRegistry(baseDir);
  const server = registry.servers.find((s) => s.name === options.name);
  if (server === undefined) {
    err(
      `Server "${options.name}" is not declared in .rea/registry.yaml. Run \`rea tofu list\` to see declared servers.`,
    );
    process.exit(1);
  }

  const current = fingerprintServer(server);
  const store = await loadFingerprintStore(baseDir);
  const stored = store.servers[server.name];

  if (stored === current) {
    log(
      `tofu: "${server.name}" already matches stored fingerprint (${current.slice(0, 12)}…) — no change written.`,
    );
    return;
  }

  const nextStore = {
    version: FINGERPRINT_STORE_VERSION as typeof FINGERPRINT_STORE_VERSION,
    servers: { ...store.servers, [server.name]: current },
  };
  await saveFingerprintStore(baseDir, nextStore);

  const event =
    stored === undefined ? 'tofu.first_seen_accepted_by_cli' : 'tofu.drift_accepted_by_cli';
  try {
    await appendAuditRecord(baseDir, {
      tool_name: 'rea.tofu',
      server_name: 'rea',
      tier: Tier.Write,
      status: InvocationStatus.Allowed,
      metadata: {
        event,
        server: server.name,
        stored_fingerprint: stored ?? null,
        current_fingerprint: current,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      },
    });
  } catch (auditErr) {
    err(
      `tofu: fingerprint updated, but audit append failed — operator MUST investigate: ${
        auditErr instanceof Error ? auditErr.message : String(auditErr)
      }`,
    );
    process.exit(2);
  }

  const shortPrior = stored !== undefined ? stored.slice(0, 12) : '(first-seen)';
  log(
    `tofu: accepted "${server.name}" — stored=${shortPrior} → current=${current.slice(0, 12)}. Next \`rea serve\` will classify as unchanged.`,
  );
}
