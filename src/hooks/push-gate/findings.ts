/**
 * Finding shape and verdict inference for the stateless push-gate.
 *
 * `codex exec review --json` emits JSONL events over stdout. The terminal
 * event is an `item.completed` with `item.type === "agent_message"` whose
 * `text` body is human-prose review output using Codex's standard severity
 * convention:
 *
 *   - `[P1]` — blocking. Must be addressed before merge.
 *   - `[P2]` — concerns. Significant risk the reviewer wants fixed.
 *   - `[P3]` — nits / low-priority suggestions.
 *
 * We extract one `Finding` per severity-marker bullet in the message text
 * and infer a verdict:
 *
 *   - Any `P1`                  → `blocking`
 *   - Else any `P2`             → `concerns`
 *   - Else (P3 or nothing)      → `pass`
 *
 * This is a text-parse, not a schema consumer. Codex does not expose a
 * structured review schema through the JSONL event stream today (only
 * `--output-schema` on plain `codex exec` does that). When the plugin
 * ecosystem catches up we can swap the parser without touching the gate.
 */

export type Severity = 'P1' | 'P2' | 'P3';

export type Verdict = 'pass' | 'concerns' | 'blocking';

export interface Finding {
  severity: Severity;
  title: string;
  /** File path, when the marker line carried one. */
  file?: string;
  /** Starting line number, when the marker carried `<path>:<line>`. */
  line?: number;
  /** Full body of the finding (all lines up to the next marker or EOF). */
  body: string;
}

export interface ReviewSummary {
  verdict: Verdict;
  findings: Finding[];
  /** The raw `agent_message` text, concatenated from every turn. */
  reviewText: string;
}

/**
 * Parse Codex review prose into structured findings. The parser is
 * conservative — lines that don't start with a severity marker are folded
 * into the previous finding's body. Unknown markers (`[P4]`, `[P0]`) are
 * ignored; we only recognize P1/P2/P3.
 *
 * Expected marker shapes, matched line-by-line:
 *
 *     - [P1] Title goes here — path/to/file.ts:42
 *     - [P1] Title — path/to/file.ts
 *     - [P1] Title
 *
 * The dash/bullet prefix is optional (Codex emits both `- [P1]` and bare
 * `[P1]` depending on model and prompt). Whitespace around the severity
 * marker is tolerated.
 */
export function parseFindings(reviewText: string): Finding[] {
  const lines = reviewText.split(/\r?\n/);
  const out: Finding[] = [];
  let current: Finding | null = null;
  // Anchored at the start of a trimmed line — an inline `[P1]` in the
  // middle of a sentence is not a finding marker. The `^` excludes the
  // all-text prefix inside the match itself; we trim before testing.
  const MARKER_RE = /^(?:[-*]\s*)?\[(P[123])\]\s+(.+?)\s*$/;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const match = MARKER_RE.exec(trimmed);
    if (match !== null) {
      if (current !== null) out.push(current);
      const severity = match[1] as Severity;
      const titleWithLocation = match[2] ?? '';
      const { title, file, line } = splitTitleLocation(titleWithLocation);
      current = {
        severity,
        title,
        body: rawLine,
        ...(file !== undefined ? { file } : {}),
        ...(line !== undefined ? { line } : {}),
      };
      continue;
    }
    if (current !== null) {
      current.body = current.body.length > 0 ? `${current.body}\n${rawLine}` : rawLine;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/**
 * Split "Title — file.ts:42" or "Title - file.ts" or bare "Title" into
 * constituent parts. Codex emits an em-dash (`—`) as the separator in the
 * default review prompt but we also accept `--` and `-` for robustness.
 */
function splitTitleLocation(raw: string): { title: string; file?: string; line?: number } {
  // Try em-dash first (Codex default), then double-dash, then single-dash
  // surrounded by whitespace. A plain `-` inside a title (e.g. "pre-push")
  // is preserved because we require surrounding whitespace.
  let splitIdx = raw.indexOf(' — ');
  let sepLen = 3;
  if (splitIdx < 0) {
    splitIdx = raw.indexOf(' -- ');
    sepLen = 4;
  }
  if (splitIdx < 0) {
    const dashMatch = / - /.exec(raw);
    if (dashMatch !== null) {
      splitIdx = dashMatch.index;
      sepLen = 3;
    }
  }
  if (splitIdx < 0) {
    return { title: raw.trim() };
  }
  const title = raw.slice(0, splitIdx).trim();
  const locationRaw = raw.slice(splitIdx + sepLen).trim();
  // `path/to/file.ts:42` or `path/to/file.ts:42-48` or bare `path/to/file.ts`.
  const locMatch = /^([^\s:]+?)(?::(\d+)(?:-\d+)?)?$/.exec(locationRaw);
  if (locMatch === null) {
    // Location we can't parse — keep the whole thing as the title so we
    // don't silently drop it.
    return { title: raw.trim() };
  }
  const file = locMatch[1];
  const lineStr = locMatch[2];
  const result: { title: string; file?: string; line?: number } = { title };
  if (file !== undefined && file.length > 0) result.file = file;
  if (lineStr !== undefined && lineStr.length > 0) {
    const n = Number.parseInt(lineStr, 10);
    if (Number.isFinite(n) && n > 0) result.line = n;
  }
  return result;
}

/**
 * Map a finding array to a single verdict. Safe-fail order: any P1 wins,
 * then any P2, else pass.
 */
export function inferVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'P1')) return 'blocking';
  if (findings.some((f) => f.severity === 'P2')) return 'concerns';
  return 'pass';
}

