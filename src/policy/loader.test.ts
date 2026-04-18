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

  describe('redact policy (G3)', () => {
    it('accepts redact.match_timeout_ms and redact.patterns when set', async () => {
      const yaml =
        SAMPLE +
        '\nredact:\n' +
        '  match_timeout_ms: 250\n' +
        '  patterns:\n' +
        '    - name: internal-token\n' +
        '      regex: "MYTOKEN_[A-Z0-9]{12}"\n' +
        '      flags: g\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.redact?.match_timeout_ms).toBe(250);
      expect(p.redact?.patterns).toHaveLength(1);
      expect(p.redact?.patterns?.[0]?.name).toBe('internal-token');
      expect(p.redact?.patterns?.[0]?.regex).toBe('MYTOKEN_[A-Z0-9]{12}');
      expect(p.redact?.patterns?.[0]?.flags).toBe('g');
    });

    it('leaves redact undefined when not set (backwards compatible)', async () => {
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), SAMPLE, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.redact).toBeUndefined();
    });

    it('rejects a user pattern that safe-regex flags as unsafe', async () => {
      // Classic catastrophic backtracker — safe-regex marks this unsafe.
      const yaml =
        SAMPLE +
        '\nredact:\n' +
        '  patterns:\n' +
        '    - name: catastrophic\n' +
        '      regex: "(a+)+$"\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Unsafe redact pattern "catastrophic"/);
    });

    it('rejects a user pattern that does not compile', async () => {
      const yaml =
        SAMPLE +
        '\nredact:\n' +
        '  patterns:\n' +
        '    - name: bad-regex\n' +
        '      regex: "("\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid redact pattern "bad-regex"/);
    });

    it('rejects unknown fields inside redact (strict)', async () => {
      const yaml = SAMPLE + '\nredact:\n  match_timeout_ms: 100\n  mystery: 1\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('rejects a user pattern with unknown fields (strict)', async () => {
      const yaml =
        SAMPLE +
        '\nredact:\n' +
        '  patterns:\n' +
        '    - name: good\n' +
        '      regex: "A[0-9]{10}"\n' +
        '      mystery: "x"\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('accepts a safe user pattern (load + round-trip)', async () => {
      // Bounded, non-backtracking pattern — safe-regex accepts it.
      const yaml =
        SAMPLE +
        '\nredact:\n' +
        '  match_timeout_ms: 150\n' +
        '  patterns:\n' +
        '    - name: customer-id\n' +
        '      regex: "CID_[A-Z0-9]{10}"\n' +
        '      flags: g\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.redact?.patterns?.[0]?.name).toBe('customer-id');
      // The policy returns the raw pattern spec; the gateway compiles it at
      // middleware-creation time.
      expect(p.redact?.patterns?.[0]?.regex).toBe('CID_[A-Z0-9]{10}');
    });
  });

  describe('audit policy (G1)', () => {
    it('accepts audit.rotation.max_bytes and max_age_days', async () => {
      const yaml =
        SAMPLE +
        '\naudit:\n' +
        '  rotation:\n' +
        '    max_bytes: 10485760\n' +
        '    max_age_days: 14\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.audit?.rotation?.max_bytes).toBe(10 * 1024 * 1024);
      expect(p.audit?.rotation?.max_age_days).toBe(14);
    });

    it('accepts an empty audit.rotation block (opt-in to defaults)', async () => {
      const yaml = SAMPLE + '\naudit:\n  rotation: {}\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      // Schema preserves the empty block; rotator applies defaults at
      // consumption time, not here.
      expect(p.audit?.rotation).toBeDefined();
      expect(p.audit?.rotation?.max_bytes).toBeUndefined();
      expect(p.audit?.rotation?.max_age_days).toBeUndefined();
    });

    it('leaves audit undefined when not set (back-compat with 0.2.x)', async () => {
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), SAMPLE, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.audit).toBeUndefined();
    });

    it('rejects unknown fields inside audit.rotation (strict)', async () => {
      const yaml =
        SAMPLE + '\naudit:\n  rotation:\n    max_bytes: 1024\n    mystery: true\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('rejects unknown fields at the audit.* level (strict)', async () => {
      const yaml = SAMPLE + '\naudit:\n  rotation: {}\n  mystery: true\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('rejects non-positive max_bytes', async () => {
      const yaml = SAMPLE + '\naudit:\n  rotation:\n    max_bytes: 0\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('rejects non-positive max_age_days', async () => {
      const yaml = SAMPLE + '\naudit:\n  rotation:\n    max_age_days: -1\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });
  });
});
