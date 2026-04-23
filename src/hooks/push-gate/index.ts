/**
 * Push-gate composition — the pure orchestrator that `rea hook push-gate`
 * calls.
 *
 * Contract: `runPushGate(deps)` returns a `GateResult` with an `exitCode`
 * the CLI wrapper hands back to `git`. Exit codes:
 *
 *   - `0` push proceeds (pass, disabled, skipped, empty-diff)
 *   - `1` HALT kill-switch active — rea unfreeze required
 *   - `2` blocked — blocking verdict, timeout, or protocol error
 *
 * The happy path is a single call: resolve policy → resolve base → spawn
 * codex exec review → parse findings → write last-review.json → emit audit
 * record → return exit code. No cache lookups, no SHA matching, no
 * attestation gymnastics. Every push runs codex afresh; Codex is the
 * source of truth.
 *
 * The function is pure-compositional: every external dependency (git,
 * codex, halt, policy) is injected via `PushGateDeps`, which is the
 * affordance tests use to replace subprocess calls with deterministic
 * fakes. `runPushGate` never reaches for `process.env` or `process.cwd`
 * directly — `deps.env` and `deps.baseDir` are the only ambient state.
 */

import path from 'node:path';
import { appendAuditRecord } from '../../audit/append.js';
import { Tier, InvocationStatus } from '../../policy/types.js';
import {
  resolvePushGatePolicy,
  type ResolvedReviewPolicy,
} from './policy.js';
import { readHalt, type HaltState } from './halt.js';
import { resolveBaseRef, type BaseResolution } from './base.js';
import {
  createRealGitExecutor,
  runCodexReview,
  CodexNotInstalledError,
  CodexProtocolError,
  CodexSubprocessError,
  CodexTimeoutError,
  type CodexRunError,
  type GitExecutor,
} from './codex-runner.js';
import { summarizeReview, type Verdict } from './findings.js';
import { renderBanner, writeLastReview, type LastReviewPayload } from './report.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GateStatus =
  | 'pass'
  | 'concerns'
  | 'blocking'
  | 'halted'
  | 'disabled'
  | 'skipped'
  | 'empty-diff'
  | 'error';

export interface GateResult {
  status: GateStatus;
  exitCode: 0 | 1 | 2;
  /** Human-readable summary suitable for the audit record `metadata.summary`. */
  summary: string;
  /** Non-empty only for 'pass' | 'concerns' | 'blocking'. */
  verdict?: Verdict;
  findingCount?: number;
  baseRef?: string;
  headSha?: string;
}

