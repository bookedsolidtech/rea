/**
 * BUG-010 — `.gitignore` scaffolding tests.
 *
 * Covers the idempotency contract documented on `ensureReaGitignore`:
 *   - fresh repo (no `.gitignore`) → create with managed block
 *   - repo with `.gitignore` but no rea block → append block after blank line
 *   - repo with partial block (missing new 0.5.0 entries) → fill in-place
 *   - all entries already present → no-op
 *   - symlinked `.gitignore` → refuse, warn, no-op (supply-chain guard)
 *
 * Every test runs in a per-test tempdir so nothing leaks into the repo.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureReaGitignore,
  GITIGNORE_BLOCK_END,
  GITIGNORE_BLOCK_START,
  REA_GITIGNORE_ENTRIES,
} from './gitignore.js';

const cleanupDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'rea-gitignore-'));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

describe('ensureReaGitignore — BUG-010 scaffolding', () => {
  it('creates .gitignore with managed block on a repo that has none', async () => {
    const dir = await makeTempDir();
    const result = await ensureReaGitignore(dir);

    expect(result.action).toBe('created');
    expect(result.addedEntries).toEqual([...REA_GITIGNORE_ENTRIES]);
    const content = await fsPromises.readFile(result.path, 'utf8');
    expect(content).toContain(GITIGNORE_BLOCK_START);
    expect(content).toContain(GITIGNORE_BLOCK_END);
    expect(content).toContain('.rea/fingerprints.json');
    expect(content).toContain('.rea/audit.jsonl');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('appends managed block to an existing .gitignore with user lines', async () => {
    const dir = await makeTempDir();
    const existing = 'node_modules\ndist\n';
    await fsPromises.writeFile(path.join(dir, '.gitignore'), existing, 'utf8');

    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('updated');
    expect(result.addedEntries).toEqual([...REA_GITIGNORE_ENTRIES]);

    const content = await fsPromises.readFile(result.path, 'utf8');
    // Pre-existing lines preserved.
    expect(content.startsWith('node_modules\ndist\n')).toBe(true);
    // Managed block separated from user content by at least a blank line.
    expect(content).toMatch(/dist\n\n# === rea managed/);
    expect(content).toContain('.rea/fingerprints.json');
  });

  it('is a no-op when every required entry is already present', async () => {
    const dir = await makeTempDir();
    await ensureReaGitignore(dir);
    const first = await fsPromises.readFile(path.join(dir, '.gitignore'), 'utf8');

    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('unchanged');
    expect(result.addedEntries).toEqual([]);

    const second = await fsPromises.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(second).toBe(first);
  });

  it('backfills missing entries inside an existing managed block (upgrade path)', async () => {
    const dir = await makeTempDir();
    // Simulate a 0.4.0 install that wrote only the older entries. When we
    // run 0.5.0 `rea upgrade`, the scaffold must fill in `fingerprints.json`
    // and `review-cache.jsonl` without deleting the operator's additions.
    const partial = [
      'node_modules',
      '',
      GITIGNORE_BLOCK_START,
      '.rea/audit.jsonl',
      '.rea/HALT',
      '# operator-authored inside block — preserved',
      '.rea/my-local-thing',
      GITIGNORE_BLOCK_END,
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(dir, '.gitignore'), partial, 'utf8');

    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('updated');
    // Entries that were missing must be in addedEntries, in canonical order.
    expect(result.addedEntries).toEqual([
      '.rea/audit-*.jsonl',
      '.rea/metrics.jsonl',
      '.rea/serve.pid',
      '.rea/serve.state.json',
      '.rea/fingerprints.json',
      '.rea/review-cache.jsonl',
    ]);

    const content = await fsPromises.readFile(result.path, 'utf8');
    expect(content).toContain('.rea/my-local-thing');
    expect(content).toContain('# operator-authored inside block — preserved');
    expect(content).toContain('.rea/fingerprints.json');
    expect(content).toContain('.rea/review-cache.jsonl');
    // User top-level line still present.
    expect(content.startsWith('node_modules\n')).toBe(true);
  });

  it('rejects a substring match on the marker — only anchored lines count', async () => {
    const dir = await makeTempDir();
    // A hostile or accidental comment containing the sentinel string must
    // NOT be treated as a managed block — a leading character breaks the
    // anchored-line match.
    const spoofed = [
      '## === rea managed — do not edit between markers === (commentary)',
      '.rea/audit.jsonl',
      '## === end rea managed === (commentary)',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(dir, '.gitignore'), spoofed, 'utf8');

    const result = await ensureReaGitignore(dir);
    // No block recognized → append a fresh one.
    expect(result.action).toBe('updated');
    expect(result.addedEntries).toEqual([...REA_GITIGNORE_ENTRIES]);

    const content = await fsPromises.readFile(result.path, 'utf8');
    // Original spoof preserved.
    expect(content).toContain('## === rea managed');
    // Real block appended.
    expect(content).toContain('\n# === rea managed — do not edit between markers ===\n');
  });

  it('refuses to write through a .gitignore symlink and surfaces a warning', async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir();
    const realTarget = path.join(outside, 'real.gitignore');
    await fsPromises.writeFile(realTarget, 'node_modules\n', 'utf8');
    await fsPromises.symlink(realTarget, path.join(dir, '.gitignore'));

    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('unchanged');
    expect(result.addedEntries).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/symlink/);

    // Real target was not touched.
    const targetContent = await fsPromises.readFile(realTarget, 'utf8');
    expect(targetContent).toBe('node_modules\n');
  });

  it('handles a .gitignore that does not end with a newline', async () => {
    const dir = await makeTempDir();
    await fsPromises.writeFile(path.join(dir, '.gitignore'), 'node_modules', 'utf8');

    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('updated');
    const content = await fsPromises.readFile(result.path, 'utf8');
    expect(content.startsWith('node_modules\n')).toBe(true);
    expect(content.endsWith('\n')).toBe(true);
    expect(content).toContain('.rea/fingerprints.json');
  });

  it('does not duplicate entries when reconciling a block that is fully populated', async () => {
    const dir = await makeTempDir();
    // Simulate a consumer who wrote ALL required entries themselves, in
    // different order. Must be recognized as "present" and produce no-op.
    const shuffled = [
      GITIGNORE_BLOCK_START,
      ...[...REA_GITIGNORE_ENTRIES].reverse(),
      GITIGNORE_BLOCK_END,
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(dir, '.gitignore'), shuffled, 'utf8');

    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('unchanged');
    expect(result.addedEntries).toEqual([]);
  });
});

describe('REA_GITIGNORE_ENTRIES — canonical list', () => {
  it('includes the BUG-010 fingerprint file', () => {
    expect(REA_GITIGNORE_ENTRIES).toContain('.rea/fingerprints.json');
  });

  it('includes the BUG-009 review cache', () => {
    expect(REA_GITIGNORE_ENTRIES).toContain('.rea/review-cache.jsonl');
  });

  it('includes the audit rotation glob', () => {
    expect(REA_GITIGNORE_ENTRIES).toContain('.rea/audit-*.jsonl');
  });

  it('has no duplicate entries', () => {
    const set = new Set(REA_GITIGNORE_ENTRIES);
    expect(set.size).toBe(REA_GITIGNORE_ENTRIES.length);
  });
});

describe('stat check — symlink refusal uses fs directly', () => {
  it('smoke: fs.existsSync agrees that the written file is a regular file', async () => {
    const dir = await makeTempDir();
    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('created');
    const stat = fs.lstatSync(result.path);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
  });
});
