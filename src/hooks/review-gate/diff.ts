/**
 * Git-subprocess wrappers the review gate needs.
 *
 * ## Why a dedicated module
 *
 * The bash core spawns git via inline `$(cd "$REA_ROOT" && git ... 2>/dev/null)`
 * subshells. Each invocation carries a handful of concerns the TS port
 * separates cleanly:
 *
 *   - Args passed as an ARRAY so the shell never interprets them
 *     (push-review-ts-port design §9 security posture: no argument-injection
 *     CVEs around refspec names like `main;rm -rf /`).
 *   - `cwd` always set to the resolved repo root — the caller never has to
 *     remember to `cd` first.
 *   - stdout/stderr captured separately. Git's error text goes to stderr in
 *     normal modes, and callers often want stderr for diagnostics while
 *     still deciding based on exit code.
 *   - A single shared timeout (10s) catches a hung `git` process. The bash
 *     core had no timeout — an upstream `git` stuck on NFS could wedge the
 *     whole push indefinitely.
 *
 * ## Mockability
 *
 * Every exported function takes a `GitRunner` as its first positional so
 * tests can stub the subprocess layer. The default runner spawns `git`;
 * tests supply a recording runner and assert over the command history. This
 * is how `base-resolve.test.ts` and `diff.test.ts` avoid needing a real
 * git repo.
 *
 * ## Defect carry-forwards
 *
 * - Two-dot `A..B` for diff inputs, NEVER three-dot `A...B`. The bash
 *   core's comment on push-review-core.sh §1053-1060 covers this: three-dot
 *   computes an implicit merge-base which FAILS when A is the empty-tree
 *   SHA (a valid bootstrap anchor in `base-resolve.ts`). Two-dot accepts
 *   any revision on the left.
 * - `git diff --name-status` output is tab-separated, one line per change;
 *   `protected-paths.ts` owns the parse.
 * - `git cat-file -e <sha>^{commit}` is the "object is locally resolvable"
 *   probe. Bash used a bare exit-code check; we preserve that.
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

/**
 * Result of a git invocation. `status` is the git exit code (0 on success).
 * Both `stdout` and `stderr` are trimmed of trailing newlines — the bash
 * core's callers all applied `$(...)` which already collapses trailing
 * whitespace, so TS callers expect the same contract.
 */
export interface GitRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Signature the git-subprocess layer must implement. Tests supply a stub
 * that records calls and returns canned results; production uses
 * {@link spawnGit}.
 */
export type GitRunner = (args: readonly string[], cwd: string) => GitRunResult;

/** Hard cap on git invocation runtime. Bash core had no cap; 10s is generous for a hot-cache repo. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Default production git runner. Spawns `git` with the supplied args, cwd,
 * and a fixed timeout. `encoding: 'utf8'` so the returned strings are
 * decoded, matching the bash `$()` shape.
 *
 * Security: args is always an array; no shell string ever participates in
 * the invocation. Refspec names that happen to contain shell metacharacters
 * are inert.
 */
export function spawnGit(args: readonly string[], cwd: string): GitRunResult {
  const opts: SpawnSyncOptions = {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    // Explicitly drop stdin — some git subcommands try to read (e.g. `git
    // commit` prompting for a message); we never want that.
    stdio: ['ignore', 'pipe', 'pipe'],
    // Never use a shell. Args are an array; spawn does argv[0] execve
    // directly, so `git` is looked up on PATH with no shell parsing.
    shell: false,
  };
  const result = spawnSync('git', args as string[], opts);
  const stdout = typeof result.stdout === 'string' ? result.stdout.replace(/\n+$/, '') : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr.replace(/\n+$/, '') : '';
  // On timeout/signal kill, spawnSync returns status=null and populates
  // `signal`. Treat as a non-zero exit so callers fall through the normal
  // error paths.
  const status = typeof result.status === 'number' ? result.status : 1;
  return { status, stdout, stderr };
}

