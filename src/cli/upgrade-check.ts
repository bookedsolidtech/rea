/**
 * `rea upgrade --check` — 0.41.0 consumer-UX dry-run preview.
 *
 * Today `rea upgrade` rewrites consumer files immediately (gated by
 * interactive prompts and `--dry-run` for a coarse preview). There has
 * been no way to PREVIEW what would change, file-by-file, with the
 * actual textual delta, before running the real upgrade. `--check`
 * fills that gap.
 *
 * # Contract
 *
 * - Reads the same canonical file set as `rea upgrade`, classifies it
 *   against the installed manifest, and emits a summary table of
 *   counts (created / modified / unchanged / removed-upstream) plus a
 *   unified diff per modified file.
 * - Never writes to disk. The classification phase is pure; nothing
 *   downstream of `computeUpgradePlan` mutates the filesystem.
 * - Exits 0 regardless of what would change — `--check` is a preview,
 *   not an enforcement gate. Consumers wiring `rea upgrade --check`
 *   into CI gate on diff-present via the JSON output (`--json`).
 * - Distinct from `--dry-run`: `--dry-run` runs the FULL interactive
 *   upgrade flow with writes suppressed (prompts still fire, output
 *   still streams in classification order). `--check` is purely
 *   structured, non-interactive, and emits the unified diffs that
 *   `--dry-run` does not.
 *
 * # JSON output
 *
 * `--json` emits a single document with shape:
 *
 *     {
 *       "schema_version": 1,
 *       "rea_version": "0.41.0",
 *       "target_root": "/abs/path/to/repo",
 *       "bootstrap": false,
 *       "counts": { "created": 1, "modified": 3, "unchanged": 47,
 *                   "removed_upstream": 0 },
 *       "files": [
 *         { "path": "hooks/foo.sh", "action": "modified",
 *           "old_sha": "…", "new_sha": "…", "diff": "--- …\n+++ …\n…" },
 *         …
 *       ]
 *     }
 *
 * `diff` is included for `created` (showing full content as additions),
 * `modified` (true unified diff), and `removed_upstream` (showing the
 * full content as removals). It is omitted for `unchanged`.
 *
 * # Why not extend `--dry-run`?
 *
 * `--dry-run` already serves a different purpose: rehearse the full
 * upgrade flow in interactive mode. Bolting structured output onto it
 * would either change its existing output shape (breaking pipelines)
 * or fork it into two output paths anyway. A new flag is cleaner.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  CLAUDE_MD_MANIFEST_PATH,
  SETTINGS_MANIFEST_PATH,
  enumerateCanonicalFiles,
  type CanonicalFile,
} from './install/canonical.js';
import { buildFragment, extractFragment, type ClaudeMdFragmentInput } from './install/claude-md.js';
import { safeReadFile } from './install/fs-safe.js';
import {
  canonicalSettingsSubsetHash,
  defaultDesiredHooks,
  mergeSettings,
  pruneHookCommands,
  readSettings,
} from './install/settings-merge.js';
import { ensureReaGitignore } from './install/gitignore.js';
import { manifestExists, readManifest } from './install/manifest-io.js';
import { type ManifestEntry } from './install/manifest-schema.js';
import { sha256OfBuffer, sha256OfFile } from './install/sha.js';
import { diffUnified, DIFF_TOO_LARGE_NOTICE } from './install/unified-diff.js';
import { loadPolicy } from '../policy/loader.js';
import { validateSettings } from '../config/settings-schema.js';
import { err, getPkgVersion, log } from './utils.js';

/** Hard cap on the diff input size. Mirrors `DIFF_SIZE_CAP_BYTES` in
 *  upgrade.ts so the two preview surfaces agree on the "too big to
 *  render" threshold. */
export const CHECK_DIFF_SIZE_CAP_BYTES = 256 * 1024;

/**
 * Stable schema marker for the JSON document. Bumped when the shape
 * changes in a non-additive way.
 */
export const UPGRADE_CHECK_SCHEMA_VERSION = 1;

/**
 * Tokens for hook commands that older rea versions registered into
 * `.claude/settings.json` and that the upgrade flow PRUNES on every
 * run. Mirrors `STALE_HOOK_COMMAND_TOKENS` in `upgrade.ts` — kept in
 * sync because both modules want to anticipate the same prune set.
 *
 * Re-exported by upgrade.ts so the actual write path uses the same
 * list.
 */
