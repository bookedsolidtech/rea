/**
 * Worktree-aware `.rea/` root resolution — THE single seam that fixes
 * multi-stream state clobbering.
 *
 * # The problem this closes
 *
 * rea historically resolved "the root" three different ways: `rea
 * review` used the git toplevel, hook bodies used `CLAUDE_PROJECT_DIR
 * ?? cwd`, and preflight/push-gate/freeze used raw `process.cwd()`. In
 * a plain checkout the three coincide. In git WORKTREES they do not:
 * Claude Code pins `CLAUDE_PROJECT_DIR` to the main checkout while the
 * session works in a linked worktree, so gates read main's `.rea/`
 * while `rea review` writes the worktree's — and parallel sessions
 * clobber `.rea/last-review.json` in whichever root they happened to
 * agree on.
 *
 * # The model
 *
 * Every rea process resolves TWO roots:
 *
 *   - `localRoot`  — the current worktree's checkout root. Holds
 *     per-stream state: `policy.yaml` reads (checked in, versioned with
 *     the branch), `last-review.json`, `review-parity.json`,
 *     `metrics.jsonl`, serve pid/state, delegation-advisory session
 *     state, install-manifest.
 *   - `commonRoot` — the PRIMARY checkout root (the worktree whose
 *     `.git` is a directory). Holds per-REPOSITORY enforcement state:
 *     `audit.jsonl` (+ rotations + the audit lock target), `HALT` (one
 *     kill switch per repository — operator ruling 2026-07-16),
 *     `last-review.cache.json` (sha-keyed verdict reuse across
 *     streams), `fingerprints.json` (TOFU trust).
 *
 * Classification rule: ENFORCEMENT state is COMMON; forensic /
 * telemetry / process state is LOCAL.
 *
 * # The load-bearing invariant
 *
 * In a non-worktree repo `commonRoot === localRoot` and every path
 * degenerates to exactly the pre-worktree behavior — zero change for
 * the entire installed base, and the existing test suite (which passes
 * explicit `reaRoot` overrides into non-git temp dirs) is untouched.
 *
 * # Cost discipline
 *
 * The linked-worktree discriminator is `stat(<localRoot>/.git)`: a
 * DIRECTORY (or nothing) means primary checkout — zero git subprocesses
 * on the hot path; a FILE means linked worktree — exactly one
 * `git rev-parse --git-common-dir` spawn, only in that case.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ReaRoots {
  /** The current worktree's checkout root (per-stream state). */
  localRoot: string;
  /** The primary checkout root (per-repository enforcement state). */
  commonRoot: string;
  /** True when localRoot is a LINKED worktree of commonRoot. */
  isLinkedWorktree: boolean;
}

/**
 * Resolve the current checkout root from `startDir`:
 * git toplevel → nearest-`.rea/` ancestor walk → `startDir` verbatim.
 *
 * The toplevel is authoritative when git answers (matches
 * `resolveRepoRoot` in src/cli/review.ts — repo-root-relative diff
 * paths and top-level `.rea/` both depend on it). The `.rea/` walk
 * covers non-git installs; the verbatim fallback covers everything
 * else (the caller's existing "treat startDir as root" behavior).
 */
