import path from 'node:path';
import { InvocationStatus } from '../../policy/types.js';
import { loadPolicyAsync } from '../../policy/loader.js';
import type { Policy } from '../../policy/types.js';
import type { Middleware } from './chain.js';

/**
 * Pre-execution middleware: denies tool invocations whose path-shaped arguments
 * reference paths in the policy's `blocked_paths` list.
 *
 * BUG-001 (0.3.x): earlier versions substring-matched blocked patterns against
 * EVERY string value in the argument tree — including free-form `content` and
 * `body` fields. Combined with a fallback that stripped the leading `.` from
 * `.env`, a note containing the word "environment" tripped the guard. This
 * version restricts enforcement to:
 *   1. Arguments whose leaf key name is a known path-like identifier
 *      (`path`, `file_path`, `filename`, `folder`, …), OR
 *   2. Arguments whose value LOOKS like a filesystem path (contains a slash,
 *      starts with `.` + alnum, `~`, `/`, or `./`).
 *
 * Post-merge hardening (0.4.0, PR #24 round-1 Codex blockers):
 *   - "Content" keys (content/body/text/message/name/value/label/tag/tags/
 *     title/description/...) are skipped ONLY when the value is NOT path-shaped.
 *     If an argument like `{name: ".env"}` or `{value: "/etc/hosts"}` lands in
 *     those keys, the path-shape heuristic still routes it into the scanner.
 *   - Absolute-path blocked_paths entries (e.g. `/etc/passwd`, `/var/log/`)
 *     match absolute-path values anchored at the filesystem root. The BUG-001
 *     narrowing dropped the leading `/` during segmentation and silently
 *     regressed these entries; restored by carrying an absolute flag through.
 *   - Malformed `%XX` URL-escape sequences now FAIL CLOSED (request blocked)
 *     rather than falling through with undecoded content, which previously
 *     allowed `.rea/` trust-root bypass via crafted escapes like `.rea%ZZ/foo`.
 *
 * SECURITY: .rea/ is always blocked regardless of policy (trust root).
 * SECURITY: Matching is path-segment aware — no substring false positives.
 * SECURITY: Absolute-path patterns are anchored at `/`, not just basename.
 * SECURITY: Glob patterns (`*`, `?`) in blocked_paths are interpreted as
 *   single-segment globs (`*` = any chars except `/`, `?` = one non-`/` char).
 * SECURITY: URL-encoded separators and case variants are normalized first.
 * SECURITY: Malformed URL-escapes are treated as hostile (request blocked).
 * SECURITY: Hot-reloads blocked_paths from policy.yaml when baseDir is given.
 */

const PATH_LIKE_KEYS: ReadonlySet<string> = new Set([
  'path',
  'paths',
  'file',
  'files',
  'file_path',
  'filepath',
  'filename',
  'filenames',
  'folder',
  'folders',
  'dir',
  'directory',
  'directories',
  'src',
  'source',
  'dst',
  'dest',
  'destination',
  'target',
  'input_path',
  'output_path',
  'from',
  'to',
  'pattern',
  'glob',
  'uri',
  'url',
]);

/**
 * Keys whose values are usually free-form prose rather than paths. We skip
 * these by name ONLY when the value is not path-shaped. A payload like
 * `{name: ".env"}` or `{value: "/etc/hosts"}` is still scanned because the
 * value itself passes `looksLikePath()`. This avoids the round-1 Codex
 * finding where these keys were a blanket skip-list that let real blocked-
 * path writes addressed as `{name: ".env"}` slip through.
 */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'contents',
  'body',
  'text',
  'message',
  'note',
  'notes',
  'description',
  'summary',
  'title',
  'query',
  'prompt',
  'search',
  'q',
  'comment',
  'caption',
  'subject',
  'name',
  'label',
  'tag',
  'tags',
  'value',
  'reason',
]);