export const UPGRADE_CHECK_STALE_HOOK_TOKENS: readonly string[] = [
  'push-review-gate.sh',
  'commit-review-gate.sh',
  'push-review-gate-git.sh',
];

export type UpgradeCheckAction = 'created' | 'modified' | 'unchanged' | 'removed_upstream';

export interface UpgradeCheckFile {
  /** Repo-relative path of the file (POSIX-normalized). */
  path: string;
  action: UpgradeCheckAction;
  /** Synthetic entries (settings.json subset hash, CLAUDE.md fragment,
   *  .gitignore managed block) are flagged so the renderer can label
   *  them in the table. */
  synthetic?: 'settings' | 'claude-md' | 'gitignore';
  /** SHA-256 of the on-disk content at preview time, when present. */
  old_sha?: string;
  /** SHA-256 of the would-be-installed content. */
  new_sha?: string;
  /** Unified diff body. Empty string for `unchanged`. May be omitted
   *  when the file exceeds `CHECK_DIFF_SIZE_CAP_BYTES` — `diff_truncated`
   *  is then `true`. */
  diff?: string;
  /** Set when the diff was suppressed for size. Operators inspect the
   *  files manually in this case. */
  diff_truncated?: boolean;
  /** Free-form notice the renderer should display alongside the file
   *  row (e.g. "removed-upstream — kept by default unless --force"). */
  note?: string;
}

/**
 * 0.42.0 charter item 2 — surface the same settings-schema validation
 * the real upgrade flow runs. `runUpgrade` calls `validateSettings`
 * on the merged result and refuses the write (throws) when it fails;
 * pre-0.42.0 `rea upgrade --check` never invoked that check, so a
 * preview could promise a write that the real upgrade would refuse.
 *
 *   - `parsed: true` — schema validation succeeded; `errors` is empty.
 *     The real upgrade WOULD write the merged settings on demand.
 *   - `parsed: false` — schema validation failed. `errors` carries the
 *     same zod-issue strings `runUpgrade` would surface in its throw
 *     message. The real upgrade would refuse and leave settings.json
 *     untouched.
 */
export interface UpgradeCheckSettingsValidation {
  parsed: boolean;
  errors: string[];
}

export interface UpgradeCheckPlan {
  schema_version: typeof UPGRADE_CHECK_SCHEMA_VERSION;
  rea_version: string;
  target_root: string;
  /** `true` when no install-manifest exists; the consumer is on a
   *  pre-G12 install and the first real upgrade will record SHAs
   *  for whatever is on disk. */
  bootstrap: boolean;
  counts: {
    created: number;
    modified: number;
    unchanged: number;
    removed_upstream: number;
  };
  files: UpgradeCheckFile[];
  /** 0.42.0 — schema-validation outcome on the merged settings.json
   *  the real `rea upgrade` would write. `null` when the synthetic
   *  settings classification did not produce a merged result (should
   *  not happen in practice; defensive). */
  settings_validation: UpgradeCheckSettingsValidation | null;
  /**
   * 0.42.0 codex round 3 P2 (2026-05-16) — top-level "preview = real"
   * verdict. `true` when `rea upgrade` would actually start mutating
   * the install; `false` when the new pre-flight (settings-validation)
   * gate would refuse the upgrade before any file is written.
   *
   * Why this matters: `counts` + `files` still describe what WOULD be
   * written if validation passed (operators want the diff so they can
   * fix the underlying invalid setting and see the upgrade preview in
   * one shot). But CI and automation consuming the JSON need a single
   * unambiguous signal that the real upgrade will write nothing in
   * the current state. Use `would_apply` as that signal; treat
   * `files[]` + `counts` as conditional on `would_apply === true`.
   */
  would_apply: boolean;
}

export interface ComputeUpgradeCheckOptions {
  /** Defaults to `process.cwd()`. */
  baseDir?: string;
  /** Tests can stub the canonical file enumeration; production reads
   *  from `PKG_ROOT`. */
  canonicalFiles?: CanonicalFile[];
  /** When `false`, skips the unified-diff computation (counts + paths
   *  only). Default `true`. Useful for very large repos previewed in
   *  CI where the diffs are not consumed. */
  includeDiffs?: boolean;
}

/**
 * Compute a unified diff and translate the LCS-overflow sentinel
 * into a `diff_truncated` verdict. Codex round-1 P1: pathological
 * line counts inside the byte cap can still return the
 * `DIFF_TOO_LARGE_NOTICE` sentinel from `diffUnified`; treat that
 * sentinel as a truncation rather than a real diff body.
 *
 * Returns `{ diff?, diff_truncated? }` — never both, never neither.
 */
