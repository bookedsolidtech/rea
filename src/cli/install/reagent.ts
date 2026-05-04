/**
 * Translate a `.reagent/policy.yaml` into a `.rea/policy.yaml`-shaped payload.
 *
 * ## Explicit contract
 *
 * Reagent had a broader policy schema than rea. Most top-level fields either
 * transfer directly (same semantics) or are dropped because their governance
 * model changed. Dropping a security-relevant field silently would downgrade a
 * guarantee the user already expected — that is forbidden.
 *
 * Fields fall into one of three lists:
 *
 *   - **copy list**: copy verbatim into the rea policy.
 *   - **drop list**: SECURITY-RELEVANT fields that were removed or restructured
 *     in rea. If any drop-list field is present in the input policy, this
 *     function refuses to translate unless `acceptDropped === true`.
 *   - **ignore list**: non-governance fields (metadata, project name, notes)
 *     that are simply not written to the rea policy. No warning emitted.
 *
 * ## Autonomy clamping
 *
 * If the reagent policy's `max_autonomy_level` exceeds the chosen profile's
 * ceiling, we clamp down to the profile ceiling and record a notice. A reagent
 * install that allowed L3 cannot silently survive a migration into an
 * `open-source` profile capped at L2.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AutonomyLevel } from '../../policy/types.js';
import { ProfileSchema, type Profile } from '../../policy/profiles.js';

const LEVEL_RANK: Record<AutonomyLevel, number> = {
  [AutonomyLevel.L0]: 0,
  [AutonomyLevel.L1]: 1,
  [AutonomyLevel.L2]: 2,
  [AutonomyLevel.L3]: 3,
};

/** Fields transferred directly from reagent. Both schemas agree on semantics. */
const COPY_FIELDS = [
  'autonomy_level',
  'max_autonomy_level',
  'promotion_requires_human_approval',
  'blocked_paths',
  'context_protection',
  'block_ai_attribution',
] as const;

/**
 * SECURITY-RELEVANT fields that reagent supported but rea does not model the
 * same way (yet). Presence of any of these triggers a refusal unless the
 * caller explicitly opts in via `--accept-dropped-fields`. This list is
 * intentionally broader than the strict minimum — err on the side of asking.
 */
const DROP_FIELDS = [
  'push_review',
  'coverage',
  'security',
  'commit_review',
  'quality_gates',
] as const;

export interface TranslateOptions {
  /**
   * Upper bound on `max_autonomy_level`. Profile ceiling (typically L2).
   * If the reagent file declares a higher ceiling, we clamp and warn.
   */
  profileCeiling: AutonomyLevel;
  /** Set by `--accept-dropped-fields` on the CLI. */
  acceptDropped: boolean;
}

export interface TranslateResult {
  translated: Profile;
  notices: string[];
  droppedFields: string[];
  clampedAutonomy: boolean;
}

export class ReagentDroppedFieldsError extends Error {
  readonly dropped: string[];
  constructor(dropped: string[]) {
    super(
      `Reagent policy contains fields that rea does not model identically:\n` +
        dropped.map((f) => `  - ${f}`).join('\n') +
        `\n\nPass --accept-dropped-fields to continue. The dropped fields are\n` +
        `security-adjacent and will be silently removed — review the rea policy\n` +
        `after migration and restore equivalent guarantees by other means.`,
    );
    this.name = 'ReagentDroppedFieldsError';
    this.dropped = dropped;
  }
}

function readReagentPolicy(reagentPath: string): Record<string, unknown> {
  const raw = fs.readFileSync(reagentPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse reagent policy at ${reagentPath}: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Reagent policy at ${reagentPath} is not a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

function detectDropped(policy: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const f of DROP_FIELDS) {
    if (f in policy) found.push(f);
  }
  return found;
}

function extractCopyFields(policy: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of COPY_FIELDS) {
    if (f in policy) out[f] = policy[f];
  }
  return out;
}

/**
 * Translate the reagent policy at `reagentPath`, enforcing drop-list rules.
 *
 * @throws {ReagentDroppedFieldsError} if drop-list fields are present and
 *   `acceptDropped` is false.
 */
export function translateReagentPolicy(
  reagentPath: string,
  options: TranslateOptions,
): TranslateResult {
  if (!fs.existsSync(reagentPath)) {
    throw new Error(`Reagent policy not found at ${reagentPath}`);
  }
  const raw = readReagentPolicy(reagentPath);
  const dropped = detectDropped(raw);

  if (dropped.length > 0 && !options.acceptDropped) {
    throw new ReagentDroppedFieldsError(dropped);
  }

  const notices: string[] = [];
  if (dropped.length > 0) {
    for (const f of dropped) {
      notices.push(
        `dropped reagent field "${f}" — governance surface no longer modeled in rea policy`,
      );
    }
  }

  const copied = extractCopyFields(raw);

  // Validate the copied subset against the profile schema. This catches shape
  // drift (e.g. a reagent file with a malformed context_protection block).
  let validated: Profile;
  try {
    validated = ProfileSchema.parse(copied);
  } catch (err) {
    throw new Error(
      `Reagent-translated fields failed schema validation: ${err instanceof Error ? err.message : err}`,
    );
  }

  let clamped = false;
  if (validated.max_autonomy_level !== undefined) {
    const reagentCeilingRank = LEVEL_RANK[validated.max_autonomy_level];
    const profileCeilingRank = LEVEL_RANK[options.profileCeiling];
    if (reagentCeilingRank > profileCeilingRank) {
      notices.push(
        `clamping max_autonomy_level ${validated.max_autonomy_level} → ${options.profileCeiling} (profile ceiling)`,
      );
      validated.max_autonomy_level = options.profileCeiling;
      clamped = true;
    }
    // Also clamp autonomy_level if it now exceeds the ceiling.
    if (
      validated.autonomy_level !== undefined &&
      LEVEL_RANK[validated.autonomy_level] > LEVEL_RANK[validated.max_autonomy_level]
    ) {
      notices.push(
        `clamping autonomy_level ${validated.autonomy_level} → ${validated.max_autonomy_level} after ceiling clamp`,
      );
      validated.autonomy_level = validated.max_autonomy_level;
      clamped = true;
    }
  }

  return { translated: validated, notices, droppedFields: dropped, clampedAutonomy: clamped };
}

/**
 * Resolve the default reagent policy path inside a target directory.
 * Convenience for the CLI's `--from-reagent` flag.
 */
export function defaultReagentPath(targetDir: string): string {
  return path.join(targetDir, '.reagent', 'policy.yaml');
}
