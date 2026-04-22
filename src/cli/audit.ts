/**
 * `rea audit` — operator-facing subcommands for the durability story (G1).
 *
 * Two verbs:
 *   - `rotate`                   force-rotate the current `.rea/audit.jsonl`.
 *   - `verify [--since <file>]`  re-hash the chain and exit 0 on clean, 1
 *                                naming the first tampered record.
 *
 * Neither command reads policy defaults for thresholds — force rotation is
 * explicit by definition, and verify operates on existing files regardless
 * of policy.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { forceRotate } from '../gateway/audit/rotator.js';
import {
  appendCodexReviewAuditRecord,
  type CodexVerdict,
} from '../audit/append.js';
import { computeHash, GENESIS_HASH } from '../audit/fs.js';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';
import { appendEntry as appendCacheEntry } from '../cache/review-cache.js';
import { AUDIT_FILE, REA_DIR, err, log, reaPath } from './utils.js';
import { Tier, InvocationStatus } from '../policy/types.js';
import { codexVerdictToCacheResult, type CodexVerdictCacheEffect } from './cache.js';

/**
 * Reserved for future rotate knobs (e.g. `--retain N` to prune old rotated
 * files). Empty today — kept as a typed record so the call site's option
 * object stays self-documenting.
 */
export type AuditRotateOptions = Record<string, never>;

export interface AuditVerifyOptions {
  /**
   * Optional rotated-file basename (e.g. `audit-20260418-193200.jsonl`).
   * When set, verification walks forward through all rotated files in
   * timestamp order starting at this one, then through the current
   * `audit.jsonl`. When unset, verification runs over the current file
   * only.
   */
  since?: string | undefined;
}

/**
 * `rea audit rotate`. Forces a rotation now regardless of thresholds.
 * Empty audit files are a no-op — rotating an empty chain would produce a
 * rotation marker with no meaningful predecessor.
 */
