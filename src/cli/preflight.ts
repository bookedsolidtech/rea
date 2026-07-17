/**
 * `rea preflight` — local-first enforcement workhorse (0.26.0+).
 *
 * Called by:
 *   - The husky pre-push template (`exec rea preflight --strict`)
 *   - The Bash-tier `local-review-gate.sh` PreToolUse hook
 *   - Operators directly (`rea preflight` to check status)
 *
 * Decision flow:
 *
 *   1. `policy.review.local_review.mode === 'off'` → exit 0 (no-op)
 *   2. `<bypass_env_var>` is set (default REA_SKIP_LOCAL_REVIEW) → audit
 *      `rea.local_review.skipped_override` with the reason; exit 0
 *   3. `--no-review-check` flag → audit `rea.preflight.review_skipped`;
 *      proceed to commit-count check only
 *   4. Tail `.rea/audit.jsonl` for a `rea.local_review` (or back-compat
 *      `codex.review`) entry with `metadata.head_sha === <git HEAD>`
 *      AND `now - timestamp < max_age_seconds`. Found → exit 0.
 *      Missing → exit 2 with helpful message.
 *   5. Commit-count check (independent of step 4):
 *        `git rev-list --count <base>..HEAD` against thresholds
 *        from `policy.commit_hygiene`.
 *
 * Exit codes:
 *
 *   0 — clean (mode=off, recent review found, or override set)
 *   1 — warn (commit count > warn_at_commits but ≤ refuse_at_commits)
 *   2 — refuse (no recent review covering HEAD, OR commit count >
 *       refuse_at_commits, OR --strict elevated a warn to refuse)
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { resolveCommonRoot, resolveLocalRoot } from '../lib/worktree-roots.js';
import { appendAuditRecord } from '../audit/append.js';
import {
  LOCAL_REVIEW_TOOL_NAME,
  LOCAL_REVIEW_SKIPPED_OVERRIDE_TOOL_NAME,
  LOCAL_REVIEW_PREFLIGHT_SKIPPED_TOOL_NAME,
  LOCAL_REVIEW_SERVER_NAME,
  type LocalReviewSkippedOverrideMetadata,
} from '../audit/local-review-event.js';
import { CODEX_REVIEW_TOOL_NAME } from '../audit/codex-event.js';
import { computeTreeToken, EMPTY_TREE_SHA } from '../audit/content-token.js';
import { readHalt } from '../hooks/push-gate/halt.js';
import { Tier, InvocationStatus, type Policy } from '../policy/types.js';
import { loadPolicyAsync } from '../policy/loader.js';
import { err, log } from './utils.js';

/** Default max age for a local-review audit entry (24h). */
export const DEFAULT_MAX_AGE_SECONDS = 86_400;
/** Default bypass env-var name. */
export const DEFAULT_BYPASS_ENV_VAR = 'REA_SKIP_LOCAL_REVIEW';
/** Default commit-hygiene thresholds. */
export const DEFAULT_WARN_AT_COMMITS = 1;
export const DEFAULT_REFUSE_AT_COMMITS = 5;

export interface RunPreflightOptions {
  /**
   * Treat warn-tier commit-hygiene findings as refusals. Husky pre-push
   * always sets this — a warn that doesn't refuse is a useless warning
   * at the terminal layer.
   */
  strict?: boolean;
  /**
   * Skip the audit-log check. The commit-count check still runs. Used
   * by operators who explicitly want to defer review (audit-logged so
   * the deferral is forensically visible).
   */
  noReviewCheck?: boolean;
  /** Emit a single JSON line on stdout instead of pretty output. */
  json?: boolean;
  /**
   * 0.54.0 round-10 P1b — what the caller is gating. For `push`, the
   * content that leaves the machine is the COMMIT, so a coverage entry
   * whose content_token equals the PRISTINE tree of HEAD (a clean-tree
   * review of exactly the pushed commit, possibly from another
   * worktree) counts even when the caller's own working tree has
   * unrelated WIP. For `commit` (and when unset — the strict default),
   * the round-27 F3 semantics hold unchanged: a token mismatch is
   * authoritative staleness, because the tree being committed IS the
   * content under review.
   */
  operation?: 'push' | 'commit';
}

interface PreflightOutcome {
  status: 'clean' | 'warn' | 'refuse';
  reason: string;
  exitCode: 0 | 1 | 2;
  details: Record<string, unknown>;
}

