import { Tier } from '../policy/types.js';
import type { GatewayConfig } from './types.js';

/** Numeric severity for tier comparison — higher = more dangerous. */
const TIER_SEVERITY: Record<Tier, number> = {
  [Tier.Read]: 0,
  [Tier.Write]: 1,
  [Tier.Destructive]: 2,
};

/**
 * Static tier classifications for known tool patterns.
 * Tools not in this map default to Tier.Write (safe default).
 */
const STATIC_TIER_MAP: Record<string, Tier> = {
  // Read-tier tools (safe, no side effects)
  get_messages: Tier.Read,
  get_channel: Tier.Read,
  get_guild: Tier.Read,
  get_member: Tier.Read,
  get_webhook: Tier.Read,
  list_channels: Tier.Read,
  list_guilds: Tier.Read,
  list_members: Tier.Read,
  list_roles: Tier.Read,
  list_threads: Tier.Read,
  list_webhooks: Tier.Read,
  list_projects: Tier.Read,
  search_messages: Tier.Read,
  query_audit_log: Tier.Read,
  health_check: Tier.Read,

  // Write-tier tools (create or modify)
  send_message: Tier.Write,
  send_embed: Tier.Write,
  edit_message: Tier.Write,
  add_reaction: Tier.Write,
  create_thread: Tier.Write,
  create_channel: Tier.Write,
  create_role: Tier.Write,
  create_invite: Tier.Write,
  create_webhook: Tier.Write,
  execute_webhook: Tier.Write,
  edit_channel: Tier.Write,
  edit_role: Tier.Write,
  edit_webhook: Tier.Write,
  set_slowmode: Tier.Write,
  set_permissions: Tier.Write,
  assign_role: Tier.Write,
  move_channel: Tier.Write,
  archive_thread: Tier.Write,
  timeout_member: Tier.Write,

  // Destructive-tier tools (irreversible or high-impact)
  delete_message: Tier.Destructive,
  delete_channel: Tier.Destructive,
  delete_role: Tier.Destructive,
  delete_webhook: Tier.Destructive,
  purge_messages: Tier.Destructive,
  ban_member: Tier.Destructive,
  unban_member: Tier.Destructive,
  kick_member: Tier.Destructive,
};

/**
 * Derive the base tier for a tool using the static map and naming conventions.
 * This is the "floor" — overrides cannot go below this.
 */
function deriveBaseTier(baseName: string): Tier {
  // Check static map first
  if (STATIC_TIER_MAP[baseName]) {
    return STATIC_TIER_MAP[baseName];
  }

  // Convention-based classification for tools not in the static map.
  // This allows non-Discord downstream servers to get sensible defaults.
  if (
    /^(get_|list_|search_|query_|read_|fetch_|check_|health_|describe_|show_|count_)/.test(baseName)
  ) {
    return Tier.Read;
  }
  if (/^(delete_|drop_|purge_|remove_|destroy_|ban_|kick_|revoke_|truncate_)/.test(baseName)) {
    return Tier.Destructive;
  }

  // Default: Write (fail-safe — requires at least L1)
  return Tier.Write;
}

/**
 * Classify a tool by its tier. Checks gateway config overrides first,
 * then static map, then naming conventions, then defaults to Write.
 */
export function classifyTool(
  toolName: string,
  serverName: string,
  gatewayConfig?: GatewayConfig,
): Tier {
  // Strip server prefix for base lookup (e.g., "discord-ops__send_message" -> "send_message")
  const baseName = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
  const baseTier = deriveBaseTier(baseName);

  // Check per-server overrides in gateway config
  const serverConfig = gatewayConfig?.servers[serverName];
  const override = serverConfig?.tool_overrides?.[toolName];
  if (override?.tier) {
    const overrideTier = override.tier;

    // SECURITY: Prevent tier downgrades — overrides cannot lower a tool below its base tier.
    if (TIER_SEVERITY[overrideTier] < TIER_SEVERITY[baseTier]) {
      console.error(
        `[rea] WARNING: tool_override for "${toolName}" attempted to downgrade tier from ${baseTier} to ${overrideTier} — ignoring override`,
      );
      return baseTier;
    }
    return overrideTier;
  }

  return baseTier;
}

/**
 * Check if a tool is explicitly blocked in gateway config.
 */
export function isToolBlocked(
  toolName: string,
  serverName: string,
  gatewayConfig?: GatewayConfig,
): boolean {
  const serverConfig = gatewayConfig?.servers[serverName];
  const override = serverConfig?.tool_overrides?.[toolName];
  return override?.blocked === true;
}

