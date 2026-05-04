/**
 * Unit tests for the durable verdict cache (0.18.1+, helixir #1, #4, #7, #8).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CACHE_TTL_MS,
  VERDICT_CACHE_FILE,
  VERDICT_CACHE_SCHEMA_VERSION,
  clearAll,
  clearVerdict,
  isFlip,
  listEntries,
  lookupVerdict,
  pruneOlderThan,
  writeVerdict,
  type VerdictCacheEntry,
} from './verdict-cache.js';

let baseDir = '';

async function makeBaseDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rea-verdict-cache-'));
  await fs.promises.mkdir(path.join(dir, '.rea'), { recursive: true });
  return dir;
}

beforeEach(async () => {
  baseDir = await makeBaseDir();
});

afterEach(async () => {
  if (baseDir) {
    await fs.promises.rm(baseDir, { recursive: true, force: true });
    baseDir = '';
  }
});

const FRESH_ENTRY = (overrides: Partial<VerdictCacheEntry> = {}): VerdictCacheEntry => ({
  verdict: 'pass',
  finding_count: 0,
  reviewed_at: new Date().toISOString(),
  model: 'gpt-5.4',
  reasoning_effort: 'high',
  ttl_ms: DEFAULT_CACHE_TTL_MS,
  ...overrides,
});

describe('verdict-cache — write + lookup roundtrip', () => {
  it('lookup returns hit for fresh entry within TTL', async () => {
    await writeVerdict(baseDir, 'sha-abc', FRESH_ENTRY());
    const r = lookupVerdict(baseDir, 'sha-abc');
    expect(r.hit).toBe(true);
    expect(r.entry?.verdict).toBe('pass');
  });

  it('lookup returns miss when no cache file exists', () => {
    const r = lookupVerdict(baseDir, 'sha-abc');
    expect(r.hit).toBe(false);
    expect(r.entry).toBeUndefined();
  });

  it('lookup returns miss for unknown SHA in existing cache', async () => {
    await writeVerdict(baseDir, 'sha-abc', FRESH_ENTRY());
    const r = lookupVerdict(baseDir, 'sha-xyz');
    expect(r.hit).toBe(false);
  });

  it('writes the cache file with the documented schema version', async () => {
    await writeVerdict(baseDir, 'sha-abc', FRESH_ENTRY());
    const raw = fs.readFileSync(path.join(baseDir, '.rea', VERDICT_CACHE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.schema_version).toBe(VERDICT_CACHE_SCHEMA_VERSION);
    expect(parsed.entries['sha-abc'].verdict).toBe('pass');
  });

  it('preserves prior entries on subsequent writes', async () => {
    await writeVerdict(baseDir, 'sha-abc', FRESH_ENTRY({ verdict: 'pass' }));
    await writeVerdict(baseDir, 'sha-def', FRESH_ENTRY({ verdict: 'concerns' }));
    expect(lookupVerdict(baseDir, 'sha-abc').entry?.verdict).toBe('pass');
    expect(lookupVerdict(baseDir, 'sha-def').entry?.verdict).toBe('concerns');
  });
});

describe('verdict-cache — TTL expiry', () => {
  it('lookup returns miss + entry when stale', async () => {
    const stale = FRESH_ENTRY({
      reviewed_at: new Date(Date.now() - 2 * DEFAULT_CACHE_TTL_MS).toISOString(),
      ttl_ms: DEFAULT_CACHE_TTL_MS,
    });
    await writeVerdict(baseDir, 'sha-abc', stale);
    const r = lookupVerdict(baseDir, 'sha-abc');
    expect(r.hit).toBe(false);
    expect(r.entry).toBeDefined();
    expect(r.expired).toBe(true);
  });

  it('lookup uses the entry-stored ttl_ms (per-entry TTL, not global)', async () => {
    const shortTtl = FRESH_ENTRY({
      reviewed_at: new Date(Date.now() - 5_000).toISOString(),
      ttl_ms: 1_000, // 1 second TTL — already expired
    });
    await writeVerdict(baseDir, 'sha-abc', shortTtl);
    expect(lookupVerdict(baseDir, 'sha-abc').hit).toBe(false);
  });

  it('lookup with explicit `now` uses caller clock', async () => {
    const entry = FRESH_ENTRY({ reviewed_at: '2026-05-01T00:00:00.000Z' });
    await writeVerdict(baseDir, 'sha-abc', entry);
    const future = new Date('2026-05-03T00:00:00.000Z'); // 2 days later, default TTL=24h
    expect(lookupVerdict(baseDir, 'sha-abc', future).hit).toBe(false);
    const same = new Date('2026-05-01T01:00:00.000Z'); // 1h later
    expect(lookupVerdict(baseDir, 'sha-abc', same).hit).toBe(true);
  });
});

describe('verdict-cache — flip detection', () => {
  it('isFlip returns false when no prior entry', () => {
    expect(isFlip(undefined, 'pass')).toBe(false);
  });

  it('isFlip returns false when verdicts match', () => {
    expect(isFlip(FRESH_ENTRY({ verdict: 'pass' }), 'pass')).toBe(false);
  });

  it('isFlip returns true on PASS → CONCERNS (helixir round 82 reproducer)', () => {
    expect(isFlip(FRESH_ENTRY({ verdict: 'pass' }), 'concerns')).toBe(true);
  });

  it('isFlip returns true on CONCERNS → PASS (reverse instability)', () => {
    expect(isFlip(FRESH_ENTRY({ verdict: 'concerns' }), 'pass')).toBe(true);
  });

  it('isFlip returns true on PASS → BLOCKING (severity escalation)', () => {
    expect(isFlip(FRESH_ENTRY({ verdict: 'pass' }), 'blocking')).toBe(true);
  });
});

describe('verdict-cache — clear + prune', () => {
  it('clearVerdict removes one entry', async () => {
    await writeVerdict(baseDir, 'sha-a', FRESH_ENTRY());
    await writeVerdict(baseDir, 'sha-b', FRESH_ENTRY());
    expect(await clearVerdict(baseDir, 'sha-a')).toBe(true);
    expect(lookupVerdict(baseDir, 'sha-a').hit).toBe(false);
    expect(lookupVerdict(baseDir, 'sha-b').hit).toBe(true);
  });

  it('clearVerdict returns false on unknown SHA', async () => {
    await writeVerdict(baseDir, 'sha-a', FRESH_ENTRY());
    expect(await clearVerdict(baseDir, 'sha-unknown')).toBe(false);
  });

  it('clearAll empties all entries and returns the count', async () => {
    await writeVerdict(baseDir, 'sha-a', FRESH_ENTRY());
    await writeVerdict(baseDir, 'sha-b', FRESH_ENTRY());
    expect(await clearAll(baseDir)).toBe(2);
    expect(Object.keys(listEntries(baseDir))).toHaveLength(0);
  });

  it('pruneOlderThan removes entries older than the cutoff', async () => {
    await writeVerdict(
      baseDir,
      'sha-old',
      FRESH_ENTRY({ reviewed_at: '2026-01-01T00:00:00.000Z' }),
    );
    await writeVerdict(baseDir, 'sha-new', FRESH_ENTRY({ reviewed_at: new Date().toISOString() }));
    const removed = await pruneOlderThan(baseDir, 7 * 24 * 60 * 60 * 1_000); // 7 days
    expect(removed).toBe(1);
    expect(lookupVerdict(baseDir, 'sha-old').entry).toBeUndefined();
    expect(lookupVerdict(baseDir, 'sha-new').hit).toBe(true);
  });
});

describe('verdict-cache — corruption resilience', () => {
  it('lookup returns miss when cache file is malformed JSON', () => {
    fs.writeFileSync(path.join(baseDir, '.rea', VERDICT_CACHE_FILE), 'not json', 'utf8');
    expect(lookupVerdict(baseDir, 'sha-a').hit).toBe(false);
  });

  it('lookup returns miss when schema_version is wrong', () => {
    fs.writeFileSync(
      path.join(baseDir, '.rea', VERDICT_CACHE_FILE),
      JSON.stringify({ schema_version: 999, entries: { 'sha-a': FRESH_ENTRY() } }),
      'utf8',
    );
    expect(lookupVerdict(baseDir, 'sha-a').hit).toBe(false);
  });

  it('lookup returns miss when reviewed_at is unparseable', async () => {
    await writeVerdict(baseDir, 'sha-a', FRESH_ENTRY({ reviewed_at: 'not-a-date' }));
    expect(lookupVerdict(baseDir, 'sha-a').hit).toBe(false);
  });
});

describe('verdict-cache — atomic write', () => {
  it('write is atomic via tmp-file + rename (no partial file under racing reads)', async () => {
    await writeVerdict(baseDir, 'sha-a', FRESH_ENTRY());
    // The cache file exists; tmp file is gone.
    const cachePath = path.join(baseDir, '.rea', VERDICT_CACHE_FILE);
    expect(fs.existsSync(cachePath)).toBe(true);
    const tmpFiles = fs
      .readdirSync(path.join(baseDir, '.rea'))
      .filter((f) => f.startsWith(VERDICT_CACHE_FILE) && f !== VERDICT_CACHE_FILE);
    expect(tmpFiles).toHaveLength(0);
  });
});
