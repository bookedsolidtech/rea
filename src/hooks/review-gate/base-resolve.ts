/**
 * Base-ref resolution for the push-review gate.
 *
 * ## What "base resolution" means
 *
 * Given a pushed refspec (a `local_sha` + `remote_ref` pair, plus the
 * remote name), determine:
 *
 *   1. the commit SHA the local changes should be diffed against
 *      (the "merge base"), and
 *   2. the human-facing label for the `Target:` banner line
 *      (defect N semantic: the SEMANTIC base, not the refspec destination).
 *
 * The four code paths the bash core walked (push-review-core.sh §720-889):
 *
 *   A. Tracked-branch push (`remote_sha != ZERO`). Use
 *      `git merge-base <remote_sha> <local_sha>`. Label = refspec target.
 *   B. New-branch push with `branch.<source>.base` config (defect N). The
 *      operator opted into a specific base. Prefer `refs/remotes/<remote>/
 *      <configured>` if it exists, else fall back to `refs/heads/<configured>`
 *      with a WARN on stderr. Label = configured base name.
 *   C. New-branch push without config, with `refs/remotes/<remote>/HEAD`
 *      resolvable. Use that symbolic-ref as the anchor. Label = refspec
 *      target (preserves the cache-key contract for bare pushes).
 *   D. Bootstrap: no config, no symbolic-ref, probe `main` then `master`.
 *      If both fail, anchor on the empty-tree SHA so the full push content
 *      is reviewable. Label = refspec target.
 *
 * ## Phase 2a scope (this file)
 *
 * `resolveBaseForRefspec()` composes the four paths via the `GitRunner`
 * port from `diff.ts`. This module is pure in the same sense `diff.ts`
 * is — every git hit goes through the injected runner, so unit tests
 * enumerate the four paths without touching a real repo.
 *
 * Defect-N fail-loud (design §7) is Phase 4's final cutover and is NOT
 * turned on here. `NoBaseResolvableError` is reserved in `errors.ts` but
 * the empty-tree bootstrap remains the current production fallback.
 * Phase 2b composes the final policy into `runPushReviewGate()`.
 */

import { EMPTY_TREE_SHA, ZERO_SHA } from './constants.js';
import {
  type GitRunner,
  hasCommitLocally,
  mergeBase,
  readGitConfig,
  refExists,
  resolveRemoteDefaultRef,
} from './diff.js';
import type { RefspecRecord } from './args.js';

/**
 * Resolved base outcome for a single refspec. Never thrown — callers
 * translate blocked conditions (remote object missing, no merge-base)
 * into `BlockedError` subclasses up the stack.
 */
export interface ResolvedBase {
  /**
   * The commit / tree SHA to diff against. Always set when
   * `status === 'ok'`; otherwise null.
   */
  merge_base: string | null;
  /**
   * The human-facing `Target:` label (defect N). The bash core defaults
   * this to the refspec target and promotes it to the configured base's
   * short name only when `branch.<source>.base` resolved. We mirror that.
   */
  target_label: string;
  /** Discriminator for the caller. */
  status:
    | 'ok'
    | 'remote_object_missing'
    | 'no_merge_base'
    | 'no_base_resolvable'; // reserved for defect-N fail-loud in Phase 4
  /**
   * For the "tracked branch but the remote commit isn't locally present"
   * path, return the remote SHA so the caller's banner can echo it. Empty
   * otherwise.
   */
  remote_sha?: string;
  /**
   * True when the configured-base branch was resolved via the LOCAL ref
   * (`refs/heads/<configured>`) instead of the remote-tracking ref. The
   * bash core prints a WARN in this case (push-review-core.sh §819-820).
   * Phase 2a carries the signal; Phase 2b's composition emits the banner.
   */
  local_ref_fallback_warning?: string;
  /**
   * The resolution path taken. Audit + debugging aid; never part of the
   * cache key. Phase 2b's audit records include this for forensic trace.
   */
  path: 'tracked' | 'new_branch_config' | 'new_branch_origin_head' | 'bootstrap_empty_tree';
}

/**
 * Deps for base resolution. Same `GitRunner` port `diff.ts` uses; plus the
 * remote name (from the adapter's argv, defaults to `origin`). `cwd` is
 * the resolved repo root.
 */
export interface ResolveBaseDeps {
  runner: GitRunner;
  cwd: string;
  /** Remote name (`origin` by convention, but respect what git passed to the hook). */
  remote: string;
}

