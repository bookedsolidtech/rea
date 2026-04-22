/**
 * Protected-path detection. Given a `git diff --name-status` output blob,
 * return true iff any change touches one of the prefixes in
 * `PROTECTED_PATH_PREFIXES`.
 *
 * ## Why this is a dedicated module
 *
 * The bash core uses `awk -v re='^(src/gateway/...)' '{...}'` inline in
 * the main gate loop (push-review-core.sh:904-923). That regex is
 * duplicated in `.husky/pre-push` (the native-git shim) and in at least
 * two places in THREAT_MODEL.md. A single TS helper with a grep-able
 * constant in `constants.ts` removes the drift risk.
 *
 * ## Input shape
 *
 * `git diff --name-status <merge_base>..<local_sha>` output. Each line is:
 *   <STATUS>\t<path1>[\t<path2>]
 * STATUS is one letter, possibly followed by a similarity score for
 * rename/copy (`R100`, `C95`). STATUS letters we care about: A, C, D, M,
 * R, T, U — the bash core's `status !~ /^[ACDMRTU]/` filter. We match
 * that exactly.
 */

import { PROTECTED_PATH_PREFIXES } from './constants.js';

/** Set of single-letter status codes the gate cares about. */
const RELEVANT_STATUS = new Set(['A', 'C', 'D', 'M', 'R', 'T', 'U']);

/**
 * Parse a single `git diff --name-status` line and extract the paths that
 * matter for protected-path detection. Rename (`R`) and copy (`C`) lines
 * carry two paths separated by tabs; both are checked against the
 * protected-path set.
 *
 * Returns an empty array for irrelevant status letters or malformed lines.
 */
export function extractPathsFromStatusLine(line: string): string[] {
  if (line.length === 0) return [];
  const parts = line.split('\t');
  if (parts.length < 2) return [];
  const status = parts[0] ?? '';
  if (status.length === 0) return [];
  const statusLetter = status[0];
  if (statusLetter === undefined || !RELEVANT_STATUS.has(statusLetter)) {
    return [];
  }
  return parts.slice(1).filter((p) => p.length > 0);
}

/**
 * True iff `path` starts with one of the protected-path prefixes. Exported
 * for unit tests; callers should usually use `diffTouchesProtectedPaths`.
 */
export function isProtectedPath(filePath: string): boolean {
  for (const prefix of PROTECTED_PATH_PREFIXES) {
    if (filePath.startsWith(prefix)) return true;
    // A bare `.rea` or `hooks` path (no trailing slash) is a directory
    // boundary match — `.rea/audit.jsonl` passes, `my-rea.config` does
    // not. startsWith on the prefix-with-slash enforces that naturally.
  }
  return false;
}

/**
 * True iff the given `git diff --name-status` output contains at least
 * one protected-path hit. Returns the set of hit paths (deduped) for
 * audit-record metadata.
 */
export interface ProtectedPathScanResult {
  hit: boolean;
  paths: string[];
}

export function scanNameStatusForProtectedPaths(nameStatusOutput: string): ProtectedPathScanResult {
  if (nameStatusOutput.length === 0) {
    return { hit: false, paths: [] };
  }
  const hits = new Set<string>();
  for (const line of nameStatusOutput.split('\n')) {
    const paths = extractPathsFromStatusLine(line);
    for (const p of paths) {
      if (isProtectedPath(p)) hits.add(p);
    }
  }
  return { hit: hits.size > 0, paths: Array.from(hits).sort() };
}
