/**
 * T-POL-01..05 + :free guard + base_url HTTPS pin — AC-11.
 *
 * Policy zod-strict: `review.provider` enum parses; absence resolves to
 * codex at consumption; a bogus enum / unknown sub-field / non-HTTPS
 * base_url / `:free` model all FAIL loud at `loadPolicyAsync`.
 *
 * Per the QA plan §2.7 caveat, the thrown-error assertions call
 * `loadPolicyAsync` DIRECTLY (the CLI catches load errors and falls back to
 * protective defaults, so going through the CLI would observe the fallback,
 * not the throw).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicyAsync, invalidatePolicyCache } from './loader.js';

let tmpDir: string;

const BASE_POLICY = [
  'version: "0.50.0"',
  'profile: open-source-no-codex',
  'installed_by: test',
  'installed_at: "2026-06-08T00:00:00Z"',
  'autonomy_level: L1',
  'max_autonomy_level: L2',
  'promotion_requires_human_approval: true',
  'block_ai_attribution: true',
  'blocked_paths: []',
  'protected_paths_relax: []',
  'notification_channel: ""',
];

function writePolicy(lines: string[]): void {
  fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.rea', 'policy.yaml'), lines.join('\n') + '\n');
  invalidatePolicyCache(tmpDir);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pol-or-'));
});

afterEach(() => {
  invalidatePolicyCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('policy zod — openrouter review provider (AC-11)', () => {
  it('T-POL-01: review.provider: openrouter parses', async () => {
    writePolicy([...BASE_POLICY, 'review:', '  provider: openrouter']);
    const policy = await loadPolicyAsync(tmpDir);
    expect(policy.review?.provider).toBe('openrouter');
  });

  it('T-POL-02: no review.provider → resolves to codex at consumption (key omitted)', async () => {
    writePolicy([...BASE_POLICY, 'review:', '  local_review:', '    mode: enforced']);
    const policy = await loadPolicyAsync(tmpDir);
    // The loader does NOT inject a default — absence stays absent.
    expect(policy.review?.provider).toBeUndefined();
    // Consumption resolves `?? 'codex'`.
    expect(policy.review?.provider ?? 'codex').toBe('codex');
  });

  it('T-POL-03: review.provider: bogus → load FAILS (enum)', async () => {
    writePolicy([...BASE_POLICY, 'review:', '  provider: bogus']);
    await expect(loadPolicyAsync(tmpDir)).rejects.toThrow(/Invalid policy schema/);
  });

  it('T-POL-04: a well-formed providers.openrouter block parses and round-trips', async () => {
    writePolicy([
      ...BASE_POLICY,
      'review:',
      '  provider: openrouter',
      '  providers:',
      '    openrouter:',
      '      model: "openai/gpt-oss-120b"',
      '      base_url: "https://openrouter.ai/api/v1"',
      '      data_policy: deny-training',
      '      backend_pin: ["fireworks"]',
      '      timeout_ms: 120000',
      '      max_diff_bytes: 1500000',
      '      path_overrides:',
      '        - paths: ["strawn-legal/**"]',
      '          provider: codex',
    ]);
    const policy = await loadPolicyAsync(tmpDir);
    const or = policy.review?.providers?.openrouter;
    expect(or?.model).toBe('openai/gpt-oss-120b');
    expect(or?.base_url).toBe('https://openrouter.ai/api/v1');
    expect(or?.data_policy).toBe('deny-training');
    expect(or?.backend_pin).toEqual(['fireworks']);
    expect(or?.timeout_ms).toBe(120000);
    expect(or?.max_diff_bytes).toBe(1500000);
    expect(or?.path_overrides?.[0]?.provider).toBe('codex');
    expect(or?.path_overrides?.[0]?.paths).toEqual(['strawn-legal/**']);
  });

  it('T-POL-05: unknown providers.openrouter.* field → load FAILS (strict)', async () => {
    writePolicy([
      ...BASE_POLICY,
      'review:',
      '  providers:',
      '    openrouter:',
      '      model: "openai/gpt-oss-120b"',
      '      bogus_field: true',
    ]);
    await expect(loadPolicyAsync(tmpDir)).rejects.toThrow(/Invalid policy schema/);
  });

  it('T-POL-06 (round-14): a path_override with provider: openrouter → load FAILS (only codex/refuse downgrades)', async () => {
    // Round-14: per-path UPGRADE to openrouter is incoherent for a whole-diff
    // review, so `openrouter` was removed from the override enum. A config that
    // tries it must fail loud, not silently no-op.
    writePolicy([
      ...BASE_POLICY,
      'review:',
      '  provider: codex',
      '  providers:',
      '    openrouter:',
      '      path_overrides:',
      '        - paths: ["docs/**"]',
      '          provider: openrouter',
    ]);
    await expect(loadPolicyAsync(tmpDir)).rejects.toThrow(/Invalid policy schema/);
  });

  it(':free model suffix → load FAILS loudly (config-vs-capability)', async () => {
    writePolicy([
      ...BASE_POLICY,
      'review:',
      '  providers:',
      '    openrouter:',
      '      model: "openai/gpt-oss-120b:free"',
    ]);
    await expect(loadPolicyAsync(tmpDir)).rejects.toThrow(/:free.*NOT wired|NOT wired.*:free/s);
  });

  it('non-HTTPS base_url → load FAILS (HTTPS pin)', async () => {
    writePolicy([
      ...BASE_POLICY,
      'review:',
      '  providers:',
      '    openrouter:',
      '      base_url: "http://openrouter.ai/api/v1"',
    ]);
    await expect(loadPolicyAsync(tmpDir)).rejects.toThrow(/Invalid policy schema/);
  });

  // FIX 2 (codex round-2): the http loopback exception is NARROW —
  // 127.0.0.0/8 + [::1] + exactly `localhost`, never a public/LAN host or a
  // suffix-evil hostname.
  const loopbackAllowed = [
    'http://127.0.0.1:8080/api/v1',
    'http://127.0.0.1/api/v1',
    'http://127.5.5.5:443/api/v1', // anywhere in 127.0.0.0/8
    'http://127.255.255.255:65535/api/v1', // max octets + max port (codex round-3 P2)
    'http://127.0.0.1:1/api/v1', // min valid port
    'http://localhost:9999/api/v1',
    'http://[::1]:8080/api/v1',
    'https://openrouter.ai/api/v1', // the production https lane
    'https://api.openrouter.ai/api/v1', // a subdomain of the pinned host (codex round-4 P1)
    'https://openrouter.ai', // no path
  ];
  for (const url of loopbackAllowed) {
    it(`base_url ${url} → ALLOWED`, async () => {
      writePolicy([
        ...BASE_POLICY,
        'review:',
        '  providers:',
        '    openrouter:',
        `      base_url: "${url}"`,
      ]);
      const policy = await loadPolicyAsync(tmpDir);
      expect(policy.review?.providers?.openrouter?.base_url).toBe(url);
    });
  }

  const nonLoopbackRejected = [
    'http://192.168.1.10:8080/api/v1', // LAN IP
    'http://10.0.0.5/api/v1', // private range, not loopback
    'http://0.0.0.0:8080/api/v1', // wildcard bind, not loopback
    'http://127.0.0.1.evil.com/api/v1', // suffix-evil — anchored regex rejects
    'http://localhost.evil.com/api/v1', // suffix-evil
    'http://openrouter.ai/api/v1', // public host over http
    'ftp://127.0.0.1/api/v1', // wrong scheme
    // codex round-3 P2: octet/port RANGE must fail closed at load, not at fetch.
    'http://127.256.0.1/api/v1', // octet > 255
    'http://127.300.0.1/api/v1', // octet way over
    'http://127.0.0.1:65536/api/v1', // port > 65535
    'http://127.0.0.1:99999/api/v1', // port 5 digits but out of range
    'http://127.0.0.1:0/api/v1', // port 0 invalid
    // codex round-4 P1: HTTPS host is PINNED to openrouter.ai — arbitrary https
    // endpoints must NOT pass load (they'd receive the full diff + commit log).
    'https://evil.example/api/v1', // arbitrary https host
    'https://openrouter.ai.evil.com/api/v1', // suffix-evil on the pinned host
    'https://evilopenrouter.ai/api/v1', // prefix-evil (no dot boundary)
    'https://openrouter.ai:0/api/v1', // pinned host but invalid port 0
  ];
  for (const url of nonLoopbackRejected) {
    it(`base_url ${url} → REJECTED (narrow loopback exception)`, async () => {
      writePolicy([
        ...BASE_POLICY,
        'review:',
        '  providers:',
        '    openrouter:',
        `      base_url: "${url}"`,
      ]);
      await expect(loadPolicyAsync(tmpDir)).rejects.toThrow(/Invalid policy schema/);
    });
  }

  it('path_override with empty paths array → load FAILS (min 1)', async () => {
    writePolicy([
      ...BASE_POLICY,
      'review:',
      '  providers:',
      '    openrouter:',
      '      path_overrides:',
      '        - paths: []',
      '          provider: codex',
    ]);
    await expect(loadPolicyAsync(tmpDir)).rejects.toThrow(/Invalid policy schema/);
  });

  it('path_override with bogus provider → load FAILS (enum)', async () => {
    writePolicy([
      ...BASE_POLICY,
      'review:',
      '  providers:',
      '    openrouter:',
      '      path_overrides:',
      '        - paths: ["x/**"]',
      '          provider: gemini',
    ]);
    await expect(loadPolicyAsync(tmpDir)).rejects.toThrow(/Invalid policy schema/);
  });

  it('provider: both parses', async () => {
    writePolicy([...BASE_POLICY, 'review:', '  provider: both']);
    const policy = await loadPolicyAsync(tmpDir);
    expect(policy.review?.provider).toBe('both');
  });

  // --- A1: commit-aware review granularity (0.50.x) ---------------------
  for (const value of ['auto', 'per-commit', 'whole'] as const) {
    it(`review_granularity: ${value} parses`, async () => {
      writePolicy([
        ...BASE_POLICY,
        'review:',
        '  providers:',
        '    openrouter:',
        `      review_granularity: ${value}`,
      ]);
      const policy = await loadPolicyAsync(tmpDir);
      expect(policy.review?.providers?.openrouter?.review_granularity).toBe(value);
    });
  }

  it('a bogus review_granularity value → load FAILS (enum)', async () => {
    writePolicy([
      ...BASE_POLICY,
      'review:',
      '  providers:',
      '    openrouter:',
      '      review_granularity: per-file',
    ]);
    await expect(loadPolicyAsync(tmpDir)).rejects.toThrow(/Invalid policy schema/);
  });

  it('absent review_granularity stays undefined (resolves to auto at consumption)', async () => {
    writePolicy([
      ...BASE_POLICY,
      'review:',
      '  providers:',
      '    openrouter:',
      '      model: "openai/gpt-oss-120b"',
    ]);
    const policy = await loadPolicyAsync(tmpDir);
    expect(policy.review?.providers?.openrouter?.review_granularity).toBeUndefined();
  });
});
