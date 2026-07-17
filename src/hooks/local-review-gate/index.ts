/**
 * Node-binary port of `hooks/local-review-gate.sh`.
 *
 * 0.34.0 Phase 2 port #2 (tier-2 medium-complexity hooks with enforcer
 * logic). This is the local-first guardrail — it refuses `git push`
 * (and optionally `git commit`) until `rea review` has been run and a
 * recent `rea.local_review` audit entry covers HEAD. CTO directive
 * 2026-05-05 enforcement.
 *
 * Behavioral contract — preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with the shared banner.
 *   2. Read stdin, extract `tool_input.command`. Non-Bash payload OR
 *      empty command → exit 0.
 *   3. Read `policy.review.local_review.mode`. `off` → exit 0
 *      immediately (silent no-op for codex-less teams). The mode
 *      short-circuit MUST happen before any further work.
 *   4. Read `policy.review.local_review.refuse_at` (default `push`).
 *      Translate into REFUSE_PUSH / REFUSE_COMMIT booleans.
 *   5. Sweep every segment whose head matches `git push` or `git commit`
 *      using BOTH `findAllSegmentsStartingWith` (stripped form) AND
 *      `findAllSegmentsRawMatches` (raw form with env-prefix shapes
 *      the stripper bails on). The raw fallback closes the helix-026
 *      round-25 P1-B laundering class.
 *   6. If no trigger segments → exit 0.
 *   7. Read the bypass env-var name from
 *      `policy.review.local_review.bypass_env_var` (default
 *      `REA_SKIP_LOCAL_REVIEW`). Check the process env first
 *      (operator-exported) — non-empty value covers ALL trigger
 *      segments uniformly. Otherwise inline-evaluate per-segment via
 *      `quoteMaskedCmd` + the segment-anchored bypass regex. EVERY
 *      trigger segment must independently authorize bypass for the
 *      gate to allow.
 *   8. If all trigger segments are bypassed → exit 0.
 *   9. Otherwise call `computePreflight({ strict: true })` in-process
 *      and use its exit code. On exit 0 → exit 0. On refuse → exit 2
 *      with the friendly "local-first review required" banner.
 *
 * Failure modes preserved:
 *   - Unknown `refuse_at` value → safest default (push).
 *   - Empty / unset bypass_env_var policy → default `REA_SKIP_LOCAL_REVIEW`.
 *   - Bypass var with shell metacharacters → skip inline detection
 *     (process-env path still works).
 *   - Empty bypass value (`VAR=""`) MUST NOT bypass.
 *   - Halted, mode-off, and short-circuit branches always WIN over
 *     CLI/sandbox concerns — same as 0.32.0 round-6 P2 fix for
 *     security-disclosure-gate (mode-off short-circuit before any CLI
 *     resolution).
 */

import type { Buffer } from 'node:buffer';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots } from '../../lib/worktree-roots.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import {
  findAllSegmentsStartingWith,
  findAllSegmentsRawMatches,
  quoteMaskedCmd,
  type CommandSegment,
} from '../_lib/segments.js';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { computePreflight } from '../../cli/preflight.js';

export interface LocalReviewGateOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
  /**
   * Test seam — override the env-var lookup for the bypass var. When
   * unset, the actual `process.env[BYPASS_VAR]` value is read. Useful
   * for tests so they don't have to mutate global env state.
   */
  envOverride?: Record<string, string | undefined>;
  /**
   * Test seam — override the preflight runner. When set, the gate
   * calls this instead of `computePreflight`. Production code never
   * sets this; tests use it to assert refuse-behavior without spawning
   * codex.
   */
  preflightImpl?: (reaRoot: string) => Promise<{ exitCode: 0 | 1 | 2; reason: string }>;
}

