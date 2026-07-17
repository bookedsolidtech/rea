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
import { resolveCommonRoot } from '../lib/worktree-roots.js';
import properLockfile from 'proper-lockfile';
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

/**
 * 0.54.0 worktree state: TOFU trust is per-REPOSITORY — the store path
 * resolves to the COMMON (primary-checkout) root regardless of which
 * worktree the caller passed, so `rea tofu accept` in one stream is
 * honored by `rea serve` started from another. Single seam: every
 * caller (tofu CLI, gateway tofu-gate, upgrade) goes through here.
 * Degenerate in plain checkouts.
 */
/**
 * Round-14 P1: the shared (common-root) store makes concurrent
 * read-modify-write across worktrees a lost-update hazard. Every
 * mutation goes through this helper: a proper-lockfile lock on the
 * STORE PATH (its own `<store>.lock` sidecar — deliberately NOT the
 * `.rea/` directory, which is the audit chain's lock target; both TOFU
 * mutation sites also append audit records, so sharing that target
 * would deadlock). Generous bounded acquisition (retry + stale-steal),
 * so contention always serializes; on a genuine lock-infrastructure
 * failure the mutate still runs (fail-loud side effects) but the write
 * is SKIPPED rather than performed unlocked — the caller sees
 * `lockError` and the record re-persists on the next run (round-44 P2).
 */
const STORE_LOCK_OPTIONS: Parameters<typeof properLockfile.lock>[1] = {
  stale: 5_000,
  retries: { retries: 20, factor: 1.4, minTimeout: 10, maxTimeout: 200, randomize: true },
  realpath: false,
};

export async function updateFingerprintStore(
  baseDir: string,
  mutate: (store: FingerprintStore) => FingerprintStore | Promise<FingerprintStore>,
): Promise<{ store: FingerprintStore; lockError?: string }> {
  const filePath = storePathFor(baseDir);
  let release: (() => Promise<void>) | null = null;
  let lockError: string | undefined;
  try {
    // Round-20 P2 (cold start): `realpath: false` already lets the lock
    // target be a not-yet-written fingerprints.json, but the sidecar
    // mkdir still ENOENTs when `.rea/` itself is absent (fresh clone
    // before any store write) — which would silently degrade every
    // first-write to the unlocked fallback and reopen the concurrent
    // cold-start lost-update this lock exists to close.
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    release = await properLockfile.lock(filePath, STORE_LOCK_OPTIONS);
  } catch (e) {
    lockError = e instanceof Error ? e.message : String(e);
  }
  try {
    const store = await loadFingerprintStore(baseDir);
    const next = await mutate(store);
    // Round-44 P2: NEVER persist the shared common-root store unlocked.
    // The `mutate` still ran (its side effects — TOFU first-seen/drift
    // banners + audit records — fire fail-loud per round-32), but on a
    // lock-acquisition failure we SKIP the write rather than clobber a
    // concurrent locked writer's read-modify-write. With the generous
    // retry budget + stale-steal above, contention always serializes;
    // this path is reached only on a genuine lock-infrastructure
    // failure, where the record is simply re-emitted and re-persisted
    // on the next run (a re-prompt, never a silent trust downgrade).
    if (lockError !== undefined) {
      return { store: next, lockError };
    }
    await saveFingerprintStore(baseDir, next);
    return { store: next };
  } finally {
    if (release !== null) {
      try {
        await release();
      } catch {
        /* stale-cleaned — work already durable */
      }
    }
  }
}

function storeRootFor(baseDir: string): string {
  return resolveCommonRoot(baseDir, () => {}).commonRoot;
}

function storePathFor(baseDir: string): string {
  return path.join(storeRootFor(baseDir), REA_DIR, FINGERPRINTS_FILE);
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
  await fs.mkdir(path.join(storeRootFor(baseDir), REA_DIR), { recursive: true });

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
