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
  /** Environment variables merged onto the child process env. */
  env: Record<string, string>;
  /** Optional per-tool tier pins. Supplied verbatim to the tier middleware. */
  tier_overrides?: Record<string, Tier>;
  /** Set to `false` to keep the entry in the file but skip spawning. */
  enabled: boolean;
}

export interface Registry {
  version: '1';
  servers: RegistryServer[];
}
