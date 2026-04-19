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
 * Free-form content fields (`content`, `body`, `text`, `message`, `description`,
 * …) are never scanned, even when the value coincidentally looks path-shaped.
 *
 * SECURITY: .rea/ is always blocked regardless of policy (trust root).
 * SECURITY: Matching is path-segment aware — no substring false positives.
 * SECURITY: Glob patterns (`*`, `?`) in blocked_paths are interpreted as
 *   single-segment globs (`*` = any chars except `/`, `?` = one non-`/` char).
 * SECURITY: URL-encoded separators and case variants are normalized first.
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
 * A string is scanned when its leaf key is in PATH_LIKE_KEYS, OR its value is
 * path-shaped AND its leaf key is NOT in CONTENT_KEYS. Array indices inherit
 * the parent key's semantics (so `files: [".env"]` scans each element).
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
    if (CONTENT_KEYS.has(leaf)) return out;
    if (PATH_LIKE_KEYS.has(leaf) || looksLikePath(obj)) {
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
 */
function looksLikePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (/[\s\n\r\t]/.test(value)) return false;
  if (value.includes('/') || value.includes('\\')) return true;
  if (value.startsWith('~')) return true;
  if (/^\.[a-zA-Z0-9_-]/.test(value)) return true;
  if (/^[a-zA-Z]:[/\\]/.test(value)) return true;
  return false;
}

/**
 * Check a candidate value against a blocked-path pattern with path-segment
 * awareness. Supports simple globs: `*` = any chars except `/`, `?` = one
 * non-`/` char. Trailing `/` means "this directory and everything under it".
 */
function matchesBlockedPattern(value: string, pattern: string): boolean {
  const nv = normalizePath(value);
  const np = normalizePath(pattern);
  if (np.length === 0) return false;

  const dirPattern = np.endsWith('/');
  const base = dirPattern ? np.slice(0, -1) : np;
  if (base.length === 0) return false;

  const hasGlob = /[*?]/.test(base);
  const segs = nv.split('/').filter((s) => s.length > 0);

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
 */
function normalizePath(raw: string): string {
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    // Leave partially encoded input as-is; downstream normalization still runs.
  }
  v = v.replace(/\\/g, '/');
  v = path.posix.normalize(v);
  return v.toLowerCase();
}
