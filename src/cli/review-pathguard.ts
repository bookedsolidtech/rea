/**
 * 0.50.x — outbound path-guard for the OpenRouter review lane
 * (security-architect §, binding).
 *
 * This is the PRIMARY control. It runs BEFORE any diff bytes are assembled
 * into a request body; refusal is TERMINAL for the external lane. Redaction
 * (review-openrouter.ts) is defense-in-depth, never the only thing between
 * privileged data and an external endpoint.
 *
 * Decision model (fail-closed):
 *   - The changed-path set comes from GIT PLUMBING ONLY — never by parsing
 *     diff text. (`git diff --name-only --no-renames <base>...HEAD` + working
 *     tree + cached + untracked.)
 *   - The refuse-set is:
 *       blocked_paths
 *       ∪ the always-on `.rea/` trust root
 *       ∪ NON-OVERRIDABLE compiled constants (the `strawn-legal` tree and any
 *         `.secret.` file) — policy can ADD, never SUBTRACT these
 *       ∪ `path_overrides` whose provider is `codex` / `refuse`
 *   - Each path classifies ALLOW / REFUSE / UNCERTAIN. UNCERTAIN ≡ REFUSE.
 *     If ANY path is REFUSE or UNCERTAIN, the WHOLE diff refuses (no per-file
 *     split). UNCERTAIN sources: malformed-escape, deep-encoded separator,
 *     traversal segment, glob compile failure, realpath outside repo root,
 *     realpath landing in a refuse-set dir, git enumeration error/timeout,
 *     malformed path_override.
 *
 * Matchers are REUSED from the production middleware:
 *   - `blocked-paths.ts`: normalizePath, matchesBlockedPattern,
 *     hasMalformedEscape, hasDeepEncodedSeparator (single-segment globs).
 *   - `path-normalize.ts`: hasTraversalSegment, resolveParentRealpath,
 *     resolveCanonRoot.
 * The evidentiary refuse-set needs `**`-aware matching (blocked-paths globs
 * are single-segment), so a dedicated `matchesDoubleStarGlob` is implemented
 * here and unit-tested (`strawn-legal/a/b/c.txt` matches,
 * `strawnlegal-notes/x` does NOT).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { matchesBlockedPattern } from '../gateway/middleware/blocked-paths.js';
import {
  hasTraversalSegment,
  resolveCanonRoot,
  resolveParentRealpath,
} from '../hooks/_lib/path-normalize.js';
import {
  PROTECTED_PATTERNS_FULL,
  PATCH_SESSION_PATTERNS,
} from '../hooks/_lib/protected-paths.js';
import { EMPTY_TREE_SHA } from '../audit/content-token.js';
import type { ReviewPathOverride } from '../policy/types.js';

/**
 * FIX B (round-2): build the `git diff` argument for the committed-changes
 * scope. `git diff <base>...HEAD` (three-dot/symmetric) requires BOTH sides to
 * be commits — it exits 128 when `<base>` is the empty-tree SHA (unborn HEAD /
 * first push / no upstream/default branch), the exact fresh-repo case
 * `resolveBaseRef` is built to support. For the empty-tree base we use TWO-dot
 * `git diff <base> HEAD` (diff the tree directly against HEAD); for a normal
 * commit base we keep THREE-dot (merge-base "what this branch changed"). The
 * SAME helper is used by both the guard (`realChangedPaths`) and the payload
 * (`assembleDiff`) so the FIX-1 guard==diff invariant holds in this case too.
 *
 * NOTE: this is only consulted when HEAD EXISTS. When HEAD is unborn (no first
 * commit yet) the diff scope is the staged index (`git diff --cached`) — see
 * `isUnbornHead` + `committedScopeArgs`.
 */
export function committedDiffArgs(baseRef: string): string[] {
  return baseRef === EMPTY_TREE_SHA
    ? [baseRef, 'HEAD'] // two-dot: tree vs HEAD (works against empty-tree)
    : [`${baseRef}...HEAD`]; // three-dot: merge-base semantics for commit bases
}

/**
 * FIX D (round-3): detect an UNBORN HEAD — a repo whose first commit does not
 * exist yet (`git init` then stage files, before any `git commit`). Mirrors
 * the codex path's bootstrap support (review-provider.ts uses
 * `headSha = EMPTY_TREE_SHA` when `git.headSha()` is empty). `git rev-parse
 * --verify HEAD` exits non-zero iff HEAD is unborn. Returns `{ unborn, errored }`
 * so the caller can DISTINGUISH unborn-HEAD (→ review the staged tree) from a
 * genuine git failure (→ still fail closed). A spawn error / non-128 failure is
 * surfaced as `errored: true`.
 */