export function createBlockedPathsMiddleware(initialPolicy: Policy, baseDir?: string): Middleware {
  return async (ctx, next) => {
    let blockedPaths = initialPolicy.blocked_paths;
    if (baseDir !== undefined) {
      try {
        const policy = await loadPolicyAsync(baseDir);
        blockedPaths = policy.blocked_paths;
      } catch {
        // Fall back to initial policy's blocked_paths on read failure.
      }
    }

    const patterns = [...new Set([...blockedPaths, '.rea/'])];

    for (const [key, value] of extractScannableStrings(ctx.arguments)) {
      // Fail closed on malformed URL-escape sequences: silently falling back
      // to undecoded content previously allowed `.rea/` trust-root bypass via
      // crafted escapes like `.rea%ZZ/foo`. A malformed escape in a path-
      // shaped value is treated as hostile.
      if (hasMalformedEscape(value)) {
        ctx.status = InvocationStatus.Denied;
        ctx.error = `Argument "${key}" contains malformed URL-escape; blocked as hostile. Tool: ${ctx.tool_name}`;
        return;
      }
      for (const pattern of patterns) {
        if (matchesBlockedPattern(value, pattern)) {
          ctx.status = InvocationStatus.Denied;
          ctx.error = `Argument "${key}" references blocked path "${pattern}". Tool: ${ctx.tool_name}`;
          return;
        }
      }
    }

    await next();
  };
}

/**
 * Walk the arg tree and return `[keyPath, value]` for strings we should scan.
 *
 * Routing rules:
 *   - PATH_LIKE_KEYS (file_path, folder, …): always scan.
 *   - CONTENT_KEYS (content, body, name, value, title, …): scan ONLY when the
 *     value is path-shaped per `looksLikePath()`. A prose title like
 *     "Working with .env files" is not path-shaped (contains whitespace) and
 *     is skipped; a value like `"/etc/hosts"` or `".env"` is path-shaped and
 *     is scanned.
 *   - Any other key: scan when the value is path-shaped.
 * Array indices inherit the parent key's semantics.
 */
function extractScannableStrings(
  obj: unknown,
  prefix = '',
  inheritedKey = '',
  seen: WeakSet<object> = new WeakSet<object>(),
): Array<[string, string]> {
  const out: Array<[string, string]> = [];

  if (obj === null || obj === undefined) return out;

  if (typeof obj === 'string') {
    const leaf = inheritedKey.toLowerCase();
    const pathShaped = looksLikePath(obj);
    if (CONTENT_KEYS.has(leaf)) {
      // Content-ish key: only scan when the value itself looks path-shaped.
      if (pathShaped) out.push([prefix || 'value', obj]);
      return out;
    }
    if (PATH_LIKE_KEYS.has(leaf) || pathShaped) {
      out.push([prefix || 'value', obj]);
    }
    return out;
  }

  if (typeof obj !== 'object') return out;

  const ref = obj as object;
  if (seen.has(ref)) return out;
  seen.add(ref);

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      out.push(...extractScannableStrings(obj[i], `${prefix}[${i}]`, inheritedKey, seen));
    }
    return out;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    out.push(...extractScannableStrings(value, fullKey, key, seen));
  }
  return out;
}

/**
 * Heuristic: does this string look like a filesystem path rather than prose?
 * Must not contain whitespace/newlines, ≤1024 chars, AND one of:
 *   - contains `/` or `\`
 *   - starts with `~`
 *   - starts with `.` followed by an alnum (dotfile)
 *   - matches a Windows drive prefix
 *   - contains a URL-encoded path separator (`%2f`, `%5c`) or a URL-encoded
 *     dot prefix (`%2e`) — these decode to the patterns above and must not
 *     be allowed to bypass the shape check
 */
function looksLikePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (/[\s\n\r\t]/.test(value)) return false;
  if (value.includes('/') || value.includes('\\')) return true;
  if (value.startsWith('~')) return true;
  if (/^\.[a-zA-Z0-9_-]/.test(value)) return true;
  if (/^[a-zA-Z]:[/\\]/.test(value)) return true;
  // URL-encoded path separators / dot prefix: `.%72ea/foo`, `%2erea%2ffoo`.
  if (/%2[efEF]/i.test(value) || /%5[cC]/.test(value)) return true;
  return false;
}

/**
 * Detect malformed `%XX` URL-escape sequences.
 *
 * A value is considered malformed when:
 *   - Any `%` is not followed by exactly two hex digits (structural), OR
 *   - The structurally-valid escapes decode to an invalid UTF-8 byte
 *     sequence (thrown by `decodeURIComponent`).
 *
 * Strings with no `%` are always well-formed.
 *
 * Rationale (Codex round-1 finding 3): the previous `normalizePath` wrapped
 * `decodeURIComponent` in a catch-all that silently fell back to the raw
 * value. This let `.rea%ZZ/foo` bypass the `.rea/` trust-root check because
 * the segment split on `/` kept `.rea%zz` and `foo`, neither of which equal
 * `.rea`. We now fail closed on malformed escapes before any pattern match.
 */
