/**
 * Type shapes for `.rea/registry.yaml`. The schema itself lives in
 * `./loader.ts` — this file carries only the static TS surface so call sites
 * can import types without dragging in zod.
 */

import type { Tier } from '../policy/types.js';

export interface RegistryServer {
  /** Lowercase-kebab identifier used as the tool-name prefix (`<name>__<tool>`). */
  name: string;
  /** Executable to spawn via stdio. Resolved through `PATH`. */
  command: string;
  /** Arguments passed to the spawned child process. */
  args: string[];
  /**
   * Environment variables merged onto the child process env. Values may
   * reference rea-serve's own `process.env` via `${VAR}` syntax — e.g.
   * `{ BOT_TOKEN: '${DISCORD_BOT_TOKEN}' }`. Only the curly-brace form is
   * supported; no `$VAR`, no defaults, no command substitution. If a
   * referenced var is unset at spawn time the affected server fails to
   * start (the rest of the gateway still comes up). See
   * `registry/interpolate.ts` for the full grammar and contract.
   */
  env: Record<string, string>;
  /**
   * Optional opt-in list of operator-env var names to forward into the child.
   * Names matching the secret-name heuristic (TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL)
   * are REFUSED at schema-parse time — use explicit `env:` mapping for those so
   * the operator is making the decision consciously.
   */
  env_passthrough?: string[];
  /** Optional per-tool tier pins. Supplied verbatim to the tier middleware. */
  tier_overrides?: Record<string, Tier>;
  /** Set to `false` to keep the entry in the file but skip spawning. */
  enabled: boolean;
}

/**
 * Allowed values for `Registry.reviewer`. Extensions land here — don't
 * accept unknown strings at parse time. The selector matches on these
 * exact tokens.
 */
export type RegistryReviewer = 'codex' | 'claude-self';

export interface Registry {
  version: '1';
  servers: RegistryServer[];
  /**
   * Optional operator pin for the adversarial reviewer. When set, takes
   * precedence over the default Codex-first selection but yields to the
   * `REA_REVIEWER` env var. Unknown values are rejected at schema-parse
   * time. Unset → default selector logic applies.
   */
  reviewer?: RegistryReviewer;
}
