/**
 * Tests for the 0.29.0 delegation-capture hook registration in
 * `rea init` / `rea upgrade`.
 *
 * The settings-merge layer is the shared workhorse — `rea init`,
 * `rea upgrade`, and the dogfood `.claude/settings.json` template
 * all route through it. These tests pin:
 *
 *   - `defaultDesiredHooks()` lists the `Agent|Skill` matcher group
 *     with the delegation-capture.sh command.
 *   - The matcher is EXACTLY `Agent|Skill` (NOT `Task|Skill` — the
 *     `TaskCreate`/`TaskList` tools are unrelated todo-list surface
 *     and MUST NOT match).
 *   - A fresh merge populates the new entry alongside the existing
 *     Bash + Write|Edit|MultiEdit|NotebookEdit groups.
 *   - The merge is idempotent — a second invocation produces a
 *     byte-identical result (same invariant as the 0.21.1 fix).
 *   - Existing consumer customization on other matchers is preserved.
 */

import { describe, expect, it } from 'vitest';
import {
  mergeSettings,
  defaultDesiredHooks,
} from '../../src/cli/install/settings-merge.js';

interface MatcherGroup {
  matcher: string;
  hooks: Array<{ command: string; timeout?: number; statusMessage?: string }>;
}

function preToolUseGroups(settings: Record<string, unknown>): MatcherGroup[] {
  const hooks = settings.hooks as { PreToolUse?: MatcherGroup[] } | undefined;
  return hooks?.PreToolUse ?? [];
}

describe('defaultDesiredHooks — delegation-capture hook entry', () => {
  it('lists a PreToolUse group with matcher exactly `Agent|Skill`', () => {
    const groups = defaultDesiredHooks();
    const agentSkill = groups.find(
      (g) => g.event === 'PreToolUse' && g.matcher === 'Agent|Skill',
    );
    expect(agentSkill).toBeDefined();
  });

  it('matcher is NEVER `Task|Skill` (TaskCreate/TaskList are unrelated todo-list tools)', () => {
    const groups = defaultDesiredHooks();
    const wrong = groups.find((g) => g.matcher === 'Task|Skill');
    expect(wrong).toBeUndefined();
  });

  it('Agent|Skill group references delegation-capture.sh', () => {
    const groups = defaultDesiredHooks();
    const agentSkill = groups.find((g) => g.matcher === 'Agent|Skill')!;
    expect(agentSkill.hooks).toHaveLength(1);
    const h = agentSkill.hooks[0]!;
    expect(h.command).toContain('delegation-capture.sh');
    expect(h.type).toBe('command');
    // Timeout is short — the hook is observational and the CLI
    // subcommand backgrounds the audit append.
    expect(h.timeout).toBeDefined();
    expect(h.timeout!).toBeLessThanOrEqual(10_000);
  });
});

describe('mergeSettings — delegation-capture entry installation', () => {
  it('adds the Agent|Skill group on a fresh install', () => {
    const result = mergeSettings({}, defaultDesiredHooks());
    const groups = preToolUseGroups(result.merged);
    const matchers = groups.map((g) => g.matcher);
    expect(matchers).toContain('Agent|Skill');
  });

  it('is idempotent — a second merge skips the Agent|Skill entry without re-adding', () => {
    const first = mergeSettings({}, defaultDesiredHooks());
    const initialCount = preToolUseGroups(first.merged).filter(
      (g) => g.matcher === 'Agent|Skill',
    ).length;
    expect(initialCount).toBe(1);

    const second = mergeSettings(first.merged, defaultDesiredHooks());
    const secondCount = preToolUseGroups(second.merged).filter(
      (g) => g.matcher === 'Agent|Skill',
    ).length;
    expect(secondCount).toBe(1);
    // No new entries added the second time around.
    expect(JSON.stringify(second.merged)).toBe(JSON.stringify(first.merged));
  });

  it('preserves a consumer-authored Agent|Skill hook and chains the rea entry alongside it', () => {
    const consumer = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Agent|Skill',
            hooks: [{ type: 'command', command: '/consumer/track-delegations.sh' }],
          },
        ],
      },
    };
    const result = mergeSettings(consumer, defaultDesiredHooks());
    const agentSkill = preToolUseGroups(result.merged).find(
      (g) => g.matcher === 'Agent|Skill',
    )!;
    const cmds = agentSkill.hooks.map((h) => h.command);
    expect(cmds).toContain('/consumer/track-delegations.sh');
    expect(cmds.some((c) => c.includes('delegation-capture.sh'))).toBe(true);
  });

  it('preserves the existing Bash + Write|Edit|MultiEdit|NotebookEdit groups (no regression)', () => {
    const result = mergeSettings({}, defaultDesiredHooks());
    const matchers = preToolUseGroups(result.merged).map((g) => g.matcher);
    expect(matchers).toContain('Bash');
    expect(matchers).toContain('Write|Edit|MultiEdit|NotebookEdit');
    expect(matchers).toContain('Agent|Skill');
  });
});