export async function runAuditRotate(_options: AuditRotateOptions): Promise<void> {
  const baseDir = process.cwd();
  const auditFile = reaPath(baseDir, AUDIT_FILE);

  let exists = true;
  try {
    const stat = await fs.stat(auditFile);
    if (!stat.isFile() || stat.size === 0) exists = false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      exists = false;
    } else {
      err(`Cannot stat ${auditFile}: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  if (!exists) {
    log('Audit log empty or missing — nothing to rotate.');
    console.log(`       File: ${path.relative(baseDir, auditFile)}`);
    return;
  }

  const result = await forceRotate(auditFile);
  if (!result.rotated) {
    log('Audit log empty — nothing to rotate.');
    return;
  }

  const rotated = result.rotatedTo!;
  log('Audit log rotated.');
  console.log(`       Rotated to: ${path.relative(baseDir, rotated)}`);
  console.log(`       Fresh file: ${path.relative(baseDir, auditFile)}`);
  console.log(`       A rotation marker anchors the new chain on the old tail's hash.`);
}

/**
 * A single unparseable-line failure. Distinct from a hash-chain failure —
 * defect T surfaces JSONL corruption as its own class so `rea audit verify`
 * can continue past it and still attempt chain verification over the
 * parseable subset, rather than aborting at the first malformed line.
 */
interface ParseFailure {
  file: string;
  /** 1-based line number within the file (matches editor / awk / jq output). */
  lineNumber: number;
  /** 1-based column of the parser's reported fault, if the error message names one. */
  column?: number | undefined;
  /** Underlying `JSON.parse` error message. */
  message: string;
}

/**
 * Best-effort column extractor. Node's JSON.parse error messages include a
 * `position N` that is a 0-based character offset into the parsed string.
 * When we parse a single JSONL line, that offset maps directly to a column.
 * Returns undefined when the position token is absent — the line number
 * alone is still useful.
 */
function extractColumnFromParserError(message: string): number | undefined {
  const m = /position (\d+)/.exec(message);
  if (m === null) return undefined;
  const n = Number.parseInt(m[1] ?? '', 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n + 1;
}

/**
 * Load a JSONL audit file as a record array + per-line raw text + a list of
 * per-line parse failures, so we can re-hash against the exact serialization
 * that was written AND report every malformed line in one pass (defect T).
 *
 * Unparseable lines are a DISTINCT failure class from hash-chain tampers:
 *
 *   - Malformed lines are collected into `parseFailures` and dropped from
 *     `records`. `rawLines` still contains the full original line array, so
 *     callers can cross-reference. `recordLineMap[i]` holds the 1-based file
 *     line number of `records[i]`.
 *   - The chain-verify pass runs only over the parseable subset. A caller
 *     that wants to report the verification result as partial checks
 *     `parseFailures.length > 0`.
 *
 * Throws only on read errors; returns an empty shape for an empty file.
 */
async function loadRecords(filePath: string): Promise<{
  records: AuditRecord[];
  /** 1-based line numbers for each entry in `records`. Same length as `records`. */
  recordLineMap: number[];
  rawLines: string[];
  parseFailures: ParseFailure[];
}> {
  const raw = await fs.readFile(filePath, 'utf8');
  // Drop a single trailing newline but preserve blank lines inside the file
  // so index numbers line up with real record positions.
  const trimmedTail = raw.replace(/\n$/, '');
  if (trimmedTail.length === 0) {
    return { records: [], recordLineMap: [], rawLines: [], parseFailures: [] };
  }
  const rawLines = trimmedTail.split('\n');
  const records: AuditRecord[] = [];
  const recordLineMap: number[] = [];
  const parseFailures: ParseFailure[] = [];
  const basename = path.basename(filePath);
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    // Empty lines mid-file are not records but also not parseable — JSON.parse('')
    // throws. Treat as a parse failure so verify surfaces them explicitly.
    try {
      const parsed = JSON.parse(line) as AuditRecord;
      records.push(parsed);
      recordLineMap.push(i + 1);
    } catch (e) {
      const msg = (e as Error).message;
      const col = extractColumnFromParserError(msg);
      parseFailures.push({
        file: basename,
        lineNumber: i + 1,
        ...(col !== undefined ? { column: col } : {}),
        message: msg,
      });
    }
  }
  return { records, recordLineMap, rawLines, parseFailures };
}

interface VerifyFailure {
  file: string;
  /** 0-based position within the parseable subset of this file. */
  recordIndex: number;
  /**
   * 1-based line number in the original file (survives parse-failure skips
   * via loadRecords.recordLineMap). Matches editor/awk/jq output directly.
   * Defect T: when a malformed line precedes the tampered record, recordIndex
   * and fileLineNumber diverge — operators need the latter to jq/grep to the
   * right place.
   */
  fileLineNumber: number;
  reason: string;
  expected?: string;
  actual?: string;
}

function verifyChain(
  fileBasename: string,
  records: AuditRecord[],
  recordLineMap: number[],
  expectedStartPrev: string,
): VerifyFailure | null {
  let prev = expectedStartPrev;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const fileLineNumber = recordLineMap[i] ?? i + 1;
    if (r.prev_hash !== prev) {
      return {
        file: fileBasename,
        recordIndex: i,
        fileLineNumber,
        reason: 'prev_hash does not match previous record',
        expected: prev,
        actual: r.prev_hash,
      };
    }
    // Recompute hash across the canonical serialization of the record
    // minus the `hash` field.
    const { hash, ...rest } = r;
    const recomputed = computeHash(rest);
    if (recomputed !== hash) {
      return {
        file: fileBasename,
        recordIndex: i,
        fileLineNumber,
        reason: 'stored hash does not match recomputed hash over record body',
        expected: recomputed,
        actual: hash,
      };
    }
    prev = hash;
  }
  return null;
}

/**
 * Find all rotated audit files in `reaDir`, in timestamp-ascending order.
 * Filenames follow `audit-YYYYMMDD-HHMMSS.jsonl` (with optional `-N` suffix
 * for intra-second collisions). Lexicographic sort handles both cases.
 */
async function listRotatedFiles(reaDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(reaDir);
  } catch {
    return [];
  }
  const rotated = entries.filter((n) => /^audit-\d{8}-\d{6}(-\d+)?\.jsonl$/.test(n));
  rotated.sort();
  return rotated;
}

/**
 * `rea audit verify [--since <rotated-file>]`. Exits 0 on clean chain, 1 on
 * first tampered record. All diagnostic output goes to stderr so the
 * exit code is the primary signal.
 */
