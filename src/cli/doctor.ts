import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '../policy/loader.js';
import { loadRegistry } from '../registry/loader.js';
import {
  CodexProbe,
  type CodexProbeState,
} from '../gateway/observability/codex-probe.js';
import {
  inspectPrePushState,
  type PrePushDoctorState,
} from './install/pre-push.js';
import { summarizeTelemetry } from '../gateway/observability/codex-telemetry.js';
import {
  CLAUDE_MD_MANIFEST_PATH,
  SETTINGS_MANIFEST_PATH,
  enumerateCanonicalFiles,
} from './install/canonical.js';
import { buildFragment } from './install/claude-md.js';
import {
  canonicalSettingsSubsetHash,
  defaultDesiredHooks,
} from './install/settings-merge.js';
import { manifestExists, readManifest } from './install/manifest-io.js';
import { sha256OfBuffer, sha256OfFile } from './install/sha.js';
import { POLICY_FILE, REA_DIR, REGISTRY_FILE, getPkgVersion, log, reaPath } from './utils.js';

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

/**
 * G6 — Verify at least one pre-push hook is installed and executable AND
 * actually wires the protected-path review gate.
 *
 * Three install shapes are acceptable:
 *   1. `.git/hooks/pre-push` — vanilla git (no hooksPath). Must carry the
 *      rea fallback marker or delegate to `push-review-gate.sh`.
 *   2. `${core.hooksPath}/pre-push` — husky 9 or custom hooksPath. Same
 *      governance rule.
 *   3. `.husky/pre-push` is present on disk but only counts if husky has
 *      configured `core.hooksPath=.husky`. A `.husky/pre-push` with an
 *      unconfigured hooksPath is dead weight; we do NOT treat it as
 *      sufficient.
 *
 * Two possible outcomes:
 *   - `pass`: active hook exists, is executable, and governance-carrying
 *     (rea-managed marker or direct gate delegation).
 *   - `fail`: no active hook, active file is non-executable, OR the active
 *     hook does not reference `.claude/hooks/push-review-gate.sh`. The last
 *     case is the "silent bypass" state — a lint-only husky hook or a
 *     pre-existing repo hook that bypasses the Codex audit gate entirely.
 *     Always a hard fail; `rea init` can install the fallback if the user
 *     removes or updates the existing hook.
 *
 * "Executable" is defined by any user/group/other exec bit, matching
 * `checkHooksInstalled`.
 */
function checkPrePushHook(state: PrePushDoctorState): CheckResult {
  if (state.ok) {
    const active = state.candidates.find((c) => c.path === state.activePath);
    const kind =
      active?.reaManaged === true
        ? 'rea-managed'
        : active?.delegatesToGate === true
          ? 'external (delegates to push-review-gate.sh)'
          : 'external';
    const detail = active !== undefined ? `${kind} at ${active.path}` : undefined;
    return detail !== undefined
      ? { label: 'pre-push hook installed', status: 'pass', detail }
      : { label: 'pre-push hook installed', status: 'pass' };
  }

  if (state.activeForeign) {
    // Executable file exists at the active path but does not carry
    // governance — the parser could not confirm the review gate is
    // invoked unconditionally. Always a hard fail.
    //
    // R13 F3: previously, a substring match of the gate path in the hook
    // downgraded this to WARN. That was unsafe — any comment, echo, or
    // dead string mentioning the path would mask a silent-bypass hook.
    // The classifier now fails closed: either the structural parser
    // (`referencesReviewGate` in `pre-push.ts`) recognizes a real
    // invocation, or doctor reports fail.
    return {
      label: 'pre-push hook installed',
      status: 'fail',
      detail:
        `active pre-push at ${state.activePath} is present and executable but does NOT ` +
        `reference \`.claude/hooks/push-review-gate.sh\` — the protected-path ` +
        `Codex audit gate is silently bypassed. Either add ` +
        '`exec .claude/hooks/push-review-gate.sh "$@"` to the existing hook, or ' +
        'remove it and re-run `rea init` to install the fallback.',
    };
  }

  const present = state.candidates
    .filter((c) => c.exists)
    .map((c) => `${c.path}${c.executable ? '' : ' (not executable)'}`);
  if (present.length > 0) {
    return {
      label: 'pre-push hook installed',
      status: 'fail',
      detail:
        `no active pre-push hook. Files on disk: ${present.join(', ')}. ` +
        'Run `rea init` to install the fallback, or configure `core.hooksPath=.husky` ' +
        'if you are using husky.',
    };
  }
  return {
    label: 'pre-push hook installed',
    status: 'fail',
    detail:
      'no pre-push hook found in `.git/hooks/`, configured `core.hooksPath`, or `.husky/`. ' +
      'Run `rea init` to install the fallback.',
  };
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
 * `prePushState` is the pre-computed G6 pre-push inspection; when omitted
 * the pre-push check is skipped entirely (older call sites that don't yet
 * thread the state through keep working without behavioural change).
 * Callers that already have fresh state (e.g. `runDoctor`) should pass
 * both; callers that don't (e.g. unit tests of the existing doctor
 * surface) can omit them and those checks are skipped.
 *
 * `activeForeign` always yields `fail` — a foreign hook bypassing the gate is a hard governance gap.
 */
