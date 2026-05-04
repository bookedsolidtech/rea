/**
 * G12 — `rea upgrade`.
 *
 * Classify every canonical shipped file against the consumer's installed copy
 * and the last manifest entry, then act:
 *
 *   - NEW (not in manifest, not on disk) → install the canonical version.
 *   - UNMODIFIED (on-disk SHA matches manifest SHA) → silently overwrite with
 *     canonical version. The consumer never changed it; they get updates for
 *     free.
 *   - DRIFTED (on-disk SHA ≠ manifest SHA) → interactive prompt:
 *       keep | overwrite | diff (show unified diff, then re-prompt)
 *     Non-interactive (`--yes`) defaults to KEEP (safe). `--force` defaults
 *     to OVERWRITE and skips the prompt.
 *   - REMOVED-UPSTREAM (in manifest, no longer canonical) → prompt to delete.
 *     Non-interactive defaults to SKIP; `--force` deletes.
 *
 * After processing, the manifest is rewritten with fresh SHAs + `upgraded_at`.
 *
 * Bootstrap path: if no manifest is found, we record current on-disk SHAs
 * as the baseline and mark `bootstrap: true`. This gives pre-G12 installs a
 * manifest without pretending we know what was originally shipped. The NEXT
 * `rea upgrade` compares against canonical normally.
 *
 * Dogfood caveat: running `rea upgrade` on this repo via a Claude Code
 * session will be blocked by `settings-protection.sh` (`.claude/hooks/*`,
 * `.claude/settings.json`, `.husky/*` all protected from Write/Edit). Invoke
 * `rea upgrade` directly from a terminal outside the Claude Code session.
 * The `rea upgrade` code itself performs writes via node `fs` calls which
 * are not hook-gated — but a Claude Code-hosted Bash invocation is. This is
 * intentional: upgrade is an authorized-human action by design.
 *
 * Security note: every on-disk mutation flows through `safeInstallFile` or
 * `safeDeleteFile` in `install/fs-safe.ts`. Path values that originate from
 * `.rea/install-manifest.json` (attacker-controllable) are validated at
 * schema-load time AND re-validated at each filesystem call. See
 * `install/fs-safe.ts` header for the full TOCTOU argument.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { loadPolicy } from '../policy/loader.js';
import {
  CLAUDE_MD_MANIFEST_PATH,
  SETTINGS_MANIFEST_PATH,
  enumerateCanonicalFiles,
  type CanonicalFile,
} from './install/canonical.js';
import {
  buildFragment,
  extractFragment,
  type ClaudeMdFragmentInput,
} from './install/claude-md.js';
import {
  atomicReplaceFile,
  safeDeleteFile,
  safeInstallFile,
  safeReadFile,
} from './install/fs-safe.js';
import {
  canonicalSettingsSubsetHash,
  defaultDesiredHooks,
  mergeSettings,
  pruneHookCommands,
  readSettings,
  writeSettingsAtomic,
} from './install/settings-merge.js';
import { ensureReaGitignore } from './install/gitignore.js';
import {
  manifestExists,
  readManifest,
  writeManifestAtomic,
} from './install/manifest-io.js';
import {
  type InstallManifest,
  type ManifestEntry,
} from './install/manifest-schema.js';
import { sha256OfBuffer, sha256OfFile } from './install/sha.js';
import { err, getPkgVersion, log, warn } from './utils.js';

export interface UpgradeOptions {
  dryRun?: boolean | undefined;
  yes?: boolean | undefined;
  force?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// 0.11.0 policy migration
// ---------------------------------------------------------------------------

/**
 * Strip 0.10.x review.* fields that 0.11.0 rejects at schema load, and
 * backfill `concerns_blocks: true` if the `review:` block exists without
 * it. Writes a timestamped backup to `.rea/policy.yaml.bak-<ts>` before
 * mutating.
 *
 * Surgical text rewrite, not YAML round-trip. YAML round-tripping loses
 * comments and reformats quoting; operators care about their comments.
 * Line-by-line deletion of the two removed keys keeps every other line
 * byte-identical. This is safe because the keys we strip are simple
 * scalars (`cache_max_age_seconds: 3600`, `allow_skip_in_ci: false`) that
 * cannot span multiple lines in any reasonable policy file.
 */