/**
 * SHA validator. Bash uses `=~ ^[0-9a-f]{40}$`; we match exactly.
 */
const SHA_HEX_40 = /^[0-9a-f]{40}$/;

/**
 * Return the current branch name (empty string when detached or on failure).
 * Bash-core parity (push-review-core.sh §687): `git branch --show-current`.
 */
export function currentBranch(runner: GitRunner, cwd: string): string {
  const r = runner(['branch', '--show-current'], cwd);
  if (r.status !== 0) return '';
  return r.stdout;
}

/**
 * Resolve `HEAD` to a commit SHA, or return the empty string when the repo
 * has no commits / the rev-parse fails. Bash-core parity
 * (push-review-core.sh §134 and §412): `git rev-parse HEAD`.
 */
export function resolveHead(runner: GitRunner, cwd: string): string {
  const r = runner(['rev-parse', 'HEAD'], cwd);
  if (r.status !== 0) return '';
  const sha = r.stdout;
  return SHA_HEX_40.test(sha) ? sha : '';
}

/**
 * Resolve a ref (e.g. `feature/foo`) to a commit SHA via
 * `git rev-parse --verify <ref>^{commit}`, or return null on failure.
 * Bash-core parity (push-review-core.sh §187): the `^{commit}` suffix
 * forces resolution to the commit even for annotated-tag refs.
 */
