import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AutonomyLevel } from './types.js';
import type { Policy } from './types.js';

const LEVEL_ORDER: Record<AutonomyLevel, number> = {
  [AutonomyLevel.L0]: 0,
  [AutonomyLevel.L1]: 1,
  [AutonomyLevel.L2]: 2,
  [AutonomyLevel.L3]: 3,
};

const ContextProtectionSchema = z.object({
  delegate_to_subagent: z.array(z.string()).default([]),
  max_bash_output_lines: z.number().int().positive().optional(),
});

/**
 * G11.2: minimal review policy. Only `codex_required` is recognized today;
 * G11.4 will expand this (profile defaults, reviewer pin, token caps).
 * Kept strict so a typo (`codex_require`) fails loudly instead of silently
 * defaulting.
 */
const ReviewPolicySchema = z
  .object({
    codex_required: z.boolean().optional(),
  })
  .strict();

const PolicySchema = z
  .object({
    version: z.string(),
    profile: z.string(),
    installed_by: z.string(),
    installed_at: z.string(),
    autonomy_level: z.nativeEnum(AutonomyLevel),
    max_autonomy_level: z.nativeEnum(AutonomyLevel),
    promotion_requires_human_approval: z.boolean(),
    block_ai_attribution: z.boolean().default(false),
    blocked_paths: z.array(z.string()),
    notification_channel: z.string().default(''),
    injection_detection: z.enum(['block', 'warn']).optional(),
    context_protection: ContextProtectionSchema.optional(),
    review: ReviewPolicySchema.optional(),
  })
  .strict();

const DEFAULT_CACHE_TTL_MS = 30_000;
const POLICY_DIR = '.rea';
const POLICY_FILE = 'policy.yaml';

interface PolicyCacheEntry {
  policy: Policy;
  cachedAt: number;
  mtimeMs: number;
}

/**
 * SECURITY: Cache never serves a more permissive policy than disk.
 * mtime invalidation ensures policy tightening takes effect before TTL expires.
 */
const policyCache = new Map<string, PolicyCacheEntry>();

const inflightReads = new Map<string, Promise<Policy>>();

/**
 * Convert `{ key: undefined }` to omitted keys so Policy satisfies
 * exactOptionalPropertyTypes. Zod defaults produce explicit undefined.
 */
function stripUndefined(input: z.infer<typeof PolicySchema>): Policy {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) result[k] = v;
  }
  return result as unknown as Policy;
}

function applyMaxCeiling(policy: Policy): Policy {
  if (LEVEL_ORDER[policy.autonomy_level] > LEVEL_ORDER[policy.max_autonomy_level]) {
    console.error(
      `[rea] WARNING: autonomy_level ${policy.autonomy_level} exceeds max_autonomy_level ${policy.max_autonomy_level} — clamping to ${policy.max_autonomy_level}`,
    );
    return { ...policy, autonomy_level: policy.max_autonomy_level };
  }
  return policy;
}

function parseRawPolicy(raw: string, policyPath: string): Policy {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (yamlErr) {
    throw new Error(
      `Failed to parse policy YAML at ${policyPath}: ${yamlErr instanceof Error ? yamlErr.message : yamlErr}`,
    );
  }

  let parsedPolicy: z.infer<typeof PolicySchema>;
  try {
    parsedPolicy = PolicySchema.parse(parsed);
  } catch (zodErr) {
    throw new Error(
      `Invalid policy schema at ${policyPath}: ${zodErr instanceof Error ? zodErr.message : zodErr}`,
    );
  }

  return applyMaxCeiling(stripUndefined(parsedPolicy));
}

function policyPathFor(baseDir: string): string {
  return path.join(baseDir, POLICY_DIR, POLICY_FILE);
}

async function readPolicyFromDisk(
  baseDir: string,
  policyPath: string,
  currentMtime: number,
): Promise<Policy> {
  const raw = await fsPromises.readFile(policyPath, 'utf8');
  const policy = parseRawPolicy(raw, policyPath);
  policyCache.set(baseDir, { policy, cachedAt: Date.now(), mtimeMs: currentMtime });
  return policy;
}

/**
 * Async policy loader with TTL cache and mtime-based invalidation.
 *
 * TTL is configurable via REA_POLICY_CACHE_TTL_MS.
 *
 * SECURITY: mtime invalidation ensures a tightened policy takes effect on the next call.
 * CONCURRENCY: inflightReads map guarantees at most one disk read per baseDir at a time.
 */
export async function loadPolicyAsync(baseDir: string): Promise<Policy> {
  const policyPath = policyPathFor(baseDir);
  const ttlMs = Number(process.env.REA_POLICY_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS);
  const now = Date.now();

  let currentMtime: number;
  try {
    const stat = await fsPromises.stat(policyPath);
    currentMtime = stat.mtimeMs;
  } catch {
    throw new Error(`Policy file not found: ${policyPath}`);
  }

  const cached = policyCache.get(baseDir);
  if (cached !== undefined && cached.mtimeMs === currentMtime && now - cached.cachedAt < ttlMs) {
    return cached.policy;
  }

  const inflight = inflightReads.get(baseDir);
  if (inflight) return inflight;

  const read = readPolicyFromDisk(baseDir, policyPath, currentMtime).finally(() => {
    inflightReads.delete(baseDir);
  });
  inflightReads.set(baseDir, read);
  return read;
}

/**
 * Synchronous policy loader — for CLI startup paths that must be sync.
 * Does NOT use the cache — always reads from disk.
 *
 * Prefer loadPolicyAsync for middleware and any async context.
 */
export function loadPolicy(baseDir: string): Policy {
  const policyPath = policyPathFor(baseDir);

  if (!fs.existsSync(policyPath)) {
    throw new Error(`Policy file not found: ${policyPath}`);
  }

  const raw = fs.readFileSync(policyPath, 'utf8');
  return parseRawPolicy(raw, policyPath);
}

/**
 * Invalidate the cache for a given baseDir.
 * Exposed for testing — production code relies on TTL and mtime invalidation.
 */
export function invalidatePolicyCache(baseDir?: string): void {
  if (baseDir === undefined) {
    policyCache.clear();
  } else {
    policyCache.delete(baseDir);
  }
}

export { PolicySchema };