async function migrateReviewPolicyFor0110(
  resolvedRoot: string,
  opts: { dryRun: boolean },
): Promise<void> {
  const policyPath = path.join(resolvedRoot, '.rea', 'policy.yaml');
  let raw: string;
  try {
    raw = await fsPromises.readFile(policyPath, 'utf8');
  } catch {
    return; // no policy to migrate
  }

  const lines = raw.split(/\r?\n/);
  const REVIEW_RE = /^review:\s*(?:#.*)?$/;
  const REMOVED_KEY_RE = /^(\s+)(cache_max_age_seconds|allow_skip_in_ci):\s*\S.*$/;
  const INDENT_RE = /^(\s+)\S/;

  let reviewStart = -1;
  let reviewIndent = '';
  const linesToDrop = new Set<number>();
  let hasConcernsBlocks = false;
  let reviewChildIndent = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (reviewStart < 0 && REVIEW_RE.test(line.trimEnd())) {
      reviewStart = i;
      const indentMatch = INDENT_RE.exec(line);
      reviewIndent = indentMatch?.[1] ?? '';
      continue;
    }
    if (reviewStart < 0) continue;
    // Inside the review: block as long as indent is deeper than reviewIndent.
    if (line.trim() === '') continue;
    const indentMatch = INDENT_RE.exec(line);
    const lineIndent = indentMatch?.[1] ?? '';
    if (lineIndent.length <= reviewIndent.length) {
      // Left the block.
      break;
    }
    if (reviewChildIndent.length === 0) reviewChildIndent = lineIndent;
    if (/^\s+concerns_blocks:/.test(line)) hasConcernsBlocks = true;
    if (REMOVED_KEY_RE.test(line)) {
      linesToDrop.add(i);
    }
  }

  const addConcernsBlocks = reviewStart >= 0 && !hasConcernsBlocks;
  if (linesToDrop.size === 0 && !addConcernsBlocks) return;

  const newLines: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (linesToDrop.has(i)) continue;
    newLines.push(lines[i] ?? '');
    // Append `concerns_blocks: true` right after the `review:` header line
    // when the block exists but lacks the key.
    if (i === reviewStart && addConcernsBlocks) {
      const indent = reviewChildIndent.length > 0 ? reviewChildIndent : reviewIndent + '  ';
      newLines.push(`${indent}concerns_blocks: true`);
    }
  }
  const updated = newLines.join('\n');

  const droppedSummary: string[] = [];
  if (linesToDrop.size > 0) droppedSummary.push(`dropped ${linesToDrop.size} removed-field line(s)`);
  if (addConcernsBlocks) droppedSummary.push('added concerns_blocks: true');

  if (opts.dryRun) {
    log(`[dry-run] would migrate .rea/policy.yaml: ${droppedSummary.join(', ')}`);
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${policyPath}.bak-${ts}`;
  await fsPromises.copyFile(policyPath, backupPath);
  await atomicReplaceFile(policyPath, updated);
  warn(
    `migrated .rea/policy.yaml for 0.11.0 (${droppedSummary.join(', ')}); backup at ${path.basename(backupPath)}`,
  );
}

type Classification =
  | { kind: 'new'; canonical: CanonicalFile; canonicalSha: string }
  | { kind: 'unmodified'; canonical: CanonicalFile; canonicalSha: string; localSha: string; entry: ManifestEntry }
  | { kind: 'drifted'; canonical: CanonicalFile; canonicalSha: string; localSha: string; entry: ManifestEntry }
  | { kind: 'removed-upstream'; entry: ManifestEntry };

/**
 * Hard cap for `showDiff` reads. Canonical files are all tiny (<64KB) but a
 * consumer could have replaced a hook with a 500MB log; refuse to slurp the
 * whole thing into memory. Above this threshold we emit a truncation notice
 * and decline to produce a diff.
 */
const DIFF_SIZE_CAP_BYTES = 256 * 1024;

/**
 * Read a consumer-side file's SHA-256 *through* the fs-safe containment
 * check. Returns `null` when the file is absent. The path here comes from
 * canonical.destRelPath (trusted, enumerated from PKG_ROOT), but we still
 * run it through `safeReadFile` so every filesystem read in upgrade is
 * uniformly symlink- and containment-guarded.
 */
async function readLocalSha(resolvedRoot: string, relPath: string): Promise<string | null> {
  const buf = await safeReadFile(resolvedRoot, relPath);
  if (buf === null) return null;
  return sha256OfBuffer(buf);
}

function showDiff(resolvedRoot: string, canonical: CanonicalFile): void {
  const dst = path.join(resolvedRoot, canonical.destRelPath);
  let localStat: fs.Stats;
  try {
    localStat = fs.statSync(dst);
  } catch {
    console.log('');
    console.log(`  (diff unavailable — ${canonical.destRelPath} disappeared)`);
    console.log('');
    return;
  }
  const canonicalStat = fs.statSync(canonical.sourceAbsPath);
  if (localStat.size > DIFF_SIZE_CAP_BYTES || canonicalStat.size > DIFF_SIZE_CAP_BYTES) {
    console.log('');
    console.log(
      `  (diff suppressed — ${canonical.destRelPath} exceeds ${DIFF_SIZE_CAP_BYTES} bytes; compare manually)`,
    );
    console.log('');
    return;
  }
  const localBytes = fs.readFileSync(dst, 'utf8');
  const canonicalBytes = fs.readFileSync(canonical.sourceAbsPath, 'utf8');
  const localLines = localBytes.split('\n');
  const canonicalLines = canonicalBytes.split('\n');
  console.log('');
  console.log(`--- local: ${canonical.destRelPath}`);
  console.log(`+++ canonical (rea v${getPkgVersion()})`);
  console.log('');
  // Minimal unified-diff-ish output: line-by-line replace. Full diff requires
  // an LCS implementation; for our purposes, showing both halves and a simple
  // line-counter is enough to let a human decide.
  const max = Math.max(localLines.length, canonicalLines.length);
  let changes = 0;
  for (let i = 0; i < max && changes < 80; i++) {
    const a = localLines[i];
    const b = canonicalLines[i];
    if (a !== b) {
      if (a !== undefined) console.log(`- ${a}`);
      if (b !== undefined) console.log(`+ ${b}`);
      changes += 1;
    }
  }
  if (changes >= 80) console.log('... (diff truncated at 80 changed lines)');
  console.log('');
}

type DriftDecision = 'keep' | 'overwrite';

async function promptDriftDecision(
  resolvedRoot: string,
  canonical: CanonicalFile,
  opts: UpgradeOptions,
): Promise<DriftDecision> {
  if (opts.force === true) return 'overwrite';
  if (opts.yes === true) return 'keep';

  while (true) {
    const choice = await p.select<'keep' | 'overwrite' | 'diff'>({
      message: `${canonical.destRelPath} — locally modified`,
      initialValue: 'keep',
      options: [
        { value: 'keep', label: 'keep', hint: 'leave your version untouched (default)' },
        { value: 'overwrite', label: 'overwrite', hint: `replace with canonical (rea v${getPkgVersion()})` },
        { value: 'diff', label: 'diff', hint: 'show diff, then re-prompt' },
      ],
    });
    if (p.isCancel(choice)) return 'keep';
    if (choice === 'diff') {
      showDiff(resolvedRoot, canonical);
      continue;
    }
    return choice;
  }
}

async function promptRemovedDecision(
  relPath: string,
  opts: UpgradeOptions,
): Promise<'delete' | 'skip'> {
  if (opts.force === true) return 'delete';
  if (opts.yes === true) return 'skip';
  const answer = await p.select<'delete' | 'skip'>({
    message: `${relPath} — no longer shipped by rea`,
    initialValue: 'skip',
    options: [
      { value: 'skip', label: 'skip', hint: 'keep the file (default)' },
      { value: 'delete', label: 'delete', hint: 'remove it' },
    ],
  });
  if (p.isCancel(answer)) return 'skip';
  return answer;
}

async function classifyFiles(
  resolvedRoot: string,
  canonicalFiles: CanonicalFile[],
  manifest: InstallManifest | null,
): Promise<{ classifications: Classification[]; shaByPath: Map<string, string> }> {
  const manifestByPath = new Map<string, ManifestEntry>();
  if (manifest !== null) {
    for (const e of manifest.files) manifestByPath.set(e.path, e);
  }

  const canonicalByPath = new Map<string, CanonicalFile>();
  for (const c of canonicalFiles) canonicalByPath.set(c.destRelPath, c);

  const classifications: Classification[] = [];
  const shaByPath = new Map<string, string>();

  for (const canonical of canonicalFiles) {
    const canonicalSha = await sha256OfFile(canonical.sourceAbsPath);
    shaByPath.set(canonical.destRelPath, canonicalSha);
    const localSha = await readLocalSha(resolvedRoot, canonical.destRelPath);
    const entry = manifestByPath.get(canonical.destRelPath);
    if (localSha === null) {
      classifications.push({ kind: 'new', canonical, canonicalSha });
      continue;
    }
    if (entry === undefined) {
      // File exists locally but not in manifest — treat as drift against
      // canonical (bootstrap-equivalent for this single file).
      if (localSha === canonicalSha) {
        classifications.push({
          kind: 'unmodified',
          canonical,
          canonicalSha,
          localSha,
          entry: { path: canonical.destRelPath, sha256: canonicalSha, source: canonical.source },
        });
      } else {
        classifications.push({
          kind: 'drifted',
          canonical,
          canonicalSha,
          localSha,
          entry: { path: canonical.destRelPath, sha256: localSha, source: canonical.source },
        });
      }
      continue;
    }
    if (localSha === entry.sha256) {
      classifications.push({ kind: 'unmodified', canonical, canonicalSha, localSha, entry });
    } else {
      classifications.push({ kind: 'drifted', canonical, canonicalSha, localSha, entry });
    }
  }

  // Removed-upstream: in manifest but not in canonical set.
  if (manifest !== null) {
    for (const entry of manifest.files) {
      if (
        entry.path === CLAUDE_MD_MANIFEST_PATH ||
        entry.path === SETTINGS_MANIFEST_PATH
      ) {
        continue; // synthetic entries handled separately
      }
      if (!canonicalByPath.has(entry.path)) {
        classifications.push({ kind: 'removed-upstream', entry });
      }
    }
  }

  return { classifications, shaByPath };
}

function summarize(classifications: Classification[]): {
  new_: number;
  unmodified: number;
  drifted: number;
  removedUpstream: number;
} {
  const counts = { new_: 0, unmodified: 0, drifted: 0, removedUpstream: 0 };
  for (const c of classifications) {
    if (c.kind === 'new') counts.new_ += 1;
    else if (c.kind === 'unmodified') counts.unmodified += 1;
    else if (c.kind === 'drifted') counts.drifted += 1;
    else if (c.kind === 'removed-upstream') counts.removedUpstream += 1;
  }
  return counts;
}

function readPolicyForFragment(baseDir: string): ClaudeMdFragmentInput | null {
  try {
    const policy = loadPolicy(baseDir);
    return {
      policyPath: '.rea/policy.yaml',
      profile: policy.profile,
      autonomyLevel: policy.autonomy_level,
      maxAutonomyLevel: policy.max_autonomy_level,
      blockedPathsCount: policy.blocked_paths.length,
      blockAiAttribution: policy.block_ai_attribution,
    };
  } catch {
    return null;
  }
}

async function upgradeClaudeMdFragment(
  resolvedRoot: string,
  opts: UpgradeOptions,
): Promise<{ sha: string | null; action: 'written' | 'skipped' | 'unchanged' }> {
  const fragmentInput = readPolicyForFragment(resolvedRoot);
  if (fragmentInput === null) return { sha: null, action: 'skipped' };
  const newFragment = buildFragment(fragmentInput);
  const newSha = sha256OfBuffer(newFragment);
  const claudeMdPath = path.join(resolvedRoot, 'CLAUDE.md');

  if (!fs.existsSync(claudeMdPath)) {
    if (opts.dryRun === true) return { sha: newSha, action: 'written' };
    await atomicReplaceFile(claudeMdPath, `# CLAUDE.md\n\n${newFragment}\n`);
    return { sha: newSha, action: 'written' };
  }

  const existing = await fsPromises.readFile(claudeMdPath, 'utf8');
  const currentFragment = extractFragment(existing);
  if (currentFragment === newFragment) return { sha: newSha, action: 'unchanged' };
  if (opts.dryRun === true) return { sha: newSha, action: 'written' };

  let next: string;
  if (currentFragment !== null) {
    next = existing.replace(currentFragment, newFragment);
  } else {
    // No markers present — append fragment, preserving existing file content.
    const trailer = existing.endsWith('\n') ? '' : '\n';
    next = `${existing}${trailer}\n${newFragment}\n`;
  }
  await atomicReplaceFile(claudeMdPath, next);
  return { sha: newSha, action: 'written' };
}

