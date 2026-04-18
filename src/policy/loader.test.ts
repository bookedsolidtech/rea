import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePolicyCache, loadPolicy, loadPolicyAsync } from './loader.js';
import { AutonomyLevel } from './types.js';

const SAMPLE = `version: "1"
profile: "minimal"
installed_by: "tester"
installed_at: "2026-04-18T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths:
  - ".env"
  - ".env.*"
notification_channel: ""
`;

describe('policy loader', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-policy-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    invalidatePolicyCache();
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('parses a minimal valid policy (sync)', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), SAMPLE, 'utf8');
    const p = loadPolicy(baseDir);
    expect(p.version).toBe('1');
    expect(p.autonomy_level).toBe(AutonomyLevel.L1);
    expect(p.blocked_paths).toContain('.env');
  });

  it('parses a minimal valid policy (async)', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), SAMPLE, 'utf8');
    const p = await loadPolicyAsync(baseDir);
    expect(p.profile).toBe('minimal');
  });

  it('clamps autonomy_level when it exceeds max_autonomy_level', async () => {
    const overClamp = SAMPLE.replace('autonomy_level: L1', 'autonomy_level: L3').replace(
      'max_autonomy_level: L2',
      'max_autonomy_level: L1',
    );
    await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), overClamp, 'utf8');
    const p = loadPolicy(baseDir);
    expect(p.autonomy_level).toBe(AutonomyLevel.L1);
  });

  it('rejects unknown fields (strict schema)', async () => {
    const withExtra = SAMPLE + '\nmystery_field: true\n';
    await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), withExtra, 'utf8');
    expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
  });

  it('throws when policy file is missing', () => {
    expect(() => loadPolicy(baseDir)).toThrow(/Policy file not found/);
  });

  describe('review policy (G11.2)', () => {
    it('accepts review.codex_required when set', async () => {
      const yaml = SAMPLE + '\nreview:\n  codex_required: false\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.review?.codex_required).toBe(false);
    });

    it('leaves review undefined when not set (backwards compatible)', async () => {
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), SAMPLE, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.review).toBeUndefined();
    });

    it('rejects unknown fields inside review (strict)', async () => {
      const yaml = SAMPLE + '\nreview:\n  codex_required: true\n  mystery: 1\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });
  });
});