/**
 * Run preflight in-process. Tests drive this directly. The CLI binding
 * exits via `process.exit` at the end of `runPreflight()`.
 */
export async function computePreflight(
  baseDir: string,
  options: RunPreflightOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ outcome: PreflightOutcome; policy: Policy | undefined }> {
  const policy = await tryLoadPolicy(baseDir);

  // 0.54.0 worktree state: policy + git resolution stay on the LOCAL
  // (worktree) root the caller passed; the audit chain — both the
  // coverage lookup and the skip-audit append — lives at the COMMON
  // (repository) root, so a review run in any worktree covers the same
  // sha pushed from another. Degenerate (plain checkout): identical.
  const commonRoot = resolveCommonRoot(baseDir).commonRoot;

  // Round-27 F4 fix: HALT check BEFORE every other path. The Bash-tier
  // `local-review-gate.sh` and the canonical husky BODY_TEMPLATE both
  // honor `.rea/HALT`, but `rea preflight` itself was missing the check —
  // direct invocations and the minimal `templates/pre-push.local-first.sh`
  // body bypassed the kill-switch entirely. The HALT check runs BEFORE
  // `mode === 'off'` so a halted repo cannot push even when local-review
  // enforcement is opted-out.
  const localHalt = readHalt(baseDir);
  const halt = localHalt.halted ? localHalt : readHalt(commonRoot);
  if (halt.halted) {
    return {
      outcome: {
        status: 'refuse',
        reason: `REA HALT: ${halt.reason ?? 'unknown'}`,
        exitCode: 2,
        details: {
          halt: true,
          halt_reason: halt.reason ?? 'unknown',
        },
      },
      policy,
    };
  }

  // Step 1: mode === 'off' → no-op clean exit.
  const mode = policy?.review?.local_review?.mode ?? 'enforced';
  if (mode === 'off') {
    return {
      outcome: {
        status: 'clean',
        reason: 'policy.review.local_review.mode is off',
        exitCode: 0,
        details: { mode: 'off' },
      },
      policy,
    };
  }

  const headSha = resolveHeadSha(baseDir);
  // 0.26.0 helix-026 finding-1: compute the current tree-token. Coverage
  // is matched on this in step 4 — `head_sha` is only used for forensics
  // (and as a back-compat fallback for legacy `codex.review` entries that
  // were written before content_token existed).
  const contentToken = computeTreeToken(baseDir);
  const bypassEnvVar = policy?.review?.local_review?.bypass_env_var ?? DEFAULT_BYPASS_ENV_VAR;
  const bypassReason = (env[bypassEnvVar] ?? '').trim();

  // Step 2: bypass env-var → audit + clean exit.
  if (bypassReason.length > 0) {
    const meta: LocalReviewSkippedOverrideMetadata = {
      head_sha: headSha,
      reason: bypassReason,
      bypass_env_var: bypassEnvVar,
    };
    await safeAudit(
      commonRoot,
      LOCAL_REVIEW_SKIPPED_OVERRIDE_TOOL_NAME,
      InvocationStatus.Allowed,
      meta as unknown as Record<string, unknown>,
      policy,
    );
    return {
      outcome: {
        status: 'clean',
        reason: `${bypassEnvVar} set (audited)`,
        exitCode: 0,
        details: { bypass_env_var: bypassEnvVar, reason: bypassReason },
      },
      policy,
    };
  }

  // Step 3: --no-review-check escape hatch (audit-logged).
  let reviewCheckSkipped = false;
  if (options.noReviewCheck === true) {
    reviewCheckSkipped = true;
    await safeAudit(
      commonRoot,
      LOCAL_REVIEW_PREFLIGHT_SKIPPED_TOOL_NAME,
      InvocationStatus.Allowed,
      { head_sha: headSha, reason: '--no-review-check flag' },
      policy,
    );
  }

  // Step 4: audit-log lookup (skipped under --no-review-check).
  const maxAgeSeconds =
    policy?.review?.local_review?.max_age_seconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!reviewCheckSkipped) {
    // Pristine token: only computed for PUSH gating (see the predicate's
    // round-10 P1b branch) — one `git rev-parse HEAD^{tree}` spawn.
    const pristineToken =
      options.operation === 'push' && headSha.length > 0
        ? resolveRef(baseDir, 'HEAD^{tree}')
        : '';
    const lookup = findRecentLocalReview(
      commonRoot,
      headSha,
      maxAgeSeconds,
      new Date(),
      contentToken,
      pristineToken,
    );
    if (!lookup.found) {
      // 0.28.0 round-29 P3: when the most recent path-matching audit
      // entry was blocking/error, the operator HAS reviewed — they
      // just need to address the findings. The original message ("no
      // recent local-review audit entry covers HEAD") makes them
      // think they forgot to review. Distinguish the two cases.
      const reason =
        lookup.last_blocking_verdict === 'blocking'
          ? 'your last local review was blocking — address findings or override'
          : lookup.last_blocking_verdict === 'error'
            ? 'your last local review errored — re-run `rea review` and address findings'
            : 'no recent local-review audit entry covers HEAD';
      return {
        outcome: {
          status: 'refuse',
          reason,
          exitCode: 2,
          details: {
            head_sha: headSha,
            content_token: contentToken,
            max_age_seconds: maxAgeSeconds,
            bypass_env_var: bypassEnvVar,
            policy_off_switch: 'policy.review.local_review.mode: off',
            ...(lookup.last_blocking_verdict !== undefined
              ? {
                  last_blocking_verdict: lookup.last_blocking_verdict,
                  last_blocking_timestamp: lookup.last_blocking_timestamp,
                }
              : {}),
          },
        },
        policy,
      };
    }
  }

  // Step 5: commit-count check.
  const warnAt = policy?.commit_hygiene?.warn_at_commits ?? DEFAULT_WARN_AT_COMMITS;
  const refuseAt = policy?.commit_hygiene?.refuse_at_commits ?? DEFAULT_REFUSE_AT_COMMITS;
  const commitCount = countCommitsAheadOfBase(baseDir);
  if (commitCount !== null) {
    if (commitCount > refuseAt) {
      return {
        outcome: {
          status: 'refuse',
          reason: `commit count ${commitCount} > refuse_at_commits=${refuseAt} — squash before pushing`,
          exitCode: 2,
          details: {
            commit_count: commitCount,
            warn_at_commits: warnAt,
            refuse_at_commits: refuseAt,
          },
        },
        policy,
      };
    }
    if (commitCount > warnAt) {
      const elevated = options.strict === true;
      return {
        outcome: {
          status: elevated ? 'refuse' : 'warn',
          reason: `commit count ${commitCount} > warn_at_commits=${warnAt}${elevated ? ' (strict)' : ''}`,
          exitCode: elevated ? 2 : 1,
          details: {
            commit_count: commitCount,
            warn_at_commits: warnAt,
            refuse_at_commits: refuseAt,
            strict: elevated,
          },
        },
        policy,
      };
    }
  }

  return {
    outcome: {
      status: 'clean',
      reason: reviewCheckSkipped
        ? 'review check skipped, commit-hygiene clean'
        : 'recent local-review audit entry covers HEAD',
      exitCode: 0,
      details: { head_sha: headSha, content_token: contentToken, commit_count: commitCount },
    },
    policy,
  };
}