/**
 * Hook commands deleted in 0.11.0. `upgradeSettings` prunes any entries
 * whose `command` string contains one of these tokens so consumer
 * `.claude/settings.json` files don't keep invoking missing scripts
 * (which would fail every matched tool call until the operator edited
 * settings by hand).
 *
 * 0.11.0 removals:
 *   - push-review-gate.sh        (replaced by husky stub → rea hook push-gate)
 *   - commit-review-gate.sh      (intentionally unregistered; source-of-truth deleted)
 *   - push-review-gate-git.sh    (native-git adapter; deleted)
 *
 * Add future removals here rather than baking the list into
 * `pruneHookCommands` itself — the removal list is release history,
 * not a static setting.
 */
const STALE_HOOK_COMMAND_TOKENS: readonly string[] = [
  'push-review-gate.sh',
  'commit-review-gate.sh',
  'push-review-gate-git.sh',
];

async function upgradeSettings(
  baseDir: string,
  opts: UpgradeOptions,
): Promise<{
  sha: string;
  addedCount: number;
  skippedCount: number;
  removedCount: number;
  warnings: string[];
}> {
  const desired = defaultDesiredHooks();
  const sha = canonicalSettingsSubsetHash(desired);
  const { settings, settingsPath } = readSettings(baseDir);
  // PRUNE FIRST (remove 0.11.0-deleted hook references), THEN MERGE
  // (add any new hooks). Order matters: merging first would re-add the
  // stale entry only to have the prune re-delete it on the next line —
  // pointless work. Pruning first means the merge sees a clean baseline.
  const pruned = pruneHookCommands(settings, STALE_HOOK_COMMAND_TOKENS);
  const mergeResult = mergeSettings(pruned.merged, desired);
  if (opts.dryRun !== true) {
    await writeSettingsAtomic(settingsPath, mergeResult.merged);
  }
  const warnings = [...mergeResult.warnings];
  if (pruned.removedCount > 0) {
    warnings.push(
      `pruned ${pruned.removedCount} stale 0.10.x hook entr${
        pruned.removedCount === 1 ? 'y' : 'ies'
      } from .claude/settings.json (removed in 0.11.0)`,
    );
  }
  return {
    sha,
    addedCount: mergeResult.addedCount,
    skippedCount: mergeResult.skippedCount,
    removedCount: pruned.removedCount,
    warnings,
  };
}

