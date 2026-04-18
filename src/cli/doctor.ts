import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '../policy/loader.js';
import { loadRegistry } from '../registry/loader.js';
import {
  CodexProbe,
  type CodexProbeState,
} from '../gateway/observability/codex-probe.js';
import { summarizeTelemetry } from '../gateway/observability/codex-telemetry.js';
import { POLICY_FILE, REA_DIR, REGISTRY_FILE, log, reaPath } from './utils.js';

export interface CheckResult {
  label: string;
  /**
   * `info` is purely informational — not a pass, fail, or warning. Used to
   * print a one-line note about why a check was skipped (e.g. "codex:
   * disabled via policy.review.codex_required").
   */
  status: 'pass' | 'fail' | 'warn' | 'info';
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

/**
 * Translate a `CodexProbeState` into two doctor CheckResults: one for
 * responsiveness (pass/warn) and one informational line about the last
 * probe time. Extracted so tests can feed a stub state without running
 * the real probe.
 */
export function checksFromProbeState(state: CodexProbeState): CheckResult[] {
  const responsive: CheckResult = state.cli_responsive
    ? state.version !== undefined
      ? {
          label: 'codex.cli_responsive',
          status: 'pass',
          detail: `version: ${state.version}`,
        }
      : { label: 'codex.cli_responsive', status: 'pass' }
    : {
        label: 'codex.cli_responsive',
        status: 'warn',
        detail: state.last_error ?? 'Codex CLI did not respond',
      };
  const lastProbe: CheckResult = {
    label: 'codex.last_probe_at',
    status: 'info',
    detail: state.last_probe_at,
  };
  return [responsive, lastProbe];
}

function formatSymbol(status: CheckResult['status']): string {
  if (status === 'pass') return '[ok]  ';
  if (status === 'warn') return '[warn]';
  if (status === 'info') return '[info]';
  return '[fail]';
}

/**
 * Return whether Codex adversarial review is required. Read from the parsed
 * policy; default is `true` when the field is absent. Isolated so tests can
 * stub a policy without having to touch disk.
 */
function codexRequiredFromPolicy(baseDir: string): boolean {
  try {
    const policy = loadPolicy(baseDir);
    return policy.review?.codex_required !== false;
  } catch {
    // If the policy itself is unreadable, checkPolicyParses will already
    // report a fail. Default to "Codex required" so we still run those
    // checks and surface the full picture.
    return true;
  }
}

/**
 * Assemble the full checklist for a given baseDir. Exported so tests can
 * exercise the conditional branching without capturing stdout from
 * `runDoctor`.
 *
 * `codexProbeState` is consulted ONLY when Codex is required by policy.
 * Callers that already have a fresh probe state (e.g. `runDoctor`) should
 * pass it; callers that don't (e.g. unit tests of the existing doctor
 * surface) can omit it and the probe-derived fields are skipped.
 */
export function collectChecks(
  baseDir: string,
  codexProbeState?: CodexProbeState,
): CheckResult[] {
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
  ];

  if (codexRequiredFromPolicy(baseDir)) {
    checks.push(checkCodexAgent(baseDir), checkCodexCommand(baseDir));
    if (codexProbeState !== undefined) {
      checks.push(...checksFromProbeState(codexProbeState));
    }
  } else {
    // Single informational line replaces the two Codex-specific checks.
    // The `codex-adversarial.md` agent is still expected to be present by
    // checkAgentsPresent — that's deliberate; the agent is cheap to ship
    // and flipping the flag should not require a re-install.
    checks.push({
      label: 'codex',
      status: 'info',
      detail:
        'disabled via policy.review.codex_required — skipping Codex-related checks',
    });
  }

  return checks;
}

export interface RunDoctorOptions {
  /** When true, print a 7-day telemetry summary after the checks (G11.5). */
  metrics?: boolean;
}

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<void> {
  const baseDir = process.cwd();

  // G11.3 — one-shot probe when Codex is required by policy. Doctor may be
  // invoked without a running gateway, so we don't share state with
  // `rea serve`; we just run a fresh probe here. Failure is observational —
  // a warn row, never a hard failure of `rea doctor`.
  let probeState: CodexProbeState | undefined;
  if (codexRequiredFromPolicy(baseDir)) {
    try {
      probeState = await new CodexProbe().probe();
    } catch {
      // `probe()` is documented as never-throws, but belt-and-suspenders:
      // missing probe data should never crash doctor.
      probeState = undefined;
    }
  }

  const checks = collectChecks(baseDir, probeState);

  console.log('');
  log(`Doctor — ${baseDir}`);
  console.log('');

  let hardFail = false;
  for (const c of checks) {
    const detail = c.detail !== undefined ? `  (${c.detail})` : '';
    console.log(`  ${formatSymbol(c.status)} ${c.label}${detail}`);
    if (c.status === 'fail') hardFail = true;
  }

  // G11.5 — optional telemetry summary. Prints AFTER the main checks and
  // NEVER contributes to the exit code. Purely observational.
  if (opts.metrics === true) {
    await printTelemetrySummary(baseDir);
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

/**
 * Render the telemetry summary after the doctor checks. Compact by
 * design — the exact shape may evolve as G5 formalizes metrics export.
 */
async function printTelemetrySummary(baseDir: string): Promise<void> {
  const summary = await summarizeTelemetry(baseDir);
  console.log('');
  log(`Telemetry — last ${summary.window_days} days`);
  console.log(
    `  invocations/day:        ${summary.invocations_per_day.join(', ')}`,
  );
  console.log(`  total estimated tokens: ${summary.total_estimated_tokens}`);
  console.log(`  rate-limited responses: ${summary.rate_limited_count}`);
  console.log(
    `  avg latency:            ${Math.round(summary.avg_latency_ms)} ms`,
  );
}