export async function runPreflight(options: RunPreflightOptions): Promise<void> {
  // Round-31 P3: normalize to the checkout root — `rea preflight` from
  // a subdirectory of a linked worktree must read HALT/coverage from
  // the worktree root and the shared common root, not `<subdir>/.rea`.
  const baseDir = resolveLocalRoot(process.cwd());
  const { outcome } = await computePreflight(baseDir, options);

  if (options.json === true) {
    process.stdout.write(JSON.stringify({ ...outcome }) + '\n');
  } else {
    if (outcome.exitCode === 0) {
      log(`preflight clean — ${outcome.reason}`);
    } else if (outcome.exitCode === 1) {
      console.warn(`[rea] preflight WARN — ${outcome.reason}`);
    } else {
      err(`preflight refuse — ${outcome.reason}`);
      console.error('');
      console.error('  To unblock, do ONE of:');
      console.error('    1. Run `rea review`           — write a fresh local-review audit entry');
      console.error('    2. Set REA_SKIP_LOCAL_REVIEW="<reason>"');
      console.error('                                  — per-invocation override (audited)');
      console.error('    3. Edit .rea/policy.yaml      — set:');
      console.error('         review:');
      console.error('           local_review:');
      console.error('             mode: off');
      console.error('       (use this if your team does not have codex/claude installed)');
      console.error('');
    }
  }
  process.exit(outcome.exitCode);
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

async function tryLoadPolicy(baseDir: string): Promise<Policy | undefined> {
  try {
    return await loadPolicyAsync(baseDir);
  } catch {
    return undefined;
  }
}

function resolveHeadSha(baseDir: string): string {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: baseDir, encoding: 'utf8' });
  if (r.status !== 0) {
    // Round-27 F2 fix: unborn-HEAD repos return EMPTY_TREE_SHA so the
    // reader stays symmetric with `rea review`'s writer (which uses the
    // same constant when HEAD can't be resolved — see review.ts). Pre-fix
    // the reader returned '' and the both-empty guard in
    // `findRecentLocalReview` rejected the just-written audit entry,
    // deadlocking `git init → rea review → git commit` under
    // `refuse_at: both`.
    return EMPTY_TREE_SHA;
  }
  const sha = (r.stdout ?? '').toString().trim();
  return sha.length > 0 ? sha : EMPTY_TREE_SHA;
}