/** Re-hash a file we just wrote. Source and on-disk bytes should match, but
 * we record the *installed* SHA so a disk-level corruption would be visible
 * on the next run rather than papered over by the source SHA. */
async function hashInstalled(resolvedRoot: string, relPath: string): Promise<string> {
  const buf = await safeReadFile(resolvedRoot, relPath);
  if (buf === null) {
    throw new Error(`post-install verification failed: ${relPath} not readable after write`);
  }
  return sha256OfBuffer(buf);
}

export async function runUpgrade(options: UpgradeOptions = {}): Promise<void> {
  const baseDir = process.cwd();
  const dryRun = options.dryRun === true;

  if (!fs.existsSync(path.join(baseDir, '.rea'))) {
    err('no .rea/ directory — run `rea init` first.');
    process.exit(1);
  }

  // Resolve the install root once so every filesystem op below uses a single
  // trusted anchor. `safeInstallFile` / `safeDeleteFile` / `safeReadFile` all
  // require this to enforce containment.
  const resolvedRoot = await fsPromises.realpath(baseDir);

  if (options.force === true && !dryRun) {
    warn(
      '--force: overwriting locally-modified files and deleting removed-upstream entries without prompt.',
    );
  }

  // 0.11.0 migration — strip removed review.* fields and backfill the new
  // concerns_blocks default. Runs before canonical file reconciliation so a
  // policy that fails strict schema load (which happens on upgrade from
  // 0.10.x the moment we re-read `.rea/policy.yaml`) is cleaned up first.
  await migrateReviewPolicyFor0110(resolvedRoot, { dryRun });

  const canonicalFiles = await enumerateCanonicalFiles();
  if (canonicalFiles.length === 0) {
    err('no canonical files found in package — is the build complete?');
    process.exit(1);
  }

  const existingManifest = manifestExists(resolvedRoot) ? await readManifest(resolvedRoot) : null;
  const isBootstrap = existingManifest === null;

  log(
    `Upgrade — target ${resolvedRoot}${dryRun ? ' (dry run)' : ''}${isBootstrap ? ' — bootstrap mode' : ''}`,
  );
  console.log('');

  const { classifications } = await classifyFiles(resolvedRoot, canonicalFiles, existingManifest);
  const counts = summarize(classifications);
  console.log(
    `  ${counts.new_} new, ${counts.unmodified} auto-update, ${counts.drifted} drifted, ${counts.removedUpstream} removed-upstream`,
  );
  console.log('');

  const applied: Classification[] = [];
  const skipped: Classification[] = [];
  const errors: string[] = [];

  const finalFileEntries: ManifestEntry[] = [];

  for (const c of classifications) {
    if (c.kind === 'new') {
      console.log(`  + ${c.canonical.destRelPath}`);
      if (!dryRun) {
        await safeInstallFile({
          srcAbsPath: c.canonical.sourceAbsPath,
          resolvedRoot,
          destRelPath: c.canonical.destRelPath,
          mode: c.canonical.mode,
        });
      }
      const installedSha = dryRun
        ? c.canonicalSha
        : await hashInstalled(resolvedRoot, c.canonical.destRelPath);
      applied.push(c);
      finalFileEntries.push({
        path: c.canonical.destRelPath,
        sha256: installedSha,
        source: c.canonical.source,
      });
    } else if (c.kind === 'unmodified') {
      if (c.canonicalSha === c.localSha) {
        // Already identical to canonical. Record the verified local SHA —
        // no write performed.
        finalFileEntries.push({
          path: c.canonical.destRelPath,
          sha256: c.localSha,
          source: c.canonical.source,
        });
        continue;
      }
      // Consumer file matches the OLD manifest (untouched since last install) —
      // safe to auto-update to the new canonical version.
      console.log(`  ~ ${c.canonical.destRelPath} (auto-update)`);
      if (!dryRun) {
        await safeInstallFile({
          srcAbsPath: c.canonical.sourceAbsPath,
          resolvedRoot,
          destRelPath: c.canonical.destRelPath,
          mode: c.canonical.mode,
        });
      }
      const installedSha = dryRun
        ? c.canonicalSha
        : await hashInstalled(resolvedRoot, c.canonical.destRelPath);
      applied.push(c);
      finalFileEntries.push({
        path: c.canonical.destRelPath,
        sha256: installedSha,
        source: c.canonical.source,
      });
    } else if (c.kind === 'drifted') {
      const decision = dryRun
        ? 'keep'
        : await promptDriftDecision(resolvedRoot, c.canonical, options);
      if (decision === 'overwrite') {
        console.log(`  ~ ${c.canonical.destRelPath} (overwrite)`);
        if (!dryRun) {
          await safeInstallFile({
            srcAbsPath: c.canonical.sourceAbsPath,
            resolvedRoot,
            destRelPath: c.canonical.destRelPath,
            mode: c.canonical.mode,
          });
        }
        const installedSha = dryRun
          ? c.canonicalSha
          : await hashInstalled(resolvedRoot, c.canonical.destRelPath);
        applied.push(c);
        finalFileEntries.push({
          path: c.canonical.destRelPath,
          sha256: installedSha,
          source: c.canonical.source,
        });
      } else {
        console.log(`  · ${c.canonical.destRelPath} (kept; local modifications preserved)`);
        warn(`DRIFT: ${c.canonical.destRelPath} differs from canonical — local version kept`);
        skipped.push(c);
        finalFileEntries.push({
          path: c.canonical.destRelPath,
          sha256: c.localSha,
          source: c.canonical.source,
        });
      }
    } else if (c.kind === 'removed-upstream') {
      const decision = dryRun
        ? 'skip'
        : await promptRemovedDecision(c.entry.path, options);
      if (decision === 'delete') {
        console.log(`  - ${c.entry.path} (deleted)`);
        if (!dryRun) {
          // Path originates from the manifest (attacker-controllable). The
          // ManifestPath zod refinement already rejected `..`, absolute
          // paths, and control chars at parse time; `safeDeleteFile` adds
          // symlink refusal + containment re-check for defence in depth.
          await safeDeleteFile(resolvedRoot, c.entry.path);
        }
        applied.push(c);
        // Drop from manifest.
      } else {
        console.log(`  · ${c.entry.path} (kept; no longer shipped)`);
        skipped.push(c);
        finalFileEntries.push(c.entry);
      }
    }
  }

  // Synthetic entries: settings + claude-md fragment.
  const settingsResult = await upgradeSettings(resolvedRoot, options);
  if (settingsResult.addedCount > 0) {
    console.log(
      `  ~ .claude/settings.json (${settingsResult.addedCount} hook entries added, ${settingsResult.skippedCount} already present)`,
    );
  } else {
    console.log(
      `  · .claude/settings.json (${settingsResult.skippedCount} rea entries already present)`,
    );
  }
  for (const w of settingsResult.warnings) warn(w);
  finalFileEntries.push({
    path: SETTINGS_MANIFEST_PATH,
    sha256: settingsResult.sha,
    source: 'settings',
  });

  const mdResult = await upgradeClaudeMdFragment(resolvedRoot, options);
  if (mdResult.sha !== null) {
    if (mdResult.action === 'written') console.log(`  ~ CLAUDE.md (managed fragment updated)`);
    else if (mdResult.action === 'unchanged') console.log(`  · CLAUDE.md (fragment unchanged)`);
    finalFileEntries.push({
      path: CLAUDE_MD_MANIFEST_PATH,
      sha256: mdResult.sha,
      source: 'claude-md',
    });
  }

  // BUG-010 — ensure `.gitignore` carries every runtime artifact entry. This
  // backfills older installs that predate the scaffolding in `rea init`. A
  // consumer who upgraded from 0.3.x/0.4.0 was previously seeing
  // `.rea/fingerprints.json` show up as an untracked file; this closes the
  // loop without touching operator-authored gitignore lines.
  if (!dryRun) {
    const gi = await ensureReaGitignore(resolvedRoot);
    if (gi.action === 'created') {
      console.log(`  + ${path.relative(resolvedRoot, gi.path)} (managed block written)`);
    } else if (gi.action === 'updated') {
      console.log(
        `  ~ ${path.relative(resolvedRoot, gi.path)} (managed block ${gi.addedEntries.length} entr${gi.addedEntries.length === 1 ? 'y' : 'ies'} added)`,
      );
    } else {
      console.log(`  · ${path.relative(resolvedRoot, gi.path)} (managed block up to date)`);
    }
    for (const w of gi.warnings) warn(w);
  }

  if (dryRun) {
    console.log('');
    log('dry run — no changes written.');
    const planned =
      counts.new_ + counts.drifted + counts.removedUpstream +
      (classifications.some((c) => c.kind === 'unmodified' && c.canonicalSha !== c.localSha)
        ? classifications.filter((c) => c.kind === 'unmodified' && c.canonicalSha !== c.localSha).length
        : 0);
    console.log(`  ${planned} file action(s) planned.`);
    return;
  }

  const now = new Date().toISOString();
  const installedAt = existingManifest?.installed_at ?? now;
  // 0.18.0 helix-020 G6 fix: pre-fix the upgrade path read profile from
  // the existing manifest only — and pre-0.2.0 manifests recorded
  // `"unknown"` as a placeholder. Every subsequent `rea upgrade` then
  // re-stamped `"unknown"` forever. Authoritative source for the
  // profile is `.rea/policy.yaml`; the manifest is a derivative
  // record. Read policy first; fall back to existing manifest only
  // when policy load fails (covers the bootstrap case where the
  // manifest exists but policy is malformed).
  let profile: string;
  try {
    const livePolicy = loadPolicy(resolvedRoot);
    profile = livePolicy.profile;
  } catch {
    profile = existingManifest?.profile ?? 'unknown';
  }
  const freshManifest: InstallManifest = {
    version: getPkgVersion(),
    profile,
    installed_at: installedAt,
    upgraded_at: now,
    ...(isBootstrap ? { bootstrap: true } : {}),
    files: finalFileEntries,
  };
  const manifestPath = await writeManifestAtomic(resolvedRoot, freshManifest);

  console.log('');
  log(
    `upgrade complete — ${applied.length} applied, ${skipped.length} skipped, ${errors.length} errors`,
  );
  console.log(`  manifest: ${path.relative(resolvedRoot, manifestPath)} (v${freshManifest.version})`);
  if (isBootstrap) {
    console.log('');
    console.log(
      'Bootstrap mode: existing files were recorded as-is. The next `rea upgrade`',
    );
    console.log(
      'will compare against the canonical set and surface any legitimate drift.',
    );
  }
  console.log('');
}

export type { Classification };
