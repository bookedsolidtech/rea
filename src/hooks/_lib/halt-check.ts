/**
 * Shared HALT kill-switch reader for the Node-binary hook tier.
 *
 * 0.32.0 — extracted from `src/cli/hook.ts`. Pre-extraction the same
 * `.rea/HALT` reader inlined twice (`runHookScanBash` lines 204-222 and
 * `runHookCodexReview` lines 518-531) and `src/hooks/push-gate/halt.ts`
 * carried a third copy with slightly different error semantics (the
 * push-gate variant returns `{ halted: true, reason: 'unknown (HALT
 * file unreadable)' }` on filesystem errors instead of falling through
 * to allow). The Node-binary hook ports landing in 0.32.0 need the
 * same primitive, so consolidate here before more copies accumulate.
 *
 * Contract:
 *
 *   - Returns `{ halted: false }` when `<reaRoot>/.rea/HALT` is absent.
 *   - Returns `{ halted: true, reason }` when the file exists. `reason`
 *     is the first non-empty line trimmed and capped at 1024 bytes;
 *     missing/blank content collapses to `"Reason unknown"`.
 *   - Filesystem errors during the read collapse to a halted sentinel
 *     `"unknown (HALT file unreadable)"` — fail-CLOSED. The historical
 *     `runHookScanBash` inline copy fell through to allow on read
 *     failure; that is the wrong posture for a kill switch (an
 *     attacker who can prevent the read should not get a free allow).
 *     The push-gate's halt.ts already takes this stance; we converge.
 *   - NEVER throws.
 *
 * Used by:
 *   - `runHookScanBash`, `runHookCodexReview` (existing — migrated to
 *     this primitive in 0.32.0)
 *   - `runHookPrIssueLinkGate`, `runHookSecurityDisclosureGate`,
 *     `runHookAttributionAdvisory` (Phase 1 pilots, 0.32.0)
 *
 * Distinct from `src/hooks/push-gate/halt.ts`:
 *   - The push-gate's `readHalt` is part of the dependency-injected
 *     test seam (`PushGateDeps.readHalt`) and cannot be replaced
 *     wholesale without breaking the gate's existing contract.
 *   - Future-work item: thread `checkHalt` THROUGH the push-gate's
 *     `readHalt` default so a single primitive backs every consumer.
 *     Out of scope for 0.32.0 — the push-gate ships green and rotating
 *     it now would expand the diff without carrying its own bug fix.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveCommonRoot } from '../../lib/worktree-roots.js';

/**
 * Result of a HALT probe.
 *
 * Discriminated union so callers cannot accidentally read `reason` from
 * the not-halted case. The `halted: true` arm always carries a non-
 * empty `reason` — the reader manufactures a placeholder rather than
 * leaving the field undefined (the operator-facing stderr message
 * `REA HALT: <reason>` would render `undefined` otherwise).
 */
export type HaltState = { halted: true; reason: string } | { halted: false };

/**
 * Maximum bytes of the HALT file we consider when assembling the
 * `reason` line. Defends against a runaway-write scenario where
 * `.rea/HALT` is megabytes large — we always emit the reason on
 * stderr, and a multi-MB stderr blob can overwhelm a TTY before the
 * user sees the actual exit. 1 KiB is more than enough for a human-
 * authored kill-switch reason.
 */
const HALT_REASON_MAX_BYTES = 1024;

/**
 * Probe `<reaRoot>/.rea/HALT`. Pure function — does not write, log, or
 * mutate process state. Caller is responsible for the operator-facing
 * stderr emission and the exit code.
 *
 * @param reaRoot Absolute path to the project root that owns `.rea/`.
 *                Hooks resolve this from `$CLAUDE_PROJECT_DIR` or
 *                `process.cwd()` — callers should pre-resolve before
 *                invoking this primitive.
 * @returns `{ halted: false }` when the kill switch is clear, or
 *          `{ halted: true, reason }` with a non-empty reason string.
 */
export function checkHalt(reaRoot: string): HaltState {
  const haltPath = path.join(reaRoot, '.rea', 'HALT');
  if (!fs.existsSync(haltPath)) {
    return { halted: false };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(haltPath, 'utf8');
  } catch {
    // Fail-closed: the file exists (existsSync passed) but we cannot
    // read it. The operator intended to halt; a permissions glitch or
    // race that prevents the read should NOT translate into a free
    // allow. Surface a generic reason so the operator knows the file
    // was present even when its content was unreadable.
    return { halted: true, reason: 'unknown (HALT file unreadable)' };
  }
  // Cap at HALT_REASON_MAX_BYTES BEFORE splitting to bound the work.
  // The pre-0.32.0 inline copies sliced the entire file content first
  // and then trimmed; that is identical behavior for any reasonable
  // file size but differs unboundedly for pathological inputs.
  const slice = raw.length > HALT_REASON_MAX_BYTES ? raw.slice(0, HALT_REASON_MAX_BYTES) : raw;
  const firstNonEmpty = slice
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return {
    halted: true,
    reason: firstNonEmpty !== undefined && firstNonEmpty.length > 0 ? firstNonEmpty : 'Reason unknown',
  };
}

/**
 * Render the canonical operator-facing HALT banner. Pulled into a
 * helper so the 5 hook callers (`runHookScanBash`,
 * `runHookCodexReview`, and the 3 Phase 1 pilots) emit the same
 * stderr text byte-for-byte. Matches the historical inline string
 * exactly so existing consumer-side log parsers (if any) continue to
 * work.
 */
export function formatHaltBanner(reason: string): string {
  return `REA HALT: ${reason}\nAll agent operations suspended. Run: rea unfreeze\n`;
}

/**
 * Worktree-aware HALT probe (0.54.0): one kill switch per REPOSITORY.
 *
 * Tests the LOCAL root first (a legacy per-worktree HALT written before
 * this release must keep freezing that stream), then the COMMON root
 * (the primary checkout — where `rea freeze` and the automated reflexes
 * write from 0.54.0 on, so a freeze in one worktree stops every
 * stream). In a plain checkout the two roots coincide and the second
 * probe never runs — the degenerate path is byte-identical to
 * `checkHalt`.
 *
 * Callers that already resolved both roots pass `commonRoot` to skip
 * re-resolution; hook bodies that only carry a single root can call
 * with just `localRoot` and let this helper derive the common one.
 */
export function checkHaltRoots(localRoot: string, commonRoot?: string): HaltState {
  const local = checkHalt(localRoot);
  if (local.halted) return local;
  const common =
    commonRoot ?? resolveCommonRoot(localRoot, () => {}).commonRoot;
  if (path.resolve(common) === path.resolve(localRoot)) return local;
  return checkHalt(common);
}
