import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { AutonomyLevel } from '../policy/types.js';
import {
  POLICY_FILE,
  REA_DIR,
  REGISTRY_FILE,
  err,
  getPkgVersion,
  log,
} from './utils.js';

export interface InitOptions {
  yes?: boolean | undefined;
  fromReagent?: boolean | undefined;
  profile?: string | undefined;
}

type Profile = 'client-engagement' | 'bst-internal' | 'lit-wc' | 'open-source' | 'minimal';

const PROFILES: Profile[] = [
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
  profile: Profile;
  autonomyLevel: AutonomyLevel;
  maxAutonomyLevel: AutonomyLevel;
  blockAiAttribution: boolean;
  fromReagent: boolean;
  reagentPolicyPath: string | null;
}

function detectReagentPolicy(targetDir: string): string | null {
  const reagentPolicy = path.join(targetDir, '.reagent', 'policy.yaml');
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

function isValidProfile(value: string): value is Profile {
  return (PROFILES as readonly string[]).includes(value);
}

function cancel(message: string): never {
  p.cancel(message);
  process.exit(0);
}

async function runWizard(
  options: InitOptions,
  targetDir: string,
  reagentPolicyPath: string | null,
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
  let profile: Profile;
  if (options.profile !== undefined) {
    if (!isValidProfile(options.profile)) {
      p.cancel(
        `Unknown profile: "${options.profile}". Valid: ${PROFILES.join(', ')}`,
      );
      process.exit(1);
    }
    profile = options.profile;
    p.log.info(`Profile: ${profile} (from --profile)`);
  } else {
    const picked = await p.select<Profile>({
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
    profile = picked;
  }

  // Autonomy level
  const autonomyPick = await p.select<AutonomyLevel>({
    message: 'Starting autonomy_level',
    initialValue: AutonomyLevel.L1,
    options: [
      { value: AutonomyLevel.L0, label: 'L0', hint: 'read-only; every write needs approval' },
      { value: AutonomyLevel.L1, label: 'L1', hint: 'default — writes allowed, destructive gated' },
      { value: AutonomyLevel.L2, label: 'L2', hint: 'wider latitude; destructive ops allowed' },
      { value: AutonomyLevel.L3, label: 'L3', hint: 'full autonomy (rare — supervised only)' },
    ],
  });
  if (p.isCancel(autonomyPick)) cancel('Init cancelled.');
  const autonomyLevel = autonomyPick;

  // Max autonomy ceiling — constrain to levels >= autonomy
  const maxCandidates = AUTONOMY_LEVELS.filter(
    (lvl) => levelRank(lvl) >= levelRank(autonomyLevel),
  );
  const defaultMax: AutonomyLevel =
    maxCandidates.find((l) => l === AutonomyLevel.L2) ?? autonomyLevel;

  const maxOptions = maxCandidates.map((lvl): { value: AutonomyLevel; label: string; hint?: string } => {
    if (lvl === autonomyLevel) {
      return { value: lvl, label: lvl, hint: 'same as starting level' };
    }
    return { value: lvl, label: lvl };
  });
  const maxPick = await p.select<AutonomyLevel>({
    message: 'max_autonomy_level (ceiling — cannot be exceeded at runtime)',
    initialValue: defaultMax,
    // Cast: clack's Option type is a discriminated union over the literal values,
    // but here we build it dynamically from the AutonomyLevel enum.
    options: maxOptions as Parameters<typeof p.select<AutonomyLevel>>[0]['options'],
  });
  if (p.isCancel(maxPick)) cancel('Init cancelled.');
  const maxAutonomyLevel = maxPick;

  // block_ai_attribution
  const attribPick = await p.confirm({
    message: 'Enforce block_ai_attribution (reject AI-authored commit trailers)?',
    initialValue: true,
  });
  if (p.isCancel(attribPick)) cancel('Init cancelled.');
  const blockAiAttribution = attribPick === true;

  p.outro('Config collected — writing files.');

  return {
    profile,
    autonomyLevel,
    maxAutonomyLevel,
    blockAiAttribution,
    fromReagent,
    reagentPolicyPath,
  };
}

function writePolicyYaml(targetDir: string, config: ResolvedConfig): string {
  const policyPath = path.join(targetDir, REA_DIR, POLICY_FILE);
  const installedBy = process.env.USER ?? os.userInfo().username ?? 'unknown';
  const installedAt = new Date().toISOString();

  const lines = [
    `# .rea/policy.yaml — managed by rea v${getPkgVersion()}`,
    `# Edit carefully: tightening takes effect on next load; loosening requires human approval.`,
    `version: "1"`,
    `profile: ${JSON.stringify(config.profile)}`,
    `installed_by: ${JSON.stringify(installedBy)}`,
    `installed_at: ${JSON.stringify(installedAt)}`,
    `autonomy_level: ${config.autonomyLevel}`,
    `max_autonomy_level: ${config.maxAutonomyLevel}`,
    `promotion_requires_human_approval: true`,
    `block_ai_attribution: ${config.blockAiAttribution ? 'true' : 'false'}`,
    `blocked_paths:`,
    `  - ".env"`,
    `  - ".env.*"`,
    `notification_channel: ""`,
    ``,
  ];
  fs.writeFileSync(policyPath, lines.join('\n'), 'utf8');
  return policyPath;
}

function writeRegistryYaml(targetDir: string): string {
  const registryPath = path.join(targetDir, REA_DIR, REGISTRY_FILE);
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

  if (fs.existsSync(policyPath) && options.yes !== true) {
    err(`.rea/policy.yaml already exists at ${policyPath}`);
    console.error('');
    console.error('  Refusing to overwrite. Pass --yes to force, or remove the file first.');
    console.error('');
    process.exit(1);
  }

  let config: ResolvedConfig;

  if (options.yes === true) {
    const profile: Profile =
      options.profile !== undefined && isValidProfile(options.profile)
        ? options.profile
        : 'minimal';
    config = {
      profile,
      autonomyLevel: AutonomyLevel.L1,
      maxAutonomyLevel: AutonomyLevel.L2,
      blockAiAttribution: true,
      fromReagent: options.fromReagent === true,
      reagentPolicyPath,
    };
    log(`Non-interactive init: profile=${profile}, autonomy=L1, max=L2, attribution-block=true`);
  } else {
    config = await runWizard(options, targetDir, reagentPolicyPath);
  }

  if (!fs.existsSync(reaDir)) {
    fs.mkdirSync(reaDir, { recursive: true });
  }

  const written: string[] = [];
  written.push(writePolicyYaml(targetDir, config));
  written.push(writeRegistryYaml(targetDir));

  // TODO: copy hooks/commands/agents once templates directory ships
  // TODO: merge .claude/settings.json once hook registration is defined
  // TODO: install .husky/commit-msg + .git/hooks/commit-msg for block_ai_attribution

  console.log('');
  log('init complete');
  for (const file of written) {
    console.log(`  + ${path.relative(targetDir, file)}`);
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
    console.log('  Field-for-field translation is not yet automated — review both files manually.');
    console.log('  Once satisfied, you can remove the .reagent/ directory.');
  }
  console.log('');
  console.log('  Hooks, slash commands, and agents are not installed yet — coming in a follow-up.');
  console.log('');
}
