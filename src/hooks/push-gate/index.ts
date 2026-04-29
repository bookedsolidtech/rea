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
  PUSH_GATE_DEFAULT_LAST_N_COMMITS_FALLBACK,
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

/**
 * A single refspec the pre-push stdin contract yields. Git passes one line
 * per refspec being pushed: `<local_ref> <local_sha> <remote_ref> <remote_sha>`.
 * See githooks(5) — Hook "pre-push".
 */
export interface PrePushRefspec {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/**
 * Parse the raw pre-push stdin text into refspecs. Each line is four
 * whitespace-separated fields. Blank lines and malformed lines are
 * silently dropped — the empty result then falls through to the
 * upstream-resolver path in `runPushGate`.
 */
export function parsePrePushStdin(raw: string): PrePushRefspec[] {
  const out: PrePushRefspec[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if (
      typeof localRef !== 'string' ||
      typeof localSha !== 'string' ||
      typeof remoteRef !== 'string' ||
      typeof remoteSha !== 'string'
    ) {
      continue;
    }
    out.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return out;
}

export interface PushGateDeps {
  baseDir: string;
  env: NodeJS.ProcessEnv;
  stderr: (line: string) => void;
  /** Override via `--base <ref>`. Absent → auto-resolve. */
  explicitBase?: string;
  /**
   * Override from the `--last-n-commits N` CLI flag. When set, the gate
   * diffs against `HEAD~N` instead of running the upstream ladder. Wins
   * over `policy.review.last_n_commits` but loses to `explicitBase`. When
   * both `explicitBase` and this are set, `explicitBase` is used and a
   * stderr warning is emitted noting the conflict.
   */
  lastNCommits?: number;
  /**
   * Pre-push refspecs from git's stdin. Empty when invoked outside a
   * pre-push context (manual `rea hook push-gate` from the CLI). When
   * non-empty, the gate diffs each refspec's (remote_sha..local_sha) and
   * reviews against the actual push target — matters when the operator
   * does `git push origin HEAD:release/1.0` and the tracking branch is
   * a different branch entirely.
   */
  refspecs?: PrePushRefspec[];
  /** Test seams; production wires these to the real implementations. */
  git?: GitExecutor;
  resolvePolicy?: (baseDir: string) => Promise<ResolvedReviewPolicy>;
  readHalt?: (baseDir: string) => HaltState;
  runCodex?: typeof runCodexReview;
  writeLastReview?: typeof writeLastReview;
  appendAudit?: typeof appendAuditRecord;
  now?: () => Date;
}

/**
 * Well-known "null SHA" in git's wire format. Pre-push sends this as
 * `remote_sha` for a fresh remote ref (the branch doesn't exist yet on
 * the remote) and as `local_sha` for a branch deletion.
 */
const NULL_SHA = '0000000000000000000000000000000000000000';

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

  // 3. Value-carrying skip waivers. HALT-wins ordering means these are
  //    checked AFTER halt (step 1) and AFTER codex_required=false
  //    short-circuit (step 2). Both of those should hold anyway; this is
  //    for the case where codex IS required but the operator wants to
  //    skip for a narrow, documented reason.
  //
  //    Two equivalent env vars are honored — gate behavior is identical;
  //    only the audit metadata's `skip_var` differs so operators can grep
  //    their audit log to see which variant agents used:
  //
  //      - REA_SKIP_PUSH_GATE     — the original 0.11.0 var
  //      - REA_SKIP_CODEX_REVIEW  — added in 0.12.0 to match the variant
  //                                 documented elsewhere in the codebase
  //                                 (gateway/reviewers, codex-probe). Prior
  //                                 to 0.12.0 this string only worked at
  //                                 the gateway tier; agents who set it on
  //                                 a `git push` got no skip and codex still
  //                                 ran. The mismatch surfaced during the
  //                                 helixir migration session 2026-04-26.
  //
  //    Precedence on simultaneous set: REA_SKIP_PUSH_GATE wins (it was the
  //    canonical name) and REA_SKIP_CODEX_REVIEW is logged but not used.
  //    Either var alone with non-empty reason short-circuits.
  const skipPush = (env.REA_SKIP_PUSH_GATE ?? '').trim();
  const skipCodex = (env.REA_SKIP_CODEX_REVIEW ?? '').trim();
  if (skipPush.length > 0 || skipCodex.length > 0) {
    const skipVar: 'REA_SKIP_PUSH_GATE' | 'REA_SKIP_CODEX_REVIEW' =
      skipPush.length > 0 ? 'REA_SKIP_PUSH_GATE' : 'REA_SKIP_CODEX_REVIEW';
    const skipReason = skipVar === 'REA_SKIP_PUSH_GATE' ? skipPush : skipCodex;
    stderr(`rea: ${skipVar}=${skipReason} — push-gate skipped (audited).\n`);
    await safeAppend(appendAuditFn, deps.baseDir, EVT_SKIPPED, {
      reason: skipReason,
      skip_var: skipVar,
    });
    return {
      status: 'skipped',
      exitCode: 0,
      summary: `${skipVar} waiver: ${skipReason}`,
    };
  }

  // 4. Resolve (base_ref, head_sha) for the actual review.
  //
  //    Precedence (highest first):
  //      a) `--base <ref>` CLI flag (deps.explicitBase) — explicit ref the
  //         operator named; we trust it.
  //      b) `--last-n-commits N` CLI flag (deps.lastNCommits) — diff
  //         against HEAD~N. Wins over the policy key.
  //      c) `policy.review.last_n_commits` — same effect as (b), but
  //         configured in `.rea/policy.yaml`. Persistent narrow-window.
  //      d) Active refspec from pre-push stdin — what git is about to
  //         push. Critical for `git push origin HEAD:release/1.0`.
  //      e) Upstream → origin/HEAD → main/master ladder.
  //
  //    When (a) collides with (b) or (c), (a) wins and we warn — explicit
  //    ref beats relative count.
  const policyLastN = policy.last_n_commits;
  const explicitBaseSet = deps.explicitBase !== undefined && deps.explicitBase.length > 0;
  const lastNFromFlag = deps.lastNCommits;
  const effectiveLastN = lastNFromFlag !== undefined ? lastNFromFlag : policyLastN;
  if (explicitBaseSet && effectiveLastN !== undefined) {
    const source = lastNFromFlag !== undefined ? '--last-n-commits' : 'policy.review.last_n_commits';
    stderr(
      `rea: --base ${deps.explicitBase} overrides ${source}=${effectiveLastN}; using explicit ref.\n`,
    );
  }

  const activeRefspec = (deps.refspecs ?? []).find(
    (r) => r.localSha !== NULL_SHA && r.localSha.length > 0,
  );
  let base: BaseResolution;
  let headSha: string;
  // Tracks whether the base was resolved from the active refspec's
  // remoteSha — i.e. "the tip of this branch as the remote currently sees
  // it". Only that case represents commits Codex has already reviewed in
  // a prior push; auto-narrow is only safe there (J / 0.13.0). Initial
  // pushes against `origin/main`-shaped bases must NOT auto-narrow,
  // because earlier commits on the branch may never have been reviewed.
  let baseFromPushedRemoteTip = false;
  if (explicitBaseSet) {
    // (a) explicit base wins absolutely.
    base = resolveBaseRef(git, { explicit: deps.explicitBase as string });
    headSha = activeRefspec !== undefined ? activeRefspec.localSha : git.headSha();
  } else if (effectiveLastN !== undefined && effectiveLastN > 0) {
    // (b) / (c) last-n-commits. Resolves to a SHA via `git rev-parse
    // <headRef>~N`. Compute headSha FIRST so the resolver walks back N
    // commits from the pushed ref rather than the local HEAD — critical
    // for `git push origin some-other-branch` where the active refspec's
    // localSha is a different branch entirely from the checkout's HEAD.
    headSha = activeRefspec !== undefined ? activeRefspec.localSha : git.headSha();
    base = resolveBaseRef(git, {
      lastNCommits: effectiveLastN,
      headRef: headSha,
    });
    if (
      base.lastNCommitsRequested !== undefined &&
      base.lastNCommits !== undefined &&
      base.lastNCommits < base.lastNCommitsRequested
    ) {
      // Clamp warning: the resolver couldn't go back N commits, so it
      // clamped to the entire branch history (diff vs empty-tree, K+1
      // commits reviewed) — `base.lastNCommits` carries the actual K+1.
      // This warning fires both when source is 'last-n-commits' (clamped
      // mid-branch, root commit included via empty-tree) and when source
      // is 'empty-tree' (single-commit branch). The user-facing message
      // is identical: we wanted N, got K, here's what we reviewed.
      stderr(
        `rea: ${headSha.slice(0, 12)}~${base.lastNCommitsRequested} not reachable; reviewing all ${base.lastNCommits} commits on this branch instead.\n`,
      );
    }
  } else if (activeRefspec !== undefined) {
    // (d) refspec-aware base — use what git is about to push.
    headSha = activeRefspec.localSha;
    if (activeRefspec.remoteSha === NULL_SHA || activeRefspec.remoteSha.length === 0) {
      // New remote ref — no existing commits to diff against. Fall back to
      // the resolver ladder so we still get a meaningful review (e.g. vs
      // origin/main) rather than an empty-tree diff of everything.
      base = resolveBaseRef(git);
    } else {
      base = { ref: activeRefspec.remoteSha, source: 'explicit' };
      // ONLY this path produces a base that represents the previously-
      // reviewed remote tip of THIS branch. Auto-narrow is safe here.
      baseFromPushedRemoteTip = true;
    }
  } else {
    // (e) upstream ladder.
    base = resolveBaseRef(git);
    headSha = git.headSha();
  }
  if (headSha.length === 0) {
    stderr('PUSH BLOCKED: could not resolve HEAD SHA. Is this a valid git repo?\n');
    await safeAppend(appendAuditFn, deps.baseDir, EVT_ERROR, { kind: 'head-sha-missing' });
    return { status: 'error', exitCode: 2, summary: 'head-sha-missing' };
  }

  // 4b. Auto-narrow probe (J / 0.13.0). When the resolved base is far
  //     behind HEAD AND the operator has not already pinned an explicit
  //     window, scope the review down to the recent commits and warn.
  //
  //     CRITICAL safety rule: auto-narrow ONLY fires when the base was
  //     resolved from the active refspec's remoteSha — i.e. "the tip of
  //     this branch as the remote currently sees it". Only that case
  //     represents commits Codex already reviewed in a prior push, so
  //     skipping older commits on the branch is safe.
  //
  //     For initial pushes (or any base resolved via the upstream /
  //     origin-head / origin-main ladder), the diff target is a trunk-
  //     like ref where commits earlier in the branch may never have been
  //     reviewed. Auto-narrowing past them would silently bypass the
  //     advertised pre-push review for a hook/policy/security change
  //     made early in the branch (codex-review 0.13.0 [P1]).
  //
  //     Suppression rules (any one prevents auto-narrow from firing):
  //
  //       - `--base` flag set (operator picked an explicit ref)
  //       - `--last-n-commits` flag set (operator picked an explicit
  //         window)
  //       - `policy.review.last_n_commits` set (persistent narrow window)
  //       - `policy.review.auto_narrow_threshold: 0` (disabled)
  //       - resolver already produced a `last-n-commits` source (we got
  //         here via the policyLastN branch above)
  //       - resolver fell back to `empty-tree` (single-commit branch /
  //         orphan; no usable upstream — narrowing would be silly)
  //       - base was NOT derived from the active refspec's remoteSha
  //         (initial push, no upstream, fallback to origin/main, etc.)
  //
  //     The probe uses `git rev-list --count base..HEAD` rather than
  //     `diffNames().length` — line-counting commits is far cheaper than
  //     listing every changed path on a 50+ commit branch. A null result
  //     (range unresolvable) suppresses auto-narrow entirely; we'd
  //     rather err on the side of reviewing more than tripping a
  //     half-baked auto-narrow on a degenerate ref.
  let autoNarrowed = false;
  let originalCommitCount: number | null = null;
  const autoNarrowEligible =
    !explicitBaseSet &&
    lastNFromFlag === undefined &&
    policyLastN === undefined &&
    policy.auto_narrow_threshold > 0 &&
    base.source !== 'last-n-commits' &&
    base.source !== 'empty-tree' &&
    baseFromPushedRemoteTip;
  if (autoNarrowEligible) {
    originalCommitCount = git.revListCount(base.ref, headSha);
    if (
      originalCommitCount !== null &&
      originalCommitCount > policy.auto_narrow_threshold
    ) {
      const fallbackWindow = PUSH_GATE_DEFAULT_LAST_N_COMMITS_FALLBACK;
      const narrowed = resolveBaseRef(git, {
        lastNCommits: fallbackWindow,
        headRef: headSha,
      });
      stderr(
        `rea: auto-narrow — ${originalCommitCount} commits behind ${base.ref} (threshold ${policy.auto_narrow_threshold}); reviewing the last ${fallbackWindow} commits instead.\n` +
          `  Override: pass \`--last-n-commits N\` or \`--base <ref>\`, set \`review.last_n_commits\` in .rea/policy.yaml, or disable with \`review.auto_narrow_threshold: 0\`.\n`,
      );
      base = narrowed;
      autoNarrowed = true;
    }
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
      last_n_commits: base.lastNCommits,
      last_n_commits_requested: base.lastNCommitsRequested,
      auto_narrowed: autoNarrowed ? true : undefined,
      original_commit_count:
        originalCommitCount !== null ? originalCommitCount : undefined,
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
      last_n_commits: base.lastNCommits,
      last_n_commits_requested: base.lastNCommitsRequested,
      auto_narrowed: autoNarrowed ? true : undefined,
      original_commit_count:
        originalCommitCount !== null ? originalCommitCount : undefined,
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
