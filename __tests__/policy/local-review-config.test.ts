/**
 * Tests for the 0.26.0 `policy.review.local_review` + `policy.commit_hygiene`
 * schema additions.
 *
 * The fields are FULLY optional — every existing 0.25.x policy.yaml must
 * load unchanged. The new fields, when present, must validate strictly so
 * a typo (`mode: of` instead of `mode: off`) fails policy load instead of
 * silently disabling enforcement.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/loader.js';

const POLICY_HEADER = `version: "1"
profile: "test"
installed_by: "test@1.0.0"
installed_at: "2026-05-04T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
notification_channel: ""
`;

async function writePolicy(dir: string, body: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_HEADER + body);
}

describe('policy.review.local_review schema (0.26.0)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-policy-localreview-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loads a policy with no review.local_review block (back-compat)', async () => {
    await writePolicy(dir, '');
    const policy = loadPolicy(dir);
    expect(policy.review?.local_review).toBeUndefined();
  });

  it('loads a policy with mode: enforced explicitly', async () => {
    await writePolicy(dir, 'review:\n  local_review:\n    mode: enforced\n');
    const policy = loadPolicy(dir);
    expect(policy.review?.local_review?.mode).toBe('enforced');
  });

  it('loads a policy with mode: off (the off-switch)', async () => {
    await writePolicy(dir, 'review:\n  local_review:\n    mode: off\n');
    const policy = loadPolicy(dir);
    expect(policy.review?.local_review?.mode).toBe('off');
  });

  it('rejects an invalid mode (typo)', async () => {
    await writePolicy(dir, 'review:\n  local_review:\n    mode: of\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('loads a complete local_review block with all fields', async () => {
    await writePolicy(
      dir,
      [
        'review:',
        '  local_review:',
        '    mode: enforced',
        '    max_age_seconds: 3600',
        '    refuse_at: both',
        '    bypass_env_var: REA_LOCAL_OVERRIDE',
        '',
      ].join('\n'),
    );
    const policy = loadPolicy(dir);
    expect(policy.review?.local_review).toEqual({
      mode: 'enforced',
      max_age_seconds: 3600,
      refuse_at: 'both',
      bypass_env_var: 'REA_LOCAL_OVERRIDE',
    });
  });

  it('rejects an invalid refuse_at value', async () => {
    await writePolicy(dir, 'review:\n  local_review:\n    refuse_at: pushh\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('rejects a bypass_env_var with shell metacharacters', async () => {
    await writePolicy(dir, 'review:\n  local_review:\n    bypass_env_var: "FOO; rm -rf /"\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('rejects a bypass_env_var that does not start with an uppercase letter', async () => {
    await writePolicy(dir, 'review:\n  local_review:\n    bypass_env_var: rea_skip\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('rejects max_age_seconds <= 0', async () => {
    await writePolicy(dir, 'review:\n  local_review:\n    max_age_seconds: 0\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('rejects an unknown field under local_review (strict schema)', async () => {
    await writePolicy(dir, 'review:\n  local_review:\n    foo: bar\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });
});

describe('policy.commit_hygiene schema (0.26.0)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-policy-commithyg-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loads a policy with no commit_hygiene block', async () => {
    await writePolicy(dir, '');
    const policy = loadPolicy(dir);
    expect(policy.commit_hygiene).toBeUndefined();
  });

  it('loads thresholds correctly', async () => {
    await writePolicy(
      dir,
      'commit_hygiene:\n  warn_at_commits: 3\n  refuse_at_commits: 10\n',
    );
    const policy = loadPolicy(dir);
    expect(policy.commit_hygiene?.warn_at_commits).toBe(3);
    expect(policy.commit_hygiene?.refuse_at_commits).toBe(10);
  });

  it('rejects negative thresholds', async () => {
    await writePolicy(dir, 'commit_hygiene:\n  warn_at_commits: -1\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });

  it('rejects unknown fields (strict schema)', async () => {
    await writePolicy(dir, 'commit_hygiene:\n  foo: bar\n');
    expect(() => loadPolicy(dir)).toThrow(/Invalid policy schema/);
  });
});
