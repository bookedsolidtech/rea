/**
 * Operator-facing banner composition.
 *
 * The bash core builds its banners via `printf` inside a `{ ... } >&2`
 * block, counting diff lines with `grep -cE ...` and file changes with
 * `grep -c '^+++ '`. Defect K (rea#62) surfaced because `grep -c`
 * emits `0` to stdout AND exits non-zero on no-match, and the bash author
 * wrote `$(grep -c ... || echo 0)` — which emitted `0\n0` when the pipe
 * produced no matches. The fix in the bash core was `|| true` + default
 * via `${LINE_COUNT:-0}`.
 *
 * The TS port closes this entire class of bug: counting happens over an
 * actual string in Node, not via a pipe-on-a-side-effect. The only way
 * LINE_COUNT / FILE_COUNT can ever be wrong now is a test-missed edge in
 * `countChangedLines` or `countChangedFiles` — unit tests in `banner.test.ts`
 * cover the zero case, the empty-diff case, the unicode-filename case, and
 * the `+++ b/-file` edge explicitly.
 *
 * ## Format parity
 *
 * `renderPushReviewRequiredBanner` reproduces the byte-exact output of the
 * bash core's "PUSH REVIEW GATE: Review required..." block, including the
 * cache-disabled fallback branch. A fixture test in `banner.test.ts` asserts
 * the output against a snapshot captured from the 0.10.1 bash core.
 */

export interface DiffStats {
  /** Number of `^\+[^+]|^-[^-]` lines in the unified diff. */
  line_count: number;
  /** Number of `^\+\+\+ ` lines (one per changed file). */
  file_count: number;
}

/**
 * Count lines that begin with `+` followed by a non-`+` character, OR `-`
 * followed by a non-`-` character. Bash-core parity (push-review-core.sh
 * §1082): `grep -cE '^\+[^+]|^-[^-]'`. This rejects every line whose
 * SECOND character is the same as the first — not just `+++`/`---`
 * headers, but also pathological `++foo` and `--bar` strings (which bash
 * did not count). Codex pass-1 on phase 1 flagged the earlier too-lax
 * char-1-only TS implementation that would have silently changed the
 * Scope: banner line count vs. bash and broken phase-4 byte compatibility.
 *
 * Empty input → 0. Bare `+` or `-` (single char line) → 0, same as bash
 * (the regex requires a second character).
 */
export function countChangedLines(diff: string): number {
  if (diff.length === 0) return 0;
  let n = 0;
  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.length < 2) continue;
    const c0 = line.charCodeAt(0);
    const c1 = line.charCodeAt(1);
    // `+` = 43: match only when char-2 is NOT `+`.
    if (c0 === 43 && c1 !== 43) {
      n++;
      continue;
    }
    // `-` = 45: match only when char-2 is NOT `-`.
    if (c0 === 45 && c1 !== 45) {
      n++;
      continue;
    }
    // Any other leading char, including `++...` and `--...`, is skipped.
  }
  return n;
}

/**
 * Count `^\+\+\+ ` header lines (one per file in the diff). Parity with
 * the bash core's `grep -c '^\+\+\+ '`.
 */
export function countChangedFiles(diff: string): number {
  if (diff.length === 0) return 0;
  let n = 0;
  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ ')) n++;
  }
  return n;
}

/**
 * Compute `{line_count, file_count}` over a diff string. Exposed separately
 * so callers can use just the stats without generating the full banner.
 */
export function computeDiffStats(diff: string): DiffStats {
  return {
    line_count: countChangedLines(diff),
    file_count: countChangedFiles(diff),
  };
}

export interface PushReviewRequiredBannerInput {
  /** The ref being pushed (e.g. `refs/heads/feature/foo` or `HEAD`). */
  source_ref: string;
  /** The source commit SHA (12 chars + rest; full sha expected). */
  source_sha: string;
  /** Target branch / base label (defect N completion surfaces here). */
  target_branch: string;
  /** Resolved merge-base SHA. */
  merge_base: string;
  /** Diff stats — pre-computed by `computeDiffStats`. */
  stats: DiffStats;
  /**
   * The sha256-of-diff cache key. When empty, the banner emits the
   * cache-disabled fallback branch (`Cache is DISABLED on this host`).
   */
  push_sha: string;
  /** Source branch name for the `rea cache set` hint. */
  source_branch: string;
}

