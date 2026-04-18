import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '../policy/loader.js';
import { loadRegistry } from '../registry/loader.js';
import { POLICY_FILE, REA_DIR, REGISTRY_FILE, log, reaPath } from './utils.js';

interface CheckResult {
  label: string;
  status: 'pass' | 'fail' | 'warn';
  detail?: string;
}

function checkFileExists(label: string, filePath: string, fatal: boolean): CheckResult {
  const exists = fs.existsSync(filePath);
  if (exists) return { label, status: 'pass' };
  return { label, status: fatal ? 'fail' : 'warn', detail: `missing: ${filePath}` };
}

function checkPolicyParses(baseDir: string, policyPath: string): CheckResult {
  if (!fs.existsSync(policyPath)) {
    return {
      label: 'policy.yaml parses',
      status: 'fail',
      detail: `missing: ${policyPath} — run \`npx rea init\``,
    };
  }
  try {
    const policy = loadPolicy(baseDir);
    return {
      label: 'policy.yaml parses',
      status: 'pass',
      detail: `profile=${policy.profile}, autonomy=${policy.autonomy_level}`,
    };
  } catch (e) {
    return {
      label: 'policy.yaml parses',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function checkRegistryParses(baseDir: string, registryPath: string): CheckResult {
  if (!fs.existsSync(registryPath)) {
    return {
      label: 'registry.yaml parses',
      status: 'warn',
      detail: `missing: ${registryPath}`,
    };
  }
  try {
    const registry = loadRegistry(baseDir);
    return {
      label: 'registry.yaml parses',
      status: 'pass',
      detail: `${registry.servers.length} server(s) declared`,
    };
  } catch (e) {
    return {
      label: 'registry.yaml parses',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

const EXPECTED_AGENTS = [
  'accessibility-engineer.md',
  'backend-engineer.md',
  'code-reviewer.md',
  'codex-adversarial.md',
  'frontend-specialist.md',
  'qa-engineer.md',
  'rea-orchestrator.md',
  'security-engineer.md',
  'technical-writer.md',
  'typescript-specialist.md',
];

const EXPECTED_HOOKS = [
  'architecture-review-gate.sh',
  'attribution-advisory.sh',
  'blocked-paths-enforcer.sh',
  'changeset-security-gate.sh',
  'commit-review-gate.sh',
  'dangerous-bash-interceptor.sh',
  'dependency-audit-gate.sh',
  'env-file-protection.sh',
  'pr-issue-link-gate.sh',
  'push-review-gate.sh',
  'secret-scanner.sh',
  'security-disclosure-gate.sh',
  'settings-protection.sh',
];

function checkAgentsPresent(baseDir: string): CheckResult {
  const agentsDir = path.join(baseDir, '.claude', 'agents');
  if (!fs.existsSync(agentsDir)) {
    return { label: 'curated agents installed', status: 'fail', detail: `missing: ${agentsDir}` };
  }
  const missing = EXPECTED_AGENTS.filter(
    (name) => !fs.existsSync(path.join(agentsDir, name)),
  );
  if (missing.length === 0) {
    return {
      label: 'curated agents installed',
      status: 'pass',
      detail: `${EXPECTED_AGENTS.length} agents present`,
    };
  }
  return {
    label: 'curated agents installed',
    status: 'fail',
    detail: `missing: ${missing.join(', ')}`,
  };
}

function checkHooksInstalled(baseDir: string): CheckResult {
  const hooksDir = path.join(baseDir, '.claude', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    return { label: 'hooks installed + executable', status: 'fail', detail: `missing: ${hooksDir}` };
  }
  const issues: string[] = [];
  for (const name of EXPECTED_HOOKS) {
    const p = path.join(hooksDir, name);
    if (!fs.existsSync(p)) {
      issues.push(`missing ${name}`);
      continue;
    }
    const stat = fs.statSync(p);
    if ((stat.mode & 0o111) === 0) issues.push(`${name} not executable (mode=${(stat.mode & 0o777).toString(8)})`);
  }
  if (issues.length === 0) {
    return {
      label: 'hooks installed + executable',
      status: 'pass',
      detail: `${EXPECTED_HOOKS.length} hooks present`,
    };
  }
  return { label: 'hooks installed + executable', status: 'fail', detail: issues.join('; ') };
}

function checkSettingsJson(baseDir: string): CheckResult {
  const settingsPath = path.join(baseDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return {
      label: 'settings.json matchers cover Bash + Write|Edit',
      status: 'fail',
      detail: `missing: ${settingsPath}`,
    };
  }
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      hooks?: Record<string, Array<{ matcher?: string }>>;
    };
    const pre = parsed.hooks?.PreToolUse ?? [];
    const matchers = new Set(pre.map((g) => g.matcher).filter((m): m is string => typeof m === 'string'));
    const needs: string[] = [];
    if (!matchers.has('Bash')) needs.push('Bash');
    if (!matchers.has('Write|Edit')) needs.push('Write|Edit');
    if (needs.length === 0) {
      return {
        label: 'settings.json matchers cover Bash + Write|Edit',
        status: 'pass',
      };
    }
    return {
      label: 'settings.json matchers cover Bash + Write|Edit',
      status: 'fail',
      detail: `missing PreToolUse matchers: ${needs.join(', ')}`,
    };
  } catch (e) {
    return {
      label: 'settings.json matchers cover Bash + Write|Edit',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function checkCommitMsgHook(baseDir: string): CheckResult {
  const hookPath = path.join(baseDir, '.git', 'hooks', 'commit-msg');
  if (!fs.existsSync(hookPath)) {
    return {
      label: 'commit-msg hook installed',
      status: 'warn',
      detail: `missing: ${hookPath} (block_ai_attribution will not be enforced at commit time)`,
    };
  }
  try {
    const stat = fs.statSync(hookPath);
    if (stat.size === 0) {
      return { label: 'commit-msg hook installed', status: 'fail', detail: 'file is empty' };
    }
    return { label: 'commit-msg hook installed', status: 'pass' };
  } catch (e) {
    return {
      label: 'commit-msg hook installed',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function checkCodexAgent(baseDir: string): CheckResult {
  const agentPath = path.join(baseDir, '.claude', 'agents', 'codex-adversarial.md');
  if (fs.existsSync(agentPath)) return { label: 'codex-adversarial agent installed', status: 'pass' };
  return {
    label: 'codex-adversarial agent installed',
    status: 'warn',
    detail: `missing: ${agentPath}`,
  };
}

function checkCodexCommand(baseDir: string): CheckResult {
  const cmdPath = path.join(baseDir, '.claude', 'commands', 'codex-review.md');
  if (fs.existsSync(cmdPath)) return { label: '/codex-review command installed', status: 'pass' };
  return {
    label: '/codex-review command installed',
    status: 'warn',
    detail: `missing: ${cmdPath}`,
  };
}

function formatSymbol(status: CheckResult['status']): string {
  if (status === 'pass') return '[ok]  ';
  if (status === 'warn') return '[warn]';
  return '[fail]';
}

export function runDoctor(): void {
  const baseDir = process.cwd();
  const policyPath = reaPath(baseDir, POLICY_FILE);
  const registryPath = reaPath(baseDir, REGISTRY_FILE);
  const reaDirPath = path.join(baseDir, REA_DIR);

  const checks: CheckResult[] = [
    checkFileExists('.rea/ directory exists', reaDirPath, true),
    checkPolicyParses(baseDir, policyPath),
    checkRegistryParses(baseDir, registryPath),
    checkAgentsPresent(baseDir),
    checkHooksInstalled(baseDir),
    checkSettingsJson(baseDir),
    checkCommitMsgHook(baseDir),
    checkCodexAgent(baseDir),
    checkCodexCommand(baseDir),
  ];

  console.log('');
  log(`Doctor — ${baseDir}`);
  console.log('');

  let hardFail = false;
  for (const c of checks) {
    const detail = c.detail !== undefined ? `  (${c.detail})` : '';
    console.log(`  ${formatSymbol(c.status)} ${c.label}${detail}`);
    if (c.status === 'fail') hardFail = true;
  }

  console.log('');
  if (hardFail) {
    log('Doctor: one or more hard checks failed.');
    console.log('');
    process.exit(1);
  }
  log('Doctor: OK (warnings do not fail the check).');
  console.log('');
}
