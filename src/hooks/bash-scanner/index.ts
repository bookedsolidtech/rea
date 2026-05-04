/**
 * `src/hooks/bash-scanner/` — parser-backed bash-tier scanner. Replaces
 * the regex-and-segmenter pipeline at `hooks/_lib/cmd-segments.sh` +
 * `hooks/_lib/interpreter-scanner.sh` with an AST-driven walker.
 *
 * Public surface:
 *
 *   - `runProtectedScan(ctx, cmd)`   — protected-paths gate
 *   - `runBlockedScan(ctx, cmd)`     — blocked_paths gate
 *
 * Both return a `Verdict` (allow|block + reason). The CLI subcommand
 * `rea hook scan-bash` consumes the verdict and translates to exit
 * codes for the bash shims.
 */

import { parseBashCommand } from './parser.js';
import { walkForWrites } from './walker.js';
import { scanForProtectedViolations, type ProtectedScanContext } from './protected-scan.js';
import { scanForBlockedViolations, type BlockedScanContext } from './blocked-scan.js';
import { buildParseFailureVerdict } from './parse-fail-closed.js';
import type { Verdict } from './verdict.js';

export type { Verdict, DetectedForm, SourcePosition } from './verdict.js';
export type { DetectedWrite } from './walker.js';
export type { ProtectedScanContext } from './protected-scan.js';
export type { BlockedScanContext } from './blocked-scan.js';
export { allowVerdict, blockVerdict, parseFailureVerdict } from './verdict.js';

/**
 * Run the protected-paths scanner against a bash command string.
 *
 * Empty / whitespace-only commands are an immediate allow (the bash
 * gate's `[[ -z "$CMD" ]] && exit 0` guard).
 *
 * Parse failures BLOCK — see `parse-fail-closed.ts` for the contract
 * rationale. The bash gates pre-0.23.0 silently allowed on segmenter
 * failure; the rewrite closes that bug class definitionally.
 */
export function runProtectedScan(ctx: ProtectedScanContext, cmd: string): Verdict {
  if (cmd.trim().length === 0) {
    return { verdict: 'allow' };
  }
  const parsed = parseBashCommand(cmd);
  if (!parsed.ok) {
    return buildParseFailureVerdict({ parserMessage: parsed.error, originalCommand: cmd });
  }
  const detections = walkForWrites(parsed.file);
  return scanForProtectedViolations(ctx, detections);
}

/**
 * Run the blocked_paths scanner against a bash command string. Identical
 * structure to runProtectedScan; the policy data shape differs.
 *
 * Empty blockedPaths list → allow (matches the bash gate's no-op
 * exit-0 behavior when policy.blocked_paths is empty).
 */
export function runBlockedScan(ctx: BlockedScanContext, cmd: string): Verdict {
  if (cmd.trim().length === 0) {
    return { verdict: 'allow' };
  }
  if (ctx.blockedPaths.length === 0) {
    return { verdict: 'allow' };
  }
  const parsed = parseBashCommand(cmd);
  if (!parsed.ok) {
    return buildParseFailureVerdict({ parserMessage: parsed.error, originalCommand: cmd });
  }
  const detections = walkForWrites(parsed.file);
  return scanForBlockedViolations(ctx, detections);
}