export interface PushGateDeps {
  baseDir: string;
  env: NodeJS.ProcessEnv;
  stderr: (line: string) => void;
  /** Override via `--base <ref>`. Absent → auto-resolve. */
  explicitBase?: string;
  /** Test seams; production wires these to the real implementations. */
  git?: GitExecutor;
  resolvePolicy?: (baseDir: string) => Promise<ResolvedReviewPolicy>;
  readHalt?: (baseDir: string) => HaltState;
  runCodex?: typeof runCodexReview;
  writeLastReview?: typeof writeLastReview;
  appendAudit?: typeof appendAuditRecord;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Audit event names (advisory — no gate ever reads these back)
// ---------------------------------------------------------------------------

const AUDIT_SERVER_NAME = 'rea';
const EVT_REVIEWED = 'rea.push_gate.reviewed';
const EVT_HALTED = 'rea.push_gate.halted';
const EVT_DISABLED = 'rea.push_gate.disabled';
const EVT_SKIPPED = 'rea.push_gate.skipped';
const EVT_EMPTY = 'rea.push_gate.empty_diff';
const EVT_ERROR = 'rea.push_gate.error';

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export async function runPushGate(deps: PushGateDeps): Promise<GateResult> {
  const stderr = deps.stderr;
  const env = deps.env;
  const readHaltFn = deps.readHalt ?? readHalt;
  const resolvePolicyFn = deps.resolvePolicy ?? resolvePushGatePolicy;
  const writeLastReviewFn = deps.writeLastReview ?? writeLastReview;
  const runCodexFn = deps.runCodex ?? runCodexReview;
  const appendAuditFn = deps.appendAudit ?? appendAuditRecord;
  const git: GitExecutor = deps.git ?? createRealGitExecutor(deps.baseDir);

  // 1. HALT wins over everything, including `review.codex_required: false`.
  //    Reading it before policy also means a corrupted policy.yaml doesn't
  //    prevent the kill-switch from firing.
  const halt = readHaltFn(deps.baseDir);
  if (halt.halted) {
    stderr(`REA HALT: ${halt.reason ?? 'unknown'}\nAll push operations suspended. Run: rea unfreeze\n`);
    await safeAppend(appendAuditFn, deps.baseDir, EVT_HALTED, {
      reason: halt.reason ?? 'unknown',
    });
    return {
      status: 'halted',
      exitCode: 1,
      summary: `HALT active: ${halt.reason ?? 'unknown'}`,
    };
  }

  // 2. Load policy. A malformed policy.yaml surfaces as a thrown zod error;
  //    we catch it, audit, and exit 2 rather than silently bypass.
  let policy: ResolvedReviewPolicy;
  try {
    policy = await resolvePolicyFn(deps.baseDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stderr(`PUSH BLOCKED: failed to load .rea/policy.yaml — ${msg}\n`);
    await safeAppend(appendAuditFn, deps.baseDir, EVT_ERROR, {
      kind: 'policy-load',
      error: msg,
    });
    return { status: 'error', exitCode: 2, summary: `policy-load error: ${msg}` };
  }

  if (!policy.codex_required) {
    await safeAppend(appendAuditFn, deps.baseDir, EVT_DISABLED, {
      policy_missing: policy.policyMissing,
    });
    return {
      status: 'disabled',
      exitCode: 0,
      summary: 'review.codex_required is false — push-gate skipped',
    };
  }

  // 3. REA_SKIP_PUSH_GATE — value-carrying waiver. HALT-wins ordering means
  //    this is checked AFTER halt (step 1) and AFTER codex_required=false
  //    short-circuit (step 2). Both of those should hold anyway; this is
  //    for the case where codex is required but the operator wants to
  //    skip for a narrow, documented reason.
  const skipReason = (env.REA_SKIP_PUSH_GATE ?? '').trim();
  if (skipReason.length > 0) {
    stderr(`rea: REA_SKIP_PUSH_GATE=${skipReason} — push-gate skipped (audited).\n`);
    await safeAppend(appendAuditFn, deps.baseDir, EVT_SKIPPED, {
      reason: skipReason,
    });
    return {
      status: 'skipped',
      exitCode: 0,
      summary: `REA_SKIP_PUSH_GATE waiver: ${skipReason}`,
    };
  }

  // 4. Resolve the base ref. `explicitBase` (from `--base <ref>`) wins; else
  //    we walk the upstream → origin/HEAD → main/master ladder.
  const base: BaseResolution = resolveBaseRef(git, {
    ...(deps.explicitBase !== undefined && deps.explicitBase.length > 0
      ? { explicit: deps.explicitBase }
      : {}),
  });
  const headSha = git.headSha();
  if (headSha.length === 0) {
    stderr('PUSH BLOCKED: could not resolve HEAD SHA. Is this a valid git repo?\n');
    await safeAppend(appendAuditFn, deps.baseDir, EVT_ERROR, { kind: 'head-sha-missing' });
    return { status: 'error', exitCode: 2, summary: 'head-sha-missing' };
  }

  // 5. Empty-diff short-circuit. An initial push against the empty-tree
  //    sentinel ALWAYS has a non-empty diff (HEAD vs empty tree); this
  //    short-circuit only fires when the feature branch really is a
  //    no-op relative to base.
  const diff = git.diffNames(base.ref, headSha);
  if (diff.length === 0) {
    await safeAppend(appendAuditFn, deps.baseDir, EVT_EMPTY, {
      base_ref: base.ref,
      base_source: base.source,
      head_sha: headSha,
    });
    return {
      status: 'empty-diff',
      exitCode: 0,
      summary: 'empty diff — nothing to review',
      baseRef: base.ref,
      headSha,
    };
  }

  // 6. Run Codex. Typed errors translate to exit 2 with distinct stderr.
  try {
    const codexResult = await runCodexFn({
      baseRef: base.ref,
      cwd: deps.baseDir,
      timeoutMs: policy.timeout_ms,
      env,
    });
    const summary = summarizeReview(codexResult.reviewText);
    const blocked = summary.verdict === 'blocking'
      || (summary.verdict === 'concerns'
        && policy.concerns_blocks
        && !isConcernsOverrideSet(env));

    const lastReviewPath = path.join(deps.baseDir, '.rea', 'last-review.json');
    const payload: LastReviewPayload = writeLastReviewFn({
      baseDir: deps.baseDir,
      summary,
      baseRef: base.ref,
      headSha,
      eventCount: codexResult.eventCount,
      durationSeconds: codexResult.durationSeconds,
      ...(deps.now !== undefined ? { now: deps.now() } : {}),
    });

    stderr(
      renderBanner({
        payload,
        baseSource: base.source,
        blocked,
        lastReviewPath,
      }),
    );

    await safeAppend(appendAuditFn, deps.baseDir, EVT_REVIEWED, {
      verdict: summary.verdict,
      finding_count: summary.findings.length,
      base_ref: base.ref,
      base_source: base.source,
      head_sha: headSha,
      blocked,
      duration_seconds: codexResult.durationSeconds,
      event_count: codexResult.eventCount,
      concerns_override:
        summary.verdict === 'concerns' && isConcernsOverrideSet(env) ? true : undefined,
    });

    if (blocked) {
      return {
        status: summary.verdict === 'blocking' ? 'blocking' : 'concerns',
        exitCode: 2,
        summary: `${summary.verdict}: ${summary.findings.length} finding(s)`,
        verdict: summary.verdict,
        findingCount: summary.findings.length,
        baseRef: base.ref,
        headSha,
      };
    }
    return {
      status: summary.verdict === 'blocking'
        ? 'blocking'
        : summary.verdict === 'concerns'
          ? 'concerns'
          : 'pass',
      exitCode: 0,
      summary: `${summary.verdict}: ${summary.findings.length} finding(s)`,
      verdict: summary.verdict,
      findingCount: summary.findings.length,
      baseRef: base.ref,
      headSha,
    };
  } catch (e) {
    return handleCodexError(e, deps, base, headSha, appendAuditFn);
  }
}

function isConcernsOverrideSet(env: NodeJS.ProcessEnv): boolean {
  const raw = env.REA_ALLOW_CONCERNS;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

async function handleCodexError(
  e: unknown,
  deps: PushGateDeps,
  base: BaseResolution,
  headSha: string,
  appendAuditFn: typeof appendAuditRecord,
): Promise<GateResult> {
  const stderr = deps.stderr;
  const runError = classifyCodexError(e);
  const metadata: Record<string, unknown> = {
    base_ref: base.ref,
    base_source: base.source,
    head_sha: headSha,
    kind: runError.kind,
  };
  if (runError.message.length > 0) metadata.error = runError.message;

  stderr(`PUSH BLOCKED: ${runError.message}\n`);
  await safeAppend(appendAuditFn, deps.baseDir, EVT_ERROR, metadata);
  return {
    status: 'error',
    exitCode: 2,
    summary: `codex error (${runError.kind}): ${runError.message}`,
    baseRef: base.ref,
    headSha,
  };
}

function classifyCodexError(
  e: unknown,
): { kind: CodexRunError['kind'] | 'unknown'; message: string } {
  if (e instanceof CodexNotInstalledError) return { kind: 'not-installed', message: e.message };
  if (e instanceof CodexTimeoutError) return { kind: 'timeout', message: e.message };
  if (e instanceof CodexProtocolError) return { kind: 'protocol', message: e.message };
  if (e instanceof CodexSubprocessError) return { kind: 'subprocess', message: e.message };
  if (e instanceof Error) return { kind: 'unknown', message: e.message };
  return { kind: 'unknown', message: String(e) };
}

/**
 * Audit-record helper. Never throws — audit failures are themselves audited
 * (best-effort warn to stderr) but must not prevent the gate from returning
 * its primary result. The hash chain remains intact if this succeeds; on
 * failure we've already made the gate decision based on the actual review.
 */
async function safeAppend(
  appendFn: typeof appendAuditRecord,
  baseDir: string,
  toolName: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    // Prune undefined values — the audit record schema's `metadata` is an
    // arbitrary map, but `undefined` values cause JSON.stringify to emit
    // missing keys which breaks round-trips on some readers.
    const cleanMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (v !== undefined) cleanMeta[k] = v;
    }
    await appendFn(baseDir, {
      tool_name: toolName,
      server_name: AUDIT_SERVER_NAME,
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      ...(Object.keys(cleanMeta).length > 0 ? { metadata: cleanMeta } : {}),
    });
  } catch (e) {
    // Audit persistence failure should never cascade into a push block when
    // the gate itself decided to pass — but we do want operator visibility.
    const msg = e instanceof Error ? e.message : String(e);
    // Use the deps.stderr is unavailable here (different stack frame); write
    // directly to process.stderr as a fallback.
    process.stderr.write(`rea: audit append failed (${toolName}): ${msg}\n`);
  }
}

// Re-exports for the CLI wrapper so it can construct dependency defaults.
export { resolvePushGatePolicy } from './policy.js';
export { readHalt } from './halt.js';
export { resolveBaseRef } from './base.js';
export { runCodexReview, createRealGitExecutor } from './codex-runner.js';
export { summarizeReview, parseFindings, inferVerdict } from './findings.js';
export { writeLastReview, renderBanner } from './report.js';
