/**
 * Audit-record emission + consumption for the review gate.
 *
 * ## Responsibilities
 *
 * 1. Emit `push.review.skipped` and `codex.review.skipped` records via the
 *    existing `appendAuditRecord()` helper. These are NEVER forgeable-
 *    verdict records (the push-review gate never consults them as Codex
 *    receipts), so they intentionally go through the `"other"`-stamped
 *    public path rather than the `"rea-cli"` dedicated writer.
 *
 * 2. Scan `.rea/audit.jsonl` for a qualifying `codex.review` receipt
 *    certifying a given `head_sha`. This is the TS equivalent of the
 *    bash core's `jq -R 'fromjson? | select(...)'` predicate
 *    (push-review-core.sh §959-966).
 *
 * ## Defect carry-forwards
 *
 * - **Defect P** (forgery rejection). The scan filter requires
 *   `emission_source ∈ {"rea-cli", "codex-cli"}`. The public
 *   `appendAuditRecord()` helper stamps `"other"`; only the dedicated
 *   `appendCodexReviewAuditRecord()` helper and the Codex CLI write
 *   `"rea-cli"` / `"codex-cli"`. Records with `emission_source: "other"`
 *   or missing the field entirely are rejected here.
 *
 * - **Defect U** (streaming-parse tolerance). Every line in `.rea/
 *   audit.jsonl` is parsed independently in a try/catch. A single
 *   corrupt line mid-file does NOT abort the scan — later lines still
 *   get a chance. Before 0.10.2 the bash `jq -e` scan would bail on the
 *   first unparseable line and miss every subsequent legitimate record.
 *
 * - **Verdict whitelist**. Only `verdict ∈ {"pass", "concerns"}` records
 *   satisfy the protected-path gate. `blocking` and `error` verdicts are
 *   receipts that a review HAPPENED but with a negative outcome, which
 *   does NOT unblock the push. Mirrors push-review-core.sh §964.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  appendAuditRecord,
  type AppendAuditInput,
  type AuditRecord,
  InvocationStatus,
  Tier,
} from '../../audit/append.js';
import { collectOsIdentity, type OsIdentity } from './metadata.js';

/** Tool-names the gate emits. Kept as constants so string-literal drift is caught at compile time. */
export const PUSH_REVIEW_SKIPPED_TOOL = 'push.review.skipped';
export const CODEX_REVIEW_SKIPPED_TOOL = 'codex.review.skipped';
export const PUSH_REVIEW_CACHE_HIT_TOOL = 'push.review.cache.hit';
export const PUSH_REVIEW_CACHE_ERROR_TOOL = 'push.review.cache.error';

/** Server-names for the emit paths — carry forward from bash §473/§639. */
export const ESCAPE_HATCH_SERVER = 'rea.escape_hatch';
export const PUSH_REVIEW_SERVER = 'rea.push_review';

/**
 * Input shape for the `REA_SKIP_PUSH_REVIEW` escape hatch's audit record.
 *
 * The `os_identity` field is captured inside this module (not by the
 * caller) so every emitter gets the same shape and failing fields degrade
 * to empty strings uniformly. The pid/ppid numeric-not-string invariant
 * (defect M) is enforced by `metadata.ts`.
 */
export interface SkipPushReviewAuditInput {
  /** Repo root (the dir containing `.rea/`). */
  baseDir: string;
  /** `HEAD` SHA at the time of the skip. */
  head_sha: string;
  /** Current branch or empty string. */
  branch: string;
  /** The non-empty value of `REA_SKIP_PUSH_REVIEW` (the reason). */
  reason: string;
  /** The resolved git actor (email, then name, else empty). */
  actor: string;
  /**
   * OS-identity fields. Optional — when absent, `collectOsIdentity()` runs
   * and fills them. Tests inject a deterministic stub for snapshot stability.
   */
  os_identity?: OsIdentity;
}

/**
 * Emit the `push.review.skipped` audit record. Wraps the public
 * `appendAuditRecord()` helper — emission_source lands as `"other"`.
 *
 * The skipped record is intentionally NOT a `codex.review` receipt: the
 * push-review cache-gate scan rejects any record whose `tool_name` is not
 * `codex.review` AND any record whose `emission_source` is not
 * `rea-cli` / `codex-cli`. So this record is on the hash chain as
 * forensic evidence but cannot be confused with a real Codex review.
 */
export async function emitPushReviewSkipped(
  input: SkipPushReviewAuditInput,
): Promise<AuditRecord> {
  const osIdentity = input.os_identity ?? collectOsIdentity();
  const metadata: Record<string, unknown> = {
    head_sha: input.head_sha,
    branch: input.branch,
    reason: input.reason,
    actor: input.actor,
    verdict: 'skipped',
    os_identity: osIdentity,
  };
  const record: AppendAuditInput = {
    tool_name: PUSH_REVIEW_SKIPPED_TOOL,
    server_name: ESCAPE_HATCH_SERVER,
    status: InvocationStatus.Allowed,
    tier: Tier.Read,
    metadata,
  };
  return appendAuditRecord(input.baseDir, record);
}

