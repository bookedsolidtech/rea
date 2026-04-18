import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { AutonomyLevel } from '../policy/types.js';
import { HARD_DEFAULTS, loadProfile, mergeProfiles, type Profile } from '../policy/profiles.js';
import { copyArtifacts } from './install/copy.js';
import {
  defaultDesiredHooks,
  mergeSettings,
  readSettings,
  writeSettingsAtomic,
} from './install/settings-merge.js';
import { installCommitMsgHook } from './install/commit-msg.js';
import { writeClaudeMdFragment } from './install/claude-md.js';
import {
  defaultReagentPath,
  ReagentDroppedFieldsError,
  translateReagentPolicy,
} from './install/reagent.js';
import {
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
}

type ProfileName = 'client-engagement' | 'bst-internal' | 'lit-wc' | 'open-source' | 'minimal';

const PROFILE_NAMES: ProfileName[] = [
  'minimal',
  'client-engagement',
  'bst-internal',
  'lit-wc',
  'open-source',
];

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
function resolveLayered(
  profileName: ProfileName,
  reagentTranslated: Profile | null,
): Profile {
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
        { value: 'client-engagement', label: 'client-engagement', hint: 'zero-trust client project' },
        { value: 'bst-internal', label: 'bst-internal', hint: 'internal BST projects' },
        { value: 'lit-wc', label: 'lit-wc', hint: 'Lit / web component libraries' },
        { value: 'open-source', label: 'open-source', hint: 'public OSS repos' },
      ],
    });
    if (p.isCancel(picked)) cancel('Init cancelled.');
    profileName = picked;
  }

  const autonomyDefault = layeredBase.autonomy_level ?? AutonomyLevel.L1;
  const autonomyPick = await p.select<AutonomyLevel>({
    message: 'Starting autonomy_level',
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
  const defaultMax: AutonomyLevel =
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

  p.outro('Config collected — installing files.');

  return {
    profile: profileName,
    autonomyLevel,
    maxAutonomyLevel,
    blockAiAttribution,
    blockedPaths: layeredBase.blocked_paths ?? ['.env', '.env.*'],
    notificationChannel: layeredBase.notification_channel ?? '',
    fromReagent,
    reagentPolicyPath,
    reagentNotices: [],
  };
}

function writePolicyYaml(targetDir: string, config: ResolvedConfig, layered: Profile): string {
  const policyPath = path.join(targetDir, REA_DIR, POLICY_FILE);
  const installedBy = process.env.USER ?? os.userInfo().username ?? 'unknown';
  const installedAt = new Date().toISOString();

  const lines: string[] = [];
  lines.push(`# .rea/policy.yaml — managed by rea v${getPkgVersion()}`);
  lines.push(`# Edit carefully: tightening takes effect on next load; loosening requires human approval.`);
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
    `version: "1"`,
    `servers: []`,
    ``,
  ].join('\n');
  fs.writeFileSync(registryPath, content, 'utf8');
  return registryPath;
}

export async function runInit(options: InitOptions): Promise<void> {
  const targetDir = process.cwd();
  const reagentPolicyPath = detectReagentPolicy(targetDir);
  const reaDir = path.join(targetDir, REA_DIR);
  const policyPath = path.join(reaDir, POLICY_FILE);

  if (fs.existsSync(policyPath) && options.yes !== true && options.force !== true) {
    err(`.rea/policy.yaml already exists at ${policyPath}`);
    console.error('');
    console.error('  Refusing to overwrite. Pass --force to replace, or --yes to accept current settings.');
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
      baseProfile?.max_autonomy_level ??
      HARD_DEFAULTS.max_autonomy_level ??
      AutonomyLevel.L2;
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

  let config: ResolvedConfig;

  if (options.yes === true) {
    config = {
      profile: profileName,
      autonomyLevel: layeredBase.autonomy_level ?? AutonomyLevel.L1,
      maxAutonomyLevel: layeredBase.max_autonomy_level ?? AutonomyLevel.L2,
      blockAiAttribution: layeredBase.block_ai_attribution ?? true,
      blockedPaths: layeredBase.blocked_paths ?? ['.env', '.env.*'],
      notificationChannel: layeredBase.notification_channel ?? '',
      fromReagent,
      reagentPolicyPath,
      reagentNotices,
    };
    log(
      `Non-interactive init: profile=${profileName}, autonomy=${config.autonomyLevel}, max=${config.maxAutonomyLevel}, attribution-block=${config.blockAiAttribution}`,
    );
  } else {
    config = await runWizard(options, targetDir, reagentPolicyPath, layeredBase);
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

  const mdResult = await writeClaudeMdFragment(targetDir, {
    policyPath: `.${path.sep}rea${path.sep}policy.yaml`.replace(/\\/g, '/'),
    profile: config.profile,
    autonomyLevel: config.autonomyLevel,
    maxAutonomyLevel: config.maxAutonomyLevel,
    blockedPathsCount: config.blockedPaths.length,
    blockAiAttribution: config.blockAiAttribution,
  });

  console.log('');
  log('init complete');
  for (const file of written) console.log(`  + ${path.relative(targetDir, file)}`);
  console.log(
    `  + .claude/ (${copyResult.copied.length} copied, ${copyResult.overwritten.length} overwritten, ${copyResult.skipped.length} skipped)`,
  );
  console.log(
    `  + .claude/settings.json (${mergeResult.addedCount} hook entries added, ${mergeResult.skippedCount} already present)`,
  );
  if (commitMsgResult.gitHook) console.log(`  + ${path.relative(targetDir, commitMsgResult.gitHook)}`);
  if (commitMsgResult.huskyHook)
    console.log(`  + ${path.relative(targetDir, commitMsgResult.huskyHook)}`);
  console.log(
    `  ${mdResult.replaced ? '~' : '+'} ${path.relative(targetDir, mdResult.path)} (fragment ${mdResult.replaced ? 'replaced' : 'written'})`,
  );

  if (mergeResult.warnings.length > 0) {
    console.log('');
    for (const w of mergeResult.warnings) warn(w);
  }
  for (const w of commitMsgResult.warnings) warn(w);
  for (const n of config.reagentNotices) warn(n);

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
