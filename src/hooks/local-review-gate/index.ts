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
 *
 * ## G3 (Artifact Gate) layering — the review gate's artifact-gates face
 *
 * This gate IS G3 (the review-gate) of the Artifact Gates trio (G1 spec,
 * G2 verification, G3 review). 0.54.0 gives it the same tri-state +
 * SHADOW tier G1/G2 carry, expressed through
 * `policy.artifact_gates.g3_review.mode` (`off | shadow | enforce`).
 *
 * ### Precedence (DOCUMENTED, load-bearing)
 *
 *   - `g3_review.mode` ABSENT  → behavior is EXACTLY the legacy
 *     `review.local_review.mode`-driven path (below). ZERO change for
 *     every existing repo — no audit is emitted, banners/decisions are
 *     byte-identical. This is the invariant the whole legacy test suite
 *     rests on.
 *   - `g3_review.mode` PRESENT → it is AUTHORITATIVE over
 *     `review.local_review.mode`. The tier (off/shadow/enforce) comes
 *     from g3_review; `refuse_at` and `bypass_env_var` STILL come from
 *     `review.local_review` (they are NOT duplicated under g3_review).
 *
 * ### One resolver, one emitter (three consistent paths)
 *
 * The effective mode is resolved by ONE shared function,
 * `resolveEffectiveReviewMode` (src/cli/preflight.ts), consumed by all
 * three review-gate paths: (a) `rea preflight` CLI, (b) the `.husky/pre-
 * push` hook (which runs `rea preflight --strict`), and (c) THIS Claude
 * Code Bash hook. There is no forked precedence rule.
 *
 * This gate applies ONLY the `off` short-circuit itself (a cheap silent
 * exit before trigger detection / git spawn). The shadow-vs-enforce
 * COVERAGE decision AND its `rea.gate.g3[.shadow]` audit emission are
 * owned SOLELY by `computePreflight`, which re-resolves the same effective
 * mode:
 *
 *   - `off`     → silent exit 0 (no-op) — handled here.
 *   - `shadow`  → preflight logs `rea.gate.g3.shadow` (would-block) and
 *     returns exit 0; the gate honors that and ALLOWS. NEVER refuses.
 *   - `enforce` → preflight refuses (exit 2), emitting `rea.gate.g3` when
 *     g3 is the active driver; the gate renders the Bash-tier banner.
 *
 * Because only preflight emits, the Bash-hook path and the husky/CLI path
 * never double-log and never diverge. The gate is mode-agnostic below the
 * `off` check: it simply honors preflight's exit code.
 *
 * ### Upgrade-path fix (legacy `local_review.mode: off` no longer neuters G3)
 *
 * `computePreflight` now resolves the SAME effective mode, so a repo on
 * `g3_review.mode: enforce` (or `shadow`) with a stale legacy
 * `review.local_review.mode: off` is governed by G3 — the legacy off-
 * switch does NOT short-circuit preflight to a clean pass. This is the
 * exact operator migration path (moving from the old knob to the new
 * tier) and is now handled in code, replacing the round-13 documentation
 * caveat.
 *
 * ### Overnight-safe + budget
 *
 * The gate acts ONLY at the push/commit boundary and NEVER prompts:
 * shadow logs, enforce refuses the Bash tool call. No interactive
 * question is ever introduced (spec §6). G3 inspects the ARTIFACT (the
 * verdict-coverage audit probe) and adds NO subprocess beyond the
 * coverage probe the legacy path already runs (spec §7.3).
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
import {
  computePreflight,
  resolveEffectiveReviewMode,
  G3_TOOL_NAME,
  G3_SHADOW_TOOL_NAME,
} from '../../cli/preflight.js';
import type { GateMode } from '../../policy/types.js';

/**
 * The G3 gate audit tool names are DEFINED in the coverage engine
 * (`src/cli/preflight.ts`), which is the SOLE emitter of `rea.gate.g3` /
 * `rea.gate.g3.shadow` records — the Bash hook here delegates the coverage
 * decision (and thus the emission) to `computePreflight`, so the husky
 * pre-push path and this path stay byte-consistent. Re-exported so
 * existing importers/tests of this module keep resolving them.
 */
