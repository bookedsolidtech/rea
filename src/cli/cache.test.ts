/**
 * CLI-level tests for `rea cache` (BUG-009).
 *
 * Focus areas:
 *   1. `rea cache check` writes ONLY JSON to stdout (hook contract).
 *   2. `rea cache check` honors policy `review.cache_max_age_seconds` when
 *      present, else the default TTL (3600s).
 *   3. `rea cache check` degrades to default TTL on a missing/malformed
 *      policy — never deadlocking the push gate.
 *   4. `rea cache set` round-trips via `rea cache check` as "hit".
 *   5. `rea cache clear` / `list` touch the expected entries only.
 *   6. `parseCacheResult` rejects anything other than `pass`/`fail`.
 *
 * These exercise the exported `runCache*` functions directly in a tempdir with
 * `process.chdir`, matching the pattern used in `status.test.ts`.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseCacheResult,
  runCacheCheck,
  runCacheClear,
  runCacheList,
  runCacheSet,
} from './cache.js';
import { invalidatePolicyCache } from '../policy/loader.js';
import { resolveCacheFile } from '../cache/review-cache.js';

async function writePolicy(
  baseDir: string,
  overrides: Partial<{ cache_max_age_seconds: number }> = {},
): Promise<void> {
  const review: string[] = ['review:', '  codex_required: false'];
  if (overrides.cache_max_age_seconds !== undefined) {
    review.push(`  cache_max_age_seconds: ${overrides.cache_max_age_seconds}`);
  }
  const yaml = [
    'version: "1"',
    'profile: "minimal"',
    'installed_by: "tester"',
    'installed_at: "2026-04-19T00:00:00Z"',
    'autonomy_level: L1',
    'max_autonomy_level: L2',
    'promotion_requires_human_approval: true',
    'block_ai_attribution: true',
    'blocked_paths:',
    '  - ".env"',
    'notification_channel: ""',
    ...review,
    '',
  ].join('\n');
  await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
}

function captureStdout(fn: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  logs: string[];
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const logs: string[] = [];

  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  return fn()
    .then(() => ({
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
      logs,
    }))
    .finally(() => {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
}

describe('runCacheCheck — hook contract', () => {
  let baseDir: string;
  let previousCwd: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-cache-cli-'));
    baseDir = await fs.realpath(baseDir);
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    previousCwd = process.cwd();
    process.chdir(baseDir);
    invalidatePolicyCache();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    invalidatePolicyCache();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('emits {"hit":false} on miss with ONLY JSON on stdout', async () => {
    const { stdout, stderr } = await captureStdout(() =>
      runCacheCheck({ sha: 'abc123', branch: 'feat/x', base: 'main' }),
    );
    expect(stdout.trim()).toBe('{"hit":false}');
    expect(stderr).toBe('');
    expect(JSON.parse(stdout.trim())).toEqual({ hit: false });
  });

  it('emits a full hit payload on a fresh pass entry', async () => {
    await writePolicy(baseDir);
    await captureStdout(() =>
      runCacheSet({
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
      }),
    );

    const { stdout } = await captureStdout(() =>
      runCacheCheck({ sha: 'abc123', branch: 'feat/x', base: 'main' }),
    );
    const payload = JSON.parse(stdout.trim()) as {
      hit: boolean;
      result: string;
      branch: string;
      base: string;
      recorded_at: string;
    };
    expect(payload.hit).toBe(true);
    expect(payload.result).toBe('pass');
    expect(payload.branch).toBe('feat/x');
    expect(payload.base).toBe('main');
    expect(typeof payload.recorded_at).toBe('string');
  });

  it('never writes diagnostic output to stdout on check (hook parses jq)', async () => {
    await writePolicy(baseDir);
    const { stdout, stderr, logs } = await captureStdout(() =>
      runCacheCheck({ sha: 'nothere', branch: 'feat/x', base: 'main' }),
    );
    expect(stdout.trim()).toBe('{"hit":false}');
    expect(logs).toEqual([]);
    expect(stderr).toBe('');
  });

  it('degrades to default TTL when policy is missing (no deadlock)', async () => {
    // No policy file at all. Write an entry 59 minutes old — should hit under
    // the 3600s default TTL.
    await captureStdout(() =>
      runCacheSet({
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
      }),
    );
    // Overwrite the just-written entry with one ~59 minutes old by rewriting
    // the file directly — simulates a cache entry from ~1h ago.
    const cacheFile = resolveCacheFile(baseDir);
    const nearlyExpired = new Date(Date.now() - 59 * 60 * 1000).toISOString();
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
        recorded_at: nearlyExpired,
      }) + '\n',
    );

    const { stdout } = await captureStdout(() =>
      runCacheCheck({ sha: 'abc123', branch: 'feat/x', base: 'main' }),
    );
    const payload = JSON.parse(stdout.trim()) as { hit: boolean };
    expect(payload.hit).toBe(true);
  });

  it('respects a shorter review.cache_max_age_seconds set in policy', async () => {
    await writePolicy(baseDir, { cache_max_age_seconds: 60 });

    // Write an entry two minutes old — must miss under a 60s TTL.
    const cacheFile = resolveCacheFile(baseDir);
    const tooOld = new Date(Date.now() - 120 * 1000).toISOString();
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
        recorded_at: tooOld,
      }) + '\n',
    );

    const { stdout } = await captureStdout(() =>
      runCacheCheck({ sha: 'abc123', branch: 'feat/x', base: 'main' }),
    );
    expect(JSON.parse(stdout.trim())).toEqual({ hit: false });
  });

  it('degrades to default TTL when policy is malformed rather than blocking the gate', async () => {
    // Write a deliberately invalid policy (missing required fields).
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      'version: "1"\nprofile: "minimal"\n',
      'utf8',
    );

    const recent = new Date(Date.now() - 1000).toISOString();
    const cacheFile = resolveCacheFile(baseDir);
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        sha: 'abc123',
        branch: 'feat/x',
        base: 'main',
        result: 'pass',
        recorded_at: recent,
      }) + '\n',
    );

    const { stdout } = await captureStdout(() =>
      runCacheCheck({ sha: 'abc123', branch: 'feat/x', base: 'main' }),
    );
    expect(JSON.parse(stdout.trim())).toEqual(
      expect.objectContaining({ hit: true, result: 'pass' }),
    );
  });
});

describe('runCacheSet + runCacheList + runCacheClear', () => {
  let baseDir: string;
  let previousCwd: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-cache-cli-ops-'));
    baseDir = await fs.realpath(baseDir);
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    previousCwd = process.cwd();
    process.chdir(baseDir);
    invalidatePolicyCache();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    invalidatePolicyCache();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('writes one JSONL entry per set and lists them in order', async () => {
    await captureStdout(() =>
      runCacheSet({ sha: 'aaa', branch: 'a', base: 'main', result: 'pass' }),
    );
    await captureStdout(() =>
      runCacheSet({
        sha: 'bbb',
        branch: 'b',
        base: 'main',
        result: 'fail',
        reason: 'still failing',
      }),
    );

    const cacheFile = resolveCacheFile(baseDir);
    const raw = await fs.readFile(cacheFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    const { logs } = await captureStdout(() => runCacheList({}));
    expect(logs.some((l) => l.includes('aaa') && l.includes('a → main'))).toBe(true);
    expect(logs.some((l) => l.includes('bbb') && l.includes('still failing'))).toBe(true);
  });

  it('clear removes every matching entry', async () => {
    await captureStdout(() =>
      runCacheSet({ sha: 'aaa', branch: 'a', base: 'main', result: 'pass' }),
    );
    await captureStdout(() =>
      runCacheSet({ sha: 'aaa', branch: 'a', base: 'main', result: 'fail' }),
    );
    await captureStdout(() =>
      runCacheSet({ sha: 'bbb', branch: 'b', base: 'main', result: 'pass' }),
    );

    await captureStdout(() => runCacheClear({ sha: 'aaa' }));

    const { logs } = await captureStdout(() => runCacheList({}));
    expect(logs.some((l) => l.includes('aaa'))).toBe(false);
    expect(logs.some((l) => l.includes('bbb'))).toBe(true);
  });

  it('list --branch filters to the named branch only', async () => {
    await captureStdout(() =>
      runCacheSet({ sha: 'aaa', branch: 'a', base: 'main', result: 'pass' }),
    );
    await captureStdout(() =>
      runCacheSet({ sha: 'bbb', branch: 'b', base: 'main', result: 'pass' }),
    );
    const { logs } = await captureStdout(() => runCacheList({ branch: 'a' }));
    expect(logs.some((l) => l.includes('aaa'))).toBe(true);
    expect(logs.some((l) => l.includes('bbb'))).toBe(false);
  });
});

describe('parseCacheResult', () => {
  it('accepts historical pass and fail', () => {
    expect(parseCacheResult('pass')).toBe('pass');
    expect(parseCacheResult('fail')).toBe('fail');
  });

  it('maps Codex verdicts to the binary cache vocabulary', () => {
    expect(parseCacheResult('concerns')).toBe('pass');
    expect(parseCacheResult('blocking')).toBe('fail');
    expect(parseCacheResult('error')).toBe('fail');
  });

  it('exits on values outside the accepted set', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('exit called');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => parseCacheResult('approve')).toThrow('exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
