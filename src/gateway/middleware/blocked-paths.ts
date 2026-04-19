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
 *     title/description/...) are ALWAYS skipped — they are never path
 *     destinations. Scanning them by value shape caused availability regressions
 *     on every tool call that used these keys as metadata (e.g. messaging tools
 *     with `message: "/some/path"`). The accepted tradeoff: false negatives on
 *     content-key bypasses are preferable to false positives across the gateway.
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
 * SECURITY: Triple+ encoded separators (%25252F → … → /) are decoded via an
 *   iterative decode-until-stable loop (no arbitrary cap) so they cannot escape
 *   the normalizer regardless of encoding depth.
 * SECURITY: Only `file:` URIs are mapped to local filesystem paths. All other
 *   URI schemes (http:, https:, ftp:, etc.) reference remote resources and are
 *   returned as empty string so they never match any blocked_paths entry.
 * SECURITY: `file:` URI authority forms (file://host/path, file:///path,
 *   file:/path) are all stripped to a bare path before decoding.
 * SECURITY: Query strings and fragments in `file:` URIs
 *   (`file:///etc/passwd?dl=1#x`) are stripped before normalization so the
 *   path component is compared cleanly against blocked entries.
 * SECURITY: C0 control characters (including null bytes) are stripped after
 *   decoding so they cannot smuggle segment prefixes past equality checks.
 * SECURITY: Malformed URL-escapes are treated as hostile (request blocked).
 * SECURITY: Paths with `%` that are not full `%XX` sequences (e.g.
 *   `/builds/50%complete/`) trigger the malformed-escape fail-closed gate.
 *   This is intentional: such values are structurally ambiguous and treated
 *   as hostile. Callers that need literal `%` in paths must percent-encode
 *   it as `%25`.
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
 * Keys whose values are free-form prose or metadata rather than path
 * destinations. These are always skipped — scanning them by value shape
 * caused availability regressions across every gateway tool call that
 * happened to use these keys as metadata (e.g. a messaging tool with
 * `message: "/some/path"` or a tagging tool with `tag: ".env"`).
 * The accepted tradeoff: false negatives on content-key bypasses are
 * preferable to false positives on all tool calls.
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
      // Fail closed: if encoded path separators (%2f / %5c) remain after a
      // full iterative decode, the value is using evasion-level encoding
      // deeper than the decode loop would surface (>5 levels). Treat as hostile
      // rather than risk a miss.
      if (hasDeepEncodedSeparator(value)) {
        ctx.status = InvocationStatus.Denied;
        ctx.error = `Argument "${key}" contains deeply-encoded path separator; blocked as hostile. Tool: ${ctx.tool_name}`;
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
 *   - CONTENT_KEYS (content, body, name, value, title, …): always skip.
 *     These keys carry prose or tool metadata — not path destinations.
 *     Scanning them (even only when path-shaped) denies legitimate tool calls
 *     across the gateway. See CONTENT_KEYS JSDoc for the accepted tradeoff.
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
      // Content-ish keys (message, title, name, body, etc.) are never path
      // destinations — skip regardless of value shape. Scanning by shape here
      // would deny legitimate tool metadata across the gateway.
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
 * Detect evasion-level encoding: run a decode-until-stable loop and check
 * whether any percent-encoded path separators (%2f / %5c) survive all passes.
 *
 * This closes the depth-6+ bypass: `.rea%25252525252Ffoo` encodes the
 * separator at 6 levels. After 5 decode passes it emerges as `.rea%2ffoo` —
 * the pattern check would miss it. Running to true stability and then checking
 * for remaining encoded separators catches all depths regardless of how many
 * encode rounds were applied.
 *
 * Strings without `%` short-circuit immediately. The try/catch exits cleanly
 * on any URIError so malformed inputs (already caught by hasMalformedEscape)
 * do not crash here.
 */
function hasDeepEncodedSeparator(value: string): boolean {
  if (!value.includes('%')) return false;
  let v = value;
  for (;;) {
    try {
      const next = decodeURIComponent(v);
      if (next === v) break;
      v = next;
    } catch {
      break;
    }
  }
  return /%2[fF]|%5[cC]/i.test(v);
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
 * Normalize a value or pattern: strip URI scheme, URL-decode iteratively until
 * stable (handles any encoding depth), strip C0 control characters, normalize
 * path separators, resolve `.`/`..` segments, lowercase.
 *
 * IMPORTANT: callers MUST first reject malformed URL-escapes via
 * `hasMalformedEscape()` before calling this on untrusted input. Silently
 * falling back to undecoded content on URIError previously allowed crafted
 * `.rea%ZZ/foo` sequences to bypass the `.rea/` check.
 *
 * Step 1 — URI scheme dispatch:
 *   - Non-file schemes (http:, https:, ftp:, …) reference remote resources and
 *     are returned immediately as `''` — they never match any blocked_paths
 *     entry (all of which are local filesystem paths).
 *   - `file:` URIs: strip the scheme + optional authority so all three forms
 *     collapse to a plain absolute path (`file:///path`, `file://host/path`,
 *     `file:/path` → `/path`).
 *   - No scheme: left as-is.
 * Step 1b — Strip query string and fragment from `file:` paths so
 *   `file:///etc/passwd?dl=1#x` → `/etc/passwd` before any matching.
 * Step 2 — Iterative decode until stable (no cap): catches triple+ encoded
 *   separators (`%25252F` → `%252F` → `%2F` → `/`). Exits when the value
 *   stops changing; per-iteration try/catch exits on URIError.
 * Step 3 — Strip C0 control characters (Finding 2): removes null bytes and
 *   other control chars that could smuggle segment prefixes past equality
 *   checks (e.g. `\x00.gitignore` → `.gitignore`).
 */
function normalizePath(raw: string): string {
  // Step 1: URI scheme dispatch.
  // Only `file:` URIs map to local filesystem paths. All other schemes
  // (http:, https:, ftp:, data:, etc.) reference remote or non-filesystem
  // resources. Mapping them to local paths (e.g. http://evil.com/etc/passwd
  // → /etc/passwd) creates false positives. Return '' so they never match
  // any blocked pattern.
  const fileScheme = /^file:/i.test(raw);
  const otherScheme = !fileScheme && /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//i.test(raw);
  if (otherScheme) return '';

  let v: string;
  if (fileScheme) {
    // Strip file: scheme + optional authority (all three forms):
    //   file:///path        → /path  (triple-slash, empty authority)
    //   file://host/path    → /path  (named authority)
    //   file:/path          → /path  (single-slash, no authority)
    v = raw.replace(/^file:(?:\/\/[^/?#]*)?(?=\/)/, '');
    // Step 1b: strip query string and fragment so file:///etc/passwd?dl=1#x
    // and file:///etc/passwd#fragment both reduce to /etc/passwd.
    v = v.replace(/[?#].*$/, '');
  } else {
    v = raw;
  }

  // Step 2: iterative decode until stable (no iteration cap).
  // Terminates because each successful decode either shortens or leaves the
  // string unchanged; once unchanged we break. Handles any encoding depth
  // (triple, quad, N-level). Per-iteration try/catch exits cleanly on URIError
  // so malformed inputs that somehow pass hasMalformedEscape() (trusted-pattern
  // code path) are left at the last valid value rather than crashing.
  let prev = v;
  for (;;) {
    try {
      const next = decodeURIComponent(prev);
      if (next === prev) break;
      prev = next;
    } catch {
      break;
    }
  }
  v = prev;

  // Step 3: strip C0 control characters (including null bytes \x00–\x1f)
  // that could prefix a segment and defeat segment-equality matching.
  v = v.replace(/[\x00-\x1f]/g, '');

  v = v.replace(/\\/g, '/');
  v = path.posix.normalize(v);
  return v.toLowerCase();
}
