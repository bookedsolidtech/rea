import { describe, expect, it } from 'vitest';
import { mergeSettings, defaultDesiredHooks, type DesiredHookGroup } from './settings-merge.js';

describe('mergeSettings', () => {
  it('adds all hooks into an empty settings file without chaining warnings', () => {
    const result = mergeSettings({}, defaultDesiredHooks());
    const preHooks = ((result.merged.hooks as { PreToolUse?: Array<{ matcher: string }> }).PreToolUse) ?? [];
    const matchers = preHooks.map((g) => g.matcher);
    expect(matchers).toContain('Bash');
    expect(matchers).toContain('Write|Edit');
    expect(result.addedCount).toBeGreaterThan(0);
    expect(result.skippedCount).toBe(0);
    // No "chained new command" warnings: on a fresh install, every matcher
    // group is novel and should be added cleanly.
    expect(result.warnings.some((w) => w.includes('chained new command'))).toBe(false);
  });

  it('is idempotent — a second merge skips everything', () => {
    const first = mergeSettings({}, defaultDesiredHooks());
    const second = mergeSettings(first.merged, defaultDesiredHooks());
    expect(second.addedCount).toBe(0);
    expect(second.skippedCount).toBeGreaterThan(0);
  });

  it('preserves existing consumer hooks on novel matchers', () => {
    const consumer = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/consumer/own.sh' }],
          },
        ],
      },
    };
    const result = mergeSettings(consumer, defaultDesiredHooks());
    const bashGroup = (result.merged.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> })
      .PreToolUse.find((g) => g.matcher === 'Bash')!;
    const commands = bashGroup.hooks.map((h) => h.command);
    expect(commands).toContain('/consumer/own.sh');
    expect(commands.some((c) => c.includes('dangerous-bash-interceptor.sh'))).toBe(true);
  });

  it('warns when chaining onto an existing matcher', () => {
    const consumer = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/consumer/own.sh' }] },
        ],
      },
    };
    const result = mergeSettings(consumer, defaultDesiredHooks());
    expect(result.warnings.some((w) => w.includes('chained'))).toBe(true);
  });

  it('adds novel matcher without warning when no existing matcher is touched', () => {
    const desired: DesiredHookGroup[] = [
      {
        event: 'Notification',
        matcher: 'custom',
        hooks: [{ type: 'command', command: '/new/hook.sh' }],
      },
    ];
    const result = mergeSettings({}, desired);
    expect(result.warnings.some((w) => w.includes('added novel matcher "custom"'))).toBe(true);
    expect(result.addedCount).toBe(1);
  });
});