export function collectChecks(
  baseDir: string,
  codexProbeState?: CodexProbeState,
  prePushState?: PrePushDoctorState,
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
  if (prePushState !== undefined) {
    checks.push(checkPrePushHook(prePushState));
  }

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
  /**
   * G12 — when true, append a read-only drift report comparing on-disk SHAs
   * to the install manifest + canonical sources. Never mutates; never fails
   * the exit code on its own (drift is information, not a hard error — use
   * `rea upgrade` to reconcile).
   */
  drift?: boolean;
}

export interface DriftRow {
  path: string;
  status:
    | 'unmodified'
    | 'drifted-from-canonical'
    | 'drifted-from-manifest'
    | 'missing'
    | 'untracked'
    | 'removed-upstream';
  detail?: string;
}

export interface DriftReport {
  hasManifest: boolean;
  bootstrap: boolean;
  manifestVersion: string | null;
  reaVersion: string;
  rows: DriftRow[];
}

/**
 * Compute drift between the install manifest and the current state of the
 * consumer's tree. Strictly read-only — no file writes. Synthetic entries
 * (settings subset, managed CLAUDE.md fragment) are checked by hashing the
 * computed values against the manifest SHA.
 */
export async function collectDriftReport(baseDir: string): Promise<DriftReport> {
  const reaVersion = getPkgVersion();
  const rows: DriftRow[] = [];

  if (!manifestExists(baseDir)) {
    return {
      hasManifest: false,
      bootstrap: false,
      manifestVersion: null,
      reaVersion,
      rows,
    };
  }

  const manifest = await readManifest(baseDir);
  if (manifest === null) {
    return {
      hasManifest: false,
      bootstrap: false,
      manifestVersion: null,
      reaVersion,
      rows,
    };
  }

  const manifestByPath = new Map(manifest.files.map((e) => [e.path, e]));
  const canonical = await enumerateCanonicalFiles();
  const canonicalByPath = new Map(canonical.map((c) => [c.destRelPath, c]));

  // Canonical files: compare on-disk against canonical + manifest.
  for (const c of canonical) {
    const abs = path.join(baseDir, c.destRelPath);
    if (!fs.existsSync(abs)) {
      rows.push({
        path: c.destRelPath,
        status: 'missing',
        detail: 'file not installed',
      });
      continue;
    }
    const localSha = await sha256OfFile(abs);
    const canonicalSha = await sha256OfFile(c.sourceAbsPath);
    const entry = manifestByPath.get(c.destRelPath);
    if (localSha === canonicalSha) {
      rows.push({ path: c.destRelPath, status: 'unmodified' });
      continue;
    }
    if (entry !== undefined && localSha === entry.sha256) {
      rows.push({
        path: c.destRelPath,
        status: 'drifted-from-canonical',
        detail: `local matches manifest but differs from rea v${reaVersion} canonical — run \`rea upgrade\``,
      });
      continue;
    }
    rows.push({
      path: c.destRelPath,
      status: 'drifted-from-manifest',
      detail: 'file modified locally since install',
    });
  }

  // Manifest entries no longer in canonical (removed upstream), excluding
  // synthetic entries handled below.
  for (const entry of manifest.files) {
    if (
      entry.path === CLAUDE_MD_MANIFEST_PATH ||
      entry.path === SETTINGS_MANIFEST_PATH
    )
      continue;
    if (!canonicalByPath.has(entry.path)) {
      rows.push({
        path: entry.path,
        status: 'removed-upstream',
        detail: 'no longer shipped — run `rea upgrade` to remove',
      });
    }
  }

  // Synthetic: rea-owned settings subset.
  const settingsEntry = manifestByPath.get(SETTINGS_MANIFEST_PATH);
  const settingsSha = canonicalSettingsSubsetHash(defaultDesiredHooks());
  if (settingsEntry === undefined) {
    rows.push({ path: SETTINGS_MANIFEST_PATH, status: 'untracked' });
  } else if (settingsEntry.sha256 !== settingsSha) {
    rows.push({
      path: SETTINGS_MANIFEST_PATH,
      status: 'drifted-from-canonical',
      detail: 'desired-hooks set has changed since install',
    });
  } else {
    rows.push({ path: SETTINGS_MANIFEST_PATH, status: 'unmodified' });
  }

  // Synthetic: managed CLAUDE.md fragment. Render the fragment from the
  // current policy and compare. If policy is unreadable, skip gracefully.
  const mdEntry = manifestByPath.get(CLAUDE_MD_MANIFEST_PATH);
  try {
    const policy = loadPolicy(baseDir);
    const fragment = buildFragment({
      policyPath: '.rea/policy.yaml',
      profile: policy.profile,
      autonomyLevel: policy.autonomy_level,
      maxAutonomyLevel: policy.max_autonomy_level,
      blockedPathsCount: policy.blocked_paths.length,
      blockAiAttribution: policy.block_ai_attribution,
    });
    const currentSha = sha256OfBuffer(fragment);
    if (mdEntry === undefined) {
      rows.push({ path: CLAUDE_MD_MANIFEST_PATH, status: 'untracked' });
    } else if (mdEntry.sha256 !== currentSha) {
      rows.push({
        path: CLAUDE_MD_MANIFEST_PATH,
        status: 'drifted-from-canonical',
        detail: 'policy values or fragment template changed since install',
      });
    } else {
      rows.push({ path: CLAUDE_MD_MANIFEST_PATH, status: 'unmodified' });
    }
  } catch {
    // Policy unreadable — drift of the fragment is meaningless to compute.
    // The main doctor checks will already surface the policy failure.
  }

  return {
    hasManifest: true,
    bootstrap: manifest.bootstrap === true,
    manifestVersion: manifest.version,
    reaVersion,
    rows,
  };
}