export { G3_TOOL_NAME, G3_SHADOW_TOOL_NAME };

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
  /**
   * G3 tri-state from `artifact_gates.g3_review.mode`, plus two sentinels:
   *   - `undefined`   — the `g3_review` block is ABSENT; the LEGACY
   *     `review.local_review.mode` path applies unchanged (byte-identical
   *     pre-G3 invariant).
   *   - `'malformed'` — the block is PRESENT with an INVALID `mode`; the
   *     shared resolver maps this to `enforce`, matching how the strict
   *     `loadPolicy` (used by `computePreflight`) fails the whole policy
   *     to the enforced default (codex round-38 P2).
   */
  g3Mode: GateMode | 'malformed' | undefined;
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
    g3Mode: undefined,
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
  const root = parsed as Record<string, unknown>;
  // Extract the G3 tri-state FIRST from the same parse — a repo may carry
  // `artifact_gates.g3_review.mode` even when the `review.local_review`
  // block is absent, so it must survive the review-block early returns.
  const g3Mode = extractG3Mode(root);
  const review = root['review'];
  if (review === null || typeof review !== 'object' || Array.isArray(review)) {
    return { ...defaults, g3Mode };
  }
  const lr = (review as Record<string, unknown>)['local_review'];
  if (lr === null || typeof lr !== 'object' || Array.isArray(lr)) {
    return { ...defaults, g3Mode };
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
  return { mode, refuseAt, bypassEnvVar, g3Mode };
}

/**
 * Tolerant read of `artifact_gates.g3_review.mode` from the parsed policy
 * root. Precedence: the PRESENCE of a `g3_review` block signals G3 opt-in
 * and is authoritative. A valid tri-state value resolves to itself; a
 * present block with a missing/omitted `mode` resolves to `off` — mirroring
 * the strict schema, which `.default('off')`s the mode so `g3_review: {}`
 * validates as `off` (round-14 P2: returning `undefined` here would wrongly
 * fall back to legacy `review.local_review` enforcement instead of the
 * `off` the validated policy promises). Only when the block is ABSENT (no
 * `artifact_gates`, or no `g3_review`) do we return `undefined` and route
 * back to the legacy path — the byte-identical pre-G3 invariant.
 *
 * A present block with a MISSING `mode` key → `off` (the strict schema
 * `.default('off')`s it, so `g3_review: {}` validates as off). But a present
 * `mode` with a MALFORMED value (typo, wrong type) → `'malformed'`, NOT `off`
 * and NOT `undefined` (codex round-38 P2, superseding round-26). The strict
 * `loadPolicy` REJECTS such a value and fails the ENTIRE policy, so
 * `computePreflight` sees `policy === undefined` and resolves to the enforced
 * DEFAULT — NOT to the legacy `local_review.mode` (which was lost with the
 * rejected policy). The shared resolver maps `'malformed' → enforce` to match.
 *
 * ## PRESENT-but-wrong-type OUTER blocks (codex round-41 P2)
 *
 * The round-38 fix only caught a bad `mode` FIELD. A wrong-TYPE OUTER block —
 * `artifact_gates` or `g3_review` given as a string/number/array/null — must
 * ALSO signal `'malformed'`, for the same reason: the strict `loadPolicy`
 * REJECTS such a policy (the block must be a plain object) and enforces, so a
 * gate that returned `undefined` (→ legacy) would let `local_review.mode: off`
 * short-circuit-ALLOW while preflight ENFORCES — the exact commit/push
 * divergence, reintroduced through the outer blocks. So we distinguish:
 *   - key ABSENT (`!('artifact_gates' in root)` / `!('g3_review' in ag)`) →
 *     `undefined` (legacy) — the byte-identical pre-G3 invariant;
 *   - key PRESENT but NOT a plain object → `'malformed'` (→ enforce).
 *
 * Returning `undefined` (legacy) for a malformed block was the bug: with
 * legacy `local_review.mode: off` the gate short-circuited to `off` and
 * ALLOWED while preflight/pre-push strict-failed to enforced and REFUSED.
 * Signalling `'malformed'` makes the gate DELEGATE to `computePreflight`
 * (which refuses), keeping all paths consistent on a malformed policy
 * regardless of the legacy mode.
 */
