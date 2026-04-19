/**
 * Registry server fingerprinting — G7 proxy-poisoning defense.
 *
 * ## Threat model
 *
 * The registry file (`.rea/registry.yaml`) is plain YAML on the operator's
 * disk. An attacker who lands a malicious template via `rea init`, or who
 * patches the file out-of-band (compromised dependency postinstall, CI-bot
 * misconfig, editor plugin writing through stale buffers), can silently swap
 * a downstream server's `command`, `args`, or `env` keys. The gateway would
 * spawn the new child at next startup and proxy it without challenge.
 *
 * Fingerprinting defends the **catalog-tampering** vector: we hash the
 * canonicalized server config on first sight (TOFU — trust on first use),
 * persist it to `.rea/fingerprints.json`, and on every subsequent boot refuse
 * to connect servers whose fingerprint has drifted without an explicit
 * one-shot acknowledgement (`REA_ACCEPT_DRIFT=<name>`).
 *
 * ## Scope: path-only, not binary
 *
 * We fingerprint the **config path** (name, command, args, env KEY SET,
 * env_passthrough, tier_overrides). We do NOT hash the binary contents at
 * `config.command`. Three reasons:
 *
 *   1. Binary hashing turns TOFU into a slow-boot tax — cold spawns already
 *      dominate first-run latency; adding N sha256-of-binary operations makes
 *      this worse on every restart.
 *   2. Legitimate MCP server upgrades (e.g. `@modelcontextprotocol/server-git`
 *      patch version bump) would legitimately change the binary content and
 *      would trip false-positive drift on every upgrade.
 *   3. The G7 threat model is **registry tampering** (YAML rewrite), which the
 *      canonicalized config hash covers cleanly. Host compromise — where an
 *      attacker swaps the on-disk binary at `config.command` — is a different
 *      G-number (supply-chain / host-integrity), not G7.
 *
 * ## Env values vs env keys
 *
 * We fingerprint the SORTED KEY SET of `config.env`, not the values. Values
 * frequently contain secrets (`GITHUB_TOKEN: ghp_...`) that the operator may
 * legitimately rotate; rotating a secret must not trip drift. Adding or
 * removing a key IS semantic change (new permission scope, new passthrough
 * surface) — that trips drift and is caught.
 */

import { createHash } from 'node:crypto';
import type { RegistryServer } from './types.js';

/**
 * Canonical representation of a server for fingerprinting. Field order is
 * fixed so JSON.stringify output is deterministic; arrays/keys are sorted.
 */
interface CanonicalServer {
  name: string;
  command: string;
  args: string[];
  env_keys: string[];
  env_passthrough: string[];
  tier_overrides: Array<[string, string]>;
}

function canonicalize(server: RegistryServer): CanonicalServer {
  const envKeys = Object.keys(server.env).sort();
  const passthrough = [...(server.env_passthrough ?? [])].sort();
  const overrides: Array<[string, string]> = Object.entries(server.tier_overrides ?? {})
    .map<[string, string]>(([k, v]) => [k, String(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    env_keys: envKeys,
    env_passthrough: passthrough,
    tier_overrides: overrides,
  };
}

/**
 * Compute a stable sha256 fingerprint of a registry server's config path.
 * Pure function — same input produces the same output forever.
 *
 * Two callers with the same server entry in different registries must get
 * the same fingerprint; two servers that differ in any material way (command,
 * args, env KEY presence, passthrough surface, tier override for any tool)
 * must get different fingerprints.
 */
export function fingerprintServer(server: RegistryServer): string {
  const canonical = canonicalize(server);
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Test hook: expose the canonical form so tests can assert what is and is
 * not included in the fingerprint input. Not part of the public API — no
 * consumer should depend on this shape remaining stable.
 */
export function __canonicalizeForTests(server: RegistryServer): CanonicalServer {
  return canonicalize(server);
}
