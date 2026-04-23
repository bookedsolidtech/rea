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
