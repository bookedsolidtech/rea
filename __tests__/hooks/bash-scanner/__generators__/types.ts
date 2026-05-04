/**
 * Shared types for the adversarial bash-scanner corpus generators.
 *
 * The corpus is the contract: a fixture's `cmd` is fed to the scanner
 * and the resulting verdict is compared against `expect`. Each fixture
 * carries dimensional metadata so failure messages identify which axis
 * of the parameter space tripped — invaluable for regression triage.
 */

export type Verdict = 'block' | 'allow';

/**
 * A generated test case. Dimensional fields make the fixture name
 * deterministic and human-readable in vitest output.
 */
export interface GeneratedFixture {
  /** The bash command string fed to the scanner. */
  cmd: string;
  /** Expected scanner verdict. */
  expect: Verdict;
  /** Bypass class label (A..I). */
  klass: string;
  /** Short slug summarizing the dimensional tuple, used in test name. */
  label: string;
  /** Why this fixture exists — e.g. "absolute /bin invocation of cp -t". */
  rationale: string;
}

/**
 * A skipped fixture — emitted by generators when a parameter combo is
 * syntactically invalid or doesn't model a meaningful attack. Counts
 * are reported in the coverage assertion to maintain visibility into
 * total candidate space size vs. live corpus size.
 */
export interface SkippedFixture {
  klass: string;
  label: string;
  reason: string;
}

export interface GenerationResult {
  fixtures: GeneratedFixture[];
  skipped: SkippedFixture[];
}

/**
 * The list of protected paths the scanner blocks by default in this
 * dogfood policy. Generators target these for positives. Keep the list
 * STATIC — every entry must match `HISTORICAL_DEFAULT_PROTECTED_PATTERNS`
 * in `src/hooks/bash-scanner/protected-scan.ts`.
 */
export const PROTECTED_TARGETS: readonly string[] = [
  '.rea/HALT',
  '.rea/policy.yaml',
  '.claude/settings.json',
  '.rea/last-review.json',
];

/**
 * Codex round 4 structural corpus extension: bare-directory ANCESTORS
 * of protected files. Used by destructive-primitive generators (rm -rf,
 * find -delete, FileUtils.rm_rf, shutil.rmtree). A destructive op
 * against an ancestor removes the protected file under it — the
 * scanner closes this via protected-ancestry matching (Finding 1).
 *
 * These are NOT direct entries in HISTORICAL_DEFAULT_PROTECTED_PATTERNS;
 * they're ancestors that protected-ancestry must catch. Without this
 * dimension, generators could not produce `rm -rf .rea`-style fixtures
 * — that was the structural gap Codex round 4 flagged.
 */
export const PROTECTED_DIR_ANCESTORS: readonly string[] = [
  '.rea',
  '.rea/',
  '.husky',
  '.husky/',
  '.claude',
  '.claude/',
];

/**
 * Non-protected targets used for negative-corpus generation. None of
 * these may overlap a protected pattern (case-insensitive) or fall
 * inside `.husky/` (also protected by the default pattern set).
 */
export const NEGATIVE_TARGETS: readonly string[] = [
  'dist/output.txt',
  'tmp/scratch.log',
  'build/manifest.json',
  '.rea-data/snapshot.json', // similar prefix but NOT in protected set
  'docs/notes.md',
];

/**
 * Codex round 4 structural corpus extension: non-protected directory
 * targets for destructive-primitive negative coverage. None of these
 * are ancestors of a protected file.
 */
export const NEGATIVE_DIR_TARGETS: readonly string[] = [
  'dist',
  'dist/',
  'tmp',
  'tmp/',
  'build',
  'build/',
  'node_modules',
  'node_modules/',
];
