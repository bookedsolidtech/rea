/**
 * G12 — Install manifest schema.
 *
 * `rea init` writes `.rea/install-manifest.json` alongside `.rea/policy.yaml`.
 * `rea upgrade` reads it to classify each canonical shipped file as
 * `unmodified | drifted | removed-upstream` and decide what to do. `rea doctor
 * --drift` uses the same data.
 *
 * The manifest is strict (zod `.strict()`): unknown fields are rejected at load
 * time so a newer rea version writing new fields does not silently get
 * downgraded by an older rea.
 */

import { z } from 'zod';

export const MANIFEST_RELPATH = '.rea/install-manifest.json';

export const SourceKindSchema = z.enum([
  'hook',
  'agent',
  'command',
  'husky',
  'claude-md',
  'settings',
]);

export type SourceKind = z.infer<typeof SourceKindSchema>;

const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase hex sha256');

/**
 * Path validation for manifest entries. The manifest is attacker-controllable
 * (it lives in `.rea/install-manifest.json`, a regular repo file that a
 * compromised PR could mutate), so every entry path must be:
 *
 *   - relative (no leading `/` or drive letter)
 *   - free of `..` segments on either separator
 *   - free of ASCII control characters (including `\x1b` terminal escapes
 *     that could corrupt a doctor/upgrade report display)
 *   - either a canonical install path (plain relative path) or one of two
 *     synthetic entries: `CLAUDE.md#rea:managed:v1`,
 *     `.claude/settings.json#rea:desired`
 *
 * Absolute paths, parent-directory segments, and control chars all throw at
 * load time — before any write or delete runs against the entry.
 */
const ManifestPath = z
  .string()
  .min(1)
  .refine((p) => !/[\x00-\x1f\x7f]/.test(p), 'path contains control characters')
  .refine((p) => {
    // `#` is allowed only for the two synthetic entries (see canonical.ts).
    // Everything else must be a clean relative path with no `#` and no
    // absolute-path leading characters.
    if (p.includes('#')) return true;
    if (/^[A-Za-z]:[\\/]/.test(p)) return false; // windows drive letter
    if (p.startsWith('/') || p.startsWith('\\')) return false;
    const parts = p.split(/[\\/]/);
    return !parts.includes('..');
  }, 'path must be relative and must not contain `..` segments');

export const ManifestEntrySchema = z
  .object({
    path: ManifestPath,
    sha256: Sha256Hex,
    source: SourceKindSchema,
    mode: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const InstallManifestSchema = z
  .object({
    version: z.string().min(1),
    profile: z.string().min(1),
    installed_at: z.string().min(1),
    upgraded_at: z.string().min(1).optional(),
    bootstrap: z.boolean().optional(),
    files: z.array(ManifestEntrySchema),
  })
  .strict();

export type InstallManifest = z.infer<typeof InstallManifestSchema>;

export function parseManifest(raw: unknown): InstallManifest {
  return InstallManifestSchema.parse(raw);
}

export function serializeManifest(manifest: InstallManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}