/**
 * Convenience: parse + infer in one call.
 */
export function summarizeReview(reviewText: string): ReviewSummary {
  const findings = parseFindings(reviewText);
  return {
    verdict: inferVerdict(findings),
    findings,
    reviewText,
  };
}

/**
 * 0.28.0 helix-029 — partition findings against a list of gitignore-style
 * globs. Findings whose `file` path matches any glob land in
 * `excluded`; everything else (including findings without a `file`
 * field — codex prose without a path can't be path-filtered) lands in
 * `kept`. The verdict is recomputed from `kept` only.
 *
 * Glob semantics (intentionally minimal — full gitignore parity is out
 * of scope for the gate):
 *
 *   - `**` matches any number of path segments (including zero)
 *   - `*` matches any chars within a single path segment
 *   - `?` matches a single character within a segment
 *   - leading `/` anchors the glob at the root (the default — paths are
 *     repo-relative anyway)
 *   - trailing `/` is treated as `/**` (directory match)
 *
 * Path normalization: backslashes → slashes (Windows checkout
 * tolerance), leading `./` stripped. Globs are case-sensitive on every
 * platform so a Windows checkout doesn't silently widen the filter.
 */
export interface FilterResult {
  kept: Finding[];
  excluded: Finding[];
  verdict: Verdict;
}

export function filterFindingsByPath(findings: Finding[], globs: readonly string[]): FilterResult {
  if (globs.length === 0) {
    return { kept: findings, excluded: [], verdict: inferVerdict(findings) };
  }
  // Compile once. Anchored at start, end, slash-tolerant.
  const compiled = globs.map(compileGlob);
  const kept: Finding[] = [];
  const excluded: Finding[] = [];
  for (const f of findings) {
    if (f.file === undefined) {
      kept.push(f);
      continue;
    }
    const norm = normalizePath(f.file);
    let matched = false;
    for (const re of compiled) {
      if (re.test(norm)) {
        matched = true;
        break;
      }
    }
    if (matched) excluded.push(f);
    else kept.push(f);
  }
  return { kept, excluded, verdict: inferVerdict(kept) };
}

function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  if (out.startsWith('./')) out = out.slice(2);
  if (out.startsWith('/')) out = out.slice(1);
  return out;
}

/**
 * Compile a gitignore-style glob into a RegExp. Conservative — handles
 * the four wildcard forms documented above and treats every other
 * character as a literal. The cost of a too-narrow compiler is a
 * miss-and-no-filter (the finding stays in `kept` and blocks the push,
 * which is the safer failure mode). The cost of a too-wide compiler is
 * a false suppression — strictly worse, since findings disappear
 * silently. We err narrow.
 */
function compileGlob(rawGlob: string): RegExp {
  let glob = rawGlob;
  if (glob.startsWith('/')) glob = glob.slice(1);
  // Trailing `/` → `/**` (directory match).
  if (glob.endsWith('/')) glob = `${glob}**`;
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      // `**` matches any number of path segments (including zero); a
      // single `*` matches any chars within a segment.
      if (i + 1 < glob.length && glob[i + 1] === '*') {
        // Consume the second `*`. If followed by `/`, also consume it
        // so `a/**/b` matches both `a/b` (zero segments) and `a/x/b`.
        i += 1;
        if (i + 1 < glob.length && glob[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c !== undefined && /[.+^$|(){}[\]\\]/.test(c)) {
      // Escape regex meta-characters.
      re += `\\${c}`;
    } else if (c !== undefined) {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
