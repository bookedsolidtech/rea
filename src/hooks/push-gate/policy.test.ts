import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PUSH_GATE_DEFAULT_CODEX_REQUIRED,
  PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
  PUSH_GATE_DEFAULT_TIMEOUT_MS,
  resolvePushGatePolicy,
} from './policy.js';

const MINIMAL_POLICY = `version: "1"
profile: "minimal"
installed_by: "test"
installed_at: "2026-04-21T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
notification_channel: ""
`;

describe('resolvePushGatePolicy', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-policy-')));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('defaults when .rea/policy.yaml is absent', async () => {
    const p = await resolvePushGatePolicy(baseDir);
    expect(p).toEqual({
      codex_required: PUSH_GATE_DEFAULT_CODEX_REQUIRED,
      concerns_blocks: PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
      timeout_ms: PUSH_GATE_DEFAULT_TIMEOUT_MS,
      last_n_commits: undefined,
      policyMissing: true,
    });
  });

  it('PUSH_GATE_DEFAULT_TIMEOUT_MS is 30 minutes (raised in 0.12.0 from 10 min)', () => {
    expect(PUSH_GATE_DEFAULT_TIMEOUT_MS).toBe(1_800_000);
  });

  it('honors explicit review.last_n_commits', async () => {
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      MINIMAL_POLICY + 'review:\n  last_n_commits: 7\n',
      'utf8',
    );
    const p = await resolvePushGatePolicy(baseDir);
    expect(p.last_n_commits).toBe(7);
  });

  it('rejects review.last_n_commits: 0 (positive integer required)', async () => {
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      MINIMAL_POLICY + 'review:\n  last_n_commits: 0\n',
      'utf8',
    );
    await expect(resolvePushGatePolicy(baseDir)).rejects.toThrow(/Invalid policy schema/);
  });

  it('rejects review.last_n_commits: -3 (positive integer required)', async () => {
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      MINIMAL_POLICY + 'review:\n  last_n_commits: -3\n',
      'utf8',
    );
    await expect(resolvePushGatePolicy(baseDir)).rejects.toThrow(/Invalid policy schema/);
  });

  it('defaults when .rea/policy.yaml has no review block', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), MINIMAL_POLICY, 'utf8');
    const p = await resolvePushGatePolicy(baseDir);
    expect(p.codex_required).toBe(true);
    expect(p.concerns_blocks).toBe(true);
    expect(p.timeout_ms).toBe(PUSH_GATE_DEFAULT_TIMEOUT_MS);
    expect(p.policyMissing).toBe(false);
  });

  it('honors explicit review.codex_required: false', async () => {
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      MINIMAL_POLICY + 'review:\n  codex_required: false\n',
      'utf8',
    );
    const p = await resolvePushGatePolicy(baseDir);
    expect(p.codex_required).toBe(false);
  });

  it('honors explicit review.concerns_blocks: false', async () => {
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      MINIMAL_POLICY + 'review:\n  concerns_blocks: false\n',
      'utf8',
    );
    const p = await resolvePushGatePolicy(baseDir);
    expect(p.concerns_blocks).toBe(false);
  });

  it('honors explicit review.timeout_ms', async () => {
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      MINIMAL_POLICY + 'review:\n  timeout_ms: 300000\n',
      'utf8',
    );
    const p = await resolvePushGatePolicy(baseDir);
    expect(p.timeout_ms).toBe(300_000);
  });

  it('rejects the removed 0.10.x cache_max_age_seconds knob', async () => {
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      MINIMAL_POLICY + 'review:\n  codex_required: true\n  cache_max_age_seconds: 3600\n',
      'utf8',
    );
    await expect(resolvePushGatePolicy(baseDir)).rejects.toThrow(/Invalid policy schema/);
  });

  it('rejects the removed 0.10.x allow_skip_in_ci knob', async () => {
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      MINIMAL_POLICY + 'review:\n  codex_required: true\n  allow_skip_in_ci: true\n',
      'utf8',
    );
    await expect(resolvePushGatePolicy(baseDir)).rejects.toThrow(/Invalid policy schema/);
  });
});
