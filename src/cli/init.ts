import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { parse as parseYaml } from 'yaml';
import { AutonomyLevel } from '../policy/types.js';
import { HARD_DEFAULTS, loadProfile, mergeProfiles, type Profile } from '../policy/profiles.js';
import { copyArtifacts } from './install/copy.js';
import { ensureReaGitignore } from './install/gitignore.js';
import {
  canonicalSettingsSubsetHash,
  defaultDesiredHooks,
  mergeSettings,
  readSettings,
  writeSettingsAtomic,
} from './install/settings-merge.js';
import { installCommitMsgHook } from './install/commit-msg.js';
import { installPrepareCommitMsgHook } from './install/prepare-commit-msg.js';
import { installPrePushFallback } from './install/pre-push.js';
import { CodexProbe } from '../gateway/observability/codex-probe.js';
import { buildFragment, writeClaudeMdFragment } from './install/claude-md.js';
import {
  CLAUDE_MD_MANIFEST_PATH,
  SETTINGS_MANIFEST_PATH,
  enumerateCanonicalFiles,
} from './install/canonical.js';
import { writeManifestAtomic } from './install/manifest-io.js';
import type { InstallManifest, ManifestEntry } from './install/manifest-schema.js';
import { sha256OfBuffer, sha256OfFile } from './install/sha.js';
import {
  defaultReagentPath,
  ReagentDroppedFieldsError,
  translateReagentPolicy,
} from './install/reagent.js';
import { POLICY_FILE, REA_DIR, REGISTRY_FILE, err, getPkgVersion, log, warn } from './utils.js';

export interface InitOptions {
  yes?: boolean | undefined;
  fromReagent?: boolean | undefined;
  profile?: string | undefined;
  force?: boolean | undefined;
  acceptDroppedFields?: boolean | undefined;
  /**
   * G11.4: explicit override for Codex adversarial review. `true` forces
   * `review.codex_required: true` in the written policy; `false` forces
   * `false`. Undefined → derive default from the chosen profile name
   * (profiles whose name ends with `-no-codex` default to no-codex).
   *
   * Non-interactive semantics: in `--yes` mode the flag is honored
   * directly. Interactive mode confirms the flag value as the prompt's
   * initial value (but still prompts for a final answer).
   */
  codex?: boolean | undefined;
}

type ProfileName =
  | 'client-engagement'
  | 'bst-internal'
  | 'bst-internal-no-codex'
  | 'lit-wc'
  | 'open-source'
  | 'open-source-no-codex'
  | 'minimal';

const PROFILE_NAMES: ProfileName[] = [
  'minimal',
  'client-engagement',
  'bst-internal',
  'bst-internal-no-codex',
  'lit-wc',
  'open-source',
  'open-source-no-codex',
];

/**
 * Default value for the "Use Codex?" decision, derived from the profile
 * name. Profiles whose name ends in `-no-codex` default to false;
 * everything else defaults to true. This keeps the wizard aligned with
 * whatever profile preset the operator picked without hard-coding a
 * profile-to-bool map.
 */
function profileDefaultCodexRequired(profileName: ProfileName): boolean {
  return !profileName.endsWith('-no-codex');
}

const AUTONOMY_LEVELS: AutonomyLevel[] = [
  AutonomyLevel.L0,
  AutonomyLevel.L1,
  AutonomyLevel.L2,
  AutonomyLevel.L3,
];

interface ResolvedConfig {
  profile: ProfileName;
  autonomyLevel: AutonomyLevel;
  maxAutonomyLevel: AutonomyLevel;
  blockAiAttribution: boolean;
  blockedPaths: string[];
  notificationChannel: string;
  /**
   * G11.4: written to `.rea/policy.yaml` as `review.codex_required`. We
   * always emit the field explicitly — no implicit defaults — so an
   * operator reading the file sees the choice that was made at init time.
   */
  codexRequired: boolean;
  /**
   * Round-27 F6: preserved 0.26.0 local-review + commit-hygiene knobs.
   * Each is `undefined` when the operator never set it, in which case
   * the policy writer omits the corresponding line from the YAML output
   * (consumers fall through to the documented 0.26.0 defaults).
   */
  localReviewMode?: 'enforced' | 'off';
  localReviewRefuseAt?: 'push' | 'commit' | 'both';
  localReviewBypassEnvVar?: string;
  localReviewMaxAgeSeconds?: number;
  commitHygieneWarnAtCommits?: number;
  commitHygieneRefuseAtCommits?: number;
  /**
   * 0.30.0 attribution augmenter. Preserved across re-init from a prior
   * on-disk policy and seeded from the chosen profile on first install.
   * Every shipped profile pins `enabled: false`, so the default for new
   * installs is "block ready, opt in by editing the policy".
   */
  attributionCoAuthor?: {
    enabled?: boolean;
    name?: string;
    email?: string;
    skipMerge?: boolean;
  };
  fromReagent: boolean;
  reagentPolicyPath: string | null;
  reagentNotices: string[];
}

function detectReagentPolicy(targetDir: string): string | null {
  const reagentPolicy = defaultReagentPath(targetDir);
  return fs.existsSync(reagentPolicy) ? reagentPolicy : null;
}

function detectProjectName(targetDir: string): string {
  const pkgPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
    } catch {
      // fall through
    }
  }
  return path.basename(targetDir);
}

function levelRank(level: AutonomyLevel): number {
  return { L0: 0, L1: 1, L2: 2, L3: 3 }[level];
}

function isValidProfile(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value);
}

function cancel(message: string): never {
  p.cancel(message);
  process.exit(0);
}

/**
 * Build the final layered profile in the documented merge order:
 *   hardDefaults ← profile ← reagentTranslation ← wizardAnswers
 */
function resolveLayered(profileName: ProfileName, reagentTranslated: Profile | null): Profile {
  const profile = loadProfile(profileName);
  if (profile === null) {
    warn(`profile "${profileName}" not found on disk — using hard defaults only`);
    return { ...HARD_DEFAULTS };
  }
  let layered = mergeProfiles(HARD_DEFAULTS, profile);
  if (reagentTranslated !== null) {
    layered = mergeProfiles(layered, reagentTranslated);
  }
  return layered;
}