/**
 * Classify a `rea <subcommand>` Bash invocation by its own semantics rather
 * than the generic Bash default.
 *
 * Defect E (rea#78): REA's own governance CLI must not be denied by REA's own
 * middleware. The gate's error messages literally say "Run `rea cache set
 * <sha> pass --branch <x> --base <y>`" — then the agent is denied at autonomy
 * L1 because `Bash` is classified Write and the downstream middleware can't
 * see that the Write is just appending a line to `.rea/review-cache.jsonl`.
 *
 * This helper returns the tier appropriate to the rea subcommand when the
 * command parses as `rea <sub>` or `npx rea <sub>`. Returns `null` if the
 * command is not a rea invocation — callers then fall back to the generic
 * Bash tier.
 *
 * Tier mapping:
 *   - Read:        `cache check|list|get`, `audit verify`,
 *                  `audit record codex-review`, `check`, `doctor`, `status`
 *   - Write:       `cache set|clear`, `audit rotate`, `init`,
 *                  `serve`, `upgrade`, `unfreeze`
 *   - Destructive: `freeze` (writes `.rea/HALT`, suspends the session)
 *
 * `audit record codex-review` is Read-tier because it is REA's own append-only
 * audit surface — the whole point of the command is to let an L1 agent satisfy
 * the push-review gate without a human in the loop. Write-tier here would
 * reintroduce exactly the deadlock Defect D/E close.
 *
 * SECURITY: returns `null` for any command containing shell metacharacters
 * that would let an attacker piggyback arbitrary commands onto an allowed
 * prefix (e.g. `rea check && rm -rf ~`). Bash tokenizes on whitespace, but
 * the shell itself dispatches the full command string — token[0] matching
 * is not a sufficient trust decision. Falling back to `null` forces the
 * generic Write-tier Bash default, which is what the operator expects for
 * any command they did not explicitly model here.
 */
const REA_SHELL_METACHAR_RE = /[;&|`\n\r]|\$\(|>\(|<\(/;

/**
 * Path suffixes recognized as trusted `rea` CLI entry points when the first
 * token is a file-path invocation like `./node_modules/.bin/rea`. Arbitrary
 * `evil-rea`-ending names should NOT satisfy the subcommand classification.
 */
const REA_TRUSTED_PATH_SUFFIXES = [
  '/node_modules/.bin/rea',
  '/dist/cli/index.js',
  '/bin/rea',
  '/.bin/rea',
];

function isTrustedReaPath(first: string): boolean {
  if (first === 'rea') return true;
  for (const suffix of REA_TRUSTED_PATH_SUFFIXES) {
    if (first === suffix || first.endsWith(suffix)) return true;
  }
  return false;
}

export function reaCommandTier(command: string): Tier | null {
  if (typeof command !== 'string' || command.length === 0) return null;

  // Refuse to classify commands that chain/substitute — the trailing shell
  // payload is arbitrary, so the prefix's read-tier status tells us nothing
  // about what the shell will actually execute.
  if (REA_SHELL_METACHAR_RE.test(command)) return null;

  const trimmed = command.trim();
  if (trimmed.length === 0) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return null;
  const first = tokens[0];
  if (first === undefined) return null;

  let idx = 0;
  if (first === 'npx') {
    if (tokens.length < 2) return null;
    const second = tokens[1];
    if (second !== 'rea' && second !== '@bookedsolid/rea') return null;
    idx = 2;
  } else if (isTrustedReaPath(first)) {
    idx = 1;
  } else {
    return null;
  }

  const sub = tokens[idx];
  if (sub === undefined) {
    return Tier.Read;
  }
  const sub2 = tokens[idx + 1];

  switch (sub) {
    case 'check':
    case 'doctor':
    case 'status':
      return Tier.Read;
    case 'cache': {
      if (sub2 === 'check' || sub2 === 'list' || sub2 === 'get') return Tier.Read;
      if (sub2 === 'set' || sub2 === 'clear') return Tier.Write;
      return Tier.Write;
    }
    case 'audit': {
      if (sub2 === 'verify') return Tier.Read;
      if (sub2 === 'record') return Tier.Read;
      if (sub2 === 'rotate') return Tier.Write;
      return Tier.Write;
    }
    case 'init':
    case 'serve':
    case 'upgrade':
    case 'unfreeze':
      return Tier.Write;
    case 'freeze':
      return Tier.Destructive;
    default:
      return Tier.Write;
  }
}
