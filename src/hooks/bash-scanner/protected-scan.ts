/**
 * Protected-paths policy composition. Mirrors the bash semantics in
 * `hooks/_lib/protected-paths.sh` byte-for-byte:
 *
 *   1. Build the effective protected set:
 *      - If policy.protected_writes is set: that list, plus kill-switch
 *        invariants always added.
 *      - Else: the historical default (REA_PROTECTED_PATTERNS_FULL).
 *      Then subtract policy.protected_paths_relax — but kill-switch
 *      invariants in the relax list are silently dropped from the
 *      relax set with a stderr advisory (not from the protected set).
 *
 *   2. The match check:
 *      a. Explicit `protected_writes` overrides win FIRST (helix-020 G2).
 *         Matched against the path BEFORE the extension-surface check.
 *      b. Extension-surface paths (`.husky/{commit-msg,pre-push,
 *         pre-commit}.d/<fragment>`) are NOT protected by default
 *         (helix-018 Option B / 0.16.4).
 *      c. Default protected list applies, with kill-switch invariants
 *         always enforced.
 *
 *   3. Pattern matching:
 *      - case-insensitive (macOS APFS — helix-015 #2)
 *      - trailing `/` is a prefix-match
 *      - everything else is exact-match
 *
 *   4. Path normalization runs BEFORE matching:
 *      - URL decode, backslash → slash, leading `./` strip
 *      - `..` walk-up via the parser-friendly equivalent of
 *        `cd -P / pwd -P` (we rely on `node:fs.realpathSync` for the
 *        symlink resolution; non-existent parents walk up to the
 *        nearest existing ancestor — helix-022 #1)
 *      - case-insensitive lowercase comparison
 *      - sentinel `__rea_unresolved_expansion__` for $-substitution
 *      - sentinel `__rea_outside_root__` for paths escaping REA_ROOT
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Policy } from '../../policy/types.js';
import type { DetectedWrite } from './walker.js';
import { allowVerdict, blockVerdict, type DetectedForm, type Verdict } from './verdict.js';

/**
 * Hardcoded historical default — when policy.protected_writes is not
 * set this is the protected list. Mirrors REA_PROTECTED_PATTERNS_FULL
 * in `hooks/_lib/protected-paths.sh`.
 *
 * Round-15 P3: `.github/workflows/` added so consumers without an
 * explicit `policy.blocked_paths` entry still refuse Bash-tier writes
 * to CI workflows. CLAUDE.md describes `.github/workflows/` as a
 * sensitive path requiring CODEOWNERS approval; the default protected
 * list now matches. Intentionally NOT a kill-switch invariant —
 * consumers may legitimately relax workflow protection via
 * `protected_paths_relax: ['.github/workflows/']` when they have no
 * CI safety story to protect.
 */
const HISTORICAL_DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.husky/',
  '.rea/policy.yaml',
  '.rea/HALT',
  '.rea/last-review.cache.json',
  '.rea/last-review.json',
  '.github/workflows/',
];

/**
 * Kill-switch invariants — never relaxable. These represent the
 * integrity of the governance layer; if a consumer could relax them
 * an agent could disable rea entirely.
 */
const KILL_SWITCH_INVARIANTS: readonly string[] = [
  '.claude/settings.json',
  '.rea/policy.yaml',
  '.rea/HALT',
  '.rea/last-review.cache.json',
  '.rea/last-review.json',
];

/**
 * Inputs the protected-scan composer needs. The caller collects these
 * from the environment + policy file once and passes them in. Keeps
 * the scanner function pure / testable.
 */
export interface ProtectedScanContext {
  reaRoot: string;
  policy: Pick<Policy, 'protected_writes' | 'protected_paths_relax'>;
  /**
   * Stderr sink for advisory messages (e.g. "kill-switch invariant in
   * protected_paths_relax"). Defaults to no-op so unit tests don't
   * pollute stdout.
   */
  stderr?: (line: string) => void;
}

interface EffectivePatterns {
  /** Full effective protected set (default OR override + invariants − relax). */
  full: string[];
  /** Subset that came from explicit `protected_writes` (overrides the extension-surface allow-list). */
  override: string[];
}

/**
 * Compute the effective protected pattern sets from policy. Pure — no
 * filesystem access.
 */
