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

export interface ResolvedConfig {
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

  // 0.43.0 UX polish: surface re-run vs fresh-install mode at the top
  // of the wizard so the operator sees up-front that an existing policy
  // is being preserved (not overwritten with defaults). Pre-fix the only
  // signal was an oblique prompt label change ("current: L2") several
  // questions in — easy to miss when running the wizard interactively.
  if (existingPolicy !== undefined) {
    p.note(
      [
        `Existing install detected at ${path.join(REA_DIR, POLICY_FILE)}.`,
        'Re-run mode: your current settings will be preserved as defaults below.',
        'Pass --force to reset everything to profile defaults.',
      ].join('\n'),
      'Re-running init',
    );
  } else {
    p.note(
      [
        `Setting up rea governance for ${projectName}.`,
        'You can change every answer later by editing .rea/policy.yaml.',
      ].join('\n'),
      'Fresh install',
    );
  }

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
      message: 'Pick a profile preset',
      initialValue: 'minimal',
      options: [
        {
          value: 'minimal',
          label: 'minimal',
          hint: 'bare policy, no extras — safe starting point',
        },
        {
          value: 'client-engagement',
          label: 'client-engagement',
          hint: 'zero-trust client project — strict by default',
        },
        {
          value: 'bst-internal',
          label: 'bst-internal',
          hint: 'BookedSolid internal projects (Codex review on)',
        },
        {
          value: 'lit-wc',
          label: 'lit-wc',
          hint: 'Lit / web-component libraries',
        },
        {
          value: 'open-source',
          label: 'open-source',
          hint: 'public OSS repos (Codex review on)',
        },
      ],
    });
    if (p.isCancel(picked)) cancel('Init cancelled.');
    profileName = picked;
  }

  // 0.21.1: prefer the existing on-disk value over the profile default
  // so re-running `rea init` doesn't reset an operator's manual edit.
  const autonomyDefault =
    existingPolicy?.autonomyLevel ?? layeredBase.autonomy_level ?? AutonomyLevel.L1;
  const autonomyMessage =
    existingPolicy?.autonomyLevel !== undefined
      ? `Starting autonomy level (current: ${existingPolicy.autonomyLevel}). Controls how much the ` +
        `agent can do without asking you first.`
      : 'Starting autonomy level — how much can the agent do without asking you first?';
  const autonomyPick = await p.select<AutonomyLevel>({
    message: autonomyMessage,
    initialValue: autonomyDefault,
    options: [
      {
        value: AutonomyLevel.L0,
        label: 'L0  — read-only',
        hint: 'every write needs your approval; safest, slowest',
      },
      {
        value: AutonomyLevel.L1,
        label: 'L1  — supervised writes',
        hint: 'default — writes allowed, destructive ops gated',
      },
      {
        value: AutonomyLevel.L2,
        label: 'L2  — wide latitude',
        hint: 'destructive ops allowed; suitable for experienced operators',
      },
      {
        value: AutonomyLevel.L3,
        label: 'L3  — full autonomy',
        hint: 'rare — supervised long-running agents only',
      },
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
    message:
      'Ceiling autonomy level — the agent can never exceed this even if asked. ' +
      'Promoting past the ceiling requires editing policy.yaml by hand.',
    initialValue: defaultMax,
    options: maxOptions as Parameters<typeof p.select<AutonomyLevel>>[0]['options'],
  });
  if (p.isCancel(maxPick)) cancel('Init cancelled.');
  const maxAutonomyLevel = maxPick;

  const attribPick = await p.confirm({
    message:
      'Block AI-attribution in commits? (rejects "Co-Authored-By: Claude" and similar ' +
      'trailers — keeps your git history human-attributed)',
    initialValue: layeredBase.block_ai_attribution ?? true,
  });
  if (p.isCancel(attribPick)) cancel('Init cancelled.');
  const blockAiAttribution = attribPick === true;

  // G11.4: "Use Codex adversarial review?" — initial-value precedence:
  //   1. explicit --codex / --no-codex flag wins
  //   2. otherwise existing on-disk value (preserves operator edit on re-run)
  //   3. otherwise profile default (`*-no-codex` profiles default to No)
  //
  // 0.43.0 codex round-1 P2: prior to this commit step 2 was skipped on
  // the interactive path — the initial value collapsed to the profile
  // default even on a re-run where the operator had already toggled
  // codex off. The summary screen advertised codex_required as
  // preserved while the prompt default silently reverted it. The
  // `--yes` path already had the correct precedence (see the
  // non-interactive branch in `runInit`); this brings the wizard in
  // line.
  const codexInitial =
    options.codex !== undefined
      ? options.codex
      : (existingPolicy?.codexRequired ?? profileDefaultCodexRequired(profileName));
  const codexPick = await p.confirm({
    message:
      'Enable Codex adversarial review? (runs a GPT-5.4 second-opinion review on every push; ' +
      'requires the Codex CLI + an OpenAI account — can be installed later via /codex:setup)',
    initialValue: codexInitial,
  });
  if (p.isCancel(codexPick)) cancel('Init cancelled.');
  const codexRequired = codexPick === true;

  return {
    profile: profileName,
    autonomyLevel,
    maxAutonomyLevel,
    blockAiAttribution,
    // 0.43.0 codex round-1 P2: preserve the wizard-untouched fields
    // (`blocked_paths` + `notification_channel`) the same way the
    // `--yes` path already does. Pre-fix the wizard return rebuilt
    // these from `layeredBase` on every interactive re-run, silently
    // dropping operator edits even though the new install-summary
    // confirm gate advertised them as preserved. The wizard does NOT
    // prompt for either field (they are policy-file edits, not
    // first-question UX), so falling back to the layered profile
    // default is the correct seed shape on a fresh install; a re-run
    // simply forwards whatever the operator committed to disk.
    blockedPaths:
      existingPolicy?.blockedPaths ?? layeredBase.blocked_paths ?? ['.env', '.env.*'],
    notificationChannel:
      existingPolicy?.notificationChannel ?? layeredBase.notification_channel ?? '',
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

/**
 * 0.43.0 UX polish: build the human-readable install summary shown
 * BEFORE any files are written. Lists, in order: the policy file
 * being written, the chosen profile + autonomy, hook + agent counts
 * planned, the git/husky hooks planned (paths reflect what the
 * installer will ACTUALLY do given the target tree's shape), and
 * whether re-run preservation is active.
 *
 * Rendered via clack's `note` primitive so it sits in a bordered block
 * adjacent to the final `confirm` gate. The string is also returned
 * verbatim so the test suite can assert content without mocking clack.
 *
 * `targetState` is computed by {@link detectTargetState} — kept as a
 * separate argument so tests can drive both shapes (husky-present and
 * husky-absent) without touching the filesystem.
 */
export function buildInstallSummary(
  targetDir: string,
  config: ResolvedConfig,
  reRunMode: boolean,
  targetState: TargetState,
): string {
  const lines: string[] = [];
  const mode = reRunMode ? 'Re-run (preserving your existing edits)' : 'Fresh install';
  lines.push(`Mode: ${mode}`);
  lines.push(`Target: ${targetDir}`);
  lines.push('');
  lines.push('Will write:');
  lines.push(`  .rea/policy.yaml         — profile=${config.profile}`);
  lines.push(`                             autonomy=${config.autonomyLevel} (max=${config.maxAutonomyLevel})`);
  lines.push(`                             attribution-block=${config.blockAiAttribution ? 'on' : 'off'}`);
  lines.push(`                             codex-review=${config.codexRequired ? 'on' : 'off'}`);
  lines.push(`  .rea/registry.yaml       — empty MCP-server registry`);
  lines.push(`  .rea/install-manifest.json — hash record for drift detection`);
  lines.push(`  .claude/agents/          — curated specialist agents`);
  lines.push(`  .claude/hooks/           — hook scripts (executable)`);
  lines.push(`  .claude/commands/        — slash commands`);
  lines.push(`  .claude/settings.json    — hook registration entries`);
  // 0.43.0 codex round-1 P3: the installer writes to `.git/hooks/*`
  // ALWAYS when a git repo is present, AND to `.husky/*` ONLY when
  // `.husky/` already exists. Pre-fix the summary hard-coded `.husky/*`
  // and silently omitted the `.git/hooks/*` writes from the "no
  // .husky/" install shape — the most common one. The operator then
  // confirmed without being told their `.git/hooks/` would be
  // modified. We list both surfaces conditionally based on the
  // detected target state so the screen is faithful to what actually
  // happens.
  if (targetState.gitRepoPresent) {
    lines.push(`  .git/hooks/commit-msg    — commit-message attribution gate`);
    lines.push(`  .git/hooks/prepare-commit-msg — attribution augmenter (no-op until enabled)`);
    lines.push(`  .git/hooks/pre-push      — local-review gate (fallback if no active hook present)`);
  } else {
    lines.push(`  (no .git/ directory detected — git hook copies will be skipped)`);
  }
  if (targetState.huskyDirPresent) {
    lines.push(`  .husky/commit-msg        — commit-message attribution gate (husky mirror)`);
    lines.push(`  .husky/prepare-commit-msg — attribution augmenter (husky mirror)`);
    lines.push(`  .husky/pre-push          — local-review gate (husky mirror)`);
  } else {
    lines.push(`  (no .husky/ directory detected — husky mirrors will be skipped)`);
  }
  lines.push(`  CLAUDE.md fragment       — managed governance block`);
  lines.push(`  .gitignore               — managed entries for .rea runtime artifacts`);
  if (reRunMode) {
    lines.push('');
    // 0.43.0 codex round-1 P2: list only the fields the wizard
    // ACTUALLY preserves. `blocked_paths`, `notification_channel`,
    // and `review.codex_required` are now preserved by the wizard
    // path (matching the `--yes` path's documented contract); the
    // wizard does NOT prompt for the 0.26.0 local_review or
    // commit_hygiene knobs, but those values forward verbatim from
    // the existing policy when set.
    lines.push('Re-run preserves your manually-edited:');
    lines.push('  • autonomy_level / max_autonomy_level / block_ai_attribution');
    lines.push('  • blocked_paths / notification_channel');
    lines.push('  • review.codex_required + local_review.* + commit_hygiene.*');
    lines.push('  • attribution.co_author.* + installed_at timestamp');
  }
  return lines.join('\n');
}

/**
 * 0.43.0 codex round-1 P3: shape of the target tree the installer
 * will see. `buildInstallSummary` and the post-install verifier both
 * need to know whether `.git/` and `.husky/` are present so the
 * summary doesn't lie about which hook files will be written.
 */
export interface TargetState {
  gitRepoPresent: boolean;
  huskyDirPresent: boolean;
}

/**
 * 0.43.0 codex round-1 P3: detect which hook surfaces the installer
 * will actually touch. Returns a snapshot so the install-summary
 * confirm screen can show the right paths.
 *
 * Intentionally simple — the installers themselves (commit-msg,
 * prepare-commit-msg, pre-push) each re-check at write time, so this
 * detection is purely presentational. If something races between the
 * snapshot and the writes (a `pnpm install` adding `.husky/` in the
 * window between confirm and spinner), the installer's own checks win
 * and the summary was only slightly stale.
 */
export function detectTargetState(targetDir: string): TargetState {
  return {
    gitRepoPresent: fs.existsSync(path.join(targetDir, '.git')),
    huskyDirPresent: fs.existsSync(path.join(targetDir, '.husky')),
  };
}

/**
 * 0.43.0 UX polish: post-install sanity check. Runs synchronously
 * after the file-write phase to catch installs that completed
 * "successfully" but are missing a critical artifact (write
 * permissions issue, partial copy, etc.).
 *
 * Strictly read-only — no probes that touch python3 / jq / codex.
 * Pattern modelled on the synthetic round-trip checks established by
 * `checkDelegationRoundTrip` in 0.29.0/0.31.0: cheap, in-process,
 * sufficient to catch the "looks-installed-but-isn't" failure shape
 * that bites first-time consumers hardest. For deep diagnostics
 * point the operator at `rea doctor`.
 *
 * Returns the list of issues found (empty = healthy). The caller
 * surfaces them via clack's `log.warn` and points the operator at
 * `rea doctor` for follow-up.
 */
export function postInstallVerify(targetDir: string): string[] {
  const issues: string[] = [];

  // 1. policy file exists + parses as YAML object.
  const policyPath = path.join(targetDir, REA_DIR, POLICY_FILE);
  if (!fs.existsSync(policyPath)) {
    issues.push(`.rea/policy.yaml missing after install (expected at ${policyPath})`);
  } else {
    try {
      const raw = fs.readFileSync(policyPath, 'utf8');
      const parsed: unknown = parseYaml(raw);
      if (parsed === null || typeof parsed !== 'object') {
        issues.push('.rea/policy.yaml parsed to a non-object — run `rea doctor` for details');
      }
    } catch (e) {
      issues.push(
        `.rea/policy.yaml failed to parse: ${e instanceof Error ? e.message : String(e)} — ` +
          'run `rea doctor` for details',
      );
    }
  }

  // 2. .claude/hooks directory present with executable scripts.
  const hooksDir = path.join(targetDir, '.claude', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    issues.push(`.claude/hooks/ directory missing after install (expected at ${hooksDir})`);
  } else {
    let executableCount = 0;
    try {
      for (const entry of fs.readdirSync(hooksDir)) {
        if (!entry.endsWith('.sh')) continue;
        const stat = fs.statSync(path.join(hooksDir, entry));
        if ((stat.mode & 0o111) !== 0) executableCount += 1;
      }
    } catch (e) {
      issues.push(
        `failed to enumerate .claude/hooks/: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (executableCount === 0) {
      issues.push('.claude/hooks/ contains zero executable .sh files — run `rea doctor`');
    }
  }

  // 3. settings.json present.
  const settingsPath = path.join(targetDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    issues.push(`.claude/settings.json missing after install (expected at ${settingsPath})`);
  }

  // 4. install manifest present.
  const manifestPath = path.join(targetDir, REA_DIR, 'install-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    issues.push(
      `.rea/install-manifest.json missing after install (expected at ${manifestPath}) — ` +
        'drift detection will not work until `rea init` is re-run',
    );
  }

  return issues;
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

  // 0.43.0 UX polish: install summary + final confirm gate. The
  // operator sees exactly what's about to happen BEFORE any
  // filesystem writes. Skipped on `--yes` / `--force` (non-interactive
  // paths assume consent). The confirm step is the last chance to
  // bail without leaving partial state on disk.
  const reRunMode = existingPolicy !== undefined;
  const interactive = options.yes !== true;
  if (interactive) {
    const targetState = detectTargetState(targetDir);
    const summary = buildInstallSummary(targetDir, config, reRunMode, targetState);
    p.note(summary, reRunMode ? 'Ready to refresh' : 'Ready to install');
    const proceed = await p.confirm({
      message: reRunMode ? 'Proceed with the refresh?' : 'Proceed with the install?',
      initialValue: true,
    });
    if (p.isCancel(proceed) || proceed !== true) {
      cancel('Init cancelled — no files written.');
    }
  }

  if (!fs.existsSync(reaDir)) fs.mkdirSync(reaDir, { recursive: true });

  // 0.43.0 UX polish: wrap the file-write phase in a clack spinner so
  // operators on slow disks see progress instead of staring at a
  // motionless prompt. Skipped under `--yes` (non-interactive paths
  // log line-by-line). All operations remain identical — the spinner
  // is purely presentational.
  const spinner = interactive ? p.spinner() : null;
  if (spinner !== null) spinner.start('Writing rea install');

  let written: string[];
  let copyResult: Awaited<ReturnType<typeof copyArtifacts>>;
  let mergeResult: ReturnType<typeof mergeSettings>;
  let commitMsgResult: Awaited<ReturnType<typeof installCommitMsgHook>>;
  let prepareCommitMsgResult: Awaited<ReturnType<typeof installPrepareCommitMsgHook>>;
  let prePushResult: Awaited<ReturnType<typeof installPrePushFallback>>;
  let mdResult: Awaited<ReturnType<typeof writeClaudeMdFragment>>;
  let gitignoreResult: Awaited<ReturnType<typeof ensureReaGitignore>>;
  let manifestPath: string;
  let fragmentInput: Parameters<typeof buildFragment>[0];

  try {
    written = [];
    written.push(writePolicyYaml(targetDir, config, layeredBase));
    written.push(writeRegistryYaml(targetDir));

    // Artifact copies + settings merge + commit-msg + CLAUDE.md fragment.
    const copyOptions = {
      force: options.force === true,
      yes: options.yes === true || options.force === true,
    };
    copyResult = await copyArtifacts(targetDir, copyOptions);

    const { settings, settingsPath } = readSettings(targetDir);
    const desired = defaultDesiredHooks();
    mergeResult = mergeSettings(settings, desired);
    await writeSettingsAtomic(settingsPath, mergeResult.merged);

    commitMsgResult = await installCommitMsgHook(targetDir);
    // 0.30.0 attribution augmenter — install the prepare-commit-msg
    // hook unconditionally. The hook is a no-op when
    // policy.attribution.co_author.enabled !== true, so it is safe to
    // ship under every profile; consumers opt in by editing their
    // .rea/policy.yaml.
    prepareCommitMsgResult = await installPrepareCommitMsgHook(targetDir);
    prePushResult = await installPrePushFallback({ targetDir });

    fragmentInput = {
      policyPath: `.${path.sep}rea${path.sep}policy.yaml`.replace(/\\/g, '/'),
      profile: config.profile,
      autonomyLevel: config.autonomyLevel,
      maxAutonomyLevel: config.maxAutonomyLevel,
      blockedPathsCount: config.blockedPaths.length,
      blockAiAttribution: config.blockAiAttribution,
    };
    mdResult = await writeClaudeMdFragment(targetDir, fragmentInput);

    // BUG-010 — scaffold `.gitignore` entries for every runtime artifact
    // `rea serve` / `rea cache` / `/freeze` can write under `.rea/`. Idempotent
    // append (and `rea upgrade` backfills older installs that never got this).
    gitignoreResult = await ensureReaGitignore(targetDir);

    // G12 — record the install manifest. SHAs are of the files actually on disk
    // after the copy pass, so drift detection compares against real state (not
    // canonical, which may differ if the consumer's copy was aborted mid-run).
    manifestPath = await writeInstallManifest(targetDir, config.profile, fragmentInput);
  } catch (e) {
    // 0.43.0 UX polish: surface install failures via the spinner's
    // error state when interactive, then re-throw with a clack-rendered
    // "what failed → suggested fix" envelope so the operator isn't
    // left staring at a raw stack trace.
    if (spinner !== null) spinner.stop('Install failed');
    const message = e instanceof Error ? e.message : String(e);
    // Pattern: <what failed>: <why> → <suggested fix>. Many of the
    // underlying installers throw with the why already in `message`;
    // we always append the actionable next step so the operator
    // knows where to look.
    p.log.error(
      `Install aborted: ${message}\n` +
        `  Suggested fix: re-run with --force to reset, or run \`rea doctor\` to ` +
        `diagnose the partial state, or escalate via \`rea freeze\` if a hook is ` +
        `actively blocking the operator's work.`,
    );
    throw e;
  }
  if (spinner !== null) spinner.stop('Install written');

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

  // 0.43.0 UX polish: inline post-install verification. NOT a full
  // `rea doctor` (that takes seconds and spawns subprocesses) — just
  // a synchronous in-process sanity check that the install is sane.
  // If anything looks off we surface a loud warning and direct the
  // operator at `rea doctor` for the deep dive. Modelled on the
  // 0.29.0/0.31.0 synthetic round-trip pattern.
  const verifyIssues = postInstallVerify(targetDir);
  if (verifyIssues.length > 0) {
    console.log('');
    warn('post-install verification flagged the following:');
    for (const issue of verifyIssues) warn(`  • ${issue}`);
    warn('Run `rea doctor` for a full diagnostic.');
  } else if (interactive) {
    // Quiet success — confirm we checked, but don't shout about it.
    p.log.success('Post-install check: install looks healthy.');
  }

  if (interactive) {
    // 0.43.0 UX polish: clack outro with structured next-steps.
    // Replaces the bare `console.log('Next steps:')` block with a
    // bordered note so the call-to-action is unmissable on a busy
    // terminal scrollback. The non-interactive path keeps the plain
    // console.log block (CI logs don't render clack borders).
    const nextSteps: string[] = [];
    nextSteps.push('1. Review .rea/policy.yaml and commit it.');
    nextSteps.push('2. Run `rea doctor` to validate the install end-to-end.');
    nextSteps.push('3. Run `rea check` to see current status (autonomy, HALT, recent audit).');
    if (config.fromReagent) {
      nextSteps.push('');
      nextSteps.push('Reagent migration:');
      nextSteps.push(`  Source: ${config.reagentPolicyPath ?? '(none)'}`);
      nextSteps.push('  Copied fields were applied per the translator rules.');
      nextSteps.push('  Once satisfied, you can remove the .reagent/ directory.');
    }
    nextSteps.push('');
    nextSteps.push('Docs: https://github.com/bookedsolidtech/rea#readme');
    p.note(nextSteps.join('\n'), 'Next steps');
    p.outro(reRunMode ? 'rea refresh complete.' : 'rea install complete.');
  } else {
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
}