async function runWizard(
  options: InitOptions,
  targetDir: string,
  reagentPolicyPath: string | null,
  layeredBase: Profile,
  existingPolicy: ExistingPolicyValues | undefined = undefined,
): Promise<ResolvedConfig> {
  const projectName = detectProjectName(targetDir);
  p.intro(`rea init — ${projectName}`);

  let fromReagent = options.fromReagent === true;
  if (!fromReagent && reagentPolicyPath !== null) {
    const migrate = await p.confirm({
      message: `Found ${path.relative(targetDir, reagentPolicyPath)} — migrate from reagent?`,
      initialValue: true,
    });
    if (p.isCancel(migrate)) cancel('Init cancelled.');
    fromReagent = migrate === true;
  }

  // Profile selection
  let profileName: ProfileName;
  if (options.profile !== undefined) {
    if (!isValidProfile(options.profile)) {
      p.cancel(`Unknown profile: "${options.profile}". Valid: ${PROFILE_NAMES.join(', ')}`);
      process.exit(1);
    }
    profileName = options.profile;
    p.log.info(`Profile: ${profileName} (from --profile)`);
  } else {
    const picked = await p.select<ProfileName>({
      message: 'Pick a profile',
      initialValue: 'minimal',
      options: [
        { value: 'minimal', label: 'minimal', hint: 'bare policy, no extras (default)' },
        {
          value: 'client-engagement',
          label: 'client-engagement',
          hint: 'zero-trust client project',
        },
        { value: 'bst-internal', label: 'bst-internal', hint: 'internal BST projects' },
        { value: 'lit-wc', label: 'lit-wc', hint: 'Lit / web component libraries' },
        { value: 'open-source', label: 'open-source', hint: 'public OSS repos' },
      ],
    });
    if (p.isCancel(picked)) cancel('Init cancelled.');
    profileName = picked;
  }

  // 0.21.1: prefer the existing on-disk value over the profile default
  // so re-running `rea init` doesn't reset an operator's manual edit.
  const autonomyDefault =
    existingPolicy?.autonomyLevel ?? layeredBase.autonomy_level ?? AutonomyLevel.L1;
  const autonomyPick = await p.select<AutonomyLevel>({
    message:
      existingPolicy?.autonomyLevel !== undefined
        ? `Starting autonomy_level (current: ${existingPolicy.autonomyLevel})`
        : 'Starting autonomy_level',
    initialValue: autonomyDefault,
    options: [
      { value: AutonomyLevel.L0, label: 'L0', hint: 'read-only; every write needs approval' },
      { value: AutonomyLevel.L1, label: 'L1', hint: 'default — writes allowed, destructive gated' },
      { value: AutonomyLevel.L2, label: 'L2', hint: 'wider latitude; destructive ops allowed' },
      { value: AutonomyLevel.L3, label: 'L3', hint: 'full autonomy (rare — supervised only)' },
    ],
  });
  if (p.isCancel(autonomyPick)) cancel('Init cancelled.');
  const autonomyLevel = autonomyPick;

  const maxCandidates = AUTONOMY_LEVELS.filter((lvl) => levelRank(lvl) >= levelRank(autonomyLevel));
  // 0.21.1: prefer existing on-disk max_autonomy_level over profile default.
  const defaultMax: AutonomyLevel =
    (existingPolicy?.maxAutonomyLevel !== undefined &&
      maxCandidates.includes(existingPolicy.maxAutonomyLevel) &&
      existingPolicy.maxAutonomyLevel) ||
    (layeredBase.max_autonomy_level !== undefined &&
      maxCandidates.includes(layeredBase.max_autonomy_level) &&
      layeredBase.max_autonomy_level) ||
    maxCandidates.find((l) => l === AutonomyLevel.L2) ||
    autonomyLevel;

  const maxOptions = maxCandidates.map(
    (lvl): { value: AutonomyLevel; label: string; hint?: string } => {
      if (lvl === autonomyLevel) return { value: lvl, label: lvl, hint: 'same as starting level' };
      return { value: lvl, label: lvl };
    },
  );
  const maxPick = await p.select<AutonomyLevel>({
    message: 'max_autonomy_level (ceiling — cannot be exceeded at runtime)',
    initialValue: defaultMax,
    options: maxOptions as Parameters<typeof p.select<AutonomyLevel>>[0]['options'],
  });
  if (p.isCancel(maxPick)) cancel('Init cancelled.');
  const maxAutonomyLevel = maxPick;

  const attribPick = await p.confirm({
    message: 'Enforce block_ai_attribution (reject AI-authored commit trailers)?',
    initialValue: layeredBase.block_ai_attribution ?? true,
  });
  if (p.isCancel(attribPick)) cancel('Init cancelled.');
  const blockAiAttribution = attribPick === true;

  // G11.4: "Use Codex adversarial review?" — the default follows the
  // chosen profile (any `*-no-codex` profile defaults to No). An explicit
  // flag on the command line overrides that default for the initial value.
  const codexInitial =
    options.codex !== undefined ? options.codex : profileDefaultCodexRequired(profileName);
  const codexPick = await p.confirm({
    message: 'Use Codex adversarial review? (requires an OpenAI account — can be added later)',
    initialValue: codexInitial,
  });
  if (p.isCancel(codexPick)) cancel('Init cancelled.');
  const codexRequired = codexPick === true;

  p.outro('Config collected — installing files.');

  return {
    profile: profileName,
    autonomyLevel,
    maxAutonomyLevel,
    blockAiAttribution,
    blockedPaths: layeredBase.blocked_paths ?? ['.env', '.env.*'],
    notificationChannel: layeredBase.notification_channel ?? '',
    codexRequired,
    // Round-27 F6: the wizard does NOT prompt for the 0.26.0 knobs (they
    // are advanced config — most teams accept defaults). But when the
    // existing on-disk policy carries them, forward them verbatim so a
    // re-run preserves operator edits exactly the same way the --yes
    // path does.
    ...(existingPolicy?.localReviewMode !== undefined
      ? { localReviewMode: existingPolicy.localReviewMode }
      : {}),
    ...(existingPolicy?.localReviewRefuseAt !== undefined
      ? { localReviewRefuseAt: existingPolicy.localReviewRefuseAt }
      : {}),
    ...(existingPolicy?.localReviewBypassEnvVar !== undefined
      ? { localReviewBypassEnvVar: existingPolicy.localReviewBypassEnvVar }
      : {}),
    ...(existingPolicy?.localReviewMaxAgeSeconds !== undefined
      ? { localReviewMaxAgeSeconds: existingPolicy.localReviewMaxAgeSeconds }
      : {}),
    ...(existingPolicy?.commitHygieneWarnAtCommits !== undefined
      ? { commitHygieneWarnAtCommits: existingPolicy.commitHygieneWarnAtCommits }
      : {}),
    ...(existingPolicy?.commitHygieneRefuseAtCommits !== undefined
      ? { commitHygieneRefuseAtCommits: existingPolicy.commitHygieneRefuseAtCommits }
      : {}),
    // 0.30.0 attribution augmenter — preserved across re-init OR
    // seeded from the layered profile (every shipped profile pins
    // `enabled: false`). Conditional spread so undefined → key omitted
    // (the field is exact-optional).
    ...attributionConfigSpread(layeredBase, existingPolicy),
    fromReagent,
    reagentPolicyPath,
    reagentNotices: [],
  };
}

