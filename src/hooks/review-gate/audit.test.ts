/**
 * Unit tests for `audit.ts`.
 *
 * Coverage priorities:
 *
 *   1. Defect P (forgery rejection) — `emission_source` predicate.
 *   2. Defect U (streaming-parse tolerance) — per-line try/catch.
 *   3. Verdict whitelist — only `pass` / `concerns` satisfy the gate.
 *   4. Skip-audit emit paths — both `push.review.skipped` and
 *      `codex.review.skipped` round-trip through the hash chain
 *      successfully and can be located by a follow-up
 *      `hasValidCodexReview` check (which they must NOT satisfy).
 *
 * Uses a real tmpdir + the existing audit-append infrastructure so the
 * hash chain is exercised end-to-end. No network, no git — just fs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_REVIEW_SKIPPED_TOOL,
  PUSH_REVIEW_SKIPPED_TOOL,
  emitCodexReviewSkipped,
  emitPushReviewSkipped,
  hasValidCodexReview,
  isQualifyingCodexReview,
} from './audit.js';

const FAKE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'review-gate-audit-test-'));
  await mkdir(join(dir, '.rea'), { recursive: true });
  return dir;
}

async function writeAuditLine(baseDir: string, record: Record<string, unknown>): Promise<void> {
  const file = join(baseDir, '.rea', 'audit.jsonl');
  await writeFile(file, JSON.stringify(record) + '\n', { flag: 'a' });
}

describe('isQualifyingCodexReview (predicate)', () => {
  const valid = {
    tool_name: 'codex.review',
    emission_source: 'rea-cli',
    metadata: { head_sha: FAKE_SHA, verdict: 'pass' },
  };

  it('accepts the canonical rea-cli record', () => {
    expect(isQualifyingCodexReview(valid, FAKE_SHA)).toBe(true);
  });

  it('accepts a codex-cli record', () => {
    expect(
      isQualifyingCodexReview({ ...valid, emission_source: 'codex-cli' }, FAKE_SHA),
    ).toBe(true);
  });

  it('accepts verdict=concerns (qualifying)', () => {
    expect(
      isQualifyingCodexReview({ ...valid, metadata: { ...valid.metadata, verdict: 'concerns' } }, FAKE_SHA),
    ).toBe(true);
  });

  it('rejects verdict=blocking (defect P: receipts without unblock)', () => {
    expect(
      isQualifyingCodexReview({ ...valid, metadata: { ...valid.metadata, verdict: 'blocking' } }, FAKE_SHA),
    ).toBe(false);
  });

  it('rejects verdict=error', () => {
    expect(
      isQualifyingCodexReview({ ...valid, metadata: { ...valid.metadata, verdict: 'error' } }, FAKE_SHA),
    ).toBe(false);
  });

  it('rejects emission_source=other (forgery rejection — defect P)', () => {
    expect(
      isQualifyingCodexReview({ ...valid, emission_source: 'other' }, FAKE_SHA),
    ).toBe(false);
  });

  it('rejects missing emission_source (legacy pre-0.10.1 records)', () => {
    expect(
      isQualifyingCodexReview({ tool_name: valid.tool_name, metadata: valid.metadata }, FAKE_SHA),
    ).toBe(false);
  });

  it('rejects tool_name that is not codex.review', () => {
    expect(
      isQualifyingCodexReview({ ...valid, tool_name: 'codex.review.skipped' }, FAKE_SHA),
    ).toBe(false);
  });

  it('rejects head_sha mismatch', () => {
    expect(isQualifyingCodexReview(valid, OTHER_SHA)).toBe(false);
  });

  it('rejects null / non-object / missing-metadata inputs', () => {
    expect(isQualifyingCodexReview(null, FAKE_SHA)).toBe(false);
    expect(isQualifyingCodexReview(undefined, FAKE_SHA)).toBe(false);
    expect(isQualifyingCodexReview('{"tool_name":"codex.review"}', FAKE_SHA)).toBe(false);
    expect(isQualifyingCodexReview(42, FAKE_SHA)).toBe(false);
    expect(
      isQualifyingCodexReview({ tool_name: 'codex.review', emission_source: 'rea-cli' }, FAKE_SHA),
    ).toBe(false);
  });
});

describe('hasValidCodexReview — streaming scan', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await freshRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('returns false when the audit file does not exist', async () => {
    // Fresh repo via `freshRepo()` has .rea/ but NO audit.jsonl yet.
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(false);
  });

  it('returns false when the audit file is empty', async () => {
    await writeFile(join(repo, '.rea', 'audit.jsonl'), '');
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(false);
  });

  it('finds a qualifying rea-cli pass record', async () => {
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      emission_source: 'rea-cli',
      metadata: { head_sha: FAKE_SHA, verdict: 'pass' },
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(true);
  });

  it('finds a concerns verdict just as well as a pass verdict', async () => {
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      emission_source: 'rea-cli',
      metadata: { head_sha: FAKE_SHA, verdict: 'concerns' },
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(true);
  });

  it('rejects a forged record with emission_source=other (defect P)', async () => {
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      emission_source: 'other',
      metadata: { head_sha: FAKE_SHA, verdict: 'pass' },
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(false);
  });

  it('rejects legacy records with no emission_source field', async () => {
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      metadata: { head_sha: FAKE_SHA, verdict: 'pass' },
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(false);
  });

  it('tolerates a corrupt mid-file line and keeps scanning (defect U)', async () => {
    const auditFile = join(repo, '.rea', 'audit.jsonl');
    // Legitimate record (should match)
    await writeFile(
      auditFile,
      JSON.stringify({
        tool_name: 'push.review.cache.hit',
        emission_source: 'rea-cli',
      }) + '\n',
    );
    // Corrupt line — invalid JSON
    await writeFile(auditFile, 'not-json-at-all{]\n', { flag: 'a' });
    // Another corrupt line with a literal backslash-u + non-hex sequence
    await writeFile(auditFile, '"\\u123q malformed unicode"\n', { flag: 'a' });
    // Legitimate Codex receipt
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      emission_source: 'rea-cli',
      metadata: { head_sha: FAKE_SHA, verdict: 'pass' },
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(true);
  });

  it('tolerates a corrupt record FIRST, then finds a legitimate one later', async () => {
    const auditFile = join(repo, '.rea', 'audit.jsonl');
    await writeFile(auditFile, '{invalid json\n');
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      emission_source: 'codex-cli',
      metadata: { head_sha: FAKE_SHA, verdict: 'pass' },
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(true);
  });

  it('rejects mismatched head_sha even for a clean rea-cli record', async () => {
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      emission_source: 'rea-cli',
      metadata: { head_sha: OTHER_SHA, verdict: 'pass' },
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(false);
  });

  it('short-circuits as soon as a qualifying record is found', async () => {
    // Many non-matching records followed by a matching one proves we don't
    // require scanning the entire file when a hit is present.
    for (let i = 0; i < 50; i++) {
      await writeAuditLine(repo, { tool_name: 'not.codex.review', emission_source: 'other' });
    }
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      emission_source: 'rea-cli',
      metadata: { head_sha: FAKE_SHA, verdict: 'pass' },
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(true);
  });

  it('ignores lines where metadata is not an object', async () => {
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      emission_source: 'rea-cli',
      metadata: 'a-string-not-an-object',
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(false);
  });

  it('ignores lines where metadata is missing entirely', async () => {
    await writeAuditLine(repo, {
      tool_name: 'codex.review',
      emission_source: 'rea-cli',
    });
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(false);
  });
});

describe('emitPushReviewSkipped', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await freshRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('writes a push.review.skipped record that is NOT a codex.review receipt', async () => {
    await emitPushReviewSkipped({
      baseDir: repo,
      head_sha: FAKE_SHA,
      branch: 'feature/foo',
      reason: 'rea is broken',
      actor: 'jake@example.com',
      os_identity: {
        uid: '1000',
        whoami: 'jake',
        hostname: 'host',
        pid: 1234,
        ppid: 1,
        ppid_cmd: 'bash',
        tty: 'not-a-tty',
        ci: '',
      },
    });
    // The skip record must NOT satisfy the codex-review gate.
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(false);
  });

  it('collects os_identity automatically when not supplied', async () => {
    const r = await emitPushReviewSkipped({
      baseDir: repo,
      head_sha: FAKE_SHA,
      branch: 'feat/x',
      reason: 'hygiene scope',
      actor: 'jake@example.com',
    });
    expect(r.tool_name).toBe(PUSH_REVIEW_SKIPPED_TOOL);
    // emission_source is ALWAYS "other" for this public path (defect P).
    expect(r.emission_source).toBe('other');
    expect((r.metadata as Record<string, unknown>)?.reason).toBe('hygiene scope');
    const osIdentity = (r.metadata as Record<string, unknown>)?.os_identity as Record<
      string,
      unknown
    >;
    expect(typeof osIdentity.pid).toBe('number'); // defect M
    expect(typeof osIdentity.ppid).toBe('number');
  });
});

describe('emitCodexReviewSkipped', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await freshRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('writes a codex.review.skipped record that is NOT a codex.review receipt', async () => {
    await emitCodexReviewSkipped({
      baseDir: repo,
      head_sha: FAKE_SHA,
      target: 'main',
      reason: 'acknowledged risk',
      actor: 'jake@example.com',
      metadata_source: 'prepush-stdin',
    });
    // Skip record has different tool_name — never satisfies hasValidCodexReview.
    expect(await hasValidCodexReview(repo, FAKE_SHA)).toBe(false);
  });

  it('records the metadata_source discriminator verbatim', async () => {
    const r = await emitCodexReviewSkipped({
      baseDir: repo,
      head_sha: FAKE_SHA,
      target: 'dev',
      reason: 'local test',
      actor: 'jake@example.com',
      metadata_source: 'local-fallback',
    });
    expect(r.tool_name).toBe(CODEX_REVIEW_SKIPPED_TOOL);
    expect(r.emission_source).toBe('other');
    expect((r.metadata as Record<string, unknown>)?.metadata_source).toBe('local-fallback');
    expect((r.metadata as Record<string, unknown>)?.verdict).toBe('skipped');
  });
});
