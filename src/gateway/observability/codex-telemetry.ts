/**
 * Codex reviewer telemetry (G11.5).
 *
 * Append-only observational metrics for adversarial-review invocations. Each
 * record captures the invocation type, estimated token counts, duration,
 * exit code, and whether the downstream reviewer appears to have been
 * rate-limited (detected from stderr).
 *
 * ## Non-goals
 *
 * - This is NOT the audit log. The audit log (`.rea/audit.jsonl`) is a
 *   hash-chained record of every middleware invocation and is authoritative
 *   for compliance. Telemetry is free-form, per-reviewer-call numbers for
 *   operators to watch spend and rate-limit pressure.
 * - No input/output payloads are stored. We estimate token counts from
 *   character counts on the fly; the raw strings are discarded after the
 *   record is constructed. This is non-negotiable — the brief explicitly
 *   prohibits storing the diff or the reviewer output. Any future extension
 *   that seems to need the text should reach for the audit log or a
 *   dedicated, policy-gated payload store instead.
 *
 * ## Write discipline
 *
 * - File: `<reaDir>/.rea/metrics.jsonl`. Created with the parent dir if
 *   absent. One JSON object per line, newline-terminated, fsync'd after
 *   each append.
 * - Fail-soft: write errors log a single stderr warning but never throw.
 *   Telemetry must never interfere with the reviewed operation.
 *
 * ## Read discipline
 *
 * - `summarizeTelemetry` streams the file, bucketed by local-tz day, and
 *   returns a fixed-shape summary. Missing file → all-zero summary.
 *
 * ## Token estimation
 *
 * - `chars / 4` — a well-known rule of thumb. Close enough for spend
 *   forecasting; not suitable for billing reconciliation. If a future
 *   caller needs precise counts, plug in a tokenizer per reviewer and keep
 *   the estimation as a fallback.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const REA_DIR = '.rea';
const METRICS_FILE = 'metrics.jsonl';

/** Shared denominator for the chars/tokens heuristic. */
const CHARS_PER_TOKEN = 4;

/**
 * Stable identifiers for the contexts in which a reviewer runs. Keep this
 * closed — downstream dashboards will key on these strings.
 */
export type TelemetryInvocationType = 'review' | 'adversarial-review' | 'rescue';

/** One row in `metrics.jsonl`. */
export interface TelemetryRecord {
  timestamp: string;
  invocation_type: TelemetryInvocationType;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  duration_ms: number;
  exit_code: number;
  rate_limited: boolean;
  /**
   * 0.50.x — provider that produced this row (`'codex'` | `'openrouter'`).
   * OMITTED on existing codex rows so they stay byte-identical; readers
   * treat an absent `provider` as `'codex'`.
   */
  provider?: string;
  /** 0.50.x — model id, when applicable (e.g. `'openai/gpt-oss-120b'`). */
  model?: string;
  /** 0.50.x — OpenRouter serving backend (e.g. `'fireworks'`). */
  served_by?: string;
  /**
   * 0.50.x — EXACT input tokens from the provider's usage block, when
   * present (OpenRouter returns these). Distinct from
   * `estimated_input_tokens` (the chars/4 heuristic), which is always set.
   */
  input_tokens?: number;
  /** 0.50.x — EXACT output tokens from the provider's usage block. */
  output_tokens?: number;
  /** 0.50.x — estimated cost in USD for this call. */
  est_cost_usd?: number;
}

/**
 * Call site input. `input_text` / `output_text` are used ONLY for token
 * estimation and are NOT persisted. See the file header.
 */
export interface RecordTelemetryInput {
  invocation_type: TelemetryInvocationType;
  input_text: string;
  output_text: string;
  duration_ms: number;
  exit_code: number;
  stderr?: string;
  /**
   * 0.50.x — provider identity + exact usage. All optional; when omitted
   * the row is byte-identical to a pre-0.50.x codex row. Conditional-spread
   * onto the record only when defined.
   */
  provider?: string;
  model?: string;
  served_by?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    est_cost_usd?: number;
  };
}

