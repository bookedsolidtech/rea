import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { parse as parseYaml } from 'yaml';
import { AutonomyLevel } from '../policy/types.js';
import { HARD_DEFAULTS, loadProfile, mergeProfiles, type Profile } from '../policy/profiles.js';
import { copyArtifacts } from './install/copy.js';
import { ensureReaGitignore } from './install/gitignore.js';
import { checkUpgradeBlockingPin, selfPinRea } from './install/self-pin.js';
import {
  canonicalSettingsSubsetHash,
  defaultDesiredHooks,
  mergeSettings,
  readSettings,
  writeSettingsAtomic,
} from './install/settings-merge.js';
import { EXPECTED_HOOKS } from './doctor.js';
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
import {
  PKG_ROOT,
  POLICY_FILE,
  REA_DIR,
  REGISTRY_FILE,
  err,
  getPkgVersion,
  log,
  warn,
} from './utils.js';

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
  /**
   * R12-P1 (codex round 12 / 0.49.0): bootstrap_allowlist.enabled.
   * Preserved across re-init so an operator who opted out via
   * `bootstrap_allowlist: { enabled: false }` doesn't get silently
   * re-enabled by the next `rea init`. Seeded from the layered
   * profile on first install (only `bst-internal` currently pins
   * `enabled: true` explicitly; every other profile inherits the
   * zod schema default which is also `true`). When `undefined`, the
   * writer emits no block — consumers fall through to the schema
   * default at policy load.
   */
  bootstrapAllowlistEnabled?: boolean;
  /**
   * 0.51.0 spend-governance (E1 seed) — the billing→HALT reflex. Emitted
   * into `.rea/policy.yaml` on EVERY install (schema default is OFF, so —
   * unlike bootstrap_allowlist — the block MUST be written explicitly or
   * the reflex ships disabled). Seeded from the layered profile, which
   * pins `enabled: true` + `billing_error_response: halt` on every shipped
   * profile; preserved across re-init so an operator override survives.
   * When `undefined` (a custom profile that declares no spend_governance),
   * the writer emits no block and the reflex stays off for that install.
   */
  spendGovernanceEnabled?: boolean;
  spendGovernanceBillingErrorResponse?: 'halt' | 'warn' | 'off';
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
    // R12-P1 (codex round 12): preserve bootstrap_allowlist.enabled
    // so an operator opt-out survives `rea init` re-runs.
    ...bootstrapAllowlistConfigSpread(layeredBase, existingPolicy),
    // 0.51.0 spend-governance — emit the billing→HALT block (ON in every
    // shipped profile; schema default is OFF so it MUST be written).
    ...spendGovernanceConfigSpread(layeredBase, existingPolicy),
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
 * R12-P1 (codex round 12 / 0.49.0): same shape-spread helper for
 * `bootstrap_allowlist.enabled`. Precedence:
 *
 *   1. Existing on-disk policy `bootstrap_allowlist.enabled` (highest).
 *   2. Layered profile's `bootstrap_allowlist.enabled` (e.g.
 *      `bst-internal` pins `true` explicitly).
 *   3. Omitted — the writer skips emission and consumers fall through
 *      to the zod schema default at policy-load time.
 *
 * The omit-vs-emit distinction matters: external profiles
 * (open-source, client-engagement, etc.) leave the block unset, and
 * we want a clean policy.yaml that does NOT mention the field unless
 * the operator or the profile explicitly pinned it. That preserves
 * the existing emit-only-when-set posture for the other preserved
 * keys (local_review, commit_hygiene).
 *
 * Pre-R12 the field was dropped entirely on re-init — an operator
 * who opted out via `bootstrap_allowlist: { enabled: false }` got
 * silently flipped back to `true` (schema default). This helper
 * closes that drop class.
 */
