/**
 * Unit tests for `cache-key.ts`. Most importantly, the fixture-backed
 * byte-exact compatibility test against the 0.10.1 bash core output.
 *
 * If any assertion in the fixture suite fails, the port has broken every
 * existing consumer's cache — revert the change or bump the contract
 * version per design §8.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { computeCacheKey } from './cache-key.js';
import { sha256Hex } from './hash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface FixtureScenario {
  diff: string;
  expected_key: string;
  expected_line_count_plus_minus: number;
  expected_file_count: number;
}

interface FixtureFile {
  scenarios: Record<string, FixtureScenario>;
}

const fixture: FixtureFile = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/cache-keys.json'), 'utf8'),
) as FixtureFile;

describe('computeCacheKey — contract', () => {
  it('produces a valid sha256 hex digest', () => {
    const key = computeCacheKey({ diff: 'anything' });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a pure function of the diff string only', () => {
    const key1 = computeCacheKey({ diff: 'abc' });
    const key2 = computeCacheKey({ diff: 'abc' });
    expect(key1).toBe(key2);
  });

  it('is equivalent to sha256Hex over the diff string', () => {
    const diff = 'some diff text';
    expect(computeCacheKey({ diff })).toBe(sha256Hex(diff));
  });

  it('differs when the diff differs by a single byte', () => {
    const a = computeCacheKey({ diff: 'x' });
    const b = computeCacheKey({ diff: 'y' });
    expect(a).not.toBe(b);
  });
});

describe('computeCacheKey — 0.10.1 compat fixtures (design §8)', () => {
  const scenarios = Object.entries(fixture.scenarios);

  it.each(scenarios)('produces byte-exact expected_key for scenario %s', (_name, scenario) => {
    expect(computeCacheKey({ diff: scenario.diff })).toBe(scenario.expected_key);
  });

  it('covers at least six representative scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
    const names = scenarios.map(([name]) => name);
    expect(names).toContain('bare-push-small');
    expect(names).toContain('multi-refspec');
    expect(names).toContain('force-push-rewrite');
    expect(names).toContain('new-branch-bootstrap');
    expect(names).toContain('cross-repo-scan');
    expect(names).toContain('unicode-filename');
  });
});
