/**
 * Tests for `rea audit record codex-review` (Defect D / rea#77).
 *
 * The command is the ONE correct way for an agent to emit the audit event the
 * push-review cache gate matches on. Previously agents hand-built the record
 * via `node -e ...` snippets, got the `tool_name` wrong, and silently failed
 * the gate. These tests lock:
 *
 *   1. A written record carries the canonical `tool_name = "codex.review"`
 *      and `server_name = "codex"` (hooks/push-review-gate.sh jq predicate).
 *   2. Required fields (--head-sha, --branch, --target, --finding-count) are
 *      validated at the CLI boundary — empty or negative values exit non-zero
 *      without writing anything.
 *   3. `--also-set-cache` emits the cache entry atomically after the audit
 *      record, with the verdict correctly mapped
 *      (pass→pass, concerns→pass, blocking→fail, error→fail).
 *   4. `--summary` lands as `metadata.summary` when provided; omitted otherwise.
 *   5. `--session-id` is attributed when set.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAuditRecordCodexReview } from '../../src/cli/audit.js';
import type { AuditRecord } from '../../src/gateway/middleware/audit-types.js';
import { resolveCacheFile } from '../../src/cache/review-cache.js';

async function readAuditRecords(baseDir: string): Promise<AuditRecord[]> {
  const raw = await fs.readFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

function silenceIo(): () => void {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return () => {
    stdout.mockRestore();
    stderr.mockRestore();
    log.mockRestore();
    err.mockRestore();
  };
}

describe('runAuditRecordCodexReview', () => {
  let baseDir: string;
  let previousCwd: string;
  let restore: () => void;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-audit-codex-'));
    baseDir = await fs.realpath(baseDir);
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    previousCwd = process.cwd();
    process.chdir(baseDir);
    restore = silenceIo();
  });

  afterEach(async () => {
    restore();
    process.chdir(previousCwd);
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('writes a record with the canonical tool_name and server_name', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abcdef1234567890',
      branch: 'feat/x',
      target: 'main',
      verdict: 'pass',
      findingCount: 0,
    });
    const records = await readAuditRecords(baseDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.tool_name).toBe('codex.review');
    expect(records[0]?.server_name).toBe('codex');
  });

  it('includes head_sha, target, verdict, and finding_count in metadata', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abcdef1234567890',
      branch: 'feat/x',
      target: 'main',
      verdict: 'concerns',
      findingCount: 3,
    });
    const records = await readAuditRecords(baseDir);
    const md = records[0]?.metadata as Record<string, unknown>;
    expect(md['head_sha']).toBe('abcdef1234567890');
    expect(md['target']).toBe('main');
    expect(md['verdict']).toBe('concerns');
    expect(md['finding_count']).toBe(3);
  });

  it('includes summary when provided', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abc',
      branch: 'feat/x',
      target: 'main',
      verdict: 'pass',
      findingCount: 0,
      summary: 'LGTM — no findings',
    });
    const records = await readAuditRecords(baseDir);
    const md = records[0]?.metadata as Record<string, unknown>;
    expect(md['summary']).toBe('LGTM — no findings');
  });

  it('omits summary from metadata when not provided', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abc',
      branch: 'feat/x',
      target: 'main',
      verdict: 'pass',
      findingCount: 0,
    });
    const records = await readAuditRecords(baseDir);
    const md = records[0]?.metadata as Record<string, unknown>;
    expect(md).not.toHaveProperty('summary');
  });

  it('attributes session_id when provided', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abc',
      branch: 'feat/x',
      target: 'main',
      verdict: 'pass',
      findingCount: 0,
      sessionId: 'session-42',
    });
    const records = await readAuditRecords(baseDir);
    expect(records[0]?.session_id).toBe('session-42');
  });

  it('--also-set-cache writes a matching cache entry for pass', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abc',
      branch: 'feat/x',
      target: 'main',
      verdict: 'pass',
      findingCount: 0,
      alsoSetCache: true,
    });
    const cacheFile = resolveCacheFile(baseDir);
    const raw = await fs.readFile(cacheFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as {
      sha: string;
      branch: string;
      base: string;
      result: string;
      reason?: string;
    };
    expect(entry.result).toBe('pass');
    expect(entry.branch).toBe('feat/x');
    expect(entry.base).toBe('main');
    expect(entry.reason).toBeUndefined();
  });

  it('--also-set-cache maps concerns → pass with codex:concerns reason', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abc',
      branch: 'feat/x',
      target: 'main',
      verdict: 'concerns',
      findingCount: 2,
      alsoSetCache: true,
    });
    const cacheFile = resolveCacheFile(baseDir);
    const raw = await fs.readFile(cacheFile, 'utf8');
    const entry = JSON.parse(raw.split('\n').filter((l) => l.length > 0)[0]!) as {
      result: string;
      reason?: string;
    };
    expect(entry.result).toBe('pass');
    expect(entry.reason).toBe('codex:concerns');
  });

  it('--also-set-cache maps blocking → fail with codex:blocking reason', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abc',
      branch: 'feat/x',
      target: 'main',
      verdict: 'blocking',
      findingCount: 4,
      alsoSetCache: true,
    });
    const cacheFile = resolveCacheFile(baseDir);
    const entry = JSON.parse(
      (await fs.readFile(cacheFile, 'utf8')).split('\n').filter((l) => l.length > 0)[0]!,
    ) as { result: string; reason?: string };
    expect(entry.result).toBe('fail');
    expect(entry.reason).toBe('codex:blocking');
  });

  it('--also-set-cache maps error → fail with codex:error reason', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abc',
      branch: 'feat/x',
      target: 'main',
      verdict: 'error',
      findingCount: 0,
      alsoSetCache: true,
    });
    const cacheFile = resolveCacheFile(baseDir);
    const entry = JSON.parse(
      (await fs.readFile(cacheFile, 'utf8')).split('\n').filter((l) => l.length > 0)[0]!,
    ) as { result: string; reason?: string };
    expect(entry.result).toBe('fail');
    expect(entry.reason).toBe('codex:error');
  });

  it('does not write a cache entry when --also-set-cache is omitted', async () => {
    await runAuditRecordCodexReview({
      headSha: 'abc',
      branch: 'feat/x',
      target: 'main',
      verdict: 'pass',
      findingCount: 0,
    });
    const cacheFile = resolveCacheFile(baseDir);
    await expect(fs.readFile(cacheFile, 'utf8')).rejects.toThrow();
  });

  it('exits non-zero on empty head-sha', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('exit called');
    }) as never);
    await expect(
      runAuditRecordCodexReview({
        headSha: '',
        branch: 'feat/x',
        target: 'main',
        verdict: 'pass',
        findingCount: 0,
      }),
    ).rejects.toThrow('exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits non-zero on negative finding-count', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('exit called');
    }) as never);
    await expect(
      runAuditRecordCodexReview({
        headSha: 'abc',
        branch: 'feat/x',
        target: 'main',
        verdict: 'pass',
        findingCount: -1,
      }),
    ).rejects.toThrow('exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