export interface LocalReviewGateResult {
  exitCode: number;
  stderr: string;
  /** Test seam — which trigger-detection branch fired (debug). */
  decision:
    | 'halt'
    | 'mode-off'
    | 'non-bash'
    | 'empty-cmd'
    | 'no-trigger'
    | 'bypass-process-env'
    | 'bypass-inline'
    | 'preflight-allow'
    | 'preflight-refuse'
    | 'malformed-payload';
}

interface LocalReviewPolicy {
  mode: 'enforced' | 'off';
  refuseAt: 'push' | 'commit' | 'both';
  bypassEnvVar: string;
}

const DEFAULT_BYPASS_VAR = 'REA_SKIP_LOCAL_REVIEW';

/**
 * Raw-form fallback regex matching `^(NAME=value...)+git push|commit` at
 * segment start. Accepts unquoted, double-quoted, single-quoted, and
 * ANSI-C-quoted (`$'…'`) value shapes. Mirrors
 * `_REA_RAW_INLINE_RE_PUSH` / `_REA_RAW_INLINE_RE_COMMIT` in the bash
 * counterpart.
 */
const RAW_INLINE_RE_PUSH =
  /^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\$'[^']*'|[^\s]+)\s+)+git\s+push(\s|$)/;
const RAW_INLINE_RE_COMMIT =
  /^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\$'[^']*'|[^\s]+)\s+)+git\s+commit(\s|$)/;

/**
 * Validates a bypass-var name as a POSIX identifier. Mirrors the bash
 * `_BYPASS_VAR_VALID=0` check.
 */
function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Resolve `policy.review.local_review.{mode, refuse_at, bypass_env_var}`.
 * Returns defaults when policy is missing / unparseable / fields unset.
 *
 * Reads the YAML file directly rather than going through the strict
 * `loadPolicy` validator — the bash counterpart only reads these three
 * fields and tolerates malformed surrounding policy (missing
 * `version`, `installed_by`, etc.). We mirror that posture so the
 * gate behaves identically across consumer installs that may have
 * partial / migrating policy files.
 */
function loadLocalReviewPolicy(reaRoot: string): LocalReviewPolicy {
  const defaults: LocalReviewPolicy = {
    mode: 'enforced',
    refuseAt: 'push',
    bypassEnvVar: DEFAULT_BYPASS_VAR,
  };
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  if (!fs.existsSync(policyPath)) return defaults;
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    return defaults;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaults;
  }
  const review = (parsed as Record<string, unknown>)['review'];
  if (review === null || typeof review !== 'object' || Array.isArray(review)) {
    return defaults;
  }
  const lr = (review as Record<string, unknown>)['local_review'];
  if (lr === null || typeof lr !== 'object' || Array.isArray(lr)) {
    return defaults;
  }
  const lrObj = lr as Record<string, unknown>;
  // mode: only `off` toggles silent no-op; anything else (including
  // missing, unknown values) defaults to enforced. Strict-mode
  // validation lives in `loadPolicy`; the gate is tolerant by design.
  const modeRaw = lrObj['mode'];
  const mode: 'enforced' | 'off' = modeRaw === 'off' ? 'off' : 'enforced';
  let refuseAt: 'push' | 'commit' | 'both' = 'push';
  const refuseRaw = lrObj['refuse_at'];
  if (refuseRaw === 'commit') refuseAt = 'commit';
  else if (refuseRaw === 'both') refuseAt = 'both';
  // bypass_env_var must be a POSIX identifier; junk falls back to default.
  const bypassRaw = lrObj['bypass_env_var'];
  const bypassEnvVar =
    typeof bypassRaw === 'string' && isValidEnvVarName(bypassRaw)
      ? bypassRaw
      : DEFAULT_BYPASS_VAR;
  return { mode, refuseAt, bypassEnvVar };
}