/** Shape returned by {@link summarizeTelemetry}. */
export interface TelemetrySummary {
  /** Number of days the summary covers. */
  window_days: number;
  /** Count per day, most-recent first. Always length === window_days. */
  invocations_per_day: number[];
  /** Sum of input + output estimates across the window. */
  total_estimated_tokens: number;
  /** How many records in the window flagged `rate_limited: true`. */
  rate_limited_count: number;
  /** Arithmetic mean of duration_ms across all records in the window. */
  avg_latency_ms: number;
  /**
   * 0.50.x — estimated spend in USD per provider across the window, for
   * doctor's per-provider spend line. A row with no `provider` field is
   * bucketed under `'codex'`. A row with no `est_cost_usd` contributes 0.
   * Absent (undefined) when no row in the window carried a cost — so codex-
   * only telemetry summaries stay shape-compatible with pre-0.50.x readers.
   */
  est_cost_usd_by_provider?: Record<string, number>;
}

/**
 * Regex for rate-limit markers. Matches the common phrasings we've seen
 * across Codex, OpenAI API, and Anthropic API error tails. Case-insensitive
 * so "Rate Limit" and "429" both match.
 *
 * Keep this permissive — a false positive is cheap (we flag an invocation
 * as throttled that wasn't), a false negative silently under-reports the
 * problem the operator is trying to measure.
 */
const RATE_LIMIT_REGEX = /rate[- ]limit|\b429\b|usage limit|exceeded quota/i;

/**
 * Token count estimate. Floors to zero for empty strings so downstream
 * math doesn't have to guard.
 */
function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Detect whether the reviewer's stderr looks rate-limited. */
function detectRateLimited(stderr: string | undefined): boolean {
  if (stderr === undefined || stderr.length === 0) return false;
  return RATE_LIMIT_REGEX.test(stderr);
}

/** Canonical location for the metrics file under `baseDir`. */
export function metricsFilePath(baseDir: string): string {
  return path.join(baseDir, REA_DIR, METRICS_FILE);
}

/**
 * Append a single telemetry row. Always fail-soft — the caller must be
 * able to treat this as a best-effort observation and continue.
 */
export async function recordTelemetry(baseDir: string, input: RecordTelemetryInput): Promise<void> {
  const record: TelemetryRecord = {
    timestamp: new Date().toISOString(),
    invocation_type: input.invocation_type,
    estimated_input_tokens: estimateTokens(input.input_text),
    estimated_output_tokens: estimateTokens(input.output_text),
    duration_ms: Math.max(0, input.duration_ms | 0),
    exit_code: input.exit_code | 0,
    rate_limited: detectRateLimited(input.stderr),
    // 0.50.x — conditional-spread provider identity + exact usage. Each key
    // is added ONLY when defined so a codex call (which passes none of
    // these) produces a row byte-identical to a pre-0.50.x row.
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.served_by !== undefined ? { served_by: input.served_by } : {}),
    ...(input.usage?.input_tokens !== undefined
      ? { input_tokens: input.usage.input_tokens }
      : {}),
    ...(input.usage?.output_tokens !== undefined
      ? { output_tokens: input.usage.output_tokens }
      : {}),
    ...(input.usage?.est_cost_usd !== undefined
      ? { est_cost_usd: input.usage.est_cost_usd }
      : {}),
  };

  const filePath = metricsFilePath(baseDir);
  const dir = path.dirname(filePath);
  const line = JSON.stringify(record) + '\n';

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(filePath, line);
    // Best-effort fsync; failure is non-fatal.
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(filePath, 'r');
      await fh.sync();
    } catch {
      /* ignored */
    } finally {
      if (fh) await fh.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // One line, to stderr, never throw. Consumers tailing logs will see it.
    console.warn(`[rea] WARN: codex telemetry write failed: ${message}`);
  }
}

/** Group records by local-tz YYYY-MM-DD. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'invalid';
  // Local-tz date — operators want "today" to mean their local today.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local-tz day key for a JS Date. */
function dayKeyForDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Load all records from `metrics.jsonl`. Returns `[]` when the file is
 * missing; skips (not throws) individual unparseable lines so a single
 * corrupt row doesn't hide the rest of the window.
 */
async function readRecords(filePath: string): Promise<TelemetryRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: TelemetryRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<TelemetryRecord>;
      if (
        typeof parsed.timestamp === 'string' &&
        typeof parsed.duration_ms === 'number' &&
        typeof parsed.exit_code === 'number' &&
        typeof parsed.rate_limited === 'boolean'
      ) {
        out.push(parsed as TelemetryRecord);
      }
    } catch {
      // Malformed line — skip. A future integrity check can flag this.
    }
  }
  return out;
}

/**
 * Build the fixed-shape summary. When `metrics.jsonl` is missing the result
 * is all-zero — callers should NEVER see an exception for "no data yet".
 */
export async function summarizeTelemetry(
  baseDir: string,
  windowDays = 7,
): Promise<TelemetrySummary> {
  const days = Math.max(1, windowDays | 0);
  const filePath = metricsFilePath(baseDir);

  let records: TelemetryRecord[];
  try {
    records = await readRecords(filePath);
  } catch {
    // Read error (permissions, etc.) — treat as empty. Telemetry must never
    // break a consumer that just wants to see "is this up?".
    records = [];
  }

  // Build day buckets most-recent-first.
  const now = new Date();
  const bucketKeys: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - i);
    bucketKeys.push(dayKeyForDate(d));
  }
  const countsByKey = new Map<string, number>();
  for (const k of bucketKeys) countsByKey.set(k, 0);

  let totalTokens = 0;
  let rateLimitedCount = 0;
  let durationSum = 0;
  let inWindow = 0;
  // 0.50.x — per-provider spend. Only populated when at least one in-window
  // row carries an `est_cost_usd`; otherwise left undefined so codex-only
  // summaries stay shape-identical to the pre-0.50.x contract.
  const costByProvider = new Map<string, number>();

  for (const r of records) {
    const key = dayKey(r.timestamp);
    if (!countsByKey.has(key)) continue; // outside window
    countsByKey.set(key, (countsByKey.get(key) ?? 0) + 1);
    // FIX E (round-3): prefer the EXACT token counts when present. OpenRouter
    // rows carry exact `input_tokens`/`output_tokens` from the provider's usage
    // block but record empty `input_text`/`output_text` (payloads are never
    // persisted), so their `estimated_*` fields are 0 — totalling only the
    // estimated fields silently dropped every openrouter invocation to 0 and
    // under-reported `rea doctor --metrics`. Codex rows have no exact field, so
    // they fall back to the estimate (unchanged).
    const inTok =
      typeof r.input_tokens === 'number' && Number.isFinite(r.input_tokens)
        ? r.input_tokens
        : (r.estimated_input_tokens ?? 0);
    const outTok =
      typeof r.output_tokens === 'number' && Number.isFinite(r.output_tokens)
        ? r.output_tokens
        : (r.estimated_output_tokens ?? 0);
    totalTokens += inTok + outTok;
    if (r.rate_limited) rateLimitedCount += 1;
    durationSum += r.duration_ms ?? 0;
    inWindow += 1;
    if (typeof r.est_cost_usd === 'number' && Number.isFinite(r.est_cost_usd)) {
      const prov = typeof r.provider === 'string' && r.provider.length > 0 ? r.provider : 'codex';
      costByProvider.set(prov, (costByProvider.get(prov) ?? 0) + r.est_cost_usd);
    }
  }

  const invocations_per_day = bucketKeys.map((k) => countsByKey.get(k) ?? 0);
  const avg_latency_ms = inWindow === 0 ? 0 : durationSum / inWindow;

  const summary: TelemetrySummary = {
    window_days: days,
    invocations_per_day,
    total_estimated_tokens: totalTokens,
    rate_limited_count: rateLimitedCount,
    avg_latency_ms,
  };
  if (costByProvider.size > 0) {
    summary.est_cost_usd_by_provider = Object.fromEntries(costByProvider);
  }
  return summary;
}