export function resolveLocalRoot(startDir: string): string {
  const top = tryGit(startDir, ['rev-parse', '--show-toplevel']);
  if (top.length > 0) return top;
  let dir = path.resolve(startDir);
  // Walk up to the nearest `.rea/` (mirrors the bash rea_root()).
  for (;;) {
    if (fs.existsSync(path.join(dir, '.rea'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/**
 * Resolve the primary-checkout root for `localRoot`.
 *
 * Discriminator: `<localRoot>/.git` as a FILE marks a linked worktree
 * (its content points into the primary's `.git/worktrees/<name>`); a
 * directory (or nothing — non-git install) marks the primary checkout
 * itself, where common === local with no subprocess spawned.
 *
 * Failure posture: any git failure, or a common-dir parent that looks
 * like a BARE repository host (no `.rea/` and no `.git/` at the
 * candidate root — there is no checkout to anchor shared state in),
 * degenerates to `commonRoot = localRoot` with a one-line stderr
 * advisory. Degenerate means "per-worktree isolated", i.e. exactly the
 * pre-worktree behavior — never a crash, never a half-shared state.
 */
export function resolveCommonRoot(
  localRoot: string,
  stderrWrite: (s: string) => void = (s) => process.stderr.write(s),
): { commonRoot: string; isLinkedWorktree: boolean } {
  const degenerate = { commonRoot: localRoot, isLinkedWorktree: false };
  let dotGit: fs.Stats;
  try {
    dotGit = fs.statSync(path.join(localRoot, '.git'));
  } catch {
    return degenerate; // non-git install
  }
  if (dotGit.isDirectory()) return degenerate; // primary checkout
  if (!dotGit.isFile()) return degenerate;

  const commonDirRaw = tryGit(localRoot, ['rev-parse', '--git-common-dir']);
  if (commonDirRaw.length === 0) return degenerate;
  const commonDir = path.isAbsolute(commonDirRaw)
    ? commonDirRaw
    : path.join(localRoot, commonDirRaw);
  const candidate = path.dirname(path.resolve(commonDir));
  if (path.resolve(candidate) === path.resolve(localRoot)) return degenerate;

  // Bare-repo edge: the common dir's parent is not a checkout (no
  // `.rea/`, no `.git/`) — there is nowhere sane to anchor shared
  // state, so stay per-worktree and say so once.
  const looksLikeCheckout =
    fs.existsSync(path.join(candidate, '.rea')) || fs.existsSync(path.join(candidate, '.git'));
  if (!looksLikeCheckout) {
    stderrWrite(
      `rea: linked worktree of a bare repository — shared .rea state unavailable, using per-worktree state at ${localRoot}\n`,
    );
    return degenerate;
  }
  return { commonRoot: candidate, isLinkedWorktree: true };
}

/** Compose local + common resolution from a starting directory. */
export function resolveReaRoots(
  startDir: string,
  stderrWrite?: (s: string) => void,
): ReaRoots {
  const localRoot = resolveLocalRoot(startDir);
  const { commonRoot, isLinkedWorktree } = resolveCommonRoot(localRoot, stderrWrite);
  return { localRoot, commonRoot, isLinkedWorktree };
}

/**
 * Hook-tier resolution: the guarded candidate ladder.
 *
 *   payload `cwd` → `CLAUDE_PROJECT_DIR` → `process.cwd()`
 *
 * A candidate is accepted ONLY if its resolved localRoot actually
 * contains `.rea/` — an agent that `cd /tmp` before a tool call must
 * not drag the gates to a root with no policy, where every check would
 * silently no-op (fail-open). When no candidate qualifies, the last
 * fallback (`process.cwd()`-resolved) is returned anyway, which is
 * byte-identical to the pre-worktree hook behavior.
 *
 * `explicitRoot` (the hooks' `options.reaRoot` test seam) short-
 * circuits the ladder entirely and — like today — is trusted verbatim,
 * with common resolution still applied so worktree tests can exercise
 * both roots.
 */
export function resolveHookRoots(
  payloadCwd: string | undefined,
  explicitRoot?: string,
  stderrWrite?: (s: string) => void,
): ReaRoots {
  if (explicitRoot !== undefined) {
    const { commonRoot, isLinkedWorktree } = resolveCommonRoot(explicitRoot, stderrWrite);
    return { localRoot: explicitRoot, commonRoot, isLinkedWorktree };
  }
  const candidates: string[] = [];
  if (payloadCwd !== undefined && payloadCwd.length > 0) candidates.push(payloadCwd);
  const envDir = process.env['CLAUDE_PROJECT_DIR'];
  if (envDir !== undefined && envDir.length > 0) candidates.push(envDir);
  candidates.push(process.cwd());

  let fallback: ReaRoots | null = null;
  for (const candidate of candidates) {
    let roots: ReaRoots;
    try {
      roots = resolveReaRoots(candidate, stderrWrite);
    } catch {
      continue;
    }
    if (fs.existsSync(path.join(roots.localRoot, '.rea'))) return roots;
    if (fallback === null) fallback = roots;
  }
  // No candidate has `.rea/` — preserve the historical behavior of the
  // FIRST candidate (payload cwd / env / cwd order) so a repo without a
  // rea install behaves exactly as before this module existed.
  return fallback ?? resolveReaRoots(process.cwd(), stderrWrite);
}

function tryGit(cwd: string, args: string[]): string {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
    if (r.status !== 0 || typeof r.stdout !== 'string') return '';
    return r.stdout.trim();
  } catch {
    return '';
  }
}