/**
 * Build the inline-bypass head regex for a given bypass var name. The
 * regex anchors at segment start (post-quote-mask) and accepts the
 * three documented bypass value shapes: unquoted, double-quoted,
 * single-quoted. The trailing `git` clause prevents quoted-mention
 * false positives in commit-message bodies.
 *
 * Round-27 F1 / Round-30 F1 sibling sweep: the segment-start anchor
 * additionally accepts zero-or-more LEADING env-var prefixes before
 * the bypass var, so POSIX-legal shapes like
 * `GIT_TRACE=1 REA_SKIP_LOCAL_REVIEW="reason" git push` are honored.
 *
 * Returns a fresh regex per call so callers don't trip over the `g`
 * flag's stateful `lastIndex`.
 */
function buildInlineBypassRegex(bypassVar: string): RegExp {
  // Same value-shape alternation as RAW_INLINE_RE_* (quoted/unquoted/
  // ANSI-C). The trailing `git` clause is preceded by zero-or-more
  // env-var assignments so `REA_SKIP="…" GIT_TRACE=1 git push` is OK.
  //
  // Shape parity with the bash `_INLINE_LEAD_PREFIX_RE` +
  // `_INLINE_TAIL_RE`: leading prefix accepts zero-or-more env-var
  // assignments BEFORE the bypass var. Tail requires at least one
  // whitespace between the bypass value and `git`, then optionally
  // more env-prefixes before `git` itself.
  //
  // 0.34.0 round-5 P2 fix: the bypass-var VALUE capture pre-fix
  // accepted only `"..."`, `'...'`, and bare tokens. ANSI-C shapes
  // like `REA_SKIP_LOCAL_REVIEW=$'urgent fix' git push` (which the
  // bash hook AND the raw trigger regex both accept) silently fell
  // through to "no bypass detected" → preflight refused valid
  // operator overrides. The fix adds `\\$'[^']*'` as the 4th
  // alternation and the capture index handling in evaluateInlineBypass
  // is updated accordingly.
  const leadPrefix =
    `^\\s*(?:[A-Za-z_][A-Za-z0-9_]*=` +
    `("[^"]*"|'[^']*'|\\$'[^']*'|[^\\s]+)\\s+)*`;
  const tail =
    `\\s+(?:[A-Za-z_][A-Za-z0-9_]*=` +
    `(?:[^\\s"']*|"[^"]*"|'[^']*'|\\$'[^']*')\\s+)*git(?:\\s|$)`;
  // Value-shape alternation captures the bypass value as group(s).
  // Order: double-quoted (m[2]), single-quoted (m[3]), ANSI-C (m[4]),
  // unquoted (m[5]). evaluateInlineBypass uses the first non-empty.
  const re = `${leadPrefix}${bypassVar}=` +
    `(?:"([^"]*)"|'([^']*)'|\\$'([^']*)'|([^\\s"']+))` +
    `${tail}`;
  return new RegExp(re);
}

/**
 * Evaluate the inline-bypass match for a single segment. Returns the
 * non-empty bypass value if present, or `null` when no inline bypass
 * was detected (segment must therefore be preflight-validated).
 *
 * Empty values (`VAR=""`) MUST NOT bypass — preserves the bash hook's
 * `[[ -n "$val" ]]` guard.
 */
function evaluateInlineBypass(
  segment: string,
  bypassVar: string,
): string | null {
  if (!isValidEnvVarName(bypassVar)) return null;
  if (segment.length === 0) return null;
  const masked = quoteMaskedCmd(segment);
  const re = buildInlineBypassRegex(bypassVar);
  const m = re.exec(masked);
  if (m === null) return null;
  // Value-capture groups (post-round-5-P2):
  //   m[1] — last lead-prefix env-var value (greedy * group)
  //   m[2] — double-quoted bypass value
  //   m[3] — single-quoted bypass value
  //   m[4] — ANSI-C-quoted bypass value (`$'...'`)
  //   m[5] — unquoted bypass value
  // The first non-empty wins.
  const candidate = m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
  return candidate.length > 0 ? candidate : null;
}

