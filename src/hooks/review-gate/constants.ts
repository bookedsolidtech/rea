/**
 * Constants shared across the review-gate modules. Kept in one file so the
 * values that a reader cares about (the all-zeros SHA, the empty-tree SHA,
 * the protected-path set) are trivially grep-able.
 */

/** The git-native "null" SHA — a deletion on the pre-push contract. */
export const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * The canonical empty-tree SHA-1. Used as the merge-base baseline when a
 * new-branch push has no remote-tracking ref to anchor on — `git diff
 * <empty-tree>..<local_sha>` gives the full push content, and the gate
 * treats it as a diff against nothing (which is what it is, operationally).
 */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * The protected-path set. A push that touches any file under one of these
 * prefixes requires a matching `codex.review` audit record with verdict in
 * {pass, concerns} AND emission_source in {rea-cli, codex-cli}. See the
 * THREAT_MODEL for the full threat statement, and the design doc §9 for
 * the carry-forward from the bash core.
 *
 * Pattern format: leading/trailing slashes stripped; matched as directory
 * prefixes by `protected-paths.ts`. Order is not significant (a hit on any
 * entry is sufficient), but we keep the list sorted for grep-ability.
 */
export const PROTECTED_PATH_PREFIXES: readonly string[] = [
  '.claude/hooks/',
  '.github/workflows/',
  '.husky/',
  '.rea/',
  'hooks/',
  'src/gateway/middleware/',
  'src/policy/',
] as const;
