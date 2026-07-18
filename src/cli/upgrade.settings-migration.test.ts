/**
 * codex round-35 F1 — `rea upgrade` matcher-move migration for
 * `billing-cap-halt.sh` (`PostToolUse/Bash` → `PostToolUse/*`, round-24).
 *
 * `mergeSettings` is additive-only, so a repo upgrading from a release that
 * registered billing-cap-halt under `Bash` would keep that registration AND
 * gain the new `*` one → the hook fires TWICE on every Bash tool call (turn
 * counter double-increments; billing warns/HALTs duplicate). The migration
 * prunes the stale `Bash` registration so exactly ONE (`*`) remains.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { runUpgrade } from './upgrade.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-upgrade-migrate-')));
}

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ command?: string }>;
}

async function readPostToolUse(dir: string): Promise<HookGroup[]> {
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  const s = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
    hooks?: { PostToolUse?: HookGroup[] };
  };
  return s.hooks?.PostToolUse ?? [];
}

/** Every (matcher) a billing-cap-halt.sh hook is registered under. */
function billingMatchers(groups: HookGroup[]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (typeof h.command === 'string' && h.command.includes('billing-cap-halt.sh')) {
        out.push(g.matcher ?? '');
      }
    }
  }
  return out;
}

describe('rea upgrade — billing-cap-halt matcher-move migration (round-35 F1)', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });
  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function scaffold(): Promise<string> {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    return dir;
  }

  /** Rewrite the fresh install's `*` billing group back to the OLD `Bash`
   *  shape, simulating a pre-round-24 (0.53.x) install. */
  async function downgradeToBashRegistration(dir: string): Promise<void> {
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const s = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
      hooks: { PostToolUse: HookGroup[] };
    };
    for (const g of s.hooks.PostToolUse) {
      const isBilling = (g.hooks ?? []).some((h) => (h.command ?? '').includes('billing-cap-halt.sh'));
      if (isBilling && g.matcher === '*') g.matcher = 'Bash';
    }
    await fs.writeFile(settingsPath, JSON.stringify(s, null, 2), 'utf8');
  }

  it('prunes the stale PostToolUse/Bash registration → billing-cap-halt.sh ONLY under `*` (no double)', async () => {
    const dir = await scaffold();
    await downgradeToBashRegistration(dir);
    // Sanity: the simulated OLD install has billing under `Bash`, not `*`.
    expect(billingMatchers(await readPostToolUse(dir))).toEqual(['Bash']);

    await runUpgrade({ yes: true });

    // Exactly one billing-cap-halt.sh registration, under `*`.
    expect(billingMatchers(await readPostToolUse(dir))).toEqual(['*']);
  });

  it('is idempotent — a second upgrade keeps exactly one `*` registration', async () => {
    const dir = await scaffold();
    await downgradeToBashRegistration(dir);
    await runUpgrade({ yes: true });
    await runUpgrade({ yes: true });
    expect(billingMatchers(await readPostToolUse(dir))).toEqual(['*']);
  });

  it('fresh install is unaffected — upgrade keeps the single `*` registration', async () => {
    const dir = await scaffold();
    // Fresh init already registers billing under `*` only.
    expect(billingMatchers(await readPostToolUse(dir))).toEqual(['*']);
    await runUpgrade({ yes: true });
    expect(billingMatchers(await readPostToolUse(dir))).toEqual(['*']);
  });

  it('preserves a consumer hook chained onto the same Bash matcher (entry-level prune)', async () => {
    const dir = await scaffold();
    await downgradeToBashRegistration(dir);
    // Consumer chained their own hook onto the Bash billing group.
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const s = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
      hooks: { PostToolUse: HookGroup[] };
    };
    const bashBilling = s.hooks.PostToolUse.find(
      (g) => g.matcher === 'Bash' && (g.hooks ?? []).some((h) => (h.command ?? '').includes('billing-cap-halt.sh')),
    );
    bashBilling?.hooks?.push({
      type: 'command',
      command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/consumer-thing.sh',
    } as never);
    await fs.writeFile(settingsPath, JSON.stringify(s, null, 2), 'utf8');

    await runUpgrade({ yes: true });

    const groups = await readPostToolUse(dir);
    // billing moved to `*` only …
    expect(billingMatchers(groups)).toEqual(['*']);
    // … and the consumer's hook is still under Bash (group not clobbered).
    const consumerStillThere = groups.some(
      (g) => g.matcher === 'Bash' && (g.hooks ?? []).some((h) => (h.command ?? '').includes('consumer-thing.sh')),
    );
    expect(consumerStillThere).toBe(true);
  });
});
