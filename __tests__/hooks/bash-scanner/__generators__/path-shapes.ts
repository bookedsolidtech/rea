/**
 * Dim 5 — Path-normalization edge cases. Each shape rewrites a target
 * path while preserving the canonical resolved form. The scanner's
 * `normalizeTarget` (`protected-scan.ts`) collapses these to the same
 * lowercase project-relative pattern.
 *
 * Bypass class: helix-022 #1 (.. walk-up), helix-021 (case-insensitive
 * macOS), helix-015 (URL-encoded paths), R2 (multi-slash, traversal).
 *
 * NOTE: backslash-as-path-separator is NOT a valid Unix attack vector —
 * bash strips a single `\X` to `X` at parse time, so `.rea\HALT` becomes
 * `.reaHALT` (a different filename). We intentionally do NOT include
 * a `bs-separator` shape; the scanner correctly allows `printf x >
 * .rea\HALT` because that command does not in fact write to a protected
 * file. (The blocked-paths gate's policy normalization translates `\`
 * to `/` in the POLICY-derived patterns it loads, but the runtime path
 * IS taken at face value.)
 */

export interface PathShape {
  id: string;
  apply: (target: string) => string;
  /** Whether the resulting form should still match the protected list.
   *  All current shapes preserve the canonical form, so all return true. */
  shouldStillMatch: boolean;
}

export const PATH_SHAPES: readonly PathShape[] = [
  { id: 'direct', apply: (p) => p, shouldStillMatch: true },

  // Leading `./` strip — normalizer drops it.
  { id: 'leading-dot', apply: (p) => `./${p}`, shouldStillMatch: true },
  { id: 'leading-dot-2', apply: (p) => `././${p}`, shouldStillMatch: true },

  // `.` mid-path: `.rea/./HALT` → `.rea/HALT`.
  {
    id: 'mid-dot',
    apply: (p) => p.replace(/\//, '/./'),
    shouldStillMatch: true,
  },

  // `..` traversal: foo/../.rea/HALT — normalizer walks up.
  { id: 'traversal-up', apply: (p) => `foo/../${p}`, shouldStillMatch: true },
  { id: 'traversal-deep', apply: (p) => `a/b/c/../../../${p}`, shouldStillMatch: true },

  // Case variants for macOS APFS — case-insensitive match.
  // helix-021. Always upper-case the FIRST letter.
  {
    id: 'case-upper-first',
    apply: (p) => p.charAt(0).toUpperCase() + p.slice(1),
    shouldStillMatch: true,
  },
  // Mixed case: .Rea/HALT → matches .rea/HALT.
  {
    id: 'case-mixed',
    apply: (p) => {
      // Capitalize alternating chars.
      return p
        .split('')
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
        .join('');
    },
    shouldStillMatch: true,
  },
  // ALL CAPS — also matches.
  { id: 'case-upper', apply: (p) => p.toUpperCase(), shouldStillMatch: true },

  // Multiple slashes — `.rea//HALT` → `.rea/HALT`.
  { id: 'double-slash', apply: (p) => p.replace(/\//, '//'), shouldStillMatch: true },
  { id: 'triple-slash', apply: (p) => p.replace(/\//, '///'), shouldStillMatch: true },

  // URL-encoded path: %2Erea/HALT (%2E is `.`)
  {
    id: 'url-enc-dot',
    apply: (p) => (p.startsWith('.') ? `%2E${p.slice(1)}` : p),
    shouldStillMatch: true,
  },
  // Slash URL-encoded: .rea%2FHALT
  { id: 'url-enc-slash', apply: (p) => p.replace(/\//, '%2F'), shouldStillMatch: true },
  // Mixed URL-encoded.
  {
    id: 'url-enc-mixed',
    apply: (p) => {
      const replaced = p.replace(/\//, '%2F');
      return replaced.startsWith('.') ? `%2E${replaced.slice(1)}` : replaced;
    },
    shouldStillMatch: true,
  },
];
