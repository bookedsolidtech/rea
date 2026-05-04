/**
 * TOFU store — first-write, update, schema mismatch, corrupt-file behavior.
 *
 * Corruption MUST throw, not silently reset. A silent reset is a downgrade
 * attack: an attacker who can corrupt the store could clear it and force
 * every drifted server back into "first-seen" acceptance.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FINGERPRINT_STORE_VERSION,
  FingerprintStoreSchema,
  __fingerprintStorePathForTests,
  loadFingerprintStore,
  saveFingerprintStore,
  type FingerprintStore,
} from './fingerprints-store.js';

const VALID_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

describe('fingerprints-store', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-fp-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('loads empty store when file is missing (first run)', async () => {
    const store = await loadFingerprintStore(baseDir);
    expect(store.version).toBe(FINGERPRINT_STORE_VERSION);
    expect(store.servers).toEqual({});
  });

  it('round-trips a single-server store', async () => {
    const written: FingerprintStore = {
      version: FINGERPRINT_STORE_VERSION,
      servers: { discord: VALID_SHA },
    };
    await saveFingerprintStore(baseDir, written);
    const read = await loadFingerprintStore(baseDir);
    expect(read).toEqual(written);
  });

  it('overwrites on re-save (update path)', async () => {
    await saveFingerprintStore(baseDir, {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: VALID_SHA },
    });
    await saveFingerprintStore(baseDir, {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: OTHER_SHA },
    });
    const read = await loadFingerprintStore(baseDir);
    expect(read.servers.mock).toBe(OTHER_SHA);
  });

  it('throws on unparseable JSON (does NOT silently reset — downgrade guard)', async () => {
    const filePath = __fingerprintStorePathForTests(baseDir);
    await fs.writeFile(filePath, 'this is not json {{{', 'utf8');
    await expect(loadFingerprintStore(baseDir)).rejects.toThrow(/not valid JSON/);
  });

  it('throws on schema mismatch (wrong version)', async () => {
    const filePath = __fingerprintStorePathForTests(baseDir);
    await fs.writeFile(filePath, JSON.stringify({ version: '0', servers: {} }), 'utf8');
    await expect(loadFingerprintStore(baseDir)).rejects.toThrow(/schema validation/);
  });

  it('throws on non-sha256 fingerprint values', async () => {
    const filePath = __fingerprintStorePathForTests(baseDir);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: FINGERPRINT_STORE_VERSION,
        servers: { mock: 'not-a-sha' },
      }),
      'utf8',
    );
    await expect(loadFingerprintStore(baseDir)).rejects.toThrow(/schema validation/);
  });

  it('refuses to persist a malformed in-memory store', async () => {
    const bad = {
      version: '1',
      servers: { mock: 'not-hex' },
    } as unknown as FingerprintStore;
    await expect(saveFingerprintStore(baseDir, bad)).rejects.toThrow();
  });

  it('writes atomically via .new + rename (no torn reads)', async () => {
    // Write a good file, then try to save again; at no point should the
    // canonical path be missing or half-written.
    await saveFingerprintStore(baseDir, {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: VALID_SHA },
    });
    const filePath = __fingerprintStorePathForTests(baseDir);
    await saveFingerprintStore(baseDir, {
      version: FINGERPRINT_STORE_VERSION,
      servers: { mock: OTHER_SHA },
    });
    // After save, no lingering `.new` sibling.
    await expect(fs.stat(`${filePath}.new`)).rejects.toHaveProperty('code', 'ENOENT');
    const read = await loadFingerprintStore(baseDir);
    expect(read.servers.mock).toBe(OTHER_SHA);
  });

  it('schema export rejects extra top-level fields (strict)', () => {
    const bad = {
      version: FINGERPRINT_STORE_VERSION,
      servers: {},
      extraneous: true,
    };
    expect(() => FingerprintStoreSchema.parse(bad)).toThrow();
  });
});
