/**
 * Profile schema + merge helper used at `rea init` time.
 *
 * A profile is a named set of policy defaults shipped with the package under
 * `profiles/*.yaml`. Profiles are NOT a runtime indirection — at init time the
 * chosen profile is materialized literally into `.rea/policy.yaml`, so the
 * resulting file is self-contained and survives `npm uninstall @bookedsolid/rea`.
 *
 * Merge order (lowest to highest precedence):
 *   hardDefaults ← profile ← reagentTranslation ← wizardAnswers
 *
 * Hard defaults come from this module; profile YAMLs come from `profiles/`;
 * reagent translation is applied by `cli/install/reagent.ts`; wizard answers
 * come from `cli/init.ts` (interactive or `--yes`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AutonomyLevel } from './types.js';
import { PKG_ROOT } from '../cli/utils.js';

const ContextProtectionProfileSchema = z
  .object({
    delegate_to_subagent: z.array(z.string()).optional(),
    max_bash_output_lines: z.number().int().positive().optional(),
  })
  .strict();

/**
 * G9: injection tier-escalation knobs. Profile-layer schema mirrors the policy
 * loader's `InjectionPolicySchema` but leaves the flag fully optional so the
 * profile-default lives at the policy-loader layer (ships `false` by default).
 * Strict mode still rejects typos so a misspelled key fails loudly at init.
 */
const InjectionProfileSchema = z
  .object({
    suspicious_blocks_writes: z.boolean().optional(),
  })
  .strict();

/**
 * Profile is PolicySchema with every field optional. Strict mode still rejects
 * unknown keys so a typo in a profile YAML fails loudly at init time rather
 * than silently getting dropped on the floor.
 */
export const ProfileSchema = z
  .object({
    autonomy_level: z.nativeEnum(AutonomyLevel).optional(),
    max_autonomy_level: z.nativeEnum(AutonomyLevel).optional(),
    promotion_requires_human_approval: z.boolean().optional(),
    block_ai_attribution: z.boolean().optional(),
    blocked_paths: z.array(z.string()).optional(),
    protected_writes: z.array(z.string()).optional(),
    protected_paths_relax: z.array(z.string()).optional(),
    notification_channel: z.string().optional(),
    injection_detection: z.enum(['block', 'warn']).optional(),
    injection: InjectionProfileSchema.optional(),
    context_protection: ContextProtectionProfileSchema.optional(),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;

/** Hard defaults applied before any profile or wizard answer. */
export const HARD_DEFAULTS: Profile = {
  autonomy_level: AutonomyLevel.L1,
  max_autonomy_level: AutonomyLevel.L2,
  promotion_requires_human_approval: true,
  block_ai_attribution: true,
  blocked_paths: ['.env', '.env.*'],
  notification_channel: '',
};

/**
 * Shallow merge: `override` wins per top-level key when defined.
 * Arrays are replaced, not concatenated — a profile that declares
 * `blocked_paths` fully owns that list.
 */
export function mergeProfiles(base: Profile, override: Profile): Profile {
  const merged: Profile = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}

/**
 * Resolve `profiles/${name}.yaml` relative to the package root. Returns `null`
 * when the profile file is absent; callers should fall through to hard defaults
 * in that case and print a warning.
 */
export function loadProfile(name: string): Profile | null {
  const profilePath = path.join(PKG_ROOT, 'profiles', `${name}.yaml`);
  if (!fs.existsSync(profilePath)) return null;
  const raw = fs.readFileSync(profilePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse profile YAML at ${profilePath}: ${err instanceof Error ? err.message : err}`,
    );
  }
  // Empty YAML file → parseYaml returns null; treat as empty profile.
  if (parsed === null || parsed === undefined) return {};
  try {
    return ProfileSchema.parse(parsed);
  } catch (err) {
    throw new Error(
      `Invalid profile schema at ${profilePath}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
