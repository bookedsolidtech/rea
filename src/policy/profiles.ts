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
    // 0.18.1+ helixir #9: profiles can ship audit-rotation defaults.
    // The full audit policy block validates at load time via
    // `AuditPolicySchema` in loader.ts; profiles only need to declare
    // the rotation knob (most consumer profiles will leave this empty
    // — the default 50 MiB / 30 days are sane).
    audit: z
      .object({
        rotation: z
          .object({
            max_bytes: z.number().int().positive().optional(),
            max_age_days: z.number().int().positive().optional(),
          })
          .optional(),
      })
      .optional(),
    // 0.20.1+ profiles can declare architecture-sensitive paths.
    architecture_review: z
      .object({
        patterns: z.array(z.string()).optional(),
      })
      .optional(),
    // 0.30.0+ attribution augmenter — every shipped profile pins
    // `enabled: false`. Opt-in is repo-local (.rea/policy.yaml edit)
    // because the identity to roll commits onto is per-developer; a
    // profile that pinned `enabled: true` would route every other
    // contributor's commits onto the profile author's heatmap.
    //
    // The profile-layer schema mirrors the policy-loader's
    // `AttributionPolicySchema` but does NOT apply the cross-field
    // refinement — a profile that ships `enabled: false` doesn't need
    // a `name`/`email` to validate. Cross-field validation only runs
    // at the policy-loader layer where the materialized file is parsed.
    attribution: z
      .object({
        co_author: z
          .object({
            enabled: z.boolean().optional(),
            name: z.string().optional(),
            email: z.string().optional(),
            skip_merge: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    // 0.31.0+ delegation-advisory nudge. `bst-internal*` profiles pin
    // `enabled: true`; external profiles ship `enabled: false`. The
    // profile-layer schema mirrors the policy-loader's
    // `DelegationAdvisoryPolicySchema` but leaves every field optional
    // — defaults are applied at the policy-loader layer when the
    // materialized file is parsed, so a profile that only declares
    // `enabled` doesn't need to also restate `threshold`. Strict mode
    // still rejects typos at init time.
    delegation_advisory: z
      .object({
        enabled: z.boolean().optional(),
        threshold: z.number().int().positive().optional(),
        exempt_subagents: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    // 0.49.0+ bootstrap allowlist (P3-1) — narrow CLI-missing pass-through
    // in `hooks/_lib/bootstrap-allowlist.sh`. The `bst-internal` profile
    // pins `enabled: true` for parity with `.rea/policy.yaml`; every other
    // shipped profile inherits the schema default (also `true`). The
    // profile-layer schema mirrors the policy-loader's
    // `BootstrapAllowlistPolicySchema`; strict mode catches typos at init.
    bootstrap_allowlist: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // 0.51.0 spend-governance (E1 seed) — billing→HALT reflex. EVERY
    // shipped profile pins `enabled: true` + `billing_error_response: halt`
    // (unlike delegation_advisory, this reflex has no false-positive cost
    // worth the risk). The profile-layer schema mirrors the policy-loader's
    // `SpendGovernancePolicySchema`; strict mode catches typos at init.
    // Fields are `.optional()` here so a profile can pin just `enabled`
    // without restating the response mode.
    spend_governance: z
      .object({
        enabled: z.boolean().optional(),
        billing_error_response: z.enum(['halt', 'warn', 'off']).optional(),
      })
      .strict()
      .optional(),
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