function printDriftReport(report: DriftReport): void {
  console.log('');
  log('Drift report');
  if (!report.hasManifest) {
    console.log(
      '  no .rea/install-manifest.json — run `rea upgrade` once to bootstrap a manifest.',
    );
    console.log('');
    return;
  }
  console.log(
    `  manifest v${report.manifestVersion ?? '?'} — running rea v${report.reaVersion}${report.bootstrap ? ' (bootstrap)' : ''}`,
  );
  console.log('');
  let clean = 0;
  for (const row of report.rows) {
    if (row.status === 'unmodified') {
      clean += 1;
      continue;
    }
    const detail = row.detail !== undefined ? `  — ${row.detail}` : '';
    console.log(`  [${row.status}] ${row.path}${detail}`);
  }
  console.log('');
  console.log(
    `  ${clean} clean, ${report.rows.length - clean} with drift/issues.`,
  );
  console.log('');
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

  // G6 — inspect pre-push state. Never throws; unreadable files downgrade
  // individual candidates but never break the whole check.
  let prePushState: PrePushDoctorState | undefined;
  try {
    prePushState = await inspectPrePushState(baseDir);
  } catch {
    prePushState = undefined;
  }

  const checks = collectChecks(baseDir, probeState, prePushState);

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

  // G12 — optional drift report. Also purely observational; `rea upgrade`
  // is the action path.
  if (opts.drift === true) {
    const report = await collectDriftReport(baseDir);
    printDriftReport(report);
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