/**
 * Collect every trigger segment (deduplicated) across the stripped +
 * raw sweeps. Mirrors the bash `_rea_append_triggers` + de-dupe loop.
 */
function collectTriggerSegments(
  cmd: string,
  refusePush: boolean,
  refuseCommit: boolean,
): { segments: CommandSegment[]; opLabel: 'git push' | 'git commit' | '' } {
  const map = new Map<string, CommandSegment>();
  let opLabel: 'git push' | 'git commit' | '' = '';
  const addAll = (segs: CommandSegment[], op: 'git push' | 'git commit'): void => {
    for (const s of segs) {
      if (!map.has(s.raw)) {
        map.set(s.raw, s);
      }
    }
    if (segs.length > 0 && opLabel === '') {
      opLabel = op;
    }
  };
  if (refusePush) {
    addAll(findAllSegmentsStartingWith(cmd, 'git\\s+push(\\s|$)'), 'git push');
    addAll(
      findAllSegmentsRawMatches(cmd, RAW_INLINE_RE_PUSH.source),
      'git push',
    );
  }
  if (refuseCommit) {
    addAll(
      findAllSegmentsStartingWith(cmd, 'git\\s+commit(\\s|$)'),
      'git commit',
    );
    addAll(
      findAllSegmentsRawMatches(cmd, RAW_INLINE_RE_COMMIT.source),
      'git commit',
    );
  }
  return { segments: [...map.values()], opLabel };
}

function buildRefuseBanner(
  opLabel: string,
  exitCode: number,
  bypassVar: string,
  reason: string,
): string {
  const lines: string[] = [];
  lines.push(`BASH BLOCKED: ${opLabel} — local-first review required\n`);
  lines.push('\n');
  lines.push(
    `  rea preflight refused (exit ${exitCode}). The local-first guardrail (CTO directive\n`,
  );
  lines.push(
    '  2026-05-05) requires a recent codex review of the working tree before any\n',
  );
  lines.push('  push or commit.\n');
  if (reason.length > 0) {
    lines.push(`  Reason: ${reason}\n`);
  }
  lines.push('\n');
  lines.push('  To unblock, do ONE of:\n');
  lines.push('    1. Run `rea review` first — writes the canonical audit entry.\n');
  lines.push(
    `    2. Set ${bypassVar}="<reason>" — per-invocation override (audited).\n`,
  );
  lines.push('    3. Edit .rea/policy.yaml — set:\n');
  lines.push('         review:\n');
  lines.push('           local_review:\n');
  lines.push('             mode: off\n');
  lines.push('       (use this if your team does not have codex/claude installed)\n');
  return lines.join('');
}

/**
 * Pure executor. Returns `{ exitCode, stderr, decision }`.
 */
