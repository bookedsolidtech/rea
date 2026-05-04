/**
 * Fingerprint stability + instability cases.
 *
 * "Stable" means: inputs that are materially the same (key order shuffled,
 * env values rotated, args the same sequence) produce the same hex digest.
 * "Unstable" means: inputs that differ in ANY material way (command
 * changed, arg added, env key added/removed, passthrough surface changed,
 * tier override changed) produce a DIFFERENT digest.
 */

import { describe, expect, it } from 'vitest';
import type { RegistryServer } from './types.js';
import { Tier } from '../policy/types.js';
import { __canonicalizeForTests, fingerprintServer } from './fingerprint.js';

function server(overrides: Partial<RegistryServer> = {}): RegistryServer {
  return {
    name: 'mock',
    command: 'node',
    args: ['-e', 'noop'],
    env: {},
    enabled: true,
    ...overrides,
  };
}

describe('fingerprintServer — stability', () => {
  it('produces the same digest for identical inputs', () => {
    const a = fingerprintServer(server());
    const b = fingerprintServer(server());
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is invariant to env-key order (canonicalization sorts keys)', () => {
    const a = fingerprintServer(server({ env: { ALPHA: '1', BETA: '2' } }));
    const b = fingerprintServer(server({ env: { BETA: '2', ALPHA: '1' } }));
    expect(a).toBe(b);
  });

  it('is invariant to env VALUES (secret rotation must not trip drift)', () => {
    const a = fingerprintServer(server({ env: { GITHUB_TOKEN: 'ghp_old' } }));
    const b = fingerprintServer(server({ env: { GITHUB_TOKEN: 'ghp_new_after_rotation' } }));
    expect(a).toBe(b);
  });

  it('is invariant to passthrough order', () => {
    const a = fingerprintServer(server({ env_passthrough: ['HTTPS_PROXY', 'HTTP_PROXY'] }));
    const b = fingerprintServer(server({ env_passthrough: ['HTTP_PROXY', 'HTTPS_PROXY'] }));
    expect(a).toBe(b);
  });

  it('is invariant to tier-override key order', () => {
    const a = fingerprintServer(server({ tier_overrides: { foo: Tier.Read, bar: Tier.Write } }));
    const b = fingerprintServer(server({ tier_overrides: { bar: Tier.Write, foo: Tier.Read } }));
    expect(a).toBe(b);
  });

  it('is invariant to the `enabled` flag (disabled servers are still fingerprinted the same)', () => {
    const a = fingerprintServer(server({ enabled: true }));
    const b = fingerprintServer(server({ enabled: false }));
    expect(a).toBe(b);
  });
});

describe('fingerprintServer — instability (drift triggers)', () => {
  it('changes when command changes', () => {
    const a = fingerprintServer(server({ command: 'node' }));
    const b = fingerprintServer(server({ command: 'evil-node' }));
    expect(a).not.toBe(b);
  });

  it('changes when an arg is added', () => {
    const a = fingerprintServer(server({ args: ['-e', 'noop'] }));
    const b = fingerprintServer(server({ args: ['-e', 'noop', '--exfil'] }));
    expect(a).not.toBe(b);
  });

  it('changes when arg order changes (command-line order is semantic)', () => {
    const a = fingerprintServer(server({ args: ['-a', '-b'] }));
    const b = fingerprintServer(server({ args: ['-b', '-a'] }));
    expect(a).not.toBe(b);
  });

  it('changes when an env KEY is added (new permission surface)', () => {
    const a = fingerprintServer(server({ env: { FOO: '1' } }));
    const b = fingerprintServer(server({ env: { FOO: '1', NEW_SECRET_KEY: '2' } }));
    expect(a).not.toBe(b);
  });

  it('changes when an env key is removed', () => {
    const a = fingerprintServer(server({ env: { FOO: '1', BAR: '2' } }));
    const b = fingerprintServer(server({ env: { FOO: '1' } }));
    expect(a).not.toBe(b);
  });

  it('changes when passthrough surface expands', () => {
    const a = fingerprintServer(server({ env_passthrough: ['HTTPS_PROXY'] }));
    const b = fingerprintServer(
      server({
        env_passthrough: ['HTTPS_PROXY', 'NPM_CONFIG_REGISTRY'],
      }),
    );
    expect(a).not.toBe(b);
  });

  it('changes when a tier override is added', () => {
    const a = fingerprintServer(server());
    const b = fingerprintServer(server({ tier_overrides: { foo: Tier.Destructive } }));
    expect(a).not.toBe(b);
  });

  it('changes when a tier override value changes (privilege escalation)', () => {
    const a = fingerprintServer(server({ tier_overrides: { foo: Tier.Read } }));
    const b = fingerprintServer(server({ tier_overrides: { foo: Tier.Destructive } }));
    expect(a).not.toBe(b);
  });

  it('changes when the server name changes (identity is part of the fingerprint)', () => {
    const a = fingerprintServer(server({ name: 'original' }));
    const b = fingerprintServer(server({ name: 'renamed' }));
    expect(a).not.toBe(b);
  });
});

describe('canonicalization shape', () => {
  it('fingerprints env by KEY SET, not values', () => {
    const c = __canonicalizeForTests(server({ env: { TOKEN: 'secret-value', OTHER: 'x' } }));
    expect(c.env_keys).toEqual(['OTHER', 'TOKEN']);
    // Values must not appear anywhere in the canonical form.
    expect(JSON.stringify(c)).not.toContain('secret-value');
  });

  it('sorts passthrough and tier overrides deterministically', () => {
    const c = __canonicalizeForTests(
      server({
        env_passthrough: ['Z_VAR', 'A_VAR'],
        tier_overrides: { zed: Tier.Read, alpha: Tier.Write },
      }),
    );
    expect(c.env_passthrough).toEqual(['A_VAR', 'Z_VAR']);
    expect(c.tier_overrides[0]?.[0]).toBe('alpha');
    expect(c.tier_overrides[1]?.[0]).toBe('zed');
  });
});
