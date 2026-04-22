/**
 * Unit tests for `cache.ts`.
 *
 * Two goals:
 *
 *   1. Byte-exact cache-key parity with Phase 1's `cache-key.ts` across
 *      all six scenarios in `__fixtures__/cache-keys.json`. A failure
 *      here means the port has broken the cache contract and the PR is
 *      rejected (design §8). This test runs Phase 2a's `computeCacheKey`
 *      wrapper (the one re-exported from `cache.ts`) and asserts the
 *      bash-0.10.1-captured expected_key for each scenario.
 *
 *   2. Cache-outcome translation: every one of the four discriminated
 *      outcomes (`hit_pass`, `hit_fail`, `miss`, `query_error`) can be
 *      produced, and each carries the expected payload.
 *
 * The integration tests in Phase 3 exercise end-to-end cache read/write
 * against real `.rea/review-cache.jsonl` files. Phase 2a proves the
 * primitives are right.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkReviewCache, computeCacheKey } from './cache.js';
import { appendEntry } from '../../cache/review-cache.js';
import * as reviewCache from '../../cache/review-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface FixtureScenario {
  diff: string;
  expected_key: string;
}
interface FixtureFile {
  scenarios: Record<string, FixtureScenario>;
}

const fixture: FixtureFile = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/cache-keys.json'), 'utf8'),
) as FixtureFile;

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'review-gate-cache-test-'));
  await mkdir(join(dir, '.rea'), { recursive: true });
  return dir;
}

describe('computeCacheKey — fixture parity with Phase 1 (design §8 contract)', () => {
  // This is the LOAD-BEARING contract. Phase 2a's `cache.ts` is a strict
  // re-export of Phase 1's `cache-key.ts::computeCacheKey`, so any drift
  // means one module has been changed in a way the other did not track.
  const scenarios = Object.entries(fixture.scenarios);

  it.each(scenarios)(
    'produces byte-exact expected_key for scenario %s (both phases must agree)',
    (_name, scenario) => {
      expect(computeCacheKey(scenario.diff)).toBe(scenario.expected_key);
    },
  );

  it('covers at least six representative scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
  });
});

describe('checkReviewCache — discriminated outcomes', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await freshRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns { kind: "miss", reason: "empty-file" } when the cache is empty', async () => {
    const outcome = await checkReviewCache({
      baseDir: repo,
      diff: 'anything',
      branch: 'feat/x',
      base: 'main',
    });
    expect(outcome.kind).toBe('miss');
    if (outcome.kind === 'miss') {
      expect(outcome.reason).toBe('empty-file');
      expect(outcome.key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns { kind: "miss", reason: "no-entry" } when key does not match any entry', async () => {
    // Populate an entry for a DIFFERENT diff.
    await appendEntry(repo, {
      sha: computeCacheKey('other diff'),
      branch: 'feat/x',
      base: 'main',
      result: 'pass',
    });
    const outcome = await checkReviewCache({
      baseDir: repo,
      diff: 'some diff',
      branch: 'feat/x',
      base: 'main',
    });
    expect(outcome.kind).toBe('miss');
    if (outcome.kind === 'miss') {
      expect(outcome.reason).toBe('no-entry');
    }
  });

  it('returns { kind: "hit_pass" } when the matching entry is a pass', async () => {
    const key = computeCacheKey('diff body X');
    await appendEntry(repo, {
      sha: key,
      branch: 'feat/x',
      base: 'main',
      result: 'pass',
    });
    const outcome = await checkReviewCache({
      baseDir: repo,
      diff: 'diff body X',
      branch: 'feat/x',
      base: 'main',
    });
    expect(outcome.kind).toBe('hit_pass');
    if (outcome.kind === 'hit_pass') {
      expect(outcome.key).toBe(key);
      expect(outcome.recorded_at).toMatch(/T.*Z$/);
    }
  });

  it('returns { kind: "hit_fail" } when the matching entry is a fail (bash §1197 carry-forward)', async () => {
    const key = computeCacheKey('diff with bad verdict');
    await appendEntry(repo, {
      sha: key,
      branch: 'feat/x',
      base: 'main',
      result: 'fail',
      reason: 'security-engineer flagged eval()',
    });
    const outcome = await checkReviewCache({
      baseDir: repo,
      diff: 'diff with bad verdict',
      branch: 'feat/x',
      base: 'main',
    });
    expect(outcome.kind).toBe('hit_fail');
    if (outcome.kind === 'hit_fail') {
      expect(outcome.reason).toBe('security-engineer flagged eval()');
    }
  });

  it('returns { kind: "hit_fail" } with NO reason when stored entry has no reason', async () => {
    const key = computeCacheKey('plain fail');
    await appendEntry(repo, {
      sha: key,
      branch: 'feat/x',
      base: 'main',
      result: 'fail',
    });
    const outcome = await checkReviewCache({
      baseDir: repo,
      diff: 'plain fail',
      branch: 'feat/x',
      base: 'main',
    });
    expect(outcome.kind).toBe('hit_fail');
    if (outcome.kind === 'hit_fail') {
      expect(outcome.reason).toBeUndefined();
    }
  });

  it('returns { kind: "miss", reason: "expired" } when TTL expires', async () => {
    const key = computeCacheKey('expired diff');
    await appendEntry(repo, {
      sha: key,
      branch: 'feat/x',
      base: 'main',
      result: 'pass',
      // Recorded 2 hours ago
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const outcome = await checkReviewCache({
      baseDir: repo,
      diff: 'expired diff',
      branch: 'feat/x',
      base: 'main',
      maxAgeSeconds: 3600, // 1 hour TTL
    });
    expect(outcome.kind).toBe('miss');
    if (outcome.kind === 'miss') {
      expect(outcome.reason).toBe('expired');
    }
  });

  it('returns { kind: "query_error" } when the underlying lookup throws', async () => {
    vi.spyOn(reviewCache, 'lookup').mockRejectedValueOnce(new Error('disk I/O fault'));
    const outcome = await checkReviewCache({
      baseDir: repo,
      diff: 'whatever',
      branch: 'feat/x',
      base: 'main',
    });
    expect(outcome.kind).toBe('query_error');
    if (outcome.kind === 'query_error') {
      expect(outcome.error).toBe('disk I/O fault');
      expect(outcome.key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('selects entries by (sha, branch, base) — not just sha', async () => {
    const key = computeCacheKey('diff body Y');
    // Record for a DIFFERENT base.
    await appendEntry(repo, {
      sha: key,
      branch: 'feat/x',
      base: 'dev', // not main
      result: 'pass',
    });
    // Lookup targets main → miss.
    const outcome = await checkReviewCache({
      baseDir: repo,
      diff: 'diff body Y',
      branch: 'feat/x',
      base: 'main',
    });
    expect(outcome.kind).toBe('miss');
  });

  it('respects the nowMs override for deterministic TTL tests', async () => {
    const key = computeCacheKey('diff Z');
    const recorded = new Date('2026-04-01T00:00:00Z').toISOString();
    await appendEntry(repo, {
      sha: key,
      branch: 'feat/x',
      base: 'main',
      result: 'pass',
      timestamp: recorded,
    });
    // nowMs 1 minute after recording — within TTL.
    const fresh = await checkReviewCache({
      baseDir: repo,
      diff: 'diff Z',
      branch: 'feat/x',
      base: 'main',
      nowMs: Date.parse(recorded) + 60_000,
    });
    expect(fresh.kind).toBe('hit_pass');
    // nowMs 2h after recording — past default TTL.
    const stale = await checkReviewCache({
      baseDir: repo,
      diff: 'diff Z',
      branch: 'feat/x',
      base: 'main',
      nowMs: Date.parse(recorded) + 2 * 60 * 60 * 1000,
    });
    expect(stale.kind).toBe('miss');
  });
});
