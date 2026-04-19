/**
 * TOFU classifier — the G7 gate between `.rea/registry.yaml` and the
 * downstream pool.
 *
 * For each server declared in the registry, classify as:
 *
 *   - `first-seen` — no entry in `.rea/fingerprints.json`. Record the
 *     fingerprint, surface a LOUD block to the operator, allow the server
 *     to connect. This is the TOFU trust-on-first-use decision; the
 *     loudness is deliberate so a silent poisoning at first install is
 *     still visible in stderr / audit / logs.
 *
 *   - `unchanged` — fingerprint matches the stored value. Proceed normally.
 *
 *   - `drifted` — fingerprint differs from the stored value. Refuse to
 *     connect the server unless `REA_ACCEPT_DRIFT` names it for a single
 *     boot. The rest of the gateway stays up — other servers remain
 *     available, the upstream client just sees a smaller catalog.
 *
 * The audit entry, log line, and stderr block are emitted by the caller
 * (the gateway startup sequence). This module is pure classification plus
 * store updates; keeping it side-effect-free makes it unit-testable
 * without stubbing the filesystem or the audit chain.
 */

import type { RegistryServer } from './types.js';
import { fingerprintServer } from './fingerprint.js';
import type { FingerprintStore } from './fingerprints-store.js';
import { FINGERPRINT_STORE_VERSION } from './fingerprints-store.js';

export type TofuVerdict = 'first-seen' | 'unchanged' | 'drifted';

export interface TofuClassification {
  server: string;
  verdict: TofuVerdict;
  /** Current fingerprint (always present — we always compute it). */
  current: string;
  /** Stored fingerprint, when one existed. Absent for `first-seen`. */
  stored?: string;
  /** Whether `REA_ACCEPT_DRIFT` bypass was honored for this server. */
  bypassed: boolean;
}

export interface ClassifyOptions {
  /**
   * Raw value of `REA_ACCEPT_DRIFT`. Accepts a single server name or a
   * comma-separated list. Whitespace is trimmed. Empty or undefined means
   * no bypass.
   */
  acceptDrift?: string;
}

function parseAcceptDrift(raw?: string): Set<string> {
  if (raw === undefined || raw.trim() === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Classify every server in `servers` against the loaded `store`. Pure:
 * does not read or write the filesystem. Returns one classification per
 * server in the same order.
 */
export function classifyServers(
  servers: RegistryServer[],
  store: FingerprintStore,
  opts: ClassifyOptions = {},
): TofuClassification[] {
  const bypass = parseAcceptDrift(opts.acceptDrift);
  return servers.map((s) => {
    const current = fingerprintServer(s);
    const stored = store.servers[s.name];
    if (stored === undefined) {
      return { server: s.name, verdict: 'first-seen', current, bypassed: false };
    }
    if (stored === current) {
      return { server: s.name, verdict: 'unchanged', current, stored, bypassed: false };
    }
    return {
      server: s.name,
      verdict: 'drifted',
      current,
      stored,
      bypassed: bypass.has(s.name),
    };
  });
}

/**
 * Merge classifications into an updated store. Applies the TOFU rule:
 *
 *   - `first-seen`  → add the current fingerprint.
 *   - `unchanged`   → keep the existing value (no-op).
 *   - `drifted`     → if bypassed, overwrite with the current fingerprint
 *                     (operator has authorized the update); otherwise keep
 *                     the stored value (drift persists across restart until
 *                     explicitly accepted).
 *
 * Does not prune entries for servers that were removed from the registry —
 * that decision is the operator's, and silently dropping fingerprints
 * would let an attacker rename-then-reinstall a server to reset TOFU state.
 */
export function updateStore(
  store: FingerprintStore,
  classifications: TofuClassification[],
): FingerprintStore {
  const next: FingerprintStore = {
    version: FINGERPRINT_STORE_VERSION,
    servers: { ...store.servers },
  };
  for (const c of classifications) {
    if (c.verdict === 'first-seen') {
      next.servers[c.server] = c.current;
      continue;
    }
    if (c.verdict === 'drifted' && c.bypassed) {
      next.servers[c.server] = c.current;
    }
    // unchanged / drifted-no-bypass → leave store untouched for this server
  }
  return next;
}
