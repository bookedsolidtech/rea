/**
 * 0.31.0 — `delegation_advisory` policy schema tests.
 *
 * Covers `DelegationAdvisoryPolicySchema` in `src/policy/loader.ts`:
 *   - the block is `.optional()` — a vanilla install with no block
 *     loads clean and `policy.delegation_advisory` is undefined
 *   - when present, the inner schema supplies defaults: enabled=false,
 *     threshold=25, the 5-entry built-in exempt list
 *   - `threshold` must be a positive integer (0 / negative / float reject)
 *   - strict mode rejects unknown keys (`thresholds`, `exempt_subagent`)
 *   - the profile-layer schema (`ProfileSchema`) accepts a partial block
 *   - the shipped profiles carry the right `enabled` value:
 *       bst-internal* → true ; every external profile → false
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/loader.js';

const POLICY_HEADER = `version: "1"
profile: minimal
installed_by: test
installed_at: "2026-05-12T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths:
  - .env
notification_channel: ""
`;

async function writePolicy(dir: string, body: string): Promise<void> {
  const reaDir = path.join(dir, '.rea');
  await fs.mkdir(reaDir, { recursive: true });
  await fs.writeFile(path.join(reaDir, 'policy.yaml'), POLICY_HEADER + body);
}

describe('DelegationAdvisoryPolicy — schema + defaults', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-deleg-adv-policy-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('the block is optional — a policy with no delegation_advisory loads clean', async () => {
    await writePolicy(dir, '');
    const policy = loadPolicy(dir);
    expect(policy.delegation_advisory).toBeUndefined();
  });

  it('supplies all defaults when the block is present but only declares `enabled`', async () => {
    await writePolicy(dir, 'delegation_advisory:\n  enabled: true\n');
    const policy = loadPolicy(dir);
    expect(policy.delegation_advisory?.enabled).toBe(true);
    // threshold default is 25.
    expect(policy.delegation_advisory?.threshold).toBe(25);
    // exempt_subagents default is the 5-entry built-in helper list.
    expect(policy.delegation_advisory?.exempt_subagents).toEqual([
      'general-purpose',
      'Explore',
      'Plan',
      'output-style-setup',
      'statusline-setup',
    ]);
  });

  it('defaults `enabled` to false when the block declares only `threshold`', async () => {
    await writePolicy(dir, 'delegation_advisory:\n  threshold: 40\n');
    const policy = loadPolicy(dir);
    expect(policy.delegation_advisory?.enabled).toBe(false);
    expect(policy.delegation_advisory?.threshold).toBe(40);
  });

  it('accepts an explicit empty exempt_subagents list (exempt nothing)', async () => {
    await writePolicy(
      dir,
      'delegation_advisory:\n  enabled: true\n  threshold: 10\n  exempt_subagents: []\n',
    );
    const policy = loadPolicy(dir);
    expect(policy.delegation_advisory?.exempt_subagents).toEqual([]);
  });

  it('accepts a custom exempt_subagents list', async () => {
    await writePolicy(
      dir,
      'delegation_advisory:\n  enabled: true\n  exempt_subagents:\n    - my-helper\n    - another\n',
    );
    const policy = loadPolicy(dir);
    expect(policy.delegation_advisory?.exempt_subagents).toEqual(['my-helper', 'another']);
  });

  it('rejects threshold: 0 (must be a positive integer)', async () => {
    await writePolicy(dir, 'delegation_advisory:\n  enabled: true\n  threshold: 0\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('rejects a negative threshold', async () => {
    await writePolicy(dir, 'delegation_advisory:\n  enabled: true\n  threshold: -5\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('rejects a non-integer threshold', async () => {
    await writePolicy(dir, 'delegation_advisory:\n  enabled: true\n  threshold: 12.5\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('rejects an unknown key inside the block (strict mode)', async () => {
    // `thresholds` (plural typo) must fail loud, not silently drop.
    await writePolicy(dir, 'delegation_advisory:\n  enabled: true\n  thresholds: 25\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('rejects `exempt_subagent` (singular typo) — strict mode', async () => {
    await writePolicy(
      dir,
      'delegation_advisory:\n  enabled: true\n  exempt_subagent:\n    - x\n',
    );
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });
});

describe('DelegationAdvisoryPolicy — profile-layer schema', () => {
  it('the profile schema accepts a partial block (just `enabled`)', async () => {
    // The profile-layer schema mirrors the policy-loader schema but
    // leaves every field optional — a profile that only declares
    // `enabled` must validate without restating `threshold`.
    const { ProfileSchema } = await import('../../src/policy/profiles.js');
    const parsed = ProfileSchema.parse({ delegation_advisory: { enabled: true } });
    expect(parsed.delegation_advisory?.enabled).toBe(true);
    // No default applied at the profile layer — that happens when the
    // materialized policy file is parsed by the loader.
    expect(parsed.delegation_advisory?.threshold).toBeUndefined();
  });

  it('the profile schema rejects an unknown key in the block (strict)', async () => {
    const { ProfileSchema } = await import('../../src/policy/profiles.js');
    expect(() =>
      ProfileSchema.parse({ delegation_advisory: { enabled: true, bogus: 1 } }),
    ).toThrow();
  });
});

describe('DelegationAdvisoryPolicy — shipped profile defaults', () => {
  it('bst-internal* profiles ship enabled: true; external profiles ship enabled: false', async () => {
    const { loadProfile } = await import('../../src/policy/profiles.js');
    // BST's own delegation discipline is load-bearing — the nudge ships on.
    for (const name of ['bst-internal', 'bst-internal-no-codex']) {
      const profile = loadProfile(name);
      expect(profile).not.toBeNull();
      expect(profile?.delegation_advisory?.enabled).toBe(true);
    }
    // "You should delegate more" is an opinion not every external team
    // shares — OSS / consumer profiles ship the nudge off (opt-in
    // per-repo via .rea/policy.yaml).
    for (const name of [
      'open-source',
      'open-source-no-codex',
      'minimal',
      'client-engagement',
      'lit-wc',
    ]) {
      const profile = loadProfile(name);
      expect(profile).not.toBeNull();
      expect(profile?.delegation_advisory?.enabled).toBe(false);
    }
  });
});
