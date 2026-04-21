import { AutonomyLevel, InvocationStatus, Tier } from '../../policy/types.js';
import { classifyTool, isToolBlocked, reaCommandTier } from '../../config/tier-map.js';
import { loadPolicyAsync } from '../../policy/loader.js';
import type { Policy } from '../../policy/types.js';
import type { GatewayConfig } from '../../config/types.js';
import type { Middleware } from './chain.js';

const BASH_DISPLAY_MAX_LEN = 80;

/** Extract the `rea <subcommand>` head from a Bash command string for display
 * in deny messages. Returns `null` when the command is not a rea invocation. */
function extractReaSubcommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0) return null;
  const first = tokens[0];
  if (first === undefined) return null;
  let idx = 0;
  if (first === 'npx' && tokens.length >= 2 && (tokens[1] === 'rea' || tokens[1] === '@bookedsolid/rea')) {
    idx = 2;
  } else if (first === 'rea' || first.endsWith('/rea')) {
    idx = 1;
  } else {
    return null;
  }
  const sub = tokens[idx];
  if (sub === undefined) return 'rea';
  const sub2 = tokens[idx + 1];
  if (sub2 !== undefined && /^[a-z][a-z-]*$/.test(sub2)) {
    return `rea ${sub} ${sub2}`;
  }
  return `rea ${sub}`;
}

/** Build a readable `Bash: <head>` display string for deny messages. Caller
 * is responsible for only invoking this for tool_name === 'Bash'. Uses
 * JSON.stringify to escape hostile characters (newlines, control chars). */
function formatBashDisplay(command: string, reaDisplay: string | null): string {
  if (reaDisplay !== null) {
    return `Bash (${reaDisplay})`;
  }
  const trimmed = command.trim();
  const truncated =
    trimmed.length > BASH_DISPLAY_MAX_LEN
      ? `${trimmed.slice(0, BASH_DISPLAY_MAX_LEN - 1)}…`
      : trimmed;
  return `Bash (${JSON.stringify(truncated)})`;
}

/**
 * Autonomy level tier permissions:
 * - L0: Read only
 * - L1: Read + Write (no destructive)
 * - L2: Read + Write (no destructive)
 * - L3: All tiers allowed
 */
const TIER_ALLOWED: Record<AutonomyLevel, Set<Tier>> = {
  [AutonomyLevel.L0]: new Set([Tier.Read]),
  [AutonomyLevel.L1]: new Set([Tier.Read, Tier.Write]),
  [AutonomyLevel.L2]: new Set([Tier.Read, Tier.Write]),
  [AutonomyLevel.L3]: new Set([Tier.Read, Tier.Write, Tier.Destructive]),
};

/**
 * Checks autonomy level against tool tier, and checks blocked tools.
 *
 * SECURITY: Re-reads policy.yaml on every invocation so autonomy level changes
 * take effect immediately without gateway restart.
 * SECURITY: Re-derives tier from tool_name independently — never trusts ctx.tier.
 * SECURITY: Undefined/unknown tier defaults to DENY (fail-closed).
 */
export function createPolicyMiddleware(
  initialPolicy: Policy,
  gatewayConfig?: GatewayConfig,
  baseDir?: string,
): Middleware {
  // SECURITY: Cache last successfully parsed policy for fallback.
  // This prevents falling back to a potentially more permissive initial policy
  // if the file is corrupted after a stricter policy was loaded.
  let lastGoodPolicy = initialPolicy;

  return async (ctx, next) => {
    // SECURITY: Re-read policy on each invocation for live autonomy changes.
    // Falls back to last successfully parsed policy on read failure.
    let policy = lastGoodPolicy;
    if (baseDir) {
      try {
        policy = await loadPolicyAsync(baseDir);
        lastGoodPolicy = policy; // Cache successful parse
      } catch {
        // Fail-safe: use last successfully parsed policy if re-read fails
      }
    }

    // Check if tool is explicitly blocked
    if (isToolBlocked(ctx.tool_name, ctx.server_name, gatewayConfig)) {
      ctx.status = InvocationStatus.Denied;
      ctx.error = `Tool "${ctx.tool_name}" is explicitly blocked in gateway config`;
      return;
    }

    // SECURITY: Re-derive tier from tool_name — do NOT trust ctx.tier from prior middleware.
    // This prevents a rogue middleware from downgrading a destructive tool to read-tier.
    let tier = classifyTool(ctx.tool_name, ctx.server_name, gatewayConfig);

    // Defect E (rea#78): when the invocation is a `Bash` call whose command
    // parses as `rea <subcommand>`, classify by subcommand instead of the
    // generic `Write` Bash default. REA's own CLI must not be denied by REA's
    // own middleware at the autonomy level the gate's remediation text
    // targets. Returns null on non-rea commands so the generic tier stands.
    let reaSubcommandDisplay: string | null = null;
    if (ctx.tool_name === 'Bash') {
      const command = ctx.arguments['command'];
      if (typeof command === 'string') {
        const subTier = reaCommandTier(command);
        if (subTier !== null) {
          tier = subTier;
          reaSubcommandDisplay = extractReaSubcommand(command);
        }
      }
    }

    ctx.tier = tier; // Overwrite with authoritative classification

    // Validate autonomy level is known
    const allowed = TIER_ALLOWED[policy.autonomy_level];
    if (!allowed) {
      ctx.status = InvocationStatus.Denied;
      ctx.error = `Unknown autonomy level: ${policy.autonomy_level}. Denying by default.`;
      return;
    }

    // Check autonomy level vs tier (fail-closed: deny if tier unknown)
    if (!allowed.has(tier)) {
      ctx.status = InvocationStatus.Denied;
      // Defect E composition: when the denial is a Bash invocation, include
      // the command head so the deny-reason is actionable. `Bash` alone tells
      // the operator nothing about WHICH shell command tripped the gate.
      const toolDisplay =
        ctx.tool_name === 'Bash' && typeof ctx.arguments['command'] === 'string'
          ? formatBashDisplay(ctx.arguments['command'] as string, reaSubcommandDisplay)
          : ctx.tool_name;
      ctx.error = `Autonomy level ${policy.autonomy_level} does not allow ${tier}-tier tools. Tool: ${toolDisplay}`;
      ctx.metadata['reason_code'] = 'tier_exceeds_autonomy';
      return;
    }

    // Store current autonomy level in metadata for audit middleware
    ctx.metadata.autonomy_level = policy.autonomy_level;

    await next();
  };
}
