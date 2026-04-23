/**
 * HALT kill-switch reader for the push-gate.
 *
 * The push-gate is a pure composition (see `./index.ts`). `readHalt()` is the
 * only side-effectful probe that must run before policy is even consulted —
 * HALT overrides every other signal, including `review.codex_required: false`.
 *
 * `.rea/HALT` is a short plain-text file. Content is not structured — the
 * first non-empty line is the "reason" we surface to the operator. Absence
 * of the file means "not halted"; presence means "block every gated
 * operation until `rea unfreeze`".
 */

import fs from 'node:fs';
import path from 'node:path';

export interface HaltState {
  halted: boolean;
  /** Present only when `halted === true`. Trimmed first line. */
  reason?: string;
}

/**
 * Read `.rea/HALT` from `baseDir`. Never throws — filesystem errors collapse
 * to `{ halted: false }` so a corrupted read does not silently block the
 * operator. The fail-closed posture lives in the caller (`runPushGate`) when
 * the gate is asked to assess HALT and cannot.
 *
 * We explicitly do NOT reuse `src/cli/freeze.ts`'s reader — that one prompts
 * via clack for unfreeze confirmation. The hook path must stay dependency-
 * free and deterministic.
 */
export function readHalt(baseDir: string): HaltState {
  const p = path.join(baseDir, '.rea', 'HALT');
  if (!fs.existsSync(p)) {
    return { halted: false };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    // Unreadable HALT file is treated as "halted with unknown reason" — the
    // file exists, so the operator intended to halt; we just can't read the
    // message. Surfacing a generic reason preserves the kill-switch
    // semantics without silently passing.
    return { halted: true, reason: 'unknown (HALT file unreadable)' };
  }
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return {
    halted: true,
    reason: firstLine !== undefined && firstLine.length > 0 ? firstLine : 'unknown',
  };
}