/**
 * Compose the "PUSH REVIEW GATE: Review required before pushing" banner.
 * Output goes to stderr via the caller; this function is pure. Returns the
 * exact text the bash core would have printed (including trailing blank
 * line and spacing), so the fixture snapshot can be compared byte-exactly.
 */
export function renderPushReviewRequiredBanner(input: PushReviewRequiredBannerInput): string {
  const lines: string[] = [];
  lines.push('PUSH REVIEW GATE: Review required before pushing');
  lines.push('');
  lines.push(`  Source ref: ${input.source_ref} (${input.source_sha.slice(0, 12)})`);
  lines.push(`  Target: ${input.target_branch}`);
  lines.push(`  Scope: ${input.stats.file_count} files changed, ${input.stats.line_count} lines`);
  lines.push('');
  lines.push('  Action required:');
  lines.push(
    `  1. Spawn a code-reviewer agent to review: git diff ${input.merge_base}..${input.source_sha}`,
  );
  lines.push('  2. Spawn a security-engineer agent for security review');
  if (input.push_sha.length > 0) {
    lines.push('  3. After both pass, cache the result:');
    lines.push(
      `     rea cache set ${input.push_sha} pass --branch ${input.source_branch} --base ${input.target_branch}`,
    );
  } else {
    lines.push('  3. Cache is DISABLED on this host (no sha256 hasher found).');
    lines.push('     After both reviews pass, bypass the push-review gate with:');
    lines.push('       REA_SKIP_PUSH_REVIEW="<reason>" git push ...');
    lines.push('     The bypass is audited as push.review.skipped — this is the');
    lines.push('     documented escape hatch when cache is unavailable.');
    lines.push('     To restore the cache path, install one of: sha256sum,');
    lines.push('     shasum (Perl Digest::SHA), or openssl.');
  }
  lines.push('');
  // bash `printf '%s\n'` with no trailing args adds a final newline; the
  // block renders terminal-ready. `lines.join('\n') + '\n'` reproduces
  // exactly that shape.
  return lines.join('\n') + '\n';
}

export interface ProtectedPathsBlockedBannerInput {
  source_ref: string;
  source_sha: string;
}

/**
 * Compose the "PUSH BLOCKED: protected paths changed — /codex-review
 * required" banner. Pure; exit-2 translation happens in the CLI shim.
 */
export function renderProtectedPathsBlockedBanner(input: ProtectedPathsBlockedBannerInput): string {
  const lines: string[] = [];
  lines.push(
    `PUSH BLOCKED: protected paths changed — /codex-review required for ${input.source_sha}`,
  );
  lines.push('');
  lines.push(`  Source ref: ${input.source_ref}`);
  lines.push('  Diff touches one of:');
  lines.push('    - src/gateway/middleware/');
  lines.push('    - hooks/');
  lines.push('    - .claude/hooks/');
  lines.push('    - src/policy/');
  lines.push('    - .github/workflows/');
  lines.push('    - .rea/');
  lines.push('    - .husky/');
  lines.push('');
  lines.push(`  Run /codex-review against ${input.source_sha}, then retry the push.`);
  lines.push('  The codex-adversarial agent emits the required audit entry.');
  lines.push('  Only `pass` or `concerns` verdicts satisfy this gate.');
  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * Strip C0 control characters (0x00-0x1F, 0x7F) and C1 (0x80-0x9F) from a
 * string. Used when a banner embeds text from a subprocess's stderr (e.g.
 * the cache-check failure case). Mirrors the `LC_ALL=C tr -d` invocation
 * in the bash core's cache-error path. Codex LOW 5 on the 0.9.4 pass.
 */
export function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    // Allow tab (9), LF (10), CR (13) — but not any other C0/C1 byte.
    if (c === 9 || c === 10 || c === 13) {
      out += input[i];
      continue;
    }
    if (c <= 0x1f) continue;
    if (c === 0x7f) continue;
    if (c >= 0x80 && c <= 0x9f) continue;
    out += input[i];
  }
  return out;
}
