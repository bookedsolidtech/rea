/**
 * Base-branch resolution for the push-gate.
 *
 * Codex `exec review --base <ref>` needs a git ref to diff against. The
 * caller may provide one via `rea hook push-gate --base <ref>`; if they
 * don't, we resolve it in priority order:
 *
 *   1. Current branch's upstream (`@{upstream}`) — the branch the operator
 *      configured as their tracking ref. Most accurate since it matches
 *      what `git push` is about to compare against.
 *   2. `origin/HEAD` symbolic ref (e.g. `refs/remotes/origin/main`). Set
 *      automatically by `git clone` and `git remote set-head`.
 *   3. Explicit probes: `origin/main` → `origin/master` via rev-parse.
 *   4. Local `main` / `master` — last resort when the clone has no remote
 *      tracking refs yet (freshly initialized sibling project, mirror
 *      clone).
 *
 * On total failure we surface the sentinel `empty-tree` SHA
 * (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) so the diff covers every
 * file in HEAD. First pushes to a fresh remote still get reviewed — the
 * 0.10.x fail-open at this resolution step was defect J.
 *
 * All git commands are invoked via the injected `GitExecutor` — tests
 * replace it with a fake to avoid shelling out.
 */

import type { GitExecutor } from './codex-runner.js';

export interface BaseResolution {
  /**
   * Resolved ref (branch, remote-tracking ref, or 40-char SHA). Always
   * usable as the `--base` argument to `codex exec review`.
   */
  ref: string;
  /** Where the ref came from — surfaces in audit records and stderr. */
  source:
    | 'explicit'
    | 'last-n-commits'
    | 'upstream'
    | 'origin-head'
    | 'origin-main'
    | 'origin-master'
    | 'local-main'
    | 'local-master'
    | 'empty-tree';
  /**
   * Set when `last-n-commits` was requested but `<headRef>~N` did not
   * resolve at the requested depth (shallower-than-N clone, or N larger
   * than the branch history). The resolver clamps to the deepest
   * reachable commit (`<headRef>~K` for the largest `K <= N` that does
   * resolve) and surfaces both numbers so the caller can emit a stderr
   * warning ("requested N=50; clamped to K=12 (oldest reachable)").
   * Present on both `last-n-commits` results (when clamped) and
   * `empty-tree` results (when even `~1` was unreachable — orphan or
   * single-commit branch).
   */
  lastNCommitsRequested?: number;
  /**
   * The N value actually used. When source is `last-n-commits`, this is
   * the depth that resolved (equals `lastNCommitsRequested` on full
   * resolution; smaller when clamped to a shallow clone). Surfaces in
   * audit metadata so operators can grep their audit log for narrowed
   * reviews.
   */
  lastNCommits?: number;
}

/**
 * Well-known empty-tree SHA: `git hash-object -t tree /dev/null`. Every git
 * installation carries this object implicitly. Using it as a fallback lets
 * a review on a clone with no tracking refs still exercise the entire HEAD
 * tree diff.
 */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface ResolveBaseOptions {
  /**
   * Explicit ref from `--base <ref>` or equivalent. When set, the resolver
   * returns it unchanged with `source: 'explicit'` — the caller is
   * responsible for its correctness. We do NOT validate that it exists;
   * that's Codex's job (it'll error clearly if the ref is bad).
   */
  explicit?: string;
  /**
   * Resolve the base to `HEAD~N` instead of running the upstream ladder.
   * `--last-n-commits N` flag and `policy.review.last_n_commits` map
   * here. Ignored when `explicit` is set (explicit ref wins). When
   * `<headRef>~N` does not resolve (shallower-than-N clone, or branch
   * history shorter than N), the resolver CLAMPS to the deepest
   * reachable commit (`<headRef>~K` for the largest `K <= N` that does
   * resolve) — i.e. it diffs against the oldest commit on the branch.
   * It does NOT fall back to the empty-tree sentinel; that would
   * silently expand "the last N commits" to "the entire repository
   * snapshot" on a normal repo with a short feature branch, flooding
   * Codex with unchanged base-branch files. The resolver only emits
   * `source: 'empty-tree'` when even `<headRef>~1` cannot be resolved
   * (orphan branch, single-commit history); in that case
   * `lastNCommitsRequested: N` is set so the caller can warn.
   */
  lastNCommits?: number;
  /**
   * The head ref the gate is reviewing. Defaults to literal "HEAD" — i.e.
   * the local checkout's tip. When the gate is invoked via pre-push and
   * the pushed ref is not the current branch (e.g.
   * `git push origin some-other-branch`), the caller passes the pushed
   * `<sha>` here so `last-n-commits` resolves `<sha>~N` rather than
   * `HEAD~N`. Without this thread-through the review walks back N commits
   * from the local checkout, which can be a different branch entirely.
   */
  headRef?: string;
}

