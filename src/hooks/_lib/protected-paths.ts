/**
 * Shared protected-paths catalog for the Node-binary hook tier.
 *
 * 0.35.0 — TypeScript port of `hooks/_lib/protected-paths.sh`. The
 * canonical hard-protected list shared between the Write/Edit tier
 * (`settings-protection`) and the Bash tier (`protected-paths-bash-
 * gate` → already in the bash-scanner module via `runProtectedScan`).
 *
 * # Why a TS port at all?
 *
 * The bash helper is sourced into both `settings-protection.sh` and
 * the Bash-tier scanner caller. Now that settings-protection.sh is
 * being moved to Node-binary in 0.35.0, the protected-list resolution
 * needs to land in TypeScript too — otherwise the new `runSettingsProtection`
 * would have to shell out to bash to read the list, which defeats the
 * point of the Node-binary migration.
 *
 * # Kill-switch invariants (NON-RELAXABLE)
 *
 * These are ALWAYS protected, even when listed in `protected_paths_relax`:
 *
 *   .rea/HALT                      — the kill switch itself
 *   .rea/policy.yaml               — the policy that defines all enforcement
 *   .claude/settings.json          — the hook registration that activates rea
 *   .rea/last-review.cache.json    — verdict-cache security boundary
 *   .rea/last-review.json          — operator forensic snapshot
 *
 * # Policy interaction
 *
 *   - `protected_writes` (optional list): when set, FULLY REPLACES the
 *     hardcoded default. Kill-switch invariants are added back
 *     defensively. The override pattern set is tracked separately so
 *     `isProtected()` can prioritize override matches over the
 *     extension-surface allow-list (helix-020 G2 fix).
 *   - `protected_paths_relax` (list): SUBTRACTS from whatever the
 *     effective set is. Kill-switch invariants in this list are silently
 *     dropped + an advisory is emitted to stderr (caller's responsibility
 *     to surface).
 */

export const KILL_SWITCH_INVARIANTS: readonly string[] = [
  '.claude/settings.json',
  '.rea/policy.yaml',
  '.rea/HALT',
  '.rea/last-review.cache.json',
  '.rea/last-review.json',
];

/**
 * Hardcoded historical default — the 7 patterns the bash helper ships
 * (`REA_PROTECTED_PATTERNS_FULL`). Suffix `/` indicates prefix match;
 * no suffix means case-insensitive exact match.
 */
export const PROTECTED_PATTERNS_FULL: readonly string[] = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.husky/',
  '.rea/policy.yaml',
  '.rea/HALT',
  '.rea/last-review.cache.json',
  '.rea/last-review.json',
];

/**
 * Patch-session patterns — protected from agents by default but
 * unlockable by setting `REA_HOOK_PATCH_SESSION=<reason>`. Mirrors
 * `PATCH_SESSION_PATTERNS` in settings-protection.sh §6b.
 */
export const PATCH_SESSION_PATTERNS: readonly string[] = ['.claude/hooks/'];

/**
 * Documented husky extension surface — `.husky/{commit-msg,pre-push,
 * pre-commit,prepare-commit-msg}.d/*`. Consumers write extension
 * fragments here freely; the §6 prefix block on `.husky/` would
 * otherwise catch them.
 *
 * The bare directory itself (e.g. `.husky/pre-push.d/`) is NOT
 * considered extension-surface — only fragments INSIDE the surface.
 */
export function isExtensionSurface(p: string): boolean {
  const lower = p.toLowerCase();
  const surfaces = [
    '.husky/commit-msg.d/',
    '.husky/pre-push.d/',
    '.husky/pre-commit.d/',
    '.husky/prepare-commit-msg.d/',
  ];
  // Refuse the bare directory itself.
  for (const s of surfaces) {
    if (lower === s) return false;
    if (lower === s.slice(0, -1)) return false; // without trailing slash
  }
  for (const s of surfaces) {
    if (lower.startsWith(s) && lower.length > s.length) {
      return true;
    }
  }
  return false;
}

/**
 * Effective protected-pattern set after applying `protected_writes`
 * (full override) and `protected_paths_relax` (subtractor).
 */
export interface ProtectedPatternResolution {
  /** Full effective list, kill-switch invariants always present. */
  patterns: readonly string[];
  /**
   * Subset of `patterns` that came from an explicit `protected_writes`
   * declaration. Used by `isProtected()` to prioritize override matches
   * over the extension-surface allow-list (helix-020 G2 fix).
   */
  overridePatterns: readonly string[];
  /**
   * Stderr advisories the caller should emit BEFORE doing path checks
   * (kill-switch invariants found in `protected_paths_relax`).
   */
  advisories: readonly string[];
}

export interface ResolvePolicyInput {
  /** `policy.protected_writes` — undefined when unset. */
  protectedWrites?: readonly string[];
  /** `policy.protected_paths_relax` — empty array when unset. */
  protectedPathsRelax?: readonly string[];
}

/**
 * Resolve the effective hard-protected pattern set against policy.
 * Pure function — no I/O, no stderr emission. Stderr advisories come
 * back as strings so the caller can route them appropriately.
 */