function hasMalformedEscape(value: string): boolean {
  if (!value.includes('%')) return false;
  if (/%(?![0-9a-fA-F]{2})/.test(value)) return true;
  try {
    decodeURIComponent(value);
    return false;
  } catch {
    return true;
  }
}

/**
 * Check a candidate value against a blocked-path pattern with path-segment
 * awareness. Supports simple globs: `*` = any chars except `/`, `?` = one
 * non-`/` char. Trailing `/` means "this directory and everything under it".
 *
 * Absolute-path patterns (leading `/`) are anchored at the filesystem root:
 *   - pattern `/etc/passwd` matches `/etc/passwd` and `/etc/passwd/anything/`
 *     when the pattern is a dir pattern, but NEVER matches `/project/etc/passwd`.
 * Relative patterns (no leading `/`) match tail-aligned segments anywhere in
 * the value (`.env` matches `/project/.env` and `.env`).
 */
function matchesBlockedPattern(value: string, pattern: string): boolean {
  const nv = normalizePath(value);
  const np = normalizePath(pattern);
  if (np.length === 0) return false;

  const patternAbsolute = np.startsWith('/');
  const valueAbsolute = nv.startsWith('/');

  const dirPattern = np.endsWith('/');
  const base = dirPattern ? np.slice(0, -1) : np;
  if (base.length === 0) return false;

  const hasGlob = /[*?]/.test(base);
  const segs = nv.split('/').filter((s) => s.length > 0);

  if (patternAbsolute) {
    // Anchored match at filesystem root. Strip the pattern's leading slash
    // for segment-wise comparison, but do NOT let the pattern match
    // non-absolute values or absolute values with different roots.
    if (!valueAbsolute) return false;
    const baseNoSlash = base.startsWith('/') ? base.slice(1) : base;
    if (baseNoSlash.length === 0) return false;
    const patternSegs = baseNoSlash.split('/').filter((s) => s.length > 0);
    if (patternSegs.length === 0) return false;

    if (hasGlob) {
      // Absolute glob: anchored at root, each segment matched positionally.
      if (segs.length < patternSegs.length) return false;
      for (let i = 0; i < patternSegs.length; i++) {
        const pseg = patternSegs[i];
        const vseg = segs[i];
        if (pseg === undefined || vseg === undefined) return false;
        const re = globToRegex(pseg);
        if (!re.test(vseg)) return false;
      }
      if (!dirPattern && segs.length !== patternSegs.length) return false;
      return true;
    }

    // Plain absolute pattern: positional, rooted.
    if (segs.length < patternSegs.length) return false;
    for (let i = 0; i < patternSegs.length; i++) {
      if (segs[i] !== patternSegs[i]) return false;
    }
    if (!dirPattern && segs.length !== patternSegs.length) return false;
    return true;
  }

  if (hasGlob) {
    const re = globToRegex(base);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg !== undefined && re.test(seg)) return true;
      const suffix = segs.slice(i).join('/');
      if (re.test(suffix)) return true;
    }
    return false;
  }

  for (let i = 0; i < segs.length; i++) {
    const suffix = segs.slice(i).join('/');
    if (suffix === base) return true;
    if (dirPattern && suffix.startsWith(`${base}/`)) return true;
  }

  const basename = segs[segs.length - 1] ?? '';
  if (basename === base) return true;
  if (dirPattern && segs.includes(base)) return true;

  return false;
}

/**
 * Convert a simple glob to an anchored RegExp. Only `*` and `?` are special;
 * all other regex metacharacters are escaped.
 */
function globToRegex(glob: string): RegExp {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (/[.+^${}()|[\]\\]/.test(ch)) out += `\\${ch}`;
    else out += ch;
  }
  out += '$';
  return new RegExp(out);
}

/**
 * Normalize a value or pattern: URL-decode, normalize path separators, resolve
 * `.`/`..` segments, lowercase.
 *
 * IMPORTANT: callers MUST first reject malformed URL-escapes via
 * `hasMalformedEscape()` before calling this on untrusted input. Silently
 * falling back to undecoded content on URIError previously allowed crafted
 * `.rea%ZZ/foo` sequences to bypass the `.rea/` check.
 */
function normalizePath(raw: string): string {
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    // Trusted-pattern fallback: patterns come from policy.yaml and never
    // reach this branch in practice. Untrusted values are filtered upstream
    // by `hasMalformedEscape()`, so this catch is defense in depth for
    // trusted inputs only. Leave value as-is.
  }
  v = v.replace(/\\/g, '/');
  v = path.posix.normalize(v);
  return v.toLowerCase();
}