function extractG3Mode(root: Record<string, unknown>): GateMode | 'malformed' | undefined {
  // artifact_gates ABSENT → legacy path (byte-identical pre-G3 invariant).
  if (!('artifact_gates' in root)) return undefined;
  const ag = root['artifact_gates'];
  // PRESENT but not a plain object → strict loadPolicy rejects → enforce.
  if (ag === null || typeof ag !== 'object' || Array.isArray(ag)) return 'malformed';
  const agObj = ag as Record<string, unknown>;
  // g3_review ABSENT → legacy (this artifact_gates block configures other
  // gates but not the review gate; fall back to review.local_review).
  if (!('g3_review' in agObj)) return undefined;
  const g3 = agObj['g3_review'];
  // PRESENT but not a plain object → malformed (same rejection posture).
  if (g3 === null || typeof g3 !== 'object' || Array.isArray(g3)) return 'malformed';
  const g3obj = g3 as Record<string, unknown>;
  const m = g3obj['mode'];
  if (m === 'off' || m === 'shadow' || m === 'enforce') return m;
  // Mode key entirely absent (`g3_review: {}`) → schema default `off`.
  if (!Object.prototype.hasOwnProperty.call(g3obj, 'mode')) return 'off';
  // Mode present but malformed → strict schema rejects the whole policy →
  // preflight resolves to the enforced default. Signal `'malformed'` so the
  // shared resolver converges on `enforce` and the gate delegates rather than
  // short-circuiting to `off`.
  return 'malformed';
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
    // Round-15 P2: a MIXED trigger set (`git commit … && git push`)
    // resolves to COMMIT semantics — the stricter gate. `git commit`
    // therefore wins over an already-recorded `git push`; push only
    // sticks when no commit trigger exists in the invocation.
    if (segs.length > 0 && (opLabel === '' || op === 'git commit')) {
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

  // 3. Read policy + resolve the EFFECTIVE tier (G3 precedence) via the
  //    SHARED resolver in src/cli/preflight.ts — the SAME function
  //    `rea preflight` (husky pre-push + coverage engine) uses, so all
  //    three review-gate paths agree on the tier. When
  //    `artifact_gates.g3_review.mode` is present it is AUTHORITATIVE over
  //    `review.local_review.mode`; otherwise the legacy mode drives.
  //    `refuse_at` / `bypass_env_var` always come from `review.local_review`.
  //
  //    The gate applies ONLY the `off` short-circuit here. The
  //    shadow-vs-enforce COVERAGE decision (and its `rea.gate.g3[.shadow]`
  //    audit emission) is owned by `computePreflight`, which re-resolves
  //    the same effective mode — so a legacy `local_review.mode: off` can
  //    NEVER neuter an active `g3_review.mode` (the round-13 caveat is now
  //    handled, not documented): under shadow/enforce the effective mode
  //    is NOT `off`, the gate proceeds, and preflight governs coverage.
  const policy = loadLocalReviewPolicy(reaRoot);
  const effectiveMode: GateMode = resolveEffectiveReviewMode(policy.g3Mode, policy.mode);
  // mode=off → silent no-op BEFORE any other work (mirrors 0.32.0 round-6
  // P2 fix: short-circuit before CLI checks). Covers BOTH `g3_review.mode:
  // off` and legacy `local_review.mode: off`; HALT above still wins.
  if (effectiveMode === 'off') {
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

  // 8. Delegate the coverage decision to `computePreflight` — the SINGLE
  //    coverage engine. It re-resolves the SAME effective mode (shared
  //    resolver) and owns the tri-state coverage outcome AND its
  //    `rea.gate.g3[.shadow]` audit emission:
  //      - `off`     → clean (already short-circuited above).
  //      - `shadow`  → logs `rea.gate.g3.shadow`, returns exit 0 (allow).
  //      - `enforce` → refuses (exit 2), emits `rea.gate.g3` when g3-active.
  //    The gate therefore just honors the exit code: 0 → allow (fresh
  //    verdict OR a shadow would-block that preflight logged-not-refused);
  //    non-zero → refuse with the friendly Bash-tier banner. Emitting the
  //    audit ONLY in preflight guarantees the husky/CLI path and this Bash
  //    path never double-log and never diverge.
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
    // Probe throw is fail-closed at the Bash tier (matches the bash shim).
    // computePreflight resolves shadow to a clean exit 0 internally, so a
    // throw here is a genuine unexpected fault, not a shadow would-block.
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
    buildRefuseBanner(opLabel, preflight.exitCode, policy.bypassEnvVar, preflight.reason),
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
