/**
 * Report output for the push-gate.
 *
 * Two channels:
 *
 *   1. `.rea/last-review.json` — machine-readable structured dump. Atomic
 *      write (write-to-tmp + rename), gitignored, overwritten every push.
 *      Claude reads this as the source of truth for file/line/body during
 *      the auto-fix loop.
 *
 *   2. stderr banner — human-legible severity-sorted summary capped to 20
 *      findings. The pre-push hook's stderr reaches Claude as the tool
 *      output of `Bash(git push)`, so this is the primary fast-path to
 *      surface verdict + first blocking finding.
 *
 * Redaction: before serializing anything to disk or stderr we run the
 * shared `SECRET_PATTERNS` list over `title`, `body`, and `reviewText`. If
 * Codex accidentally quoted a secret from the diff (common in password-
 * reset flows, API-key migration PRs, env-file edits) it never hits disk
 * in cleartext.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  compileDefaultSecretPatterns,
  redactSecrets,
  type CompiledSecretPattern,
} from '../../gateway/middleware/redact.js';
import type { Finding, ReviewSummary, Verdict } from './findings.js';

export interface LastReviewPayload {
  schema_version: 1;
  /** ISO-8601 UTC timestamp of the review run (wall clock). */
  generated_at: string;
  verdict: Verdict;
  base_ref: string;
  head_sha: string;
  finding_count: number;
  findings: Finding[];
  /** Full agent text (post-redact). Useful for debugging parser misses. */
  review_text: string;
  /** Number of raw JSONL events Codex emitted. */
  event_count: number;
  /** Wall clock seconds in the Codex subprocess. */
  duration_seconds: number;
}

export interface WriteLastReviewInput {
  baseDir: string;
  summary: ReviewSummary;
  baseRef: string;
  headSha: string;
  eventCount: number;
  durationSeconds: number;
  /** Test seam — defaults to `new Date()`. */
  now?: Date;
}

const LAST_REVIEW_FILENAME = 'last-review.json';

/**
 * Atomic write of `.rea/last-review.json`. Returns the redacted payload
 * actually written so the caller can reuse it for stderr rendering
 * without re-redacting.
 *
 * We write to `last-review.json.tmp.<pid>-<rand>` first, fsync the file
 * descriptor, then rename. rename(2) is atomic within the same
 * filesystem, so partial writes never surface to readers.
 */
export function writeLastReview(input: WriteLastReviewInput): LastReviewPayload {
  const { baseDir, summary, baseRef, headSha, eventCount, durationSeconds } = input;
  const now = input.now ?? new Date();
  const patterns = compileDefaultSecretPatterns({ source: 'default' });

  const payload: LastReviewPayload = {
    schema_version: 1,
    generated_at: now.toISOString(),
    verdict: summary.verdict,
    base_ref: baseRef,
    head_sha: headSha,
    finding_count: summary.findings.length,
    findings: summary.findings.map((f) => redactFinding(f, patterns)),
    review_text: redactString(summary.reviewText, patterns),
    event_count: eventCount,
    duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
  };

  const reaDir = path.join(baseDir, '.rea');
  ensureDir(reaDir);
  const finalPath = path.join(reaDir, LAST_REVIEW_FILENAME);
  const tmpPath = `${finalPath}.tmp.${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
  return payload;
}

function redactFinding(f: Finding, patterns: CompiledSecretPattern[]): Finding {
  return {
    severity: f.severity,
    title: redactString(f.title, patterns),
    body: redactString(f.body, patterns),
    ...(f.file !== undefined ? { file: f.file } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
  };
}

function redactString(s: string, patterns: CompiledSecretPattern[]): string {
  const { output } = redactSecrets(s, patterns);
  return output;
}

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // mkdir -p is idempotent; EEXIST is fine, anything else surfaces to
    // the caller and becomes an exit-2 error.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw e;
  }
}

// ---------------------------------------------------------------------------
// stderr banner rendering
// ---------------------------------------------------------------------------

export interface RenderBannerInput {
  payload: LastReviewPayload;
  /** Where was the base ref sourced from (audit / debugging). */
  baseSource: string;
  /**
   * Whether the verdict-level action is BLOCKED or SOFT. Surfaced in the
   * banner first line. Callers infer this from verdict + concerns_blocks.
   */
  blocked: boolean;
  /** Last-review.json on-disk path — shown as a pointer. */
  lastReviewPath: string;
  /** Max findings to enumerate in the banner. Default 20. */
  maxFindings?: number;
}

const SEVERITY_ORDER: Record<'P1' | 'P2' | 'P3', number> = { P1: 0, P2: 1, P3: 2 };

/**
 * Build the stderr banner as a single multi-line string. Ends with `\n`.
 *
 * Layout:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ push-gate VERDICT — BLOCKED / PROCEEDING   │
 *   │ base: <ref> (<source>)                     │
 *   │ head: <sha>                                │
 *   │ findings: <count>                          │
 *   └────────────────────────────────────────────┘
 *   - [P1] Title — file:42
 *       body-excerpt
 *   ...
 *   see .rea/last-review.json for full details
 */
export function renderBanner(input: RenderBannerInput): string {
  const { payload, baseSource, blocked, lastReviewPath } = input;
  const max = input.maxFindings ?? 20;
  const verdictLabel = blocked ? 'BLOCKED' : 'PROCEEDING';
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`rea push-gate: ${payload.verdict.toUpperCase()} — ${verdictLabel}`);
  lines.push(`base:     ${payload.base_ref}  (${baseSource})`);
  lines.push(`head:     ${payload.head_sha}`);
  lines.push(`findings: ${payload.finding_count}`);
  lines.push(`elapsed:  ${payload.duration_seconds.toFixed(1)}s`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (payload.findings.length === 0) {
    lines.push('(no findings)');
  } else {
    const sorted = [...payload.findings].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
    const shown = sorted.slice(0, max);
    for (const f of shown) {
      const loc =
        f.file !== undefined ? ` — ${f.file}${f.line !== undefined ? `:${f.line}` : ''}` : '';
      lines.push(`- [${f.severity}] ${f.title}${loc}`);
    }
    if (sorted.length > shown.length) {
      lines.push(`... ${sorted.length - shown.length} additional finding(s) suppressed (see JSON)`);
    }
  }
  lines.push('');
  lines.push(`machine-readable: ${lastReviewPath}`);
  lines.push('');
  return lines.join('\n');
}
