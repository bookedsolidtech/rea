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

  describe('review policy (0.11.0 push-gate)', () => {
    it('accepts review.codex_required when set', async () => {
      const yaml = SAMPLE + '\nreview:\n  codex_required: false\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.review?.codex_required).toBe(false);
    });

    it('accepts review.concerns_blocks when set', async () => {
      const yaml = SAMPLE + '\nreview:\n  concerns_blocks: false\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.review?.concerns_blocks).toBe(false);
    });

    it('accepts review.timeout_ms when set (positive integer)', async () => {
      const yaml = SAMPLE + '\nreview:\n  timeout_ms: 300000\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.review?.timeout_ms).toBe(300_000);
    });

    it('rejects non-positive timeout_ms', async () => {
      const yaml = SAMPLE + '\nreview:\n  timeout_ms: 0\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('leaves review undefined when not set (backwards compatible)', async () => {
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), SAMPLE, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.review).toBeUndefined();
    });

    it('rejects the 0.10.x cache_max_age_seconds field (removed in 0.11.0)', async () => {
      const yaml = SAMPLE + '\nreview:\n  codex_required: true\n  cache_max_age_seconds: 3600\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('rejects the 0.10.x allow_skip_in_ci field (removed in 0.11.0)', async () => {
      const yaml = SAMPLE + '\nreview:\n  codex_required: true\n  allow_skip_in_ci: true\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
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
        SAMPLE + '\nredact:\n' + '  patterns:\n' + '    - name: bad-regex\n' + '      regex: "("\n';
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
      const yaml = SAMPLE + '\naudit:\n  rotation:\n    max_bytes: 1024\n    mystery: true\n';
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

  describe('injection policy (G9)', () => {
    it('accepts injection.suspicious_blocks_writes when pinned true (bst-internal posture)', async () => {
      const yaml = SAMPLE + '\ninjection:\n  suspicious_blocks_writes: true\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.injection?.suspicious_blocks_writes).toBe(true);
    });

    it('accepts injection.suspicious_blocks_writes when pinned false', async () => {
      const yaml = SAMPLE + '\ninjection:\n  suspicious_blocks_writes: false\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.injection?.suspicious_blocks_writes).toBe(false);
    });

    it('leaves suspicious_blocks_writes undefined when the injection block is present but empty (G9 follow-up)', async () => {
      // Post-patch: the schema no longer applies a default. Absence is
      // preserved so the middleware can distinguish "not configured" from
      // "explicitly false" and apply 0.2.x block-default parity for
      // `action: 'block'` + unset.
      const yaml = SAMPLE + '\ninjection: {}\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.injection).toBeDefined();
      expect(p.injection?.suspicious_blocks_writes).toBeUndefined();
    });

    it('leaves injection undefined when not set — middleware applies 0.2.x block-default parity (G9 follow-up)', async () => {
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), SAMPLE, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.injection).toBeUndefined();
    });

    it('rejects unknown fields inside injection (strict)', async () => {
      const yaml = SAMPLE + '\ninjection:\n  suspicious_blocks_writes: true\n  mystery: 1\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('rejects non-boolean suspicious_blocks_writes', async () => {
      const yaml = SAMPLE + '\ninjection:\n  suspicious_blocks_writes: "yes"\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('reload picks up a pin change (flag flipped on disk, cache invalidates on mtime)', async () => {
      const policyPath = path.join(baseDir, '.rea', 'policy.yaml');
      await fs.writeFile(
        policyPath,
        SAMPLE + '\ninjection:\n  suspicious_blocks_writes: false\n',
        'utf8',
      );
      const first = await loadPolicyAsync(baseDir);
      expect(first.injection?.suspicious_blocks_writes).toBe(false);

      // Wait enough for mtime to tick on disk. macOS HFS+ is 1s granularity;
      // APFS is sub-ms but we still give a small sleep so stat.mtimeMs differs.
      await new Promise((resolve) => setTimeout(resolve, 20));

      await fs.writeFile(
        policyPath,
        SAMPLE + '\ninjection:\n  suspicious_blocks_writes: true\n',
        'utf8',
      );
      const second = await loadPolicyAsync(baseDir);
      expect(second.injection?.suspicious_blocks_writes).toBe(true);
    });
  });

  describe('runtime policy (0.50.0 safe-global-cli veto)', () => {
    it('leaves runtime undefined when no runtime block is present (absent → permitted)', async () => {
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), SAMPLE, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.runtime).toBeUndefined();
    });

    it('accepts runtime.allow_global_cli: true (explicit affirm — value round-trips)', async () => {
      const yaml = SAMPLE + '\nruntime:\n  allow_global_cli: true\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.runtime).toBeDefined();
      expect(p.runtime?.allow_global_cli).toBe(true);
    });

    it('accepts runtime.allow_global_cli: false (project veto — value round-trips)', async () => {
      const yaml = SAMPLE + '\nruntime:\n  allow_global_cli: false\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.runtime).toBeDefined();
      // false must survive as false — NOT collapsed to undefined. The shim
      // veto wiring distinguishes explicit-false (project refuses) from
      // absent (registry governs).
      expect(p.runtime?.allow_global_cli).toBe(false);
    });

    it('preserves an empty runtime block (allow_global_cli omitted → undefined)', async () => {
      const yaml = SAMPLE + '\nruntime: {}\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.runtime).toBeDefined();
      expect(p.runtime?.allow_global_cli).toBeUndefined();
    });

    it('rejects a typo field inside runtime (strict — allow_globcli)', async () => {
      const yaml = SAMPLE + '\nruntime:\n  allow_globcli: true\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('rejects a wrong-type allow_global_cli (string "yes")', async () => {
      const yaml = SAMPLE + '\nruntime:\n  allow_global_cli: "yes"\n';
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
      expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
    });

    it('loads a full .rea/policy.yaml-shaped fixture carrying runtime.allow_global_cli: false (strict-reject-of-unknown-field is solved)', async () => {
      // The crux of Phase 2a: BEFORE the schema existed, ANY policy.yaml with
      // a `runtime:` block failed to load entirely under the top-level
      // `.strict()`. This fixture proves a realistic project policy that opts
      // into the veto loads cleanly and round-trips the value.
      const fixture = `version: "1"
profile: "bst-internal"
installed_by: "safe-global-cli-phase-2a"
installed_at: "2026-06-30T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths:
  - ".env"
  - ".env.*"
  - ".rea/HALT"
notification_channel: ""
review:
  codex_required: true
runtime:
  allow_global_cli: false
`;
      await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), fixture, 'utf8');
      const p = loadPolicy(baseDir);
      expect(p.profile).toBe('bst-internal');
      expect(p.review?.codex_required).toBe(true);
      expect(p.runtime?.allow_global_cli).toBe(false);
    });
  });
});