export function isUnbornHead(
  baseDir: string,
): { unborn: boolean; errored: boolean } {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: baseDir,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (r.error !== undefined) {
    // git not found / spawn failure — a real error, not an unborn HEAD.
    return { unborn: false, errored: true };
  }
  // `--verify --quiet HEAD`: exit 0 + sha when HEAD exists; exit 1 (quiet) when
  // HEAD is unborn or the ref doesn't resolve. We treat the clean
  // ref-doesn't-resolve case (status 1, no stdout) as unborn.
  if (r.status === 0) {
    return { unborn: false, errored: false };
  }
  if (r.status === 1) {
    return { unborn: true, errored: false };
  }
  // Any other status (128 = not a git repo, etc.) is a genuine error.
  return { unborn: false, errored: true };
}

/**
 * FIX D (round-3): the committed-scope `git diff` ARGUMENTS for the current
 * HEAD state. When HEAD EXISTS, this is `committedDiffArgs(baseRef)` (two/three
 * dot). When HEAD is UNBORN, the reviewable content is the STAGED initial tree,
 * so the scope is `--cached` (index vs the empty tree). Used by BOTH the guard
 * and `assembleDiff` so the FIX-1 guard==diff invariant holds in the
 * unborn-HEAD case too.
 *
 * Returns the `git diff` args AFTER the leading `diff` subcommand (callers
 * prepend their own flags like `--name-only` / `--no-color`).
 */
export function committedScopeArgs(baseRef: string, unborn: boolean): string[] {
  return unborn ? ['--cached'] : committedDiffArgs(baseRef);
}

/**
 * NON-OVERRIDABLE evidentiary refuse globs. Policy can ADD refusals; it can
 * NEVER subtract these. Built as runtime strings (kept out of the JSDoc body
 * because a double-star-slash glob sequence would terminate the comment).
 */
export const EVIDENTIARY_REFUSE_GLOBS: ReadonlyArray<{ rule: string; glob: string }> = [
  // The entire strawn-legal tree, at any depth.
  { rule: 'evidentiary:strawn-legal', glob: 'strawn-legal/**' },
  // Any file whose name carries a `.secret.` segment, at any depth.
  { rule: 'evidentiary:secret-file', glob: '**/*.secret.*' },
];

/**
 * NON-OVERRIDABLE governance-protected surfaces (codex round-9). The SAME
 * protected-write set `settings-protection` / `protected-paths-bash-gate`
 * enforce — `.claude/settings.json`, `.claude/settings.local.json`, `.husky/`,
 * `.claude/hooks/`, etc. — sourced VERBATIM from the canonical
 * `protected-paths.ts` constants so the outbound guard is consistent BY
 * CONSTRUCTION with the rest of rea's protected-path model. Sending a hook /
 * settings diff to an external OSS model is the exposure this closes. (The
 * `.rea/*` invariants here are already covered by the always-on `.rea/` root;
 * the new coverage is the `.claude/` + `.husky/` governance surfaces.) The
 * consumer's `policy.protected_writes` is added on TOP (union, not replace —
 * external exposure is held more conservatively than local write-protection).
 */
export const GOVERNANCE_REFUSE_PATTERNS: readonly string[] = [
  ...new Set([...PROTECTED_PATTERNS_FULL, ...PATCH_SESSION_PATTERNS]),
];

/**
 * Round-13: a NON-decoding normalization for git-LITERAL paths — identical in
 * spirit to `blocked-paths` `normalizePath` EXCEPT it does NOT URL-decode
 * `%xx`. A `git diff -z` (core.quotePath=false) path is byte-exact: a literal
 * `%2F` must stay `%2F`, never become `/`. (lowercase + `\\`→`/` + strip leading
 * `./` and `/` + collapse `//`.) `..` segments are already refused upstream.
 */
function normalizeLiteral(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  while (out.startsWith('/')) out = out.slice(1);
  out = out.replace(/\/{2,}/g, '/');
  return out.toLowerCase();
}

/**
 * Round-13: a LITERAL (non-decoding) twin of `matchesBlockedPattern`. It
 * replicates that matcher's semantics — dir-prefix at ANY depth, basename
 * exact/glob at ANY depth, multi-segment patterns unmatched, case-insensitive —
 * WITHOUT URL-decoding `%xx`. Used ONLY when a git-literal path contains a `%`
 * (the lane that `matchesBlockedPattern`/`normalizePath` would mis-decode);
 * every other path keeps using the proven production matcher. An equivalence
 * test pins agreement with `matchesBlockedPattern` on the non-`%` corpus.
 */
export function matchesLiteralBlockedPattern(value: string, pattern: string): boolean {
  const nv = normalizeLiteral(value);
  const np = normalizeLiteral(pattern);
  if (np.length === 0) return false;
  const vsegs = nv.split('/').filter((s) => s.length > 0);
  if (vsegs.length === 0) return false;
  if (np.endsWith('/')) {
    const dir = np.slice(0, -1);
    if (dir.length === 0 || dir.includes('/')) return false; // multi-segment dir → unmatched
    // dir name present as a DIRECTORY segment (i.e. NOT the last segment).
    for (let i = 0; i < vsegs.length - 1; i += 1) {
      if (vsegs[i] === dir) return true;
    }
    return false;
  }
  if (np.includes('/')) return false; // multi-segment exact → unmatched (mirrors matchesBlockedPattern)
  // single-segment pattern → match the BASENAME (exact or glob).
  const base = vsegs[vsegs.length - 1] ?? '';
  if (/[*?]/.test(np)) {
    const re =
      '^' +
      np.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') +
      '$';
    try {
      return new RegExp(re).test(base);
    } catch {
      return false;
    }
  }
  return base === np;
}