/**
 * Resolve the divergence base for commit-counting. The intent is "how
 * many commits will this push deliver to TRUNK" — not "how many commits
 * are unpushed on this branch". Order trunk-equivalent refs first.
 *
 * Order (0.26.0 helix-026 finding-3):
 *   1. `origin/HEAD` (the default branch on origin — usually `main`)
 *   2. `origin/main`
 *   3. `origin/master`
 *   4. `@{upstream}` (LAST RESORT — see warning below)
 *
 * # Why `@{upstream}` is last
 *
 * After `git push -u origin <branch>`, `@{upstream}` resolves to
 * `origin/<branch>` — the branch's OWN remote tip, NOT trunk. If
 * preflight's commit-count check were keyed to that, a 50-commit
 * feature branch would always count "0" once pushed, defeating
 * `refuse_at_commits` on the very long-lived branches the policy was
 * designed to discourage.
 *
 * `@{upstream}` is preserved as the absolute fallback for repos with no
 * `origin` (forks, mirrors, weird CI clones). When `@{upstream}` is the
 * only resolvable base AND it points to a non-trunk ref, preflight
 * accepts the no-op cost — the audit-log review check is the primary
 * gate; commit-count is best-effort.
 *
 * Additional guard: when `@{upstream}` resolves to a ref under
 * `refs/remotes/origin/` other than the default branch, we skip it.
 * This catches the typical `git push -u origin <feature>` case while
 * still allowing `@{upstream}` -> `origin/main` to work for branches
 * whose upstream IS trunk.
 *
 * Returns null when none resolve — `rea preflight` then skips the
 * commit-count check (best-effort; the audit-log check is the primary
 * gate).
 */
function resolveCommitCountBase(baseDir: string): string | null {
  // Trunk-equivalent refs first. `@{upstream}` is held back as a
  // last-resort because it can resolve to the branch's own remote tip
  // and turn the gate into a no-op — see the docblock above.
  const primary = ['origin/HEAD', 'origin/main', 'origin/master'];
  for (const ref of primary) {
    if (resolveRef(baseDir, ref).length > 0) return ref;
  }
  // 0.28.0 round-29 P3: develop-branch repos sometimes omit
  // `origin/HEAD` entirely (the symbolic ref is unset until a fresh
  // `git remote set-head origin -a`), and `origin/main` /
  // `origin/master` may not exist when the trunk is `origin/develop`.
  // Pre-fix the resolver silently fell through to `null`, disabling
  // the auto-narrow check without telling the operator. Emit a single
  // advisory line on stderr so the failure mode is visible — but do
  // not fail; this path is best-effort and a missing trunk is a
  // recoverable misconfiguration.
  if (resolveRef(baseDir, 'origin/develop').length > 0) {
    process.stderr.write(
      `rea: preflight commit-count base falling through to origin/develop ` +
        `(origin/HEAD/main/master not resolvable). ` +
        `Consider: \`git remote set-head origin -a\` to seed origin/HEAD.\n`,
    );
    return 'origin/develop';
  }

  // `@{upstream}` LAST. We additionally probe what it resolves to —
  // if it's a remote feature-branch ref under `refs/remotes/origin/`
  // (not a primary trunk ref we already tried), the candidate is
  // useless for commit-counting and we skip it rather than silently
  // turn the check into a no-op.
  const upstreamSymbolic = resolveSymbolicRef(baseDir, '@{upstream}');
  if (upstreamSymbolic.length > 0) {
    // `git rev-parse --abbrev-ref @{upstream}` returns e.g.
    // `origin/main` or `origin/feat/foo`. If the resolved ref matches
    // origin/<branch> for any branch we DIDN'T already try as a primary
    // candidate, it's a feature-tracking upstream — skip.
    const isFeatureUpstream =
      upstreamSymbolic.startsWith('origin/') &&
      !primary.includes(upstreamSymbolic);
    if (!isFeatureUpstream) {
      // Upstream IS a trunk-equivalent ref (origin/main / origin/master /
      // a non-origin remote). Use it.
      if (resolveRef(baseDir, '@{upstream}').length > 0) return '@{upstream}';
    }
    // Feature-tracking upstream: deliberately skipped to avoid the
    // "50-commit branch counts 0" no-op. Fall through.
  }

  return null;
}