describe('spend_governance policy (0.51.0 E1 seed)', () => {
  let baseDir: string;

  const BASE = `version: "1"
profile: "minimal"
installed_by: "tester"
installed_at: "2026-07-04T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
`;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-spend-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    invalidatePolicyCache();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  async function write(body: string): Promise<void> {
    await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), body, 'utf8');
  }

  it('absent block leaves spend_governance undefined', async () => {
    await write(BASE);
    const p = loadPolicy(baseDir);
    expect(p.spend_governance).toBeUndefined();
  });

  it('present block defaults billing_error_response to halt', async () => {
    await write(BASE + 'spend_governance:\n  enabled: true\n');
    const p = loadPolicy(baseDir);
    expect(p.spend_governance?.enabled).toBe(true);
    expect(p.spend_governance?.billing_error_response).toBe('halt');
  });

  it('present block defaults enabled to false when omitted', async () => {
    await write(BASE + 'spend_governance:\n  billing_error_response: warn\n');
    const p = loadPolicy(baseDir);
    expect(p.spend_governance?.enabled).toBe(false);
    expect(p.spend_governance?.billing_error_response).toBe('warn');
  });

  it('accepts each enum value (halt|warn|off)', async () => {
    for (const v of ['halt', 'warn', 'off'] as const) {
      invalidatePolicyCache();
      await write(BASE + `spend_governance:\n  enabled: true\n  billing_error_response: ${v}\n`);
      const p = loadPolicy(baseDir);
      expect(p.spend_governance?.billing_error_response).toBe(v);
    }
  });

  it('rejects an unknown billing_error_response value (strict enum)', async () => {
    await write(BASE + 'spend_governance:\n  enabled: true\n  billing_error_response: retry\n');
    expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
  });

  it('rejects an unknown sub-field (strict block)', async () => {
    await write(
      BASE + 'spend_governance:\n  enabled: true\n  metered_endpoints: []\n',
    );
    expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
  });

  it('rejects a non-boolean enabled', async () => {
    await write(BASE + 'spend_governance:\n  enabled: "yes"\n');
    expect(() => loadPolicy(baseDir)).toThrow(/Invalid policy schema/);
  });
});