/**
 * Strip `refs/heads/` / `refs/for/` prefixes from a ref and return the
 * trailing branch name. Used for the target-label normalization path
 * where both ref families should collapse to a bare branch name for
 * display. Exported for tests.
 */
export function stripRefsPrefix(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/for/')) return ref.slice('refs/for/'.length);
  return ref;
}

/**
 * Strip ONLY the `refs/heads/` prefix — leaves `refs/for/`, `refs/tags/`,
 * and every other ref-namespace untouched. Mirrors the bash core's
 * `${local_ref#refs/heads/}` on the source-branch lookup path (push-review-
 * core.sh §797), so Gerrit-style pushes (`refs/for/main`) keep their
 * namespace and do NOT accidentally match a `branch.main.base` config
 * entry intended for a regular branch push.
 *
 * Codex pass-1 on Phase 2a flagged the earlier implementation that used
 * `stripRefsPrefix` here — it would have promoted the Target: label for
 * a Gerrit push against the reviewer's intent. Exported for tests.
 */
export function stripRefsHeadsOnly(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  return ref;
}

/**
 * Resolve the base anchor for a single push refspec. See the file-top
 * docstring for the four code paths.
 *
 * Deletion refspecs (local_sha === ZERO_SHA) return `{merge_base: null,
 * status: 'ok'}` with `path: 'tracked'` — the caller is expected to have
 * already trapped deletions via `hasDeletion()` before calling here. We
 * don't throw in that case because the caller owns the deletion policy,
 * not this resolver.
 */
export function resolveBaseForRefspec(
  record: RefspecRecord,
  deps: ResolveBaseDeps,
): ResolvedBase {
  const { runner, cwd } = deps;
  const targetLabel = computeInitialTargetLabel(record);

  // Deletion — caller owns the policy.
  if (record.is_deletion) {
    return {
      merge_base: null,
      target_label: targetLabel,
      status: 'ok',
      path: 'tracked',
    };
  }

  // Path A: tracked-branch push (remote_sha is not ZERO). Existing
  // history is available; merge-base against the remote's tip.
  if (record.remote_sha !== ZERO_SHA) {
    if (!hasCommitLocally(runner, cwd, record.remote_sha)) {
      return {
        merge_base: null,
        target_label: targetLabel,
        status: 'remote_object_missing',
        remote_sha: record.remote_sha,
        path: 'tracked',
      };
    }
    const mb = mergeBase(runner, cwd, record.remote_sha, record.local_sha);
    if (mb === null) {
      return {
        merge_base: null,
        target_label: targetLabel,
        status: 'no_merge_base',
        remote_sha: record.remote_sha,
        path: 'tracked',
      };
    }
    return {
      merge_base: mb,
      target_label: targetLabel,
      status: 'ok',
      path: 'tracked',
    };
  }

  // Path B/C/D: new-branch push. Need a server-authoritative anchor.
  //
  // Bash-core parity (push-review-core.sh §797): the source-branch lookup
  // uses `${local_ref#refs/heads/}` — strips ONLY the `refs/heads/`
  // prefix. For a Gerrit-style `refs/for/main` push, bash leaves the ref
  // as `refs/for/main`, the `branch.refs/for/main.base` config key never
  // matches, and the new-branch walk proceeds to the origin/HEAD /
  // bootstrap path. We mirror that exactly: use `stripRefsHeadsOnly`
  // rather than the more aggressive `stripRefsPrefix` (which also strips
  // `refs/for/`). The aggressive strip was a Phase 1 carry-over from
  // `args.ts`'s destination-ref normalization; applied here it would
  // cause a `refs/for/main` push to look up `branch.main.base` and
  // potentially promote the Target: label against the reviewer's
  // intent. Codex pass-1 on Phase 2a flagged this (P3) and we preserve
  // byte-for-byte bash parity.
  const sourceBranch = stripRefsHeadsOnly(record.local_ref);
  const newBranchOutcome = resolveNewBranchBase(sourceBranch, deps);

  if (newBranchOutcome.kind === 'config_hit') {
    // Defect N: promote the target label to the configured base's short
    // name. The bash core does this ONLY when the config hit fires — for
    // all other new-branch paths the label stays as the refspec target
    // (preserves cache-key / label continuity for pre-config consumers).
    //
    // `exactOptionalPropertyTypes: true` in tsconfig means we must NOT
    // set `local_ref_fallback_warning: undefined` — we either include the
    // key (as a string) or omit it entirely. Spread the conditional.
    const result: ResolvedBase = {
      merge_base:
        mergeBase(runner, cwd, newBranchOutcome.ref, record.local_sha) ?? EMPTY_TREE_SHA,
      target_label: newBranchOutcome.label,
      status: 'ok',
      path: 'new_branch_config',
    };
    if (newBranchOutcome.warning !== null) {
      result.local_ref_fallback_warning = newBranchOutcome.warning;
    }
    return result;
  }

  if (newBranchOutcome.kind === 'origin_head') {
    return {
      merge_base:
        mergeBase(runner, cwd, newBranchOutcome.ref, record.local_sha) ?? EMPTY_TREE_SHA,
      target_label: targetLabel,
      status: 'ok',
      path: 'new_branch_origin_head',
    };
  }

  // Bootstrap: no config, no remote HEAD — anchor on the empty-tree SHA
  // so the full push content is reviewable. Matches bash §887.
  return {
    merge_base: EMPTY_TREE_SHA,
    target_label: targetLabel,
    status: 'ok',
    path: 'bootstrap_empty_tree',
  };
}