/**
 * Compute the attribution-augmenter config spread to inject into a
 * partial `ResolvedConfig` literal. Returns `{}` when neither the
 * existing on-disk policy nor the layered profile declared the
 * augmenter — the policy writer then omits the block entirely so
 * consumers who haven't seen 0.30.0 don't get a mystery YAML block.
 *
 * Returns `{ attributionCoAuthor: ... }` otherwise. Using a spread
 * helper instead of a value-returning function lets `exactOptionalProperty
 * Types` distinguish "omitted" from "explicitly undefined" — required
 * by the strict tsconfig.
 */
function attributionConfigSpread(
  layered: Profile,
  existing: ExistingPolicyValues | undefined,
): { attributionCoAuthor?: NonNullable<ResolvedConfig['attributionCoAuthor']> } {
  const preserved = existing?.attributionCoAuthor;
  if (preserved !== undefined) {
    return {
      attributionCoAuthor: {
        ...(preserved.enabled !== undefined ? { enabled: preserved.enabled } : {}),
        ...(preserved.name !== undefined ? { name: preserved.name } : {}),
        ...(preserved.email !== undefined ? { email: preserved.email } : {}),
        ...(preserved.skipMerge !== undefined ? { skipMerge: preserved.skipMerge } : {}),
      },
    };
  }
  const fromProfile = layered.attribution?.co_author;
  if (fromProfile === undefined) return {};
  return {
    attributionCoAuthor: {
      ...(fromProfile.enabled !== undefined ? { enabled: fromProfile.enabled } : {}),
      ...(fromProfile.name !== undefined && fromProfile.name.length > 0
        ? { name: fromProfile.name }
        : {}),
      ...(fromProfile.email !== undefined && fromProfile.email.length > 0
        ? { email: fromProfile.email }
        : {}),
      ...(fromProfile.skip_merge !== undefined ? { skipMerge: fromProfile.skip_merge } : {}),
    },
  };
}

/**
 * G6 — Codex install-assist probe.
 *
 * Runs a single {@link CodexProbe} attempt and prints a guidance block when
 * the CLI is NOT responsive. Behavior:
 *
 *   - `cli_responsive === true`  → print a single-line "Codex CLI detected"
 *     acknowledgement (informational, not verbose).
 *   - `cli_responsive === false` → print a 4-line install guidance block
 *     naming the Claude Code helper that installs Codex.
 *
 * Failure of the probe itself is never fatal — a hung CLI must not stall
 * `rea init`. The probe class already caps each subcommand at 2s/5s. Any
 * throw bubbling out here is caught and treated as "not responsive".
 *
 * We deliberately reference the user-visible helper path (`/codex:setup`)
 * rather than shelling out to install Codex ourselves. `rea init` does not
 * auto-install third-party tooling; the operator signs off.
 */
async function printCodexInstallAssist(): Promise<void> {
  let responsive = false;
  let versionLine: string | undefined;
  try {
    const state = await new CodexProbe().probe();
    responsive = state.cli_responsive;
    versionLine = state.version;
  } catch {
    // probe() is documented as never-throws, but belt-and-suspenders.
    responsive = false;
  }

  console.log('');
  if (responsive) {
    const suffix = versionLine !== undefined ? ` (${versionLine})` : '';
    console.log(`Codex CLI detected${suffix}.`);
    return;
  }
  console.log('Codex CLI not detected on PATH.');
  console.log('  Adversarial review via `/codex-review` requires the Codex plugin.');
  console.log('  Install via the Claude Code Codex plugin helper: `/codex:setup`,');
  console.log('  or set `review.codex_required: false` in .rea/policy.yaml to opt out.');
}

/**
 * 0.21.1: user-mutable policy values preserved across `rea init` re-runs.
 * Each field is undefined when the existing policy didn't set it.
 */
interface ExistingPolicyValues {
  profile?: ProfileName;
  autonomyLevel?: AutonomyLevel;
  maxAutonomyLevel?: AutonomyLevel;
  blockAiAttribution?: boolean;
  blockedPaths?: string[];
  notificationChannel?: string;
  codexRequired?: boolean;
  /**
   * Round-27 F6 fix: preserve 0.26.0 local-review + commit-hygiene knobs
   * across `rea init` re-runs. Pre-fix, a team opting out via
   * `mode: off` got silently reverted on the next `rea init`, defeating
   * the off-switch documented as a FIRST-class concern.
   *
   * Each field is `undefined` when the existing policy didn't set it,
   * so the writer can distinguish "operator made an explicit choice"
   * from "use the 0.26.0 documented default".
   */
  localReviewMode?: 'enforced' | 'off';
  localReviewRefuseAt?: 'push' | 'commit' | 'both';
  localReviewBypassEnvVar?: string;
  localReviewMaxAgeSeconds?: number;
  commitHygieneWarnAtCommits?: number;
  commitHygieneRefuseAtCommits?: number;
  /**
   * 0.30.0 attribution augmenter. Preserved across `rea init` re-runs
   * so an operator who set `attribution.co_author.enabled: true` with
   * a configured identity does not silently get reverted to the
   * profile-default `enabled: false` on the next init.
   */
  attributionCoAuthor?: {
    enabled?: boolean;
    name?: string;
    email?: string;
    skipMerge?: boolean;
  };
}

/**
 * Read user-mutable values from an existing `.rea/policy.yaml`.
 * Returns undefined when the file doesn't exist or fails to parse.
 *
 * The reader is permissive — any field that fails to extract is
 * dropped from the result; the caller falls back to the profile
 * default for that one field. This is the idempotency contract
 * extension introduced in 0.17.0 (`installed_at` preservation),
 * extended in 0.21.1 to cover every field an operator might
 * manually edit between init runs.
 *
 * Profile-switch is allowed but advisory: when the existing
 * `profile:` value disagrees with the requested one, the existing
 * VALUES are still preserved. Operators who want full reset pass
 * `--force` to bypass the file-existence check entirely.
 */
