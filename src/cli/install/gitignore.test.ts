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
    // All canonical entries minus the two the partial state already had.
    const alreadyPresent = new Set(['.rea/audit.jsonl', '.rea/HALT']);
    expect(result.addedEntries).toEqual(
      REA_GITIGNORE_ENTRIES.filter((e) => !alreadyPresent.has(e)),
    );

    const content = await fsPromises.readFile(result.path, 'utf8');
    expect(content).toContain('.rea/my-local-thing');
    expect(content).toContain('# operator-authored inside block — preserved');
    expect(content).toContain('.rea/fingerprints.json');
    expect(content).toContain('.rea/last-review.json');
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
    expect(REA_GITIGNORE_ENTRIES).toContain('.rea/last-review.json');
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

describe('Codex F7 — adversarial regression fixtures', () => {
  it('F3: CRLF input does not get a duplicate block appended on rerun', async () => {
    const dir = await makeTempDir();
    // Simulate a Windows consumer whose `.gitignore` is CRLF-encoded.
    const crlf = ['node_modules', 'dist', ''].join('\r\n');
    await fsPromises.writeFile(path.join(dir, '.gitignore'), crlf, 'utf8');

    const r1 = await ensureReaGitignore(dir);
    expect(r1.action).toBe('updated');
    const after1 = await fsPromises.readFile(path.join(dir, '.gitignore'), 'utf8');
    // EOL preserved: file stays CRLF.
    expect(after1.includes('\r\n')).toBe(true);
    // Exactly one managed block.
    const startCount1 = (after1.match(/# === rea managed — do not edit between markers ===/g) ?? [])
      .length;
    expect(startCount1).toBe(1);

    // Second run must be a no-op — THIS is what F3 was protecting against.
    const r2 = await ensureReaGitignore(dir);
    expect(r2.action).toBe('unchanged');
    const after2 = await fsPromises.readFile(path.join(dir, '.gitignore'), 'utf8');
    const startCount2 = (after2.match(/# === rea managed — do not edit between markers ===/g) ?? [])
      .length;
    expect(startCount2).toBe(1);
  });

  it('F4: duplicate managed blocks trigger refuse-and-warn, no modification', async () => {
    const dir = await makeTempDir();
    // Two full managed blocks — the failure mode F4 was catching. The
    // scaffolder must NOT silently touch only the first; it refuses and
    // surfaces a warning so the operator consolidates manually.
    const doubled = [
      'node_modules',
      '',
      GITIGNORE_BLOCK_START,
      '.rea/audit.jsonl',
      GITIGNORE_BLOCK_END,
      '',
      GITIGNORE_BLOCK_START,
      '.rea/HALT',
      GITIGNORE_BLOCK_END,
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(dir, '.gitignore'), doubled, 'utf8');

    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('unchanged');
    expect(result.addedEntries).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/multiple|duplicate/i);

    // File was not modified.
    const after = await fsPromises.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(after).toBe(doubled);
  });

  it('F5: trailing whitespace on marker lines is normalized for anchored match', async () => {
    const dir = await makeTempDir();
    // A marker line that happens to have a trailing space (editors sometimes
    // auto-insert these) must still be recognized as the block start.
    const withTrailingWs = [
      'node_modules',
      '',
      GITIGNORE_BLOCK_START + '  ',
      '.rea/audit.jsonl',
      GITIGNORE_BLOCK_END + '\t',
      '',
    ].join('\n');
    await fsPromises.writeFile(path.join(dir, '.gitignore'), withTrailingWs, 'utf8');

    const result = await ensureReaGitignore(dir);
    // Should be recognized as an existing block needing backfill — NOT
    // treated as a non-existent block (which would double the managed
    // block on disk).
    expect(result.action).toBe('updated');
    const after = await fsPromises.readFile(path.join(dir, '.gitignore'), 'utf8');
    const startCount = (after.match(/# === rea managed — do not edit between markers ===/g) ?? [])
      .length;
    expect(startCount).toBe(1);
  });

  it('F5: UTF-8 BOM on the first line does not prevent marker matching', async () => {
    const dir = await makeTempDir();
    // Some Windows editors prepend U+FEFF to new text files. Without BOM
    // handling, the marker on line 0 would silently not match.
    const bom =
      '\uFEFF' + GITIGNORE_BLOCK_START + '\n.rea/audit.jsonl\n' + GITIGNORE_BLOCK_END + '\n';
    await fsPromises.writeFile(path.join(dir, '.gitignore'), bom, 'utf8');

    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('updated');
    const after = await fsPromises.readFile(path.join(dir, '.gitignore'), 'utf8');
    const startCount = (after.match(/# === rea managed — do not edit between markers ===/g) ?? [])
      .length;
    expect(startCount).toBe(1);
  });

  it('F7: same-process async overlap lands a single well-formed block (last-rename-wins)', async () => {
    // NOTE: This test proves what `Promise.all` in a single event loop can
    // prove — no torn `.gitignore`, distinct crypto-random temp names,
    // exactly one rename winning. It does NOT prove multi-process race
    // safety; there is no proper-lockfile around `.gitignore` writes, and
    // two independent Node processes could last-write-wins and lose the
    // slower one's additions. That tradeoff is intentional: .gitignore
    // writes are operator-visible and rare, and consumers would not
    // appreciate a fresh lock directory landing next to .gitignore.
    // Codex F3 on the bc2b77b re-review flagged the prior docstring as
    // overstating this test's coverage.
    const dir = await makeTempDir();
    await Promise.all([ensureReaGitignore(dir), ensureReaGitignore(dir)]);

    const content = await fsPromises.readFile(path.join(dir, '.gitignore'), 'utf8');
    const startCount = (content.match(/# === rea managed — do not edit between markers ===/g) ?? [])
      .length;
    const endCount = (content.match(/# === end rea managed ===/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
    for (const entry of REA_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it('F7: crashed-temp leftover does not block a subsequent successful write', async () => {
    const dir = await makeTempDir();
    // Simulate a prior crash mid-write: stale temp file in-place. The
    // atomic writer uses randomBytes(16), so name collision is
    // astronomically unlikely — but the stale file shouldn't interfere
    // with a subsequent run either way. The post-F2 canonical list
    // includes `.gitignore.rea-tmp-*` at the repo root (where this temp
    // actually lives), so `git status` will not flag it either.
    await fsPromises.writeFile(
      path.join(dir, '.gitignore.rea-tmp-stale'),
      'garbage from a prior crash\n',
      'utf8',
    );

    const result = await ensureReaGitignore(dir);
    expect(result.action).toBe('created');
    const content = await fsPromises.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(content).toContain(GITIGNORE_BLOCK_START);
    // The root-level temp glob is in the canonical list.
    expect(content).toContain('.gitignore.rea-tmp-*');
    // Stale temp survives — we don't garbage-collect someone else's files.
    expect(fs.existsSync(path.join(dir, '.gitignore.rea-tmp-stale'))).toBe(true);
  });
});
