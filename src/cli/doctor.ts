import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { loadPolicy } from '../policy/loader.js';
import { loadRegistry } from '../registry/loader.js';
import { loadFingerprintStore } from '../registry/fingerprints-store.js';
import { fingerprintServer } from '../registry/fingerprint.js';
import { CodexProbe, type CodexProbeState } from '../gateway/observability/codex-probe.js';
import {
  inspectPrePushState,
  isHusky9Stub,
  resolveHusky9StubTarget,
  type PrePushDoctorState,
} from './install/pre-push.js';
import { summarizeTelemetry } from '../gateway/observability/codex-telemetry.js';
import {
  CLAUDE_MD_MANIFEST_PATH,
  SETTINGS_MANIFEST_PATH,
  enumerateCanonicalFiles,
} from './install/canonical.js';
import { buildFragment } from './install/claude-md.js';
import { canonicalSettingsSubsetHash, defaultDesiredHooks } from './install/settings-merge.js';
import { manifestExists, readManifest } from './install/manifest-io.js';
import { sha256OfBuffer, sha256OfFile } from './install/sha.js';
import { DELEGATION_SIGNAL_TOOL_NAME } from '../audit/delegation-event.js';
import { computeHash } from '../audit/fs.js';
import {
  PREPARE_COMMIT_MSG_BODY_MARKER,
  PREPARE_COMMIT_MSG_MARKER,
} from './install/prepare-commit-msg.js';
import { validateSettings } from '../config/settings-schema.js';
import { checkSelfPinDeclaredSync, REA_PACKAGE_NAME, stripUtf8Bom } from './install/self-pin.js';
import {
  checkGlobalCandidateSafety,
  checkReaDirSafety,
  checkRegistrySafety,
  globalRoot,
  isProjectTrusted,
  passwdHome,
  probeGlobalCliCapability,
  reaDir as globalReaDir,
  registryPath as globalRegistryPath,
  resolveGlobalCli,
  type GlobalCandidateFail,
  type SafetyFail,
} from './global-cli.js';
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

/**
 * G7: report the TOFU fingerprint-store state. Pass = every enabled server
 * in the registry has a matching stored fingerprint. Warn = at least one
 * server would be first-seen or drifted at next `rea serve`. Info = no
 * enabled servers (nothing to fingerprint). Fail only for unreadable store.
 *
 * Exported so tests can drive this without spinning up the full `runDoctor`.
 */