function bootstrapAllowlistConfigSpread(
  layered: Profile,
  existing: ExistingPolicyValues | undefined,
): { bootstrapAllowlistEnabled?: boolean } {
  // Existing on-disk policy wins — preserves explicit opt-out.
  if (existing?.bootstrapAllowlistEnabled !== undefined) {
    return { bootstrapAllowlistEnabled: existing.bootstrapAllowlistEnabled };
  }
  // Profile-layer value next — `bst-internal` pins `true` explicitly
  // so the on-disk policy shows the pinned posture rather than
  // relying on the schema default.
  const fromProfile = layered.bootstrap_allowlist?.enabled;
  if (fromProfile !== undefined) {
    return { bootstrapAllowlistEnabled: fromProfile };
  }
  // Neither set — omit from the emitted policy.yaml.
  return {};
}

/**
 * 0.51.0 spend-governance (E1 seed) — resolve the `spend_governance`
 * block for emission. Precedence mirrors `bootstrapAllowlistConfigSpread`:
 *
 *   1. Existing on-disk policy (highest) — preserves an operator override
 *      (e.g. `billing_error_response: warn`, or a deliberate opt-out).
 *   2. Layered profile — every SHIPPED profile pins `enabled: true` +
 *      `billing_error_response: halt`.
 *   3. Omitted — a custom profile declaring no spend_governance emits no
 *      block (the reflex stays off for that install).
 *
 * CRITICAL difference from bootstrap_allowlist: the zod schema default is
 * `enabled: false` (absent block = disabled), so omitting the block does
 * NOT fall through to an enabled default. For the reflex to actually ship
 * ON, the block MUST be emitted — which it is for every shipped profile,
 * because they all pin it and the writer emits whenever `enabled` resolves.
 * Fields are resolved independently so an operator who set only `warn`
 * still gets `enabled` from the profile (and vice-versa).
 */
