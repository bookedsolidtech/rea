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
function sanitize(input: string): string {
  return input.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

export function runFreeze(options: FreezeOptions): void {
  const reason = options.reason !== undefined ? sanitize(options.reason) : '';

  if (!reason) {
    err('`rea freeze` requires `--reason "..."`');
    console.error('');
    console.error('  Example: rea freeze --reason "security incident — pausing agent work"');
    console.error('');
    process.exit(1);
  }

  const targetDir = process.cwd();
  const reaDir = path.join(targetDir, REA_DIR);
  const haltFile = reaPath(targetDir, HALT_FILE);

  if (!fs.existsSync(reaDir)) {
    fs.mkdirSync(reaDir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const content = `${reason} (frozen at ${timestamp})\n`;
  fs.writeFileSync(haltFile, content, 'utf8');

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
