/**
 * TOFU classification + store-update logic. Pure functions — no disk.
 *
 * The side-effect layer (stderr, audit, log) is tested separately via the
 * tofu-gate integration tests; this file pins down the classification
 * primitive and the store-update merge rules.
 */

import { describe, expect, it } from 'vitest';
import type { RegistryServer } from './types.js';
import { fingerprintServer } from './fingerprint.js';
import type { FingerprintStore } from './fingerprints-store.js';
import { FINGERPRINT_STORE_VERSION } from './fingerprints-store.js';
import { classifyServers, updateStore } from './tofu.js';

function server(name: string, overrides: Partial<RegistryServer> = {}): RegistryServer {
  return {
    name,
    command: 'node',
    args: ['-e', `console.log("${name}")`],
    env: {},
    enabled: true,
    ...overrides,
  };
}

function emptyStore(): FingerprintStore {
  return { version: FINGERPRINT_STORE_VERSION, servers: {} };
}

describe('classifyServers', () => {
  it('classifies first-seen when store is empty', () => {
    const s = server('discord');
    const out = classifyServers([s], emptyStore());
    expect(out).toHaveLength(1);
    expect(out[0]?.verdict).toBe('first-seen');
    expect(out[0]?.current).toBe(fingerprintServer(s));
    expect(out[0]?.stored).toBeUndefined();
    expect(out[0]?.bypassed).toBe(false);
  });

  it('classifies unchanged when stored fingerprint matches current', () => {
    const s = server('obsidian');
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: { obsidian: fingerprintServer(s) },
    };
    const out = classifyServers([s], store);
    expect(out[0]?.verdict).toBe('unchanged');
    expect(out[0]?.bypassed).toBe(false);
  });

  it('classifies drifted when command changes out from under stored fingerprint', () => {
    const pristine = server('mock');
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: fingerprintServer(pristine) },
    };
    const poisoned = server('mock', { command: 'evil-node' });
    const out = classifyServers([poisoned], store);
    expect(out[0]?.verdict).toBe('drifted');
    expect(out[0]?.stored).toBe(fingerprintServer(pristine));
    expect(out[0]?.current).toBe(fingerprintServer(poisoned));
    expect(out[0]?.bypassed).toBe(false);
  });

  it('honors REA_ACCEPT_DRIFT for a single named server', () => {
    const pristine = server('mock');
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: fingerprintServer(pristine) },
    };
    const poisoned = server('mock', { command: 'new-node' });
    const out = classifyServers([poisoned], store, { acceptDrift: 'mock' });
    expect(out[0]?.verdict).toBe('drifted');
    expect(out[0]?.bypassed).toBe(true);
  });

  it('honors REA_ACCEPT_DRIFT with a comma-separated list', () => {
    const a = server('alpha');
    const b = server('beta');
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: {
        alpha: fingerprintServer(a),
        beta: fingerprintServer(b),
      },
    };
    const aDrift = server('alpha', { command: 'x' });
    const bDrift = server('beta', { command: 'y' });
    const out = classifyServers([aDrift, bDrift], store, {
      acceptDrift: 'alpha, beta',
    });
    expect(out[0]?.bypassed).toBe(true);
    expect(out[1]?.bypassed).toBe(true);
  });

  it('does NOT bypass servers not named in REA_ACCEPT_DRIFT', () => {
    const a = server('alpha');
    const b = server('beta');
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: {
        alpha: fingerprintServer(a),
        beta: fingerprintServer(b),
      },
    };
    const aDrift = server('alpha', { command: 'x' });
    const bDrift = server('beta', { command: 'y' });
    const out = classifyServers([aDrift, bDrift], store, {
      acceptDrift: 'alpha',
    });
    expect(out[0]?.server).toBe('alpha');
    expect(out[0]?.bypassed).toBe(true);
    expect(out[1]?.server).toBe('beta');
    expect(out[1]?.bypassed).toBe(false);
  });

  it('treats empty / whitespace REA_ACCEPT_DRIFT as no bypass', () => {
    const a = server('alpha');
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: { alpha: fingerprintServer(a) },
    };
    const drifted = server('alpha', { command: 'x' });
    for (const raw of ['', '   ', undefined]) {
      const out = classifyServers([drifted], store, { acceptDrift: raw });
      expect(out[0]?.bypassed).toBe(false);
    }
  });

  it('preserves input order in the output', () => {
    const a = server('alpha');
    const b = server('beta');
    const c = server('gamma');
    const out = classifyServers([c, a, b], emptyStore());
    expect(out.map((o) => o.server)).toEqual(['gamma', 'alpha', 'beta']);
  });
});

describe('updateStore merge rules', () => {
  it('records first-seen fingerprints', () => {
    const store = emptyStore();
    const s = server('new');
    const classifications = classifyServers([s], store);
    const next = updateStore(store, classifications);
    expect(next.servers.new).toBe(fingerprintServer(s));
  });

  it('leaves unchanged servers untouched', () => {
    const s = server('steady');
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: { steady: fingerprintServer(s) },
    };
    const next = updateStore(store, classifyServers([s], store));
    expect(next.servers.steady).toBe(fingerprintServer(s));
  });

  it('keeps stored fingerprint on drift WITHOUT bypass (drift persists across restart)', () => {
    const original = server('mock');
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: fingerprintServer(original) },
    };
    const poisoned = server('mock', { command: 'evil' });
    const classifications = classifyServers([poisoned], store);
    const next = updateStore(store, classifications);
    // Stored value preserved — operator must still deal with drift on next boot.
    expect(next.servers.mock).toBe(fingerprintServer(original));
    expect(next.servers.mock).not.toBe(fingerprintServer(poisoned));
  });

  it('updates stored fingerprint on drift WITH bypass (operator authorized rotation)', () => {
    const original = server('mock');
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: fingerprintServer(original) },
    };
    const rotated = server('mock', { command: 'legitimate-update' });
    const classifications = classifyServers([rotated], store, {
      acceptDrift: 'mock',
    });
    const next = updateStore(store, classifications);
    expect(next.servers.mock).toBe(fingerprintServer(rotated));
  });

  it('does NOT prune fingerprints for servers removed from the registry', () => {
    // Rename-then-reinstall is a classic attacker move. Pruning on absence
    // would let that reset TOFU silently.
    const store: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: { departed: 'c'.repeat(64) },
    };
    const next = updateStore(store, classifyServers([], store));
    expect(next.servers.departed).toBe('c'.repeat(64));
  });
});
