import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { HALT_FILE, REA_DIR, err, log, reaPath } from './utils.js';

export interface FreezeOptions {
  reason?: string | undefined;
}

export interface UnfreezeOptions {
  yes?: boolean | undefined;
}

/**
 * Strip control characters (terminal escape injection defense).
 */
export function sanitizeHaltReason(input: string): string {
  return input.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/**
 * Write `.rea/HALT` under `targetDir` with the canonical shape
 * (`<reason> (frozen at <ISO-timestamp>)\n`), creating `.rea/` if
 * needed. Returns the absolute path written.
 *
 * Extracted from `runFreeze` (0.51.0) so the automated billing→HALT
 * reflex (`billing-cap-halt` hook) writes byte-identical HALT files
 * without re-implementing the write path. The hook is the automated
 * analog of `rea freeze` — same file, same shape, same kill-switch that
 * every middleware + hook already respects.
 *
 * The caller is responsible for sanitizing `reason` (via
 * `sanitizeHaltReason`) if it is derived from untrusted input.
 */
export function writeHaltFile(targetDir: string, reason: string): string {
  const reaDir = path.join(targetDir, REA_DIR);
  if (!fs.existsSync(reaDir)) {
    fs.mkdirSync(reaDir, { recursive: true });
  }
  const haltFile = reaPath(targetDir, HALT_FILE);
  const timestamp = new Date().toISOString();
  const content = `${reason} (frozen at ${timestamp})\n`;
  fs.writeFileSync(haltFile, content, 'utf8');
  return haltFile;
}

export function runFreeze(options: FreezeOptions): void {
  const reason = options.reason !== undefined ? sanitizeHaltReason(options.reason) : '';

  if (!reason) {
    err('`rea freeze` requires `--reason "..."`');
    console.error('');
    console.error('  Example: rea freeze --reason "security incident — pausing agent work"');
    console.error('');
    process.exit(1);
  }

  const targetDir = process.cwd();
  writeHaltFile(targetDir, reason);

  console.log('');
  log('REA FROZEN');
  console.log(`       Reason: ${reason}`);
  console.log(`       File:   .rea/HALT`);
  console.log(`       Effect: all middleware + PreToolUse hooks will block agent operations.`);
  console.log('');
  console.log('       To resume: rea unfreeze');
  console.log('');
}

export async function runUnfreeze(options: UnfreezeOptions): Promise<void> {
  const targetDir = process.cwd();
  const haltFile = reaPath(targetDir, HALT_FILE);

  if (!fs.existsSync(haltFile)) {
    log('Not frozen — no .rea/HALT file found.');
    return;
  }

  const existingReason = fs.readFileSync(haltFile, 'utf8').trim();

  if (options.yes !== true) {
    const confirmed = await p.confirm({
      message: `Remove .rea/HALT and resume agent operations?\n    Current freeze: ${existingReason}`,
      initialValue: false,
    });

    if (p.isCancel(confirmed) || confirmed !== true) {
      log('Unfreeze cancelled — HALT remains in place.');
      return;
    }
  }

  fs.unlinkSync(haltFile);
  console.log('');
  log('REA UNFROZEN');
  console.log('       .rea/HALT removed — agent operations resumed.');
  console.log('');
}