export async function runLocalReviewGate(
  options: LocalReviewGateOptions = {},
): Promise<LocalReviewGateResult> {
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };
  const envLookup = (name: string): string | undefined => {
    if (options.envOverride && name in options.envOverride) {
      return options.envOverride[name];
    }
    return process.env[name];
  };

  // 2. Read + parse stdin.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let toolName = '';
  let cmd = '';
  let payloadCwd = '';
  try {
    const payload = parseHookPayload(stdinRaw);
    payloadCwd = payload.cwd;
    toolName = payload.toolName;
    cmd = payload.command;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr(
        `local-review-gate: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr, decision: 'malformed-payload' };
    }
    throw err;
  }

  // Roots + HALT (0.54.0 worktree state): the payload's `cwd` feeds the
  // resolution ladder, so stdin is parsed FIRST — a deliberate reorder.
  // Policy/path checks key off the LOCAL (worktree) root; audit and the
  // kill switch key off the COMMON (repository) root.
  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(payloadCwd, options.reaRoot);
  // 1. HALT check — fail-closed.
  const halt = checkHaltRoots(reaRoot, commonRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, decision: 'halt' };
  }

  // 3. Read policy. mode=off → silent no-op BEFORE any other work
  //    (mirrors 0.32.0 round-6 P2 fix: short-circuit before CLI checks).
  const policy = loadLocalReviewPolicy(reaRoot);
  if (policy.mode === 'off') {
    return { exitCode: 0, stderr, decision: 'mode-off' };
  }

  // 4. Non-Bash → allow.
  if (toolName !== '' && toolName !== 'Bash') {
    return { exitCode: 0, stderr, decision: 'non-bash' };
  }
  if (cmd.length === 0) {
    return { exitCode: 0, stderr, decision: 'empty-cmd' };
  }

  // 5. Sweep trigger segments based on refuse_at.
  const refusePush =
    policy.refuseAt === 'push' || policy.refuseAt === 'both';
  const refuseCommit =
    policy.refuseAt === 'commit' || policy.refuseAt === 'both';
  const { segments, opLabel } = collectTriggerSegments(
    cmd,
    refusePush,
    refuseCommit,
  );

  if (segments.length === 0 || opLabel === '') {
    return { exitCode: 0, stderr, decision: 'no-trigger' };
  }

  // 6. Bypass — process env wins globally.
  const processEnvBypass = envLookup(policy.bypassEnvVar) ?? '';
  if (processEnvBypass.length > 0) {
    return { exitCode: 0, stderr, decision: 'bypass-process-env' };
  }

  // 7. Per-segment inline bypass — every trigger must independently
  //    authorize. Mirrors helix-026 round-25 P1-B fix.
  let allBypassed = true;
  for (const seg of segments) {
    const inline = evaluateInlineBypass(seg.raw, policy.bypassEnvVar);
    if (inline === null) {
      allBypassed = false;
      break;
    }
  }
  if (allBypassed) {
    return { exitCode: 0, stderr, decision: 'bypass-inline' };
  }

  // 8. Run preflight in-process.
  const preflightFn =
    options.preflightImpl ?? (async (root: string) => {
      // Round-10 P1b: pushes get the pristine-tree coverage fallback;
      // any commit trigger keeps the strict token-authoritative
      // semantics (mixed segments resolve to the stricter 'commit').
      const result = await computePreflight(root, {
        strict: true,
        operation: opLabel === 'git push' ? 'push' : 'commit',
      });
      return {
        exitCode: result.outcome.exitCode,
        reason: result.outcome.reason,
      };
    });
  let preflight: { exitCode: 0 | 1 | 2; reason: string };
  try {
    preflight = await preflightFn(reaRoot);
  } catch (err) {
    // Preflight throw is treated as refuse — same fail-closed posture as
    // the bash shim. Emit a generic refusal banner.
    writeStderr(
      buildRefuseBanner(
        opLabel,
        2,
        policy.bypassEnvVar,
        err instanceof Error ? err.message : String(err),
      ),
    );
    return { exitCode: 2, stderr, decision: 'preflight-refuse' };
  }

  if (preflight.exitCode === 0) {
    return { exitCode: 0, stderr, decision: 'preflight-allow' };
  }

  writeStderr(
    buildRefuseBanner(
      opLabel,
      preflight.exitCode,
      policy.bypassEnvVar,
      preflight.reason,
    ),
  );
  return { exitCode: 2, stderr, decision: 'preflight-refuse' };
}

/**
 * CLI entry point — `rea hook local-review-gate`.
 */
export async function runHookLocalReviewGate(
  options: LocalReviewGateOptions = {},
): Promise<void> {
  const result = await runLocalReviewGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}

// Internal exports for byte-fidelity tests.
export const __INTERNAL_FOR_TESTS = {
  buildInlineBypassRegex,
  evaluateInlineBypass,
  collectTriggerSegments,
  loadLocalReviewPolicy,
  RAW_INLINE_RE_PUSH,
  RAW_INLINE_RE_COMMIT,
};
