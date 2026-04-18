/**
 * Atomic read/write for `.rea/install-manifest.json` (G12).
 *
 * Write uses the three-file dance in `fs-safe.atomicReplaceFile` so that a
 * Windows rename-retry never leaves the user with *no* manifest — there is
 * always either `install-manifest.json` or `install-manifest.json.bak` on
 * disk to recover from.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { atomicReplaceFile } from './fs-safe.js';
import {
  InstallManifestSchema,
  MANIFEST_RELPATH,
  serializeManifest,
  type InstallManifest,
} from './manifest-schema.js';

function manifestPath(baseDir: string): string {
  return path.join(baseDir, MANIFEST_RELPATH);
}

export function manifestExists(baseDir: string): boolean {
  return fs.existsSync(manifestPath(baseDir));
}

export async function readManifest(baseDir: string): Promise<InstallManifest | null> {
  const filePath = manifestPath(baseDir);
  if (!fs.existsSync(filePath)) return null;
  const raw = await fsPromises.readFile(filePath, 'utf8');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `install manifest is not valid JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Delete \`.rea/install-manifest.json\` and run \`rea upgrade\` to rebuild from current disk state.`,
    );
  }
  const parsed = InstallManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `invalid install manifest at ${filePath}: ${parsed.error.message}. ` +
        `Delete \`.rea/install-manifest.json\` and run \`rea upgrade\` to rebuild.`,
    );
  }
  return parsed.data;
}

export async function writeManifestAtomic(
  baseDir: string,
  manifest: InstallManifest,
): Promise<string> {
  const filePath = manifestPath(baseDir);
  await atomicReplaceFile(filePath, serializeManifest(manifest));
  return filePath;
}