function resolveRef(baseDir: string, ref: string): string {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], {
    cwd: baseDir,
    encoding: 'utf8',
  });
  if (r.status !== 0) return '';
  return (r.stdout ?? '').toString().trim();
}

function resolveSymbolicRef(baseDir: string, ref: string): string {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', ref], {
    cwd: baseDir,
    encoding: 'utf8',
  });
  if (r.status !== 0) return '';
  return (r.stdout ?? '').toString().trim();
}

function countCommitsAheadOfBase(baseDir: string): number | null {
  const base = resolveCommitCountBase(baseDir);
  if (base === null) return null;
  const r = spawnSync('git', ['rev-list', '--count', `${base}..HEAD`], {
    cwd: baseDir,
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const n = Number((r.stdout ?? '').toString().trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Tail `.rea/audit.jsonl` for the most recent matching local-review
 * entry. We accept BOTH `rea.local_review` (canonical) and
 * `codex.review` (back-compat from pre-0.26.0 audit data) so existing
 * users with prior reviews don't have to re-review on upgrade.
 *
 * Streaming approach: read the whole file (audit logs are typically
 * < 10 MB even after months of use) and walk lines from the end. The
 * audit log is append-only and timestamps are monotonic per writer.
 *
 * # Coverage matching (0.26.0 helix-026 finding-1)
 *
 * The first valid `metadata.content_token` on each record wins:
 *
 *   1. Record has `content_token` AND caller supplied `contentToken` →
 *      exact-string match. Stable across `--amend` / fixup rebases.
 *   2. Record has NO `content_token` (legacy `codex.review` entry, or
 *      a future provider that can't compute one) → fall back to
 *      exact-string `head_sha` match. Pre-0.26.0 reviews still cover.
 *   3. Record has `content_token` but caller's `contentToken` is empty
 *      (preflight on a non-git directory or detached state) → fall back
 *      to `head_sha` match. The content path is the additive layer; the
 *      head-sha layer remains as the floor.
 *
 * Hierarchy invariant: an entry is valid coverage when EITHER the token
 * matches OR the head_sha matches. The two are not AND-ed — that would
 * make legacy entries un-matchable and would break the local-first loop
 * back to the old "commit first, then review" inversion.
 */
export interface LocalReviewLookupResult {
  found: boolean;
  /** Audit-record metadata payload, when found. */
  metadata?: Record<string, unknown>;
  /** ISO timestamp on the matching record. */
  timestamp?: string;
  /** Tool name that matched (canonical or legacy). */
  tool_name?: string;
  /**
   * Which match-path validated this entry. Useful for tests and for the
   * `--json` outcome: `'content_token'` (preferred), `'head_sha'`
   * (back-compat / fallback).
   */
  match_kind?: 'content_token' | 'head_sha';
  /**
   * 0.28.0 round-29 P3 — set when the most recent path-matching audit
   * entry for this HEAD had verdict `blocking` (or `error`) and was
   * therefore skipped as "not coverage". Surfacing this lets the
   * preflight caller render a clearer message than "no recent local-
   * review audit entry covers HEAD" — the operator hasn't forgotten
   * to review, they've already done one and it told them to fix
   * findings.
   */
  last_blocking_verdict?: 'blocking' | 'error';
  /** ISO timestamp of the last blocking entry, when present. */
  last_blocking_timestamp?: string;
}

export function findRecentLocalReview(
  baseDir: string,
  headSha: string,
  maxAgeSeconds: number,
  now: Date = new Date(),
  contentToken: string = '',
  pristineToken: string = '',
): LocalReviewLookupResult {
  // 0.26.0 helix-026 finding-1: callers can match by content_token,
  // head_sha, or both. We need at least ONE non-empty key — without
  // either the function would match every record indiscriminately.
  if (headSha.length === 0 && contentToken.length === 0) return { found: false };
  const auditPath = path.join(baseDir, '.rea', 'audit.jsonl');
  if (!fs.existsSync(auditPath)) return { found: false };
  let raw: string;
  try {
    raw = fs.readFileSync(auditPath, 'utf8');
  } catch {
    return { found: false };
  }
  const lines = raw.split(/\r?\n/);
  const cutoffMs = now.getTime() - maxAgeSeconds * 1000;
  // 0.28.0 round-29 P3: track the most recent blocking/error entry that
  // path-matched HEAD even though it didn't qualify as coverage. The
  // not-found return path consumes this so the operator-facing message
  // distinguishes "you haven't reviewed" from "your review found
  // problems".
  let lastBlockingVerdict: 'blocking' | 'error' | undefined;
  let lastBlockingTimestamp: string | undefined;
  // Walk in reverse — most recent first.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const toolName = typeof record.tool_name === 'string' ? record.tool_name : '';
    if (toolName !== LOCAL_REVIEW_TOOL_NAME && toolName !== CODEX_REVIEW_TOOL_NAME) {
      continue;
    }
    const status = typeof record.status === 'string' ? record.status : '';
    // Skipped/error variants are not coverage. `denied` (blocking verdict)
    // is also not coverage — preflight's job is to ensure a successful
    // recent review, not just any review.
    if (status !== 'allowed') continue;
    const metadata = (record.metadata ?? {}) as Record<string, unknown>;
    const recordedSha = typeof metadata.head_sha === 'string' ? metadata.head_sha : '';
    const recordedToken =
      typeof metadata.content_token === 'string' ? metadata.content_token : '';

    // Coverage match: prefer content_token (stable across --amend), fall
    // back to head_sha for legacy entries / providers that can't compute
    // a token. See block-comment above for the full hierarchy.
    //
    // Round-27 F3 fix: when BOTH sides have a content_token but they
    // DISAGREE, the entry is stale — the working-tree content has changed
    // since the review was written. Pre-fix the `else if` ran whenever
    // the first branch failed, INCLUDING real token mismatch, which
    // silently fell back to head_sha matching. PoC: `rea review` writes
    // T1, operator edits one tracked file (no commit), `git commit`
    // under `refuse_at: commit` → preflight approves the commit because
    // HEAD hasn't moved, defeating the whole content-token path.
    //
    // Fix: when both tokens are present, the comparison is authoritative —
    // mismatch means stale, no fallback. Only when the entry is missing
    // a content_token (legacy `codex.review`) OR the caller's contentToken
    // is empty (non-git directory) do we fall through to head_sha.
    let matchKind: 'content_token' | 'head_sha' | null = null;
    if (recordedToken.length > 0 && contentToken.length > 0) {
      // Both sides have a token — token comparison is AUTHORITATIVE.
      if (recordedToken === contentToken) matchKind = 'content_token';
      else if (
        pristineToken.length > 0 &&
        recordedToken === pristineToken &&
        recordedSha.length > 0 &&
        headSha.length > 0 &&
        recordedSha === headSha
      ) {
        // 0.54.0 round-10 P1b (PUSH callers only — the caller supplies
        // pristineToken exclusively for push gating): the entry reviewed
        // the CLEAN tree of exactly this commit. The caller's own WIP
        // is not part of what a push ships, so a clean-tree review of
        // the pushed sha — typically written from another worktree —
        // is coverage. The round-27 F3 defense is untouched: commit
        // gating never passes a pristineToken, so a dirtied tree still
        // refuses there.
        matchKind = 'head_sha';
      }
      // Any other token mismatch: this entry is stale. Do NOT fall back.
    } else if (recordedSha.length > 0 && headSha.length > 0 && recordedSha === headSha) {
      // No token on this entry (or caller). Legacy / non-git fallback.
      matchKind = 'head_sha';
    }
    if (matchKind === null) continue;

    const verdict = typeof metadata.verdict === 'string' ? metadata.verdict : '';
    if (verdict === 'error' || verdict === 'blocking') {
      // 0.28.0 round-29 P3 — capture the FIRST (i.e., most-recent in
      // reverse walk) blocking/error entry that path-matched HEAD so
      // the not-found path can render a better message. Don't
      // overwrite a later catch — we want the most-recent one.
      if (lastBlockingVerdict === undefined) {
        lastBlockingVerdict = verdict as 'blocking' | 'error';
        const ts = typeof record.timestamp === 'string' ? record.timestamp : '';
        if (ts.length > 0) lastBlockingTimestamp = ts;
      }
      continue;
    }
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
    if (timestamp.length > 0) {
      const ts = Date.parse(timestamp);
      if (Number.isFinite(ts) && ts < cutoffMs) {
        // Older than max_age_seconds — keep walking; a more recent valid
        // record may exist further back? No: we walk newest-to-oldest so
        // anything older from here on is also stale. Stop early.
        return {
          found: false,
          ...(lastBlockingVerdict !== undefined ? { last_blocking_verdict: lastBlockingVerdict } : {}),
          ...(lastBlockingTimestamp !== undefined
            ? { last_blocking_timestamp: lastBlockingTimestamp }
            : {}),
        };
      }
    }
    return {
      found: true,
      metadata,
      timestamp,
      tool_name: toolName,
      match_kind: matchKind,
    };
  }
  return {
    found: false,
    ...(lastBlockingVerdict !== undefined ? { last_blocking_verdict: lastBlockingVerdict } : {}),
    ...(lastBlockingTimestamp !== undefined
      ? { last_blocking_timestamp: lastBlockingTimestamp }
      : {}),
  };
}

async function safeAudit(
  baseDir: string,
  toolName: string,
  status: InvocationStatus,
  metadata: Record<string, unknown>,
  policy: Policy | undefined,
): Promise<void> {
  try {
    const cleanMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (v !== undefined) cleanMeta[k] = v;
    }
    await appendAuditRecord(baseDir, {
      tool_name: toolName,
      server_name: LOCAL_REVIEW_SERVER_NAME,
      tier: Tier.Read,
      status,
      ...(Object.keys(cleanMeta).length > 0 ? { metadata: cleanMeta } : {}),
      ...(policy !== undefined ? { policy } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`rea: audit append failed (${toolName}): ${msg}\n`);
  }
}

/**
 * Attach `rea preflight` to a commander Program.
 */
export function registerPreflightCommand(program: Command): void {
  program
    .command('preflight')
    .description(
      'Local-first enforcement workhorse. Refuses (exit 2) when no recent `rea.local_review` audit entry covers HEAD, when commit-hygiene thresholds are exceeded, or when the kill-switch is active. Exit 0 (clean) / 1 (warn) / 2 (refuse). Husky pre-push and the Bash-tier `local-review-gate.sh` hook both delegate here.',
    )
    .option(
      '--strict',
      'treat commit-hygiene warns as refusals (exit 2 instead of 1). Always set by husky pre-push.',
    )
    .option(
      '--no-review-check',
      'skip the audit-log lookup (still runs commit-hygiene). Audit-logged escape hatch — different from the per-invocation env-var override.',
    )
    .option('--json', 'emit a single-line JSON outcome instead of human-readable output')
    .option(
      '--operation <op>',
      "what is being gated: 'push' enables the pristine-tree coverage fallback (a clean-tree review of exactly the pushed sha — typically from another worktree — counts even with local WIP); 'commit'/unset keeps token-authoritative staleness (round-27 F3). Husky pre-push passes 'push'.",
    )
    .action(async (opts: { strict?: boolean; reviewCheck?: boolean; json?: boolean; operation?: string }) => {
      // Commander negation: --no-review-check sets opts.reviewCheck = false.
      // We invert to noReviewCheck for clarity in the runner.
      const noReviewCheck = opts.reviewCheck === false;
      const operation =
        opts.operation === 'push' || opts.operation === 'commit' ? opts.operation : undefined;
      await runPreflight({
        ...(operation !== undefined ? { operation } : {}),
        ...(opts.strict === true ? { strict: true } : {}),
        ...(noReviewCheck ? { noReviewCheck: true } : {}),
        ...(opts.json === true ? { json: true } : {}),
      });
    });
}
