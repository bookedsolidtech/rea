/**
 * Registry loader — parses `.rea/registry.yaml`, validates with zod, and
 * caches the result with the same TTL + mtime-invalidation pattern as
 * `src/policy/loader.ts`. Keep the two loaders structurally similar; if one
 * gets a new invariant (e.g. cross-process locking), the other probably
 * needs it too.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { Tier } from '../policy/types.js';
import type { Registry, RegistryServer } from './types.js';

/**
 * Regex used to refuse passthrough of var names that look like secrets.
 * Explicit `env:` mapping is the escape hatch — if a user types the value into
 * the registry, the operator has consciously authorized it. Passthrough pulls
 * from the host environment silently, so we refuse secret-looking names there.
 */
const SECRET_NAME_HEURISTIC = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;

const RegistryServerSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        'server name must be lowercase-kebab and cannot start with a dash',
      ),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    env_passthrough: z
      .array(
        z
          .string()
          .regex(
            /^[A-Za-z_][A-Za-z0-9_]*$/,
            'env var name must match POSIX identifier syntax',
          )
          .refine(
            (name) => !SECRET_NAME_HEURISTIC.test(name),
            (name) => ({
              message: `env_passthrough refuses secret-looking name "${name}" — use an explicit env: mapping instead`,
            }),
          ),
      )
      .optional(),
    tier_overrides: z.record(z.nativeEnum(Tier)).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

const RegistrySchema = z
  .object({
    version: z.literal('1'),
    servers: z.array(RegistryServerSchema).default([]),
  })
  .strict();

const DEFAULT_CACHE_TTL_MS = 30_000;
const REA_DIR = '.rea';
const REGISTRY_FILE = 'registry.yaml';

interface CacheEntry {
  registry: Registry;
  cachedAt: number;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Registry>>();

function registryPathFor(baseDir: string): string {
  return path.join(baseDir, REA_DIR, REGISTRY_FILE);
}

function stripUndefined(input: z.infer<typeof RegistrySchema>): Registry {
  const servers: RegistryServer[] = input.servers.map((s) => {
    const out: RegistryServer = {
      name: s.name,
      command: s.command,
      args: s.args,
      env: s.env,
      enabled: s.enabled,
    };
    if (s.env_passthrough !== undefined) out.env_passthrough = s.env_passthrough;
    if (s.tier_overrides !== undefined) out.tier_overrides = s.tier_overrides;
    return out;
  });
  return { version: input.version, servers };
}

function parseRaw(raw: string, filePath: string): Registry {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse registry YAML at ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
  }
  // Empty file → treat as an empty registry so `rea init` + no edits still works.
  const normalized =
    parsed === null || parsed === undefined ? { version: '1', servers: [] } : parsed;
  try {
    return stripUndefined(RegistrySchema.parse(normalized));
  } catch (err) {
    throw new Error(
      `Invalid registry schema at ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function readFromDisk(
  baseDir: string,
  filePath: string,
  currentMtime: number,
): Promise<Registry> {
  const raw = await fsPromises.readFile(filePath, 'utf8');
  const registry = parseRaw(raw, filePath);
  cache.set(baseDir, { registry, cachedAt: Date.now(), mtimeMs: currentMtime });
  return registry;
}

/**
 * Async registry loader with TTL cache and mtime-based invalidation.
 * Mirrors the contract of `loadPolicyAsync` — see its header for the
 * security/concurrency rationale.
 */
export async function loadRegistryAsync(baseDir: string): Promise<Registry> {
  const filePath = registryPathFor(baseDir);
  const ttlMs = Number(process.env.REA_REGISTRY_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS);
  const now = Date.now();

  let currentMtime: number;
  try {
    const stat = await fsPromises.stat(filePath);
    currentMtime = stat.mtimeMs;
  } catch {
    throw new Error(`Registry file not found: ${filePath}`);
  }

  const cached = cache.get(baseDir);
  if (cached !== undefined && cached.mtimeMs === currentMtime && now - cached.cachedAt < ttlMs) {
    return cached.registry;
  }

  const pending = inflight.get(baseDir);
  if (pending) return pending;

  const read = readFromDisk(baseDir, filePath, currentMtime).finally(() => {
    inflight.delete(baseDir);
  });
  inflight.set(baseDir, read);
  return read;
}

/** Synchronous loader — for CLI startup paths. No cache. */
export function loadRegistry(baseDir: string): Registry {
  const filePath = registryPathFor(baseDir);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Registry file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return parseRaw(raw, filePath);
}

export function invalidateRegistryCache(baseDir?: string): void {
  if (baseDir === undefined) cache.clear();
  else cache.delete(baseDir);
}

export { RegistrySchema, RegistryServerSchema };