/**
 * Resolve the base ref using the configured priority order. Never throws —
 * every failure mode degrades to the next step, and the worst case (no
 * tracking refs, no local main/master) is `empty-tree`.
 */
export function resolveBaseRef(git: GitExecutor, options: ResolveBaseOptions = {}): BaseResolution {
  if (options.explicit !== undefined && options.explicit.length > 0) {
    return { ref: options.explicit, source: 'explicit' };
  }

  // 0. Last-N-commits override. Caller (CLI flag or policy key) requested
  //    diffing against `HEAD~N` directly. Resolves to a 40-char SHA via
  //    `git rev-parse HEAD~N`; on failure (shallower-than-N clone, or N
  //    larger than the branch's history depth) we fall back to the
  //    empty-tree sentinel and surface `lastNCommitsRequested` so the
  //    caller can emit a stderr warning. We deliberately resolve to a
  //    SHA rather than passing `HEAD~N` through to Codex — Codex shells
  //    out to `git diff` itself, but a SHA is unambiguous regardless of
  //    intermediate ref churn.
  if (options.lastNCommits !== undefined && options.lastNCommits > 0) {
    // Walk back N commits from the actual head being reviewed (defaults to
    // local HEAD when the caller didn't thread a pushed ref through). Using
    // a literal "HEAD" here would be wrong for `git push origin
    // some-other-branch` invocations, where the local checkout's HEAD is a
    // different branch entirely and the resulting diff would compare the
    // wrong commits.
    const headRef =
      options.headRef !== undefined && options.headRef.length > 0 ? options.headRef : 'HEAD';
    const requested = options.lastNCommits;
    const tryDepth = (k: number): string =>
      git.tryRevParse(['--verify', '--quiet', `${headRef}~${k}^{commit}`]).trim();

    // Fast path: requested depth resolves directly.
    const direct = tryDepth(requested);
    if (direct.length > 0) {
      return {
        ref: direct,
        source: 'last-n-commits',
        lastNCommits: requested,
      };
    }

    // Clamp: `<headRef>~N` did not resolve. Two distinct causes need
    // different handling — and the difference matters because the wrong
    // choice silently inflates the review:
    //
    //   (i) Branch is genuinely shorter than N (full clone). The
    //       deepest resolvable ancestor `<headRef>~K` IS the root
    //       commit (parent-less). Diffing against `<headRef>~K` would
    //       EXCLUDE the root commit's changes (`git diff base..head`
    //       excludes `base`), so we diff against EMPTY_TREE_SHA to
    //       include them. Report lastNCommits = K + 1 (every commit on
    //       the branch was reviewed).
    //
    //   (ii) Repo is a shallow clone — `<headRef>~K` resolves but
    //        `<headRef>~K`'s parent simply isn't fetched locally. The
    //        commit isn't actually the root; older history exists on
    //        the remote. Diffing against EMPTY_TREE_SHA would balloon
    //        the review to "every tracked file in the checkout"
    //        (including all unchanged base-branch files), defeating
    //        the entire point of last-n-commits. So in the shallow
    //        case we diff against `<headRef>~K` itself, accepting that
    //        the K-th commit's changes are excluded — the operator
    //        chose a shallow clone and the deepest reachable commit is
    //        the best base we have. Report lastNCommits = K (the K
    //        ancestors we DID reach).
    //
    // `git rev-parse --is-shallow-repository` distinguishes the two
    // cases (returns "true" / "false"). On unknown / errored output we
    // assume FULL (the safer default for case (i): we'd rather review
    // the root commit and risk a slightly larger diff than silently
    // drop changes).
    //
    // Both Codex [P1] findings 2026-04-29 (initial empty-tree-on-clamp
    // dropping root commit, then shallow-clone empty-tree expanding to
    // full repo) drove this two-branch design.
    const oneSha = tryDepth(1);
    if (oneSha.length === 0) {
      // Even `<headRef>~1` does not resolve — single-commit history
      // (full clone with one commit) OR a shallow clone fetched at
      // depth=1. In both cases the only locally-resolvable commit is
      // headRef itself; there's no useful intermediate base. Fall back
      // to empty-tree (matches case (i) of single commit review) and
      // report lastNCommits = 1.
      return {
        ref: EMPTY_TREE_SHA,
        source: 'empty-tree',
        lastNCommits: 1,
        lastNCommitsRequested: requested,
      };
    }
    // Binary search for the deepest K < N where `<headRef>~K` resolves.
    // Invariant: tryDepth(lo) resolves; tryDepth(hi+1) does not. We
    // narrow until lo > hi; bestDepth carries the highest K seen.
    let lo = 1;
    let hi = requested - 1;
    let bestDepth = 1;
    while (lo <= hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const sha = tryDepth(mid);
      if (sha.length > 0) {
        bestDepth = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const shallowFlag = git.tryRevParse(['--is-shallow-repository']).trim();
    if (shallowFlag === 'true') {
      // Case (ii): shallow clone. Diff against the deepest reachable
      // ancestor SHA — its parent exists on the remote but isn't
      // locally available, so empty-tree would over-review. Accept that
      // the K-th commit's content is excluded; that's the cost of the
      // shallow clone the operator chose.
      const bestSha = tryDepth(bestDepth);
      return {
        ref: bestSha,
        source: 'last-n-commits',
        lastNCommits: bestDepth,
        lastNCommitsRequested: requested,
      };
    }
    // Case (i): full clone, branch genuinely shorter than N. The
    // deepest resolvable ancestor IS the root. Diff against empty-tree
    // to include the root commit's changes; reviewed count = K + 1.
    return {
      ref: EMPTY_TREE_SHA,
      source: 'last-n-commits',
      lastNCommits: bestDepth + 1,
      lastNCommitsRequested: requested,
    };
  }

  // 1. Upstream of current branch. `@{upstream}` resolves to the configured
  //    tracking ref (typically `refs/remotes/origin/<branch>`). Returns
  //    empty on branches without an upstream — which is normal for a brand
  //    new feature branch; fall through.
  const upstream = git.tryRevParse(['--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim();
  if (upstream.length > 0) {
    return { ref: upstream, source: 'upstream' };
  }

  // 2. origin/HEAD symbolic ref. Set by `git clone` to point at the remote's
  //    default branch. `git symbolic-ref` returns the full ref path; we
  //    hand that to Codex directly (it's `refs/remotes/origin/<name>`).
  const originHead = git.trySymbolicRef('refs/remotes/origin/HEAD').trim();
  if (originHead.length > 0) {
    return { ref: originHead, source: 'origin-head' };
  }

  // 3. Explicit probes for the two most common default-branch names.
  if (git.tryRevParse(['--verify', '--quiet', 'refs/remotes/origin/main']).length > 0) {
    return { ref: 'refs/remotes/origin/main', source: 'origin-main' };
  }
  if (git.tryRevParse(['--verify', '--quiet', 'refs/remotes/origin/master']).length > 0) {
    return { ref: 'refs/remotes/origin/master', source: 'origin-master' };
  }

  // 4. Local branches. `main` and `master` without `refs/remotes/` prefix
  //    resolve via `refs/heads/`. Order matches priority 3.
  if (git.tryRevParse(['--verify', '--quiet', 'refs/heads/main']).length > 0) {
    return { ref: 'refs/heads/main', source: 'local-main' };
  }
  if (git.tryRevParse(['--verify', '--quiet', 'refs/heads/master']).length > 0) {
    return { ref: 'refs/heads/master', source: 'local-master' };
  }

  // 5. Last resort: diff against the empty-tree SHA. Covers every file in
  //    HEAD; expensive for large repos but correct.
  return { ref: EMPTY_TREE_SHA, source: 'empty-tree' };
}