function spendGovernanceConfigSpread(
  layered: Profile,
  existing: ExistingPolicyValues | undefined,
): { spendGovernanceEnabled?: boolean; spendGovernanceBillingErrorResponse?: 'halt' | 'warn' | 'off' } {
  const enabled =
    existing?.spendGovernanceEnabled ?? layered.spend_governance?.enabled;
  const mode =
    existing?.spendGovernanceBillingErrorResponse ??
    layered.spend_governance?.billing_error_response;
  return {
    ...(enabled !== undefined ? { spendGovernanceEnabled: enabled } : {}),
    ...(mode !== undefined ? { spendGovernanceBillingErrorResponse: mode } : {}),
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
  /**
   * R12-P1 (codex round 12 / 0.49.0): bootstrap_allowlist.enabled
   * preserved across `rea init` re-runs. Pre-fix an operator who
   * opted out via `bootstrap_allowlist: { enabled: false }` got
   * silently re-enabled on the next init — the same drop-class
   * R28-F6 closed for local_review / commit_hygiene.
   */
  bootstrapAllowlistEnabled?: boolean;
  /** 0.51.0 spend-governance — preserved across re-init. */
  spendGovernanceEnabled?: boolean;
  spendGovernanceBillingErrorResponse?: 'halt' | 'warn' | 'off';
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

  // R12-P1 (codex round 12 / 0.49.0): preserve bootstrap_allowlist
  // across re-init. Critical for the documented opt-out — an
  // operator who set `bootstrap_allowlist: { enabled: false }` MUST
  // NOT have it silently flipped back to `true` by the next init.
  // Inline (`bootstrap_allowlist: { enabled: false }`) and block
  // (`bootstrap_allowlist:\n  enabled: false`) forms fold to the
  // same parsed object via yaml.parse.
  const bootstrapAllowlist = policy['bootstrap_allowlist'];
  if (bootstrapAllowlist !== null && typeof bootstrapAllowlist === 'object') {
    const ba = bootstrapAllowlist as Record<string, unknown>;
    if (typeof ba['enabled'] === 'boolean') {
      out.bootstrapAllowlistEnabled = ba['enabled'];
    }
  }

  // 0.51.0 spend-governance — preserve an operator's enabled / mode
  // override across re-init (e.g. a deliberate opt-out, or `warn`).
  const spendGovernance = policy['spend_governance'];
  if (spendGovernance !== null && typeof spendGovernance === 'object') {
    const sg = spendGovernance as Record<string, unknown>;
    if (typeof sg['enabled'] === 'boolean') {
      out.spendGovernanceEnabled = sg['enabled'];
    }
    const mode = sg['billing_error_response'];
    if (mode === 'halt' || mode === 'warn' || mode === 'off') {
      out.spendGovernanceBillingErrorResponse = mode;
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
  // R12-P1 (codex round 12 / 0.49.0): emit bootstrap_allowlist when
  // the layered profile or the existing on-disk policy declared it.
  // When unset, omit the block — consumers fall through to the zod
  // schema default (`enabled: true`). The block form (vs flow form)
  // mirrors what `bst-internal.yaml` emits so dogfood byte-fidelity
  // is preserved.
  if (config.bootstrapAllowlistEnabled !== undefined) {
    lines.push(`bootstrap_allowlist:`);
    lines.push(`  enabled: ${config.bootstrapAllowlistEnabled ? 'true' : 'false'}`);
  }
  // 0.51.0 spend-governance (E1 seed) — the billing→HALT reflex. Emitted
  // whenever `enabled` resolves (every shipped profile pins it). Unlike
  // bootstrap_allowlist, omitting the block does NOT enable it (schema
  // default is OFF), so this MUST be written for the reflex to ship on.
  // `billing_error_response` only emits when resolved (default `halt` is
  // also the schema default, so an operator who left it unset still gets
  // `halt` at load — but the shipped profiles pin it explicitly).
  if (config.spendGovernanceEnabled !== undefined) {
    lines.push(`spend_governance:`);
    lines.push(`  enabled: ${config.spendGovernanceEnabled ? 'true' : 'false'}`);
    if (config.spendGovernanceBillingErrorResponse !== undefined) {
      lines.push(`  billing_error_response: ${config.spendGovernanceBillingErrorResponse}`);
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
 * 0.45.0 charter item 2 — derive the canonical hook filename set
 * PRIMARILY from the packaged `hooks/` filesystem tree (the literal
 * shipped artifact), with the two source-code registries
 * (`EXPECTED_HOOKS` and `defaultDesiredHooks()`) layered on top as
 * defensive fallbacks.
 *
 * # Why filesystem-first
 *
 * 0.44.0 introduced this helper as the UNION of two source-code
 * lists. Round-2 noticed a drift hazard: if either source-code list
 * gets out of sync with the actual `hooks/` filesystem reality
 * (e.g. a hook is added to `hooks/` but not to `EXPECTED_HOOKS`),
 * the install-summary lies about what's about to land on disk.
 * The filesystem is the source of truth — what the installer
 * actually copies into `.claude/hooks/` is the contents of
 * `hooks/`. Pinning the canonical set to the FS catches drift at
 * runtime; the cross-check test in `init.test.ts` catches it at
 * build time.
 *
 * # Strategy
 *
 *   1. Try to read `PKG_ROOT/hooks/*.sh` (filtered to exclude `_lib/`).
 *      This is the authoritative list — it's literally what the
 *      installer will copy into `.claude/hooks/`.
 *   2. Union with `EXPECTED_HOOKS` (doctor's required list) — covers
 *      the future case where the FS read fails (e.g. an unusual
 *      install layout) but the source-code registry is intact.
 *   3. Union with `defaultDesiredHooks()` basenames — covers the
 *      symmetric case where a hook is registered in settings.json
 *      but somehow absent from `EXPECTED_HOOKS`.
 *
 * Steps 2 and 3 are belt-and-suspenders. The cross-check test
 * asserts all three sources agree; a drift between the FS and either
 * source-code list fails the test loudly. In production the FS read
 * (step 1) is the only one that contributes anything that wouldn't
 * already be covered by steps 2+3 IF the test stays green.
 *
 * Sorted + deduped so the screen is stable across orderings.
 *
 * Exported for testability — the cross-check test imports it
 * directly to compare against `canonicalHooksFromFilesystem()` and
 * the two source-code registries.
 */
export function canonicalInstalledHooks(): string[] {
  const merged = new Set<string>(canonicalHooksFromFilesystem());
  for (const name of EXPECTED_HOOKS) merged.add(name);
  for (const group of defaultDesiredHooks()) {
    for (const h of group.hooks) {
      const cmd = h.command;
      // Commands have shape `"$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>.sh`.
      // Take the basename (everything after the last `/`). Robust against
      // future path changes — only the filename matters here.
      const slashIdx = cmd.lastIndexOf('/');
      const basename = slashIdx >= 0 ? cmd.slice(slashIdx + 1) : cmd;
      if (basename.endsWith('.sh')) merged.add(basename);
    }
  }
  return Array.from(merged).sort();
}

/**
 * 0.45.0 charter item 2 — read the canonical hook filename set
 * directly from the packaged `hooks/` filesystem tree. Returns
 * basenames (e.g. `dangerous-bash-interceptor.sh`) sorted ascending.
 * Excludes anything under `_lib/` (shared helpers, not installed
 * shims).
 *
 * Returns `[]` if the directory can't be read — caller is expected
 * to union with `EXPECTED_HOOKS` / `defaultDesiredHooks()` so a
 * missing FS doesn't produce a zero-length canonical list.
 *
 * Exported so the cross-check test can compare it against the two
 * source-code registries and fail loudly on drift.
 */
export function canonicalHooksFromFilesystem(): string[] {
  const dir = path.join(PKG_ROOT, 'hooks');
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.sh'))
      .filter((name) => {
        try {
          // Exclude subdirectories like `_lib/`; only top-level `.sh`
          // files are shipped shims. `readdirSync` returns names from
          // the directory itself, but a future `_lib/foo.sh` reachable
          // via the root listing should still be excluded — hence the
          // explicit isFile() check.
          return fs.statSync(path.join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    // PKG_ROOT/hooks/ unreadable — fall through to the caller's
    // source-code union. This is a defensive branch; in practice the
    // packaged tarball always ships hooks/, and source builds always
    // have a hooks/ checked into the repo.
    return [];
  }
}

/**
 * 0.43.0 UX polish: build the human-readable install summary shown
 * BEFORE any files are written. Lists, in order: the policy file
 * being written, the chosen profile + autonomy, hook + agent counts
 * planned, the git/husky hooks planned (paths reflect what the
 * installer will ACTUALLY do given the target tree's shape), and
 * whether re-run preservation is active.
 *
 * 0.44.0 charter item 1: hook count + listing is derived from the
 * canonical hook resolvers via {@link canonicalInstalledHooks}, NOT
 * hard-coded. Adding a hook to `EXPECTED_HOOKS` or
 * `defaultDesiredHooks()` automatically reflects in this screen.
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
  // 0.44.0 charter item 1: hook count derived from the canonical
  // resolvers (EXPECTED_HOOKS + defaultDesiredHooks). Pre-fix this
  // line read `.claude/hooks/           — hook scripts (executable)`
  // with no count, so adding a new hook silently changed the install
  // surface without surfacing in the operator's confirm screen.
  const hookNames = canonicalInstalledHooks();
  lines.push(`  .claude/hooks/           — ${hookNames.length} hook scripts (executable):`);
  for (const name of hookNames) {
    lines.push(`      ${name}`);
  }
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
 * 0.44.0 charter item 2: detect filesystems where Unix mode bits are
 * unreliable (Windows-class FSes, WSL/native crossings, some network
 * mounts). On these, `stat.mode` for a freshly-installed `.sh` either
 * reads back without the `0o111` exec bit set, or is zeroed entirely.
 *
 * Pre-fix `postInstallVerify` hard-failed the install when zero `.sh`
 * files had the exec bit — every Windows install thus produced a
 * false-positive "0 executable .sh files" warning even on a perfectly
 * healthy install. We now treat exec-bit checks as advisory on these
 * filesystems and still verify the more meaningful invariant: the
 * files exist and have non-empty bytes.
 *
 * Detection strategy — three layers, ordered cheapest-first.
 *
 *   1. Platform — `process.platform === 'win32'` always skips the
 *      exec-bit check (native Windows has no POSIX mode bit; node's
 *      `stat.mode` is a translation that may or may not preserve the
 *      0o111 bit depending on the source).
 *   2. Unambiguous shapes via sample — sample the FIRST `.sh` file:
 *
 *      - All 0o777 bits clear (`0o000`) — historical mode-less shape.
 *        On a genuine Unix install no shipped hook is ever 0o000,
 *        and a chmod-stripped install (the only innocuous source of
 *        0o000) would already be unusable so a false skip there is
 *        harmless (the substitute presence + non-empty check still
 *        fires).
 *      - All 0o777 bits set (`0o777`) — "no info, everything exec";
 *        some SMB / NTFS-via-FUSE mounts surface this so file IO
 *        works regardless of source mode.
 *
 *   3. Active mode-bit probe (0.45.0 codex round-1 P1 fix) — for
 *      ambiguous shapes like `0o644` / `0o666` where the sample
 *      COULD be "mode-less mount surfacing as 0o644" OR "chmod-
 *      stripped genuine Unix install", do an active probe:
 *
 *        a. Write a temporary file with mode `0o755`.
 *        b. Stat it back; if the kernel returned a value missing
 *           the exec bits we just set, the FS truly ignores mode
 *           bits — mode-less.
 *        c. If the kernel returned `0o755` (preserved the mode),
 *           the FS DOES respect mode bits — the sampled hook's
 *           lack of exec bits is a real install failure, NOT a
 *           mode-less mount. Return false so the caller emits the
 *           genuine "zero executable .sh files" error.
 *        d. If the probe itself fails (EROFS, EPERM, ENOSPC,
 *           anything), fall through to false — let the caller
 *           surface the real installation failure rather than
 *           hide it behind an advisory.
 *
 *      Pre-fix the `0o644` branch suppressed the exec-bit check
 *      unconditionally, masking genuinely broken Unix installs.
 *
 * Returns true when the exec-bit check should be SKIPPED.
 *
 * Exported for testability — callers can stub the filesystem and
 * exercise all three shapes without spinning up an actual Windows VM.
 */
export function isModeLessFilesystem(hooksDir: string): boolean {
  if (process.platform === 'win32') return true;
  // Sample any single .sh file to probe whether the FS preserves
  // exec bits at all. We don't need every file — just one signal.
  try {
    const entries = fs.readdirSync(hooksDir);
    const firstSh = entries.find((e) => e.endsWith('.sh'));
    if (firstSh === undefined) {
      // No .sh files at all — let the caller's existence check fire.
      // Treat as mode-aware (skip = false) so we don't hide the
      // genuinely-missing-files case behind the WSL advisory.
      return false;
    }
    const stat = fs.statSync(path.join(hooksDir, firstSh));
    const perm = stat.mode & 0o777;
    // (a) All 0o777 bits clear — historical mode-less detection.
    if (perm === 0) return true;
    // (b) All 0o777 bits set — some SMB / FUSE mounts surface this.
    if (perm === 0o777) return true;
    // (c) 0.45.0 codex round-1 P1 fix: when 0o111 bits are clear
    //     (e.g. 0o644 / 0o666), we MUST disambiguate "mode-less
    //     mount that surfaces as 0o644" from "chmod-stripped Unix
    //     install" via an active write-then-stat probe. The pre-fix
    //     unconditional skip masked genuinely-broken Unix installs.
    if ((perm & 0o111) === 0) {
      return filesystemIgnoresModeBits(hooksDir);
    }
    return false;
  } catch {
    // Stat failed — let the caller's enumeration handle the error.
    // Returning false here means "don't skip" so a genuine ENOENT
    // surfaces through the normal exec-bit branch.
    return false;
  }
}

/**
 * 0.45.0 codex round-1 P1 fix: active probe to disambiguate a
 * mode-less filesystem from a chmod-stripped genuine Unix install.
 *
 * Writes a temporary file with mode `0o755` and stats it back. If
 * the kernel returns a value that LACKS the exec bits we just set,
 * the filesystem is ignoring mode bits — it's truly mode-less.
 * Otherwise (kernel preserves the mode, OR the probe fails for any
 * reason), return false so the caller surfaces the real install
 * failure instead of hiding it behind an advisory.
 *
 * Probe file is written into `hooksDir` to match the exact mount
 * the caller is checking — sampling a different directory could
 * cross a mount boundary and lie about the target FS. The file is
 * always unlinked, even on probe failure.
 *
 * Exported for testability.
 */
export function filesystemIgnoresModeBits(hooksDir: string): boolean {
  const probePath = path.join(hooksDir, `.rea-modeless-probe-${process.pid}-${Date.now()}`);
  try {
    // 0.45.0 codex round-2 P2: write WITHOUT the mode option, then
    // explicitly chmod to 0o755. `writeFileSync({ mode })` is filtered
    // through the process umask, so a caller running under e.g.
    // `umask 0111` would have their probe land as 0o644 even on a
    // real Unix FS — falsely flagging mode-less and re-introducing
    // the bug the round-1 fix was trying to close. Explicit chmod
    // bypasses umask and always lands exactly the bits we asked for
    // (when the FS honors them, which is the property we're probing).
    fs.writeFileSync(probePath, '');
    fs.chmodSync(probePath, 0o755);
    const stat = fs.statSync(probePath);
    const perm = stat.mode & 0o777;
    // If the kernel preserved any of our exec bits, the FS honors
    // mode bits — NOT mode-less.
    if ((perm & 0o111) !== 0) return false;
    // Kernel stripped every exec bit we wrote — mode-less.
    return true;
  } catch {
    // Probe write/stat failed (read-only mount, EPERM, ENOSPC).
    // Conservative: return false so the caller emits the real error
    // rather than swallow it behind an advisory.
    return false;
  } finally {
    try {
      fs.unlinkSync(probePath);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * 0.43.0 UX polish: post-install sanity check. Runs synchronously
 * after the file-write phase to catch installs that completed
 * "successfully" but are missing a critical artifact (write
 * permissions issue, partial copy, etc.).
 *
 * 0.44.0 charter item 2: exec-bit check is skipped on mode-less
 * filesystems (Windows / WSL-crossing / SMB mounts). When skipped, we
 * still verify the files exist + are non-empty — that's the invariant
 * a partial-copy or zero-byte write would actually violate. The skip
 * is annotated in the returned advisory so the operator knows why a
 * check they expected to run didn't.
 *
 * Strictly read-only — no probes that touch python3 / jq / codex.
 * Pattern modelled on the synthetic round-trip checks established by
 * `checkDelegationRoundTrip` in 0.29.0/0.31.0: cheap, in-process,
 * sufficient to catch the "looks-installed-but-isn't" failure shape
 * that bites first-time consumers hardest. For deep diagnostics
 * point the operator at `rea doctor`.
 *
 * Returns the list of issues found (empty = healthy). Advisory
 * (skipped-check) lines are prefixed with `advisory:` so the caller
 * can distinguish them from real issues if desired. The caller
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

  // 2. .claude/hooks directory present with non-empty scripts (and,
  //    on mode-aware filesystems, executable).
  const hooksDir = path.join(targetDir, '.claude', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    issues.push(`.claude/hooks/ directory missing after install (expected at ${hooksDir})`);
  } else {
    const modeLess = isModeLessFilesystem(hooksDir);
    let executableCount = 0;
    let shCount = 0;
    try {
      for (const entry of fs.readdirSync(hooksDir)) {
        if (!entry.endsWith('.sh')) continue;
        shCount += 1;
        const stat = fs.statSync(path.join(hooksDir, entry));
        if ((stat.mode & 0o111) !== 0) executableCount += 1;
      }
    } catch (e) {
      issues.push(
        `failed to enumerate .claude/hooks/: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (modeLess) {
      // 0.44.0 charter item 2: emit a one-liner advisory so the
      // operator understands why the exec-bit check didn't run. Still
      // verify the files exist + have content — that's the partial-
      // copy failure shape we genuinely want to catch on these FSes.
      //
      // 0.44.0 codex round-1 P2 fix: validate the FULL canonical hook
      // set, not just `shCount > 0 && nonEmptyCount > 0`. Pre-fix a
      // partial copy that left ONE non-empty .sh and dropped the rest
      // would still report "install looks healthy" because the
      // substitute invariant only required at least one survivor.
      // Now we per-file check every entry in canonicalInstalledHooks()
      // for existence + non-empty bytes — equivalent rigor to the
      // mode-aware path's per-file exec-bit check.
      issues.push(
        'advisory: skipping exec-bit check on this filesystem ' +
          '(Windows/WSL/SMB-class; mode bits not reliable). ' +
          'Verifying per-file presence and non-empty content instead.',
      );
      const expected = canonicalInstalledHooks();
      const missing: string[] = [];
      const empty: string[] = [];
      for (const name of expected) {
        const hookPath = path.join(hooksDir, name);
        if (!fs.existsSync(hookPath)) {
          missing.push(name);
          continue;
        }
        try {
          const stat = fs.statSync(hookPath);
          if (stat.size === 0) empty.push(name);
        } catch {
          // Treat unstattable as missing — the partial-copy failure
          // shape we are trying to detect.
          missing.push(name);
        }
      }
      if (missing.length > 0) {
        issues.push(
          `.claude/hooks/ is missing ${missing.length} expected hook file(s): ${missing.join(', ')}`,
        );
      }
      if (empty.length > 0) {
        issues.push(
          `.claude/hooks/ has ${empty.length} empty hook file(s): ${empty.join(', ')}`,
        );
      }
      // Fallback for the no-canonical-list-known case (defensive — the
      // helper always returns >=1 in practice, but if a future
      // refactor empties the resolvers we still want to catch a
      // completely-empty hooks dir).
      if (expected.length === 0 && shCount === 0) {
        issues.push('.claude/hooks/ contains zero .sh files — run `rea doctor`');
      }
    } else if (executableCount === 0) {
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
      // R12-P1 (codex round 12): preserve bootstrap_allowlist.enabled
      // so an operator opt-out survives `rea init` re-runs.
      ...bootstrapAllowlistConfigSpread(layeredBase, existingPolicy),
      // 0.51.0 spend-governance — emit the billing→HALT block (ON in every
      // shipped profile; schema default is OFF so it MUST be written).
      ...spendGovernanceConfigSpread(layeredBase, existingPolicy),
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

  // R11-P1 (codex round 11): blocking-pin pre-flight. Same security
  // guarantee as `runUpgrade`'s pre-flight (R9-P1) but for the init
  // surface. If `package.json` already pins `@bookedsolid/rea` to a
  // version that does NOT admit the installed CLI version
  // (workspace:*, file:.., git URLs, dist-tags, exact older pins,
  // cross-major caret), writing 0.49 hooks + policy artifacts on
  // top creates a hook/CLI skew: the bash gates resolve the older
  // CLI from node_modules and that CLI's strict policy loader
  // rejects the new `bootstrap_allowlist:` top-level key.
  //
  // Pre-R11 the pre-flight was upgrade-only. Operators running `rea
  // init` to reinstall (a common pattern on consumer repos) hit
  // the same trap. We run the same check here, BEFORE the first
  // `.rea/` mkdir — so a refused init leaves the consumer's
  // existing state untouched.
  //
  // Fresh-clone repos (no existing pin) return `kind: 'ok'` from
  // the check, so this branch is a no-op for the canonical init
  // path.
  {
    const initPinCheck = await checkUpgradeBlockingPin({
      cwd: targetDir,
      cliVersion: getPkgVersion(),
      mode: 'init',
    });
    if (initPinCheck.kind === 'block' || initPinCheck.kind === 'block-symlink') {
      // R10-P2: block-symlink is the symlinked-pkg.json variant.
      // Both kinds share the `reason` field; throw with the
      // operator-actionable explainer. The throw lands in
      // `main().catch(...)` (src/cli/index.ts) which surfaces the
      // multi-line message via the standard `err` path.
      throw new Error(initPinCheck.reason);
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
  let selfPinResult: Awaited<ReturnType<typeof selfPinRea>>;
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

    // 0.49.0 — self-pin `@bookedsolid/rea` as `^<cli-version>` in the
    // consumer's package.json (devDependencies). Without this, the hook
    // shims that init JUST wrote depend on a CLI that the next `pnpm
    // install` does not actually install. The bash-gate bootstrap
    // allowlist (Fix B) recovers the brick state when the dep IS
    // declared but the CLI is not yet built; without the dep declared,
    // the allowlist refuses (no precondition forge route — must be a
    // legitimate top-level declaration). See `src/cli/install/self-pin.ts`
    // for the full contract.
    //
    // R13-P1 (codex round 13): `mode: 'upgrade'` — managed-caret pins
    // that don't admit the installed CLI MUST bump in place during
    // `rea init` too. Pre-R13 init used the default `mode: 'init'`
    // (warn-and-skip), but the R11-P1 preflight already filters out
    // the non-managed-caret cases (workspace, file:, git, dist-tag,
    // exact) — so anything reaching this line is either a fresh
    // write OR a managed-caret bump. `mode: 'upgrade'` is the right
    // semantics for both. Without this fix, `rea init` on a repo
    // with `^0.49.0` + CLI 0.50.0 wrote new hooks/policy but left
    // the pin behind — recreating the hook/CLI skew the preflight
    // was supposed to prevent.
    selfPinResult = await selfPinRea({
      cwd: targetDir,
      cliVersion: getPkgVersion(),
      mode: 'upgrade',
    });

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
  // 0.49.0 self-pin reporting. One line per outcome; warn-and-skip is
  // surfaced loudly so the operator notices a mismatched pin.
  //
  // R18-P2 (codex round 18): R13-P1 switched `rea init` to
  // `mode: 'upgrade'` so re-running init on a repo with a managed-
  // caret pin from an older CLI auto-bumps to the new CLI's caret.
  // The reporting ladder lacked a `'bumped'` arm — the file was
  // mutated but the success summary printed no line about it,
  // making the install output incomplete. Mirrors the `'bumped'`
  // arm in `rea upgrade` (see src/cli/upgrade.ts) so the operator
  // sees the pin delta explicitly in both surfaces.
  if (selfPinResult.action === 'wrote' && selfPinResult.packageJsonPath !== null) {
    console.log(
      `  ~ ${path.relative(targetDir, selfPinResult.packageJsonPath)} (self-pin: @bookedsolid/rea@${selfPinResult.pinnedRange})`,
    );
  } else if (selfPinResult.action === 'bumped' && selfPinResult.packageJsonPath !== null) {
    console.log(
      `  ✓ ${path.relative(targetDir, selfPinResult.packageJsonPath)} (self-pin: bumped @bookedsolid/rea from ${selfPinResult.existingRange ?? '?'} to ${selfPinResult.pinnedRange})`,
    );
  } else if (selfPinResult.action === 'skipped-same' && selfPinResult.packageJsonPath !== null) {
    console.log(
      `  · ${path.relative(targetDir, selfPinResult.packageJsonPath)} (self-pin: already declared)`,
    );
  } else if (selfPinResult.action === 'skipped-different') {
    warn(selfPinResult.message);
  } else if (selfPinResult.action === 'skipped-dogfood') {
    // Silent — dogfood install, expected.
  } else if (selfPinResult.action === 'skipped-no-package-json') {
    warn(
      'self-pin skipped — no package.json found upward from target; bash gates will refuse on a fresh clone unless you add `@bookedsolid/rea` to a package.json',
    );
  } else if (selfPinResult.action === 'skipped-malformed-package-json') {
    warn(selfPinResult.message);
  }
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
  // 0.44.0 charter item 2: split advisory (`advisory:`-prefixed) from
  // real issues. Advisories explain skipped checks (Windows/WSL exec-
  // bit skip) and don't merit the loud "verification flagged" header
  // when no real issue is present.
  const realIssues = verifyIssues.filter((i) => !i.startsWith('advisory:'));
  const advisories = verifyIssues.filter((i) => i.startsWith('advisory:'));
  if (realIssues.length > 0) {
    console.log('');
    warn('post-install verification flagged the following:');
    for (const issue of realIssues) warn(`  • ${issue}`);
    for (const adv of advisories) warn(`  • ${adv}`);
    warn('Run `rea doctor` for a full diagnostic.');
  } else if (advisories.length > 0) {
    if (interactive) {
      p.log.success('Post-install check: install looks healthy.');
      for (const adv of advisories) p.log.info(adv);
    } else {
      console.log('');
      console.log('Post-install check: install looks healthy.');
      for (const adv of advisories) console.log(`  ${adv}`);
    }
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
