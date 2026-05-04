/**
 * TOFU fingerprint store — persisted trust anchors for each downstream
 * server declared in `.rea/registry.yaml`.
 *
 * Stored at `.rea/fingerprints.json`. Versioned schema (currently `"1"`)
 * so we can migrate shape without a surprise parse failure on upgrade.
 *
 * ## Format
 *
 * ```json
 * {
 *   "version": "1",
 *   "servers": {
 *     "discord-ops": "a3f4...",
 *     "obsidian":    "b1c2..."
 *   }
 * }
 * ```
 *
 * ## Corruption policy
 *
 * A missing file is the **first-run** state. An unparseable or
 * schema-invalid file is NOT silently ignored: the loader throws. The
 * gateway treats that as a fail-closed signal — refuse to start rather than
 * reset TOFU state, which would downgrade a real attack to a first-seen
 * acceptance. The operator can delete the file deliberately to re-bootstrap.
 *
 * ## Concurrency
 *
 * Writes use an atomic `write → rename` pattern to avoid torn reads. The
 * gateway is the only writer in normal operation (startup TOFU check),
 * so we do not take a file lock — two concurrent `rea serve` processes
 * in the same repo is not a supported state.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const FINGERPRINTS_FILE = 'fingerprints.json';
const REA_DIR = '.rea';

export const FINGERPRINT_STORE_VERSION = '1';

const FingerprintStoreSchema = z
  .object({
    version: z.literal(FINGERPRINT_STORE_VERSION),
    servers: z.record(
      z.string().regex(/^[a-f0-9]{64}$/, 'fingerprint must be lowercase hex sha256'),
    ),
  })
  .strict();

export type FingerprintStore = z.infer<typeof FingerprintStoreSchema>;

function storePathFor(baseDir: string): string {
  return path.join(baseDir, REA_DIR, FINGERPRINTS_FILE);
}

/**
 * Load the fingerprint store. Returns an empty store if the file does not
 * exist (first-run). Throws on unreadable or schema-invalid files — do NOT
 * catch and treat as first-run, that would let an attacker who corrupts the
 * file downgrade a drift event to first-seen acceptance.
 */
export async function loadFingerprintStore(baseDir: string): Promise<FingerprintStore> {
  const filePath = storePathFor(baseDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: FINGERPRINT_STORE_VERSION, servers: {} };
    }
    throw new Error(
      `failed to read fingerprint store at ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `fingerprint store at ${filePath} is not valid JSON — delete the file to re-bootstrap TOFU if this is intentional: ${err instanceof Error ? err.message : err}`,
    );
  }

  const result = FingerprintStoreSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `fingerprint store at ${filePath} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Persist the fingerprint store. Writes to a sibling `.new` file then
 * renames into place so a crashed process never leaves a half-written store
 * that would fail to parse on next boot.
 */
export async function saveFingerprintStore(
  baseDir: string,
  store: FingerprintStore,
): Promise<void> {
  const filePath = storePathFor(baseDir);
  const tmpPath = `${filePath}.new`;
  await fs.mkdir(path.join(baseDir, REA_DIR), { recursive: true });

  // Validate before write — a malformed in-memory store should never be
  // persisted. The parse is cheap and catches bugs in the classify layer.
  FingerprintStoreSchema.parse(store);

  const serialized = JSON.stringify(store, null, 2) + '\n';
  await fs.writeFile(tmpPath, serialized, 'utf8');
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the orphaned .new file so a retry doesn't
    // accumulate cruft. If the unlink itself fails, swallow — the original
    // rename error is the one the caller needs to see.
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

export { FingerprintStoreSchema, storePathFor as __fingerprintStorePathForTests };
