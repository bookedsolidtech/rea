/**
 * Tests for `src/cli/roster.ts` (0.31.0) — live `.claude/agents/`
 * roster discovery + the `countsAsRealDelegation` predicate.
 *
 * The roster is discovered at read time (not a frozen constant) so the
 * delegation nudge knows what counts as a REAL curated-specialist
 * delegation versus a built-in Claude Code helper.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverRoster,
  countsAsRealDelegation,
  DEFAULT_EXEMPT_SUBAGENTS,
} from '../../src/cli/roster.js';

function mkTempBase(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-roster-')));
}

function writeAgent(baseDir: string, name: string): void {
  const agentsDir = path.join(baseDir, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, name), '# agent\n');
}

describe('discoverRoster — filesystem discovery', () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkTempBase();
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns discovered:false with an empty roster when .claude/agents/ is absent', () => {
    const r = discoverRoster(baseDir);
    expect(r.discovered).toBe(false);
    expect(r.roster).toEqual([]);
    expect(r.agentsDir).toContain(path.join('.claude', 'agents'));
  });

  it('discovers every *.md basename, sorted', () => {
    writeAgent(baseDir, 'rea-orchestrator.md');
    writeAgent(baseDir, 'code-reviewer.md');
    writeAgent(baseDir, 'backend-engineer.md');
    const r = discoverRoster(baseDir);
    expect(r.discovered).toBe(true);
    expect(r.roster).toEqual(['backend-engineer', 'code-reviewer', 'rea-orchestrator']);
  });

  it('skips non-.md files (READMEs, dotfiles, editor swap files)', () => {
    writeAgent(baseDir, 'rea-orchestrator.md');
    const agentsDir = path.join(baseDir, '.claude', 'agents');
    fs.writeFileSync(path.join(agentsDir, 'README.txt'), 'not an agent\n');
    fs.writeFileSync(path.join(agentsDir, '.DS_Store'), '');
    fs.writeFileSync(path.join(agentsDir, 'code-reviewer.md.swp'), 'vim swap\n');
    const r = discoverRoster(baseDir);
    expect(r.roster).toEqual(['rea-orchestrator']);
  });

  it('skips subdirectories even when named `foo.md`', () => {
    writeAgent(baseDir, 'real-agent.md');
    fs.mkdirSync(path.join(baseDir, '.claude', 'agents', 'decoy.md'), { recursive: true });
    const r = discoverRoster(baseDir);
    expect(r.roster).toEqual(['real-agent']);
  });

  it('matches the .md extension case-insensitively', () => {
    writeAgent(baseDir, 'upper-case.MD');
    const r = discoverRoster(baseDir);
    expect(r.roster).toEqual(['upper-case']);
  });

  it('skips a bare `.md` file (empty basename)', () => {
    writeAgent(baseDir, 'real.md');
    fs.writeFileSync(path.join(baseDir, '.claude', 'agents', '.md'), '');
    const r = discoverRoster(baseDir);
    expect(r.roster).toEqual(['real']);
  });
});

describe('countsAsRealDelegation — the nudge-suppression predicate', () => {
  const discoveredRoster = {
    roster: ['rea-orchestrator', 'code-reviewer', 'backend-engineer'],
    agentsDir: '/x/.claude/agents',
    discovered: true,
  };
  const undiscoveredRoster = {
    roster: [],
    agentsDir: '/x/.claude/agents',
    discovered: false,
  };

  it('a Skill signal ALWAYS counts as real delegation', () => {
    // There is no "built-in skill" exemption — every Skill invocation
    // is a real delegation. Even a skill name not in any roster counts.
    expect(
      countsAsRealDelegation({
        delegationTool: 'Skill',
        subagentType: 'deep-dive',
        roster: discoveredRoster,
        exempt: DEFAULT_EXEMPT_SUBAGENTS,
      }),
    ).toBe(true);
    expect(
      countsAsRealDelegation({
        delegationTool: 'Skill',
        subagentType: 'some-unknown-skill',
        roster: undiscoveredRoster,
        exempt: DEFAULT_EXEMPT_SUBAGENTS,
      }),
    ).toBe(true);
  });

  it('an Agent signal to a built-in helper does NOT count (exempt)', () => {
    for (const helper of DEFAULT_EXEMPT_SUBAGENTS) {
      expect(
        countsAsRealDelegation({
          delegationTool: 'Agent',
          subagentType: helper,
          roster: discoveredRoster,
          exempt: DEFAULT_EXEMPT_SUBAGENTS,
        }),
      ).toBe(false);
    }
  });

  it('an Agent signal to a discovered curated specialist counts', () => {
    expect(
      countsAsRealDelegation({
        delegationTool: 'Agent',
        subagentType: 'rea-orchestrator',
        roster: discoveredRoster,
        exempt: DEFAULT_EXEMPT_SUBAGENTS,
      }),
    ).toBe(true);
  });

  it('an Agent signal to a name NOT in the discovered roster does NOT count', () => {
    // The roster WAS discovered and this name is not in it — so it is
    // not a curated specialist. (e.g. a typo'd subagent_type, or a
    // built-in helper not in the exempt list.)
    expect(
      countsAsRealDelegation({
        delegationTool: 'Agent',
        subagentType: 'not-a-real-agent',
        roster: discoveredRoster,
        exempt: DEFAULT_EXEMPT_SUBAGENTS,
      }),
    ).toBe(false);
  });

  it('falls back to non-exempt-name-counts when the roster is undiscovered', () => {
    // .claude/agents/ absent — we cannot verify, so a non-exempt Agent
    // name is the best signal we have. Count it (a false negative is
    // less corrosive than a false-positive nudge).
    expect(
      countsAsRealDelegation({
        delegationTool: 'Agent',
        subagentType: 'whatever-specialist',
        roster: undiscoveredRoster,
        exempt: DEFAULT_EXEMPT_SUBAGENTS,
      }),
    ).toBe(true);
    // ...but an exempt name still does not count, even undiscovered.
    expect(
      countsAsRealDelegation({
        delegationTool: 'Agent',
        subagentType: 'general-purpose',
        roster: undiscoveredRoster,
        exempt: DEFAULT_EXEMPT_SUBAGENTS,
      }),
    ).toBe(false);
  });

  it('honors a custom exempt list (an explicit empty list exempts nothing)', () => {
    // Operator set exempt_subagents: [] — now even general-purpose
    // counts (as long as it is in the roster, or roster undiscovered).
    expect(
      countsAsRealDelegation({
        delegationTool: 'Agent',
        subagentType: 'general-purpose',
        roster: undiscoveredRoster,
        exempt: [],
      }),
    ).toBe(true);
  });

  it('exempt comparison is case-sensitive', () => {
    // `Explore` is exempt; `explore` (lowercase) is not — a curated
    // agent could plausibly be lowercase, and case-folding would risk
    // wrongly exempting it.
    expect(
      countsAsRealDelegation({
        delegationTool: 'Agent',
        subagentType: 'explore',
        roster: undiscoveredRoster,
        exempt: DEFAULT_EXEMPT_SUBAGENTS,
      }),
    ).toBe(true);
  });
});
