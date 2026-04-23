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
    | 'upstream'
    | 'origin-head'
    | 'origin-main'
    | 'origin-master'
    | 'local-main'
    | 'local-master'
    | 'empty-tree';
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

  // 1. Upstream of current branch. `@{upstream}` resolves to the configured
  //    tracking ref (typically `refs/remotes/origin/<branch>`). Returns
  //    empty on branches without an upstream — which is normal for a brand
  //    new feature branch; fall through.
  const upstream = git
    .tryRevParse(['--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    .trim();
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