/**
 * `matchesBlockedPattern` (mirrored from the gateway middleware) has a known
 * gap: its DOT-ANCHORED fast-path only compares single segments, so a
 * multi-segment dot-anchored `blocked_paths` entry like
 * `.github/workflows/release.yml` or `.rea/HALT` never matches — and the file
 * would be uploaded to the external review lane (codex round-2 P1). (Non-dot
 * multi-segment exact entries like `src/foo.ts` ARE caught by that matcher's
 * suffix loop; only the dot-anchored multi-segment case leaks.) The path-guard
 * is fail-closed, so we OR in a tail-aligned exact match for multi-segment,
 * non-glob, non-dir patterns to close the bypass. This is additive for the
 * dot-anchored case and harmlessly redundant for the rest.
 *
 * NOTE: the same gap exists in the production `matchesBlockedPattern`
 * (`src/gateway/middleware/blocked-paths.ts`) — a separate, broader-blast-radius
 * fix for the gateway middleware, tracked independently.
 */
function matchesBlockedMultiSegmentExact(value: string, pattern: string): boolean {
  const nv = normalizeLiteral(value);
  const np = normalizeLiteral(pattern);
  if (np.length === 0 || nv.length === 0) return false;
  if (!np.includes('/')) return false; // single-segment → matchesBlockedPattern handles it
  if (np.endsWith('/')) return false; // dir pattern → matchesBlockedPattern handles it
  if (/[*?]/.test(np)) return false; // glob → matchesBlockedPattern handles it
  // Tail-aligned exact, mirroring matchesBlockedPattern's relative semantics:
  // the pattern matches the whole repo-relative path or a trailing segment run.
  return nv === np || nv.endsWith(`/${np}`);
}

/**
 * Match a git-LITERAL path against a `blocked_paths` pattern. Routes `%`-bearing
 * paths through the non-decoding `matchesLiteralBlockedPattern` (round-13) so a
 * file literally named `.rea%2Fnotes.md` is NOT decoded into `.rea/notes.md` and
 * false-refused; every other path keeps the proven `matchesBlockedPattern`. In
 * BOTH cases we additionally OR the multi-segment-exact catch above so a
 * dot-anchored nested entry (`.github/workflows/release.yml`) can never slip the
 * guard (codex round-2 P1).
 */
function matchesBlockedLiteral(value: string, pattern: string): boolean {
  const base = value.includes('%')
    ? matchesLiteralBlockedPattern(value, pattern)
    : matchesBlockedPattern(value, pattern);
  return base || matchesBlockedMultiSegmentExact(value, pattern);
}

/**
 * Match a path against a protected-paths-style pattern, implementing the SAME
 * semantics `protected-paths.ts` documents: a trailing `/` is a directory
 * PREFIX match; otherwise it is a case-insensitive EXACT match. Uses the
 * NON-decoding `normalizeLiteral` (round-13) — the guard's input is a git
 * literal path, so `%xx` must never be URL-decoded. `matchesBlockedPattern`
 * also can't match a multi-segment exact file like `.claude/settings.json`
 * (the governance surface we must refuse), so the governance loop uses this.
 */
export function matchesGovernancePattern(value: string, pattern: string): boolean {
  const nv = normalizeLiteral(value);
  const np = normalizeLiteral(pattern);
  if (np.length === 0 || nv.length === 0) return false;
  if (np.endsWith('/')) {
    const base = np.slice(0, -1);
    return base.length > 0 && (nv === base || nv.startsWith(np));
  }
  return nv === np;
}

export type PathClass = 'allow' | 'refuse' | 'uncertain';

export interface PathGuardResult {
  /** `'send'` only when every changed path is ALLOW. */
  decision: 'send' | 'refuse';
  /**
   * Refusal class when `decision === 'refuse'`. One of `'path-guard'`
   * (a matched refuse rule), `'path-override'` (a codex/refuse override),
   * or `'git-enumeration-error'` (could not enumerate changed paths).
   */
  refusalClass?: 'path-guard' | 'path-override' | 'git-enumeration-error';
  /** The RULE that triggered refusal (NEVER a raw path value). */
  matchedRule?: string;
  /** Number of changed paths considered (a count, never the paths). */
  changedPathCount: number;
  /**
   * When a `path_overrides` entry matched with a non-external provider, the
   * lane to fall back to (`codex` or `refuse`). Undefined for hard refusals.
   */
  fallbackLane?: 'codex' | 'refuse';
}