function safeDiff(
  oldText: string,
  newText: string,
  pathLabel: string,
): { diff?: string; diff_truncated?: boolean } {
  const body = diffUnified(oldText, newText, { oldPath: pathLabel, newPath: pathLabel });
  if (body.length === 0) return {};
  if (body.includes(DIFF_TOO_LARGE_NOTICE)) {
    return { diff_truncated: true };
  }
  return { diff: body };
}

/**
 * Read a file from disk under `safeReadFile` containment. Returns
 * `null` when the file does not exist (the standard "not on disk yet"
 * signal in this module).
 */
async function readLocalFile(
  resolvedRoot: string,
  relPath: string,
): Promise<{ bytes: Buffer; sha: string } | null> {
  const buf = await safeReadFile(resolvedRoot, relPath);
  if (buf === null) return null;
  return { bytes: buf, sha: sha256OfBuffer(buf) };
}

/**
 * Classify a single canonical file against the local copy + manifest
 * entry and return an UpgradeCheckFile.
 */
async function classifyOne(
  resolvedRoot: string,
  canonical: CanonicalFile,
  manifestEntry: ManifestEntry | undefined,
  includeDiffs: boolean,
): Promise<UpgradeCheckFile> {
  const canonicalSha = await sha256OfFile(canonical.sourceAbsPath);
  const local = await readLocalFile(resolvedRoot, canonical.destRelPath);

  if (local === null) {
    // Treat as `created`. Diff shows full canonical content as adds.
    const file: UpgradeCheckFile = {
      path: canonical.destRelPath,
      action: 'created',
      new_sha: canonicalSha,
    };
    if (includeDiffs) {
      const canonicalStat = await fsPromises.stat(canonical.sourceAbsPath);
      if (canonicalStat.size > CHECK_DIFF_SIZE_CAP_BYTES) {
        file.diff_truncated = true;
      } else {
        const canonicalText = await fsPromises.readFile(canonical.sourceAbsPath, 'utf8');
        Object.assign(file, safeDiff('', canonicalText, canonical.destRelPath));
      }
    }
    return file;
  }

  // File exists on disk. Resolve manifest tier:
  //   - manifest entry present + sha matches local → `unmodified` per
  //     manifest, but if local !== canonical, the actual upgrade will
  //     auto-update. Treat as `modified` in the check view (the
  //     consumer needs to know this byte will change).
  //   - manifest entry absent + local matches canonical → `unchanged`
  //     (no work).
  //   - manifest entry absent + local diverges → `modified` (rea will
  //     prompt; --check reports the would-be canonical replacement).
  if (local.sha === canonicalSha) {
    return {
      path: canonical.destRelPath,
      action: 'unchanged',
      old_sha: local.sha,
      new_sha: canonicalSha,
    };
  }

  const file: UpgradeCheckFile = {
    path: canonical.destRelPath,
    action: 'modified',
    old_sha: local.sha,
    new_sha: canonicalSha,
  };

  if (includeDiffs) {
    const canonicalStat = await fsPromises.stat(canonical.sourceAbsPath);
    if (
      local.bytes.byteLength > CHECK_DIFF_SIZE_CAP_BYTES ||
      canonicalStat.size > CHECK_DIFF_SIZE_CAP_BYTES
    ) {
      file.diff_truncated = true;
    } else {
      const oldText = local.bytes.toString('utf8');
      const newText = await fsPromises.readFile(canonical.sourceAbsPath, 'utf8');
      Object.assign(file, safeDiff(oldText, newText, canonical.destRelPath));
    }
  }

  // Manifest context is informational only. Pre-write we cannot
  // distinguish auto-update from prompt-on-drift without re-running
  // the interactive flow; both surface as `modified` here. The actual
  // upgrade decision (auto vs prompt) is made by `runUpgrade`.
  if (manifestEntry === undefined) {
    file.note = 'no manifest entry — first observed on this run';
  } else if (local.sha === manifestEntry.sha256) {
    file.note = 'auto-update — local matches last installed SHA';
  } else {
    file.note = 'drift — interactive upgrade will prompt to overwrite or keep';
  }

  return file;
}

/**
 * Build the synthetic CLAUDE.md fragment entry. Mirrors
 * `upgradeClaudeMdFragment` in `upgrade.ts` but never writes — it just
 * reports what the fragment WOULD look like.
 */
