import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mergeSettings,
  defaultDesiredHooks,
  writeSettingsAtomic,
  type DesiredHookGroup,
} from './settings-merge.js';

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

describe('writeSettingsAtomic — cross-platform rename (finding #8)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-settings-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a new settings.json when none exists', async () => {
    const target = path.join(dir, '.claude', 'settings.json');
    await writeSettingsAtomic(target, { hooks: { PreToolUse: [] } });
    const written = await fs.readFile(target, 'utf8');
    expect(JSON.parse(written)).toEqual({ hooks: { PreToolUse: [] } });
    // Tmp file must not be left behind.
    await expect(fs.stat(`${target}.tmp`)).rejects.toThrow();
  });

  it('overwrites an existing settings.json (POSIX atomic-replace semantics)', async () => {
    const target = path.join(dir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{"stale":true}\n', 'utf8');

    await writeSettingsAtomic(target, { fresh: true });
    const written = await fs.readFile(target, 'utf8');
    expect(JSON.parse(written)).toEqual({ fresh: true });
    await expect(fs.stat(`${target}.tmp`)).rejects.toThrow();
  });

  it('recovers when rename reports EEXIST (Windows rename-does-not-replace behavior)', async () => {
    // We can't monkey-patch the ESM namespace of `node:fs/promises` — its
    // properties are read-only on import. Vitest's `vi.spyOn` takes a
    // different path (defineProperty on the module record) and does work
    // here. Simulate the Windows rename-EEXIST on the first attempt; the
    // fallback unlink + retry should succeed on the second.
    const target = path.join(dir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{"stale":true}\n', 'utf8');

    const originalRename = fs.rename;
    let calls = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      calls += 1;
      if (calls === 1 && typeof newPath === 'string' && newPath.endsWith('settings.json')) {
        const e = new Error('simulated EEXIST') as NodeJS.ErrnoException;
        e.code = 'EEXIST';
        throw e;
      }
      return originalRename(oldPath, newPath);
    });

    try {
      await writeSettingsAtomic(target, { fresh: true });
    } finally {
      spy.mockRestore();
    }

    // First call threw (simulated Windows), second call succeeded.
    expect(calls).toBeGreaterThanOrEqual(2);
    const written = await fs.readFile(target, 'utf8');
    expect(JSON.parse(written)).toEqual({ fresh: true });
    await expect(fs.stat(`${target}.tmp`)).rejects.toThrow();
  });
});
