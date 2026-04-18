/**
 * Unit tests for `appendAuditRecord` — focused on the guarantees the helper
 * makes in its module header: hash-chain integrity and per-process
 * serialization.
 *
 * Finding #6 coverage: two callers that reference the same on-disk directory
 * via different surface forms (`'.'` after chdir, `process.cwd()`, a symlink,
 * etc.) must land on the same write queue. Otherwise concurrent writes bypass
 * serialization and can interleave, breaking the prev_hash chain.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditRecord, type AuditRecord } from './append.js';

async function readAuditLines(baseDir: string): Promise<AuditRecord[]> {
  const file = path.join(baseDir, '.rea', 'audit.jsonl');
  const raw = await fs.readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe('appendAuditRecord — hash-chain normalization (finding #6)', () => {
  let baseDir: string;
  let previousCwd: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-audit-'));
    // Resolve symlinks up front: macOS `/tmp` is a symlink to `/private/tmp`,
    // and we want the test's own path strings to be stable.
    baseDir = await fs.realpath(baseDir);
    previousCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('serializes concurrent appends under the SAME baseDir form', async () => {
    // Kick off 20 concurrent appends — if the per-process queue works, every
    // record's prev_hash must equal the previous record's hash, in order.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendAuditRecord(baseDir, {
          tool_name: 'test',
          server_name: 'unit',
          metadata: { index: i },
        }),
      ),
    );
    expect(results).toHaveLength(20);

    // Read back from disk and verify the chain. File order == write order
    // under per-process serialization.
    const lines = await readAuditLines(baseDir);
    expect(lines).toHaveLength(20);
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const cur = lines[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      expect(cur!.prev_hash).toBe(prev!.hash);
    }
  });

  it('serializes appends across DIFFERENT-looking baseDir paths pointing at the same directory', async () => {
    // This is the heart of finding #6. Caller A uses the absolute path;
    // caller B uses `'.'` after chdir into the same directory. Before the fix
    // these produced different queue keys and could interleave.
    process.chdir(baseDir);

    const absoluteForm = baseDir;
    const relativeForm = '.';

    // Interleave the two callers heavily. If the queue key is normalized,
    // every record chains cleanly. If it isn't, a later write can snapshot
    // `readLastHash` before an earlier concurrent write has committed, and
    // two records end up with the same `prev_hash`.
    const ops: Promise<AuditRecord>[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push(
        appendAuditRecord(absoluteForm, {
          tool_name: 'abs',
          server_name: 'unit',
          metadata: { index: i },
        }),
      );
      ops.push(
        appendAuditRecord(relativeForm, {
          tool_name: 'rel',
          server_name: 'unit',
          metadata: { index: i },
        }),
      );
    }
    await Promise.all(ops);

    const lines = await readAuditLines(baseDir);
    expect(lines).toHaveLength(20);

    // Chain integrity: each prev_hash equals the previous record's hash.
    const seenPrevHashes = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const cur = lines[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      expect(cur!.prev_hash).toBe(prev!.hash);
      // Also: no prev_hash should appear twice. A duplicate prev_hash is the
      // signature of two writes racing past `readLastHash` with the same
      // view of the tail — the specific corruption this fix prevents.
      expect(seenPrevHashes.has(cur!.prev_hash)).toBe(false);
      seenPrevHashes.add(cur!.prev_hash);
    }
  });

  it('serializes appends across a symlinked baseDir and its real path', async () => {
    // Create a symlink that resolves to baseDir. Callers passing the link and
    // callers passing the real path must share the same queue.
    const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-audit-link-parent-'));
    const link = path.join(linkDir, 'alias');
    await fs.symlink(baseDir, link);

    try {
      const ops: Promise<AuditRecord>[] = [];
      for (let i = 0; i < 10; i++) {
        ops.push(appendAuditRecord(baseDir, { tool_name: 'real', server_name: 'unit' }));
        ops.push(appendAuditRecord(link, { tool_name: 'link', server_name: 'unit' }));
      }
      await Promise.all(ops);

      const lines = await readAuditLines(baseDir);
      expect(lines).toHaveLength(20);
      for (let i = 1; i < lines.length; i++) {
        const prev = lines[i - 1];
        const cur = lines[i];
        expect(prev).toBeDefined();
        expect(cur).toBeDefined();
        expect(cur!.prev_hash).toBe(prev!.hash);
      }
    } finally {
      await fs.rm(linkDir, { recursive: true, force: true });
    }
  });
});