export function resolveRefToSha(runner: GitRunner, cwd: string, ref: string): string | null {
  const r = runner(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  if (r.status !== 0) return null;
  const sha = r.stdout;
  return SHA_HEX_40.test(sha) ? sha : null;
}

/**
 * Return the short-name upstream for the current branch (e.g. `origin/main`)
 * or null if no upstream is set. Bash-core parity (push-review-core.sh §129
 * and §601): `git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'`.
 */
export function resolveUpstream(runner: GitRunner, cwd: string): string | null {
  const r = runner(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd);
  if (r.status !== 0) return null;
  const out = r.stdout;
  return out.length > 0 ? out : null;
}

/**
 * Check whether a commit object is locally resolvable. Bash-core parity
 * (push-review-core.sh §743): `git cat-file -e <sha>^{commit}`. Returns
 * true on exit 0, false otherwise. Used before merge-base computation on
 * the non-new-branch path — if the remote ref isn't fetched, `git merge-
 * base` would silently return an unrelated base and the gate would diff
 * against the wrong anchor.
 */
export function hasCommitLocally(runner: GitRunner, cwd: string, sha: string): boolean {
  if (!SHA_HEX_40.test(sha)) return false;
  const r = runner(['cat-file', '-e', `${sha}^{commit}`], cwd);
  return r.status === 0;
}

/**
 * Compute the merge-base between two refs. Returns the SHA on success,
 * null on failure or empty output. Bash-core parity
 * (push-review-core.sh §756 and §860): `git merge-base <a> <b>`.
 */
export function mergeBase(runner: GitRunner, cwd: string, a: string, b: string): string | null {
  const r = runner(['merge-base', a, b], cwd);
  if (r.status !== 0) return null;
  const sha = r.stdout;
  return SHA_HEX_40.test(sha) ? sha : null;
}

/**
 * True iff `ref` is a resolvable rev (commit, tag, or branch). Bash-core
 * parity (push-review-core.sh §815 and §835): `git rev-parse --verify
 * --quiet <ref>` with stdout suppressed and stderr ignored.
 */
export function refExists(runner: GitRunner, cwd: string, ref: string): boolean {
  const r = runner(['rev-parse', '--verify', '--quiet', ref], cwd);
  return r.status === 0;
}

/**
 * Read a git config value (e.g. `branch.<name>.base`). Returns the value
 * or the empty string when the config entry is absent or `git config` fails.
 * Bash-core parity (push-review-core.sh §808): `git config --get <key>`.
 */
export function readGitConfig(runner: GitRunner, cwd: string, key: string): string {
  const r = runner(['config', '--get', key], cwd);
  if (r.status !== 0) return '';
  return r.stdout;
}

/**
 * Resolve `refs/remotes/<remote>/HEAD` to its symbolic target (e.g.
 * `refs/remotes/origin/main`). Returns null on failure. Bash-core parity
 * (push-review-core.sh §826): `git symbolic-ref refs/remotes/<remote>/HEAD`.
 */
export function resolveRemoteDefaultRef(
  runner: GitRunner,
  cwd: string,
  remote: string,
): string | null {
  const r = runner(['symbolic-ref', `refs/remotes/${remote}/HEAD`], cwd);
  if (r.status !== 0) return null;
  const out = r.stdout;
  return out.length > 0 ? out : null;
}

/**
 * Full `git diff <a>..<b>` output (two-dot per the §1053-1060 rationale).
 * Returns the diff body on success; throws via the typed error if git
 * exits non-zero so the caller can translate to the banner + exit 2.
 *
 * Empty diff → empty string, status 0 is a legitimate no-op push and the
 * caller routes to its "no reviewable diff" branch.
 */
export interface DiffResult {
  /** The full `git diff` output (may be empty). */
  diff: string;
  /** git's exit code. */
  status: number;
  /** git's stderr for error-path diagnostics. */
  stderr: string;
}

export function fullDiff(runner: GitRunner, cwd: string, a: string, b: string): DiffResult {
  const r = runner(['diff', `${a}..${b}`], cwd);
  return { diff: r.stdout, status: r.status, stderr: r.stderr };
}

/**
 * `git diff --name-status <a>..<b>` output. One line per change, tab-
 * separated `<STATUS>\t<path1>[\t<path2>]`. Consumed by
 * `protected-paths.ts`. Returns stdout on success or null on error (the
 * caller emits a banner + exit 2; see bash core §904-914).
 */
export interface NameStatusResult {
  /** Raw name-status output (may be empty on a zero-change diff). */
  output: string;
  /** git's exit code. */
  status: number;
  /** git's stderr for error-path diagnostics. */
  stderr: string;
}

export function diffNameStatus(
  runner: GitRunner,
  cwd: string,
  a: string,
  b: string,
): NameStatusResult {
  const r = runner(['diff', '--name-status', `${a}..${b}`], cwd);
  return { output: r.stdout, status: r.status, stderr: r.stderr };
}

/**
 * Commit count between two refs. Bash-core parity
 * (push-review-core.sh §996): `git rev-list --count <a>..<b>`. Returns -1
 * on error so callers can distinguish "git failed" (exit 2) from "zero
 * commits" (legitimate, usually a same-ref push).
 */
export function revListCount(runner: GitRunner, cwd: string, a: string, b: string): number {
  const r = runner(['rev-list', '--count', `${a}..${b}`], cwd);
  if (r.status !== 0) return -1;
  const n = Number.parseInt(r.stdout, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Resolve the repository's common-dir (the path to `.git` or to a
 * shared worktree parent). Returns the absolute path or null when not in
 * a git repo. Bash-core parity (push-review-core.sh §272-273):
 * `git rev-parse --path-format=absolute --git-common-dir`.
 *
 * Used by the cross-repo guard in §1a to distinguish two checkouts of the
 * same repo (linked worktrees share a common-dir) from two unrelated
 * repos. Phase 2a ships the primitive; composition happens in Phase 2b.
 */
export function gitCommonDir(runner: GitRunner, cwd: string): string | null {
  const r = runner(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (r.status !== 0) return null;
  const out = r.stdout;
  return out.length > 0 ? out : null;
}

/**
 * Read git's user email + name fallback for skip-audit actor attribution.
 * Bash-core parity (push-review-core.sh §393-396 and §563-566): prefer
 * email; fall back to name if email is empty; empty string if both missing.
 */
export function readGitActor(runner: GitRunner, cwd: string): string {
  const email = readGitConfig(runner, cwd, 'user.email');
  if (email.length > 0) return email;
  return readGitConfig(runner, cwd, 'user.name');
}
