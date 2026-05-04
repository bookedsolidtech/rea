/**
 * Blocked-paths policy composition. Mirrors `blocked-paths-bash-gate.sh`
 * + the `_match_blocked` helper byte-for-byte:
 *
 *   - directory entry (ends with `/`): prefix match OR exact match
 *     against the bare-dir form (entry without trailing slash)
 *   - glob entry (contains `*`): convert to ERE (escape `.`, `*` → `.*`),
 *     anchored, case-insensitive
 *   - exact (case-insensitive) otherwise
 *
 * Path normalization is identical to protected-scan.ts: URL-decode,
 * backslash → slash, leading-./ strip, `..` walk-up + outside-root
 * sentinel, optional symlink-resolved form.
 *
 * Out-of-scope-of-blocked: paths outside REA_ROOT. blocked_paths is a
 * project-relative concept; an outside-root write can't match a
 * blocked_paths entry. The PROTECTED-paths gate handles outside-root
 * rejection on the protected list itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { allowVerdict, blockVerdict, type DetectedForm, type Verdict } from './verdict.js';
import type { DetectedWrite } from './walker.js';

export interface BlockedScanContext {
  reaRoot: string;
  blockedPaths: readonly string[];
}

interface BlockedNormalized {
  pathLc: string;
  outsideRoot: boolean;
  expansion: boolean;
  original: string;
  resolvedLc: string | null;
}

function normalizeTarget(reaRoot: string, raw: string, form?: DetectedForm): BlockedNormalized {
  let t = raw;
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) t = t.slice(1, -1);

  // Codex round 1 F-15: strip backslash-escapes prefixing path chars.
  t = stripBashBackslashEscapes(t);

  // Codex round 1 F-16: ANSI-C $'…' quoting → dynamic.
  if (t.startsWith("$'") || t.includes("$'")) {
    return {
      pathLc: '__rea_unresolved_expansion__',
      outsideRoot: false,
      expansion: true,
      original: raw,
      resolvedLc: null,
    };
  }

  if (t.includes('$') || t.includes('`')) {
    return {
      pathLc: '__rea_unresolved_expansion__',
      outsideRoot: false,
      expansion: true,
      original: raw,
      resolvedLc: null,
    };
  }

  // Codex round 1 F-14: glob metachars in REDIRECT targets → dynamic.
  // See protected-scan.ts::normalizeTarget for the rationale on
  // scoping this to redirect-form only.
  if (form === 'redirect' && containsGlobMetachar(t)) {
    return {
      pathLc: '__rea_unresolved_expansion__',
      outsideRoot: false,
      expansion: true,
      original: raw,
      resolvedLc: null,
    };
  }

  // Codex round 1 F-24: tilde expansion → dynamic.
  if (t === '~' || t.startsWith('~/') || t.startsWith('~')) {
    return {
      pathLc: '__rea_unresolved_expansion__',
      outsideRoot: false,
      expansion: true,
      original: raw,
      resolvedLc: null,
    };
  }

  let normalized = t;
  try {
    normalized = decodeURIComponent(t);
  } catch {
    normalized = t;
  }
  normalized = normalized.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  let abs = normalized;
  if (!abs.startsWith('/')) {
    abs = path.join(reaRoot, abs);
  }
  const collapsed = collapseDotDot(abs);
  if (!isInsideRoot(collapsed, reaRoot)) {
    // blocked_paths is project-relative; an outside-root write can't
    // match. Return a non-matching sentinel form that the matcher
    // ignores — same posture as the bash hook's "outside root → exit 0".
    return {
      pathLc: `__outside_root_allowed:${collapsed.toLowerCase()}`,
      outsideRoot: true,
      expansion: false,
      original: raw,
      resolvedLc: null,
    };
  }
  const projectRelative = collapsed === reaRoot ? '' : collapsed.slice(reaRoot.length + 1);
  const inputHadTrailingSlash = normalized.endsWith('/');
  const pathLc = (
    inputHadTrailingSlash && projectRelative.length > 0 && !projectRelative.endsWith('/')
      ? projectRelative + '/'
      : projectRelative
  ).toLowerCase();

  let resolvedLc: string | null = null;
  try {
    const resolved = resolveSymlinksWalkUp(collapsed);
    if (resolved === SYMLINK_DYNAMIC_SENTINEL) {
      // Codex round 2 R2-2: cycle / depth-cap → refuse on uncertainty.
      return {
        pathLc: '__rea_unresolved_expansion__',
        outsideRoot: false,
        expansion: true,
        original: raw,
        resolvedLc: null,
      };
    }
    if (resolved !== null) {
      const realRoot = realpathSafe(reaRoot) ?? reaRoot;
      let resolvedRelative: string | null = null;
      if (resolved === realRoot) resolvedRelative = '';
      else if (resolved.startsWith(realRoot + '/'))
        resolvedRelative = resolved.slice(realRoot.length + 1);
      else if (resolved.startsWith(reaRoot + '/'))
        resolvedRelative = resolved.slice(reaRoot.length + 1);
      if (resolvedRelative !== null) {
        const candidate = resolvedRelative.toLowerCase();
        if (candidate !== pathLc) resolvedLc = candidate;
      }
    }
  } catch {
    /* best-effort */
  }

  return { pathLc, outsideRoot: false, expansion: false, original: raw, resolvedLc };
}

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
 * Walk to the nearest existing-or-symlink ancestor and resolve. Codex
 * round 1 F-2 — see protected-scan.ts::resolveSymlinksWalkUp for the
 * full rationale.
 *
 * Codex round 2 R2-2: same cycle-guard + depth-cap as protected-scan.
 * Returns SYMLINK_DYNAMIC_SENTINEL to signal "refuse on uncertainty".
 */
