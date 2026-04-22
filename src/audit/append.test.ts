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

  it('resolves `.` against the current cwd on every call, not a cached view (finding R2-3)', async () => {
    // Regression: a prior revision cached `resolvedBaseDirCache.get('.') → /repoA`
    // keyed by the raw input string. After `process.chdir('/repoB')` a later
    // `appendAuditRecord('.', ...)` would still land in /repoA's chain —
    // cross-repo contamination. Re-resolving cwd on every call prevents this.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-audit-other-'));
    const resolvedOther = await fs.realpath(other);

    try {
      process.chdir(baseDir);
      await appendAuditRecord('.', {
        tool_name: 'in-baseDir',
        server_name: 'unit',
        metadata: { where: 'a' },
      });

      process.chdir(resolvedOther);
      await appendAuditRecord('.', {
        tool_name: 'in-other',
        server_name: 'unit',
        metadata: { where: 'b' },
      });

      // baseDir's log must contain ONLY the first record.
      const aLines = await readAuditLines(baseDir);
      expect(aLines).toHaveLength(1);
      expect(aLines[0]!.tool_name).toBe('in-baseDir');

      // The other dir's log must contain ONLY the second record.
      const bLines = await readAuditLines(resolvedOther);
      expect(bLines).toHaveLength(1);
      expect(bLines[0]!.tool_name).toBe('in-other');
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('throws before writing when JSON.stringify output fails self-check (defect T)', async () => {
    // Defect T contract: appendAuditRecord must verify its own serialization
    // round-trips through JSON.parse BEFORE the line touches .rea/audit.jsonl.
    // No public caller can currently produce an unparseable line (TypeScript
    // input shapes rule it out), so we simulate the failure mode by
    // monkey-patching JSON.stringify to emit a known-bad line for one call.
    //
    // The contract we assert:
    //   1. The helper throws with a diagnostic naming tool_name/server_name.
    //   2. `.rea/audit.jsonl` does NOT contain the malformed line — in fact,
    //      the file remains absent (this was the first write on a fresh repo).
    //   3. The hash chain on disk is untouched; a subsequent valid write
    //      lands cleanly.
    const originalStringify = JSON.stringify.bind(JSON);
    const spy = (value: unknown, ...rest: unknown[]): string => {
      // Only intercept the SECOND JSON.stringify call in the append path —
      // the one that serializes the fully-formed `record` (includes `hash`)
      // for on-disk write. The FIRST call is computeHash serializing
      // `recordBase` (has `tool_name` but no `hash`) — we must let that
      // return real JSON so the hash computes correctly; otherwise the
      // helper throws inside computeHash instead of the line self-check,
      // testing a different code path.
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).tool_name === 'T-self-check-target' &&
        typeof (value as Record<string, unknown>).hash === 'string'
      ) {
        // Emit a definitively-unparseable string. JSON.parse rejects a bare
        // trailing backslash-quote sequence, which is the canonical
        // "escape without target" failure — exactly the kind of byte
        // sequence defect T surfaced in the wild.
        return '{"broken":"\\}';
      }
      return originalStringify(value, ...(rest as []));
    };
    (JSON as { stringify: typeof JSON.stringify }).stringify = spy;

    try {
      await expect(
        appendAuditRecord(baseDir, {
          tool_name: 'T-self-check-target',
          server_name: 'unit',
          metadata: { defect: 'T' },
        }),
      ).rejects.toThrow(/Audit append aborted.*T-self-check-target.*No data was written/s);
    } finally {
      (JSON as { stringify: typeof JSON.stringify }).stringify = originalStringify;
    }

    // The audit file must not exist — the throw fired before fs.appendFile.
    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    await expect(fs.stat(auditFile)).rejects.toMatchObject({ code: 'ENOENT' });

    // A subsequent valid write lands cleanly and chains from GENESIS.
    const ok = await appendAuditRecord(baseDir, {
      tool_name: 'after-self-check',
      server_name: 'unit',
    });
    const lines = await readAuditLines(baseDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.tool_name).toBe('after-self-check');
    expect(lines[0]!.hash).toBe(ok.hash);
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
