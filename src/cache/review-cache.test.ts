/**
 * Unit tests for the review-cache persistence layer (BUG-009).
 *
 * The cache is not hash-chained, but it IS cross-process locked via the same
 * `.rea/` directory lock as the audit log — so the round-trip, last-write-wins,
 * TTL, and concurrent-safety invariants all have to hold.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_MAX_AGE_SECONDS,
  appendEntry,
  clear,
  list,
  lookup,
  resolveCacheFile,
  type CacheEntry,
} from './review-cache.js';

async function readRawLines(baseDir: string): Promise<string[]> {
  const file = resolveCacheFile(baseDir);
  const raw = await fs.readFile(file, 'utf8');
  return raw.split('\n').filter((l) => l.length > 0);
}

describe('review-cache', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-cache-'));
    baseDir = await fs.realpath(baseDir);
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  describe('appendEntry + lookup', () => {
    it('round-trips a pass entry and returns a hit within the TTL window', async () => {
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
      });

      const result = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
      });

      expect(result.hit).toBe(true);
      expect(result.entry?.result).toBe('pass');
      expect(result.entry?.branch).toBe('feat/x');
      expect(result.entry?.base).toBe('main');
      expect(typeof result.entry?.recorded_at).toBe('string');
    });

    it('returns a no-entry miss when nothing matches', async () => {
      const result = await lookup(baseDir, {
        sha: 'no-such',
        branch: 'feat/x',
        base: 'main',
      });
      expect(result.hit).toBe(false);
      expect(result.missReason).toBe('empty-file');
    });

    it('treats a (sha, branch, base) mismatch as a miss even when other fields match', async () => {
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
      });

      const wrongBranch = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/y',
        base: 'main',
      });
      const wrongBase = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'dev',
      });

      expect(wrongBranch.hit).toBe(false);
      expect(wrongBranch.missReason).toBe('no-entry');
      expect(wrongBase.hit).toBe(false);
      expect(wrongBase.missReason).toBe('no-entry');
    });

    it('persists optional reason when supplied', async () => {
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'fail',
        reason: 'security finding unresolved',
      });

      const result = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
      });
      expect(result.hit).toBe(true);
      expect(result.entry?.reason).toBe('security finding unresolved');
    });

    it('omits reason field when not supplied (idempotent JSON shape)', async () => {
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
      });
      const [line] = await readRawLines(baseDir);
      const parsed = JSON.parse(line!) as CacheEntry;
      expect(parsed.reason).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(parsed, 'reason')).toBe(false);
    });
  });

  describe('TTL behavior', () => {
    it('treats an entry older than max_age as an expired miss', async () => {
      const oldTimestamp = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
        timestamp: oldTimestamp,
      });

      const result = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        maxAgeSeconds: DEFAULT_CACHE_MAX_AGE_SECONDS, // 1 hour
      });
      expect(result.hit).toBe(false);
      expect(result.missReason).toBe('expired');
      expect(result.entry).toBeDefined();
    });

    it('honors a caller-supplied nowMs reference', async () => {
      const recordedAt = '2026-04-19T12:00:00.000Z';
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
        timestamp: recordedAt,
      });

      const withinWindow = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        nowMs: Date.parse('2026-04-19T12:30:00.000Z'),
        maxAgeSeconds: 3600,
      });
      const beyondWindow = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        nowMs: Date.parse('2026-04-19T13:00:01.000Z'),
        maxAgeSeconds: 3600,
      });

      expect(withinWindow.hit).toBe(true);
      expect(beyondWindow.hit).toBe(false);
      expect(beyondWindow.missReason).toBe('expired');
    });

    it('uses the default TTL when no maxAgeSeconds is passed', async () => {
      const now = Date.now();
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
        timestamp: new Date(now - 1000).toISOString(),
      });
      const result = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
      });
      expect(result.hit).toBe(true);
    });

    it('treats a far-future timestamp as an expired miss (Codex F3: skew guard)', async () => {
      // A `recorded_at` 10 minutes in the future cannot be trusted — either
      // the writer had a skewed clock or the line was tampered. Either way,
      // the correct behavior is to force a re-review rather than extend an
      // approval indefinitely (finding #3 on the PR1 Codex review).
      const now = Date.parse('2026-04-19T12:00:00.000Z');
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
        timestamp: '2026-04-19T12:10:00.000Z',
      });

      const result = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        nowMs: now,
        maxAgeSeconds: 3600,
      });

      expect(result.hit).toBe(false);
      expect(result.missReason).toBe('expired');
    });

    it('tolerates up to 60s of forward skew as a hit (Codex F3: skew allowance)', async () => {
      // 30 seconds in the future is plausible NTP jitter on well-synced hosts
      // and must still count as a hit. 60s is the ceiling.
      const now = Date.parse('2026-04-19T12:00:00.000Z');
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
        timestamp: new Date(now + 30_000).toISOString(),
      });

      const result = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        nowMs: now,
        maxAgeSeconds: 3600,
      });

      expect(result.hit).toBe(true);
    });
  });

  describe('last-write-wins semantics', () => {
    it('returns the newest entry matching (sha, branch, base) on duplicate writes', async () => {
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'fail',
        reason: 'first attempt',
        timestamp: '2026-04-19T10:00:00.000Z',
      });
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
        timestamp: '2026-04-19T11:00:00.000Z',
      });

      const result = await lookup(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        nowMs: Date.parse('2026-04-19T11:30:00.000Z'),
        maxAgeSeconds: 7200,
      });
      expect(result.hit).toBe(true);
      expect(result.entry?.result).toBe('pass');
      expect(result.entry?.reason).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes every entry matching the given sha', async () => {
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'fail',
      });
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
      });
      await appendEntry(baseDir, {
        sha: 'zzz999',
        branch: 'feat/y',
        base: 'main',
        result: 'pass',
      });

      const removed = await clear(baseDir, 'abc123');
      expect(removed).toBe(2);

      const entries = await list(baseDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sha).toBe('zzz999');
    });

    it('is a no-op (returns 0) when no entries match', async () => {
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
      });
      const removed = await clear(baseDir, 'not-present');
      expect(removed).toBe(0);
    });

    it('empties the file when clearing the only sha present', async () => {
      await appendEntry(baseDir, {
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
      });
      const removed = await clear(baseDir, 'abc123');
      expect(removed).toBe(1);
      const lines = await readRawLines(baseDir);
      expect(lines).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('returns entries in file order', async () => {
      await appendEntry(baseDir, {
        sha: 'aaa',
        branch: 'a',
        base: 'main',
        result: 'pass',
      });
      await appendEntry(baseDir, {
        sha: 'bbb',
        branch: 'b',
        base: 'main',
        result: 'pass',
      });
      const entries = await list(baseDir);
      expect(entries.map((e) => e.sha)).toEqual(['aaa', 'bbb']);
    });

    it('filters by branch when requested', async () => {
      await appendEntry(baseDir, {
        sha: 'aaa',
        branch: 'a',
        base: 'main',
        result: 'pass',
      });
      await appendEntry(baseDir, {
        sha: 'bbb',
        branch: 'b',
        base: 'main',
        result: 'pass',
      });
      const entries = await list(baseDir, { branch: 'a' });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sha).toBe('aaa');
    });

    it('returns an empty array for a missing cache file', async () => {
      const entries = await list(baseDir);
      expect(entries).toEqual([]);
    });
  });

  describe('concurrent-write safety', () => {
    it('does not corrupt or drop entries under 20 concurrent appends', async () => {
      const writes = Array.from({ length: 20 }, (_, i) =>
        appendEntry(baseDir, {
          sha: `sha-${i.toString().padStart(2, '0')}`,
          branch: 'feat/x',
          base: 'main',
          result: 'pass',
        }),
      );
      await Promise.all(writes);

      const lines = await readRawLines(baseDir);
      expect(lines).toHaveLength(20);
      // Every line must be valid JSON with the expected shape (no torn writes).
      const parsed = lines.map((l) => JSON.parse(l) as CacheEntry);
      const shaSet = new Set(parsed.map((e) => e.sha));
      expect(shaSet.size).toBe(20);
    });

    it('Codex F4: 10 appends + 1 clear interleaved — final line count is self-consistent', async () => {
      // Seed a line targeted by the clear call so the clear has work to do.
      await appendEntry(baseDir, {
        sha: 'target',
        branch: 'x',
        base: 'main',
        result: 'pass',
      });

      const appends = Array.from({ length: 10 }, (_, i) =>
        appendEntry(baseDir, {
          sha: `a-${i}`,
          branch: 'x',
          base: 'main',
          result: 'pass',
        }),
      );
      const clearOp = clear(baseDir, 'target');
      await Promise.all([...appends, clearOp]);

      const lines = await readRawLines(baseDir);
      // Each surviving line must be valid JSON with the expected shape.
      const parsed = lines.map((l) => JSON.parse(l) as CacheEntry);
      expect(parsed.every((e) => typeof e.sha === 'string' && e.sha.length > 0)).toBe(
        true,
      );
      // 'target' must be gone regardless of interleave order. 10 appended shas
      // must each appear at least once (no lost append).
      const seen = new Set(parsed.map((e) => e.sha));
      expect(seen.has('target')).toBe(false);
      for (let i = 0; i < 10; i++) {
        expect(seen.has(`a-${i}`)).toBe(true);
      }
    });

    it('Codex F4: 5 concurrent clears for overlapping shas — no exception, idempotent', async () => {
      await Promise.all([
        appendEntry(baseDir, { sha: 's1', branch: 'x', base: 'main', result: 'pass' }),
        appendEntry(baseDir, { sha: 's2', branch: 'x', base: 'main', result: 'pass' }),
        appendEntry(baseDir, { sha: 's3', branch: 'x', base: 'main', result: 'pass' }),
      ]);

      const clears = [
        clear(baseDir, 's1'),
        clear(baseDir, 's1'),
        clear(baseDir, 's2'),
        clear(baseDir, 's2'),
        clear(baseDir, 's3'),
      ];
      // Must not throw under any interleave.
      await expect(Promise.all(clears)).resolves.toBeDefined();

      // Final file contains zero of the cleared shas. Length may be 0.
      const entries = await list(baseDir);
      const seen = new Set(entries.map((e) => e.sha));
      expect(seen.has('s1')).toBe(false);
      expect(seen.has('s2')).toBe(false);
      expect(seen.has('s3')).toBe(false);
    });

    it('Codex F4: lookup during clear observes either pre-clear hit or post-clear miss — never an exception', async () => {
      await appendEntry(baseDir, {
        sha: 'race',
        branch: 'x',
        base: 'main',
        result: 'pass',
      });

      const clearOp = clear(baseDir, 'race');
      const lookups = Array.from({ length: 50 }, () =>
        lookup(baseDir, { sha: 'race', branch: 'x', base: 'main' }),
      );
      const results = await Promise.all([clearOp, ...lookups]);
      // Drop the clear result; every remaining result must be a CacheLookupResult
      // shape with boolean hit. No torn-parse, no exception.
      const lookupResults = results.slice(1) as Array<{ hit: boolean }>;
      for (const r of lookupResults) {
        expect(typeof r.hit).toBe('boolean');
      }
    });
  });

  describe('robustness against malformed lines', () => {
    it('skips malformed lines on read without throwing', async () => {
      const file = resolveCacheFile(baseDir);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        [
          JSON.stringify({
            sha: 'good',
            branch: 'a',
            base: 'main',
            result: 'pass',
            recorded_at: new Date().toISOString(),
          }),
          'not-json',
          JSON.stringify({
            sha: 'also-good',
            branch: 'b',
            base: 'main',
            result: 'pass',
            recorded_at: new Date().toISOString(),
          }),
          '',
        ].join('\n'),
      );

      const entries = await list(baseDir);
      expect(entries.map((e) => e.sha)).toEqual(['good', 'also-good']);
    });

    it('treats corrupt timestamps as expired misses (never crashes the gate)', async () => {
      const file = resolveCacheFile(baseDir);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        JSON.stringify({
          sha: 'abc',
          branch: 'a',
          base: 'main',
          result: 'pass',
          recorded_at: 'not-a-timestamp',
        }) + '\n',
      );

      const result = await lookup(baseDir, { sha: 'abc', branch: 'a', base: 'main' });
      expect(result.hit).toBe(false);
      expect(result.missReason).toBe('expired');
    });
  });
});
