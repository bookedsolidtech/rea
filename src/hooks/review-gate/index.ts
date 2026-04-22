/**
 * Public entry point for the review-gate TypeScript port (G).
 *
 * ## Scope after Phase 2b (0.10.4)
 *
 * - Phase 1 primitives (args, banner, cache-key, constants, errors,
 *   hash, metadata, policy, protected-paths) — pure, dependency-free.
 * - Phase 2a supporting modules (base-resolve, diff, audit, cache) —
 *   wrap git subprocesses, wrap audit append/scan, wrap the review-
 *   cache lookup.
 * - **Phase 2b composition** — `runPushReviewGate()` and
 *   `runCommitReviewGate()` compose the primitives into the two gate
 *   decisions the bash cores currently make. Phase 3 wires these to
 *   `rea hook push-review-gate` / `rea hook commit-review-gate` CLI
 *   subcommands; Phase 4 swaps the shims over and deletes the bash
 *   cores.
 *
 * The bash core in `hooks/_lib/push-review-core.sh` continues to run
 * in production until phase 4. These exports are library-level
 * primitives that Phase 3's CLI dispatch consumes; no behavioral
 * surface is registered for external callers here yet.
 *
 * See `docs/design/push-review-ts-port.md` for the full plan.
 */

// Phase 1 primitives
export * from './args.js';
export * from './banner.js';
export * from './cache-key.js';
export * from './constants.js';
export * from './errors.js';
export * from './hash.js';
export * from './metadata.js';
export * from './policy.js';
export * from './protected-paths.js';

// Phase 2a supporting modules — re-export explicit names to avoid
// double-exporting `computeCacheKey` (which lives in both cache-key.ts
// and cache.ts; cache.ts's is a strict re-export of Phase 1's).
export {
  currentBranch,
  diffNameStatus,
  fullDiff,
  gitCommonDir,
  hasCommitLocally,
  mergeBase,
  readGitActor,
  readGitConfig,
  refExists,
  resolveHead,
  resolveRefToSha,
  resolveRemoteDefaultRef,
  resolveUpstream,
  revListCount,
  spawnGit,
  type DiffResult,
  type GitRunResult,
  type GitRunner,
  type NameStatusResult,
} from './diff.js';
export {
  computeInitialTargetLabel,
  resolveBaseForRefspec,
  resolveNewBranchBase,
  stripRefsHeadsOnly,
  type ResolveBaseDeps,
  type ResolvedBase,
} from './base-resolve.js';
export {
  CODEX_REVIEW_SKIPPED_TOOL,
  ESCAPE_HATCH_SERVER,
  PUSH_REVIEW_CACHE_ERROR_TOOL,
  PUSH_REVIEW_CACHE_HIT_TOOL,
  PUSH_REVIEW_SERVER,
  PUSH_REVIEW_SKIPPED_TOOL,
  emitCodexReviewSkipped,
  emitPushReviewSkipped,
  hasValidCodexReview,
  isQualifyingCodexReview,
  type SkipCodexReviewAuditInput,
  type SkipPushReviewAuditInput,
} from './audit.js';
export {
  checkReviewCache,
  type CacheOutcome,
  type CheckReviewCacheInput,
} from './cache.js';
export {
  evaluateCodexGate,
  renderWaiverBanner,
  verifyCodexReceipt,
  type CodexGateDecision,
  type EvaluateCodexGateInput,
} from './codex-gate.js';

// ────────────────────────────────────────────────────────────────────────
// Phase 2b — gate composition
// ────────────────────────────────────────────────────────────────────────

import type { RefspecRecord } from './args.js';
import { hasDeletion, parsePrepushStdin, resolveArgvRefspecs } from './args.js';
import {
  renderProtectedPathsBlockedBanner,
  renderPushReviewRequiredBanner,
  computeDiffStats,
} from './banner.js';
import { checkReviewCache, type CacheOutcome } from './cache.js';
import {
  BlockedError,
  DeletionBlockedError,
  NoBaseResolvableError,
  ReviewGateError,
  type ReviewGateErrorCode,
} from './errors.js';
import {
  resolveBaseForRefspec,
  type ResolvedBase,
} from './base-resolve.js';
import {
  currentBranch,
  diffNameStatus,
  fullDiff,
  type GitRunner,
  resolveHead,
  resolveRefToSha,
  resolveUpstream,
  revListCount,
  spawnGit,
} from './diff.js';
import {
  emitPushReviewSkipped,
  type SkipPushReviewAuditInput,
} from './audit.js';
import {
  evaluateCodexGate,
  verifyCodexReceipt,
  type CodexGateDecision,
} from './codex-gate.js';
import { computeCacheKey } from './cache-key.js';
import {
  isCiContext,
  readSkipEnv,
  resolveReviewPolicy,
  type ResolvedPolicy,
} from './policy.js';
import { scanNameStatusForProtectedPaths } from './protected-paths.js';