/** Injectable git enumerator (tests provide a deterministic list). */
export interface ChangedPathsResult {
  /** Repo-relative changed paths, or `undefined` on enumeration failure. */
  paths?: string[];
  /** True when git enumeration errored/timed out → fail-closed UNCERTAIN. */
  errored: boolean;
}

export type ChangedPathsEnumerator = (baseDir: string, baseRef: string) => ChangedPathsResult;

/**
 * Enumerate the changed-path set from GIT PLUMBING ONLY.
 *
 * INVARIANT (codex round-2 FIX 1): the guard's evaluated path set MUST be
 * IDENTICAL to the set `assembleDiff()` (review-openrouter.ts) actually sends
 * off-machine. `assembleDiff` sends exactly `git diff <base>...HEAD`
 * (committed) ∪ `git diff HEAD` (tracked working-tree + index changes) — i.e.
 * TRACKED changes ONLY. Untracked files are NEVER in the outbound payload, so
 * they are NEVER enumerated here either. Enumerating untracked files would
 * (a) refuse a send that never happens (false positive) AND, worse, (b) let a
 * path leave the guard set that the diff still includes if the two ever
 * diverged. We keep them byte-for-byte aligned on the SAME `git diff` shape.
 *
 * Consequences (correct + intended):
 *   - A TRACKED `.rea/*` change IS in the diff → classifyPath refuses the
 *     external lane (the `.rea/` trust root stays in the refuse-set). The
 *     governance file is NEVER sent off-machine.
 *   - An UNTRACKED `.rea/policy.yaml` (this repo's own install) is NOT sent by
 *     assembleDiff, so it is NOT enumerated → NO spurious refusal. The old
 *     `.rea/`-dropping filter that caused the FIX-1 vuln is GONE; this is the
 *     correct, leak-free way to avoid the false positive.
 *
 * Any git invocation that errors (non-zero / spawn error / timeout) makes the
 * whole result `errored: true` → the caller treats the diff as UNCERTAIN and
 * refuses the external lane (fail-closed).
 */
export const realChangedPaths: ChangedPathsEnumerator = (baseDir, baseRef) => {
  const collected = new Set<string>();
  let errored = false;
  // FIX I (round-5): even the `--name-only` enumeration runs with
  // `--no-ext-diff` + the safe `-c diff.external=` override + a scrubbed env
  // (no `GIT_EXTERNAL_DIFF`/`GIT_DIFF_OPTS`).
  //
  // STRUCTURAL FIX 2 / P1-3 (round-6): enumerate with `-z` (NUL-delimited) +
  // `-c core.quotePath=false` so the guard sees REAL byte-exact paths — never
  // the human-formatted form (default `core.quotePath=true` octal-escapes +
  // double-quote-wraps non-ASCII, and a `\n`-split would break on a path that
  // contains a newline). `assembleDiff` uses the SAME flags so both sides see
  // identical real paths and the guard==diff invariant holds for non-ASCII +
  // newline paths.
  const scrubbedEnv = { ...process.env };
  delete scrubbedEnv.GIT_EXTERNAL_DIFF;
  delete scrubbedEnv.GIT_DIFF_OPTS;
  const runLines = (diffArgs: string[]): string[] | undefined => {
    // diffArgs always begins with the `diff` subcommand here; inject the safe
    // config + `--no-ext-diff` + `-z` right after it.
    const args = [
      '-c',
      'diff.external=',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'core.quotePath=false',
      ...diffArgs,
    ];
    const withFlags = args.flatMap((a) => (a === 'diff' ? ['diff', '--no-ext-diff', '-z'] : [a]));
    const r = spawnSync('git', withFlags, {
      cwd: baseDir,
      encoding: 'utf8',
      timeout: 15000,
      env: scrubbedEnv,
    });
    if (r.error !== undefined || r.status !== 0) {
      errored = true;
      return undefined;
    }
    // `--name-only -z` emits NUL-delimited paths — split on `\0` ONLY (a path
    // may contain `\n`), drop the trailing empty field.
    return (typeof r.stdout === 'string' ? r.stdout : '').split('\0').filter((l) => l.length > 0);
  };

  // FIX D (round-3): detect unborn HEAD BEFORE any `git diff HEAD` (which would
  // exit 128 and be misclassified as a git error → spurious refuse). A genuine
  // git failure (not-a-repo, spawn error) still fails closed.
  const head = isUnbornHead(baseDir);
  if (head.errored) return { errored: true };

  if (head.unborn) {
    // Unborn HEAD (bootstrap case — `git init` + stage, before first commit).
    // The reviewable content is the STAGED initial tree: `git diff --cached`
    // (index vs the empty tree). There is NO `git diff HEAD` working scope —
    // HEAD does not exist. Truly empty repo (nothing staged) → empty set, the
    // lane sends an empty review (sane, not a refuse).
    const staged = runLines(['diff', '--name-only', '--no-renames', '--cached']);
    if (errored) return { errored: true };
    if (staged !== undefined) for (const p of staged) collected.add(p);
    return { paths: [...collected], errored: false };
  }

  // HEAD exists — normal path.
  // 1. Committed diff against base. Mirrors assembleDiff's committed scope.
  //    FIX B (round-2): use two-dot `git diff <base> HEAD` for the empty-tree
  //    base (three-dot exits 128 there), three-dot otherwise — via the shared
  //    committedScopeArgs helper so the guard==diff invariant holds.
  if (baseRef.length > 0) {
    const committed = runLines([
      'diff',
      '--name-only',
      '--no-renames',
      ...committedScopeArgs(baseRef, false),
    ]);
    if (committed !== undefined) for (const p of committed) collected.add(p);
  }
  // 2. Tracked working-tree changes vs HEAD. Mirrors assembleDiff's
  //    `git diff --no-color HEAD` (covers both unstaged and staged tracked
  //    changes against HEAD). This is TRACKED ONLY — `git diff HEAD` never
  //    lists untracked files, so the guard set == the diff set.
  const trackedVsHead = runLines(['diff', '--name-only', '--no-renames', 'HEAD']);
  if (trackedVsHead !== undefined) for (const p of trackedVsHead) collected.add(p);

  if (errored) return { errored: true };
  // NO post-filter: every enumerated path is exactly what the diff sends.
  // `.rea/*` paths that appear here are TRACKED changes and MUST refuse the
  // external lane (classifyPath's refuse-set still includes `.rea/`).
  return { paths: [...collected], errored: false };
};

