/**
 * Live `.claude/agents/` roster discovery (0.31.0+).
 *
 * 0.29.0 shipped the delegation-telemetry observability layer. 0.31.0
 * closes the loop with the *nudge* — and the nudge needs to know what
 * counts as a "real" specialist delegation versus a built-in helper.
 *
 * # Why discovery, not a hardcoded list
 *
 * `src/cli/doctor.ts` already carries an `EXPECTED_AGENTS` constant,
 * but it is a deliberately-frozen 10-entry subset — the minimum roster
 * `rea init` guarantees, pinned so a regression that drops a curated
 * agent from the install manifest trips a doctor failure. It is NOT
 * the live roster: this repo ships 23 agents, consumers add their own,
 * and the curated set grows release over release. Keying the
 * delegation nudge off `EXPECTED_AGENTS` would mean a session that
 * delegated exclusively to `principal-engineer` and `data-architect`
 * (both real, curated, neither in the frozen subset) still got nudged
 * — exactly the false positive that erodes trust in an advisory.
 *
 * So the roster is discovered at read time: every `*.md` file under
 * `<baseDir>/.claude/agents/` is a curated specialist. The basename
 * (sans `.md`) is the `subagent_type` Claude Code's `Agent` tool
 * reports, so the mapping is direct.
 *
 * # The exempt set
 *
 * Claude Code ships built-in helpers — `general-purpose`, `Explore`,
 * `Plan`, `output-style-setup`, `statusline-setup` — that are dispatched
 * through the same `Agent` tool but are NOT curated specialists. A
 * session that only ever delegated to those has not actually routed
 * work to the engineering team. The exempt set is policy-configurable
 * (`policy.delegation_advisory.exempt_subagents`) with a 5-entry
 * built-in default; this module takes the resolved list as an argument
 * rather than reading policy itself, so it stays a pure filesystem
 * helper with no policy-loader dependency.
 *
 * # Skills
 *
 * The `Skill` delegation tool is intentionally NOT roster-gated. A
 * skill invocation (`deep-dive`, `due-diligence`, …) is always a real
 * delegation signal — there is no "built-in skill" equivalent of
 * `general-purpose`. The advisory's "did this session delegate"
 * predicate counts every `Skill` signal and every non-exempt `Agent`
 * signal whose `subagent_type` is in the discovered roster.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Default exempt subagent names — Claude Code's built-in helper agents
 * that are dispatched through the `Agent` tool but are not curated
 * specialists. Mirrors the schema-layer default in
 * `DelegationAdvisoryPolicySchema` (`src/policy/loader.ts`). Exported
 * so callers that have no policy in scope (the bash-hook fallback
 * path) can still apply the same filter.
 */
export const DEFAULT_EXEMPT_SUBAGENTS: readonly string[] = [
  'general-purpose',
  'Explore',
  'Plan',
  'output-style-setup',
  'statusline-setup',
];

export interface RosterDiscoveryResult {
  /**
   * Sorted list of discovered curated-specialist names — the basename
   * (sans `.md`) of every file under `.claude/agents/`. Empty when the
   * directory is absent or unreadable.
   */
  roster: string[];
  /**
   * Absolute path actually scanned. Returned for diagnostics — doctor
   * surfaces it, the `rea hook` subcommand echoes it in `--json` mode.
   */
  agentsDir: string;
  /**
   * `true` when `.claude/agents/` exists and was read. `false` when it
   * is absent or a read error occurred — callers treat that as "no
   * roster, every Agent delegation is non-exempt-but-also-unverifiable"
   * and fall back to the exempt-list-only filter.
   */
  discovered: boolean;
}

/**
 * Discover the curated-specialist roster by listing `*.md` files under
 * `<baseDir>/.claude/agents/`. Pure filesystem read — never throws; an
 * absent or unreadable directory yields `discovered: false` with an
 * empty roster.
 *
 * The `.md` extension match is case-insensitive (`.MD` on a
 * case-preserving-but-insensitive filesystem still counts) and the
 * basename is taken verbatim — `rea-orchestrator.md` →
 * `rea-orchestrator`. Subdirectories and non-`.md` files (READMEs,
 * `.DS_Store`, editor swap files) are skipped.
 */
export function discoverRoster(baseDir: string): RosterDiscoveryResult {
  const agentsDir = path.join(baseDir, '.claude', 'agents');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    // ENOENT (no .claude/agents/), ENOTDIR, EACCES — all collapse to
    // "no roster discovered". The caller falls back to the exempt-list
    // filter alone.
    return { roster: [], agentsDir, discovered: false };
  }
  const roster: string[] = [];
  for (const entry of entries) {
    // Only regular files. A directory named `foo.md` is not an agent.
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.toLowerCase().endsWith('.md')) continue;
    const base = name.slice(0, name.length - 3);
    if (base.length === 0) continue;
    roster.push(base);
  }
  roster.sort();
  return { roster, agentsDir, discovered: true };
}

/**
 * The delegation-nudge predicate, factored out so the CLI subcommand,
 * the `audit specialists` reader, and the doctor smoke check all apply
 * identical logic.
 *
 * Returns `true` when the given `(delegation_tool, subagent_type)` pair
 * counts as a REAL delegation — i.e. the kind that should suppress the
 * advisory nudge:
 *
 *   - `Skill` → always counts. There is no "built-in skill" exemption.
 *   - `Agent` → counts when the `subagent_type` is NOT in `exempt` AND
 *     (the roster was discovered AND contains the name, OR the roster
 *     was NOT discovered — in which case we cannot verify and fall
 *     back to "non-exempt name counts"). The non-discovered fallback
 *     is deliberately permissive: a consumer who deleted
 *     `.claude/agents/` has bigger problems than a missed nudge, and a
 *     false negative (no nudge when one was due) is far less corrosive
 *     than a false positive.
 *
 * `exempt` comparison is case-sensitive — the built-in helper names
 * (`Explore`, `Plan`) are capitalized and the curated specialists are
 * kebab-case, so there is no realistic collision, and a case-folded
 * compare would risk a curated `Plan-something` agent being wrongly
 * exempted.
 */
export function countsAsRealDelegation(args: {
  delegationTool: 'Agent' | 'Skill';
  subagentType: string;
  roster: RosterDiscoveryResult;
  exempt: readonly string[];
}): boolean {
  if (args.delegationTool === 'Skill') return true;
  // Agent path.
  if (args.exempt.includes(args.subagentType)) return false;
  if (!args.roster.discovered) {
    // Roster unverifiable — a non-exempt Agent name is the best signal
    // we have. Count it.
    return true;
  }
  return args.roster.roster.includes(args.subagentType);
}