/**
 * Context for one invocation of the push-review gate.
 *
 * All IO is injected so the gate is unit-testable without a real git
 * repo / real env / real stdin:
 *
 *   - `baseDir` — resolved repo root (the directory containing
 *     `.rea/policy.yaml`). The cross-repo guard lives in the CLI shim
 *     (Phase 3); by the time the gate is invoked, baseDir IS the repo.
 *   - `runner` — git subprocess runner. Production wires to
 *     `spawnGit`; tests supply a recording stub.
 *   - `input` — raw stdin bytes (pre-push refspec lines or
 *     Claude-Code JSON).
 *   - `cmd` — the parsed command string (`git push origin ...`).
 *     Provided by the shim; empty string when not a `git push`.
 *   - `argv_remote` — the remote name from adapter argv (`origin`
 *     default).
 *   - `env` — optional env override for tests; defaults to
 *     `process.env`.
 *
 * When the caller doesn't know `cmd` at dispatch time, pass the empty
 * string — the gate will treat stdin as authoritative and fall back to
 * `git push ${argv_remote}` if stdin looks like git's refspec contract.
 */
export interface PushReviewContext {
  baseDir: string;
  runner?: GitRunner;
  input: string;
  cmd: string;
  argv_remote: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Outcome from `runPushReviewGate()`. A discriminated union so the CLI
 * shim can translate to the right exit code + banner without parsing
 * text.
 *
 *   - `pass` — everything checked out. Exit 0. Banner text is optional
 *     (only populated for the skipped path, which emits a visible
 *     banner per bash §489-500).
 *   - `review_required` — no cache hit; operator must run the review
 *     loop + cache the result. Exit 2. `banner` contains the PUSH
 *     REVIEW GATE text.
 *   - `skipped` — `REA_SKIP_PUSH_REVIEW` was honored. Exit 0. `banner`
 *     contains the audited-bypass notice.
 *   - `not_a_push` — stdin/cmd does not look like a push. Exit 0. No
 *     banner. This is the bash §326-341 no-op case.
 */
export type PushReviewOutcome =
  | { kind: 'pass'; exitCode: 0; banner?: string }
  | {
      kind: 'review_required';
      exitCode: 2;
      banner: string;
      source_ref: string;
      source_sha: string;
      target_branch: string;
      merge_base: string;
      push_sha: string;
      cache?: CacheOutcome;
    }
  | { kind: 'skipped'; exitCode: 0; banner: string }
  | { kind: 'not_a_push'; exitCode: 0 };

/**
 * Run the push-review gate against the given context.
 *
 * Flow (mirrors bash §5–§9):
 *
 *   1. HALT + `REA_SKIP_PUSH_REVIEW` escape-hatch — the highest
 *      precedence. The skip emits a `push.review.skipped` audit
 *      record, renders the banner, returns `skipped`.
 *   2. Parse stdin → refspec records. If stdin didn't match the
 *      pre-push contract, fall back to argv parsing via
 *      `resolveArgvRefspecs(cmd)`.
 *   3. Deletion guard (defect J) — any deletion anywhere in the
 *      push is an immediate `BlockedError`.
 *   4. Per-refspec loop: resolve base, run protected-path check,
 *      count commits. Pick the winning refspec by commit count
 *      (largest diff).
 *   5. Full diff. Empty → `pass` (bash §1073-1075).
 *   6. Cache lookup. `hit_pass` → `pass`. `hit_fail` / `miss` /
 *      `query_error` → `review_required`.
 *
 * Throws `ReviewGateError` subclasses for all refusal conditions. The
 * CLI shim (Phase 3) translates to exit 2 + stderr banner via the
 * error's own `message` field. The TS caller (Phase 2b tests,
 * Phase-3 unit tests) catches and asserts on the `code` discriminator.
 */
export async function runPushReviewGate(
  ctx: PushReviewContext,
): Promise<PushReviewOutcome> {
  const env = ctx.env ?? process.env;
  const runner: GitRunner = ctx.runner ?? spawnGit;

  // Step 1a: determine whether this is actually a push at all. Bash
  // §327-341 sniffs stdin for the pre-push line shape AND falls back
  // to argv inspection. The shim already parsed cmd; if cmd lacks a
  // `git push` token AND stdin doesn't match the refspec pattern, the
  // gate is a no-op.
  if (!looksLikePush(ctx)) {
    return { kind: 'not_a_push', exitCode: 0 };
  }

  // Step 1b: resolve policy once — the Codex gate and the skip path
  // both need it; reading YAML twice is wasted work.
  const policy = resolveReviewPolicy(ctx.baseDir);
  if (policy.warning !== null) {
    // Non-fatal — the caller (CLI shim) chooses whether to echo.
    // The fail-closed default (codex_required=true) is already baked
    // into the ResolvedPolicy.
  }

  // Step 2: REA_SKIP_PUSH_REVIEW whole-gate escape hatch (bash §344-502).
  const skipEnv = readSkipEnv(env);
  if (skipEnv.push_review_reason !== null) {
    return await handleFullGateSkip(ctx, runner, policy, skipEnv.push_review_reason, env);
  }

  // Step 3: parse refspecs. Stdin authoritative; fall back to argv.
  const records = parseRefspecsFromContext(ctx, runner);
  if (records.length === 0) {
    throw new BlockedError(
      'PUSH_BLOCKED_NO_REFSPECS' satisfies ReviewGateErrorCode,
      'PUSH BLOCKED: no push refspecs could be resolved.\n' +
        '  Refusing to pass without a source commit to review.\n',
    );
  }

  // Step 4: deletion guard — defect J. Hoisted above per-refspec
  // selection so a sibling successful refspec cannot hide a deletion.
  if (hasDeletion(records)) {
    throw new DeletionBlockedError();
  }

  // Step 5: Codex-gate decision (policy + env + CI + waiver). Computed
  // ONCE for the whole push — bash §540-673. Uses the pushed HEAD
  // (the first non-deletion refspec's local_sha) for the waiver
  // record. metadata_source is 'prepush-stdin' when we matched stdin,
  // else 'local-fallback'.
  //
  // Codex P1: thread the injected env through. Without this, a caller
  // that supplied `ctx.env = {}` (sanitized test env) would still let
  // `evaluateCodexGate` fall back to `process.env` and pick up an
  // ambient `REA_SKIP_CODEX_REVIEW` / `CI` value from the parent
  // process — inverting the gate decision invisibly.
  const firstPush = records.find((r) => !r.is_deletion)!;
  const codexDecision = await evaluateCodexGate({
    baseDir: ctx.baseDir,
    runner,
    head_sha: firstPush.local_sha,
    target: stripRefsHeadsOnly(firstPush.remote_ref),
    metadata_source: ctx.input.length > 0 && looksLikePrepushStdin(ctx.input) ? 'prepush-stdin' : 'local-fallback',
    policy,
    skipEnv: readSkipEnv(env),
    ci: isCiContext(env),
  });

  // Step 6: per-refspec loop. Resolve base, run protected-path check,
  // size the diff. Pick the best (largest) refspec as the reviewable.
  const best = await pickWinningRefspec(records, ctx, runner, codexDecision);

  // Step 7: compute the full diff for the winning refspec. Empty diff
  // means the push is a no-op (same SHA on both sides, or an already-
  // fast-forwarded branch). Exit 0 per bash §1073-1075.
  const d = fullDiff(runner, ctx.baseDir, best.merge_base, best.source_sha);
  if (d.status !== 0) {
    throw new BlockedError(
      'PUSH_BLOCKED_DIFF_FAILED' satisfies ReviewGateErrorCode,
      `PUSH BLOCKED: git diff ${best.merge_base.slice(0, 12)}..${best.source_sha.slice(0, 12)} failed (exit ${d.status})\n` +
        '  Cannot compute reviewable diff; refusing to pass.\n',
      { merge_base: best.merge_base, source_sha: best.source_sha, status: d.status, stderr: d.stderr },
    );
  }
  if (d.diff.length === 0) {
    return { kind: 'pass', exitCode: 0 };
  }

  // Step 8: cache lookup. Key is sha256(diff). Branch scope uses the
  // PUSHED source ref, falling back to the checkout branch when the
  // pushed ref is HEAD (bare push via argv fallback). Bash §1152-1155.
  const pushSha = computeCacheKey({ diff: d.diff });
  const sourceBranch = deriveSourceBranch(best.source_ref, runner, ctx.baseDir);
  const cache = await checkReviewCache({
    baseDir: ctx.baseDir,
    diff: d.diff,
    branch: sourceBranch,
    base: best.target_branch,
  });

  if (cache.kind === 'hit_pass') {
    return { kind: 'pass', exitCode: 0 };
  }

  // Cache miss / fail / error → review required.
  const stats = computeDiffStats(d.diff);
  const banner = renderPushReviewRequiredBanner({
    source_ref: best.source_ref.length > 0 ? best.source_ref : 'HEAD',
    source_sha: best.source_sha,
    target_branch: best.target_branch,
    merge_base: best.merge_base,
    stats,
    push_sha: pushSha,
    source_branch: sourceBranch,
  });

  const out: Extract<PushReviewOutcome, { kind: 'review_required' }> = {
    kind: 'review_required',
    exitCode: 2,
    banner,
    source_ref: best.source_ref,
    source_sha: best.source_sha,
    target_branch: best.target_branch,
    merge_base: best.merge_base,
    push_sha: pushSha,
    cache,
  };
  return out;
}

/**
 * Context for one invocation of the commit-review gate.
 *
 * The commit gate is a much simpler composition than push-review —
 * it has no per-refspec loop (always operates on the staged index),
 * no cache-key sharing across branches, and no escape-hatch env var
 * (commits are gated only under Claude Code's `Bash` PreToolUse
 * matcher, so a human direct-shell commit bypasses the gate
 * entirely — see commit-review-gate.sh §13-14 file-top).
 *
 * Triage thresholds (matching the bash core):
 *   - <20 changed lines + non-sensitive → `trivial` (pass)
 *   - ≥20 AND ≤200 lines → `standard` (check cache, review if miss)
 *   - >200 lines OR sensitive paths → `significant` (always review)
 */
export interface CommitReviewContext {
  baseDir: string;
  runner?: GitRunner;
  /** The command string extracted from Bash tool_input. */
  cmd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Triage scoring. A pure function over diff stats + sensitive-path
 * detection. Exported so the commit-review-gate's bash port and the
 * Phase-3 CLI smoke test can both consult it.
 */
export type CommitTriageScore = 'trivial' | 'standard' | 'significant';

export function scoreCommit(input: {
  line_count: number;
  sensitive: boolean;
}): CommitTriageScore {
  if (input.sensitive || input.line_count > 200) return 'significant';
  if (input.line_count >= 20) return 'standard';
  return 'trivial';
}

/**
 * Outcome from `runCommitReviewGate()`. Mirrors the commit-review
 * bash core: `pass` covers both trivial (auto) and cached-pass paths;
 * `review_required` covers standard-miss and significant-always.
 */
export type CommitReviewOutcome =
  | { kind: 'pass'; exitCode: 0; score: CommitTriageScore; reason: 'trivial' | 'cache_hit' | 'amend' | 'not_a_commit' | 'no_staged_changes' }
  | {
      kind: 'review_required';
      exitCode: 2;
      banner: string;
      score: CommitTriageScore;
      line_count: number;
      sensitive_files: string[];
      staged_sha: string;
      branch: string;
      base_branch: string;
    };

/**
 * Run the commit-review gate against staged changes.
 *
 * Flow (mirrors commit-review-gate.sh §4-11):
 *
 *   1. Not a `git commit` → pass (not_a_commit).
 *   2. `--amend` → pass (amend). Amends are out of scope for this
 *      gate; reviewing amendments is a future feature.
 *   3. No staged diff → pass (let git error). This avoids blocking
 *      on an empty commit so the operator sees git's own error.
 *   4. Count lines + detect sensitive paths. Score.
 *   5. Trivial → pass immediately.
 *   6. Standard/significant → cache lookup. Hit-pass → pass;
 *      otherwise review_required with the banner.
 */
export async function runCommitReviewGate(
  ctx: CommitReviewContext,
): Promise<CommitReviewOutcome> {
  const runner: GitRunner = ctx.runner ?? spawnGit;

  if (!/\bgit[\s]+commit\b/i.test(ctx.cmd)) {
    return { kind: 'pass', exitCode: 0, score: 'trivial', reason: 'not_a_commit' };
  }
  if (/\bgit[\s]+commit[^\n]*--amend/i.test(ctx.cmd)) {
    return { kind: 'pass', exitCode: 0, score: 'trivial', reason: 'amend' };
  }

  // Staged diff — `git diff --cached`.
  const diffResult = runner(['diff', '--cached'], ctx.baseDir);
  const stagedDiff = diffResult.stdout;
  if (diffResult.status !== 0 || stagedDiff.length === 0) {
    // No staged changes — let `git commit` handle the error.
    return { kind: 'pass', exitCode: 0, score: 'trivial', reason: 'no_staged_changes' };
  }

  const stats = computeDiffStats(stagedDiff);
  const sensitive = detectCommitSensitiveFiles(stagedDiff);
  const score = scoreCommit({ line_count: stats.line_count, sensitive: sensitive.hit });

  if (score === 'trivial') {
    return { kind: 'pass', exitCode: 0, score, reason: 'trivial' };
  }

  // Standard / significant — consult the review cache. Cache key is
  // the same sha256-of-diff shape as push-review — a merge that
  // happens to match the next push's diff can reuse the cached result.
  const stagedSha = computeCacheKey({ diff: stagedDiff });
  const branch = currentBranch(runner, ctx.baseDir);
  const baseBranch = resolveCommitBaseBranch(runner, ctx.baseDir);

  let cacheOutcome: CacheOutcome | null = null;
  if (branch.length > 0 && baseBranch.length > 0) {
    cacheOutcome = await checkReviewCache({
      baseDir: ctx.baseDir,
      diff: stagedDiff,
      branch,
      base: baseBranch,
    });
    if (cacheOutcome.kind === 'hit_pass') {
      return { kind: 'pass', exitCode: 0, score, reason: 'cache_hit' };
    }
  }

  const banner = renderCommitReviewBanner({
    score,
    line_count: stats.line_count,
    sensitive_files: sensitive.files,
    staged_sha: stagedSha,
    branch,
    base_branch: baseBranch,
  });

  return {
    kind: 'review_required',
    exitCode: 2,
    banner,
    score,
    line_count: stats.line_count,
    sensitive_files: sensitive.files,
    staged_sha: stagedSha,
    branch,
    base_branch: baseBranch,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Internal helpers — module-private composition glue
// ────────────────────────────────────────────────────────────────────────

/**
 * True iff the ctx looks like a push: either `cmd` contains `git push`
 * OR stdin matches the pre-push refspec-line shape. Mirrors bash
 * §327-341.
 */
function looksLikePush(ctx: PushReviewContext): boolean {
  if (/\bgit[\s]+push\b/i.test(ctx.cmd)) return true;
  if (ctx.input.length > 0 && looksLikePrepushStdin(ctx.input)) return true;
  return false;
}

/** Sniff stdin for a pre-push refspec line. Reused by looksLikePush + metadata_source. */
function looksLikePrepushStdin(input: string): boolean {
  const firstLine = input.split('\n').find((l) => l.trim().length > 0) ?? '';
  if (firstLine.length === 0) return false;
  // Shape: `<local_ref> <local_sha> <remote_ref> <remote_sha>` with SHA
  // as 40-hex. Matches the bash grep at §331-333.
  return /^\S+\s+[0-9a-f]{40}\s+\S+\s+[0-9a-f]{40}\s*$/.test(firstLine);
}

/**
 * Parse refspecs out of stdin; fall back to argv parsing when stdin
 * doesn't match the pre-push contract. Bash §693-702.
 *
 * Returns an empty array when both paths fail; the caller throws
 * `PUSH_BLOCKED_NO_REFSPECS`.
 */
function parseRefspecsFromContext(ctx: PushReviewContext, runner: GitRunner): RefspecRecord[] {
  const stdinResult = parsePrepushStdin(ctx.input);
  if (stdinResult.matched) {
    return stdinResult.records;
  }

  // Argv fallback. Needs HEAD + @{upstream} for bare `git push`.
  const headSha = resolveHead(runner, ctx.baseDir);
  const upstream = resolveUpstream(runner, ctx.baseDir);
  try {
    return resolveArgvRefspecs(ctx.cmd, {
      resolveHead: (ref: string) => resolveRefToSha(runner, ctx.baseDir, ref),
      headSha,
      upstream,
    });
  } catch (err) {
    // args.ts throws `BlockedError` subclasses for operator-error
    // conditions (HEAD refspec, invalid delete, etc.). Propagate —
    // the caller's top-level catch handles them.
    if (err instanceof ReviewGateError) throw err;
    throw err;
  }
}

/**
 * Walk every refspec, run the protected-path scan per refspec, and
 * accumulate the winning (largest-diff) one. Bash §711-1021 condensed.
 *
 * Returns the resolved merge-base + source_sha + target_branch for the
 * winner. Throws `BlockedError` on the first per-refspec fatal
 * (remote-object-missing, no-merge-base, diff-failed, protected-paths-
 * without-receipt, rev-list-failed).
 *
 * Note on defect N: the empty-tree fallback for bootstrap / grafted
 * branches is still the phase-2b behavior. Fail-loud is reserved for
 * Phase 4 per design §7; `NoBaseResolvableError` is imported here
 * unused to keep the type visible until that phase lands.
 */
async function pickWinningRefspec(
  records: RefspecRecord[],
  ctx: PushReviewContext,
  runner: GitRunner,
  codexDecision: CodexGateDecision,
): Promise<{
  source_ref: string;
  source_sha: string;
  target_branch: string;
  merge_base: string;
}> {
  // Pin unused import so the Phase-4 fail-loud cutover doesn't have to
  // touch imports; also ensures tree-shaking keeps the class exported.
  void NoBaseResolvableError;

  let best: {
    source_ref: string;
    source_sha: string;
    target_branch: string;
    merge_base: string;
    count: number;
  } | null = null;

  for (const rec of records) {
    if (rec.is_deletion) continue;

    const base: ResolvedBase = resolveBaseForRefspec(rec, {
      runner,
      cwd: ctx.baseDir,
      remote: ctx.argv_remote.length > 0 ? ctx.argv_remote : 'origin',
    });

    if (base.status === 'remote_object_missing') {
      throw new BlockedError(
        'PUSH_BLOCKED_REMOTE_OBJECT_MISSING' satisfies ReviewGateErrorCode,
        `PUSH BLOCKED: remote object ${rec.remote_sha} is not in the local object DB.\n` +
          '\n' +
          '  The gate cannot compute a review diff without it. Fetch the\n' +
          '  remote and retry:\n' +
          '\n' +
          `    git fetch ${ctx.argv_remote || 'origin'}\n` +
          '    # then retry the push\n',
        { remote_sha: rec.remote_sha },
      );
    }
    if (base.status === 'no_merge_base') {
      throw new BlockedError(
        'PUSH_BLOCKED_NO_MERGE_BASE' satisfies ReviewGateErrorCode,
        `PUSH BLOCKED: no merge-base between remote ${(rec.remote_sha).slice(0, 12)} and local ${rec.local_sha.slice(0, 12)}\n` +
          '  The two histories are unrelated; refusing to pass without a\n' +
          '  reviewable diff.\n',
        { remote_sha: rec.remote_sha, local_sha: rec.local_sha },
      );
    }

    const mb = base.merge_base;
    if (mb === null) continue; // deletion / invariant — shouldn't hit.

    // Per-refspec protected-path check — bash §894-994. MUST run on
    // every refspec (not just the winner) so a small protected-path
    // refspec can't hide behind a larger sibling.
    const ns = diffNameStatus(runner, ctx.baseDir, mb, rec.local_sha);
    if (ns.status !== 0) {
      throw new BlockedError(
        'PUSH_BLOCKED_DIFF_FAILED' satisfies ReviewGateErrorCode,
        `PUSH BLOCKED: git diff --name-status ${mb.slice(0, 12)}..${rec.local_sha.slice(0, 12)} failed (exit ${ns.status})\n` +
          `  Refspec: ${rec.local_ref || '<unknown>'}\n` +
          '  Cannot determine whether protected paths changed; refusing to pass.\n',
        { merge_base: mb, source_sha: rec.local_sha, status: ns.status },
      );
    }

    const scan = scanNameStatusForProtectedPaths(ns.output);
    if (scan.hit) {
      // Codex P2: fail closed on audit-read I/O errors. When
      // `hasValidCodexReview` propagates a non-ENOENT fs error
      // (permission denied, transient FS failure, EIO on a crashed
      // mount), we MUST translate to a typed `BlockedError` so the
      // CLI shim can render an actionable banner + exit 2 rather
      // than crashing with an uncaught exception. A crashed gate is
      // indistinguishable from a passed gate at the shim level
      // (both return non-zero), but the operator-facing text is
      // drastically different — fail-closed with the correct banner
      // is the contract.
      let ok = false;
      try {
        ok = await verifyCodexReceipt(codexDecision, ctx.baseDir, rec.local_sha);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BlockedError(
          'PUSH_BLOCKED_PROTECTED_PATHS' satisfies ReviewGateErrorCode,
          `PUSH BLOCKED: protected paths changed but audit log is unreadable — ${msg}\n` +
            '  Cannot verify a codex.review receipt; refusing to pass.\n' +
            '  Inspect `.rea/audit.jsonl` permissions and retry.\n',
          { source_sha: rec.local_sha, paths: scan.paths, cause: msg },
        );
      }
      if (!ok) {
        throw new BlockedError(
          'PUSH_BLOCKED_PROTECTED_PATHS' satisfies ReviewGateErrorCode,
          renderProtectedPathsBlockedBanner({
            source_ref: rec.local_ref || '<unknown>',
            source_sha: rec.local_sha,
          }),
          { source_sha: rec.local_sha, paths: scan.paths },
        );
      }
    }

    // Size the diff for selection.
    const count = revListCount(runner, ctx.baseDir, mb, rec.local_sha);
    if (count < 0) {
      throw new BlockedError(
        'PUSH_BLOCKED_REV_LIST_FAILED' satisfies ReviewGateErrorCode,
        `PUSH BLOCKED: git rev-list --count ${mb.slice(0, 12)}..${rec.local_sha.slice(0, 12)} failed\n` +
          '  Cannot size the diff; refusing to pass.\n',
        { merge_base: mb, source_sha: rec.local_sha },
      );
    }

    if (best === null || count > best.count) {
      best = {
        source_ref: rec.local_ref,
        source_sha: rec.local_sha,
        target_branch: base.target_label,
        merge_base: mb,
        count,
      };
    }
  }

  if (best === null) {
    throw new BlockedError(
      'PUSH_BLOCKED_NO_MERGE_BASE' satisfies ReviewGateErrorCode,
      'PUSH BLOCKED: could not resolve a merge-base for any push refspec.\n' +
        '\n' +
        '  Fetch the remote and retry, or name an explicit destination.\n',
    );
  }

  return {
    source_ref: best.source_ref,
    source_sha: best.source_sha,
    target_branch: best.target_branch,
    merge_base: best.merge_base,
  };
}

/** Strip `refs/heads/` only. Local helper — same logic lives in args + base-resolve. */
function stripRefsHeadsOnly(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * Derive the source-branch name for the cache-key branch scope.
 * Bash §1152-1155: strip refs/heads/, and when the result is empty or
 * the literal "HEAD" (argv fallback for a bare push), substitute the
 * checkout branch.
 */
function deriveSourceBranch(source_ref: string, runner: GitRunner, baseDir: string): string {
  let sourceBranch = stripRefsHeadsOnly(source_ref);
  if (sourceBranch.length === 0 || sourceBranch === 'HEAD') {
    sourceBranch = currentBranch(runner, baseDir);
  }
  return sourceBranch;
}

/**
 * `REA_SKIP_PUSH_REVIEW` escape-hatch handler. Mirrors bash §344-502.
 *
 * Runs all the refusal checks (build-absent, CI-refused, no-actor),
 * captures OS-identity metadata, emits the `push.review.skipped`
 * audit record, and returns the `skipped` outcome with the operator-
 * facing banner.
 *
 * Note: bash §359 checks for `dist/audit/append.js` because the bash
 * path would shell out to node. The TS path imports the appender
 * directly, so "rea is built" is implicitly satisfied (the gate
 * itself is compiled TS).
 */
async function handleFullGateSkip(
  ctx: PushReviewContext,
  runner: GitRunner,
  policy: ResolvedPolicy,
  reason: string,
  env: NodeJS.ProcessEnv,
): Promise<Extract<PushReviewOutcome, { kind: 'skipped' }>> {
  // CI refusal (bash §371-389).
  if (isCiContext(env) && !policy.allow_skip_in_ci) {
    throw new BlockedError(
      'PUSH_BLOCKED_SKIP_REFUSED_IN_CI' satisfies ReviewGateErrorCode,
      'PUSH BLOCKED: REA_SKIP_PUSH_REVIEW refused in CI context.\n' +
        '\n' +
        '  CI env var is set. An unauthenticated env-var bypass in a shared\n' +
        '  build agent is not trusted. To enable, set\n' +
        '    review:\n' +
        '      allow_skip_in_ci: true\n' +
        '  in .rea/policy.yaml — explicitly authorizing env-var skips in CI.\n',
      { env_var: 'REA_SKIP_PUSH_REVIEW' },
    );
  }

  // Actor resolution (bash §392-408).
  const actor = (runner(['config', '--get', 'user.email'], ctx.baseDir).stdout) ||
    (runner(['config', '--get', 'user.name'], ctx.baseDir).stdout);
  if (actor.length === 0) {
    throw new BlockedError(
      'PUSH_BLOCKED_SKIP_NO_ACTOR' satisfies ReviewGateErrorCode,
      'PUSH BLOCKED: REA_SKIP_PUSH_REVIEW requires a git identity.\n' +
        '\n' +
        '  Neither `git config user.email` nor `git config user.name`\n' +
        '  is set. The skip audit record would have no actor; refusing\n' +
        '  to bypass without one.\n',
      { env_var: 'REA_SKIP_PUSH_REVIEW' },
    );
  }

  const branch = currentBranch(runner, ctx.baseDir);
  const head = resolveHead(runner, ctx.baseDir);

  const auditInput: SkipPushReviewAuditInput = {
    baseDir: ctx.baseDir,
    head_sha: head,
    branch,
    reason,
    actor,
  };
  try {
    await emitPushReviewSkipped(auditInput);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BlockedError(
      'PUSH_BLOCKED_SKIP_AUDIT_FAILED' satisfies ReviewGateErrorCode,
      `PUSH BLOCKED: REA_SKIP_PUSH_REVIEW audit-append failed — ${msg}\n` +
        '  Refusing to bypass the push gate without a receipt.\n',
      { env_var: 'REA_SKIP_PUSH_REVIEW', cause: msg },
    );
  }

  const banner =
    '\n==  PUSH REVIEW GATE SKIPPED via REA_SKIP_PUSH_REVIEW\n' +
    `    Reason:  ${reason}\n` +
    `    Actor:   ${actor}\n` +
    `    Branch:  ${branch.length > 0 ? branch : '<detached>'}\n` +
    `    Head:    ${head.length > 0 ? head : '<unknown>'}\n` +
    '    Audited: .rea/audit.jsonl (tool_name=push.review.skipped)\n' +
    '\n' +
    '    This is a gate weakening. Every invocation is permanently audited.\n' +
    '\n';

  return { kind: 'skipped', exitCode: 0, banner };
}

/**
 * Detect commit-review sensitive paths. Mirrors the bash grep at
 * commit-review-gate.sh §131 — the regex is a superset of the push-
 * gate protected-paths prefix list (it includes `.env`, `auth`, and
 * `security` as substring matches for the commit-time "is this
 * risky?" triage).
 *
 * Input is the raw staged diff; output is the hit flag + the set of
 * hit filenames (from `+++ b/<path>` headers). The bash version caps
 * the sample at 5 lines for the banner; we expose the full set and
 * let the banner renderer decide.
 */
export function detectCommitSensitiveFiles(diff: string): { hit: boolean; files: string[] } {
  const hits = new Set<string>();
  if (diff.length === 0) return { hit: false, files: [] };
  // Match bash §131 regex family. Note: these are SUBSTRING matches
  // per bash's behavior (e.g. `auth` in a filename triggers), not
  // prefix matches — different from push-gate protected-paths.
  //
  // Codex P2: `.env` is a plain substring in the bash gate — matches
  // `.env`, `.env.local`, AND `.envrc` / `.envvar-dump` / any file
  // whose path contains the literal 4-byte sequence. An earlier TS
  // draft used `/\.env(?!\w)/` which tightened the match (dropping
  // `.envrc` / `.envrcdef`), regressing the commit-gate's
  // sensitive-triage against the bash contract. Revert to the plain
  // substring — byte-compatible parity with bash is the design
  // non-goal anchor (design §2).
  const sensitivePatterns = [
    /\.rea\//,
    /\.claude\//,
    /\.env/,
    /auth/i,
    /security/i,
    /\.github\/workflows/,
  ];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    // `+++ b/path/file` — strip the `+++ [ab]/` prefix for display.
    let path = line.slice(4);
    if (path.startsWith('a/') || path.startsWith('b/')) path = path.slice(2);
    if (path === '/dev/null') continue;
    if (sensitivePatterns.some((re) => re.test(path))) {
      hits.add(path);
    }
  }
  return { hit: hits.size > 0, files: Array.from(hits).sort() };
}

/**
 * Resolve the base branch for commit-review cache lookups. Mirrors
 * commit-review-gate.sh §212-232: origin/HEAD → origin/main →
 * origin/master → empty.
 */
function resolveCommitBaseBranch(runner: GitRunner, baseDir: string): string {
  const originHead = runner(['symbolic-ref', 'refs/remotes/origin/HEAD'], baseDir);
  if (originHead.status === 0 && originHead.stdout.length > 0) {
    const short = originHead.stdout.replace(/^refs\/remotes\/origin\//, '');
    if (short.length > 0) return short;
  }
  const probeMain = runner(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], baseDir);
  if (probeMain.status === 0) return 'main';
  const probeMaster = runner(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'], baseDir);
  if (probeMaster.status === 0) return 'master';
  return '';
}

/**
 * Compose the commit-review banner. Mirrors commit-review-gate.sh
 * §292-329 — including the "cache DISABLED" fork when no
 * staged_sha or base_branch is available.
 */
function renderCommitReviewBanner(input: {
  score: CommitTriageScore;
  line_count: number;
  sensitive_files: string[];
  staged_sha: string;
  branch: string;
  base_branch: string;
}): string {
  const lines: string[] = [];
  lines.push('COMMIT REVIEW GATE: Review required before committing');
  lines.push('');
  lines.push(`  Score: ${input.score} (${input.line_count} changed lines)`);
  if (input.sensitive_files.length > 0) {
    lines.push('  Sensitive paths detected:');
    for (const f of input.sensitive_files.slice(0, 5)) {
      lines.push(`  ${f}`);
    }
  }
  lines.push('');
  lines.push('  YOU (the agent) are the reviewer. Do not ask the user to commit manually.');
  lines.push('  Review the staged diff, make a pass/fail decision, then proceed:');
  lines.push('');
  lines.push('  1. Inspect:  git diff --cached');
  lines.push('  2. Decide:   Is this safe to commit? (initial commits, refactors, and');
  lines.push('               feature work are normal — use judgement, not ceremony)');
  if (input.staged_sha.length > 0 && input.base_branch.length > 0) {
    lines.push(
      `  3. Approve:  rea cache set ${input.staged_sha} pass --branch ${input.branch} --base ${input.base_branch}`,
    );
    lines.push('  4. Retry the git commit command');
  } else {
    lines.push('  3. Cache is DISABLED on this host (no sha256 hasher or no base');
    lines.push('     branch resolvable). Install one of: sha256sum (Linux coreutils),');
    lines.push('     shasum (perl-core), or openssl; or ensure origin/HEAD is set so');
    lines.push('     the gate can identify the merge target. Without these the cache');
    lines.push('     path cannot complete — escalate to the user if neither can be');
    lines.push('     provided.');
  }
  lines.push('');
  lines.push('  Only escalate to the user if you find a genuine problem in the diff.');
  return lines.join('\n') + '\n';
}