/**
 * codex round-13 P1 — enumerate the PER-COMMIT sent-path UNION for `per-commit`
 * granularity. In per-commit mode the openrouter lane uploads each commit's OWN
 * `C^..C` patch over `base..HEAD` (+ the trailing tracked working-tree unit).
 * That union can DIFFER from the net `base...HEAD` diff when history is
 * non-linear: a file touched in an intermediate commit and REVERTED before HEAD,
 * or pulled in by a MERGE commit from `main`, appears in a `C^..C` patch yet is
 * absent from the net diff. The whole-diff guard (`realChangedPaths`) would not
 * see it, so per-commit mode could send an UNGUARDED path off-machine. This
 * enumerator returns exactly the union per-commit mode SENDS, so the guard==send
 * invariant holds for per-commit too. Same `-z` + safe-config + scrubbed-env
 * hardening as `realChangedPaths`; any git failure → `errored: true` (fail-closed).
 */
export const realPerCommitChangedPaths: ChangedPathsEnumerator = (baseDir, baseRef) => {
  const collected = new Set<string>();
  let errored = false;
  const scrubbedEnv = { ...process.env };
  delete scrubbedEnv.GIT_EXTERNAL_DIFF;
  delete scrubbedEnv.GIT_DIFF_OPTS;
  const SAFE = ['-c', 'diff.external=', '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false'];
  const runZ = (args: string[]): string[] | undefined => {
    const r = spawnSync('git', [...SAFE, ...args], {
      cwd: baseDir,
      encoding: 'utf8',
      timeout: 15000,
      env: scrubbedEnv,
    });
    if (r.error !== undefined || r.status !== 0) {
      errored = true;
      return undefined;
    }
    return (typeof r.stdout === 'string' ? r.stdout : '').split('\0').filter((l) => l.length > 0);
  };

  const head = isUnbornHead(baseDir);
  if (head.errored) return { errored: true };
  if (head.unborn) {
    // No commits to walk — the staged initial tree IS the review (same as the
    // whole-diff enumerator's unborn case).
    const staged = runZ(['diff', '--no-ext-diff', '-z', '--name-only', '--no-renames', '--cached']);
    if (errored) return { errored: true };
    if (staged !== undefined) for (const p of staged) collected.add(p);
    return { paths: [...collected], errored: false };
  }

  // The commits whose patches per-commit mode sends: `git rev-list base..HEAD`.
  // codex round-14 P1: this MUST match `enumerateReviewUnits`, which uses
  // `${baseRef}..HEAD` UNCONDITIONALLY for a non-unborn HEAD — including when
  // `baseRef` is the EMPTY_TREE_SHA (a new repo / no upstream / last-N clamped to
  // root), where `<empty-tree>..HEAD` lists ALL of HEAD's history. Skipping
  // rev-list for the empty-tree base (as an earlier draft did) left every
  // committed path UNGUARDED while per-commit still uploaded those patches — a
  // fail-OPEN. We enumerate the same commit set the unit builder sends.
  if (baseRef.length > 0) {
    const rl = spawnSync('git', [...SAFE, 'rev-list', `${baseRef}..HEAD`], {
      cwd: baseDir,
      encoding: 'utf8',
      timeout: 15000,
      env: scrubbedEnv,
    });
    if (rl.error !== undefined || rl.status !== 0) return { errored: true };
    const shas = (typeof rl.stdout === 'string' ? rl.stdout : '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sha of shas) {
      const hasParent =
        spawnSync('git', [...SAFE, 'rev-parse', '--verify', '--quiet', `${sha}^`], {
          cwd: baseDir,
          encoding: 'utf8',
          env: scrubbedEnv,
        }).status === 0;
      const left = hasParent ? `${sha}^` : EMPTY_TREE_SHA;
      const paths = runZ(['diff', '--no-ext-diff', '-z', '--name-only', '--no-renames', left, sha]);
      if (paths !== undefined) for (const p of paths) collected.add(p);
    }
  }
  // The trailing working-tree unit (tracked changes vs HEAD), matching the
  // working-tree review unit `enumerateReviewUnits` appends.
  const wt = runZ(['diff', '--no-ext-diff', '-z', '--name-only', '--no-renames', 'HEAD']);
  if (wt !== undefined) for (const p of wt) collected.add(p);

  if (errored) return { errored: true };
  return { paths: [...collected], errored: false };
};

