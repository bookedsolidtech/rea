import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '../policy/loader.js';
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

function checkCodexPlugin(baseDir: string): CheckResult {
  const commandsDir = path.join(baseDir, '.claude', 'commands');
  if (!fs.existsSync(commandsDir)) {
    return {
      label: 'Codex plugin command(s)',
      status: 'warn',
      detail: 'no .claude/commands/ directory — Codex adversarial review not wired',
    };
  }
  const entries = fs.readdirSync(commandsDir);
  const codexEntry = entries.find((name) => name.toLowerCase().startsWith('codex'));
  if (codexEntry !== undefined) {
    return { label: 'Codex plugin command(s)', status: 'pass', detail: codexEntry };
  }
  return {
    label: 'Codex plugin command(s)',
    status: 'warn',
    detail: 'no .claude/commands/codex* found — /codex-review will not be available',
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
  const reaDir = path.join(baseDir, REA_DIR);
  const commitMsgHook = path.join(baseDir, '.git', 'hooks', 'commit-msg');

  const checks: CheckResult[] = [
    checkFileExists('.rea/ directory exists', reaDir, true),
    checkPolicyParses(baseDir, policyPath),
    checkFileExists('.rea/registry.yaml exists', registryPath, false),
    checkFileExists('.git/hooks/commit-msg installed', commitMsgHook, false),
    checkCodexPlugin(baseDir),
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