export function computeEffectivePatterns(ctx: ProtectedScanContext): EffectivePatterns {
  const writes = ctx.policy.protected_writes;
  const writesIsSet = writes !== undefined;
  const relax = ctx.policy.protected_paths_relax ?? [];

  // 1. Compose BASE list.
  let base: string[];
  if (writesIsSet && writes !== undefined) {
    base = [...writes];
    // Add kill-switch invariants if not already present (case-insensitive).
    for (const inv of KILL_SWITCH_INVARIANTS) {
      const invLc = inv.toLowerCase();
      if (!base.some((b) => b.toLowerCase() === invLc)) {
        base.push(inv);
      }
    }
  } else {
    base = [...HISTORICAL_DEFAULT_PROTECTED_PATTERNS];
  }

  // 2. Validate relax: drop kill-switch invariants with a stderr advisory.
  const validRelax: string[] = [];
  for (const r of relax) {
    if (isKillSwitchInvariant(r)) {
      ctx.stderr?.(
        `rea: protected_paths_relax: ${r} is a kill-switch invariant and cannot be relaxed; ignoring.\n`,
      );
    } else {
      validRelax.push(r);
    }
  }

  // 3. Subtract relax from base.
  const effective: string[] = [];
  for (const pat of base) {
    const patLc = pat.toLowerCase();
    if (!validRelax.some((r) => r.toLowerCase() === patLc)) {
      effective.push(pat);
    }
  }

  // 4. Compute override subset (subset of policy.protected_writes that
  // survived the relax filter). Kill-switch invariants added defensively
  // in step 1 are NOT included — only consumer-declared entries count
  // as explicit overrides.
  const override: string[] = [];
  if (writesIsSet && writes !== undefined) {
    for (const w of writes) {
      const wLc = w.toLowerCase();
      if (!validRelax.some((r) => r.toLowerCase() === wLc)) {
        override.push(w);
      }
    }
  }

  return { full: effective, override };
}

function isKillSwitchInvariant(p: string): boolean {
  const lc = p.toLowerCase();
  return KILL_SWITCH_INVARIANTS.some((inv) => inv.toLowerCase() === lc);
}

/**
 * Test whether a normalized lowercase project-relative path falls
 * inside the documented husky extension surface
 * (`.husky/{commit-msg,pre-push,pre-commit}.d/<fragment>`).
 *
 * The bare directory itself (`.husky/pre-push.d/`) and the dir node
 * (`.husky/pre-push.d`) do NOT match — only fragments inside.
 */
function isExtensionSurface(pathLc: string): boolean {
  const surfaces = ['.husky/commit-msg.d/', '.husky/pre-push.d/', '.husky/pre-commit.d/'];
  for (const s of surfaces) {
    if (pathLc.startsWith(s) && pathLc.length > s.length) {
      return true;
    }
  }
  return false;
}

/**
 * Test a path against a pattern list. Match rules:
 *   - exact (case-insensitive) when the pattern doesn't end with `/`
 *   - prefix-match when the pattern ends with `/`
 *   - "directory-shape" inputs (trailing `/` OR walker-flagged
 *     isDirTarget) match any protected path that would live inside,
 *     so `cp -t .rea` catches `.rea/HALT` even without a trailing
 *     slash. Codex round 1 F-7.
 *   - "destructive" inputs (walker-flagged isDestructive) match via
 *     PROTECTED-ANCESTRY: an input target T matches when any protected
 *     pattern P is a strict descendant of T, because removing T
 *     recursively removes P. So `rm -rf .rea` matches `.rea/HALT`
 *     even though `.rea` itself is neither a pattern nor input-dir-
 *     shaped. Codex round 4 Finding 1.
 *
 * Returns the matched pattern (preserving original case) or null.
 */
function matchPatterns(
  pathLc: string,
  patterns: readonly string[],
  options?: { forceDirSemantics?: boolean; isDestructive?: boolean },
): string | null {
  // Strip a single trailing slash on the input so `.rea/` and `.rea`
  // both compare against the same forms. We DO keep a flag tracking
  // whether the input was directory-shaped (trailing `/` or argv form
  // like `cp -t .rea/`) for the second-pass check below.
  const inputHadTrailingSlash = pathLc.endsWith('/');
  const inputIsDir = inputHadTrailingSlash || (options?.forceDirSemantics ?? false);
  const isDestructive = options?.isDestructive ?? false;
  const inputBase = inputHadTrailingSlash ? pathLc.slice(0, -1) : pathLc;
  for (const pat of patterns) {
    const patLc = pat.toLowerCase();
    if (patLc.endsWith('/')) {
      if (pathLc.startsWith(patLc)) return pat;
      if (pathLc === patLc.slice(0, -1)) return pat;
      // Reverse-prefix: input is `.rea/` (a dir-write target) and
      // pattern `.rea/HALT` would normally not match a bare-dir
      // input. But writing INTO `.rea/` is an attack on protected
      // files inside it — block. discord-ops Round 13 #2.
      if (inputIsDir && patLc.startsWith(inputBase + '/')) return pat;
      // Codex round 4 Finding 1: protected-ancestry. Destructive
      // operations (rm -rf, rmtree, FileUtils.rm_rf, find -delete)
      // against an ancestor of a protected dir-pattern remove
      // EVERYTHING under it. `rm -rf .` reaches `.husky/`.
      if (isDestructive && patLc.startsWith(inputBase + '/')) return pat;
    } else if (pathLc === patLc) {
      return pat;
    } else if (inputIsDir && patLc.startsWith(inputBase + '/')) {
      // Input is a directory; pattern is a file (e.g. `.rea/HALT`)
      // inside it. Conservative refusal: writes to this dir might
      // hit the protected file. discord-ops Round 13 #2 / `cp -t .rea/`
      // or `cp --target-directory=.rea` (codex round 1 F-7).
      return pat;
    } else if (isDestructive && patLc.startsWith(inputBase + '/')) {
      // Codex round 4 Finding 1: protected-ancestry. The input is
      // target `.rea` (not flagged dir-shape), the pattern is
      // `.rea/HALT`. A destructive op against `.rea` removes
      // `.rea/HALT`. Treat as a hit.
      return pat;
    }
  }
  return null;
}

