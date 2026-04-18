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
import { computeHash, GENESIS_HASH } from '../audit/fs.js';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';
import { AUDIT_FILE, REA_DIR, err, log, reaPath } from './utils.js';

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
 * Load a JSONL audit file as a record array + per-line raw text, so we can
 * re-hash against the exact serialization that was written. Throws on read
 * errors; returns an empty array for an empty file.
 */
async function loadRecords(
  filePath: string,
): Promise<{ records: AuditRecord[]; rawLines: string[] }> {
  const raw = await fs.readFile(filePath, 'utf8');
  // Drop a single trailing newline but preserve blank lines inside the file
  // so index numbers line up with real record positions.
  const trimmedTail = raw.replace(/\n$/, '');
  if (trimmedTail.length === 0) return { records: [], rawLines: [] };
  const rawLines = trimmedTail.split('\n');
  const records: AuditRecord[] = rawLines.map((line, i) => {
    try {
      return JSON.parse(line) as AuditRecord;
    } catch (e) {
      throw new Error(
        `Cannot parse JSON at ${path.basename(filePath)} line ${i + 1}: ${(e as Error).message}`,
      );
    }
  });
  return { records, rawLines };
}

interface VerifyFailure {
  file: string;
  lineIndex: number; // 0-based within the file
  reason: string;
  expected?: string;
  actual?: string;
}

function verifyChain(
  fileBasename: string,
  records: AuditRecord[],
  expectedStartPrev: string,
): VerifyFailure | null {
  let prev = expectedStartPrev;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.prev_hash !== prev) {
      return {
        file: fileBasename,
        lineIndex: i,
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
        lineIndex: i,
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

  let expectedPrev = GENESIS_HASH;
  let totalRecords = 0;
  for (const filePath of filesToVerify) {
    let records: AuditRecord[];
    try {
      ({ records } = await loadRecords(filePath));
    } catch (e) {
      err(`${(e as Error).message}`);
      process.exit(1);
    }

    const basename = path.basename(filePath);
    const failure = verifyChain(basename, records, expectedPrev);
    if (failure !== null) {
      err(`Audit chain TAMPER DETECTED in ${failure.file}`);
      console.error(`       Record index:  ${failure.lineIndex} (0-based within file)`);
      console.error(`       Reason:        ${failure.reason}`);
      if (failure.expected !== undefined) {
        console.error(`       Expected:      ${failure.expected}`);
      }
      if (failure.actual !== undefined) {
        console.error(`       Actual:        ${failure.actual}`);
      }
      process.exit(1);
    }

    // Advance the cross-file anchor for the next file.
    if (records.length > 0) {
      expectedPrev = records[records.length - 1]!.hash;
    }
    totalRecords += records.length;
  }

  log(
    `Audit chain verified: ${totalRecords} records across ${filesToVerify.length} file(s) — clean.`,
  );
}