async function classifyClaudeMd(
  resolvedRoot: string,
  includeDiffs: boolean,
): Promise<UpgradeCheckFile | null> {
  // The fragment requires the live policy to render. If policy load
  // fails (e.g. consumer hasn't run `rea init` yet), the upgrade flow
  // skips the fragment too — mirror that.
  let fragmentInput: ClaudeMdFragmentInput;
  try {
    const policy = loadPolicy(resolvedRoot);
    fragmentInput = {
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
  const newFragment = buildFragment(fragmentInput);
  const newSha = sha256OfBuffer(newFragment);
  const claudeMdPath = path.join(resolvedRoot, 'CLAUDE.md');

  if (!fs.existsSync(claudeMdPath)) {
    const wouldBe = `# CLAUDE.md\n\n${newFragment}\n`;
    // Codex round-2 P2: hash the full would-be CLAUDE.md content,
    // NOT the fragment-only SHA. The fragment SHA is what the
    // manifest tracks; the on-disk file is the wrapper + fragment.
    // Reporting fragment SHA as new_sha makes JSON consumers
    // diffing SHA fields see a false mismatch against the on-disk
    // hash post-upgrade.
    const file: UpgradeCheckFile = {
      path: 'CLAUDE.md',
      action: 'created',
      synthetic: 'claude-md',
      new_sha: sha256OfBuffer(Buffer.from(wouldBe, 'utf8')),
      note: `managed fragment will be installed into a fresh CLAUDE.md (fragment SHA ${newSha.slice(0, 12)}…)`,
    };
    if (includeDiffs) {
      Object.assign(file, safeDiff('', wouldBe, 'CLAUDE.md'));
    }
    return file;
  }

  const existing = await fsPromises.readFile(claudeMdPath, 'utf8');
  const existingSha = sha256OfBuffer(Buffer.from(existing, 'utf8'));
  const currentFragment = extractFragment(existing);
  if (currentFragment === newFragment) {
    return {
      path: 'CLAUDE.md',
      action: 'unchanged',
      synthetic: 'claude-md',
      old_sha: existingSha,
      new_sha: existingSha,
      note: `managed fragment up to date (fragment SHA ${newSha.slice(0, 12)}…)`,
    };
  }

  // Build the would-be replacement text the same way `upgrade.ts` does
  // (replace existing fragment in place, or append if no markers).
  let next: string;
  if (currentFragment !== null) {
    next = existing.replace(currentFragment, newFragment);
  } else {
    const trailer = existing.endsWith('\n') ? '' : '\n';
    next = `${existing}${trailer}\n${newFragment}\n`;
  }

  const file: UpgradeCheckFile = {
    path: 'CLAUDE.md',
    action: 'modified',
    synthetic: 'claude-md',
    old_sha: existingSha,
    new_sha: sha256OfBuffer(Buffer.from(next, 'utf8')),
    note: `managed fragment will be updated; non-managed content preserved (fragment SHA ${newSha.slice(0, 12)}…)`,
  };
  if (includeDiffs) {
    if (
      Buffer.byteLength(existing, 'utf8') > CHECK_DIFF_SIZE_CAP_BYTES ||
      Buffer.byteLength(next, 'utf8') > CHECK_DIFF_SIZE_CAP_BYTES
    ) {
      file.diff_truncated = true;
    } else {
      Object.assign(file, safeDiff(existing, next, 'CLAUDE.md'));
    }
  }
  return file;
}

/**
 * Classify the synthetic `.claude/settings.json` entry. Like the real
 * upgrade flow, we prune known-stale hook tokens BEFORE merging the
 * default-desired hook set — the order matters so the merge sees a
 * clean baseline.
 *
 * 0.42.0 — also returns the merged object so the caller can run the
 * same `validateSettings` check the real `runUpgrade` runs. We hand
 * back the merged shape directly (not the file rendering) so the
 * caller can decide whether to thread it into the schema check.
 */
async function classifySettings(
  resolvedRoot: string,
  includeDiffs: boolean,
): Promise<{ file: UpgradeCheckFile; merged: Record<string, unknown> }> {
  const desired = defaultDesiredHooks();
  // `canonicalSettingsSubsetHash` is the MANIFEST-tracked SHA of the
  // rea-owned subset (used by drift detection). It does NOT equal the
  // on-disk file hash, because consumers commonly add their own hook
  // entries that we leave alone. Keep it in the note for forensics,
  // but report `old_sha` / `new_sha` as the actual on-disk vs.
  // would-be-on-disk file hashes — that's what consumers diffing the
  // JSON expect. (Codex round-2 P2.)
  const subsetSha = canonicalSettingsSubsetHash(desired);
  const { settings, settingsPath } = readSettings(resolvedRoot);

  const pruned = pruneHookCommands(settings, UPGRADE_CHECK_STALE_HOOK_TOKENS);
  const mergeResult = mergeSettings(pruned.merged, desired);
  const willWrite = pruned.removedCount > 0 || mergeResult.addedCount > 0;
  const action: UpgradeCheckAction = willWrite ? 'modified' : 'unchanged';

  let oldText = '';
  let exists = false;
  try {
    oldText = await fsPromises.readFile(settingsPath, 'utf8');
    exists = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const newText = `${JSON.stringify(mergeResult.merged, null, 2)}\n`;

  const file: UpgradeCheckFile = {
    path: path.relative(resolvedRoot, settingsPath).split(path.sep).join('/'),
    action: !exists ? 'created' : action,
    synthetic: 'settings',
    new_sha: sha256OfBuffer(Buffer.from(newText, 'utf8')),
  };
  if (exists) {
    file.old_sha = sha256OfBuffer(Buffer.from(oldText, 'utf8'));
  }
  const notes: string[] = [`rea-subset SHA ${subsetSha.slice(0, 12)}…`];
  if (pruned.removedCount > 0) {
    notes.push(
      `would prune ${String(pruned.removedCount)} stale hook entr${pruned.removedCount === 1 ? 'y' : 'ies'}`,
    );
  }
  if (mergeResult.addedCount > 0) {
    notes.push(
      `would add ${String(mergeResult.addedCount)} hook entr${mergeResult.addedCount === 1 ? 'y' : 'ies'}`,
    );
  }
  if (mergeResult.skippedCount > 0) {
    notes.push(
      `${String(mergeResult.skippedCount)} hook entr${mergeResult.skippedCount === 1 ? 'y' : 'ies'} already present`,
    );
  }
  file.note = notes.join('; ');

  if (includeDiffs && (file.action === 'modified' || file.action === 'created')) {
    if (
      Buffer.byteLength(oldText, 'utf8') > CHECK_DIFF_SIZE_CAP_BYTES ||
      Buffer.byteLength(newText, 'utf8') > CHECK_DIFF_SIZE_CAP_BYTES
    ) {
      file.diff_truncated = true;
    } else {
      Object.assign(file, safeDiff(oldText, newText, file.path));
    }
  }
  return { file, merged: mergeResult.merged };
}

/**
 * Build a `removed_upstream` entry from a manifest record that has no
 * matching canonical file. The diff body shows the full local content
 * as removals.
 */
async function classifyRemovedUpstream(
  resolvedRoot: string,
  entry: ManifestEntry,
  includeDiffs: boolean,
): Promise<UpgradeCheckFile | null> {
  const local = await readLocalFile(resolvedRoot, entry.path);
  if (local === null) {
    // The manifest references a file that's already gone. Nothing
    // for --check to surface — the actual upgrade would also no-op.
    return null;
  }
  const file: UpgradeCheckFile = {
    path: entry.path,
    action: 'removed_upstream',
    old_sha: local.sha,
    note: 'no longer shipped by rea — interactive upgrade defaults to keep; --force deletes',
  };
  if (includeDiffs) {
    if (local.bytes.byteLength > CHECK_DIFF_SIZE_CAP_BYTES) {
      file.diff_truncated = true;
    } else {
      const oldText = local.bytes.toString('utf8');
      Object.assign(file, safeDiff(oldText, '', entry.path));
    }
  }
  return file;
}

/**
 * Build the synthetic `.gitignore` entry. Mirrors the real upgrade
 * path's `ensureReaGitignore` call but runs in dry-run mode so it
 * returns `previewContent` instead of writing.
 *
 * Codex round-1 P2: `runUpgrade` calls `ensureReaGitignore` to
 * backfill the managed block for older installs missing
 * `.rea/last-review.json` / `.rea/fingerprints.json` / etc. Without
 * a synthetic check entry, `rea upgrade --check` would silently
 * report a fully-in-sync repo and then `rea upgrade` would still
 * mutate `.gitignore` — breaking the advertised preview contract.
 */
async function classifyGitignore(
  resolvedRoot: string,
  includeDiffs: boolean,
): Promise<UpgradeCheckFile | null> {
  let result;
  try {
    result = await ensureReaGitignore(resolvedRoot, { dryRun: true });
  } catch {
    // Defensive — the dry-run path inside ensureReaGitignore converts
    // every recoverable failure to a warning + 'unchanged' verdict.
    // Catch the unexpected and skip the row rather than failing the
    // whole plan.
    return null;
  }
  // `action` from ensureReaGitignore: 'created' | 'updated' | 'unchanged'.
  // Map onto our check vocabulary.
  const action: UpgradeCheckAction =
    result.action === 'created'
      ? 'created'
      : result.action === 'updated'
        ? 'modified'
        : 'unchanged';
  const relPath = path.relative(resolvedRoot, result.path).split(path.sep).join('/');
  const file: UpgradeCheckFile = {
    path: relPath,
    action,
    synthetic: 'gitignore',
  };
  const previewContent = result.previewContent ?? '';
  const previousContent = result.previousContent ?? '';
  if (previewContent.length > 0) {
    file.new_sha = sha256OfBuffer(Buffer.from(previewContent, 'utf8'));
  }
  if (previousContent.length > 0 || result.previousContent !== null) {
    file.old_sha = sha256OfBuffer(Buffer.from(previousContent, 'utf8'));
  }
  if (result.addedEntries.length > 0) {
    file.note = `managed block ${result.action} — ${String(result.addedEntries.length)} entr${
      result.addedEntries.length === 1 ? 'y' : 'ies'
    } added`;
  } else if (action === 'unchanged') {
    file.note = 'managed block up to date';
  }
  if (result.warnings.length > 0) {
    const joined = result.warnings.join('; ');
    file.note = file.note !== undefined ? `${file.note}; ${joined}` : joined;
  }
  if (includeDiffs && action !== 'unchanged') {
    if (
      Buffer.byteLength(previousContent, 'utf8') > CHECK_DIFF_SIZE_CAP_BYTES ||
      Buffer.byteLength(previewContent, 'utf8') > CHECK_DIFF_SIZE_CAP_BYTES
    ) {
      file.diff_truncated = true;
    } else {
      Object.assign(file, safeDiff(previousContent, previewContent, relPath));
    }
  }
  return file;
}

/**
 * Compute the full upgrade-check plan. Pure (filesystem reads only —
 * no writes). All synthetic entries (CLAUDE.md fragment, settings
 * subset hash, .gitignore managed block) are included alongside the
 * canonical-file classifications.
 */
export async function computeUpgradeCheck(
  options: ComputeUpgradeCheckOptions = {},
): Promise<UpgradeCheckPlan> {
  const baseDir = options.baseDir ?? process.cwd();
  const includeDiffs = options.includeDiffs ?? true;
  const resolvedRoot = await fsPromises.realpath(baseDir);

  const canonicalFiles = options.canonicalFiles ?? (await enumerateCanonicalFiles());
  const existingManifest = manifestExists(resolvedRoot) ? await readManifest(resolvedRoot) : null;
  const isBootstrap = existingManifest === null;

  const manifestByPath = new Map<string, ManifestEntry>();
  if (existingManifest !== null) {
    for (const e of existingManifest.files) manifestByPath.set(e.path, e);
  }

  const canonicalByPath = new Map<string, CanonicalFile>();
  for (const c of canonicalFiles) canonicalByPath.set(c.destRelPath, c);

  const files: UpgradeCheckFile[] = [];

  for (const canonical of canonicalFiles) {
    files.push(
      await classifyOne(
        resolvedRoot,
        canonical,
        manifestByPath.get(canonical.destRelPath),
        includeDiffs,
      ),
    );
  }

  // Removed-upstream entries.
  if (existingManifest !== null) {
    for (const entry of existingManifest.files) {
      if (entry.path === CLAUDE_MD_MANIFEST_PATH || entry.path === SETTINGS_MANIFEST_PATH) {
        continue; // synthetic entries handled below
      }
      if (!canonicalByPath.has(entry.path)) {
        const file = await classifyRemovedUpstream(resolvedRoot, entry, includeDiffs);
        if (file !== null) files.push(file);
      }
    }
  }

  // Synthetic entries.
  const settingsClassification = await classifySettings(resolvedRoot, includeDiffs);
  files.push(settingsClassification.file);
  const claudeMd = await classifyClaudeMd(resolvedRoot, includeDiffs);
  if (claudeMd !== null) files.push(claudeMd);
  const gitignoreFile = await classifyGitignore(resolvedRoot, includeDiffs);
  if (gitignoreFile !== null) files.push(gitignoreFile);

  // 0.42.0 charter item 2 — schema-validate the merged settings the
  // real `runUpgrade` would write. `runUpgrade` calls `validateSettings`
  // (non-strict, matching the upgrade flow's posture) and throws when
  // the merged result fails — refusing the write. Pre-0.42.0 the
  // preview never ran this check, so the planner could promise a write
  // that the real upgrade would refuse. Reproduce the exact validation
  // shape here so the JSON `settings_validation` field is byte-for-byte
  // what `runUpgrade` would see.
  const validation = validateSettings(settingsClassification.merged, { strict: false });
  const settingsValidation: UpgradeCheckSettingsValidation = {
    parsed: validation.parsed,
    errors: validation.errors,
  };
  // If validation failed, annotate the settings file row so the
  // human-readable rendering surfaces the refusal alongside the count
  // table (operators reading the table without scrolling to the
  // footer still see the warning). Note appends rather than overwrites
  // so the existing merge / prune annotations remain visible.
  if (!validation.parsed) {
    const refusalNote = `WOULD REFUSE: schema validation failed — ${validation.errors.join('; ')}`;
    const f = settingsClassification.file;
    f.note = f.note !== undefined ? `${f.note}; ${refusalNote}` : refusalNote;
  }

  // Stable sort: action priority (modified → created → removed_upstream
  // → unchanged) then path. Operators reviewing the table want to see
  // the changed entries first.
  const actionOrder: Record<UpgradeCheckAction, number> = {
    modified: 0,
    created: 1,
    removed_upstream: 2,
    unchanged: 3,
  };
  files.sort((a, b) => {
    const diff = actionOrder[a.action] - actionOrder[b.action];
    if (diff !== 0) return diff;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const counts = { created: 0, modified: 0, unchanged: 0, removed_upstream: 0 };
  for (const f of files) counts[f.action] += 1;

  return {
    schema_version: UPGRADE_CHECK_SCHEMA_VERSION,
    rea_version: getPkgVersion(),
    target_root: resolvedRoot,
    bootstrap: isBootstrap,
    counts,
    files,
    settings_validation: settingsValidation,
    // Codex round 3 P2 (2026-05-16): mirror runUpgrade's pre-flight
    // gate. `would_apply` is true when the real upgrade would actually
    // start mutating disk — currently the only gate is settings-schema
    // validation, but more pre-flight checks may land in future
    // releases (in which case they get ANDed in here).
    would_apply: settingsValidation.parsed,
  };
}

/**
 * Render the plan as a human-readable summary block. Designed for
 * terminal consumption — counts table on top, then a per-file section
 * with the diff body indented.
 */
export function renderUpgradeCheck(plan: UpgradeCheckPlan): string {
  const lines: string[] = [];
  lines.push(`rea upgrade --check (rea v${plan.rea_version})`);
  lines.push(`  target: ${plan.target_root}`);
  if (plan.bootstrap) {
    lines.push(`  bootstrap mode: no install-manifest found yet`);
  }
  lines.push('');
  // Codex round 3 P2 (2026-05-16): when a pre-flight gate would
  // refuse the upgrade, the counts/files below describe what WOULD
  // happen if the gate passed — but `rea upgrade` will actually
  // write nothing in the current state. Lead with that banner so
  // operators don't read the summary table as a promise of action.
  if (!plan.would_apply) {
    lines.push(
      'BLOCKED — `rea upgrade` would refuse to apply this plan in its current state. ' +
        'The summary below describes the would-be plan IF the refusal were fixed first; ' +
        'the real upgrade writes nothing until the refusal clears.',
    );
    lines.push('');
  }
  const totalChanges =
    plan.counts.created + plan.counts.modified + plan.counts.removed_upstream;
  const summaryLabel = plan.would_apply ? 'planned change(s)' : 'change(s) blocked by refusal';
  lines.push(`Summary — ${String(totalChanges)} ${summaryLabel}:`);
  lines.push(`  created:          ${String(plan.counts.created)}`);
  lines.push(`  modified:         ${String(plan.counts.modified)}`);
  lines.push(`  removed-upstream: ${String(plan.counts.removed_upstream)}`);
  lines.push(`  unchanged:        ${String(plan.counts.unchanged)}`);
  lines.push('');
  if (totalChanges === 0) {
    lines.push('No changes — your install is already in sync with this rea version.');
    lines.push('');
    // 0.42.0 — even with zero planned changes, surface a validation
    // failure here so an operator doesn't see "in sync" and miss the
    // settings refusal.
    if (plan.settings_validation !== null && !plan.settings_validation.parsed) {
      lines.push(
        'WARNING: `rea upgrade` would REFUSE to run — the merged ' +
          '.claude/settings.json would fail schema validation:',
      );
      for (const e of plan.settings_validation.errors) {
        lines.push(`  - ${e}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  // Per-file detail — skip `unchanged` entries.
  for (const file of plan.files) {
    if (file.action === 'unchanged') continue;
    const marker =
      file.action === 'created' ? '+' : file.action === 'removed_upstream' ? '-' : '~';
    const baseLabel =
      file.action === 'removed_upstream' ? 'removed-upstream' : file.action;
    // Codex round 3 P2 (2026-05-16): when a refusal is active, every
    // would-be-mutated file row gets a BLOCKED suffix so a quick scroll
    // through the per-file detail cannot miss the fact that no write
    // will happen until the refusal clears.
    const label = plan.would_apply ? baseLabel : `${baseLabel} (BLOCKED — refusal active)`;
    const syntheticTag = file.synthetic !== undefined ? ` [${file.synthetic}]` : '';
    lines.push(`${marker} ${file.path}${syntheticTag} — ${label}`);
    if (file.note !== undefined) lines.push(`    note: ${file.note}`);
    if (file.old_sha !== undefined && file.new_sha !== undefined) {
      lines.push(`    sha:  ${file.old_sha.slice(0, 12)}… → ${file.new_sha.slice(0, 12)}…`);
    } else if (file.new_sha !== undefined) {
      lines.push(`    sha:  (new) → ${file.new_sha.slice(0, 12)}…`);
    } else if (file.old_sha !== undefined) {
      lines.push(`    sha:  ${file.old_sha.slice(0, 12)}… → (removed)`);
    }
    if (file.diff_truncated === true) {
      lines.push(
        `    diff: (suppressed — file exceeds ${String(CHECK_DIFF_SIZE_CAP_BYTES)} bytes; inspect manually)`,
      );
    } else if (file.diff !== undefined && file.diff.length > 0) {
      lines.push('    diff:');
      for (const dl of file.diff.split('\n')) {
        // Trailing empty from split — preserve only if non-empty.
        if (dl.length > 0) lines.push(`      ${dl}`);
      }
    }
    lines.push('');
  }
  // 0.42.0 — surface settings-schema validation outcome alongside the
  // footer. When the merged settings would fail validation, `rea
  // upgrade` would refuse to start at all (codex round 2 P2 moved the
  // validation to a pre-flight check BEFORE any file writes); we
  // report that here so consumers can fix policy + settings before
  // invoking the real upgrade.
  if (plan.settings_validation !== null && !plan.settings_validation.parsed) {
    lines.push('');
    lines.push(
      'WARNING: `rea upgrade` would REFUSE to run — the merged ' +
        '.claude/settings.json would fail schema validation:',
    );
    for (const e of plan.settings_validation.errors) {
      lines.push(`  - ${e}`);
    }
    lines.push(
      'No files will be written by `rea upgrade` while this is true — the ' +
        'pre-flight check runs before any canonical hook or agent file is ' +
        'installed AND before the 0.11.0 .rea/policy.yaml migration, so your ' +
        'existing install stays untouched. Fix the settings entries flagged ' +
        'above and re-run `rea upgrade --check`.',
    );
    lines.push('');
  } else {
    lines.push(
      'No changes were written. Run `rea upgrade` (without --check) to apply.',
    );
    lines.push('');
  }
  return lines.join('\n');
}

export interface RunUpgradeCheckOptions {
  json?: boolean;
  /** Strip `diff` bodies from output (counts + paths only). */
  noDiff?: boolean;
}

/**
 * Commander entrypoint for `rea upgrade --check`. Always exits 0 —
 * `--check` is a preview, not a gate.
 */
export async function runUpgradeCheck(options: RunUpgradeCheckOptions = {}): Promise<void> {
  const baseDir = process.cwd();
  if (!fs.existsSync(path.join(baseDir, '.rea'))) {
    err('no .rea/ directory — run `rea init` first.');
    process.exit(1);
  }
  const plan = await computeUpgradeCheck({
    baseDir,
    includeDiffs: options.noDiff !== true,
  });
  if (options.json === true) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderUpgradeCheck(plan));
  log(`upgrade --check complete — no changes were written.`);
}