/**
 * The full match-check, mirroring `rea_path_is_protected` in the bash
 * lib. Returns the matched pattern + which match-tier (`override`,
 * `default`) hit, or null if not protected.
 */
function checkPathProtected(
  pathLc: string,
  effective: EffectivePatterns,
  options?: { forceDirSemantics?: boolean; isDestructive?: boolean },
): { pattern: string; tier: 'override' | 'default' } | null {
  // Tier 1: explicit override wins.
  const overrideHit = matchPatterns(pathLc, effective.override, options);
  if (overrideHit !== null) return { pattern: overrideHit, tier: 'override' };

  // Tier 2: extension-surface allow-list short-circuits.
  // Codex round 4 Finding 1: but a DESTRUCTIVE op against the husky
  // extension-surface dir itself (e.g. `rm -rf .husky/pre-push.d`)
  // doesn't reach the per-fragment allow-list — we still want to
  // block ancestry hits against protected siblings (e.g. .husky/).
  // The extension-surface short-circuit only applies to the precise
  // fragment paths, not their parents. So we pass through to tier 3
  // when isDestructive AND the pathLc isn't itself a fragment but
  // could be an ancestor of one. The simplest semantic: skip the
  // short-circuit entirely on destructive operations. False positives
  // are acceptable — destructive ops on .husky/ are rare and policy-
  // relevant. Pre-fix: `rm -rf .husky` allowed because tier 2 didn't
  // apply (the path isn't a fragment) but tier 3 didn't trigger
  // ancestry without the destructive flag.
  if (!(options?.isDestructive ?? false) && isExtensionSurface(pathLc)) return null;

  // Tier 3: full effective protected set.
  const defaultHit = matchPatterns(pathLc, effective.full, options);
  if (defaultHit !== null) return { pattern: defaultHit, tier: 'default' };

  return null;
}

interface NormalizedTarget {
  /** The lowercase project-relative path, OR a sentinel string. */
  pathLc: string;
  /** True if the path is a recognized sentinel (outside root, expansion). */
  sentinel: 'outside_root' | 'expansion' | null;
  /** The original token, for error messages. */
  original: string;
  /** The fully-resolved (symlink-walked) project-relative path, when different. */
  resolvedLc: string | null;
}

/**
 * Normalize a write target from raw walker output to a project-relative
 * lowercase path suitable for `checkPathProtected`. Mirrors
 * `_normalize_target` + `rea_resolved_relative_form` in the bash hook.
 *
 * Returns one normalized form (logical) and optionally the symlink-
 * resolved form. The caller checks the policy against BOTH and
 * blocks on either match. Either may be a sentinel string for
 * outside-root / expansion-uncertainty.
 */