/**
 * Round-30 F3 (structural): read the existing policy via the canonical
 * YAML parser instead of regex-scraping the raw text.
 *
 * Pre-fix the preservation reader used independent line-anchored regexes
 * (`^\s+mode:`, `^\s+warn_at_commits:`, etc.) that ONLY matched
 * block-form scalars. The TS loader (and `policy_nested_scalar` in the
 * bash hooks) accept inline mappings — `local_review: { mode: off }` —
 * but the regex preservation slipped them through, leaving the values
 * `undefined` after re-read. The writer then skipped emission, and the
 * inline block vanished entirely on a `rea init` re-run. Round-trip
 * lossy across the inline/block divergence.
 *
 * Structural fix: parse the YAML once, walk the resulting object tree,
 * and read each preservation key by dotted path. Inline AND block forms
 * agree at the parsed layer — the parser folds both into the same
 * object shape — so this fix closes the inline/block divergence for
 * EVERY preservation key (the round-29 cross-cutting observation), not
 * just the 6 round-28 fields.
 *
 * Failure modes handled:
 *   - Policy file missing — returns undefined (caller falls back to
 *     profile defaults; same behavior as pre-fix).
 *   - YAML malformed — returns undefined (same as pre-fix; the regex
 *     reader returned undefined on any thrown read error).
 *   - YAML parses but is null / not an object — returns an empty
 *     ExistingPolicyValues (no fields to preserve; profile defaults
 *     fill in).
 *   - Individual fields wrong type — silently dropped (permissive
 *     contract, same as the previous regex reader).
 */
function readExistingPolicyForPreservation(targetDir: string): ExistingPolicyValues | undefined {
  const policyPath = path.join(targetDir, REA_DIR, POLICY_FILE);
  if (!fs.existsSync(policyPath)) return undefined;
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(policyPath, 'utf8');
    parsed = parseYaml(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    // Empty / non-mapping document — nothing to preserve, but signal
    // the caller that the file did exist (pre-fix returned `out` even
    // for a fully-empty file because every regex missed without
    // throwing). Returning `{}` matches that pre-fix shape.
    return {};
  }
  const policy = parsed as Record<string, unknown>;
  const out: ExistingPolicyValues = {};

  // Top-level scalars.
  const profile = policy['profile'];
  if (typeof profile === 'string' && /^[a-z0-9-]+$/.test(profile)) {
    out.profile = profile as ProfileName;
  }
  const autonomyLevel = policy['autonomy_level'];
  if (
    typeof autonomyLevel === 'string' &&
    (Object.values(AutonomyLevel) as string[]).includes(autonomyLevel)
  ) {
    out.autonomyLevel = autonomyLevel as AutonomyLevel;
  }
  const maxAutonomyLevel = policy['max_autonomy_level'];
  if (
    typeof maxAutonomyLevel === 'string' &&
    (Object.values(AutonomyLevel) as string[]).includes(maxAutonomyLevel)
  ) {
    out.maxAutonomyLevel = maxAutonomyLevel as AutonomyLevel;
  }
  const blockAiAttribution = policy['block_ai_attribution'];
  if (typeof blockAiAttribution === 'boolean') out.blockAiAttribution = blockAiAttribution;

  // blocked_paths is an array of strings. Pre-fix only preserved a
  // non-empty list (an explicit `blocked_paths: []` fell through to
  // profile defaults). Match that contract: skip the assignment when
  // the parsed value is empty / wrong shape.
  const blockedPaths = policy['blocked_paths'];
  if (Array.isArray(blockedPaths)) {
    const collected = blockedPaths.filter((v): v is string => typeof v === 'string');
    if (collected.length > 0) out.blockedPaths = collected;
  }

  const notificationChannel = policy['notification_channel'];
  if (typeof notificationChannel === 'string') out.notificationChannel = notificationChannel;

  // Nested review.* knobs. Inline form `review: { codex_required: true }`
  // and block form both fold to the same object at the parser layer.
  const review = policy['review'];
  if (review !== null && typeof review === 'object') {
    const r = review as Record<string, unknown>;
    if (typeof r['codex_required'] === 'boolean') out.codexRequired = r['codex_required'];

    // local_review.* — round-28 F6 + round-30 F3 fields.
    const localReview = r['local_review'];
    if (localReview !== null && typeof localReview === 'object') {
      const lr = localReview as Record<string, unknown>;
      const mode = lr['mode'];
      if (mode === 'enforced' || mode === 'off') out.localReviewMode = mode;
      const refuseAt = lr['refuse_at'];
      if (refuseAt === 'push' || refuseAt === 'commit' || refuseAt === 'both') {
        out.localReviewRefuseAt = refuseAt;
      }
      const bypassEnvVar = lr['bypass_env_var'];
      if (typeof bypassEnvVar === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(bypassEnvVar)) {
        out.localReviewBypassEnvVar = bypassEnvVar;
      }
      const maxAge = lr['max_age_seconds'];
      if (typeof maxAge === 'number' && Number.isFinite(maxAge) && maxAge > 0) {
        out.localReviewMaxAgeSeconds = maxAge;
      }
    }
  }

  // commit_hygiene.* — top-level (NOT nested under review). Inline form
  // `commit_hygiene: { warn_at_commits: 3 }` and block form both work.
  const commitHygiene = policy['commit_hygiene'];
  if (commitHygiene !== null && typeof commitHygiene === 'object') {
    const ch = commitHygiene as Record<string, unknown>;
    const warnAt = ch['warn_at_commits'];
    if (typeof warnAt === 'number' && Number.isFinite(warnAt) && warnAt >= 0) {
      out.commitHygieneWarnAtCommits = warnAt;
    }
    const refuseAt = ch['refuse_at_commits'];
    if (typeof refuseAt === 'number' && Number.isFinite(refuseAt) && refuseAt >= 0) {
      out.commitHygieneRefuseAtCommits = refuseAt;
    }
  }

  // 0.30.0 attribution augmenter. Preserve every field the operator
  // may have configured so re-running `rea init` doesn't silently
  // revert an opt-in. Block AND inline forms agree at the parser
  // layer.
  const attribution = policy['attribution'];
  if (attribution !== null && typeof attribution === 'object') {
    const attr = attribution as Record<string, unknown>;
    const coAuthor = attr['co_author'];
    if (coAuthor !== null && typeof coAuthor === 'object') {
      const ca = coAuthor as Record<string, unknown>;
      const preserved: NonNullable<ExistingPolicyValues['attributionCoAuthor']> = {};
      let any = false;
      if (typeof ca['enabled'] === 'boolean') {
        preserved.enabled = ca['enabled'];
        any = true;
      }
      if (typeof ca['name'] === 'string') {
        preserved.name = ca['name'];
        any = true;
      }
      if (typeof ca['email'] === 'string') {
        preserved.email = ca['email'];
        any = true;
      }
      if (typeof ca['skip_merge'] === 'boolean') {
        preserved.skipMerge = ca['skip_merge'];
        any = true;
      }
      if (any) out.attributionCoAuthor = preserved;
    }
  }

  return out;
}