/**
 * Compute the initial `Target:` label for a refspec: the short name of
 * the remote ref, falling back to `main` when it's empty (defensive;
 * `args.ts` should never emit an empty remote_ref for a non-deletion).
 *
 * Exported for unit tests. Mirrors push-review-core.sh §725-727.
 */
export function computeInitialTargetLabel(record: RefspecRecord): string {
  let target = stripRefsPrefix(record.remote_ref);
  if (target.length === 0) target = 'main';
  return target;
}

/**
 * Inner helper: resolve the new-branch anchor via the B→C→D walk. Stays
 * module-private so callers only see `resolveBaseForRefspec` as the
 * public surface. Returns a discriminated union so the caller can branch
 * on path + extract the warning / label cleanly.
 */
type NewBranchOutcome =
  | {
      kind: 'config_hit';
      ref: string;
      label: string;
      /** Non-null when we fell back to `refs/heads/<base>` (§819-820 WARN). */
      warning: string | null;
    }
  | { kind: 'origin_head'; ref: string }
  | { kind: 'bootstrap' };

/**
 * Path B: consult `branch.<source>.base`. Returns `config_hit` iff a base
 * was configured AND resolvable to a ref that exists. Falls through
 * otherwise. Exported so tests can exercise the config-path independently.
 */
export function resolveNewBranchBase(
  sourceBranch: string,
  deps: ResolveBaseDeps,
): NewBranchOutcome {
  const { runner, cwd, remote } = deps;

  // B — branch.<source>.base config hit.
  if (sourceBranch.length > 0 && sourceBranch !== 'HEAD') {
    const configuredBase = readGitConfig(runner, cwd, `branch.${sourceBranch}.base`);
    if (configuredBase.length > 0) {
      const remoteRef = `refs/remotes/${remote}/${configuredBase}`;
      const localRef = `refs/heads/${configuredBase}`;
      if (refExists(runner, cwd, remoteRef)) {
        return {
          kind: 'config_hit',
          ref: remoteRef,
          label: configuredBase,
          warning: null,
        };
      }
      if (refExists(runner, cwd, localRef)) {
        // Bash-core §819-820: local-ref fallback is less trustworthy; emit
        // a WARN so the reviewer knows the anchor may be stale.
        const warning =
          `WARN: branch.${sourceBranch}.base=${configuredBase} resolved to local ref; ` +
          `remote counterpart ${remote}/${configuredBase} missing — reviewer-side diff may be stale`;
        return {
          kind: 'config_hit',
          ref: localRef,
          label: configuredBase,
          warning,
        };
      }
      // Config key set but neither ref exists: fall through to origin/HEAD
      // (bash does the same — `configured_base` stays non-empty, but
      // `default_ref` is still empty so the OR at §844 takes over).
    }
  }

  // C — refs/remotes/<remote>/HEAD.
  const symbolic = resolveRemoteDefaultRef(runner, cwd, remote);
  if (symbolic !== null && symbolic.length > 0) {
    return { kind: 'origin_head', ref: symbolic };
  }

  // C-bis — fall-back probes: `main`, then `master`. Bash §834-843 probes
  // both because symbolic-ref fails on shallow or mirror clones where
  // origin/HEAD was never set.
  const mainRef = `refs/remotes/${remote}/main`;
  if (refExists(runner, cwd, mainRef)) {
    return { kind: 'origin_head', ref: mainRef };
  }
  const masterRef = `refs/remotes/${remote}/master`;
  if (refExists(runner, cwd, masterRef)) {
    return { kind: 'origin_head', ref: masterRef };
  }

  // D — bootstrap.
  return { kind: 'bootstrap' };
}
