/**
 * Shared path-normalization primitives for the Node-binary hook tier.
 *
 * 0.35.0 — TypeScript port of `hooks/_lib/path-normalize.sh`. The bash
 * helper is the single source of truth shared between settings-
 * protection.sh and blocked-paths-enforcer.sh (and the Bash-tier
 * gates' relevance pre-checks). The 4 hooks landing in 0.35.0 all
 * need the same normalization to stay byte-parity with their bash
 * counterparts.
 *
 * Functions:
 *   - `normalizePath(p, reaRoot)` — project-relative form. Strip
 *     reaRoot prefix → URL-decode `%2F`/`%2E`/`%20`/`%5C` → translate
 *     `\` → `/` → strip leading `./` segments.
 *   - `hasTraversalSegment(p)` — true if any `..` segment exists.
 *   - `hasInteriorDotSegment(p)` — true if any interior `/./` segment
 *     exists (0.29.0 helix-/./-class refusal).
 *   - `resolveParentRealpath(targetPath)` — pure-Node equivalent of
 *     the bash `resolve_parent_realpath`. Returns the realpath of the
 *     parent dir, walking up to the nearest existing ancestor if the
 *     parent doesn't exist yet, then appending the unresolved tail.
 *   - `resolveCanonRoot(reaRoot)` — `cd -P && pwd -P` equivalent of
 *     the project root, with macOS `/var` → `/private/var` collapse.
 *
 * All functions are pure (no logging, no exit) — the caller decides
 * how to surface failures.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Project-relative form of a file path. Mirrors the bash helper
 * byte-for-byte.
 *
 * Order of operations (lifted from `hooks/_lib/path-normalize.sh`):
 *   1. Strip leading `<reaRoot>/` prefix.
 *   2. URL-decode `%2F`, `%2E`, `%20`, `%5C` (case-insensitive). Other
 *      percent-encodings are left untouched — the bash helper only
 *      decodes this fixed set.
 *   3. Translate backslash separators to forward slashes.
 *   4. Strip leading `./` segments. Interior `./` is NOT stripped (that
 *      would corrupt `..` traversals — see §5a-bis).
 */
export function normalizePath(input: string, reaRoot: string): string {
  let p = input;
  // 1. Strip $REA_ROOT/ prefix.
  const prefix = reaRoot.endsWith(path.sep) ? reaRoot : reaRoot + '/';
  if (p === reaRoot || p.startsWith(prefix)) {
    if (p === reaRoot) {
      p = '';
    } else {
      p = p.slice(prefix.length);
    }
  }
  // 2. URL-decode the fixed set: %2F→/, %2E→., %20→' ', %5C→\.
  p = p
    .replace(/%2[Ff]/g, '/')
    .replace(/%2[Ee]/g, '.')
    .replace(/%20/g, ' ')
    .replace(/%5[Cc]/g, '\\');
  // 3. Translate backslash separators to forward slashes.
  p = p.replace(/\\/g, '/');
  // 4. Strip leading `./` segments only.
  while (p.startsWith('./')) {
    p = p.slice(2);
  }
  return p;
}

/**
 * True if any `/../` segment is present (bracketing the input with `/`
 * on each side so leading/trailing `..` segments still count). Mirrors
 * the bash `case "/$path/" in *<slash>..<slash>*) traversal=1` shape
 * (the literal asterisk-slash form is omitted to keep the JSDoc block
 * from terminating early).
 */
export function hasTraversalSegment(p: string): boolean {
  const bracketed = `/${p}/`;
  return bracketed.includes('/../');
}

/**
 * True if any interior `/./` segment is present. The bash helper uses
 * the equivalent `*<slash>.<slash>*` case-glob shape; leading `./` is
 * stripped by normalizePath, so anything that survives is interior.
 */
export function hasInteriorDotSegment(p: string): boolean {
  const bracketed = `/${p}/`;
  return bracketed.includes('/./');
}

/**
 * Canonicalize a project root the same way bash `cd -P && pwd -P`
 * would — follow every symlink in the path to the physical form. On
 * macOS this collapses `/var/...` → `/private/var/...` because `/var`
 * is itself a symlink. Used to make REA_ROOT prefix comparisons
 * symmetric against realpath'd children.
 *
 * Returns the original `reaRoot` (unmodified) when realpath fails —
 * the bash helper falls back the same way via `|| resolved=""`.
 */
export function resolveCanonRoot(reaRoot: string): string {
  try {
    return fs.realpathSync(reaRoot);
  } catch {
    return reaRoot;
  }
}

/**
 * Resolve the realpath of the parent directory of `targetPath`. Pure-
 * Node mirror of `hooks/_lib/path-normalize.sh::resolve_parent_realpath`,
 * including the 0.21.2 helix-022 #1 nearest-existing-ancestor walk.
 *
 * Returns:
 *   - The resolved realpath of the parent when it exists.
 *   - When the parent doesn't exist on disk: walk UP looking for the
 *     nearest existing ancestor, realpath that, then append the
 *     unresolved tail. This catches symlink walks where the terminal
 *     directory is created mid-segment (`mkdir -p linkroot/.husky/sub`).
 *   - Empty string when no existing ancestor inside REA_ROOT could be
 *     resolved.
 */
export function resolveParentRealpath(targetPath: string): string {
  const parentDir = path.dirname(targetPath);
  // Fast path: parent exists. Resolve directly.
  let parentStat: fs.Stats | undefined;
  try {
    parentStat = fs.statSync(parentDir);
  } catch {
    /* falls through to walk-up below */
  }
  if (parentStat?.isDirectory()) {
    try {
      return fs.realpathSync(parentDir);
    } catch {
      return '';
    }
  }
  // Walk up to the nearest existing ancestor; accumulate the tail.
  let walk = parentDir;
  let tail = '';
  // Bound the walk to avoid pathological loops on relative paths.
  for (let i = 0; i < 64; i++) {
    if (!walk || walk === '/' || walk === '.') break;
    try {
      const s = fs.statSync(walk);
      if (s.isDirectory()) break;
    } catch {
      /* keep walking */
    }
    const base = path.basename(walk);
    tail = tail.length > 0 ? `${base}/${tail}` : base;
    walk = path.dirname(walk);
  }
  if (!walk || walk === '/' || walk === '.') {
    return '';
  }
  let resolvedWalk: string;
  try {
    resolvedWalk = fs.realpathSync(walk);
  } catch {
    return '';
  }
  if (tail.length === 0) return resolvedWalk;
  return `${resolvedWalk}/${tail}`;
}
