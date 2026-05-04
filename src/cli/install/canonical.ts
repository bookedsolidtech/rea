/**
 * G12 — Canonical file enumeration.
 *
 * Single source of truth for "what ships in this rea version". Used by:
 *   - `rea init`      — to record SHAs of what was installed
 *   - `rea upgrade`   — to classify consumer files (new/unmodified/drifted/removed)
 *   - `rea doctor --drift` — to report drift without mutating
 *
 * The function walks `PKG_ROOT/{hooks,agents,commands,.husky}` at runtime.
 * Mirrors the layout in `copy.ts` but is pure enumeration — no writes, no
 * symlink guards (those live on the write side).
 */

import type fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { PKG_ROOT } from '../utils.js';
import type { SourceKind } from './manifest-schema.js';

export interface CanonicalFile {
  /** Absolute path to the source file inside PKG_ROOT. */
  sourceAbsPath: string;
  /** POSIX-normalized consumer-relative destination path (what goes in the manifest `path`). */
  destRelPath: string;
  source: SourceKind;
  /** Desired mode at install; hooks get 0o755, everything else 0o644. */
  mode: number;
}

interface DirMapping {
  srcDir: string;
  dstPrefix: string;
  source: SourceKind;
  mode: number;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

async function walkFiles(srcDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      // `Dirent.isFile()` / `isDirectory()` return false for symlinks when
      // `readdir` is called with `withFileTypes: true` — the link would be
      // silently dropped from enumeration. That is exactly the primitive a
      // supply-chain attacker would exploit: planting a symlink at
      // `.husky/pre-push` in the published tarball causes the canonical set
      // to lose the hook, which in turn causes `rea upgrade` to classify the
      // consumer's on-disk copy as `removed-upstream` and prompt to delete
      // it. Refuse loudly instead.
      if (entry.isSymbolicLink()) {
        throw new Error(
          `canonical source contains symlink at ${abs} — refusing to enumerate; ` +
            `audit the package tree before shipping.`,
        );
      }
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
      // sockets, FIFOs, devices silently ignored — they cannot originate
      // from a tarball so their presence is an operational anomaly, not a
      // security event.
    }
  }
  await walk(srcDir);
  out.sort();
  return out;
}

/**
 * Enumerate every file this rea version installs. Ordering is stable (sorted
 * by absolute source path) so manifests are deterministic across runs.
 *
 * The `.husky/` mapping only emits files actually present in the packaged
 * `.husky/` directory — so when a new hook ships (e.g. `pre-push`) it
 * automatically becomes part of the upgrade surface without code changes.
 */
export async function enumerateCanonicalFiles(
  pkgRoot: string = PKG_ROOT,
): Promise<CanonicalFile[]> {
  const mappings: DirMapping[] = [
    {
      srcDir: path.join(pkgRoot, 'hooks'),
      dstPrefix: '.claude/hooks',
      source: 'hook',
      mode: 0o755,
    },
    {
      srcDir: path.join(pkgRoot, 'agents'),
      dstPrefix: '.claude/agents',
      source: 'agent',
      mode: 0o644,
    },
    {
      srcDir: path.join(pkgRoot, 'commands'),
      dstPrefix: '.claude/commands',
      source: 'command',
      mode: 0o644,
    },
    { srcDir: path.join(pkgRoot, '.husky'), dstPrefix: '.husky', source: 'husky', mode: 0o755 },
  ];
  const out: CanonicalFile[] = [];
  for (const m of mappings) {
    const files = await walkFiles(m.srcDir);
    for (const abs of files) {
      const rel = path.relative(m.srcDir, abs);
      out.push({
        sourceAbsPath: abs,
        destRelPath: toPosix(path.join(m.dstPrefix, rel)),
        source: m.source,
        mode: m.mode,
      });
    }
  }
  return out;
}

/**
 * Synthetic canonical entry for the managed CLAUDE.md fragment. Hashed
 * separately via `sha256OfBuffer(fragment)` because the SHA tracks fragment
 * content, not the full CLAUDE.md (consumer owns the rest of the file).
 */
export const CLAUDE_MD_MANIFEST_PATH = 'CLAUDE.md#rea:managed:v1';

/**
 * Synthetic canonical entry for the rea-owned subset of `.claude/settings.json`.
 * The SHA tracks what we own (the desired hooks) — never the full file, so a
 * consumer adding their own hook entries does not register as drift.
 */
export const SETTINGS_MANIFEST_PATH = '.claude/settings.json#rea:desired';