function normalizeTarget(reaRoot: string, raw: string, form?: DetectedForm): NormalizedTarget {
  // 1. Strip surrounding matching quotes (the parser already strips
  //    them for SglQuoted/DblQuoted, but a literal node can still hold
  //    `'.rea/HALT'` in pathological cases). Defensive.
  let t = raw;
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1);
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    t = t.slice(1, -1);
  }

  // 1b. Codex round 1 F-15: strip backslash-escapes that prefix
  //     ordinary path chars. Bash strips one level at runtime, so
  //     `\.rea/HALT` and `.rea/HALT` are the same target. Pre-fix
  //     `printf x > \.rea/HALT` allowed because `\.` was preserved
  //     in the literal token.
  t = stripBashBackslashEscapes(t);

  // 1c. Codex round 1 F-16: ANSI-C `$'…'` quoting expands escape
  //     sequences (`\n` `\t` `\xNN` etc.) at parse time. mvdan-sh
  //     emits the EXPANDED form, so we usually don't need to do this
  //     ourselves — but if we ever encounter the literal `$'` prefix
  //     in our raw input, it's a sign that ParamExp normalization
  //     dropped the special handling. Treat as dynamic to be safe.
  if (t.startsWith("$'") || t.includes("$'")) {
    return {
      pathLc: '__rea_unresolved_expansion__',
      sentinel: 'expansion',
      original: raw,
      resolvedLc: null,
    };
  }

  // 2. Sentinel: $-expansion / `cmd` / $(cmd) inside the path.
  if (t.includes('$') || t.includes('`')) {
    return {
      pathLc: '__rea_unresolved_expansion__',
      sentinel: 'expansion',
      original: raw,
      resolvedLc: null,
    };
  }

  // 2b. Codex round 1 F-14: glob metachars (`*`, `?`, `[`, `{`) in
  //     redirect targets are runtime-expanded; refuse on uncertainty.
  //     We scope this to redirect-form detections — argv-based forms
  //     (chmod, cp, rm, etc.) commonly take legitimately-globbed
  //     positional args (`chmod +x bin/*.sh`) that we don't want to
  //     refuse blanket-style. Their expansion at runtime DOES still
  //     create the same conservative blocking concern, but in practice
  //     bash redirect targets are the high-confidence attack vector;
  //     argv globs that plausibly hit a protected path are caught by
  //     individual per-utility detection (e.g. `chmod 000 .rea/H*` →
  //     when `.rea/HALT` exists the glob WOULD have expanded; we just
  //     can't enumerate it). Future enhancement: enumerate glob matches
  //     against the FS at scan-time.
  if (form === 'redirect' && containsGlobMetachar(t)) {
    return {
      pathLc: '__rea_unresolved_expansion__',
      sentinel: 'expansion',
      original: raw,
      resolvedLc: null,
    };
  }

  // 2c. Codex round 1 F-24: `~/` or bare `~` expands to $HOME at
  //     runtime, which may equal reaRoot (any project rooted at the
  //     user's home dir). Treat as dynamic to be safe — refuse on
  //     uncertainty rather than guess at HOME.
  if (t === '~' || t.startsWith('~/') || t.startsWith('~')) {
    return {
      pathLc: '__rea_unresolved_expansion__',
      sentinel: 'expansion',
      original: raw,
      resolvedLc: null,
    };
  }

  // 3. URL-decode + backslash translation + leading-./ strip.
  let normalized = t;
  try {
    normalized = decodeURIComponent(t);
  } catch {
    // Malformed URI escape — leave alone.
    normalized = t;
  }
  normalized = normalized.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  // 4. Resolve `..` segments. Build absolute path then walk-and-collapse.
  let abs = normalized;
  if (!abs.startsWith('/')) {
    abs = path.join(reaRoot, abs);
  }
  const hadDotDot = normalized.includes('..');
  const collapsed = collapseDotDot(abs);

  // 5. Outside-root sentinel — fires ONLY for paths that contained
  //    `..` segments and resolved outside REA_ROOT (helix-022 #1
  //    semantic). A bare absolute path like `/tmp/foo` is just an
  //    out-of-scope target — we don't enforce the protected list
  //    against it (the protected list is project-relative). The bash
  //    gate pre-0.23.0 had the same behavior.
  if (!isInsideRoot(collapsed, reaRoot)) {
    if (hadDotDot) {
      return {
        pathLc: '__rea_outside_root__',
        sentinel: 'outside_root',
        original: raw,
        resolvedLc: null,
      };
    }
    // Plain absolute path outside root — return a path that won't
    // match anything in the protected list. We use a unique sentinel
    // so the caller can distinguish "outside root, not protected" from
    // "outside root, refused" — but `pathLc` here is just a non-
    // matching string.
    return {
      pathLc: `__outside_root_allowed:${collapsed.toLowerCase()}`,
      sentinel: null,
      original: raw,
      resolvedLc: null,
    };
  }
  const projectRelative = collapsed === reaRoot ? '' : collapsed.slice(reaRoot.length + 1);
  // Preserve trailing-slash signal from the input — `cp -t .rea/` and
  // `cp --target-directory=.rea/` need the dir-write semantic to stick
  // through normalization. `collapseDotDot` strips trailing slashes
  // because it splits-and-rejoins on `/`, so we re-attach when the
  // original had one.
  const inputHadTrailingSlash = normalized.endsWith('/');
  const pathLc = (
    inputHadTrailingSlash && projectRelative.length > 0 && !projectRelative.endsWith('/')
      ? projectRelative + '/'
      : projectRelative
  ).toLowerCase();

  // 6. Symlink-resolved form. Walk to the nearest existing ancestor,
  //    realpath-it, then re-attach the unresolved tail. Mirrors
  //    `resolve_parent_realpath` in `hooks/_lib/path-normalize.sh`
  //    (helix-022 #1).
  //
  //    Codex round 2 R2-2: cycle / depth-cap detection. When the
  //    resolver returns SYMLINK_DYNAMIC_SENTINEL, treat the target as
  //    dynamic — refuse on uncertainty via the `expansion` sentinel.
  let resolvedLc: string | null = null;
  try {
    const resolved = resolveSymlinksWalkUp(collapsed);
    if (resolved === SYMLINK_DYNAMIC_SENTINEL) {
      return {
        pathLc: '__rea_unresolved_expansion__',
        sentinel: 'expansion',
        original: raw,
        resolvedLc: null,
      };
    }
    if (resolved !== null) {
      // macOS /var ↔ /private/var canonicalization (helix-021): the
      // realpath of REA_ROOT itself may differ from REA_ROOT. Compute
      // the relative form using the realpath of REA_ROOT.
      const realRoot = realpathSafe(reaRoot) ?? reaRoot;
      let resolvedRelative: string | null = null;
      if (resolved === realRoot) {
        resolvedRelative = '';
      } else if (resolved.startsWith(realRoot + '/')) {
        resolvedRelative = resolved.slice(realRoot.length + 1);
      } else if (resolved.startsWith(reaRoot + '/')) {
        resolvedRelative = resolved.slice(reaRoot.length + 1);
      }
      if (resolvedRelative !== null) {
        const candidate = resolvedRelative.toLowerCase();
        if (candidate !== pathLc) {
          resolvedLc = candidate;
        }
      }
    }
  } catch {
    // Symlink resolution is best-effort. If it fails the logical form
    // is still checked.
  }

  return { pathLc, sentinel: null, original: raw, resolvedLc };
}