/**
 * `**`-aware glob matcher for the evidentiary refuse-set. Distinct from the
 * single-segment `matchesBlockedPattern`. Semantics:
 *   - `**` matches any number of path segments (including zero).
 *   - `*` matches any chars WITHIN a single segment (not `/`).
 *   - `?` matches one non-`/` char.
 *   - everything else is literal (regex meta escaped).
 * Case-sensitive (a Windows checkout must not silently widen the filter).
 * Paths are normalized: `\` → `/`, leading `./` stripped, leading `/` stripped.
 */
/**
 * Tri-state glob match. `'uncertain'` is returned on a regex-COMPILE FAILURE so
 * the caller can map it to UNCERTAIN ≡ refuse (fail-CLOSED) — P2-5 (round-6):
 * a bare `false` on compile failure let an operator's custom refuse-glob
 * silently no-op (fail-OPEN) in the path_override loop. Compile failure is now
 * a refusal, matching the documented fail-closed contract.
 */
export function matchDoubleStarGlob(
  rawPath: string,
  rawGlob: string,
): 'match' | 'no-match' | 'uncertain' {
  const norm = (s: string): string => {
    let out = s.replace(/\\/g, '/');
    while (out.startsWith('./')) out = out.slice(2);
    if (out.startsWith('/')) out = out.slice(1);
    return out;
  };
  const p = norm(rawPath);
  let glob = norm(rawGlob);
  if (glob.endsWith('/')) glob = `${glob}**`;
  // FIX M (round-8): a trailing `/**` means "this directory ROOT and everything
  // under it". The naive expansion (`PREFIX/.*`) matched only descendants —
  // so a path resolving to the bare directory root (e.g. a symlink whose
  // realpath IS `strawn-legal`) slipped the guard. Strip the trailing `/**`
  // here, compile the prefix, then append `(?:/.*)?` so the regex matches the
  // root exactly AND any descendant. The `/` boundary still prevents
  // over-matching a sibling like `strawn-legal-notes` (no slash boundary).
  const trailingDirStar = glob.endsWith('/**');
  if (trailingDirStar) glob = glob.slice(0, -'/**'.length);
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (i + 1 < glob.length && glob[i + 1] === '*') {
        i += 1;
        // `**/` → zero-or-more leading segments; bare `**` → anything.
        if (i + 1 < glob.length && glob[i + 1] === '/') {
          i += 1;
          re += '(?:[^/]+/)*';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c !== undefined && /[.+^$|(){}[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else if (c !== undefined) {
      re += c;
    }
  }
  // The trailing `/**` matches the root (zero descendants) OR `/`-prefixed
  // descendants. `(?:/.*)?` after the prefix gives exactly that.
  if (trailingDirStar) re += '(?:/.*)?';
  re += '$';
  let compiled: RegExp;
  try {
    compiled = new RegExp(re);
  } catch {
    // P2-5: compile failure is UNCERTAIN → caller refuses (fail-closed).
    return 'uncertain';
  }
  return compiled.test(p) ? 'match' : 'no-match';
}

/**
 * Boolean convenience for the evidentiary CONSTANT globs (which never fail to
 * compile) and for back-compat tests. Treats `'uncertain'` as `true`
 * (fail-closed) so a caller that uses the boolean form on an operator glob
 * still errs toward refuse — but the path_override loop uses the tri-state form
 * directly so it can record the UNCERTAIN class.
 */
export function matchesDoubleStarGlob(rawPath: string, rawGlob: string): boolean {
  return matchDoubleStarGlob(rawPath, rawGlob) !== 'no-match';
}

export interface PathGuardInput {
  baseDir: string;
  baseRef: string;
  blockedPaths: readonly string[];
  /**
   * Consumer's `policy.protected_writes` (round-9). Added to the
   * non-overridable governance refuse-set (`GOVERNANCE_REFUSE_PATTERNS`) so a
   * diff touching protected hook/settings surfaces refuses the external lane.
   */
  protectedWrites?: readonly string[];
  /**
   * Consumer's `policy.protected_paths_relax` (codex round-17 P2). SUBTRACTED
   * from the governance refuse-set — a consumer that intentionally unprotects a
   * governance path (e.g. `.husky/`) can then send it on the external lane,
   * mirroring the normal protected-path enforcement. Kill-switch invariants
   * (`.rea/policy.yaml`, `.rea/HALT`, `.rea/last-review*.json`,
   * `.claude/settings.json`) are NEVER relaxable — they must never egress.
   */
  protectedPathsRelax?: readonly string[];
  pathOverrides: readonly ReviewPathOverride[];
  /** Injectable git enumerator (tests pass a deterministic list). */
  enumerate?: ChangedPathsEnumerator;
}

/**
 * Governance patterns that can NEVER be relaxed for EXTERNAL sending, even via
 * `protected_paths_relax` — the kill-switch trust root. Mirrors the bash-scanner
 * `KILL_SWITCH_INVARIANTS`; for the OUTBOUND lane these must never egress.
 */
const NON_RELAXABLE_EXTERNAL: ReadonlySet<string> = new Set(
  [
    '.claude/settings.json',
    '.rea/policy.yaml',
    '.rea/HALT',
    '.rea/last-review.json',
    '.rea/last-review.cache.json',
  ].map((p) => p.toLowerCase()),
);

/**
 * Classify ONE changed path. Returns its class + (on refuse) the matched
 * rule. Pure except for realpath checks (which read the filesystem).
 */
function classifyPath(
  rawPath: string,
  ctx: {
    canonRoot: string;
    blockedPaths: readonly string[];
    governancePatterns: readonly string[];
    overridesRefuse: ReviewPathOverride[];
  },
): { cls: PathClass; rule?: string; fallback?: 'codex' | 'refuse' } {
  // Structural hostility on a git-LITERAL path. `rawPath` comes from
  // `git diff --name-only -z` with `core.quotePath=false` — the REAL filename
  // bytes, NOT URL-encoded input. So the `hasMalformedEscape` /
  // `hasDeepEncodedSeparator` gates (which defend URL-DECODED tool input) do
  // NOT apply here and would falsely refuse legitimate names like
  // `docs/50% complete.md` or `foo%2Fbar.txt` (codex round-10) — they are NOT
  // used on this path. A literal `..` SEGMENT, however, is still a real escape
  // signal (and `..foo` is not a `..` segment → no false-positive), and the
  // realpath check below is the actual symlink/escape defense.
  if (hasTraversalSegment(rawPath)) return { cls: 'uncertain', rule: 'traversal-segment' };

  // 1. NON-OVERRIDABLE evidentiary refuse-set (the `**`-aware matcher).
  for (const { rule, glob } of EVIDENTIARY_REFUSE_GLOBS) {
    if (matchesDoubleStarGlob(rawPath, glob)) return { cls: 'refuse', rule };
  }

  // 2. Always-on `.rea/` trust root + blocked_paths (single-segment matcher).
  const blockedPatterns = [...new Set([...ctx.blockedPaths, '.rea/'])];
  for (const pattern of blockedPatterns) {
    if (matchesBlockedLiteral(rawPath, pattern)) {
      return { cls: 'refuse', rule: `blocked_paths:${pattern}` };
    }
  }

  // 2b. NON-OVERRIDABLE governance-protected surfaces (round-9): refuse the
  //     SAME protected-write set the rest of rea enforces (.claude/settings.json,
  //     .husky/, .claude/hooks/, …) + the consumer's protected_writes, so a
  //     governance hook/settings diff cannot be sent to an external OSS model.
  for (const pattern of ctx.governancePatterns) {
    if (matchesGovernancePattern(rawPath, pattern)) {
      return { cls: 'refuse', rule: `protected-write:${pattern}` };
    }
  }

  // 3. path_overrides whose provider is codex/refuse → fall back to that lane.
  //    P2-5 (round-6): operator-supplied globs can fail to compile. The
  //    tri-state matcher returns 'uncertain' on compile failure → UNCERTAIN ≡
  //    refuse (fail-CLOSED), instead of the old bare-false that silently
  //    no-op'd the operator's refuse-glob (fail-OPEN).
  for (const ov of ctx.overridesRefuse) {
    for (const g of ov.paths) {
      const m = matchDoubleStarGlob(rawPath, g);
      if (m === 'uncertain') {
        return { cls: 'uncertain', rule: `path_override-glob-compile-failure:${g}` };
      }
      if (m === 'match') {
        return {
          cls: 'refuse',
          rule: `path_override:${ov.provider}:${g}`,
          fallback: ov.provider === 'refuse' ? 'refuse' : 'codex',
        };
      }
    }
  }

  // 4. realpath check: the resolved path must stay inside the repo root, and
  //    its parent dir must not BE a refuse-set directory (symlink escape).
  //    FIX (round-10): probe the LITERAL git path (case-PRESERVED). The earlier
  //    `normalizeBlockedPath` lowercased segments, so on a case-sensitive FS a
  //    tracked `Docs/api/spec.md` was looked up as `docs/...`, failed to
  //    resolve, and refused the WHOLE diff. The matchers stay case-insensitive
  //    (they normalize internally); only the FILESYSTEM probe needs git's exact
  //    bytes. `..` segments are already excluded above, so `path.join` cannot
  //    escape the root.
  const abs = path.isAbsolute(rawPath) ? rawPath : path.join(ctx.canonRoot, rawPath);
  const parentReal = resolveParentRealpath(abs);
  if (parentReal.length === 0) {
    // Could not resolve a real parent inside the repo → UNCERTAIN.
    return { cls: 'uncertain', rule: 'realpath-unresolved' };
  }
  // Must be a descendant of the canonical root.
  const rootWithSep = ctx.canonRoot.endsWith(path.sep) ? ctx.canonRoot : ctx.canonRoot + path.sep;
  if (parentReal !== ctx.canonRoot && !parentReal.startsWith(rootWithSep)) {
    return { cls: 'uncertain', rule: 'realpath-outside-root' };
  }
  // The realpath'd location (relative to root) must itself not be in the
  // refuse-set (a symlink pointing INTO strawn-legal/.rea/blocked).
  const relReal = parentReal === ctx.canonRoot ? '' : parentReal.slice(rootWithSep.length);
  for (const { rule, glob } of EVIDENTIARY_REFUSE_GLOBS) {
    if (relReal.length > 0 && matchesDoubleStarGlob(relReal, glob)) {
      return { cls: 'refuse', rule: `${rule}:realpath` };
    }
  }
  for (const pattern of blockedPatterns) {
    if (relReal.length > 0 && matchesBlockedLiteral(relReal, pattern)) {
      return { cls: 'refuse', rule: `blocked_paths:${pattern}:realpath` };
    }
  }
  for (const pattern of ctx.governancePatterns) {
    if (relReal.length > 0 && matchesGovernancePattern(relReal, pattern)) {
      return { cls: 'refuse', rule: `protected-write:${pattern}:realpath` };
    }
  }

  return { cls: 'allow' };
}

/**
 * Run the outbound path-guard over the changed-path set. Returns
 * `decision: 'send'` ONLY when every changed path is ALLOW. Any REFUSE or
 * UNCERTAIN → `decision: 'refuse'` for the WHOLE diff (no per-file split).
 */
export function evaluatePathGuard(input: PathGuardInput): PathGuardResult {
  const enumerate = input.enumerate ?? realChangedPaths;
  const enumerated = enumerate(input.baseDir, input.baseRef);
  if (enumerated.errored || enumerated.paths === undefined) {
    // git enumeration error/timeout → fail-closed.
    return {
      decision: 'refuse',
      refusalClass: 'git-enumeration-error',
      changedPathCount: 0,
    };
  }
  const paths = enumerated.paths;
  const canonRoot = resolveCanonRoot(input.baseDir);
  const overridesRefuse = input.pathOverrides.filter(
    (ov) => ov.provider === 'codex' || ov.provider === 'refuse',
  );
  // Validate override shapes — a malformed override (empty paths) → UNCERTAIN.
  for (const ov of input.pathOverrides) {
    if (!Array.isArray(ov.paths) || ov.paths.length === 0) {
      return {
        decision: 'refuse',
        refusalClass: 'path-override',
        matchedRule: 'malformed-path-override',
        changedPathCount: paths.length,
      };
    }
  }

  // Round-9: the non-overridable governance refuse-set (rea's own protected
  // hook/settings surfaces) + the consumer's protected_writes. codex round-17
  // P2: SUBTRACT `protected_paths_relax` (a consumer's explicit decision to
  // unprotect a path) — but NEVER the kill-switch invariants (which must never
  // egress). Pattern-equality subtraction, case-insensitive, mirroring the
  // normal protected-path enforcement.
  const relax = (input.protectedPathsRelax ?? []).filter(
    (r) => !NON_RELAXABLE_EXTERNAL.has(r.toLowerCase()),
  );
  const governancePatterns = [
    ...new Set([...GOVERNANCE_REFUSE_PATTERNS, ...(input.protectedWrites ?? [])]),
  ].filter((pat) => !relax.some((r) => r.toLowerCase() === pat.toLowerCase()));

  for (const rawPath of paths) {
    const { cls, rule, fallback } = classifyPath(rawPath, {
      canonRoot,
      blockedPaths: input.blockedPaths,
      governancePatterns,
      overridesRefuse,
    });
    if (cls === 'allow') continue;
    // REFUSE or UNCERTAIN → whole-diff refusal.
    const isOverride = rule !== undefined && rule.startsWith('path_override:');
    return {
      decision: 'refuse',
      refusalClass: isOverride ? 'path-override' : 'path-guard',
      ...(rule !== undefined ? { matchedRule: rule } : {}),
      changedPathCount: paths.length,
      ...(fallback !== undefined ? { fallbackLane: fallback } : {}),
    };
  }

  return { decision: 'send', changedPathCount: paths.length };
}