function readExistingInstalledAt(policyPath: string): string | undefined {
  try {
    if (!fs.existsSync(policyPath)) return undefined;
    const raw = fs.readFileSync(policyPath, 'utf8');
    const m = raw.match(/^installed_at:\s*"([^"]+)"\s*$/m);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

function writePolicyYaml(targetDir: string, config: ResolvedConfig, layered: Profile): string {
  const policyPath = path.join(targetDir, REA_DIR, POLICY_FILE);
  const installedBy = process.env.USER ?? os.userInfo().username ?? 'unknown';
  // 0.17.0 idempotency: preserve the original `installed_at` if a policy
  // already exists. Without this, every `rea init` re-stamps the field
  // and produces a non-idempotent diff. The first install date is the
  // semantically correct value — re-runs reflect refreshes, not new
  // installs. Falls back to `new Date()` only when the file is absent
  // or unparseable.
  const installedAt = readExistingInstalledAt(policyPath) ?? new Date().toISOString();

  const lines: string[] = [];
  lines.push(`# .rea/policy.yaml — managed by rea v${getPkgVersion()}`);
  lines.push(
    `# Edit carefully: tightening takes effect on next load; loosening requires human approval.`,
  );
  lines.push(`version: "1"`);
  lines.push(`profile: ${JSON.stringify(config.profile)}`);
  lines.push(`installed_by: ${JSON.stringify(installedBy)}`);
  lines.push(`installed_at: ${JSON.stringify(installedAt)}`);
  lines.push(`autonomy_level: ${config.autonomyLevel}`);
  lines.push(`max_autonomy_level: ${config.maxAutonomyLevel}`);
  lines.push(`promotion_requires_human_approval: true`);
  lines.push(`block_ai_attribution: ${config.blockAiAttribution ? 'true' : 'false'}`);
  lines.push(`blocked_paths:`);
  for (const bp of config.blockedPaths) {
    lines.push(`  - ${JSON.stringify(bp)}`);
  }
  lines.push(`notification_channel: ${JSON.stringify(config.notificationChannel)}`);

  // Preserve injection_detection and context_protection if the layered profile
  // carried them (e.g. bst-internal). These are pass-through fields.
  if (layered.injection_detection !== undefined) {
    lines.push(`injection_detection: ${layered.injection_detection}`);
  }
  // G9: preserve `injection.suspicious_blocks_writes` when the layered profile
  // pinned it (bst-internal/bst-internal-no-codex pin `true`). External profiles
  // leave this unset so the policy loader's schema default (`false`) applies,
  // which keeps 0.2.x consumers from being silently tightened on upgrade.
  if (layered.injection?.suspicious_blocks_writes !== undefined) {
    lines.push(`injection:`);
    lines.push(
      `  suspicious_blocks_writes: ${layered.injection.suspicious_blocks_writes ? 'true' : 'false'}`,
    );
  }
  if (layered.context_protection !== undefined) {
    lines.push(`context_protection:`);
    const cp = layered.context_protection;
    if (cp.delegate_to_subagent !== undefined) {
      lines.push(`  delegate_to_subagent:`);
      for (const cmd of cp.delegate_to_subagent) {
        lines.push(`    - ${JSON.stringify(cmd)}`);
      }
    }
    if (cp.max_bash_output_lines !== undefined) {
      lines.push(`  max_bash_output_lines: ${cp.max_bash_output_lines}`);
    }
  }

  // 0.20.1+ helix-round-N P2: emit architecture_review.patterns when
  // the layered profile declared them. Consumers without patterns see
  // a silent no-op from architecture-review-gate.sh.
  if (layered.architecture_review?.patterns !== undefined) {
    lines.push(`architecture_review:`);
    lines.push(`  patterns:`);
    for (const p of layered.architecture_review.patterns) {
      lines.push(`    - ${JSON.stringify(p)}`);
    }
  }

  // 0.30.0 attribution augmenter — emit the block whenever the layered
  // profile (or a preserved on-disk policy) declared it. We always emit
  // a fully-explicit `enabled` so an operator reading the file can
  // confirm the current state at a glance without falling back to
  // schema defaults. Identity (name/email) is omitted when empty —
  // operators opt in by hand-editing those two fields, which keeps
  // the policy file diff-clean on profile re-init.
  const attr = config.attributionCoAuthor;
  if (attr !== undefined) {
    lines.push(`attribution:`);
    lines.push(`  co_author:`);
    lines.push(`    enabled: ${attr.enabled === true ? 'true' : 'false'}`);
    if (attr.name !== undefined && attr.name.length > 0) {
      lines.push(`    name: ${JSON.stringify(attr.name)}`);
    }
    if (attr.email !== undefined && attr.email.length > 0) {
      lines.push(`    email: ${JSON.stringify(attr.email)}`);
    }
    if (attr.skipMerge !== undefined) {
      lines.push(`    skip_merge: ${attr.skipMerge ? 'true' : 'false'}`);
    }
  }

  // 0.18.1+ helixir #9: emit audit.rotation when the layered profile
  // declared it. Empty `rotation: {}` opts in to documented defaults
  // (50 MiB / 30 days); explicit values override.
  if (layered.audit !== undefined) {
    lines.push(`audit:`);
    if (layered.audit.rotation !== undefined) {
      const rot = layered.audit.rotation;
      const hasFields = rot.max_bytes !== undefined || rot.max_age_days !== undefined;
      lines.push(hasFields ? `  rotation:` : `  rotation: {}`);
      if (rot.max_bytes !== undefined) {
        lines.push(`    max_bytes: ${rot.max_bytes}`);
      }
      if (rot.max_age_days !== undefined) {
        lines.push(`    max_age_days: ${rot.max_age_days}`);
      }
    }
  }

  // G11.4: always emit the review block explicitly. Making the value
  // visible in the generated file helps the operator notice what was
  // chosen at init time and simplifies switching modes later (edit a
  // single line, no need to understand the default semantics).
  lines.push(`review:`);
  lines.push(`  codex_required: ${config.codexRequired ? 'true' : 'false'}`);

  // Round-27 F6: emit `review.local_review` and top-level
  // `commit_hygiene` blocks ONLY when the operator (or the prior on-disk
  // policy) set them. Pre-fix re-running `rea init` silently dropped any
  // 0.26.0 knobs the operator had configured — `mode: off` reverted to
  // the documented `enforced` default, etc. We deliberately do NOT emit
  // a block when nothing was set, so consumers reading `policy.yaml` see
  // a clean file that documents only the operator's explicit choices.
  const hasLocalReview =
    config.localReviewMode !== undefined ||
    config.localReviewRefuseAt !== undefined ||
    config.localReviewBypassEnvVar !== undefined ||
    config.localReviewMaxAgeSeconds !== undefined;
  if (hasLocalReview) {
    lines.push(`  local_review:`);
    if (config.localReviewMode !== undefined) {
      lines.push(`    mode: ${config.localReviewMode}`);
    }
    if (config.localReviewRefuseAt !== undefined) {
      lines.push(`    refuse_at: ${config.localReviewRefuseAt}`);
    }
    if (config.localReviewBypassEnvVar !== undefined) {
      lines.push(`    bypass_env_var: ${JSON.stringify(config.localReviewBypassEnvVar)}`);
    }
    if (config.localReviewMaxAgeSeconds !== undefined) {
      lines.push(`    max_age_seconds: ${config.localReviewMaxAgeSeconds}`);
    }
  }
  if (
    config.commitHygieneWarnAtCommits !== undefined ||
    config.commitHygieneRefuseAtCommits !== undefined
  ) {
    lines.push(`commit_hygiene:`);
    if (config.commitHygieneWarnAtCommits !== undefined) {
      lines.push(`  warn_at_commits: ${config.commitHygieneWarnAtCommits}`);
    }
    if (config.commitHygieneRefuseAtCommits !== undefined) {
      lines.push(`  refuse_at_commits: ${config.commitHygieneRefuseAtCommits}`);
    }
  }
  lines.push(``);
  fs.writeFileSync(policyPath, lines.join('\n'), 'utf8');
  return policyPath;
}

function writeRegistryYaml(targetDir: string): string {
  const registryPath = path.join(targetDir, REA_DIR, REGISTRY_FILE);
  if (fs.existsSync(registryPath)) return registryPath;
  const content = [
    `# .rea/registry.yaml — downstream MCP servers proxied through rea serve.`,
    `# Every entry below is subject to the same middleware chain as native tool calls.`,
    `#`,
    `# env: values support \${VAR} interpolation against rea-serve's own process.env.`,
    `# If a referenced var is unset at startup, the affected server fails to start`,
    `# (the rest of the gateway still comes up). Only the curly-brace form is`,
    `# supported — no $VAR, no defaults, no command substitution.`,
    `#`,
    `# Example (uncomment and export the vars in your shell before running \`rea serve\`):`,
    `#`,
    `#   - name: discord-ops`,
    `#     command: npx`,
    `#     args: ['-y', 'discord-ops@latest']`,
    `#     env:`,
    `#       BOOKED_DISCORD_BOT_TOKEN: '\${BOOKED_DISCORD_BOT_TOKEN}'`,
    `#       CLARITY_DISCORD_BOT_TOKEN: '\${CLARITY_DISCORD_BOT_TOKEN}'`,
    `#     enabled: false  # flip to true after exporting the tokens`,
    `version: "1"`,
    `servers: []`,
    ``,
  ].join('\n');
  fs.writeFileSync(registryPath, content, 'utf8');
  return registryPath;
}

/**
 * G12 — write `.rea/install-manifest.json` after `runInit` has copied all
 * artifacts. SHAs are computed from the files on disk (so the manifest
 * reflects actual state, not canonical-source state) with two synthetic
 * entries for the rea-owned settings subset and the managed CLAUDE.md
 * fragment.
 */
async function writeInstallManifest(
  targetDir: string,
  profile: string,
  fragmentInput: Parameters<typeof buildFragment>[0],
): Promise<string> {
  const canonical = await enumerateCanonicalFiles();
  const entries: ManifestEntry[] = [];
  for (const c of canonical) {
    const dst = path.join(targetDir, c.destRelPath);
    // A file that was skipped during copy (e.g. --yes over existing) may not
    // exist if the destination layout diverged — hash whatever is on disk.
    // If it doesn't exist at all, fall back to hashing the source so the
    // manifest still has a baseline.
    const absPath = fs.existsSync(dst) ? dst : c.sourceAbsPath;
    const sha = await sha256OfFile(absPath);
    entries.push({ path: c.destRelPath, sha256: sha, source: c.source });
  }
  // Synthetic entries.
  entries.push({
    path: SETTINGS_MANIFEST_PATH,
    sha256: canonicalSettingsSubsetHash(defaultDesiredHooks()),
    source: 'settings',
  });
  entries.push({
    path: CLAUDE_MD_MANIFEST_PATH,
    sha256: sha256OfBuffer(buildFragment(fragmentInput)),
    source: 'claude-md',
  });

  // 0.17.0 idempotency: preserve the original `installed_at` from a
  // prior manifest if present. The first install date is the semantic
  // truth — re-runs reflect refreshes, not new installs.
  const manifestPath = path.join(targetDir, REA_DIR, 'install-manifest.json');
  const manifest: InstallManifest = {
    version: getPkgVersion(),
    profile,
    installed_at: readExistingManifestInstalledAt(manifestPath) ?? new Date().toISOString(),
    files: entries,
  };
  return writeManifestAtomic(targetDir, manifest);
}

function readExistingManifestInstalledAt(manifestPath: string): string | undefined {
  try {
    if (!fs.existsSync(manifestPath)) return undefined;
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'installed_at' in parsed &&
      typeof (parsed as { installed_at: unknown }).installed_at === 'string'
    ) {
      return (parsed as { installed_at: string }).installed_at;
    }
  } catch {
    // Fall through — caller stamps a fresh date.
  }
  return undefined;
}