export async function runAuditVerify(options: AuditVerifyOptions): Promise<void> {
  const baseDir = process.cwd();
  const reaDir = path.join(baseDir, REA_DIR);
  const currentAudit = path.join(reaDir, AUDIT_FILE);

  // Assemble the file walk.
  const filesToVerify: string[] = [];

  if (options.since !== undefined && options.since.length > 0) {
    const sinceName = path.basename(options.since);
    if (!/^audit-\d{8}-\d{6}(-\d+)?\.jsonl$/.test(sinceName)) {
      err(
        `--since must name a rotated audit file (audit-YYYYMMDD-HHMMSS.jsonl); got ${JSON.stringify(
          options.since,
        )}`,
      );
      process.exit(1);
    }
    const allRotated = await listRotatedFiles(reaDir);
    const startIdx = allRotated.indexOf(sinceName);
    if (startIdx === -1) {
      err(`Rotated file not found: ${path.join(REA_DIR, sinceName)}`);
      process.exit(1);
    }
    for (const name of allRotated.slice(startIdx)) {
      filesToVerify.push(path.join(reaDir, name));
    }
  }

  // The current audit.jsonl is ALWAYS the tail of the walk (unless it
  // doesn't exist — then the caller either asked for --since only or has
  // a fresh install).
  try {
    const stat = await fs.stat(currentAudit);
    if (stat.isFile()) filesToVerify.push(currentAudit);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      err(`Cannot stat ${currentAudit}: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  if (filesToVerify.length === 0) {
    err('No audit files to verify.');
    console.error(`       Expected: ${path.relative(baseDir, currentAudit)}`);
    process.exit(1);
  }

  // Defect T (0.10.2): collect-all-errors mode. We no longer abort at the
  // first unparseable line — `rea audit verify` now walks every file, lists
  // EVERY malformed line with its number + parser message, and attempts
  // chain verification over the parseable subset. Unparseable lines are a
  // distinct failure class from hash-chain tampers; both contribute to a
  // non-zero exit, but they are reported separately so an operator can tell
  // "JSONL corruption" from "someone edited a hash".
  let expectedPrev = GENESIS_HASH;
  let totalRecords = 0;
  const allParseFailures: ParseFailure[] = [];
  let chainFailure: VerifyFailure | null = null;
  let chainFailureFile: string | null = null;

  for (const filePath of filesToVerify) {
    let loaded: Awaited<ReturnType<typeof loadRecords>>;
    try {
      loaded = await loadRecords(filePath);
    } catch (e) {
      err(`${(e as Error).message}`);
      process.exit(1);
    }

    const { records, recordLineMap, parseFailures } = loaded;
    allParseFailures.push(...parseFailures);

    // Chain verify over the parseable subset only. If an earlier file had a
    // chain failure we stop verifying further files — advancing `expectedPrev`
    // past an unknown tail would produce misleading secondary failures.
    // recordLineMap threads the 1-based original-file line number through so
    // the failure diagnostic names the editor/jq position directly, not the
    // parseable-subset index which diverges from the file whenever a
    // malformed line precedes the tamper.
    if (chainFailure === null) {
      const failure = verifyChain(
        path.basename(filePath),
        records,
        recordLineMap,
        expectedPrev,
      );
      if (failure !== null) {
        chainFailure = failure;
        chainFailureFile = filePath;
      } else if (records.length > 0) {
        expectedPrev = records[records.length - 1]!.hash;
      }
    }

    totalRecords += records.length;
  }

  // Report parse failures first — they're independent of the chain result.
  if (allParseFailures.length > 0) {
    err(
      `Audit verify: ${allParseFailures.length} unparseable line(s) detected. ` +
        `Chain verification was performed over the parseable subset only.`,
    );
    for (const f of allParseFailures) {
      const loc =
        f.column !== undefined
          ? `${f.file}:${f.lineNumber}:${f.column}`
          : `${f.file}:${f.lineNumber}`;
      console.error(`       ${loc}  ${f.message}`);
    }
  }

  // Then report any chain failure found on the parseable subset.
  if (chainFailure !== null) {
    err(`Audit chain TAMPER DETECTED in ${chainFailure.file}`);
    // File-line-number is the operator-facing anchor — jump straight to the
    // offending line with `sed -n "${n}p" audit.jsonl` or editor:LINE. The
    // parseable-subset index is kept for audit-tooling consumers that walk
    // the records[] array.
    console.error(
      `       File line:     ${chainFailure.fileLineNumber} (1-based in ${chainFailure.file})`,
    );
    console.error(
      `       Record index:  ${chainFailure.recordIndex} (0-based within parseable subset)`,
    );
    console.error(`       Reason:        ${chainFailure.reason}`);
    if (chainFailure.expected !== undefined) {
      console.error(`       Expected:      ${chainFailure.expected}`);
    }
    if (chainFailure.actual !== undefined) {
      console.error(`       Actual:        ${chainFailure.actual}`);
    }
    if (chainFailureFile !== null) {
      console.error(`       File path:     ${path.relative(baseDir, chainFailureFile)}`);
    }
  }

  if (allParseFailures.length > 0 || chainFailure !== null) {
    process.exit(1);
  }

  log(
    `Audit chain verified: ${totalRecords} records across ${filesToVerify.length} file(s) — clean.`,
  );
}

export interface AuditRecordCodexReviewOptions {
  headSha: string;
  branch: string;
  target: string;
  verdict: CodexVerdict;
  findingCount: number;
  summary?: string | undefined;
  sessionId?: string | undefined;
  alsoSetCache?: boolean | undefined;
}

/**
 * `rea audit record codex-review` (Defect D / rea#77). Emits the single audit
 * event the push-review cache gate looks up by `tool_name == "codex.review"` +
 * `metadata.head_sha == <sha>` + `metadata.verdict in {pass, concerns}`. Prior
 * to this command, agents had to reverse-engineer the canonical `tool_name`
 * string, the hash-chain append path, and the `CodexReviewMetadata` shape —
 * the most common failure mode was emitting `tool_name: "codex-adversarial-review"`
 * (the agent's name) instead of `codex.review` (the event type), which the
 * gate's jq predicate silently missed.
 *
 * `--also-set-cache` performs the audit record AND the review-cache write
 * in one invocation — two sequential appends in a single process, not a
 * two-phase commit. A crash between them leaves the audit entry without
 * a cache row; the cache is recomputable from audit, the audit chain is
 * the source of truth. What this DOES eliminate is the two-step race where
 * `rea cache set` is denied by permission middleware (Defect E) after the
 * audit has already been emitted, leaving the gate stuck on "audit present
 * but cache cold" with no way forward.
 */
export async function runAuditRecordCodexReview(
  options: AuditRecordCodexReviewOptions,
): Promise<void> {
  if (options.headSha.length === 0) {
    err('--head-sha must not be empty');
    process.exit(1);
  }
  if (options.branch.length === 0) {
    err('--branch must not be empty');
    process.exit(1);
  }
  if (options.target.length === 0) {
    err('--target must not be empty');
    process.exit(1);
  }
  if (!Number.isFinite(options.findingCount) || options.findingCount < 0) {
    err(`--finding-count must be a non-negative integer; got ${options.findingCount}`);
    process.exit(1);
  }

  const baseDir = process.cwd();
  const metadata: Record<string, unknown> = {
    head_sha: options.headSha,
    target: options.target,
    finding_count: options.findingCount,
    verdict: options.verdict,
  };
  if (options.summary !== undefined && options.summary.length > 0) {
    metadata.summary = options.summary;
  }

  // Defect P: stamps emission_source: "rea-cli" so the record satisfies the
  // push-review gate's new integrity predicate. Legacy records (without
  // emission_source) and records written through the generic
  // appendAuditRecord() helper (emission_source: "other") are rejected.
  // tool_name/server_name are fixed inside the helper.
  await appendCodexReviewAuditRecord(baseDir, {
    tier: Tier.Read,
    status: InvocationStatus.Allowed,
    ...(options.sessionId !== undefined ? { session_id: options.sessionId } : {}),
    metadata,
  });

  log(
    `Recorded codex.review (${options.verdict}, ${options.findingCount} finding${
      options.findingCount === 1 ? '' : 's'
    }) for ${options.headSha.slice(0, 12)}.`,
  );

  if (options.alsoSetCache === true) {
    const effect: CodexVerdictCacheEffect = codexVerdictToCacheResult(options.verdict);
    const cacheEntry = await appendCacheEntry(baseDir, {
      sha: options.headSha,
      branch: options.branch,
      base: options.target,
      result: effect.result,
      ...(effect.reason !== undefined ? { reason: effect.reason } : {}),
    });
    log(
      `Cached ${cacheEntry.result} for ${cacheEntry.sha.slice(0, 12)} (${cacheEntry.branch} → ${cacheEntry.base}).`,
    );
  }
}
