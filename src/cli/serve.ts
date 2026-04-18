import { loadPolicy } from '../policy/loader.js';
import { POLICY_FILE, err, exitWithMissingPolicy, log, reaPath } from './utils.js';

export async function runServe(): Promise<void> {
  const baseDir = process.cwd();
  const policyPath = reaPath(baseDir, POLICY_FILE);

  try {
    const policy = loadPolicy(baseDir);
    log(
      `MCP gateway not yet implemented — install complete, policy loaded (profile=${policy.profile}, autonomy=${policy.autonomy_level}).`,
    );
    process.exit(0);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('not found')) {
      exitWithMissingPolicy(policyPath);
    }
    err(`Failed to load policy: ${message}`);
    process.exit(1);
  }
}
