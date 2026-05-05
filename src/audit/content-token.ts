/**
 * Content-token computation for the local-first review audit trail.
 *
 * 0.26.0 P1 fix (helix-026, codex finding 1): `rea preflight` originally
 * keyed reviews to `git rev-parse HEAD`. The local-first flow is
 * "working tree → review → fix → commit → push" — by design the COMMIT
 * happens AFTER the review, so HEAD changes between them. Matching by
 * `head_sha` guaranteed a stale lookup and broke the advertised loop.
 *
 * The fix is to record a token tied to the CONTENT codex actually
 * reviewed instead of the commit it sat on top of.
 *
 * 0.26.0 round-25 P1-A fix: codex `exec review` diffs the WORKING TREE
 * against base — meaning the token must reflect the working tree (with
 * any uncommitted edits), NOT `HEAD^{tree}`. Pre-fix the token was
 * computed via `git rev-parse HEAD^{tree}` — the LAST COMMIT's tree,
 * not the working-tree state codex actually reviewed. The documented
 * happy path is `edit → review → fix → commit → push`; after commit
 * HEAD changes, preflight's token doesn't match the audit entry's
 * token, and the gate REFUSES the very flow it documents.
 *
 * Fix: compute the WORKING-TREE token via `git stash create`. That
 * command returns the SHA of a commit object whose tree is the
 * working-tree + index merged. `git rev-parse <stash-sha>^{tree}` then
 * gives a deterministic fingerprint of what codex actually reviewed:
 *
 *   - At review time: working tree dirty → token = Tw (working-tree tree).
 *   - Operator commits: HEAD becomes B with tree Tb. Tb == Tw because
 *     `git commit` just persists the index, not new content.
 *   - Push time: working tree CLEAN, `git stash create` returns empty,
 *     fall back to `HEAD^{tree}` = Tb == Tw. Match. Allow.
 *
 * Stable behaviors preserved from the 0.26.0 finding-1 fix:
 *   - Stable across `git commit --amend` with no content change
 *   - Stable across rebases that don't touch content (fixup, reword)
 *   - Differs immediately on any real content edit
 *
 * NOTE: untracked AND `.gitignore`'d content is by design NOT part of
 * the token, because:
 *   - `git stash create` does not include untracked files (without `-u`,
 *     and even `-u` excludes ignored files).
 *   - `git push` cannot transmit them either.
 * So the token reflects what would actually be pushed. Codex review
 * follows the same `git diff` semantics.
 *
 * The audit record continues to record `head_sha` for forensics —
 * `content_token` is what `rea preflight` matches on. Legacy
 * `codex.review` audit entries (pre-0.26.0) only have `head_sha`;
 * preflight falls back to head-sha matching for those.
 */

import { spawnSync } from 'node:child_process';

/**
 * Git's well-known "empty tree" object SHA — the SHA-1 of an empty tree
 * object, identical across every git repository on Earth.
 *
 * Round-27 F2 fix: this constant exists so the unborn-HEAD bootstrap path
 * is symmetric between writer (`rea review` audit-record `head_sha`) and
 * reader (`rea preflight` HEAD probe). Pre-fix:
 *
 *   - `rea review` (writer) used `EMPTY_TREE_SHA` as the synthetic head
 *     when HEAD couldn't be resolved (round-25 P2-B).
 *   - `rea preflight` (reader) returned `''` for headSha AND empty
 *     contentToken on unborn HEAD, then refused with a both-empty guard.
 *
 * The asymmetry deadlocked the bootstrap flow `git init` →
 * `rea review` → `rea preflight` under `refuse_at: both`. Both sides
 * now reference THIS constant when HEAD cannot be resolved, so the
 * head_sha-fallback path in `findRecentLocalReview` matches uniformly.
 */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Compute a deterministic content token for the working tree.
 *
 * Returns `''` (empty string) when the tree token cannot be resolved
 * (no git repo, no HEAD, etc.). Callers MUST treat empty token as
 * "no token" — the audit record's `content_token` field should be
 * omitted in that case so `rea preflight` does not match a missing
 * token against a missing token (which would be a trivial bypass).
 *
 * The token is the SHA of the working-tree tree object (or HEAD's
 * tree object if the working tree is clean). Format: 40-char lowercase
 * hex (or 64-char if the repo uses SHA-256). The function does not
 * normalize or truncate — `rea preflight` does an exact-string match.
 *
 * Resolution order (round-25 P1-A):
 *   1. `git stash create` — non-empty stdout means there are tracked
 *      changes. The stash SHA is a commit object; its tree is the
 *      working-tree + index merged. Use `<sha>^{tree}` as treeSource.
 *      `git stash create` does NOT modify the stash list, working tree,
 *      or index — it only synthesizes a commit object pointing at the
 *      current state.
 *   2. Empty stdout from `git stash create` (or non-zero exit) → tree
 *      is clean OR repo is empty. Fall back to `HEAD^{tree}`. A clean
 *      working tree's tree object is identical to HEAD's tree by
 *      definition.
 *   3. Both fail → return empty string. `head_sha` fallback in
 *      preflight takes over.
 */
export function computeTreeToken(cwd: string): string {
  // Step 1: try `git stash create`. Width-preserved by design — never
  // touches the stash list, working tree, or index.
  const stashResult = spawnSync('git', ['stash', 'create'], {
    cwd,
    encoding: 'utf8',
  });
  let treeSource: string;
  if (stashResult.status === 0 && (stashResult.stdout ?? '').toString().trim().length > 0) {
    const stashSha = (stashResult.stdout ?? '').toString().trim();
    // Defensive: only accept hex SHA shapes — otherwise treat as
    // unresolvable and fall through to HEAD^{tree}.
    if (!/^[0-9a-f]{40,64}$/.test(stashSha)) {
      treeSource = 'HEAD^{tree}';
    } else {
      treeSource = `${stashSha}^{tree}`;
    }
  } else {
    // Step 2: clean working tree OR empty repo — clean tree's content
    // is identical to HEAD^{tree} by definition; resolve that. Empty
    // repo will fail in step 3 below and return empty string.
    treeSource = 'HEAD^{tree}';
  }
  const treeResult = spawnSync('git', ['rev-parse', treeSource], {
    cwd,
    encoding: 'utf8',
  });
  if (treeResult.status !== 0) return '';
  const out = (treeResult.stdout ?? '').toString().trim();
  // Defensive: only accept hex strings — git's tree SHA is always hex.
  // This rejects unexpected output (error messages, ANSI noise, etc.).
  if (!/^[0-9a-f]{40,64}$/.test(out)) return '';
  return out;
}
