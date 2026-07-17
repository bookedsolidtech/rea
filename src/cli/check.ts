import fs from 'node:fs';
import { loadPolicy } from '../policy/loader.js';
import { resolveReaRoots } from '../lib/worktree-roots.js';
import {
  AUDIT_FILE,
  HALT_FILE,
  POLICY_FILE,
  err,
  exitWithMissingPolicy,
  log,
  reaPath,
} from './utils.js';

const AUDIT_TAIL_LINES = 5;

function readLastLines(filePath: string, n: number): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter((line) => line.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

export function runCheck(): void {
  // 0.54.0 worktree state: policy is per-worktree (checked in); the
  // HALT probe covers both roots (repo-wide kill switch); the audit
  // chain lives at the common root. Degenerate in plain checkouts.
  const { localRoot: baseDir, commonRoot } = resolveReaRoots(process.cwd());
  const policyPath = reaPath(baseDir, POLICY_FILE);
  const localHaltPath = reaPath(baseDir, HALT_FILE);
  const haltPath = fs.existsSync(localHaltPath) ? localHaltPath : reaPath(commonRoot, HALT_FILE);
  const auditPath = reaPath(commonRoot, AUDIT_FILE);

  if (!fs.existsSync(policyPath)) {
    exitWithMissingPolicy(policyPath);
  }

  let policy;
  try {
    policy = loadPolicy(baseDir);
  } catch (e) {
    err(`Failed to parse policy: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  console.log('');
  log(`Status — ${baseDir}`);
  console.log('');
  console.log(`  Profile:              ${policy.profile}`);
  console.log(`  Autonomy level:       ${policy.autonomy_level}`);
  console.log(`  Max autonomy:         ${policy.max_autonomy_level}`);
  console.log(`  Block AI attribution: ${policy.block_ai_attribution ? 'yes' : 'no'}`);
  console.log(`  Blocked paths:        ${policy.blocked_paths.length} entries`);

  if (fs.existsSync(haltPath)) {
    const reason = fs.readFileSync(haltPath, 'utf8').trim();
    console.log('');
    console.log('  HALT: ACTIVE');
    console.log(`        ${reason}`);
    console.log('        Run `rea unfreeze` to resume.');
  } else {
    console.log(`  HALT:                 inactive`);
  }

  console.log('');
  if (fs.existsSync(auditPath)) {
    const tail = readLastLines(auditPath, AUDIT_TAIL_LINES);
    if (tail.length === 0) {
      console.log(`  Audit log:            .rea/audit.jsonl (empty)`);
    } else {
      console.log(`  Audit log:            last ${tail.length} entries (.rea/audit.jsonl)`);
      for (const entry of tail) {
        console.log(`    ${entry.slice(0, 160)}${entry.length > 160 ? '…' : ''}`);
      }
    }
  } else {
    console.log(`  Audit log:            not yet written`);
  }
  console.log('');
}