/**
 * Input shape for the `REA_SKIP_CODEX_REVIEW` (Codex-only) waiver.
 *
 * `metadata_source` records whether the skip metadata came from the
 * pre-push stdin (`"prepush-stdin"`) or from a local HEAD fallback
 * (`"local-fallback"`). Bash-core §594+§606.
 */
export interface SkipCodexReviewAuditInput {
  baseDir: string;
  head_sha: string;
  target: string;
  reason: string;
  actor: string;
  metadata_source: 'prepush-stdin' | 'local-fallback';
}

export async function emitCodexReviewSkipped(
  input: SkipCodexReviewAuditInput,
): Promise<AuditRecord> {
  const metadata: Record<string, unknown> = {
    head_sha: input.head_sha,
    target: input.target,
    reason: input.reason,
    actor: input.actor,
    verdict: 'skipped',
    files_changed: null,
    metadata_source: input.metadata_source,
  };
  const record: AppendAuditInput = {
    tool_name: CODEX_REVIEW_SKIPPED_TOOL,
    server_name: ESCAPE_HATCH_SERVER,
    status: InvocationStatus.Allowed,
    tier: Tier.Read,
    metadata,
  };
  return appendAuditRecord(input.baseDir, record);
}

/** Verdicts that satisfy the protected-path Codex-receipt gate. */
const ACCEPTABLE_VERDICTS = new Set(['pass', 'concerns']);

/** Emission sources that satisfy the protected-path Codex-receipt gate. */
const ACCEPTABLE_SOURCES = new Set(['rea-cli', 'codex-cli']);

/**
 * The minimal record shape the scan inspects. Keep this decoupled from the
 * full `AuditRecord` type so a partial / legacy record (missing
 * `emission_source`) is still type-safely rejected.
 */
interface ScannableCodexReviewRecord {
  tool_name?: unknown;
  emission_source?: unknown;
  metadata?: {
    head_sha?: unknown;
    verdict?: unknown;
    // Other metadata fields exist but are irrelevant to the predicate.
  };
}

/**
 * Predicate: does this parsed JSON object qualify as a valid
 * `codex.review` receipt for the given `head_sha`?
 *
 * Exported for unit tests; callers should usually use
 * `hasValidCodexReview()` below.
 */
export function isQualifyingCodexReview(record: unknown, head_sha: string): boolean {
  if (record === null || typeof record !== 'object') return false;
  const r = record as ScannableCodexReviewRecord;
  if (r.tool_name !== 'codex.review') return false;
  if (typeof r.emission_source !== 'string' || !ACCEPTABLE_SOURCES.has(r.emission_source)) {
    return false;
  }
  const md = r.metadata;
  if (md === null || md === undefined || typeof md !== 'object') return false;
  if (md.head_sha !== head_sha) return false;
  if (typeof md.verdict !== 'string' || !ACCEPTABLE_VERDICTS.has(md.verdict)) {
    return false;
  }
  return true;
}

/**
 * Scan `.rea/audit.jsonl` for a qualifying `codex.review` record matching
 * the given `head_sha`. Returns true as soon as one is found.
 *
 * ## Defect U tolerance
 *
 * Each line is parsed independently via `JSON.parse` inside try/catch. A
 * malformed line logs nothing and the scan continues. The bash fix in
 * 0.10.2 was `jq -R 'fromjson?'`; we mirror the per-line behavior in
 * native JS.
 *
 * ## Path safety
 *
 * The audit file is always `<baseDir>/.rea/audit.jsonl` — baseDir flows
 * in from the caller and is the same resolved path used everywhere else.
 * No caller-supplied path segments.
 *
 * ## Missing file
 *
 * ENOENT resolves to `false` (no receipt exists yet). Any other error
 * propagates — the caller's policy is to fail-closed, and a permission
 * error on the audit file is a distinct operational concern the caller
 * should surface rather than silently mask as "no receipt".
 */
export async function hasValidCodexReview(
  baseDir: string,
  head_sha: string,
): Promise<boolean> {
  const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
  let raw: string;
  try {
    raw = await fs.readFile(auditFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (raw.length === 0) return false;

  // Walk lines. Each line is independently parsed; a corrupt line is
  // silently skipped. A matching record short-circuits the scan.
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Defect U tolerance — move on.
      continue;
    }
    if (isQualifyingCodexReview(parsed, head_sha)) return true;
  }
  return false;
}