export function resolveProtectedPatterns(
  input: ResolvePolicyInput = {},
): ProtectedPatternResolution {
  const writes = input.protectedWrites;
  const relax = input.protectedPathsRelax ?? [];

  // 1. Compose the BASE list.
  const baseList: string[] = [];
  if (writes !== undefined) {
    // protected_writes set — replaces the default.
    for (const w of writes) {
      if (typeof w === 'string' && w.length > 0) baseList.push(w);
    }
    // Add kill-switch invariants if not already present (case-insensitive).
    for (const inv of KILL_SWITCH_INVARIANTS) {
      const invLc = inv.toLowerCase();
      if (!baseList.some((b) => b.toLowerCase() === invLc)) {
        baseList.push(inv);
      }
    }
  } else {
    for (const pat of PROTECTED_PATTERNS_FULL) baseList.push(pat);
  }

  // 2. Validate relax entries — kill-switch invariants are non-relaxable.
  const advisories: string[] = [];
  const relaxedSet: string[] = [];
  for (const r of relax) {
    if (typeof r !== 'string' || r.length === 0) continue;
    if (KILL_SWITCH_INVARIANTS.some((inv) => inv.toLowerCase() === r.toLowerCase())) {
      advisories.push(
        `rea: protected_paths_relax: ${r} is a kill-switch invariant and cannot be relaxed; ignoring.\n`,
      );
    } else {
      relaxedSet.push(r);
    }
  }

  // 3. Build the effective list — base entries NOT in relaxed set
  //    (case-insensitive comparison).
  const patterns: string[] = [];
  for (const pat of baseList) {
    const patLc = pat.toLowerCase();
    const relaxed = relaxedSet.some((r) => r.toLowerCase() === patLc);
    if (!relaxed) patterns.push(pat);
  }

  // 4. Build the OVERRIDE subset (only entries from `protected_writes`,
  //    NOT kill-switch invariants added back defensively). Mirrors
  //    REA_PROTECTED_OVERRIDE_PATTERNS in the bash helper.
  const overridePatterns: string[] = [];
  if (writes !== undefined) {
    for (const w of writes) {
      if (typeof w !== 'string' || w.length === 0) continue;
      const wLc = w.toLowerCase();
      const relaxed = relaxedSet.some((r) => r.toLowerCase() === wLc);
      if (!relaxed) overridePatterns.push(w);
    }
  }

  return { patterns, overridePatterns, advisories };
}

/**
 * Match a project-relative path against a pattern list. Mirrors the
 * shell exact-equal AND the trailing-slash prefix-glob shapes,
 * case-INSENSITIVE.
 *
 * Returns the matched pattern (preserving its original case) or `null`.
 */
export function matchAny(
  pathLc: string,
  patterns: readonly string[],
): string | null {
  for (const pattern of patterns) {
    const patternLc = pattern.toLowerCase();
    if (pathLc === patternLc) return pattern;
    if (patternLc.endsWith('/') && pathLc.startsWith(patternLc)) return pattern;
  }
  return null;
}

/**
 * Full equivalent of `rea_path_is_protected` from the bash helper.
 * Three-step decision:
 *
 *   1. Explicit `protected_writes` overrides win FIRST (helix-020 G2).
 *   2. Extension-surface allow-list short-circuits "not protected"
 *      for `.husky/{commit-msg,pre-push,pre-commit,prepare-commit-msg}.d`
 *      fragments.
 *   3. Default hard-protected list (kill-switch invariants + the
 *      historical patterns from PROTECTED_PATTERNS_FULL).
 */
export function isProtected(
  pathRel: string,
  resolution: ProtectedPatternResolution,
): { protected: boolean; matchedPattern: string | null } {
  const lower = pathRel.toLowerCase();
  // 1. Explicit overrides win.
  const overrideHit = matchAny(lower, resolution.overridePatterns);
  if (overrideHit !== null) {
    return { protected: true, matchedPattern: overrideHit };
  }
  // 2. Extension-surface short-circuit.
  if (isExtensionSurface(pathRel)) {
    return { protected: false, matchedPattern: null };
  }
  // 3. Default protected list.
  const defaultHit = matchAny(lower, resolution.patterns);
  if (defaultHit !== null) {
    return { protected: true, matchedPattern: defaultHit };
  }
  return { protected: false, matchedPattern: null };
}

/**
 * Strip C0/C1 control characters from a string before echoing it back to
 * the operator. Mirrors `sanitize_for_stderr` in settings-protection.sh.
 *
 * Byte ranges stripped (after UTF-16→code-point):
 *    –  — C0 controls (BEL, BS, HT, LF, CR, ESC, …)
 *            — DEL
 *   –  — C1 controls (CSI, OSC, …)
 *
 * String-level filter — does NOT operate on raw bytes. Sufficient for
 * the bash helper's use case: file-name display in error messages.
 */
export function sanitizeForStderr(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x00 && cp <= 0x1f) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      continue;
    }
    out += ch;
  }
  return out;
}
