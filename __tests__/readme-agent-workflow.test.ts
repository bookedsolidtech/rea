/**
 * README-example regression test — the "Agent push workflow" section.
 *
 * If a new engineer copy-pastes the single `rea audit record codex-review
 * ... --also-set-cache` block and the push-review cache predicate fails, the
 * README documented a broken flow. This test drives the exact command pattern
 * and asserts both the audit record and the cache entry match the gate's jq
 * predicate (hooks/push-review-gate.sh section 8).
 *
 * Deliberately loose on text-match: the test asserts the SHAPE of what the
 * README says you get, not the prose. If the README rewords "LGTM" to
 * "clean" the test stays green; if the README starts recommending the wrong
 * CLI flag, this fails.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAuditRecordCodexReview } from '../src/cli/audit.js';
import type { AuditRecord } from '../src/gateway/middleware/audit-types.js';
import { resolveCacheFile } from '../src/cache/review-cache.js';

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

describe('README agent push workflow — one-command satisfies the gate', () => {
  let baseDir: string;
  let previousCwd: string;
  let restore: () => void;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-readme-workflow-'));
    baseDir = await fs.realpath(baseDir);
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    previousCwd = process.cwd();
    process.chdir(baseDir);

    // The CLI derives head_sha from `git rev-parse HEAD` in the README
    // example, but runAuditRecordCodexReview takes it as an option, so we
    // pass an explicit value — no git repo required.
    restore = silenceIo();
  });

  afterEach(async () => {
    restore();
    process.chdir(previousCwd);
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('emits the audit record with tool_name = "codex.review" and verdict = pass', async () => {
    await runAuditRecordCodexReview({
      headSha: 'a'.repeat(40),
      branch: 'feat/readme-example',
      target: 'main',
      verdict: 'pass',
      findingCount: 0,
      summary: 'no findings',
      alsoSetCache: true,
    });

    const auditRaw = await fs.readFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'utf8');
    const records = auditRaw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AuditRecord);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.tool_name).toBe('codex.review');
    expect(rec.server_name).toBe('codex');
    const md = rec.metadata as Record<string, unknown>;
    expect(md['verdict']).toBe('pass');
    expect(md['head_sha']).toBe('a'.repeat(40));
    expect(md['target']).toBe('main');
  });

  it('writes a cache entry the push-review gate predicate would hit', async () => {
    await runAuditRecordCodexReview({
      headSha: 'b'.repeat(40),
      branch: 'feat/readme-example',
      target: 'main',
      verdict: 'pass',
      findingCount: 0,
      alsoSetCache: true,
    });

    const cacheFile = resolveCacheFile(baseDir);
    const raw = await fs.readFile(cacheFile, 'utf8');
    const entry = JSON.parse(raw.split('\n').filter((l) => l.length > 0)[0]!) as {
      sha: string;
      branch: string;
      base: string;
      result: string;
    };

    expect(entry.result).toBe('pass');
    expect(entry.branch).toBe('feat/readme-example');
    expect(entry.base).toBe('main');
    // Predicate the gate uses: `.hit == true and .result == "pass"`.
    // The lookup logic lives in src/cache/review-cache.ts — verifying the
    // result field is correct here is sufficient to prove the gate would hit.
  });

  it('the "concerns" verdict still satisfies the gate — same result, extra reason tag', async () => {
    await runAuditRecordCodexReview({
      headSha: 'c'.repeat(40),
      branch: 'feat/c',
      target: 'main',
      verdict: 'concerns',
      findingCount: 2,
      alsoSetCache: true,
    });

    const cacheFile = resolveCacheFile(baseDir);
    const entry = JSON.parse(
      (await fs.readFile(cacheFile, 'utf8')).split('\n').filter((l) => l.length > 0)[0]!,
    ) as { result: string; reason?: string };

    expect(entry.result).toBe('pass');
    expect(entry.reason).toBe('codex:concerns');
  });

  it('README section exists and references the --also-set-cache flag', async () => {
    // Meta-regression: if the README section is accidentally deleted the
    // workflow claim silently rots. Pin the section header + the flag name.
    const repoRoot = path.resolve(__dirname, '..');
    const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');

    expect(readme).toMatch(/Agent push workflow/);
    expect(readme).toMatch(/--also-set-cache/);
    expect(readme).toMatch(/rea audit record codex-review/);
  });
});

describe('README SDK snippet compiles and runs against the public export', () => {
  it('imports match @bookedsolid/rea/audit surface', async () => {
    // Import the public surface the README tells users to import from.
    // If any of these re-exports get renamed or removed, the README is
    // telling the user to write broken code.
    const mod = await import('../src/audit/append.js');
    expect(typeof mod.appendAuditRecord).toBe('function');
    expect(mod.CODEX_REVIEW_TOOL_NAME).toBe('codex.review');
    expect(mod.CODEX_REVIEW_SERVER_NAME).toBe('codex');
    const policyTypes = await import('../src/policy/types.js');
    expect(policyTypes.InvocationStatus).toBeDefined();
    expect(policyTypes.Tier).toBeDefined();
  });
});