export async function runInit(options: InitOptions): Promise<void> {
  const targetDir = process.cwd();
  const reagentPolicyPath = detectReagentPolicy(targetDir);
  const reaDir = path.join(targetDir, REA_DIR);
  const policyPath = path.join(reaDir, POLICY_FILE);

  if (fs.existsSync(policyPath) && options.yes !== true && options.force !== true) {
    err(`.rea/policy.yaml already exists at ${policyPath}`);
    console.error('');
    console.error(
      '  Refusing to overwrite. Pass --force to replace, or --yes to accept current settings.',
    );
    console.error('');
    process.exit(1);
  }

  // Select the profile name up front so we can load it for the layered base.
  let profileName: ProfileName;
  if (options.profile !== undefined && isValidProfile(options.profile)) {
    profileName = options.profile;
  } else if (options.profile !== undefined) {
    err(`Unknown profile: "${options.profile}". Valid: ${PROFILE_NAMES.join(', ')}`);
    process.exit(1);
  } else {
    profileName = 'minimal';
  }

  // Reagent translation, applied to the layered base before the wizard so
  // defaults reflect the reagent values when the user confirms.
  let reagentTranslated: Profile | null = null;
  const reagentNotices: string[] = [];
  const fromReagent = options.fromReagent === true;
  if (fromReagent) {
    if (reagentPolicyPath === null) {
      err('--from-reagent passed but no .reagent/policy.yaml found');
      process.exit(1);
    }
    const baseProfile = loadProfile(profileName);
    const profileCeiling =
      baseProfile?.max_autonomy_level ?? HARD_DEFAULTS.max_autonomy_level ?? AutonomyLevel.L2;
    try {
      const t = translateReagentPolicy(reagentPolicyPath, {
        profileCeiling,
        acceptDropped: options.acceptDroppedFields === true,
      });
      reagentTranslated = t.translated;
      reagentNotices.push(...t.notices);
    } catch (e) {
      if (e instanceof ReagentDroppedFieldsError) {
        err(e.message);
        process.exit(1);
      }
      err(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  const layeredBase = resolveLayered(profileName, reagentTranslated);

  // 0.21.1: preserve user-mutable policy values across re-init (idempotency
  // class — same as the `installed_at` fix from 0.17.0). Pre-fix, every
  // `rea init` re-applied profile defaults, silently resetting an
  // operator's `autonomy_level: L2` back to the profile's L1, etc.
  // Read the existing policy if present and merge: explicit existing
  // value wins over profile default. Operator opts out with --force
  // (existing flag — bypass the file-existence check entirely).
  // Profile-switch case: when the existing profile name disagrees with
  // the requested profile, the existing values are STILL preserved by
  // default but a stderr advisory names what was kept; operator can
  // pass --force to fully reset.
  const existingPolicy = readExistingPolicyForPreservation(targetDir);

  let config: ResolvedConfig;

  if (options.yes === true) {
    // G11.4 non-interactive codex resolution:
    //   1. Explicit --codex / --no-codex flag wins.
    //   2. Otherwise existing policy value wins (preserves operator edit).
    //   3. Otherwise derive from the profile name (`*-no-codex` → false).
    const codexRequired =
      options.codex !== undefined
        ? options.codex
        : (existingPolicy?.codexRequired ?? profileDefaultCodexRequired(profileName));
    config = {
      profile: profileName,
      autonomyLevel:
        existingPolicy?.autonomyLevel ?? layeredBase.autonomy_level ?? AutonomyLevel.L1,
      maxAutonomyLevel:
        existingPolicy?.maxAutonomyLevel ?? layeredBase.max_autonomy_level ?? AutonomyLevel.L2,
      blockAiAttribution:
        existingPolicy?.blockAiAttribution ?? layeredBase.block_ai_attribution ?? true,
      blockedPaths: existingPolicy?.blockedPaths ?? layeredBase.blocked_paths ?? ['.env', '.env.*'],
      notificationChannel:
        existingPolicy?.notificationChannel ?? layeredBase.notification_channel ?? '',
      codexRequired,
      // Round-27 F6: forward the existing 0.26.0 knobs verbatim. Any field
      // not set on disk stays undefined, and the writer omits it from the
      // emitted YAML.
      ...(existingPolicy?.localReviewMode !== undefined
        ? { localReviewMode: existingPolicy.localReviewMode }
        : {}),
      ...(existingPolicy?.localReviewRefuseAt !== undefined
        ? { localReviewRefuseAt: existingPolicy.localReviewRefuseAt }
        : {}),
      ...(existingPolicy?.localReviewBypassEnvVar !== undefined
        ? { localReviewBypassEnvVar: existingPolicy.localReviewBypassEnvVar }
        : {}),
      ...(existingPolicy?.localReviewMaxAgeSeconds !== undefined
        ? { localReviewMaxAgeSeconds: existingPolicy.localReviewMaxAgeSeconds }
        : {}),
      ...(existingPolicy?.commitHygieneWarnAtCommits !== undefined
        ? { commitHygieneWarnAtCommits: existingPolicy.commitHygieneWarnAtCommits }
        : {}),
      ...(existingPolicy?.commitHygieneRefuseAtCommits !== undefined
        ? { commitHygieneRefuseAtCommits: existingPolicy.commitHygieneRefuseAtCommits }
        : {}),
      // 0.30.0 attribution augmenter — preserved across re-init OR
      // seeded from the layered profile. Same precedence as the
      // wizard path above. Conditional spread for exact-optional.
      ...attributionConfigSpread(layeredBase, existingPolicy),
      fromReagent,
      reagentPolicyPath,
      reagentNotices,
    };
    if (existingPolicy !== undefined) {
      log(
        `Non-interactive init (re-run): preserving existing autonomy=${config.autonomyLevel}, max=${config.maxAutonomyLevel}, attribution-block=${config.blockAiAttribution}, codex_required=${config.codexRequired}. Pass --force to reset to profile defaults.`,
      );
    } else {
      log(
        `Non-interactive init: profile=${profileName}, autonomy=${config.autonomyLevel}, max=${config.maxAutonomyLevel}, attribution-block=${config.blockAiAttribution}, codex_required=${config.codexRequired}`,
      );
    }
  } else {
    config = await runWizard(options, targetDir, reagentPolicyPath, layeredBase, existingPolicy);
    config.reagentNotices = reagentNotices;
  }

  if (!fs.existsSync(reaDir)) fs.mkdirSync(reaDir, { recursive: true });

  const written: string[] = [];
  written.push(writePolicyYaml(targetDir, config, layeredBase));
  written.push(writeRegistryYaml(targetDir));

  // Artifact copies + settings merge + commit-msg + CLAUDE.md fragment.
  const copyOptions = {
    force: options.force === true,
    yes: options.yes === true || options.force === true,
  };
  const copyResult = await copyArtifacts(targetDir, copyOptions);

  const { settings, settingsPath } = readSettings(targetDir);
  const desired = defaultDesiredHooks();
  const mergeResult = mergeSettings(settings, desired);
  await writeSettingsAtomic(settingsPath, mergeResult.merged);

  const commitMsgResult = await installCommitMsgHook(targetDir);
  // 0.30.0 attribution augmenter — install the prepare-commit-msg
  // hook unconditionally. The hook is a no-op when
  // policy.attribution.co_author.enabled !== true, so it is safe to
  // ship under every profile; consumers opt in by editing their
  // .rea/policy.yaml.
  const prepareCommitMsgResult = await installPrepareCommitMsgHook(targetDir);
  const prePushResult = await installPrePushFallback({ targetDir });

  const fragmentInput = {
    policyPath: `.${path.sep}rea${path.sep}policy.yaml`.replace(/\\/g, '/'),
    profile: config.profile,
    autonomyLevel: config.autonomyLevel,
    maxAutonomyLevel: config.maxAutonomyLevel,
    blockedPathsCount: config.blockedPaths.length,
    blockAiAttribution: config.blockAiAttribution,
  };
  const mdResult = await writeClaudeMdFragment(targetDir, fragmentInput);

  // BUG-010 — scaffold `.gitignore` entries for every runtime artifact
  // `rea serve` / `rea cache` / `/freeze` can write under `.rea/`. Idempotent
  // append (and `rea upgrade` backfills older installs that never got this).
  const gitignoreResult = await ensureReaGitignore(targetDir);

  // G12 — record the install manifest. SHAs are of the files actually on disk
  // after the copy pass, so drift detection compares against real state (not
  // canonical, which may differ if the consumer's copy was aborted mid-run).
  const manifestPath = await writeInstallManifest(targetDir, config.profile, fragmentInput);

  console.log('');
  log('init complete');
  for (const file of written) console.log(`  + ${path.relative(targetDir, file)}`);
  console.log(
    `  + .claude/ (${copyResult.copied.length} copied, ${copyResult.overwritten.length} overwritten, ${copyResult.skipped.length} skipped)`,
  );
  console.log(
    `  + .claude/settings.json (${mergeResult.addedCount} hook entries added, ${mergeResult.skippedCount} already present)`,
  );
  if (commitMsgResult.gitHook)
    console.log(`  + ${path.relative(targetDir, commitMsgResult.gitHook)}`);
  if (commitMsgResult.huskyHook)
    console.log(`  + ${path.relative(targetDir, commitMsgResult.huskyHook)}`);
  if (prepareCommitMsgResult.gitHook) {
    const verb = prepareCommitMsgResult.refreshed === true ? '~' : '+';
    console.log(
      `  ${verb} ${path.relative(targetDir, prepareCommitMsgResult.gitHook)} (attribution augmenter)`,
    );
  }
  if (prepareCommitMsgResult.huskyHook) {
    const verb = prepareCommitMsgResult.refreshed === true ? '~' : '+';
    console.log(
      `  ${verb} ${path.relative(targetDir, prepareCommitMsgResult.huskyHook)} (attribution augmenter)`,
    );
  }
  if (prePushResult.written !== undefined) {
    const verb = prePushResult.decision.action === 'refresh' ? '~' : '+';
    console.log(`  ${verb} ${path.relative(targetDir, prePushResult.written)} (pre-push fallback)`);
  } else if (
    prePushResult.decision.action === 'skip' &&
    prePushResult.decision.reason === 'active-pre-push-present'
  ) {
    console.log(
      `  = ${path.relative(targetDir, prePushResult.decision.hookPath)} (active pre-push already present — skipped fallback)`,
    );
  }
  console.log(
    `  ${mdResult.replaced ? '~' : '+'} ${path.relative(targetDir, mdResult.path)} (fragment ${mdResult.replaced ? 'replaced' : 'written'})`,
  );
  if (gitignoreResult.action === 'created') {
    console.log(`  + ${path.relative(targetDir, gitignoreResult.path)} (managed block written)`);
  } else if (gitignoreResult.action === 'updated') {
    console.log(
      `  ~ ${path.relative(targetDir, gitignoreResult.path)} (managed block ${gitignoreResult.addedEntries.length} entr${gitignoreResult.addedEntries.length === 1 ? 'y' : 'ies'} added)`,
    );
  } else {
    console.log(`  · ${path.relative(targetDir, gitignoreResult.path)} (managed block up to date)`);
  }
  for (const w of gitignoreResult.warnings) warn(w);
  console.log(`  + ${path.relative(targetDir, manifestPath)}`);

  if (mergeResult.warnings.length > 0) {
    console.log('');
    for (const w of mergeResult.warnings) warn(w);
  }
  for (const w of commitMsgResult.warnings) warn(w);
  for (const w of prepareCommitMsgResult.warnings) warn(w);
  for (const w of prePushResult.warnings) warn(w);
  for (const n of config.reagentNotices) warn(n);

  // G6 + G11.4: Codex install-assist.
  //
  // Split by codex_required:
  //   - codex_required=true  → probe the CLI; if it is not responsive, print
  //                            a clear "install Codex" guidance block so the
  //                            operator knows why /codex-review will fail.
  //   - codex_required=false → skip the probe entirely and print the
  //                            existing "Codex review disabled" notice.
  //                            Probing here is pointless (wasted 2s) and
  //                            actively confusing — no-codex mode is a
  //                            supported first-class configuration.
  if (config.codexRequired) {
    await printCodexInstallAssist();
  } else {
    console.log('');
    console.log('Codex review disabled. ClaudeSelfReviewer will be used.');
    console.log('  Set review.codex_required: true in .rea/policy.yaml to re-enable.');
  }

  console.log('');
  console.log('Next steps:');
  console.log('  1. Review .rea/policy.yaml and commit it.');
  console.log('  2. Run `rea doctor` to validate the install.');
  console.log('  3. Run `rea check` to see current status.');
  if (config.fromReagent) {
    console.log('');
    console.log('Reagent migration:');
    console.log(`  Source: ${config.reagentPolicyPath ?? '(none)'}`);
    console.log('  Copied fields were applied per the translator rules.');
    console.log('  Once satisfied, you can remove the .reagent/ directory.');
  }
  console.log('');
}