/**
 * Resolve `..` and `.` segments without filesystem access. Standard
 * lexical normalization.
 */
function collapseDotDot(absPath: string): string {
  const parts = absPath.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      out.pop();
    } else {
      out.push(p);
    }
  }
  return '/' + out.join('/');
}

function isInsideRoot(absPath: string, reaRoot: string): boolean {
  if (absPath === reaRoot) return true;
  // Use realpath-aware equivalence: macOS /var ↔ /private/var.
  const realRoot = realpathSafe(reaRoot);
  if (realRoot && absPath === realRoot) return true;
  if (absPath.startsWith(reaRoot + '/')) return true;
  if (realRoot && absPath.startsWith(realRoot + '/')) return true;
  return false;
}

function realpathSafe(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Walk to the nearest existing ancestor, realpath-it, then re-attach
 * the unresolved tail.
 *
 * Return values:
 *   - string: the resolved absolute path
 *   - null: nothing resolves (should never happen — FS root always exists)
 *   - SYMLINK_DYNAMIC_SENTINEL: cycle or depth cap hit; caller MUST treat
 *     this as a dynamic / unresolvable target and refuse on uncertainty
 *
 * helix-022 #1: pre-fix the bash hook walked up via stat-loop and
 * stopped at the nearest existing parent, reattaching the unresolved
 * tail. We do the same here using `node:fs.realpathSync` on the
 * existing prefix.
 *
 * Codex round 1 F-2: dangling symlinks. `fs.existsSync` follows the
 * symlink — if the target is missing, it returns FALSE, so the leaf
 * (which IS a real link in the directory) gets walked PAST and
 * re-attached unresolved. Pre-fix `ln -s .rea/HALT innocent_link;
 * printf x > innocent_link` was allowed because innocent_link's
 * realpath wasn't computed (the link target didn't exist YET). The
 * write would create .rea/HALT.
 *
 * Fix: at each level, also check `lstatSync` — if the entry exists
 * as a symlink (whether or not the target resolves), follow it via
 * `readlinkSync` and re-resolve. This catches dangling and broken
 * links by their LINK content, not their target's existence.
 *
 * Codex round 2 R2-2: prior recursion had no cycle guard or depth cap.
 * A symlink loop `a → b → a` against a protected target caused unbounded
 * recursion (Node would eventually stack-overflow but the path-of-least-
 * resistance failure was a long hang). Even non-cyclic deep chains could
 * stress the resolver. We now thread a `visited` Set + `depth` counter
 * through every recursive call. On cycle detection or depth-cap hit we
 * return a sentinel that the caller maps to `dynamic: true` so the
 * compositor BLOCKS on uncertainty.
 */
