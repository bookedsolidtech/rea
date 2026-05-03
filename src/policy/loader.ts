import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import safeRegex from 'safe-regex';
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
 * 0.11.0 push-gate review policy. Three knobs only — the stateless gate does
 * not have a cache and does not treat CI differently. Strict mode so typos
 * (`codex_require`, `concerns_block`) fail loudly rather than silently
 * defaulting. `rea upgrade` strips the removed 0.10.x fields
 * (`cache_max_age_seconds`, `allow_skip_in_ci`) from consumer policy files.
 */
const ReviewPolicySchema = z
  .object({
    codex_required: z.boolean().optional(),
    concerns_blocks: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional(),
    last_n_commits: z.number().int().positive().optional(),
    /**
     * Auto-narrow threshold (J / 0.13.0). When the resolved diff base is more
     * than N commits away from HEAD, the gate auto-scopes to
     * `last_n_commits` (or the 0.13 fallback default of 10) and emits a
     * stderr warning. Default 30 when unset; explicit 0 disables auto-narrow
     * entirely. Suppressed when the operator pinned `--last-n-commits`,
     * `--base`, or `policy.review.last_n_commits` (those are explicit
     * intent and auto-narrow stays out of the way).
     */
    auto_narrow_threshold: z.number().int().nonnegative().optional(),
    /**
     * Codex CLI model override (0.13.4+). Pinned via `-c model="<name>"` on
     * every `codex exec review` invocation. When unset, codex's own default
     * applies — which today is the special-purpose `codex-auto-review`
     * model at `medium` reasoning, NOT the flagship.
     *
     * For serious adversarial review on consumer codebases (where verdict
     * stability matters) the recommended setting is `gpt-5.4` with
     * `codex_reasoning_effort: high`. Higher reasoning trades push-gate
     * latency for finding consistency — fewer same-code-different-verdict
     * round-trips like the 2026-04-26 helixir migration session.
     *
     * Loose string type: codex's model catalog evolves over time and we do
     * NOT want to lock consumers to a hardcoded enum that drifts behind
     * upstream. Codex itself validates the model name at exec time.
     */
    codex_model: z.string().min(1).optional(),
    /**
     * Codex reasoning effort knob (0.13.4+). Pinned via
     * `-c model_reasoning_effort="<level>"` on every invocation. Only
     * meaningful when paired with a reasoning-capable model (gpt-5.4,
     * gpt-5.3-codex, etc.). The `codex-auto-review` model honors this
     * but caps lower than gpt-5.4.
     *
     * Recommended: `high` for serious review on long-running branches
     * (more compute spent per finding, fewer flips). `medium` is codex's
     * own default. `low` for cost-bounded environments where consistency
     * matters less than throughput.
     */
    codex_reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

/**
 * G3: user-supplied redaction pattern. `name` is audit-stable; `regex` is a
 * raw pattern source (no leading/trailing slashes); `flags` follows JS
 * RegExp flag semantics. Every pattern is passed through `safe-regex` at
 * load time — a flagged pattern rejects the entire policy load with an
 * error that names the offender.
 */
const UserRedactPatternSchema = z
  .object({
    name: z.string().min(1),
    regex: z.string().min(1),
    flags: z.string().optional(),
  })
  .strict();

const RedactPolicySchema = z
  .object({
    match_timeout_ms: z.number().int().positive().optional(),
    patterns: z.array(UserRedactPatternSchema).optional(),
  })
  .strict();

/**
 * G1: audit rotation thresholds. Both knobs optional; a policy that omits the
 * `audit` block (or the `audit.rotation` sub-block) retains 0.2.x behavior
 * with no rotation. Defaults are NOT baked into the schema — the rotator
 * resolves them at consumption time so absence remains distinguishable from
 * an explicit value.
 */
const AuditRotationPolicySchema = z
  .object({
    max_bytes: z.number().int().positive().optional(),
    max_age_days: z.number().int().positive().optional(),
  })
  .strict();

const AuditPolicySchema = z
  .object({
    rotation: AuditRotationPolicySchema.optional(),
  })
  .strict();

/**
 * G9: injection tier escalation. `suspicious_blocks_writes` is fully
 * optional at the schema layer — absence is distinguishable from an
 * explicit `false`. The middleware (`createInjectionMiddleware`) then
 * applies the action-aware default:
 *
 *   - `injection_detection: block` (default) + flag unset  → `true`
 *     (0.2.x parity — a single literal match at write/destructive tier
 *     still denies for upgraded consumers who omit the `injection:` block)
 *   - `injection_detection: block` + flag explicit `false` → `false`
 *     (explicit opt-out)
 *   - `injection_detection: warn`  + flag unset or `false` → `false`
 *     (warn mode preserves 0.2.x warn-only semantics)
 *   - flag explicit `true` (pinned in `bst-internal*`)      → `true`
 *
 * This avoids the Codex-reported regression in PR #25 where the schema
 * default of `false` silently loosened `injection_detection: block`
 * behavior on upgrade for non-bst consumers.
 *
 * `likely_injection` verdicts (multi-literal matches, base64-decoded matches,
 * or any read-tier match) are ALWAYS deny regardless of this flag.
 */
const InjectionPolicySchema = z
  .object({
    suspicious_blocks_writes: z.boolean().optional(),
  })
  .strict();

/**
 * BUG-011 (0.6.2) — gateway-level policy. Currently only the `health`
 * sub-block is defined; kept strict so typos (`gateway.heath`) fail loudly.
 */
const GatewayHealthPolicySchema = z
  .object({
    expose_diagnostics: z.boolean().optional(),
  })
  .strict();

const GatewayPolicySchema = z
  .object({
    health: GatewayHealthPolicySchema.optional(),
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
    // 0.16.3 F7: opt-in relax list. Consumers can list rea-managed
    // hard-protected patterns they want unblocked (e.g. `.husky/` to
    // author their own husky hooks). The kill-switch invariants
    // (`.rea/HALT`, `.rea/policy.yaml`, `.claude/settings.json`) are
    // ignored if listed — see hooks/_lib/protected-paths.sh.
    protected_paths_relax: z.array(z.string()).default([]),
    notification_channel: z.string().default(''),
    injection_detection: z.enum(['block', 'warn']).optional(),
    injection: InjectionPolicySchema.optional(),
    context_protection: ContextProtectionSchema.optional(),
    review: ReviewPolicySchema.optional(),
    redact: RedactPolicySchema.optional(),
    audit: AuditPolicySchema.optional(),
    gateway: GatewayPolicySchema.optional(),
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

/**
 * G3: run every user-supplied redact pattern through `safe-regex`. A flagged
 * pattern rejects the entire policy load with an error that names the
 * offender. Also verifies the pattern actually compiles — a malformed regex
 * source is a clear policy authoring bug and should fail loud.
 */
function checkUserRedactPatterns(policy: z.infer<typeof PolicySchema>, policyPath: string): void {
  const patterns = policy.redact?.patterns;
  if (!patterns || patterns.length === 0) return;

  for (const entry of patterns) {
    let compiled: RegExp;
    try {
      compiled = new RegExp(entry.regex, entry.flags);
    } catch (err) {
      throw new Error(
        `Invalid redact pattern "${entry.name}" at ${policyPath}: ` +
          `cannot compile regex ${JSON.stringify(entry.regex)}` +
          (entry.flags ? ` with flags ${JSON.stringify(entry.flags)}` : '') +
          ` — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!safeRegex(compiled)) {
      throw new Error(
        `Unsafe redact pattern "${entry.name}" at ${policyPath}: ` +
          `safe-regex flagged ${JSON.stringify(entry.regex)} as potentially ReDoS-vulnerable. ` +
          `Rewrite with bounded quantifiers / no nested repetition / no disjoint alternation.`,
      );
    }
  }
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

  // G3: reject unsafe user-supplied redaction patterns. This runs BEFORE
  // stripUndefined so the error references the user-authored field exactly.
  checkUserRedactPatterns(parsedPolicy, policyPath);

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
