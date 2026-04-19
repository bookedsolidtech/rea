/**
 * Integration tests for `applyTofuGate` — the startup-time side-effect
 * layer on top of the pure classifier.
 *
 * Verifies:
 *   - First-seen: audit entry written, LOUD stderr block, log line, server
 *     included in the accepted set.
 *   - Drift (no bypass): audit denied entry, stderr warn, log line, server
 *     DROPPED from the accepted set (other servers remain).
 *   - Drift (REA_ACCEPT_DRIFT bypass): audit allowed + bypassed=true,
 *     stderr notice, server included, store updated.
 *   - Persistence across calls — the "restart" case reads the store the
 *     previous run wrote.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryServer } from './types.js';
import { fingerprintServer } from './fingerprint.js';
import { applyTofuGate } from './tofu-gate.js';

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

async function readAuditLines(baseDir: string): Promise<Array<Record<string, unknown>>> {
  const p = path.join(baseDir, '.rea', 'audit.jsonl');
  try {
    const raw = await fs.readFile(p, 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe('applyTofuGate', () => {
  let baseDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[];
  const originalAcceptDrift = process.env.REA_ACCEPT_DRIFT;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tofu-gate-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    stderrChunks = [];
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    delete process.env.REA_ACCEPT_DRIFT;
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    if (originalAcceptDrift === undefined) {
      delete process.env.REA_ACCEPT_DRIFT;
    } else {
      process.env.REA_ACCEPT_DRIFT = originalAcceptDrift;
    }
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('first-seen: audit-allowed + stderr block + server accepted + persists fingerprint', async () => {
    const s = server('discord');
    const { accepted, classifications } = await applyTofuGate(baseDir, [s]);
    expect(accepted).toEqual([s]);
    expect(classifications[0]?.verdict).toBe('first-seen');

    const stderr = stderrChunks.join('');
    expect(stderr).toMatch(/NEW DOWNSTREAM SERVER/);
    expect(stderr).toContain('discord');

    const lines = await readAuditLines(baseDir);
    const tofuEntries = lines.filter((l) => l.tool_name === 'rea.tofu');
    expect(tofuEntries).toHaveLength(1);
    expect(tofuEntries[0]?.status).toBe('allowed');
    const meta = tofuEntries[0]?.metadata as Record<string, unknown>;
    expect(meta?.event).toBe('tofu.first_seen');
    expect(meta?.server).toBe('discord');

    // Fingerprint persisted.
    const storeRaw = await fs.readFile(
      path.join(baseDir, '.rea', 'fingerprints.json'),
      'utf8',
    );
    const store = JSON.parse(storeRaw) as { servers: Record<string, string> };
    expect(store.servers.discord).toBe(fingerprintServer(s));
  });

  it('persists across restart: unchanged on second call, silent (no stderr block, no new audit)', async () => {
    const s = server('obsidian');
    await applyTofuGate(baseDir, [s]);
    // Clear side-effect record from the first call.
    stderrChunks.length = 0;
    const linesBefore = await readAuditLines(baseDir);

    const { accepted, classifications } = await applyTofuGate(baseDir, [s]);
    expect(accepted).toEqual([s]);
    expect(classifications[0]?.verdict).toBe('unchanged');
    expect(stderrChunks.join('')).toBe('');
    const linesAfter = await readAuditLines(baseDir);
    // No new TOFU audit entries.
    const newTofu = linesAfter
      .slice(linesBefore.length)
      .filter((l) => l.tool_name === 'rea.tofu');
    expect(newTofu).toHaveLength(0);
  });

  it('drift WITHOUT bypass: audit denied + stderr block + server DROPPED + other servers stay up', async () => {
    const alpha = server('alpha');
    const beta = server('beta');
    // Seed with current fingerprints.
    await applyTofuGate(baseDir, [alpha, beta]);
    stderrChunks.length = 0;

    // Poison `alpha`; leave `beta` alone.
    const poisonedAlpha = server('alpha', { command: 'evil-node' });
    const { accepted, classifications } = await applyTofuGate(baseDir, [
      poisonedAlpha,
      beta,
    ]);

    // Other server stays up.
    expect(accepted.map((s) => s.name)).toEqual(['beta']);
    expect(classifications[0]?.verdict).toBe('drifted');
    expect(classifications[0]?.bypassed).toBe(false);
    expect(classifications[1]?.verdict).toBe('unchanged');

    const stderr = stderrChunks.join('');
    expect(stderr).toMatch(/FINGERPRINT DRIFT/);
    expect(stderr).toContain('alpha');

    const lines = await readAuditLines(baseDir);
    const driftDenied = lines.filter(
      (l) =>
        l.tool_name === 'rea.tofu' &&
        l.status === 'denied' &&
        (l.metadata as Record<string, unknown>)?.event === 'tofu.drift_blocked',
    );
    expect(driftDenied).toHaveLength(1);
  });

  it('drift persists across restart — second boot STILL blocks until accepted', async () => {
    const s = server('mock');
    await applyTofuGate(baseDir, [s]);
    const poisoned = server('mock', { command: 'evil' });
    await applyTofuGate(baseDir, [poisoned]); // first drift
    stderrChunks.length = 0;
    const { accepted, classifications } = await applyTofuGate(baseDir, [poisoned]);
    expect(accepted).toHaveLength(0);
    expect(classifications[0]?.verdict).toBe('drifted');
    expect(stderrChunks.join('')).toMatch(/FINGERPRINT DRIFT/);
  });

  it('drift WITH REA_ACCEPT_DRIFT bypass: accepted + audit allowed with bypassed=true + store updated', async () => {
    const pristine = server('mock');
    await applyTofuGate(baseDir, [pristine]);
    stderrChunks.length = 0;

    const rotated = server('mock', { command: 'new-node' });
    process.env.REA_ACCEPT_DRIFT = 'mock';
    const { accepted, classifications } = await applyTofuGate(baseDir, [rotated]);

    expect(accepted).toEqual([rotated]);
    expect(classifications[0]?.verdict).toBe('drifted');
    expect(classifications[0]?.bypassed).toBe(true);
    expect(stderrChunks.join('')).toMatch(/accepting drift/);

    const lines = await readAuditLines(baseDir);
    const accepted_ = lines.filter(
      (l) =>
        l.tool_name === 'rea.tofu' &&
        (l.metadata as Record<string, unknown>)?.event === 'tofu.drift_accepted',
    );
    expect(accepted_).toHaveLength(1);
    expect((accepted_[0]?.metadata as Record<string, unknown>)?.bypassed).toBe(true);

    // After bypass, the new fingerprint is the stored baseline.
    const storeRaw = await fs.readFile(
      path.join(baseDir, '.rea', 'fingerprints.json'),
      'utf8',
    );
    const store = JSON.parse(storeRaw) as { servers: Record<string, string> };
    expect(store.servers.mock).toBe(fingerprintServer(rotated));
  });

  it('mixed case: first-seen server is accepted alongside a drifted-blocked server in the same boot', async () => {
    // Seed a store with alpha only, then change alpha AND introduce a brand
    // new gamma. Expect: gamma first-seen (accepted, loud block), alpha
    // drifted (blocked, loud block), store updated with gamma's fingerprint,
    // alpha's stored fingerprint preserved.
    const alpha = server('alpha');
    await applyTofuGate(baseDir, [alpha]);
    stderrChunks.length = 0;

    const poisonedAlpha = server('alpha', { command: 'evil' });
    const gamma = server('gamma');
    const { accepted, classifications } = await applyTofuGate(baseDir, [
      poisonedAlpha,
      gamma,
    ]);

    expect(accepted.map((s) => s.name)).toEqual(['gamma']);
    const byName = Object.fromEntries(classifications.map((c) => [c.server, c]));
    expect(byName.alpha?.verdict).toBe('drifted');
    expect(byName.alpha?.bypassed).toBe(false);
    expect(byName.gamma?.verdict).toBe('first-seen');

    const stderr = stderrChunks.join('');
    expect(stderr).toMatch(/FINGERPRINT DRIFT/);
    expect(stderr).toMatch(/NEW DOWNSTREAM SERVER/);

    // Store: gamma recorded, alpha's original stored fingerprint preserved.
    const storeRaw = await fs.readFile(
      path.join(baseDir, '.rea', 'fingerprints.json'),
      'utf8',
    );
    const store = JSON.parse(storeRaw) as { servers: Record<string, string> };
    expect(store.servers.gamma).toBe(fingerprintServer(gamma));
    expect(store.servers.alpha).toBe(fingerprintServer(alpha));
    expect(store.servers.alpha).not.toBe(fingerprintServer(poisonedAlpha));
  });

  it('REA_ACCEPT_DRIFT is single-shot: on next call without the env var, drift re-blocks', async () => {
    // This test enforces the "single-shot bypass" contract: the env var is
    // the ONLY bypass channel. After the bypass is consumed, the new
    // fingerprint becomes the stored baseline (so `unchanged` follows), but
    // a subsequent real drift with no env var must block again.
    const pristine = server('mock');
    await applyTofuGate(baseDir, [pristine]);

    const rotated = server('mock', { command: 'first-rotation' });
    process.env.REA_ACCEPT_DRIFT = 'mock';
    await applyTofuGate(baseDir, [rotated]);

    delete process.env.REA_ACCEPT_DRIFT;
    const secondRotation = server('mock', { command: 'second-rotation' });
    stderrChunks.length = 0;
    const { accepted, classifications } = await applyTofuGate(baseDir, [
      secondRotation,
    ]);
    expect(classifications[0]?.verdict).toBe('drifted');
    expect(classifications[0]?.bypassed).toBe(false);
    expect(accepted).toHaveLength(0);
    expect(stderrChunks.join('')).toMatch(/FINGERPRINT DRIFT/);
  });
});