const SYMLINK_DYNAMIC_SENTINEL: unique symbol = Symbol('symlink-dynamic');
type SymlinkDynamic = typeof SYMLINK_DYNAMIC_SENTINEL;
const SYMLINK_DEPTH_CAP = 32;

function resolveSymlinksWalkUp(absPath: string): string | null | SymlinkDynamic {
  return resolveSymlinksWalkUpInner(absPath, new Set<string>(), 0);
}

function resolveSymlinksWalkUpInner(
  absPath: string,
  visited: Set<string>,
  depth: number,
): string | null | SymlinkDynamic {
  if (depth >= SYMLINK_DEPTH_CAP) {
    return SYMLINK_DYNAMIC_SENTINEL;
  }
  if (visited.has(absPath)) {
    return SYMLINK_DYNAMIC_SENTINEL;
  }
  visited.add(absPath);
  const parts = absPath.split('/').filter((p) => p.length > 0);
  // Find the longest existing-or-symlink prefix.
  for (let i = parts.length; i >= 0; i -= 1) {
    const prefix = '/' + parts.slice(0, i).join('/');
    // Check via lstat first so dangling symlinks register.
    const lstat = lstatSafe(prefix);
    if (lstat !== null) {
      // Entry exists in the directory (file, dir, OR dangling link).
      let resolved: string;
      if (lstat.isSymbolicLink()) {
        // Codex F-2: follow the link manually so dangling targets are
        // re-evaluated through the protected-list match.
        const linkTarget = readlinkSafe(prefix);
        if (linkTarget === null) return null;
        // If the link target is relative, resolve it against the link's
        // dirname.
        const linkDir = '/' + parts.slice(0, i - 1).join('/');
        const targetAbs = linkTarget.startsWith('/')
          ? linkTarget
          : path.resolve(linkDir, linkTarget);
        // Codex round 2 R2-2: thread visited + depth into the recursion
        // so cycles bottom out at the depth cap with the dynamic sentinel.
        const recursive = resolveSymlinksWalkUpInner(targetAbs, visited, depth + 1);
        if (recursive === SYMLINK_DYNAMIC_SENTINEL) return SYMLINK_DYNAMIC_SENTINEL;
        if (recursive === null) return null;
        const tail = parts.slice(i).join('/');
        resolved =
          tail.length === 0 ? recursive : recursive === '/' ? '/' + tail : recursive + '/' + tail;
        return resolved;
      }
      const real = realpathSafe(prefix);
      if (real === null) return null;
      const tail = parts.slice(i).join('/');
      if (tail.length === 0) return real;
      return real === '/' ? '/' + tail : real + '/' + tail;
    }
  }
  return null;
}