const SYMLINK_DYNAMIC_SENTINEL: unique symbol = Symbol('symlink-dynamic-blocked');
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
  if (depth >= SYMLINK_DEPTH_CAP) return SYMLINK_DYNAMIC_SENTINEL;
  if (visited.has(absPath)) return SYMLINK_DYNAMIC_SENTINEL;
  visited.add(absPath);
  const parts = absPath.split('/').filter((p) => p.length > 0);
  for (let i = parts.length; i >= 0; i -= 1) {
    const prefix = '/' + parts.slice(0, i).join('/');
    const lstat = lstatSafe(prefix);
    if (lstat !== null) {
      if (lstat.isSymbolicLink()) {
        const linkTarget = readlinkSafe(prefix);
        if (linkTarget === null) return null;
        const linkDir = '/' + parts.slice(0, i - 1).join('/');
        const targetAbs = linkTarget.startsWith('/')
          ? linkTarget
          : path.resolve(linkDir, linkTarget);
        const recursive = resolveSymlinksWalkUpInner(targetAbs, visited, depth + 1);
        if (recursive === SYMLINK_DYNAMIC_SENTINEL) return SYMLINK_DYNAMIC_SENTINEL;
        if (recursive === null) return null;
        const tail = parts.slice(i).join('/');
        return tail.length === 0
          ? recursive
          : recursive === '/'
            ? '/' + tail
            : recursive + '/' + tail;
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

function stripBashBackslashEscapes(s: string): string {
  return s.replace(/\\([A-Za-z0-9./_~\-])/g, '$1');
}

function containsGlobMetachar(s: string): boolean {
  return /[*?[{]/.test(s);
}

/**
 * Match a normalized lowercase path against the blocked_paths list.
 * Returns the matching entry (preserving original case for the error
 * message) or null.
 */
function matchBlockedEntry(
  pathLc: string,
  blockedPaths: readonly string[],
  options?: { forceDirSemantics?: boolean },
): string | null {
  const inputHadTrailingSlash = pathLc.endsWith('/');
  const inputIsDir = inputHadTrailingSlash || (options?.forceDirSemantics ?? false);
  const inputBase = inputHadTrailingSlash ? pathLc.slice(0, -1) : pathLc;
  for (const entry of blockedPaths) {
    const entryLc = entry.toLowerCase();
    // Directory match.
    if (entryLc.endsWith('/')) {
      if (pathLc.startsWith(entryLc)) return entry;
      if (pathLc === entryLc.slice(0, -1)) return entry;
      // Codex round 1 F-7: dir-target input matches a dir-pattern
      // even when `pathLc` is `.rea` (no trailing slash) but the
      // walker flagged it as dir-target.
      if (inputIsDir && entryLc.startsWith(inputBase + '/')) return entry;
      continue;
    }
    // Glob match.
    if (entry.includes('*')) {
      const re = globToRegex(entryLc);
      if (re.test(pathLc)) return entry;
      continue;
    }
    // Exact match.
    if (pathLc === entryLc) return entry;
    // Dir-target input vs file entry inside that dir.
    if (inputIsDir && entryLc.startsWith(inputBase + '/')) return entry;
  }
  return null;
}

/**
 * Convert a glob entry to a case-insensitive anchored regex. Mirrors
 * the bash `sed` transform applied in the pre-0.23.0 hook: escape `.`,
 * convert `*` to `.*`, anchor both ends. We additionally escape every
 * other regex metacharacter so values like `[`, `(`, `+` in a
 * blocked_paths entry don't blow up at runtime.
 */
function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i);
    if (c === '*') {
      re += '.*';
    } else if (c === '?') {
      re += '.';
    } else {
      // Escape any regex-meta characters.
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

function buildBlockReason(args: {
  entry: string;
  hitForm: string;
  detectedForm: DetectedForm;
  originalToken: string;
}): string {
  return [
    'BLOCKED PATH (bash): write denied by policy',
    '',
    `  Blocked by:      ${args.entry}`,
    `  Resolved target: ${args.hitForm}`,
    `  Original token:  ${args.originalToken}`,
    `  Detected as:     ${args.detectedForm}`,
    '',
    '  Source: .rea/policy.yaml → blocked_paths',
    '  Rule: blocked_paths entries are unreachable via Bash redirects',
    '        too — not just Write/Edit/MultiEdit. To modify, a human',
    '        must edit directly or update blocked_paths in policy.yaml.',
  ].join('\n');
}

export function scanForBlockedViolations(
  ctx: BlockedScanContext,
  detections: readonly DetectedWrite[],
): Verdict {
  if (ctx.blockedPaths.length === 0) return allowVerdict();
  if (detections.length === 0) return allowVerdict();
  for (const d of detections) {
    if (d.dynamic) {
      if (d.form === 'xargs_unresolvable') {
        return blockVerdict({
          reason: [
            'BLOCKED PATH (bash): xargs destination is fed via stdin and cannot be statically resolved.',
            '',
            '  rea refuses on uncertainty against the blocked_paths policy. Rewrite without',
            '  xargs (use a loop with explicit destinations).',
          ].join('\n'),
          hitPattern: '(xargs unresolvable stdin)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      if (d.form === 'nested_shell_inner') {
        return blockVerdict({
          reason: [
            'BLOCKED PATH (bash): nested-shell payload is dynamic or exceeds the recursion depth cap (8).',
            '',
            '  rea refuses on uncertainty.',
          ].join('\n'),
          hitPattern: '(nested-shell unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      // Codex round 11 F11-1 / F11-5 / F11-4: refuse-on-uncertainty
      // forms surfaced as dynamic detections. Same pattern as
      // protected-scan: each form gets its own message.
      if (d.form === 'find_exec_placeholder_unresolvable') {
        return blockVerdict({
          reason: [
            'BLOCKED PATH (bash): find -exec with `{}` placeholder targets runtime-resolved paths.',
            '',
            '  rea refuses on uncertainty.',
          ].join('\n'),
          hitPattern: '(find -exec placeholder unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      if (d.form === 'parallel_stdin_unresolvable') {
        return blockVerdict({
          reason: [
            'BLOCKED PATH (bash): parallel without `:::` reads inputs from stdin and cannot be statically resolved.',
            '',
            '  rea refuses on uncertainty.',
          ].join('\n'),
          hitPattern: '(parallel stdin unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      if (d.form === 'archive_extract_unresolvable') {
        return blockVerdict({
          reason: [
            'BLOCKED PATH (bash): archive extraction targets are unresolvable.',
            '',
            '  rea refuses on uncertainty.',
          ].join('\n'),
          hitPattern: '(archive extract unresolvable)',
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
      return blockVerdict({
        reason: [
          'BLOCKED PATH (bash): unresolved shell expansion in target.',
          '',
          `  Token:           ${d.path}`,
          `  Detected as:     ${d.form}`,
        ].join('\n'),
        hitPattern: '(dynamic target)',
        detectedForm: d.form,
        ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
      });
    }
    if (d.path.length === 0) continue;

    const norm = normalizeTarget(ctx.reaRoot, d.path, d.form);
    if (norm.expansion) {
      return blockVerdict({
        reason: [
          'BLOCKED PATH (bash): unresolved shell expansion in target.',
          '',
          `  Token:           ${norm.original}`,
          `  Detected as:     ${d.form}`,
        ].join('\n'),
        hitPattern: '(dynamic target)',
        detectedForm: d.form,
        ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
      });
    }
    if (norm.outsideRoot) {
      // blocked_paths is project-relative; outside-root paths can't
      // match. Continue to the next detection.
      continue;
    }

    const dirOptions = d.isDirTarget === true ? { forceDirSemantics: true } : undefined;
    const logicalHit = matchBlockedEntry(norm.pathLc, ctx.blockedPaths, dirOptions);
    if (logicalHit !== null) {
      return blockVerdict({
        reason: buildBlockReason({
          entry: logicalHit,
          hitForm: norm.pathLc,
          detectedForm: d.form,
          originalToken: norm.original,
        }),
        hitPattern: logicalHit,
        detectedForm: d.form,
        ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
      });
    }
    if (norm.resolvedLc !== null) {
      const resolvedHit = matchBlockedEntry(norm.resolvedLc, ctx.blockedPaths, dirOptions);
      if (resolvedHit !== null) {
        return blockVerdict({
          reason: buildBlockReason({
            entry: resolvedHit,
            hitForm: norm.resolvedLc,
            detectedForm: d.form,
            originalToken: norm.original,
          }),
          hitPattern: resolvedHit,
          detectedForm: d.form,
          ...(d.position.line > 0 ? { sourcePosition: d.position } : {}),
        });
      }
    }
  }
  return allowVerdict();
}