export async function checkFingerprintStore(baseDir: string): Promise<CheckResult> {
  const label = 'fingerprint store';
  let registry;
  try {
    registry = loadRegistry(baseDir);
  } catch {
    return {
      label,
      status: 'info',
      detail: 'registry missing — no fingerprints to compare',
    };
  }
  const enabled = registry.servers.filter((s) => s.enabled);
  if (enabled.length === 0) {
    return { label, status: 'info', detail: 'no enabled servers to fingerprint' };
  }
  let store;
  try {
    store = await loadFingerprintStore(baseDir);
  } catch (e) {
    return {
      label,
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  let firstSeen = 0;
  let drifted = 0;
  for (const s of enabled) {
    const stored = store.servers[s.name];
    if (stored === undefined) firstSeen += 1;
    else if (stored !== fingerprintServer(s)) drifted += 1;
  }
  if (firstSeen === 0 && drifted === 0) {
    return {
      label,
      status: 'pass',
      detail: `${enabled.length} server(s) trusted`,
    };
  }
  const parts: string[] = [];
  if (firstSeen > 0) parts.push(`${firstSeen} first-seen`);
  if (drifted > 0) parts.push(`${drifted} drifted`);
  return {
    label,
    status: 'warn',
    detail: `${parts.join(', ')} — next \`rea serve\` will block drift (run \`rea tofu list\` for detail, \`rea tofu accept <name>\` to rebase after a legitimate registry edit)`,
  };
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

/**
 * 0.30.0 (Class M settings.json schema) — `EXPECTED_HOOKS` is exported
 * so the schema validator at `src/config/settings-schema.ts` can
 * cross-check rea-shipped hook filenames against entries it sees in
 * a consumer's `.claude/settings.json`. The validator's `--strict`
 * mode FAILS when a known rea-managed hook is missing from the
 * consumer's registration; default mode logs a warn.
 */
export const EXPECTED_AGENTS = [
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

export const EXPECTED_HOOKS = [
  'architecture-review-gate.sh',
  'attribution-advisory.sh',
  // 0.51.0 — spend-governance E1 seed (INCIDENT-2026-07-04,
  // denial-of-wallet). PostToolUse Bash billing→HALT reflex. Added to
  // EXPECTED_HOOKS at ship time (not staged like delegation-advisory
  // was) because the hook is security-load-bearing AND ships enabled in
  // every profile — a consumer who upgrades must lay it down, and doctor
  // should surface its absence rather than silently tolerate a missing
  // spend wall. Consumers on pre-0.51.0 installs get a doctor `fail`
  // until they run `rea upgrade`, which is the correct signal for a
  // control this class.
  'billing-cap-halt.sh',
  // 0.22.0 — Bash-tier parity with `blocked-paths-enforcer.sh`.
  // Round-27 F8 fix: was silently missing from EXPECTED_HOOKS, so
  // doctor returned pass on consumer installs that lacked this
  // security-load-bearing hook (any consumer who upgraded from
  // 0.21.x → 0.22.x without `rea upgrade` was undetected).
  'blocked-paths-bash-gate.sh',
  'blocked-paths-enforcer.sh',
  'changeset-security-gate.sh',
  'dangerous-bash-interceptor.sh',
  // 0.36.0 — `delegation-advisory.sh` PROMOTED to EXPECTED_HOOKS (charter
  // follow-through from 0.31.0). Originally held out in 0.31.0 to give
  // consumers an upgrade-lag window: adding a brand-new hook to
  // EXPECTED_HOOKS would have hard-`fail`ed `checkHooksInstalled` on
  // every pre-0.31.0 install the instant they bumped the rea binary, a
  // regression that turns a green doctor red purely from upgrade lag.
  // After 4 releases of propagation (0.32, 0.33, 0.34, 0.35), the lag
  // window has closed — consumers running `rea upgrade` since 0.31.0
  // have laid the hook down. Same ratchet `delegation-capture.sh` went
  // through 0.29.0 → 0.30.0. Promotion happens in lockstep with
  // `checkDelegationAdvisoryHookRegistered` flipping `warn` → `fail`
  // (see that function for the matching commentary).
  'delegation-advisory.sh',
  // 0.29.0 — delegation-telemetry MVP. The PreToolUse hook on
  // matcher `Agent|Skill` emits a `rea.delegation_signal` audit record
  // on every subagent / skill dispatch. Observational only — fails
  // open so missing rea binary doesn't crash dispatch. Doctor surfaces
  // a missing hook file so consumers don't silently lose the signal
  // after upgrade.
  'delegation-capture.sh',
  'dependency-audit-gate.sh',
  'env-file-protection.sh',
  // 0.26.0 local-first enforcement (CTO directive 2026-05-05).
  // Round-25 P3 fix: doctor's EXPECTED_HOOKS list missed this entry.
  // Without it, `rea doctor` returned pass on consumer installs that
  // didn't actually have the new gate present after upgrade — silently
  // disabling the local-first guardrail.
  'local-review-gate.sh',
  'pr-issue-link-gate.sh',
  // 0.21.0 — Bash-tier parity with `settings-protection.sh`.
  // Round-27 F8 fix: same class as blocked-paths-bash-gate.sh — silently
  // missing since 0.21.0, doctor would pass even when the hook was
  // absent from a consumer install.
  'protected-paths-bash-gate.sh',
  'secret-scanner.sh',
  'security-disclosure-gate.sh',
  'settings-protection.sh',
];

function checkAgentsPresent(baseDir: string): CheckResult {
  const agentsDir = path.join(baseDir, '.claude', 'agents');
  if (!fs.existsSync(agentsDir)) {
    return { label: 'curated agents installed', status: 'fail', detail: `missing: ${agentsDir}` };
  }
  const missing = EXPECTED_AGENTS.filter((name) => !fs.existsSync(path.join(agentsDir, name)));
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
    return {
      label: 'hooks installed + executable',
      status: 'fail',
      detail: `missing: ${hooksDir}`,
    };
  }
  const issues: string[] = [];
  for (const name of EXPECTED_HOOKS) {
    const p = path.join(hooksDir, name);
    if (!fs.existsSync(p)) {
      issues.push(`missing ${name}`);
      continue;
    }
    const stat = fs.statSync(p);
    if ((stat.mode & 0o111) === 0)
      issues.push(`${name} not executable (mode=${(stat.mode & 0o777).toString(8)})`);
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

/**
 * 0.49.0 — fail when `.claude/hooks/` is present but no `@bookedsolid/rea`
 * pin is declared in the consumer's `package.json`. This is the "brick
 * state" detector — a fresh clone of a consumer repo whose hook shims
 * exist but whose dependency declaration is missing is exactly the
 * scenario the bash-gate bootstrap allowlist (paired Fix B) recovers
 * from. Doctor surfaces it loudly so the operator runs `rea upgrade`
 * (which re-runs the self-pin step) before assuming the shims have
 * drifted.
 *
 * Statuses:
 *   - `pass`  — hooks installed AND pin declared (in dependencies or
 *               devDependencies).
 *   - `pass`  — no `.claude/hooks/` directory (check is N/A; the
 *               brick scenario does not exist).
 *   - `pass`  — `pkg.name === '@bookedsolid/rea'` (dogfood — never
 *               self-pins).
 *   - `warn`  — hooks installed but NO `package.json` upward. The
 *               bootstrap allowlist requires a pkg.json precondition,
 *               so without one the gates cannot self-recover anyway.
 *               We warn rather than fail to avoid spamming non-Node
 *               consumers who landed `.claude/hooks/` through a
 *               separate vendoring flow.
 *   - `fail`  — hooks installed, package.json found, no rea pin.
 *               This is the brick state.
 *   - `fail`  — package.json exists but is malformed/non-object.
 */
/**
 * R18-P1 (codex round 18) / R19-P2 (codex round 19): resolve the
 * `@bookedsolid/rea` version that the consumer's HOOK SCRIPTS will
 * actually invoke at runtime.
 *
 * Two layouts the shim chain accepts (mirrors `resolveCliDistPath`
 * above):
 *
 *   1. `<baseDir>/node_modules/@bookedsolid/rea/package.json` — the
 *      consumer install (`pnpm i @bookedsolid/rea`). The version is
 *      that file's `version` field.
 *
 *   2. `<baseDir>/dist/cli/index.js` present AND `<baseDir>/package.json`
 *      has `name === '@bookedsolid/rea'` — the rea-repo dogfood
 *      after `pnpm build`. The dist is a build output of the same
 *      package.json that declares the rea CLI, so its `version`
 *      field is the CLI version the dogfood hooks will resolve.
 *
 * Pre-R18 doctor passed `getPkgVersion()` (the version of whatever
 * `rea` binary launched `rea doctor`) into the pin-compat check.
 * That caused false failures whenever an operator ran a newer
 * GLOBAL CLI (e.g. `rea@0.50.0`) against a repo whose `package.json`
 * intentionally pinned an older but compatible version. The repo's
 * hooks resolve the LOCAL CLI; the global binary is irrelevant.
 *
 * R19-P2 narrows the fix: when neither layout resolves, return
 * `null` — and the caller SKIPS the compat check entirely (no
 * fallback to `getPkgVersion()`). Fresh clones (pre-`pnpm install`)
 * and broken dist builds fall into this branch and now pass instead
 * of false-failing.
 *
 * Returns `null` on any read/parse error or when no recognized
 * layout matches. Best-effort, single read per call. Never throws.
 */
function resolveLocalCliVersion(baseDir: string): string | null {
  // Layout 1: consumer install via node_modules.
  const nmPkgPath = path.join(
    baseDir,
    'node_modules',
    '@bookedsolid',
    'rea',
    'package.json',
  );
  const nmVersion = readPackageVersion(nmPkgPath);
  if (nmVersion !== null) return nmVersion;

  // Layout 2: rea-repo dogfood. The CLI is `<baseDir>/dist/cli/
  // index.js`; the source of truth for its version is the SAME
  // `<baseDir>/package.json` that declares it. Guard with name-
  // match so we never mis-identify a consumer's package.json
  // (which lacks the dist build) as a rea install.
  const distCliPath = path.join(baseDir, 'dist', 'cli', 'index.js');
  if (!fs.existsSync(distCliPath)) return null;
  const dogfoodPkgPath = path.join(baseDir, 'package.json');
  let raw: string;
  try {
    raw = fs.readFileSync(dogfoodPkgPath, 'utf8');
  } catch {
    return null;
  }
  raw = stripUtf8Bom(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const pkg = parsed as Record<string, unknown>;
  if (pkg['name'] !== REA_PACKAGE_NAME) return null;
  const version = pkg['version'];
  return typeof version === 'string' && version.length > 0 ? version : null;
}

/**
 * Helper for `resolveLocalCliVersion` — read a package.json's
 * `version` field with the same BOM tolerance + defensive parse
 * posture as the rest of the self-pin surface. Returns `null` on
 * any failure.
 */
function readPackageVersion(pkgPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } catch {
    return null;
  }
  raw = stripUtf8Bom(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const version = (parsed as Record<string, unknown>)['version'];
  return typeof version === 'string' && version.length > 0 ? version : null;
}

export function checkSelfPinDeclaredCheck(baseDir: string): CheckResult {
  const label = `${REA_PACKAGE_NAME} declared in package.json`;
  try {
    // R11-P3 (codex round 11): pass the running CLI version so the
    // check verifies the declared range admits it (not just that
    // it's declared). Pre-R11 the check was presence-only — a stale
    // pin like `"0.48.0"` reported pass even though the running
    // CLI was 0.49.x. Doctor's job is to catch skew BEFORE it
    // bricks the consumer.
    //
    // R18-P1 (codex round 18): prefer the LOCAL CLI's version
    // (`<baseDir>/node_modules/@bookedsolid/rea`) over the global
    // invoker's. The consumer's HOOKS resolve the local install at
    // runtime, so that's the version the pin must admit.
    //
    // R19-P2 (codex round 19): when the local CLI is absent (no
    // node_modules layout AND no dogfood dist build), SKIP the
    // compat check entirely. Falling back to the invoker version
    // (the R18-P1 implementation) still produced false-fails on
    // fresh clones — an operator's newer global `rea@0.50.0`
    // running doctor against a repo pinned `^0.49.0` before
    // `pnpm install` saw fail-incompatible despite no real
    // problem. With local CLI absent we cannot determine what
    // version the hooks will run, so we report pass and let
    // pnpm's own resolution-time errors surface any actual pin
    // skew during install. The existing `fail-no-pin` /
    // `fail-malformed` arms continue to catch the brick states.
    const resolvedCliVersion = resolveLocalCliVersion(baseDir);
    const result = checkSelfPinDeclaredSync(
      baseDir,
      resolvedCliVersion ?? undefined,
    );
    switch (result.kind) {
      case 'pass':
        return {
          label,
          status: 'pass',
          detail: `declared in ${result.declaredIn} as ${result.declaredRange}`,
        };
      case 'pass-no-hooks':
        return {
          label,
          status: 'pass',
          detail: 'no .claude/hooks/ — check is N/A',
        };
      case 'pass-dogfood':
        return {
          label,
          status: 'pass',
          detail: 'dogfood install (pkg.name === @bookedsolid/rea)',
        };
      case 'pass-no-pkg':
        return {
          label,
          status: 'warn',
          detail:
            'hook shims installed but no package.json found upward — bash gates will refuse on fresh clones (the bootstrap allowlist requires a package.json precondition)',
        };
      case 'fail':
        return {
          label,
          status: 'fail',
          detail:
            `hook shims at ${path.relative(baseDir, result.hooksDir)} but ${REA_PACKAGE_NAME} is not declared in ${path.relative(baseDir, result.packageJsonPath)}. ` +
            `Fresh clones will brick (bash gates refuse without a CLI). Run \`rea upgrade\` to self-heal.`,
        };
      case 'fail-malformed':
        return {
          label,
          status: 'fail',
          detail: `${path.relative(baseDir, result.packageJsonPath)} is missing or not a valid JSON object`,
        };
      // R10-P2 (codex round 10): symlinked package.json. Surface
      // the write-path's refusal verbatim so the operator sees the
      // same diagnostic at doctor time as they would at upgrade
      // time (avoiding drift between the two surfaces).
      case 'fail-symlink':
        return {
          label,
          status: 'fail',
          detail: result.reason,
        };
      // R11-P3 (codex round 11): declared range doesn't admit the
      // running CLI. Surface the helper's full reason — it includes
      // the recovery command and the explainer.
      case 'fail-incompatible':
        return {
          label,
          status: 'fail',
          detail: result.reason,
        };
      // R11-P3: declared as workspace:* / file:.. / git URL / dist-
      // tag. Can't statically determine whether the resolved version
      // admits the running CLI; surface as fail so the operator
      // audits the resolution path.
      case 'fail-non-semver':
        return {
          label,
          status: 'fail',
          detail: result.reason,
        };
    }
  } catch (e) {
    return {
      label,
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 0.30.0 Class M — validate `.claude/settings.json` against the zod
 * schema in `src/config/settings-schema.ts`.
 *
 * Status posture:
 *
 *   - `strict: false` (default `rea doctor`) — emit a warn when:
 *       - zod parse fails (unknown top-level key, missing matcher,
 *         malformed hook entry, etc.),
 *       - any `command` contains a `..` traversal after stripping
 *         `$CLAUDE_PROJECT_DIR`,
 *       - any rea-shipped hook from `EXPECTED_HOOKS` is missing from
 *         the consumer's registrations.
 *     The harness keeps working — the schema only refuses to call
 *     malformed hook entries; we surface the issue without breaking
 *     the install.
 *
 *   - `strict: true` (`rea doctor --strict`) — fail (hard) on the
 *     same conditions. Used by CI gates that want a hard floor on
 *     consumer settings.
 *
 * Returns `pass` when everything cleared. Returns one `CheckResult`
 * per concern; called once and emits one result. Combined with the
 * existing `checkSettingsJson` (which checks for the historical Bash
 * + Write|Edit|MultiEdit|NotebookEdit matchers), gives consumers a
 * complete picture.
 */
export function checkSettingsSchema(baseDir: string, strict: boolean): CheckResult {
  const label = strict ? 'settings.json schema (strict)' : 'settings.json schema (advisory)';
  const settingsPath = path.join(baseDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return {
      label,
      status: strict ? 'fail' : 'warn',
      detail: `missing: ${settingsPath}`,
    };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    return {
      label,
      status: strict ? 'fail' : 'warn',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      label,
      status: 'fail',
      detail: `malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const result = validateSettings(parsed, { strict });
  const issues: string[] = [];
  if (!result.parsed) {
    issues.push(...result.errors.map((e) => `schema: ${e}`));
  }
  for (const t of result.traversalFindings) {
    issues.push(`traversal: ${t.event}[${t.matcher}].hooks[${t.index}].command — ${t.reason}`);
  }
  for (const missing of result.missingReaHooks) {
    issues.push(`missing rea hook: ${missing} not registered in PreToolUse/PostToolUse`);
  }
  if (issues.length === 0) {
    return { label, status: 'pass' };
  }
  return {
    label,
    status: strict ? 'fail' : 'warn',
    detail: issues.join('; '),
  };
}

function checkSettingsJson(baseDir: string): CheckResult {
  const settingsPath = path.join(baseDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return {
      label: 'settings.json matchers cover Bash + Write|Edit|MultiEdit|NotebookEdit',
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
    const matchers = new Set(
      pre.map((g) => g.matcher).filter((m): m is string => typeof m === 'string'),
    );
    const needs: string[] = [];
    if (!matchers.has('Bash')) needs.push('Bash');
    // 0.16.0: matcher widened to `Write|Edit|MultiEdit|NotebookEdit`. Doctor
    // accepts any of the three historical shapes so pre-0.14.0 / pre-0.16.0
    // installs that haven't run `rea upgrade` still report accurately. The
    // canonical from `defaultDesiredHooks()` is the widest matcher.
    if (
      !matchers.has('Write|Edit|MultiEdit|NotebookEdit') &&
      !matchers.has('Write|Edit|MultiEdit') &&
      !matchers.has('Write|Edit')
    ) {
      needs.push('Write|Edit|MultiEdit|NotebookEdit');
    }
    if (needs.length === 0) {
      return {
        label: 'settings.json matchers cover Bash + Write|Edit|MultiEdit|NotebookEdit',
        status: 'pass',
      };
    }
    return {
      label: 'settings.json matchers cover Bash + Write|Edit|MultiEdit|NotebookEdit',
      status: 'fail',
      detail: `missing PreToolUse matchers: ${needs.join(', ')}`,
    };
  } catch (e) {
    return {
      label: 'settings.json matchers cover Bash + Write|Edit|MultiEdit|NotebookEdit',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Detect whether `baseDir` is a git repository. Returns true for the three
 * shapes git itself accepts:
 *
 *   1. `.git/` is a directory (vanilla repo).
 *   2. `.git` is a file with `gitdir: <path>` (linked worktree, submodule).
 *      The target gitdir is resolved and must exist on disk — a stale or
 *      orphaned gitlink (submodule whose parent moved, worktree whose main
 *      repo was deleted) is NOT a git repo and must return false, otherwise
 *      doctor short-circuits the non-git escape hatch and hard-fails on the
 *      pre-push check against a `.git/hooks/` that doesn't exist (F1 from
 *      Codex review of 0.5.1).
 *   3. Anything else (including a plain file a user accidentally named
 *      `.git`, or a symlink to nowhere) → false.
 *
 * Filesystem-shape predicate only. Deliberately does not consult `GIT_DIR`
 * or shell out to `git rev-parse` — `rea doctor` already checks things
 * inside `baseDir/.git/hooks/`, so the shape-on-disk is the right question
 * for the escape hatch. A GIT_DIR-aware secondary signal is a follow-up.
 *
 * Security note (F3): removing `.git/` does NOT bypass governance. The
 * governance artifact is the pre-push hook; a directory with no `.git/`
 * has no commits to push and no pre-push event to bypass. The escape
 * hatch is a UX predicate for knowledge repos and non-source directories,
 * NOT a trust boundary. Do not key security decisions on the return value.
 */
export function isGitRepo(baseDir: string): boolean {
  const dotGit = path.join(baseDir, '.git');
  let stat: fs.Stats;
  try {
    // statSync follows symlinks, so a `.git` symlink to a real gitdir is
    // treated like the real thing; a dangling symlink throws ENOENT and
    // falls into the catch → false.
    stat = fs.statSync(dotGit);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return true;
  if (!stat.isFile()) return false;
  // Gitlink file: `gitdir: <absolute-or-relative-path>`. Read and verify
  // the target resolves. If the target is missing, git itself would fail
  // in this directory, so we treat it as non-git.
  let content: string;
  try {
    content = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return false;
  }
  // `\s*$` on the old shape was inert (greedy `.+` consumed trailing spaces
  // and `\s ⊂ .`) — the `.trim()` below did all the work. Tighten to
  // `(\S.*?)` with an explicit trailing-space class so the captured group
  // starts at the first non-whitespace char and stops before trailing
  // whitespace. Still handles CRLF, leading tabs, and path-internal spaces.
  const match = /^gitdir:\s*(\S.*?)[ \t]*\r?$/m.exec(content);
  const rawTarget = match?.[1];
  if (rawTarget === undefined) return false;
  const targetPath = rawTarget;
  if (targetPath.length === 0) return false;
  const resolved = path.isAbsolute(targetPath) ? targetPath : path.join(baseDir, targetPath);
  return fs.existsSync(resolved);
}

/**
 * 0.30.0 attribution augmenter — verify the husky `prepare-commit-msg`
 * hook state matches what `policy.attribution.co_author.enabled` asks
 * for. Four buckets:
 *
 *   1. `enabled: true` + hook present + rea-managed marker → pass.
 *   2. `enabled: true` + hook missing OR marker mismatched → fail.
 *      Defense in depth: the loader's cross-field refinement should
 *      already have rejected `enabled: true` without identity, but
 *      we surface a missing hook file separately.
 *   3. `enabled: true` + name OR email empty → fail. The loader should
 *      have already caught this; surfacing here ensures `rea doctor`
 *      reports a clean state for the entire augmenter surface.
 *   4. `enabled: false` (or absent) + hook present (rea-managed) → pass
 *      (no-op — hook ships under every install).
 *   5. `enabled: false` (or absent) + foreign file → warn. The operator
 *      has a `prepare-commit-msg` outside rea's marker; their commits
 *      get whatever it does, which is fine.
 *   6. `enabled: false` + hook absent → pass (vanilla state).
 *
 * Returns `info` when the rea-shipped `.git/hooks/prepare-commit-msg`
 * lives under a hooksPath we couldn't resolve (treat as same as case
 * 6 from doctor's perspective).
 */
/**
 * Resolve the active git hooks directory for the doctor's prepare-commit-msg
 * check. Mirrors `installPrepareCommitMsgHook`'s resolution order
 * (synchronous — doctor is sync end-to-end):
 *
 *   1. `core.hooksPath` — explicit operator override (husky 9 installs
 *      land at `.husky/_/`). Honored verbatim.
 *   2. `git rev-parse --git-path hooks` — resolves the canonical hooks
 *      dir even when `.git` is a FILE (linked worktrees, submodules).
 *      0.30.1 round-5 P2: the prior implementation hardcoded
 *      `.git/hooks`, which is wrong for worktrees/submodules where
 *      `.git` is a gitdir pointer file, not a directory.
 *   3. `.git/hooks` — last-resort fallback when git itself is missing.
 *
 * The Husky 9 STUB indirection (active file at the resolved path is a
 * `. "${0%/*}/h"` stub that dispatches to `.husky/prepare-commit-msg`)
 * is followed separately inside `checkPrepareCommitMsgHook` via
 * `isHusky9Stub` / `resolveHusky9StubTarget`.
 */
function resolveHooksDirSync(baseDir: string): string {
  try {
    const out = execFileSync('git', ['-C', baseDir, 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    if (trimmed.length > 0) {
      return path.isAbsolute(trimmed) ? trimmed : path.join(baseDir, trimmed);
    }
  } catch {
    // git missing or `core.hooksPath` unset — fall through.
  }
  try {
    const out = execFileSync('git', ['-C', baseDir, 'rev-parse', '--git-path', 'hooks'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    if (trimmed.length > 0) {
      return path.isAbsolute(trimmed) ? trimmed : path.join(baseDir, trimmed);
    }
  } catch {
    // git missing — fall through to the literal default.
  }
  return path.join(baseDir, '.git', 'hooks');
}

export function checkPrepareCommitMsgHook(baseDir: string): CheckResult {
  const label = 'prepare-commit-msg hook (attribution augmenter)';
  const hooksDir = resolveHooksDirSync(baseDir);
  const hookPath = path.join(hooksDir, 'prepare-commit-msg');
  let policyAttr:
    | { enabled?: boolean; name?: string; email?: string; skip_merge?: boolean }
    | undefined;
  try {
    const policy = loadPolicy(baseDir);
    policyAttr = policy.attribution?.co_author;
  } catch {
    // policy-parse failure is surfaced elsewhere; default to "absent"
    policyAttr = undefined;
  }

  const enabled = policyAttr?.enabled === true;
  const hookExists = fs.existsSync(hookPath);
  let hookIsReaManaged = false;
  let hookMarkerMismatch = false;
  if (hookExists) {
    try {
      let content = fs.readFileSync(hookPath, 'utf8');
      // Codex round 3 P2: Husky 9 (`core.hooksPath=.husky/_`) auto-
      // generates a stub like `. "${0%/*}/h"` at the active hooks path.
      // Git dispatches through that stub to `.husky/prepare-commit-msg`
      // (the canonical body, which IS rea-managed). Follow the
      // indirection so doctor classifies the canonical body, not the
      // stub. Same pattern as installer + pre-push doctor checks.
      if (isHusky9Stub(content)) {
        const target = resolveHusky9StubTarget(hookPath);
        if (target !== null && target !== hookPath && fs.existsSync(target)) {
          try {
            content = fs.readFileSync(target, 'utf8');
          } catch {
            // canonical body unreadable — fall through with stub content,
            // which will classify as foreign and surface a clear error.
          }
        }
      }
      const lines = content.split('\n');
      hookIsReaManaged =
        content.startsWith('#!/bin/sh\n') &&
        lines[1] === PREPARE_COMMIT_MSG_MARKER &&
        lines[2] === PREPARE_COMMIT_MSG_BODY_MARKER;
      if (
        !hookIsReaManaged &&
        content.includes('rea:prepare-commit-msg') &&
        lines[1] !== PREPARE_COMMIT_MSG_MARKER
      ) {
        hookMarkerMismatch = true;
      }
    } catch {
      hookIsReaManaged = false;
    }
  }

  if (enabled) {
    if (!hookExists) {
      return {
        label,
        status: 'fail',
        detail:
          'attribution.co_author.enabled: true but .git/hooks/prepare-commit-msg is missing — ' +
          'run `rea init` to install the hook, or set enabled: false.',
      };
    }
    if (!hookIsReaManaged) {
      const reason = hookMarkerMismatch
        ? 'marker mismatch (older rea or hand-edited)'
        : 'no rea marker';
      return {
        label,
        status: 'fail',
        detail:
          `attribution.co_author.enabled: true but the prepare-commit-msg hook is foreign (${reason}) — ` +
          'remove the existing hook and re-run `rea init`, or set enabled: false.',
      };
    }
    const name = (policyAttr?.name ?? '').trim();
    const email = (policyAttr?.email ?? '').trim();
    if (name.length === 0 || email.length === 0) {
      const which = name.length === 0 ? 'name' : 'email';
      return {
        label,
        status: 'fail',
        detail:
          `attribution.co_author.enabled: true but ${which} is empty — ` +
          'the policy loader should have rejected this; if you are seeing this, edit ' +
          '.rea/policy.yaml and either set both name+email or set enabled: false.',
      };
    }
    return {
      label,
      status: 'pass',
      detail: `enabled — trailer: ${name} <${email}>`,
    };
  }

  // enabled: false (or absent).
  if (!hookExists) {
    return { label, status: 'pass', detail: 'disabled (no hook installed — vanilla state)' };
  }
  if (hookIsReaManaged) {
    return {
      label,
      status: 'pass',
      detail: 'disabled (rea-managed hook present, runs as no-op)',
    };
  }
  return {
    label,
    status: 'warn',
    detail:
      'foreign prepare-commit-msg hook present — rea would refuse to overwrite. ' +
      'When you enable attribution.co_author.enabled, the existing hook must be ' +
      'removed or migrated to a fragment first.',
  };
}

function checkCommitMsgHook(baseDir: string): CheckResult {
  // Resolve the ACTIVE hooks dir (core.hooksPath → rev-parse --git-path →
  // .git/hooks) exactly like the prepare-commit-msg and pre-push checks do.
  // Pre-fix this check hardcoded `.git/hooks/commit-msg`, so a repo wired
  // through `core.hooksPath=.husky` — where git actually runs
  // `.husky/commit-msg` and the attribution gate IS active — warned
  // "missing" on every doctor run (a permanent false negative).
  let hookPath = path.join(resolveHooksDirSync(baseDir), 'commit-msg');
  if (!fs.existsSync(hookPath)) {
    return {
      label: 'commit-msg hook installed',
      status: 'warn',
      detail: `missing: ${hookPath} (block_ai_attribution will not be enforced at commit time)`,
    };
  }
  try {
    // Git only RUNS the active hook file when it carries an exec bit; a
    // 0644 commit-msg is silently ignored on POSIX, which would disable
    // block_ai_attribution while doctor reports green. Validate the exec
    // bit on the ACTIVE file (the one git dispatches — for husky 9 that is
    // the stub, not the canonical body it sources), same as the
    // hooks-installed and pre-push checks.
    const activeStat = fs.statSync(hookPath);
    if ((activeStat.mode & 0o111) === 0) {
      return {
        label: 'commit-msg hook installed',
        status: 'fail',
        detail:
          `${hookPath} is not executable (mode=${(activeStat.mode & 0o777).toString(8)}) — ` +
          'git will silently skip it (block_ai_attribution will not be enforced at commit time)',
      };
    }
    // Husky 9 (`core.hooksPath=.husky/_`) auto-generates a `. "${0%/*}/h"`
    // stub at the active hooks path; git dispatches through it to
    // `.husky/commit-msg` (the canonical body). Classify THAT file — a
    // non-empty stub whose canonical body is missing is NOT an installed
    // gate. Same indirection-following as the prepare-commit-msg and
    // pre-push doctor checks.
    const content = fs.readFileSync(hookPath, 'utf8');
    if (isHusky9Stub(content)) {
      const target = resolveHusky9StubTarget(hookPath);
      if (target === null || !fs.existsSync(target)) {
        return {
          label: 'commit-msg hook installed',
          status: 'warn',
          detail:
            `husky 9 stub at ${hookPath} has no canonical body at ` +
            `${target ?? '<unresolvable>'} (block_ai_attribution will not be enforced at commit time)`,
        };
      }
      // The stub sources its sibling runner `.husky/_/h` BEFORE the
      // canonical body ever runs — a partially-installed husky (stub
      // present, runner missing) breaks `git commit` outright, which is
      // not a healthy install even though the body exists.
      const runner = path.join(path.dirname(hookPath), 'h');
      try {
        fs.accessSync(runner, fs.constants.R_OK);
      } catch {
        return {
          label: 'commit-msg hook installed',
          status: 'warn',
          detail:
            `husky 9 stub at ${hookPath} sources ${runner}, which is missing or ` +
            'unreadable — git commit will fail before the hook body runs. ' +
            'Reinstall husky (`pnpm install`) to regenerate it.',
        };
      }
      hookPath = target;
      // The canonical body must be a READABLE REGULAR FILE — a directory
      // left behind by a bad migration, or an unreadable file, means git
      // fails to source the hook and the gate is effectively disabled.
      // existsSync alone would report pass for both shapes.
      fs.accessSync(hookPath, fs.constants.R_OK);
    }
    const stat = fs.statSync(hookPath);
    if (!stat.isFile()) {
      return {
        label: 'commit-msg hook installed',
        status: 'fail',
        detail: `${hookPath} is not a regular file (block_ai_attribution will not be enforced at commit time)`,
      };
    }
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
          ? 'external (delegates to `rea hook push-gate`)'
          : 'external';
    const detail = active !== undefined ? `${kind} at ${active.path}` : undefined;
    return detail !== undefined
      ? { label: 'pre-push hook installed', status: 'pass', detail }
      : { label: 'pre-push hook installed', status: 'pass' };
  }

  if (state.activeForeign) {
    // Executable file exists at the active path but neither carries a rea
    // marker nor invokes `rea hook push-gate` — the push-gate is silently
    // bypassed. Always a hard fail. When the foreign hook references a
    // recognizable prior tool (commitlint, lint-staged, gitleaks, act-CI,
    // …), surface the .d/ migration path explicitly so consumers know
    // exactly how to keep their existing chain without losing rea coverage
    // or having `rea upgrade` clobber them again.
    const hints = state.activePath !== null ? detectPriorToolHints(state.activePath) : [];
    let detail =
      `active pre-push at ${state.activePath} is present and executable but does NOT ` +
      'invoke `rea hook push-gate` — the 0.11.0 push-gate is silently bypassed. ' +
      'Either add `exec rea hook push-gate "$@"` to the existing hook, or ' +
      'remove it and re-run `rea init` to install the fallback.';
    if (hints.length > 0) {
      detail +=
        `\n      Detected prior tooling in the foreign hook: ${hints.join(', ')}. ` +
        'Recommended migration (rea 0.13.0+): move each chained command to ' +
        '`.husky/pre-push.d/<NN>-<name>` as a separate executable file; rea then ' +
        'runs them in lex order AFTER the push-gate, surviving `rea upgrade` ' +
        'unchanged. See `MIGRATING.md` for a worked example.';
    }
    return {
      label: 'pre-push hook installed',
      status: 'fail',
      detail,
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

/**
 * Best-effort scan of a foreign hook body for references to recognizable
 * consumer tooling. Each match returns a short label so doctor can render
 * a precise migration recommendation without dumping the raw hook body.
 *
 * Patterns are intentionally narrow: a substring match in a non-comment line
 * referencing a tool's CLI binary or a well-known wrapper. False positives
 * here are cosmetic (extra hint) — the hard-fail decision still drives the
 * doctor verdict.
 *
 * Read errors are swallowed (return []). Doctor's foreign-hook message is
 * still useful without hints.
 */
function detectPriorToolHints(hookPath: string): string[] {
  let body: string;
  try {
    body = fs.readFileSync(hookPath, 'utf8');
  } catch {
    return [];
  }
  const lines = body.split(/\r?\n/);
  const found = new Set<string>();
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue; // skip comments
    if (/\bcommitlint\b/.test(raw)) found.add('commitlint');
    if (/\blint-staged\b/.test(raw)) found.add('lint-staged');
    if (/\bgitleaks\b/.test(raw)) found.add('gitleaks');
    if (/\bact[-_]ci\b/i.test(raw) || /\bact-CI\b/.test(raw)) found.add('act-CI');
    if (/\bhusky\.sh\b/.test(raw)) found.add('legacy husky 4-8 wrapper');
    if (/\bnpx\s+--no-install\s+commitlint/.test(raw)) found.add('commitlint');
  }
  return Array.from(found).sort();
}

/**
 * Detect and list extension-hook fragments under `.husky/commit-msg.d/` and
 * `.husky/pre-push.d/`. Informational only — fragments are an opt-in feature
 * (added in 0.13.0); their presence is something operators should know about
 * but never a hard fail. Non-executable files in the directories are
 * surfaced as a warning since they are silently skipped at hook-fire time
 * (executable bit is the consumer's opt-in).
 */
function checkExtensionFragments(baseDir: string): CheckResult {
  const dirs = [
    { name: 'commit-msg.d', path: path.join(baseDir, '.husky', 'commit-msg.d') },
    { name: 'pre-push.d', path: path.join(baseDir, '.husky', 'pre-push.d') },
  ];
  const found: string[] = [];
  const inert: string[] = [];
  for (const d of dirs) {
    if (!fs.existsSync(d.path)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const abs = path.join(d.path, e.name);
      try {
        const st = fs.statSync(abs);
        if ((st.mode & 0o111) !== 0) {
          found.push(`${d.name}/${e.name}`);
        } else {
          inert.push(`${d.name}/${e.name}`);
        }
      } catch {
        // unreadable — skip, will be surfaced at hook-fire time
      }
    }
  }
  if (found.length === 0 && inert.length === 0) {
    return {
      label: 'extension hook fragments',
      status: 'info',
      detail: 'none — drop executables into .husky/{commit-msg,pre-push}.d/ to chain custom checks',
    };
  }
  if (inert.length > 0) {
    const detail =
      `executable: ${found.length === 0 ? 'none' : found.join(', ')}; ` +
      `non-executable (silently skipped): ${inert.join(', ')} — chmod +x to enable`;
    return { label: 'extension hook fragments', status: 'warn', detail };
  }
  return {
    label: 'extension hook fragments',
    status: 'info',
    detail: `${found.length} executable fragment(s): ${found.join(', ')}`,
  };
}

function checkCodexAgent(baseDir: string): CheckResult {
  const agentPath = path.join(baseDir, '.claude', 'agents', 'codex-adversarial.md');
  if (fs.existsSync(agentPath))
    return { label: 'codex-adversarial agent installed', status: 'pass' };
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
 * Resolve the absolute path of `codex` on PATH (cross-platform). Returns
 * `null` when codex is not installed. We walk `process.env.PATH`
 * directly rather than shelling out — earlier iterations spawned
 * `sh -c "command -v codex"` which gave false negatives in sanitized
 * POSIX environments where `/bin` is omitted from PATH (CI runners,
 * hardened dev shells) but the `codex` binary lives at a project-bin
 * path that IS on PATH. Codex [P2] 2026-04-29.
 *
 * On Windows we iterate `PATHEXT` (default `.COM;.EXE;.BAT;.CMD`) so
 * `codex.cmd` (the typical npm shim) is discovered. POSIX checks the
 * bare name and accepts any file with an execute bit set.
 */
function resolveCodexBinary(): string | null {
  const isWindows = process.platform === 'win32';
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  if (pathEnv.length === 0) return null;
  const sep = isWindows ? ';' : ':';
  const entries = pathEnv.split(sep).filter((p) => p.length > 0);

  if (isWindows) {
    const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
    for (const dir of entries) {
      for (const ext of pathExt) {
        const candidate = path.join(dir, `codex${ext}`);
        try {
          const st = fs.statSync(candidate);
          if (st.isFile()) return candidate;
        } catch {
          // not present in this PATH entry — keep walking
        }
      }
      // also check the bare name in case PATHEXT is unusual
      const bare = path.join(dir, 'codex');
      try {
        const st = fs.statSync(bare);
        if (st.isFile()) return bare;
      } catch {
        // not present — keep walking
      }
    }
    return null;
  }

  // POSIX: check executable bit on the file mode.
  for (const dir of entries) {
    const candidate = path.join(dir, 'codex');
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      // not present in this PATH entry — keep walking
    }
  }
  return null;
}

/**
 * Hard-fail when `policy.review.codex_required: true` but the `codex`
 * binary is not on PATH. Pre-0.12.0 this prereq surfaced only at first
 * push, by which point the consumer had cloned, run `pnpm install`,
 * authored a commit, and tried to push — only then to learn that they
 * needed a separate install. Fix C of 0.12.0 surfaces it during install.
 *
 * Returns `pass` when codex resolves; `fail` when missing. Operators who
 * want to disable the gate can flip `policy.review.codex_required: false`
 * (the doctor then short-circuits past every Codex check).
 */
export function checkCodexBinaryOnPath(): CheckResult {
  const resolved = resolveCodexBinary();
  if (resolved !== null) {
    return {
      label: 'codex CLI on PATH',
      status: 'pass',
      detail: resolved,
    };
  }
  return {
    label: 'codex CLI on PATH',
    status: 'fail',
    detail:
      'codex not found on PATH. policy.review.codex_required: true requires the codex binary. ' +
      'Install: https://github.com/openai/codex (e.g. `npm i -g @openai/codex`). ' +
      'To disable the push-gate instead, set policy.review.codex_required: false in .rea/policy.yaml.',
  };
}

/**
 * 0.39.0 — `rea doctor` visibility into the 4-tier shim policy reader.
 *
 * `hooks/_lib/policy-reader.sh` (introduced 0.37.0) is the unified
 * shim-side policy reader. Each shim sources it and reads policy
 * values via a graceful-degradation ladder:
 *
 *   Tier 1: `rea hook policy-get --json` — canonical TS loader.
 *   Tier 2: `python3` + stdlib `yaml` (PyYAML).
 *   Tier 3: `awk` block-form parser (last resort, block-form ONLY).
 *   Tier 4: fail-closed sentinel.
 *
 * The Tier 1/2 path handles BOTH block-form and flow-form YAML
 * (`local_review: { mode: off }`). Tier 3 only handles block-form, so
 * a consumer with flow-form policy AND no reachable CLI AND no python3
 * silently no-ops on every shim fallback path — exactly the split-brain
 * 0.37.0 set out to fix. The risk persists if the consumer's box lacks
 * the upper tiers; operators currently have no way to see which tier
 * their shims would actually use.
 *
 * These doctor checks surface the tier inventory so the gap is visible
 * before it produces a silent regression. Each check is independent and
 * uses optional probe-function injection so unit tests can simulate any
 * combination of tier availability without manipulating PATH.
 *
 * Pure environment probes — no policy read, no shim spawn. Doctor calls
 * each one in turn and the summary check aggregates the verdicts.
 */

/**
 * Cheap PATH walker — returns the absolute path of `bin` when found
 * with an executable bit set, or `null` otherwise. Mirrors
 * `resolveCodexBinary`'s POSIX path but generalized for any binary.
 *
 * Windows path: walks PATHEXT and the bare name like `resolveCodexBinary`
 * does for `codex`. Most consumer machines that run the shim ladder are
 * POSIX (the shim is bash); Windows support is best-effort.
 */
function resolveBinaryOnPath(bin: string): string | null {
  const isWindows = process.platform === 'win32';
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  if (pathEnv.length === 0) return null;
  const sep = isWindows ? ';' : ':';
  const entries = pathEnv.split(sep).filter((p) => p.length > 0);

  if (isWindows) {
    const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
    for (const dir of entries) {
      for (const ext of pathExt) {
        const candidate = path.join(dir, `${bin}${ext}`);
        try {
          const st = fs.statSync(candidate);
          if (st.isFile()) return candidate;
        } catch {
          // not present — keep walking
        }
      }
      const bare = path.join(dir, bin);
      try {
        const st = fs.statSync(bare);
        if (st.isFile()) return bare;
      } catch {
        // not present — keep walking
      }
    }
    return null;
  }

  for (const dir of entries) {
    const candidate = path.join(dir, bin);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      // not present — keep walking
    }
  }
  return null;
}

/**
 * Probe interface accepted by the policy-reader tier checks. Each
 * field is optional; when omitted the check uses the real-environment
 * default (PATH walk, spawnSync). Tests inject stubs to get
 * deterministic, fast verdicts without touching the real filesystem or
 * spawning subprocesses.
 *
 * - `cliDistExists` — does the rea CLI binary exist on disk at one of
 *   the two shim-resolved paths? Cheap (single `existsSync`). Used to
 *   give a clear "missing vs. broken" error message when Tier 1 is
 *   unreachable.
 * - `cliInvokable` — does the resolved CLI actually respond to
 *   `rea hook policy-get version --json`? The expensive probe (one
 *   subprocess spawn). Mirrors EXACTLY what `_pr_load_full_json`
 *   does in `hooks/_lib/policy-reader.sh` so a stale or broken dist
 *   reports `warn` here — same outcome the real shim ladder would
 *   produce. Codex round-1 P2 (2026-05-16).
 * - `python3OnPath` / `python3PyYamlReachable` — Tier 2 reachability.
 *   `python3PyYamlReachable` returns `true` when both python3 AND the
 *   `yaml` stdlib (PyYAML) can be imported (the Tier 2 loader needs
 *   both).
 * - `awkOnPath` / `jqOnPath` — Tier 3 + JSON-accelerator reachability.
 */
export interface PolicyReaderProbes {
  cliDistExists?: (baseDir: string) => boolean;
  cliInvokable?: (baseDir: string) => boolean;
  python3OnPath?: () => string | null;
  /**
   * 0.40.0 charter item 3 — accepts the consumer's `baseDir` so the
   * probe can thread it as `cwd` to the spawned `python3 -c` process.
   * Pre-fix, the spawn happened in doctor's own cwd, which meant the
   * sys.path scrub (which removes "", ".", CWD, realpath(CWD) to
   * mirror policy-reader.sh's defense against a malicious repo-local
   * `./yaml.py`) operated on the wrong directory when `rea doctor`
   * was invoked from outside the consumer tree (e.g. `cd /tmp && rea
   * doctor --base-dir /Users/.../consumer-repo`).
   *
   * Probes that don't care about cwd (test stubs, fakes) can simply
   * ignore the argument; the default production probe uses it.
   */
  python3PyYamlReachable?: (baseDir: string) => boolean;
  /**
   * 0.42.0 codex round 5 P2 (2026-05-16) — execution probe for the
   * python3 list-walker branch in `policy_reader_get_list`. That
   * branch needs to spawn `python3 -c "..."` with `import json` from
   * stdlib; PyYAML is irrelevant. The check is execution-based (not
   * PATH-only) because a `python3` symlink can resolve on PATH but
   * fail to start in the current sandbox (dangling pyenv/asdf stub,
   * permission-denied interpreter, missing dynamic libs). A PATH-only
   * check would let the doctor declare `warn` on a box where the
   * shim will actually fall through to Tier 3 — masking a real
   * enforcement gap for list-valued policy keys.
   *
   * The probe runs `python3 -c "import json; print('ok')"` with the
   * same env scrub as the PyYAML probe (PYTHONPATH/PYTHONHOME/
   * PYTHONSTARTUP unset, PYTHONSAFEPATH=1, sys.path scrubbed) so a
   * malicious repo cannot plant a `./json.py` that shadows stdlib
   * and falsely report `true` while the real loader (which scrubs)
   * fails.
   */
  python3ListWalkerReachable?: (baseDir: string) => boolean;
  awkOnPath?: () => string | null;
  jqOnPath?: () => string | null;
}

/** Resolve the shim's preferred CLI dist path, or null when no layout matches. */
function resolveCliDistPath(baseDir: string): string | null {
  // The shim's Tier 1 path requires the rea CLI binary to be
  // resolvable from the consumer's tree. Two layouts cover every
  // real-world install:
  //   1. <baseDir>/node_modules/@bookedsolid/rea/dist/cli/index.js
  //      (consumer install — `pnpm i @bookedsolid/rea`)
  //   2. <baseDir>/dist/cli/index.js
  //      (rea-repo dogfood after `pnpm build`)
  // Either presence is enough for the shim's sandboxed CLI resolution
  // (see hooks/_lib/shim-runtime.sh).
  const consumerCli = path.join(
    baseDir,
    'node_modules',
    '@bookedsolid',
    'rea',
    'dist',
    'cli',
    'index.js',
  );
  if (fs.existsSync(consumerCli)) return consumerCli;
  const dogfoodCli = path.join(baseDir, 'dist', 'cli', 'index.js');
  if (fs.existsSync(dogfoodCli)) return dogfoodCli;
  return null;
}

function defaultCliDistExists(baseDir: string): boolean {
  return resolveCliDistPath(baseDir) !== null;
}

/**
 * Sandbox check — mirrors `shim_sandbox_check` in
 * `hooks/_lib/shim-runtime.sh` (introduced 0.38.0).
 *
 * Codex round-2 P1 (2026-05-16): the pre-fix `defaultCliInvokable`
 * spawned the resolved CLI WITHOUT this validation. An attacker who
 * could plant a `dist/cli/index.js` outside `realpath(baseDir)` (via
 * a symlink) — OR plant one inside the tree but WITHOUT an ancestor
 * `package.json` whose `name === "@bookedsolid/rea"` — would have
 * their forged code executed every time doctor probed Tier 1
 * reachability. The real shim chain refuses these layouts; the
 * doctor probe MUST refuse them identically so it cannot be tricked
 * into reporting `pass` on a layout the production shims would
 * never trust.
 *
 * Returns `true` when:
 *   1. `realpath(cli)` resolves AND lives INSIDE `realpath(baseDir)`
 *      (no symlink-out of the project)
 *   2. an ancestor `package.json` (walking up from
 *      `dirname(dirname(dirname(real)))` — i.e. the package root for
 *      a `dist/cli/index.js` shape) has `name === "@bookedsolid/rea"`
 *      (max 20 hops)
 *
 * Returns `false` on any failure (realpath miss, escapes-project,
 * missing/wrong package.json). Doctor's Tier 1 check then treats a
 * sandbox-failed CLI identically to a CLI-missing layout — both
 * report `warn` ("Tier 1 unreachable") rather than `pass`.
 *
 * This mirrors the bash logic EXACTLY:
 *   - `fs.realpathSync` on both paths (no symlink slippage)
 *   - path-prefix containment via `realProj + sep` (so a sibling
 *     directory whose name STARTS with realProj cannot match)
 *   - ancestor walk capped at 20 hops with a filesystem-root break
 *     (`cur === path.dirname(cur)`)
 *   - JSON parse failures in any candidate `package.json` are
 *     swallowed and the walk continues (mirrors the bash `try/catch`)
 *
 * Kept in sync with the bash helper: any future change to the
 * sandbox-check shape (e.g. CLI-shape enforcement) MUST be applied
 * in both places.
 */
function sandboxCheckCli(cli: string, baseDir: string): boolean {
  let real: string;
  let realProj: string;
  try {
    real = fs.realpathSync(cli);
  } catch {
    return false;
  }
  try {
    realProj = fs.realpathSync(baseDir);
  } catch {
    return false;
  }
  const sep = path.sep;
  const projWithSep = realProj.endsWith(sep) ? realProj : realProj + sep;
  if (!(real === realProj || real.startsWith(projWithSep))) {
    return false;
  }
  // Walk ancestor directories from the package root (3 levels up
  // from a `<root>/dist/cli/index.js` shape) looking for a
  // package.json whose `name === "@bookedsolid/rea"`. Max 20 hops
  // with a filesystem-root break so we never loop forever on
  // exotic mount layouts.
  let cur = path.dirname(path.dirname(path.dirname(real)));
  for (let i = 0; i < 20 && cur && cur !== path.dirname(cur); i += 1) {
    const pj = path.join(cur, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const data = JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: unknown };
        if (data && data.name === '@bookedsolid/rea') {
          return true;
        }
      } catch {
        // keep walking — malformed package.json on the path is not fatal
      }
    }
    cur = path.dirname(cur);
  }
  return false;
}

/**
 * Codex round-1 P2 (2026-05-16): the file-presence probe alone allows
 * a stale or broken dist (e.g. an upgrade-lagged consumer who never
 * re-ran `pnpm build`) to falsely report `pass` while the real shim
 * ladder in `hooks/_lib/policy-reader.sh` would skip Tier 1 because
 * `rea hook policy-get version --json` exits non-zero. We mirror that
 * exact probe verbatim — same key (`version`), same `--json` flag,
 * same accept-criterion (exit 0 + non-empty stdout).
 *
 * Codex round-2 P1 (2026-05-16): BEFORE invoking the resolved CLI,
 * apply the same realpath + ancestor-package.json sandbox check the
 * shims apply in `hooks/_lib/shim-runtime.sh::shim_sandbox_check`.
 * Pre-fix, an attacker who could plant a `dist/cli/index.js` via a
 * symlink-out (or without a `@bookedsolid/rea` package.json ancestor)
 * would have their forged code executed every probe call — yet the
 * real shim ladder would refuse the same layout. This probe MUST
 * refuse identically so it cannot mis-report `pass` on an
 * unsandboxed CLI.
 *
 * Returns `true` when the CLI responds correctly; `false` when the
 * dist is missing OR present-but-broken OR present-but-unsandboxed.
 * Doctor's Tier 1 check then surfaces the difference: missing →
 * install guidance; broken/unsandboxed → rebuild guidance. (The
 * unsandboxed branch deliberately collapses into the "broken" bucket
 * because either way Tier 1 is unreachable for the shim chain.)
 *
 * 8s timeout: the CLI's `hook policy-get` path is local-only (zod
 * load + YAML parse + JSON walk); on any reasonable machine it
 * resolves in under a second. The timeout is a defense against a CLI
 * that hangs on import (a broken postinstall, a missing native module)
 * rather than a normal-operation budget.
 */
function defaultCliInvokable(baseDir: string): boolean {
  const cli = resolveCliDistPath(baseDir);
  if (cli === null) return false;
  // Codex round-2 P1: sandbox check BEFORE spawn. Pre-fix the probe
  // spawned arbitrary code that happened to live at the expected
  // shim-resolved path; if a symlink-out OR a missing rea
  // package.json ancestor existed, we executed an attacker payload.
  if (!sandboxCheckCli(cli, baseDir)) return false;
  try {
    const res = spawnSync('node', [cli, 'hook', 'policy-get', 'version', '--json'], {
      cwd: baseDir,
      timeout: 8_000,
      // Tier 1 reads policy.yaml at REA_ROOT — propagate so the probe
      // honors the same scope the real shim chain would (a missing
      // `CLAUDE_PROJECT_DIR` falls back to cwd, which doctor has
      // already set).
      env: { ...process.env, CLAUDE_PROJECT_DIR: baseDir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0) return false;
    const out = (res.stdout ?? '').trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function defaultPython3PyYamlReachable(baseDir: string): boolean {
  // The Tier 2 loader runs `python3 -c "import yaml"`. We mirror that
  // probe verbatim so a `yaml`-installable-but-broken interpreter is
  // not falsely reported as "reachable". Apply the SAME env scrub
  // (PYTHONPATH / PYTHONHOME / PYTHONSTARTUP unset, PYTHONSAFEPATH=1)
  // that policy-reader.sh applies, so a repo-local `yaml.py` cannot
  // shadow the stdlib copy here either — otherwise this probe would
  // report `true` against a malicious repo where the actual loader
  // would (correctly) refuse to import.
  //
  // Codex round-3 P1 (2026-05-16): `PYTHONSAFEPATH=1` is the env-var
  // form of `python3 -P` and is only honored on Python 3.11+. On
  // Python 3.4-3.10 (still installed by default on macOS Big Sur /
  // Monterey / Ventura, RHEL 8, Ubuntu 20.04, …) it is SILENTLY
  // IGNORED — meaning the interpreter will still prepend `""`/`"."`/
  // CWD to `sys.path[0]` and import a repo-local `./yaml.py` instead
  // of the stdlib copy. The production loader in
  // hooks/_lib/policy-reader.sh closes this gap with a defensive
  // sys.path scrub at the top of every `python3 -c` body (see the
  // "Codex round 2 P1" comment block in policy-reader.sh:256-267).
  // We MUST mirror that scrub here — without it, a malicious repo
  // could plant `./yaml.py`, get this probe to report `true`, while
  // the real Tier 2 loader (which DOES scrub) refuses to import and
  // falls through to Tier 3. The doctor verdict would then point
  // operators at the wrong tier when diagnosing a stuck shim.
  try {
    const probeEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONSAFEPATH: '1' };
    delete probeEnv['PYTHONPATH'];
    delete probeEnv['PYTHONHOME'];
    delete probeEnv['PYTHONSTARTUP'];
    // Same scrub shape as policy-reader.sh's Tier 2 body — strip
    // empty/CWD entries from sys.path BEFORE the `import yaml` so
    // the probe and the production loader produce the same answer
    // on Python 3.4-3.10.
    const probeBody = [
      'import sys',
      'import os',
      '_cwd = os.getcwd()',
      '_cwd_real = os.path.realpath(_cwd)',
      'sys.path[:] = [p for p in sys.path if p not in ("", ".", _cwd, _cwd_real)]',
      'import yaml',
    ].join('\n');
    // 0.40.0 charter item 3 — thread `baseDir` as cwd so the sys.path
    // scrub above strips THIS consumer's repo root (the directory the
    // production shim chain runs from), not doctor's own cwd. Pre-fix,
    // `rea doctor --base-dir <consumer>` invoked from `/tmp/foo` would
    // scrub against `/tmp/foo`, leaving any `<consumer>/yaml.py`
    // shadowing potential undetected — exactly the multi-repo workflow
    // every other doctor probe (cliInvokable, …) already handles by
    // setting cwd to baseDir.
    const res = spawnSync('python3', ['-c', probeBody], {
      cwd: baseDir,
      env: probeEnv,
      timeout: 5_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * 0.42.0 codex round 5 P2 (2026-05-16) — execution probe for the
 * python3 list-walker. Mirrors `defaultPython3PyYamlReachable` exactly
 * but swaps the `import yaml` for `import json` (the actual stdlib
 * module the shim's list-walker branch imports). Spawning the
 * interpreter end-to-end catches the broken-symlink / unreachable-
 * shim case that a bare PATH check misses.
 */
function defaultPython3ListWalkerReachable(baseDir: string): boolean {
  try {
    const probeEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONSAFEPATH: '1' };
    delete probeEnv['PYTHONPATH'];
    delete probeEnv['PYTHONHOME'];
    delete probeEnv['PYTHONSTARTUP'];
    // Same sys.path scrub as the production loader, applied before
    // `import json`. `json` is stdlib so a malicious `./json.py`
    // attack would matter the same way `./yaml.py` does.
    const probeBody = [
      'import sys',
      'import os',
      '_cwd = os.getcwd()',
      '_cwd_real = os.path.realpath(_cwd)',
      'sys.path[:] = [p for p in sys.path if p not in ("", ".", _cwd, _cwd_real)]',
      'import json',
      'sys.stdout.write("ok")',
    ].join('\n');
    const res = spawnSync('python3', ['-c', probeBody], {
      cwd: baseDir,
      env: probeEnv,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0) return false;
    return (res.stdout?.toString().trim() ?? '') === 'ok';
  } catch {
    return false;
  }
}

const DEFAULT_PROBES: Required<PolicyReaderProbes> = {
  cliDistExists: defaultCliDistExists,
  cliInvokable: defaultCliInvokable,
  python3OnPath: () => resolveBinaryOnPath('python3'),
  python3PyYamlReachable: defaultPython3PyYamlReachable,
  python3ListWalkerReachable: defaultPython3ListWalkerReachable,
  awkOnPath: () => resolveBinaryOnPath('awk'),
  jqOnPath: () => resolveBinaryOnPath('jq'),
};

function resolveProbes(probes: PolicyReaderProbes | undefined): Required<PolicyReaderProbes> {
  if (probes === undefined) return DEFAULT_PROBES;
  // 0.42.0 codex round 5 P2 (2026-05-16): when a caller (typically
  // a unit test) stubs `python3OnPath` but does NOT stub the new
  // `python3ListWalkerReachable` execution probe, derive a faithful
  // fallback from `python3OnPath` instead of falling through to the
  // real `defaultPython3ListWalkerReachable` (which would spawn a
  // python3 subprocess and break test determinism). The convention
  // matches `python3PyYamlReachable` in the existing test suite:
  // stubs that say "python3 is present" want both downstream probes
  // to report reachable, and stubs that say "python3 is absent" want
  // both downstream probes to report unreachable.
  const overrides: PolicyReaderProbes = { ...probes };
  if (overrides.python3ListWalkerReachable === undefined && overrides.python3OnPath !== undefined) {
    const stubbedPython3OnPath = overrides.python3OnPath;
    overrides.python3ListWalkerReachable = () => stubbedPython3OnPath() !== null;
  }
  return { ...DEFAULT_PROBES, ...overrides };
}

/**
 * Tier 1 — `rea hook policy-get`. Reachable when the rea CLI is
 * present at one of the two shim-resolved paths (consumer install OR
 * dogfood `dist/`) AND actually responds to `rea hook policy-get
 * version --json`. The shim ladder uses that exact invocation as its
 * Tier 1 probe (see `_pr_load_full_json` in `hooks/_lib/policy-reader.sh`);
 * mirroring it here means a stale or broken dist (file present but
 * import-throws / postinstall failed) reports `warn` — matching the
 * real fall-through to Tier 2/3 the shim would do at runtime.
 *
 * Three states:
 *   - dist present + CLI responds → `pass` (canonical loader fully wired).
 *   - dist present + CLI broken → `warn` (stale build, missing native
 *     module, broken postinstall — needs `pnpm build` / `rea upgrade`).
 *   - dist absent → `warn` (not installed; Tier 2/3 still cover).
 *
 * Codex round-1 P2 (2026-05-16) replaced the file-existence-only
 * probe with this CLI-invocation probe — pre-fix, a consumer with
 * `dist/cli/index.js` present but throwing on load would see `pass`
 * here while every real shim would silently fall through.
 */
export function checkPolicyReaderTier1(
  baseDir: string,
  probes?: PolicyReaderProbes,
): CheckResult {
  const label = 'policy-reader Tier 1 (rea CLI)';
  const p = resolveProbes(probes);
  const distPresent = p.cliDistExists(baseDir);
  if (!distPresent) {
    return {
      label,
      status: 'warn',
      detail:
        'rea CLI dist not found at node_modules/@bookedsolid/rea/dist/cli/index.js or <baseDir>/dist/cli/index.js — ' +
        'shims fall through to Tier 2/3 (works, but loses validated schema + full subtree shapes). ' +
        'Consumer: run `pnpm i @bookedsolid/rea`. Dogfood: run `pnpm build`.',
    };
  }
  if (!p.cliInvokable(baseDir)) {
    return {
      label,
      status: 'warn',
      detail:
        'rea CLI dist exists but `rea hook policy-get version --json` failed — the dist is ' +
        'stale or broken (incomplete build, missing native module, broken postinstall). The ' +
        'shim ladder will skip Tier 1 and fall through to Tier 2/3 just as this probe did. ' +
        'Run `pnpm build` (dogfood) or `rea upgrade` (consumer) to rebuild.',
    };
  }
  return {
    label,
    status: 'pass',
    detail:
      'rea CLI dist responds to `hook policy-get version --json` — canonical loader fully wired',
  };
}

/**
 * Tier 2 — python3 + stdlib `yaml` (PyYAML). Handles BOTH block-form
 * and flow-form YAML; the practical floor when Tier 1 is unreachable.
 *
 * Three states:
 *   - python3 present + PyYAML importable → `pass`.
 *   - python3 present, PyYAML missing → `warn` (the loader will fall
 *     through to Tier 3, which only handles block-form).
 *   - python3 absent → `warn` (same Tier 3 fall-through).
 *
 * Never `fail` — Tier 3 is still a valid floor for block-form policy.
 * The warning highlights the silent no-op risk for flow-form lookups
 * when CLI is also unreachable.
 */
export function checkPolicyReaderTier2(
  baseDir: string,
  probes?: PolicyReaderProbes,
): CheckResult {
  const label = 'policy-reader Tier 2 (python3 + PyYAML)';
  const p = resolveProbes(probes);
  const py = p.python3OnPath();
  if (py === null) {
    return {
      label,
      status: 'warn',
      detail:
        'python3 not on PATH — Tier 2 unavailable. Shims fall through to Tier 3 (awk, ' +
        'block-form only). Flow-form policy (e.g. `local_review: { mode: off }`) silently ' +
        'no-ops when the rea CLI is also unreachable. Install python3 to close this gap.',
    };
  }
  if (!p.python3PyYamlReachable(baseDir)) {
    return {
      label,
      status: 'warn',
      detail:
        `python3 found at ${py} but \`import yaml\` failed — PyYAML missing. ` +
        'Shims fall through to Tier 3 (awk, block-form only). Flow-form policy silently ' +
        'no-ops when the rea CLI is also unreachable. Install: `pip3 install pyyaml`.',
    };
  }
  return {
    label,
    status: 'pass',
    detail: `python3 + PyYAML reachable at ${py} — flow-form policy parses correctly`,
  };
}

/**
 * Tier 3 — awk block-form parser. Last-resort no-dep fallback.
 * Practically always present (POSIX requirement).
 *
 * 0.40.0 charter item 2 — conditional verdict, refined by codex
 * round 1 P2 (0.40.0) and round 2 P2 (0.42.0):
 *   - awk present                                            → `pass`
 *   - awk absent AND Tier 2 reachable                        → `warn`
 *     (Tier 2 implies python3, which is a list-walker)
 *   - awk absent AND Tier 1 reachable AND a list walker
 *     (jq OR full Tier-2 reachable) is usable                → `warn`
 *   - awk absent AND Tier 1 reachable BUT no list walker     → `fail`
 *     (codex round 1 P2 — list-valued policy reads silently
 *     fail-closed even though scalar reads work, so the
 *     downgrade-to-warn is misleading; doctor would exit 0 on a
 *     broken install)
 *   - awk absent AND no other tier reachable                 → `fail`
 *
 * Pre-fix the absent-awk branch always returned `fail` — but when
 * Tier 1 (rea CLI) AND/OR Tier 2 (python3+PyYAML) are reachable AND
 * the list walker exists, the operator's effective floor is fine even
 * without awk; Tier 3 is the LAST fallback, not a hard requirement.
 * The summary check (`checkPolicyReaderTierSummary`) already
 * aggregates correctly; this per-tier verdict now reflects the same
 * severity logic so an operator who reads ONLY the Tier 3 row isn't
 * misled into thinking the install is broken on a perfectly-
 * functional box that has python3 + jq + the rea CLI all wired but
 * happens to lack awk.
 *
 * List-iteration semantic (clarifying note for codex round 2 P2,
 * 2026-05-16): `policy_reader_get_list` in
 * `hooks/_lib/policy-reader.sh` walks the cached subtree JSON via
 * `jq` OR `python3` (stdlib-only — `json` module, no PyYAML import).
 * PyYAML is only needed for Tier 2 itself (YAML PARSING into JSON),
 * NOT for iterating the already-parsed JSON arrays at list-read time.
 *
 * Codex round 5 P2 (2026-05-16): the "list walker" predicate uses
 * `python3ListWalkerReachable` — an EXECUTION probe that actually
 * spawns `python3 -c "import json"` — instead of `python3OnPath`. A
 * PATH-only check passes for broken pyenv/asdf shims, dangling
 * symlinks, and sandboxed environments where the interpreter cannot
 * start; in those cases the shim's list-walker branch would actually
 * fail and `blocked_paths`/`protected_writes` enforcement would
 * silently break while doctor reported `warn`. The execution probe
 * mirrors `defaultPython3PyYamlReachable` exactly but swaps the
 * `import yaml` for `import json` so it's not gated on PyYAML
 * availability (which is irrelevant to list iteration).
 *
 * Takes `baseDir` so it can evaluate Tier 1's two-stage check (dist
 * present + CLI invokable), Tier 2's reachability, and the
 * list-walker execution probe. All probes are threaded through
 * identically.
 */
export function checkPolicyReaderTier3(
  baseDir: string,
  probes?: PolicyReaderProbes,
): CheckResult {
  const label = 'policy-reader Tier 3 (awk)';
  const p = resolveProbes(probes);
  const awk = p.awkOnPath();
  if (awk !== null) {
    return {
      label,
      status: 'pass',
      detail: `awk at ${awk} — block-form fallback available`,
    };
  }
  // 0.40.0 — awk is absent. Decide whether this is `warn` (other tiers
  // cover) or `fail` (catastrophic — no working policy lookup tier).
  // Mirror Tier 1's two-stage check (dist + invokable) and Tier 2's
  // python3 + PyYAML pair so the verdict here matches what the shim
  // ladder would actually do at runtime.
  const tier1 = p.cliDistExists(baseDir) && p.cliInvokable(baseDir);
  const tier2 = p.python3OnPath() !== null && p.python3PyYamlReachable(baseDir);
  // Codex round 1 P2 (0.40.0) + round 2 P2 corrected (0.42.0,
  // 2026-05-16) + round 5 P2 (0.42.0, 2026-05-16): the
  // downgrade-to-warn branch needs a list walker too.
  // `policy_reader_get_list` iterates the parsed JSON array via jq
  // OR python3. The python3 branch uses `json` from stdlib only —
  // PyYAML is NOT required (it's only needed for Tier 2's YAML
  // parsing step, which has already run by the time list iteration
  // executes).
  //
  // Round 5 P2 hardening: the python3 leg of this predicate uses an
  // EXECUTION probe (`python3ListWalkerReachable`), not just a PATH
  // check. A `python3` symlink can resolve on PATH while the
  // interpreter itself fails to start (dangling pyenv/asdf shim,
  // sandboxed runner without dynamic libs, permission denied on the
  // resolved binary). PATH-only would let doctor declare `warn` on
  // a box where the shim's list walker would actually fail —
  // silently breaking `blocked_paths` / `protected_writes`
  // enforcement while doctor exits 0.
  const listWalker = p.jqOnPath() !== null || p.python3ListWalkerReachable(baseDir);
  if (tier2 || (tier1 && listWalker)) {
    const reachable: string[] = [];
    if (tier1) reachable.push('Tier 1 (rea CLI)');
    if (tier2) reachable.push('Tier 2 (python3+PyYAML)');
    return {
      label,
      status: 'warn',
      detail:
        `awk not on PATH — Tier 3 (block-form fallback) unreachable. ${reachable.join(
          ' and ',
        )} ` +
        'still cover the shim ladder, so policy lookups continue to work; this is a ' +
        'soft degradation, not a hard failure. Install awk (`mawk`, `gawk`, or `nawk`) ' +
        'to restore the last-resort fallback.',
    };
  }
  // Codex round 1 P2 (0.40.0) + round 2 P2 (0.42.0): separate "no list
  // walker" diagnosis from the catastrophic "no tier at all" case.
  // Tier 1 reachable but no jq AND no python3 AND no awk means
  // list-valued policy reads fail-closed silently — distinct from the
  // truly-empty no-CLI-no-python-no-awk shape, and worth a precise
  // remediation. The python3-as-list-walker signal is plain
  // `python3OnPath` (the `json` module is stdlib — PyYAML is NOT
  // required for list iteration).
  if (tier1) {
    // 0.42.0 codex round 6 P3 (2026-05-16): distinguish "python3 not
    // on PATH" from "python3 on PATH but execution fails". Pre-fix
    // this branch always reported "python3 is not on PATH" even when
    // a python3 binary was resolvable but a broken pyenv/asdf shim
    // or sandboxed interpreter failed the execution probe — that
    // sent operators toward the wrong remediation. Round 5 added
    // the execution probe specifically to surface this case; the
    // diagnostic needs to follow.
    const pythonOnPath = p.python3OnPath();
    const pythonState =
      pythonOnPath === null
        ? 'python3 is not on PATH'
        : `python3 at ${pythonOnPath} cannot execute \`import json\` (broken pyenv/asdf shim, ` +
          'sandboxed interpreter, or permission-denied binary — fix the interpreter or ' +
          'remove the shim)';
    const remediation =
      pythonOnPath === null
        ? 'Install awk OR jq OR python3 to restore list-iteration.'
        : `Install awk OR jq, or repair the python3 interpreter at ${pythonOnPath}, ` +
          'to restore list-iteration.';
    return {
      label,
      status: 'fail',
      detail:
        `awk not on PATH AND jq is not on PATH AND ${pythonState} — ` +
        'Tier 1 (rea CLI) parses flow-form scalars, but `policy_reader_get_list` ' +
        'cannot iterate list-valued keys (e.g. `blocked_paths: [.env, ...]`) ' +
        'without jq OR python3 OR awk to walk the resulting JSON arrays. ' +
        'Affected hooks (`blocked-paths-bash-gate.sh`, ' +
        `\`blocked-paths-enforcer.sh\`, …) see an EMPTY list and silently stop ` +
        `enforcing. ${remediation}`,
    };
  }
  return {
    label,
    status: 'fail',
    detail:
      'awk not on PATH — no fallback tier reachable. If the rea CLI and python3+PyYAML are ' +
      'ALSO unreachable, every shim policy lookup fails closed. This is unusual; awk is a ' +
      'POSIX requirement. Install awk (`mawk`, `gawk`, or `nawk`).',
  };
}

/**
 * jq — optional accelerator used by Tier 1/2's JSON subtree parsing.
 * Per the 0.37.0 round-1 P2 fix the helper falls back to a python3
 * walker when jq is absent (still correct, just an extra spawn per
 * leaf). `warn` when missing so operators know they're paying the
 * latency cost.
 *
 * `info` when present — no action needed, just confirming the
 * accelerator is wired.
 */
export function checkPolicyReaderJq(probes?: PolicyReaderProbes): CheckResult {
  const label = 'policy-reader jq (JSON accelerator)';
  const p = resolveProbes(probes);
  const jq = p.jqOnPath();
  if (jq !== null) {
    return {
      label,
      status: 'pass',
      detail: `jq at ${jq} — used by Tier 1/2 JSON subtree walking`,
    };
  }
  return {
    label,
    status: 'warn',
    detail:
      'jq not on PATH — Tier 1/2 fall back to a python3 JSON walker per leaf (correct, ' +
      'just slower). Install jq to reduce per-leaf spawn overhead.',
  };
}

/**
 * Summary roll-up: which tiers are reachable, what's the effective
 * floor when the CLI is unreachable, and is flow-form policy at risk
 * of silent no-op.
 *
 * Four verdicts:
 *   - `pass` — Tier 1 OR Tier 2 reachable AND a JSON list walker
 *     (jq or python3) is available. Flow-form scalars AND flow-form
 *     arrays both parse correctly via whichever tier is hit first.
 *   - `warn` (flow-form-lists-degraded) — Tier 1 reachable but neither
 *     jq nor python3 on PATH. Flow-form SCALARS parse correctly via
 *     the CLI's JSON output, but `policy_reader_get_list` cannot
 *     iterate the resulting JSON array — it falls through to Tier 3
 *     awk, which silently misses flow-form arrays like
 *     `blocked_paths: [.env, ...]`. Codex round-1 P2 (2026-05-16).
 *   - `warn` (Tier-3-only) — Only Tier 3 (awk) reachable. Block-form
 *     policy works; flow-form scalars AND arrays both silently no-op
 *     on every shim fallback.
 *   - `fail` — No tiers reachable. Shims fail closed on every policy
 *     lookup. (Practically requires losing awk too — see Tier 3.)
 *
 * Tier 2 implies python3 is on PATH (it's the interpreter that runs
 * the loader), so when Tier 2 is reachable the list-iteration python3
 * fallback is also reachable — only the Tier-1-without-list-walker
 * shape can produce the degraded warning.
 */
export function checkPolicyReaderTierSummary(
  baseDir: string,
  probes?: PolicyReaderProbes,
): CheckResult {
  const label = 'policy-reader effective floor';
  const p = resolveProbes(probes);
  // Mirror Tier 1's two-stage check — dist present + CLI invokable.
  // A stale/broken dist that fails the invokable probe is treated as
  // "Tier 1 not reachable" so the summary matches what the shim
  // ladder would actually do at runtime.
  const tier1 = p.cliDistExists(baseDir) && p.cliInvokable(baseDir);
  const py = p.python3OnPath();
  const tier2 = py !== null && p.python3PyYamlReachable(baseDir);
  const tier3 = p.awkOnPath() !== null;
  const jq = p.jqOnPath();
  // 0.42.0 codex round 5 P2 (2026-05-16): list iteration after Tier
  // 1/2 needs jq OR a python3 that can ACTUALLY execute (not just
  // resolve on PATH). The execution probe catches the broken-shim
  // case where `python3` resolves but the interpreter cannot start —
  // PATH-only would falsely declare the list walker "usable" on a
  // box where the shim's python3 branch will fall through to Tier 3
  // and silently miss flow-form arrays.
  const listWalker = jq !== null || p.python3ListWalkerReachable(baseDir);

  const reachable: string[] = [];
  if (tier1) reachable.push('Tier 1 (CLI)');
  if (tier2) reachable.push('Tier 2 (python3+PyYAML)');
  if (tier3) reachable.push('Tier 3 (awk)');

  if (tier1 || tier2) {
    if (!listWalker) {
      // Tier 1 + no working list walker. flow-form scalars work;
      // flow-form arrays silently no-op via Tier 3 fallthrough.
      // (Tier 2 path is unreachable here because Tier 2 requires
      // python3 itself reachable.)
      //
      // 0.43.0 round-7 P3 (2026-05-17): mirror the round-6 P3 fix
      // from `checkPolicyReaderTier3`. Pre-fix this branch always
      // said "neither jq nor python3 is on PATH" — but the
      // `listWalker` predicate is `jq OR python3ListWalkerReachable`,
      // so it also fires when python3 IS on PATH but the EXECUTION
      // probe fails (broken pyenv/asdf shim, dangling symlink,
      // sandboxed interpreter that fails to start). That
      // misdiagnosis sent operators chasing the wrong remediation
      // ("install python3" when python3 was already installed but
      // broken). Distinguish the two shapes so the operator sees
      // the actual problem, and surface the resolved path so they
      // can `ls -l` it on the filesystem.
      const pythonOnPath = py;
      const pythonState =
        pythonOnPath === null
          ? 'neither jq nor python3 is on PATH'
          : `jq is not on PATH AND python3 at ${pythonOnPath} cannot execute \`import json\` ` +
            '(broken pyenv/asdf shim, sandboxed interpreter, or permission-denied binary — ' +
            'fix the interpreter or remove the shim)';
      const remediation =
        pythonOnPath === null
          ? 'Install jq (`brew install jq` / `apt-get install jq`) or python3 to close the gap.'
          : `Install jq (\`brew install jq\` / \`apt-get install jq\`) or repair the python3 ` +
            `interpreter at ${pythonOnPath} to close the gap.`;
      return {
        label,
        status: 'warn',
        detail:
          `${reachable.join(', ')} reachable — flow-form scalars parse via Tier 1 CLI, ` +
          `BUT ${pythonState} so \`policy_reader_get_list\` cannot iterate ` +
          'the resulting JSON arrays. Flow-form list policy (e.g. `blocked_paths: [.env, ...]`) ' +
          `silently falls through to Tier 3 awk and misses inline arrays. ${remediation}`,
      };
    }
    return {
      label,
      status: 'pass',
      detail: `${reachable.join(', ')} reachable — flow-form policy parses correctly`,
    };
  }
  if (tier3) {
    return {
      label,
      status: 'warn',
      detail:
        'only Tier 3 (awk, block-form ONLY) reachable — flow-form policy ' +
        '(e.g. `local_review: { mode: off }`, `blocked_paths: [.env, ...]`) silently ' +
        'no-ops on every shim fallback path. Restore Tier 1 (rea CLI dist) or Tier 2 ' +
        '(python3 + PyYAML) to close the gap.',
    };
  }
  return {
    label,
    status: 'fail',
    detail:
      'no policy-reader tier reachable — every shim policy lookup fails closed. ' +
      'Install at least one of: rea CLI dist (Tier 1), python3 + PyYAML (Tier 2), ' +
      'awk (Tier 3).',
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
 * 0.29.0 — verify the delegation-capture hook is registered in
 * `.claude/settings.json` under PreToolUse with matcher `Agent|Skill`
 * AND that the hook file exists at the expected dogfood path.
 *
 * Status posture:
 *
 * 0.29.0 shipped this check as `warn` (advisory) — the
 * `defaultDesiredHooks()` entry was new, and existing consumer
 * installs (plus this repo's own dogfood, locked from agent-driven
 * edits by `settings-protection.sh`) wouldn't have the matcher
 * registered until the operator ran `rea upgrade`. The comments
 * promised promotion to `fail` "in 0.30.0".
 *
 * **0.31.0 makes good on that promise.** The 0.29.0 → 0.30.x consumer
 * cycles have propagated; the `Agent|Skill` matcher has been in
 * `defaultDesiredHooks()` for multiple minors. A consumer install
 * that still lacks the registration is a real governance gap (the
 * delegation telemetry — and now the 0.31.0 nudge — silently does
 * nothing), so the check is `fail`. The detail message still names
 * the exact `rea upgrade` fix.
 *
 * Hook-file presence is verified separately by `checkHooksInstalled`
 * via `EXPECTED_HOOKS` — that path was always hard-`fail`.
 */
export function checkDelegationHookRegistered(baseDir: string): CheckResult {
  const label = 'delegation-capture hook registered';
  // 0.31.0 — promoted from `warn` to `fail` (see the docstring).
  const REFUSE = 'fail' as const;
  const settingsPath = path.join(baseDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return {
      label,
      status: REFUSE,
      detail: `missing: ${settingsPath} — run \`rea upgrade\` or \`rea init\``,
    };
  }
  let parsed: {
    hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  };
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as typeof parsed;
  } catch (e) {
    return {
      label,
      status: REFUSE,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  const groups = parsed.hooks?.PreToolUse ?? [];
  const group = groups.find((g) => g.matcher === 'Agent|Skill');
  if (group === undefined) {
    return {
      label,
      status: REFUSE,
      detail:
        'no PreToolUse group with matcher "Agent|Skill" found in .claude/settings.json — ' +
        'run `rea upgrade` to install. ' +
        'NOTE: matcher MUST be exactly `Agent|Skill` ' +
        '(NOT `Task|Skill` — `TaskCreate`/`TaskList` are unrelated todo-list tools).',
    };
  }
  const cmds = (group.hooks ?? []).map((h) => (typeof h.command === 'string' ? h.command : ''));
  if (!cmds.some((c) => c.includes('delegation-capture.sh'))) {
    return {
      label,
      status: REFUSE,
      detail:
        'Agent|Skill matcher exists but no delegation-capture.sh command found in its hooks list',
    };
  }
  return { label, status: 'pass' };
}

/**
 * 0.31.0 — verify the delegation-advisory hook is registered in
 * `.claude/settings.json` under PostToolUse with matcher
 * `Bash|Edit|Write|MultiEdit|NotebookEdit`, that a
 * `delegation-advisory.sh` command is present in that group, AND that
 * the `.claude/hooks/delegation-advisory.sh` file actually exists.
 *
 * Status posture: `warn` (advisory) for 0.31.0. This is a brand-new
 * `defaultDesiredHooks()` entry — the exact same upgrade-lag situation
 * `checkDelegationHookRegistered` faced in 0.29.0. Existing consumer
 * installs (and this repo's own dogfood, locked from agent-driven
 * edits by `settings-protection.sh`) won't have the PostToolUse group
 * until the operator runs `rea upgrade`. Holding at `warn` for one
 * release cycle keeps `rea doctor` green during propagation; a future
 * minor promotes it to `fail` once consumer installs have caught up —
 * the same ratchet `checkDelegationHookRegistered` just completed.
 *
 * The hook is ALSO advisory at runtime (it never blocks a tool call,
 * and `policy.delegation_advisory` defaults to disabled), so a missing
 * registration is a lower-stakes gap than a missing security gate —
 * `warn` is proportionate even setting the upgrade-lag aside.
 *
 * # Why this check verifies file presence AND executability (round-2/3 P2)
 *
 * `delegation-advisory.sh` is deliberately NOT in `EXPECTED_HOOKS` for
 * 0.31.0 (staged rollout — see the `EXPECTED_HOOKS` comment). That
 * leaves THIS function as the only 0.31.0 doctor signal covering the
 * new hook, so it must check the file too:
 *
 *   - File MISSING — a settings.json that references
 *     `delegation-advisory.sh` while the actual script is absent (a
 *     partial `rea upgrade`, manual drift) would otherwise report
 *     `pass`, and every matching PostToolUse dispatch would shell out
 *     to a nonexistent path.
 *   - File present but NOT EXECUTABLE — a script copied without its
 *     mode bits (a manual `cp`, an archive extracted without `+x`
 *     preservation) cannot be launched by Claude Code from
 *     `settings.json` at all. `checkHooksInstalled` performs this exact
 *     `0o111` check for every `EXPECTED_HOOKS` entry; because
 *     `delegation-advisory.sh` is held out of that list, the parity
 *     check has to live here.
 *
 * Both failures are held at the same `warn` tier as the registration
 * failures: consistent posture for 0.31.0, and they promote to `fail`
 * alongside them — at which point `delegation-advisory.sh` also joins
 * `EXPECTED_HOOKS` and gets the hard-`fail` `checkHooksInstalled`
 * coverage (presence + executability) the other hooks have.
 */
export function checkDelegationAdvisoryHookRegistered(baseDir: string): CheckResult {
  const label = 'delegation-advisory hook registered';
  // 0.36.0 — promoted from `warn` (advisory in 0.31.0) to `fail` (hard)
  // per the staged-rollout ratchet. After 4 releases of upgrade-lag
  // propagation (0.32, 0.33, 0.34, 0.35), consumer installs that have
  // run `rea upgrade` since 0.31.0 already carry the PostToolUse
  // `Bash|Edit|Write|MultiEdit|NotebookEdit` group. Any install that
  // still lacks it after that window is genuinely missing the nudge
  // and `fail` is the proportionate signal. Companion change:
  // `delegation-advisory.sh` joined `EXPECTED_HOOKS` in the same
  // commit, so `checkHooksInstalled` also covers the file-presence +
  // executability checks now (this function still does both directly
  // as defense-in-depth, mirroring `checkDelegationHookRegistered`).
  const REFUSE = 'fail' as const;
  const MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
  const settingsPath = path.join(baseDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return {
      label,
      status: REFUSE,
      detail: `missing: ${settingsPath} — run \`rea upgrade\` or \`rea init\``,
    };
  }
  let parsed: {
    hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  };
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as typeof parsed;
  } catch (e) {
    return {
      label,
      status: REFUSE,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  const groups = parsed.hooks?.PostToolUse ?? [];
  const group = groups.find((g) => g.matcher === MATCHER);
  if (group === undefined) {
    return {
      label,
      status: REFUSE,
      detail:
        `no PostToolUse group with matcher "${MATCHER}" found in .claude/settings.json — ` +
        'run `rea upgrade` to install. ' +
        'NOTE: the matcher INCLUDES Bash — the delegation nudge counts every write-class ' +
        'tool call, not just file edits.',
    };
  }
  const cmds = (group.hooks ?? []).map((h) => (typeof h.command === 'string' ? h.command : ''));
  if (!cmds.some((c) => c.includes('delegation-advisory.sh'))) {
    return {
      label,
      status: REFUSE,
      detail: `${MATCHER} matcher exists but no delegation-advisory.sh command found in its hooks list`,
    };
  }
  // 0.31.0 round-2/3 P2: the registration string is present — now
  // confirm the hook file it points at actually exists AND is
  // executable. Kept after the 0.36.0 EXPECTED_HOOKS promotion as
  // defense-in-depth (the same `0o111` check `checkHooksInstalled`
  // does, scoped to this hook so the failure message can name the
  // exact remediation rather than a generic "missing X" enumeration).
  const hookFile = path.join(baseDir, '.claude', 'hooks', 'delegation-advisory.sh');
  let hookStat: fs.Stats;
  try {
    hookStat = fs.statSync(hookFile);
  } catch {
    return {
      label,
      status: REFUSE,
      detail:
        `${MATCHER} matcher references delegation-advisory.sh but the hook file is missing: ` +
        `${hookFile} — run \`rea upgrade\` to lay it down. ` +
        'Without the file every matching PostToolUse dispatch shells out to a nonexistent path.',
    };
  }
  if ((hookStat.mode & 0o111) === 0) {
    return {
      label,
      status: REFUSE,
      detail:
        `${MATCHER} matcher references delegation-advisory.sh but the hook file is not executable ` +
        `(mode=${(hookStat.mode & 0o777).toString(8)}): ${hookFile} — ` +
        'run `rea upgrade` or `chmod +x` it. ' +
        'A non-executable hook cannot be launched by Claude Code from settings.json.',
    };
  }
  return { label, status: 'pass' };
}

/**
 * 0.29.0 — synthetic round-trip of the delegation-signal audit path.
 * 0.31.0 — drives the REAL `.claude/hooks/delegation-capture.sh` shell
 * hook, not just the `rea hook delegation-signal` CLI underneath it.
 *
 * Feeds a synthetic Claude Code PreToolUse hook payload to the shell
 * hook (the exact entry point Claude Code's `Agent|Skill` matcher
 * invokes in production) and asserts:
 *
 *   - The shell hook exited 0.
 *   - A new `rea.delegation_signal` record landed on disk — the smoke
 *     check POLLS for it, because `delegation-capture.sh` backgrounds
 *     + disowns the CLI (`& disown`) so the shell hook returns before
 *     the audit append completes.
 *   - The record's metadata contains the probe tag (so we don't
 *     mistakenly attribute an existing record to our run).
 *   - The recorded `invocation_description_sha256` matches the
 *     expected hash of the probe description.
 *   - Chain integrity holds (recomputed hash == stored hash).
 *
 * # Why drive the shell hook, not the CLI directly
 *
 * 0.29.0's version spawned `rea hook delegation-signal` directly. That
 * exercised the CLI's stdin parsing / hashing / redaction / process-
 * lifecycle — but NOT the shell shim's own logic: the 2-tier sandboxed
 * CLI resolution, the realpath sandbox check, the `& disown`
 * backgrounding. A regression in the shim (a botched resolution order,
 * a sandbox check that rejects the legitimate dogfood CLI, a
 * backgrounding bug that drops the signal) would pass 0.29.0's smoke
 * check while breaking production. 0.31.0 closes that gap: the smoke
 * check now invokes `bash .claude/hooks/delegation-capture.sh` and
 * the CLI is reached only through the shim.
 *
 * # Prerequisites and graceful degradation
 *
 * The check needs THREE things and degrades to `warn` (not `fail`)
 * when any is absent — a missing prerequisite is an environment gap,
 * not a wiring regression:
 *
 *   - `bash` on PATH.
 *   - `.claude/hooks/delegation-capture.sh` present (the consumer
 *     install path; absent before `rea init` / `rea upgrade`).
 *   - A sandboxed rea CLI the shim can resolve — either
 *     `<baseDir>/node_modules/@bookedsolid/rea/dist/cli/index.js` OR
 *     `<baseDir>/dist/cli/index.js` (the rea-repo dogfood). Without
 *     one the shim silently drops the signal by design, so the smoke
 *     check would time out waiting for a record that will never land.
 *
 * Gated behind `--smoke` so a casual `rea doctor` doesn't write probe
 * records on every invocation. Operators run `rea doctor --smoke`
 * after install / upgrade to confirm the pipeline is wired end-to-end.
 */
export async function checkDelegationRoundTrip(baseDir: string): Promise<CheckResult> {
  const label = 'delegation-signal round-trip';
  const probeTag = `doctor-smoke-${process.pid}-${Date.now()}`;

  // Prerequisite 1: the shell hook file. The consumer install path is
  // `.claude/hooks/delegation-capture.sh`; that is the exact file
  // Claude Code's matcher invokes. We do NOT fall back to the source
  // `hooks/` copy — the point of the smoke check is to validate the
  // INSTALLED artifact.
  const hookPath = path.join(baseDir, '.claude', 'hooks', 'delegation-capture.sh');
  if (!fs.existsSync(hookPath)) {
    return {
      label,
      status: 'warn',
      detail:
        `shell hook not installed at ${hookPath} — run \`rea init\` / \`rea upgrade\`. ` +
        'Smoke check needs the installed hook to drive the full chain.',
    };
  }

  // Prerequisite 2: bash on PATH.
  const { spawnSync } = await import('node:child_process');
  const bashProbe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bashProbe.status !== 0) {
    return {
      label,
      status: 'warn',
      detail: 'bash not available — cannot drive the delegation-capture.sh shell hook',
    };
  }

  // Prerequisite 3: a sandboxed rea CLI the shim can resolve. The
  // shim's 2-tier order is node_modules/@bookedsolid/rea/dist/... then
  // <proj>/dist/cli/index.js. If NEITHER exists the shim drops the
  // signal silently (by design) and the poll below would just time
  // out — surface the real reason instead.
  const consumerCli = path.join(
    baseDir,
    'node_modules',
    '@bookedsolid',
    'rea',
    'dist',
    'cli',
    'index.js',
  );
  const dogfoodCli = path.join(baseDir, 'dist', 'cli', 'index.js');
  if (!fs.existsSync(consumerCli) && !fs.existsSync(dogfoodCli)) {
    return {
      label,
      status: 'warn',
      detail:
        'no sandboxed rea CLI in scope (need node_modules/@bookedsolid/rea/dist/cli/index.js ' +
        'or <baseDir>/dist/cli/index.js) — the shell hook drops the signal silently here. ' +
        'Run `pnpm build` (dogfood) or `pnpm i` (consumer) first.',
    };
  }

  // Codex round 4 P3 (2026-05-12): exercise a NON-EMPTY description
  // so the smoke check actually validates SHA-256 hashing of prompt
  // content. Pre-fix the description was '' and the hash was always
  // the well-known empty-string SHA-256 — a regression that ignored
  // tool_input.description and substituted an empty hash would have
  // passed the smoke check.
  const probeDescription = `doctor-smoke probe (${probeTag})`;
  const expectedDescriptionHash = crypto
    .createHash('sha256')
    .update(probeDescription)
    .digest('hex');
  const payload = JSON.stringify({
    tool_name: 'Agent',
    session_id: 'doctor-smoke',
    tool_input: {
      subagent_type: probeTag,
      description: probeDescription,
    },
  });
  const auditPath = path.join(baseDir, '.rea', 'audit.jsonl');

  // Drive the REAL shell hook. `delegation-capture.sh` reads the
  // payload on stdin, resolves + sandbox-checks the rea CLI, then
  // backgrounds `rea hook delegation-signal --detach` with `& disown`.
  // The hook itself returns near-instantly; the audit append lands
  // asynchronously. CLAUDE_PROJECT_DIR is set so the shim resolves the
  // same baseDir doctor is checking.
  const res = spawnSync('bash', [hookPath], {
    cwd: baseDir,
    input: payload,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: baseDir },
  });
  if (res.error !== undefined) {
    return {
      label,
      status: 'fail',
      detail: `shell hook spawn failed: ${res.error.message}`,
    };
  }
  if (res.status !== 0) {
    return {
      label,
      status: 'fail',
      detail: `shell hook exited ${res.status ?? 'null'}; stderr: ${(res.stderr ?? '').slice(0, 240)}`,
    };
  }

  // The shell hook backgrounds the CLI — poll the audit log for our
  // probe record. Budget: 10s, checked every 150ms. The audit append
  // is local-filesystem work behind a lockfile; under normal
  // conditions it lands in well under a second.
  interface MatchedRecord {
    line: string;
    parsed: {
      tool_name?: string;
      metadata?: { subagent_type?: string; invocation_description_sha256?: string };
      hash?: string;
    };
  }
  /** Scan one audit-file's content for the probe record; null when absent. */
  const scanForProbe = (raw: string): MatchedRecord | null => {
    let found: MatchedRecord | null = null;
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      try {
        const p = JSON.parse(line) as MatchedRecord['parsed'];
        if (
          p.tool_name === DELEGATION_SIGNAL_TOOL_NAME &&
          p.metadata?.subagent_type === probeTag
        ) {
          found = { line, parsed: p };
        }
      } catch {
        // skip malformed
      }
    }
    return found;
  };
  let matched: MatchedRecord | null = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let raw: string | null = null;
    try {
      raw = await fsPromises.readFile(auditPath, 'utf8');
    } catch {
      // Audit file may not exist yet on a brand-new install — keep
      // polling; the first append creates it.
      raw = null;
    }
    if (raw !== null) {
      matched = scanForProbe(raw);
      if (matched !== null) break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (matched === null) {
    return {
      label,
      status: 'fail',
      detail:
        `shell hook exited 0 but no rea.delegation_signal record with probe-tag ` +
        `${probeTag} appeared in audit.jsonl within 10s — the shim resolved/sandboxed ` +
        `the CLI but the backgrounded append never landed (check shell-hook stderr: ` +
        `${(res.stderr ?? '').slice(0, 160)})`,
    };
  }
  // Codex round 4 P3 (2026-05-12): assert the recorded
  // invocation_description_sha256 matches the expected hash of the
  // probe description we sent. Catches a regression where the parser
  // ignores tool_input.description and substitutes the empty hash.
  const recordedDescHash = matched.parsed.metadata?.invocation_description_sha256;
  if (recordedDescHash !== expectedDescriptionHash) {
    return {
      label,
      status: 'fail',
      detail:
        `recorded invocation_description_sha256 mismatch: ` +
        `expected ${expectedDescriptionHash.slice(0, 16)}…, ` +
        `got ${(recordedDescHash ?? 'undefined').slice(0, 16)}…`,
    };
  }

  // Verify chain integrity for the probe record. Recompute its hash
  // over the record-minus-hash payload and compare.
  const recordParsed = JSON.parse(matched.line) as Record<string, unknown> & {
    hash?: string;
  };
  const storedHash = recordParsed.hash;
  if (typeof storedHash !== 'string' || storedHash.length !== 64) {
    return {
      label,
      status: 'fail',
      detail: 'probe record has no valid `hash` field',
    };
  }
  const { hash: _h, ...rest } = recordParsed;
  void _h;
  const recomputed = computeHash(rest as unknown as Parameters<typeof computeHash>[0]);
  if (recomputed !== storedHash) {
    return {
      label,
      status: 'fail',
      detail: `chain integrity broken: stored=${storedHash} recomputed=${recomputed}`,
    };
  }
  return {
    label,
    status: 'pass',
    detail: `probe via real .claude/hooks/delegation-capture.sh shell hook (hash=${storedHash.slice(
      0,
      16,
    )}, tag=${probeTag.slice(-8)})`,
  };
}

// ---------------------------------------------------------------------------
// 0.50.0 Phase 3b — global rea CLI resolution section.
//
// The opt-in GLOBAL CLI tier (Phase 1b/2b) resolves a per-user `rea` from
// `<passwd-home>/.rea/cli`, gated by a per-user trust registry
// (`<passwd-home>/.rea/trusted-projects`) and an optional in-project
// `runtime.allow_global_cli: false` veto. `rea doctor` surfaces which tier a
// checkout would actually run through — and refuses (exit 1) when the global
// root is present but unsafe.
//
// F1 SINGLE PREDICATE: this section consumes `global-cli.ts` (the TS mirror of
// the bash shim's resolver) and NEVER reimplements resolution. `resolveGlobalCliTier`
// is the one function; both the row renderer below AND the doctor↔shim parity
// test read from it, so `rea doctor` can never claim a tier the shim wouldn't.
// The reason codes map 1:1 onto the authoritative Phase-3b decision tree.
// ---------------------------------------------------------------------------

/**
 * The tier a checkout resolves to under the global-CLI feature, plus the
 * reason (which drives the doctor rows) and the resolved realpaths. Mirrors
 * `shim_run`'s tier resolution in `hooks/_lib/shim-runtime.sh` (steps 4 /
 * 4-global / 4-global-veto) exactly, so a parity test can bind the two.
 */
export interface GlobalCliTier {
  /** The tier the bash shim would resolve to for this checkout. */
  tier: 'in-project' | 'global';
  reason:
    | 'global-unavailable-platform' // no process.geteuid (Windows/Git Bash) — tier is POSIX-only
    | 'global-root-absent' // <home>/.rea/cli missing — feature unused
    | 'global-root-unsafe' // <home>/.rea failed the A5.3a safety gate — shim degrades to no-CLI
    | 'global-registry-unsafe' // <home>/.rea/trusted-projects failed the A5.3b gate
    | 'global-unresolvable' // root present but no dist/cli/index.js under it
    | 'in-project-wins' // an in-project CLI resolved — global present but unused
    | 'untrusted' // checkout not in the trust registry — shim fails closed to project
    | 'global-candidate-unsafe' // candidate present but fails the A1–A4 sandbox
    | 'global-cli-incapable' // candidate sandbox-clean but predates `hook policy-get`
    | 'policy-veto' // runtime.allow_global_cli: false — the repo refuses the tier
    | 'trusted'; // checkout trusted — the global CLI is the active tier
  /** realpath of the CLI the shim would actually run, or null when no CLI resolves. */
  cliRealpath: string | null;
  /** realpath of the global candidate (existence probe) when the root resolved one. */
  globalCliRealpath: string | null;
  /** Populated for `global-root-unsafe` (the .rea dir) or `global-registry-unsafe` (the registry file). */
  safety?: SafetyFail;
  /** Populated only for `global-candidate-unsafe`. */
  candidateSafety?: GlobalCandidateFail;
}

/** realpath a path, returning null on any failure (missing / ENOENT / loop). */
function realpathOrNull(p: string | null): string | null {
  if (p === null) return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Is the global tier vetoed by this repo's policy? Mirrors `shim_run`'s
 * step 4-global-veto, which shells `rea hook policy-get runtime.allow_global_cli`:
 *   - explicit `runtime.allow_global_cli: false`      → veto
 *   - `true` / no `runtime:` block / EMPTY output      → allow
 *   - a MISSING `.rea/policy.yaml`                      → allow (policy-get exits
 *     0 with empty output for an absent file — the tier is ALLOWED)
 *   - a PRESENT but malformed/unreadable policy         → veto (policy-get exits
 *     non-zero → the shim's fail-closed branch refuses the tier)
 *
 * The missing-vs-malformed distinction is load-bearing: turning file-absent into
 * a veto (the old behavior) misreported a trusted checkout with no policy.yaml as
 * `policy-veto` while the shim actually runs the global CLI.
 */
function globalTierVetoed(baseDir: string): boolean {
  const policyPath = reaPath(baseDir, POLICY_FILE);
  // Absent policy ⇒ allow (parity with `policy-get` exit 0 + empty output).
  if (!fs.existsSync(policyPath)) return false;
  try {
    return loadPolicy(baseDir).runtime?.allow_global_cli === false;
  } catch {
    // Present but malformed/unreadable ⇒ fail-closed veto (parity with the
    // shim's non-zero `policy-get` branch).
    return true;
  }
}

/**
 * THE single predicate (F1). Resolve which tier a checkout runs through and
 * why, consuming `global-cli.ts`. Follows the authoritative Phase-3b decision
 * tree top-to-bottom; each branch corresponds to a `shim_run` outcome so the
 * parity test can assert byte-agreement on `tier` + `cliRealpath`.
 *
 * `home` defaults to the passwd-derived home (env-immune by design); tests
 * inject a temp home to stay hermetic. `probeCapability` defaults to the shared
 * `probeGlobalCliCapability` (spawns the real CLI); tests inject a fake to stay
 * hermetic. NO CLI flag exposes either parameter.
 */
export function resolveGlobalCliTier(
  baseDir: string,
  home: string = passwdHome(),
  probeCapability: (cliPath: string) => { ok: boolean } = probeGlobalCliCapability,
): GlobalCliTier {
  const inProjectReal = realpathOrNull(resolveCliDistPath(baseDir));

  // In-project ALWAYS wins (shim step 4). The bash shim NEVER consults
  // <home>/.rea when an in-project @bookedsolid/rea resolves — so we MUST
  // short-circuit BEFORE any global-root safety / resolvability / candidate
  // check. Otherwise a repo that vendors rea locally, whose user also has a
  // stale or permission-damaged ~/.rea/cli, would get a FALSE [fail] from
  // `rea doctor` even though the hooks happily run the in-project CLI. A
  // broken or unused global tree must never produce a warn/fail here.
  if (inProjectReal !== null) {
    // Note the global root's mere existence (a benign [info]) but do NOT probe
    // or sandbox it — it is unused, and the shim would never touch it.
    const reason = fs.existsSync(globalRoot(home)) ? 'in-project-wins' : 'global-root-absent';
    return { tier: 'in-project', reason, cliRealpath: inProjectReal, globalCliRealpath: null };
  }

  // Platform guard (before ANY global work). The global tier is POSIX-ONLY (v1):
  // the bash `shim_global_entry_gate` calls `process.geteuid()`, which is
  // undefined on Windows / Git Bash, so it falls back to `unavailable` and the
  // tier NEVER resolves there. Mirror that gate EXACTLY (`geteuid` presence, not
  // `platform === 'win32'`) so doctor never claims a global tier the hooks can't
  // resolve. In-project resolution above is unaffected; this is NOT a fail —
  // the feature simply isn't available on this platform.
  if (typeof process.geteuid !== 'function') {
    return {
      tier: 'in-project',
      reason: 'global-unavailable-platform',
      cliRealpath: null,
      globalCliRealpath: null,
    };
  }

  // No in-project CLI — the global tier now governs.
  // Global root absent → feature unused; the (empty) in-project resolver governs.
  if (!fs.existsSync(globalRoot(home))) {
    return {
      tier: 'in-project',
      reason: 'global-root-absent',
      cliRealpath: null,
      globalCliRealpath: null,
    };
  }

  // <home>/.rea safety gate (shim A5.3a). Unsafe → shim degrades to no-CLI;
  // doctor hard-fails.
  const safety = checkReaDirSafety(home);
  if (!safety.ok) {
    return {
      tier: 'in-project',
      reason: 'global-root-unsafe',
      cliRealpath: null,
      globalCliRealpath: null,
      safety,
    };
  }

  // <home>/.rea/trusted-projects safety gate (shim A5.3b) — checked BEFORE
  // membership, exactly as the shim's entry gate does. A symlinked / hardlinked
  // / group-or-other-accessible (non-0600) registry makes the shim REFUSE the
  // global CLI entirely (silent no-CLI fallback); doctor must NOT then report
  // `trusted`/`global` — it would send the operator to the wrong remediation.
  // An ABSENT registry is safe here (`ok:true, absent:true`) — it just means
  // nothing is trusted yet, which the membership check below reports as
  // `untrusted`.
  const registrySafety = checkRegistrySafety(home);
  if (!registrySafety.ok) {
    return {
      tier: 'in-project',
      reason: 'global-registry-unsafe',
      cliRealpath: null,
      globalCliRealpath: null,
      safety: registrySafety,
    };
  }

  // Root present but no resolvable CLI under it (blessed-but-not-installed).
  const globalCli = resolveGlobalCli(home);
  if (globalCli === null) {
    return {
      tier: 'in-project',
      reason: 'global-unresolvable',
      cliRealpath: null,
      globalCliRealpath: null,
    };
  }
  const globalReal = realpathOrNull(globalCli);

  // The remaining branches mirror the shim's GLOBAL path when the in-project
  // resolver missed. The shim evaluates them in this order:
  //   entry gate (registry membership) -> A1–A4 candidate sandbox -> veto.
  // Reproduce that order so the tier verdict matches for every scenario.

  // Trust-registry membership (shim A5.5) keyed on realpath(cwd). An untrusted
  // checkout fails the entry gate BEFORE the candidate is ever sandboxed.
  const cwdReal = realpathOrNull(baseDir);
  if (cwdReal === null || !isProjectTrusted(cwdReal, home)) {
    return {
      tier: 'in-project',
      reason: 'untrusted',
      cliRealpath: null,
      globalCliRealpath: globalReal,
    };
  }

  // A1–A4 candidate sandbox (shim `shim_sandbox_check_global`). A
  // blessed-but-hostile tree (symlinked index.js, foreign owner, wrong pkg
  // name, …) makes the shim fall back to no-CLI — so doctor must NOT claim
  // global. Reported as a fail row (a hostile global tree is worth surfacing).
  const candSafety = checkGlobalCandidateSafety(globalCli, globalRoot(home), home);
  if (!candSafety.ok) {
    return {
      tier: 'in-project',
      reason: 'global-candidate-unsafe',
      cliRealpath: null,
      globalCliRealpath: globalReal,
      candidateSafety: candSafety,
    };
  }

  // Capability floor (shim step 4-global-veto read). The shim's veto step runs
  // `<global CLI> hook policy-get runtime.allow_global_cli`; a CLI that predates
  // that subcommand (older/manually-seeded ~/.rea/cli that still passes A1–A4)
  // exits non-zero → the shim FAIL-CLOSES to no-CLI. Doctor must NOT then claim
  // `global`. Probe `hook policy-get --help` on the sandbox-validated realpath;
  // a failing probe reports NOT-global so operators get the right remediation
  // (re-run `rea install --global`), not a false "global active".
  if (!probeCapability(candSafety.realpath).ok) {
    return {
      tier: 'in-project',
      reason: 'global-cli-incapable',
      cliRealpath: null,
      globalCliRealpath: globalReal,
    };
  }

  // Project veto over the global tier (shim step 4-global-veto), read only
  // AFTER the sandbox confirmed the candidate — exactly the shim's ordering.
  if (globalTierVetoed(baseDir)) {
    return {
      tier: 'in-project',
      reason: 'policy-veto',
      cliRealpath: null,
      globalCliRealpath: globalReal,
    };
  }

  // Trusted + sandbox-clean + not vetoed → the global CLI is the active tier.
  // Prefer the sandbox-validated realpath (identical to `globalReal` for a
  // non-symlinked tree, but it is the exact path the shim would execute).
  return {
    tier: 'global',
    reason: 'trusted',
    cliRealpath: candSafety.realpath,
    globalCliRealpath: globalReal,
  };
}

/**
 * Read the global CLI's declared version from the package.json that sits
 * beside whichever install shape `resolveGlobalCli` matched. Best-effort;
 * returns null when neither shape carries a readable version.
 */
function readGlobalCliVersion(home: string): string | null {
  const root = globalRoot(home);
  const candidates = [
    path.join(root, 'node_modules', '@bookedsolid', 'rea', 'package.json'),
    path.join(root, 'package.json'),
  ];
  for (const p of candidates) {
    const v = readPackageVersion(p);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Render the global rea CLI section as flat `CheckResult` rows. Off-by-default
 * quiet: when the global root does NOT exist, emits exactly ONE `info` row.
 * When it exists, walks the authoritative decision tree via
 * `resolveGlobalCliTier` and always names the RESOLVED REALPATH (helix-013.1
 * lesson). A `global-root-unsafe` / `global-unresolvable` verdict yields a
 * `fail` row so `rea doctor` exits 1.
 *
 * The registry named in these rows is the per-user GLOBAL-CLI TRUST REGISTRY
 * (`<home>/.rea/trusted-projects`), NOT `.rea/registry.yaml` (the MCP
 * fingerprint store).
 */
export function checkGlobalCli(
  baseDir: string,
  homeArg?: string,
  probeCapability: (cliPath: string) => { ok: boolean } = probeGlobalCliCapability,
): CheckResult[] {
  // P2-2: the passwd lookup throws on an arbitrary/unmapped UID (containers,
  // CI, `nobody`). The feature is off-by-default quiet — a passwd failure must
  // degrade to ONE info row, NEVER abort `rea doctor` before any row renders.
  let home: string;
  if (homeArg !== undefined) {
    home = homeArg;
  } else {
    try {
      home = passwdHome();
    } catch {
      return [
        {
          label: 'global rea CLI',
          status: 'info',
          detail: 'unavailable — could not resolve home directory from the password database',
        },
      ];
    }
  }

  const dir = globalReaDir(home);
  const reg = globalRegistryPath(home);
  const root = globalRoot(home);

  if (!fs.existsSync(root)) {
    return [
      {
        label: 'global rea CLI',
        status: 'info',
        detail: 'not installed — in-project resolution active; see `rea install --global`',
      },
    ];
  }

  const tier = resolveGlobalCliTier(baseDir, home, probeCapability);

  // POSIX-only tier on a platform without geteuid (Windows/Git Bash). A single
  // benign info row — never a fail/warn (the feature is simply unavailable, and
  // in-project resolution still governs).
  if (tier.reason === 'global-unavailable-platform') {
    return [
      {
        label: 'global rea CLI',
        status: 'info',
        detail: 'POSIX-only; not available on this platform',
      },
    ];
  }

  if (tier.reason === 'global-root-unsafe') {
    const s = tier.safety as SafetyFail;
    return [
      {
        label: 'global rea CLI root safety',
        status: 'fail',
        detail: `${s.reason} — fix: \`${s.remediation}\``,
      },
    ];
  }

  if (tier.reason === 'global-registry-unsafe') {
    const s = tier.safety as SafetyFail;
    return [
      {
        label: 'global-CLI trust registry safety',
        status: 'fail',
        detail: `${s.reason} — the shim refuses the global CLI while the trust registry is tampered; fix: \`${s.remediation}\``,
      },
    ];
  }

  if (tier.reason === 'global-unresolvable') {
    return [
      {
        label: 'global rea CLI',
        status: 'fail',
        detail: `${root} present but no resolvable CLI (expected dist/cli/index.js) — re-run \`rea install --global\``,
      },
    ];
  }

  if (tier.reason === 'global-candidate-unsafe') {
    const c = tier.candidateSafety as GlobalCandidateFail;
    return [
      {
        label: 'global rea CLI candidate safety',
        status: 'fail',
        detail: `blessed global CLI tree fails the sandbox (${c.code}): ${c.reason} — the shim refuses it; re-run \`rea install --global\` to reinstall a clean tree`,
      },
    ];
  }

  if (tier.reason === 'global-cli-incapable') {
    return [
      {
        label: 'global rea CLI capability',
        status: 'fail',
        detail: `resolved global CLI at ${tier.globalCliRealpath} does not implement \`rea hook policy-get\` (needs ~0.26.0+) — the shim falls back to no-CLI at the veto step; re-run \`rea install --global\` to reinstall a current CLI`,
      },
    ];
  }

  // In-project wins: an in-project CLI resolved, so the shim never consults the
  // global tree. Emit exactly ONE benign info row — NEVER a warn/fail for the
  // unused global tree (it may legitimately be broken/stale and it does not
  // matter here). We deliberately do NOT read the global version or sandbox it.
  if (tier.reason === 'in-project-wins') {
    return [
      {
        label: 'global rea CLI',
        status: 'info',
        detail: `present at ${root} but unused — this checkout resolves the in-project CLI (${tier.cliRealpath})`,
      },
    ];
  }

  const version = readGlobalCliVersion(home);
  const rows: CheckResult[] = [
    {
      label: 'global rea CLI installed',
      status: 'pass',
      detail: `${version !== null ? `v${version} ` : ''}at ${tier.globalCliRealpath}`,
    },
  ];

  switch (tier.reason) {
    case 'policy-veto':
      rows.push({
        label: 'global rea CLI active tier',
        status: 'info',
        detail:
          'policy.runtime.allow_global_cli: false — global tier vetoed by this repo; in-project required',
      });
      break;
    case 'trusted':
      rows.push({
        label: 'global rea CLI active tier',
        status: 'pass',
        detail: `global — this checkout is trusted (in the global-CLI trust registry ${reg}); hooks run ${tier.cliRealpath}`,
      });
      rows.push({
        label: 'global rea CLI residual risk',
        status: 'info',
        detail: `integrity relies on filesystem ownership of ${dir}; prefer in-project install for shared or CI checkouts`,
      });
      break;
    case 'untrusted':
      rows.push({
        label: 'global rea CLI active tier',
        status: 'warn',
        detail: `this checkout is NOT in the global-CLI trust registry ${reg} — hooks FAIL-CLOSED here until you trust it; run: rea trust`,
      });
      break;
  }
  return rows;
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
  options: { strict?: boolean; globalHome?: string } = {},
): CheckResult[] {
  const policyPath = reaPath(baseDir, POLICY_FILE);
  const registryPath = reaPath(baseDir, REGISTRY_FILE);
  const reaDirPath = path.join(baseDir, REA_DIR);

  // Run checkPolicyParses up-front so we can both push its result and
  // use the verdict to gate the 0.39.0 policy-reader tier checks below.
  // A malformed policy file should NOT trigger the tier-reachability
  // probes — those reports would misattribute a parse failure to a
  // runtime/install problem (codex round-3 P2, 2026-05-16).
  const policyParsesResult = checkPolicyParses(baseDir, policyPath);

  const checks: CheckResult[] = [
    checkFileExists('.rea/ directory exists', reaDirPath, true),
    policyParsesResult,
    checkRegistryParses(baseDir, registryPath),
    checkAgentsPresent(baseDir),
    checkHooksInstalled(baseDir),
    // 0.49.0 brick-state detector. Hook shims installed without a
    // self-pin in package.json is the exact scenario the bash-gate
    // bootstrap allowlist (paired fix) recovers from. Doctor surfaces
    // it as a hard FAIL so the operator runs `rea upgrade` (which
    // re-runs self-pin) before assuming the gates are broken.
    checkSelfPinDeclaredCheck(baseDir),
    checkSettingsJson(baseDir),
    // 0.30.0 Class M — strict zod schema check of the full
    // .claude/settings.json shape. Complements checkSettingsJson
    // (matcher coverage) and checkDelegationHookRegistered (Agent|Skill
    // wiring). Hard fail under `--strict`, warn by default.
    checkSettingsSchema(baseDir, options.strict === true),
    // 0.29.0 — delegation-telemetry MVP wiring check. Separate from
    // checkSettingsJson because that check only validates the
    // existence of the Bash + Write|Edit|MultiEdit|NotebookEdit
    // matcher groups. The Agent|Skill matcher is new and needs its
    // own pass/fail signal. 0.31.0 — promoted warn → fail.
    checkDelegationHookRegistered(baseDir),
    // 0.31.0 — delegation-telemetry completion. The PostToolUse
    // `Bash|Edit|Write|MultiEdit|NotebookEdit` matcher group drives
    // the delegation-advisory nudge hook. 0.36.0 — promoted warn →
    // fail (same upgrade-lag ratchet checkDelegationHookRegistered
    // went through in 0.29.0 → 0.30.0, after 4 release cycles of
    // propagation).
    checkDelegationAdvisoryHookRegistered(baseDir),
    // 0.39.0 — policy-reader tier visibility. Surfaces which tiers of
    // the 4-tier `hooks/_lib/policy-reader.sh` ladder are reachable in
    // this environment so operators can SEE whether flow-form policy
    // would silently no-op when the CLI is unreachable.
    //
    // Codex round-3 P2 (2026-05-16): gated on `policyParsesResult`
    // being a `pass` — NOT just `existsSync(policyPath)`. A
    // malformed policy file (present but unparseable) should report
    // exactly ONE failure — the parse-error from `checkPolicyParses`
    // above — and not also light up the tier probes with misleading
    // "Tier 1 dist exists but failed" or summary "ladder degraded"
    // diagnostics that misattribute a config bug to an
    // install/runtime problem. The parse-failure row already tells
    // the operator the right thing to fix; adding more downstream
    // noise would obscure it.
    ...(policyParsesResult.status === 'pass'
      ? [
          checkPolicyReaderTier1(baseDir),
          checkPolicyReaderTier2(baseDir),
          checkPolicyReaderTier3(baseDir),
          checkPolicyReaderJq(),
          checkPolicyReaderTierSummary(baseDir),
        ]
      : []),
  ];

  // Non-git escape hatch: when `.git/` is absent, both git-hook checks are
  // meaningless (commit-msg + pre-push can't be invoked without git). Emit
  // one informational line so `rea doctor` exits 0 in knowledge repos and
  // other non-source-code directories that consume rea governance.
  if (isGitRepo(baseDir)) {
    checks.push(checkCommitMsgHook(baseDir));
    // 0.30.0 attribution augmenter — only check when policy.attribution
    // is declared. Vanilla installs without the block see no check
    // (cleaner output for consumers who don't opt in).
    checks.push(checkPrepareCommitMsgHook(baseDir));
    if (prePushState !== undefined) {
      checks.push(checkPrePushHook(prePushState));
    }
    checks.push(checkExtensionFragments(baseDir));
  } else {
    checks.push({
      label: 'git hooks',
      status: 'info',
      detail: 'no `.git/` at baseDir — commit-msg / pre-push checks skipped (not a git repo)',
    });
  }

  if (codexRequiredFromPolicy(baseDir)) {
    checks.push(checkCodexAgent(baseDir), checkCodexCommand(baseDir), checkCodexBinaryOnPath());
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
      detail: 'disabled via policy.review.codex_required — skipping Codex-related checks',
    });
  }

  // 0.50.0 Phase 3b — global rea CLI resolution section. Off-by-default quiet:
  // one `info` row when the global root is absent (the common case). When the
  // root exists, the section names the active tier + resolved realpath and
  // hard-fails on an unsafe/unresolvable global root. `globalHome` is the
  // injectable passwd-home seam for hermetic tests; production passes nothing
  // and the check reads the env-immune passwd home.
  checks.push(...checkGlobalCli(baseDir, options.globalHome));

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
  /**
   * 0.29.0 — when true, run the synthetic delegation-signal round-trip
   * check. Writes a probe `rea.delegation_signal` audit record (with
   * the doctor-smoke session id) and verifies chain integrity. Gated
   * behind a flag so casual `rea doctor` invocations don't pollute the
   * audit log with probe records.
   */
  smoke?: boolean;
  /**
   * 0.30.0 — when true, every advisory check (settings.json schema
   * cross-check, prepare-commit-msg foreign-hook warn, etc.) is
   * promoted to hard fail. Used by CI gates that want a strict floor
   * on consumer installs. Default `false`.
   */
  strict?: boolean;
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
    if (entry.path === CLAUDE_MD_MANIFEST_PATH || entry.path === SETTINGS_MANIFEST_PATH) continue;
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
  console.log(`  ${clean} clean, ${report.rows.length - clean} with drift/issues.`);
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

  const checks = collectChecks(baseDir, probeState, prePushState, {
    strict: opts.strict === true,
  });
  // G7: async fingerprint-store check. Kept out of `collectChecks` so the
  // existing sync contract stays intact for downstream consumers; appended
  // here so runDoctor surfaces it inline.
  checks.push(await checkFingerprintStore(baseDir));

  // 0.29.0 — optional synthetic round-trip of the delegation-signal
  // audit path. Only runs under `--smoke` because it writes a probe
  // record to the audit chain; default `rea doctor` invocations leave
  // the chain untouched.
  if (opts.smoke === true) {
    checks.push(await checkDelegationRoundTrip(baseDir));
  }

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
  console.log(`  invocations/day:        ${summary.invocations_per_day.join(', ')}`);
  console.log(`  total estimated tokens: ${summary.total_estimated_tokens}`);
  console.log(`  rate-limited responses: ${summary.rate_limited_count}`);
  console.log(`  avg latency:            ${Math.round(summary.avg_latency_ms)} ms`);
}