function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function readlinkSafe(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

/**
 * Strip a single layer of bash backslash-escaping from a literal path
 * token. Bash collapses `\X` to `X` for any non-special X at runtime,
 * but mvdan-sh sometimes preserves the backslash in the parsed Lit
 * token. Codex round 1 F-15.
 *
 * We don't try to be clever — bash's actual rules are messy and
 * context-dependent. We strip every `\X` to `X` for X in
 * `[A-Za-z0-9./_~-]`. The compositor then runs its existing checks
 * against the resulting form.
 */
function stripBashBackslashEscapes(s: string): string {
  return s.replace(/\\([A-Za-z0-9./_~\-])/g, '$1');
}

/**
 * True if the string contains a glob metacharacter. Conservative —
 * we treat `?` `*` `[` `{` as globby; the bash brace expansion produces
 * multiple args from one source token. Codex round 1 F-14.
 *
 * We DO NOT distinguish between literal `*` (escaped with backslash —
 * already handled by stripBashBackslashEscapes above) and glob `*`,
 * because by the time we're here both have collapsed to the same
 * literal char. The fail-closed posture is acceptable: globs in
 * redirect targets are rare in legitimate code.
 */
function containsGlobMetachar(s: string): boolean {
  return /[*?[{]/.test(s);
}

/**
 * Build the operator-facing block reason for a successful match.
 */
function buildBlockReason(args: {
  pattern: string;
  hitForm: string;
  detectedForm: DetectedForm;
  originalToken: string;
}): string {
  return [
    'PROTECTED PATH (bash): write to a package-managed file blocked',
    '',
    `  Pattern matched: ${args.pattern}`,
    `  Resolved target: ${args.hitForm}`,
    `  Original token:  ${args.originalToken}`,
    `  Detected as:     ${args.detectedForm}`,
    '',
    '  Rule: protected paths (kill-switch, policy.yaml, settings.json,',
    '        .husky/*) are unreachable via Bash redirects too — not just',
    '        Write/Edit/MultiEdit. To modify, a human must edit directly.',
  ].join('\n');
}

/**
 * Run a list of detected writes against the protected-paths policy.
 * Returns the FIRST blocking verdict, or allow if every detection is
 * clean.
 *
 * Order: walk detections in order of appearance. The walker emits
 * them in source order, so the operator sees the EARLIEST violation
 * in the error message.
 */
export function scanForProtectedViolations(
  ctx: ProtectedScanContext,
  detections: readonly DetectedWrite[],
): Verdict {
  if (detections.length === 0) return allowVerdict();
  const effective = computeEffectivePatterns(ctx);
  for (const d of detections) {
    // Dynamic targets fail closed.
    if (d.dynamic) {
      // xargs-stdin and depth-cap detections always have empty path
      // and dynamic=true; we surface a path-specific reason for them.
      if (d.form === 'xargs_unresolvable') {
        return blockVerdict({
          reason: [
            'PROTECTED PATH (bash): xargs destination is fed via stdin and cannot be statically resolved.',
            '',
            '  rea refuses on uncertainty. Rewrite without xargs (use a loop with explicit',
            '  destinations) or pipe to a known-safe destination directory.',
          ].join('\n'),
          hitPattern: '(xargs unresolvable stdin)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      if (d.form === 'nested_shell_inner') {
        return blockVerdict({
          reason: [
            'PROTECTED PATH (bash): nested-shell payload is dynamic or exceeds the recursion depth cap (8).',
            '',
            '  rea refuses on uncertainty. Inline the command instead of wrapping in `bash -c`',
            '  with a $-expanded or deeply-nested payload.',
          ].join('\n'),
          hitPattern: '(nested-shell unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      // Codex round 11 F11-1: find -exec/-execdir/-ok/-okdir with `{}`
      // placeholder. The placeholder is a runtime-resolved file path
      // from find's own match set; we cannot statically determine
      // which protected paths it will produce.
      if (d.form === 'find_exec_placeholder_unresolvable') {
        return blockVerdict({
          reason: [
            'PROTECTED PATH (bash): find -exec with `{}` placeholder targets runtime-resolved paths.',
            '',
            '  rea refuses on uncertainty. Rewrite without `{}` (use an explicit destination)',
            '  or limit the find seed/-name predicates so the matched paths are statically',
            '  knowable (note: even `-name SAFE` cannot be honored because find resolves',
            '  matches at runtime against the live filesystem).',
          ].join('\n'),
          hitPattern: '(find -exec placeholder unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      // Codex round 11 F11-5: parallel reading from stdin (no ::: separator).
      if (d.form === 'parallel_stdin_unresolvable') {
        return blockVerdict({
          reason: [
            'PROTECTED PATH (bash): parallel without `:::` reads inputs from stdin and cannot be statically resolved.',
            '',
            '  rea refuses on uncertainty. Use `parallel CMD ::: arg1 arg2` with explicit',
            '  inputs, or pipe to a non-parallel form (`for x; do CMD; done`).',
          ].join('\n'),
          hitPattern: '(parallel stdin unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      // helix-024 F1: cd-into-dynamic-directory + writes-elsewhere.
      // Walker emits when the cd/pushd target is $VAR / $(cmd) and
      // the AST contains writes. We can't statically determine
      // whether the dynamic target is protected; refuse on uncertainty.
      if (d.form === 'cwd_dynamic_with_writes_unresolvable') {
        return blockVerdict({
          reason: [
            'PROTECTED PATH (bash): cd/pushd target is dynamic and the command contains writes.',
            '',
            '  rea refuses on uncertainty. The cwd may resolve to a protected directory',
            '  (.rea/, .husky/, .claude/, .github/workflows/) at runtime, in which case any',
            '  subsequent relative-path write would target a protected file.',
            '',
            '  Resolve the variable to a literal path before the cd, OR move the writes out',
            '  of the cd-affected scope so the scanner can verify each target individually.',
          ].join('\n'),
          hitPattern: '(cd dynamic + writes unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      // helix-024 F3: ln SRC DEST whose SRC is dynamic. The link target
      // is computed at runtime; we can't tell whether the eventual
      // alias points at a protected path. Refuse on uncertainty when
      // SRC is dynamic. (Literal-SRC-protected ln is handled below in
      // the logical-form match path because the walker emits with
      // dynamic=false for literal SRCs.)
      if (d.form === 'ln_to_protected_unresolvable') {
        return blockVerdict({
          reason: [
            'PROTECTED PATH (bash): ln source is dynamic — link may alias a protected path.',
            '',
            '  rea refuses on uncertainty. A subsequent write through the link would target',
            '  the resolved source path, which the static scanner cannot verify.',
            '',
            '  Resolve the variable to a literal path before the ln, OR avoid creating a',
            '  link whose source is dynamically computed.',
          ].join('\n'),
          hitPattern: '(ln source dynamic unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      // Codex round 11 F11-4: archive extraction whose member set is
      // unknown at static-analysis time (`tar -xzf foo.tar.gz` with no
      // explicit member list — the archive may contain `.rea/HALT`).
      if (d.form === 'archive_extract_unresolvable') {
        return blockVerdict({
          reason: [
            'PROTECTED PATH (bash): archive extraction targets are unresolvable — the archive may contain protected paths.',
            '',
            '  rea refuses on uncertainty. Either:',
            '    1. List the explicit members on the command line so the scanner can verify',
            '       none collide with protected patterns, OR',
            '    2. Extract into a sandbox directory under `tmp/` or `dist/`, never the',
            '       project root, so the protected-paths cannot be overwritten.',
          ].join('\n'),
          hitPattern: '(archive extract unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      return blockVerdict({
        reason: [
          'PROTECTED PATH (bash): unresolved shell expansion in target.',
          '',
          `  Token:           ${d.path}`,
          `  Detected as:     ${d.form}`,
          '',
          '  Rule: $-substitution and `command-substitution` in redirect targets are',
          '        refused at static-analysis time. Resolve the variable to a literal',
          '        path before the redirect.',
        ].join('\n'),
        hitPattern: '(dynamic target)',
        detectedForm: d.form,
        ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
      });
    }
    if (d.path.length === 0) continue;

    const norm = normalizeTarget(ctx.reaRoot, d.path, d.form);
    if (norm.sentinel === 'expansion') {
      return blockVerdict({
        reason: [
          'PROTECTED PATH (bash): unresolved shell expansion in target.',
          '',
          `  Token:           ${norm.original}`,
          `  Detected as:     ${d.form}`,
        ].join('\n'),
        hitPattern: '(dynamic target)',
        detectedForm: d.form,
        ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
      });
    }
    if (norm.sentinel === 'outside_root') {
      return blockVerdict({
        reason: [
          'PROTECTED PATH (bash): path traversal escapes project root.',
          '',
          `  Logical:  ${norm.original}`,
          `  Detected as:     ${d.form}`,
          '',
          '  Rule: bash redirects whose target resolves outside REA_ROOT are refused.',
          '        Use a project-relative path without `..` segments.',
        ].join('\n'),
        hitPattern: '(outside-root)',
        detectedForm: d.form,
        ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
      });
    }

    // Logical-form match.
    // Codex round 1 F-7: walker-flagged dir targets (-t / --target-
    // directory / cp_t_flag / mv_t_flag / install_t_flag / ln_t_flag)
    // get directory-shape match semantics so a write INTO `.rea`
    // catches `.rea/HALT` even without a trailing slash.
    // Codex round 4 Finding 1: destructive flag plumbed through so
    // protected-ancestry matching can treat `rm -rf .rea` as a hit on
    // `.rea/HALT`.
    const matchOptions: { forceDirSemantics?: boolean; isDestructive?: boolean } = {};
    if (d.isDirTarget === true) matchOptions.forceDirSemantics = true;
    if (d.isDestructive === true) matchOptions.isDestructive = true;
    const dirOptions = Object.keys(matchOptions).length > 0 ? matchOptions : undefined;
    const logicalHit = checkPathProtected(norm.pathLc, effective, dirOptions);
    if (logicalHit !== null) {
      return blockVerdict({
        reason: buildBlockReason({
          pattern: logicalHit.pattern,
          hitForm: norm.pathLc,
          detectedForm: d.form,
          originalToken: norm.original,
        }),
        hitPattern: logicalHit.pattern,
        detectedForm: d.form,
        ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
      });
    }
    // Symlink-resolved-form match.
    if (norm.resolvedLc !== null) {
      const resolvedHit = checkPathProtected(norm.resolvedLc, effective, dirOptions);
      if (resolvedHit !== null) {
        return blockVerdict({
          reason: buildBlockReason({
            pattern: resolvedHit.pattern,
            hitForm: norm.resolvedLc,
            detectedForm: d.form,
            originalToken: norm.original,
          }),
          hitPattern: resolvedHit.pattern,
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
    }
  }
  return allowVerdict();
}
