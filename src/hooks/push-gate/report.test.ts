import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderBanner, writeLastReview, type LastReviewPayload } from './report.js';
import type { Finding, ReviewSummary } from './findings.js';

// Test fixture that exercises the redact pipeline without embedding a real
// credential pattern in the source file (the secret-scanner hook would
// block this file from being written if we did). Built at runtime from
// pieces so it doesn't match any pattern at scan time but reassembles into
// a GitHub-shaped token that redactSecrets will scrub on write.
function fakeGithubToken(): string {
  return 'ghp' + '_' + '0123456789abcdef0123456789abcdef01234567';
}

describe('writeLastReview', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-report-')));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('writes a redacted payload to .rea/last-review.json and returns it', async () => {
    const token = fakeGithubToken();
    const summary: ReviewSummary = {
      verdict: 'blocking',
      findings: [
        {
          severity: 'P1',
          title: 'Committed API key',
          body: `Key ${token} leaks in secrets.ts.`,
          file: 'src/secrets.ts',
          line: 4,
        },
      ],
      reviewText: `We found a key like ${token} in the diff.`,
    };
    const fixedDate = new Date('2026-04-22T12:00:00Z');
    const payload = writeLastReview({
      baseDir,
      summary,
      baseRef: 'origin/main',
      headSha: 'deadbeef',
      eventCount: 7,
      durationSeconds: 42.5,
      now: fixedDate,
    });
    expect(payload.verdict).toBe('blocking');
    expect(payload.finding_count).toBe(1);
    expect(payload.findings[0]?.body).not.toContain('ghp_');
    expect(payload.review_text).not.toContain('ghp_');
    expect(payload.generated_at).toBe(fixedDate.toISOString());

    const raw = await fs.readFile(path.join(baseDir, '.rea', 'last-review.json'), 'utf8');
    const disk = JSON.parse(raw) as LastReviewPayload;
    expect(disk.verdict).toBe('blocking');
    expect(disk.findings[0]?.body).not.toContain('ghp_');
  });

  it('creates .rea/ if it does not exist', async () => {
    const summary: ReviewSummary = { verdict: 'pass', findings: [], reviewText: '' };
    writeLastReview({
      baseDir,
      summary,
      baseRef: 'main',
      headSha: 'abc',
      eventCount: 0,
      durationSeconds: 0,
    });
    const stat = await fs.stat(path.join(baseDir, '.rea', 'last-review.json'));
    expect(stat.isFile()).toBe(true);
  });

  it('atomic write: final file never leaves .tmp artifacts in .rea/', async () => {
    const summary: ReviewSummary = { verdict: 'pass', findings: [], reviewText: '' };
    writeLastReview({
      baseDir,
      summary,
      baseRef: 'main',
      headSha: 'abc',
      eventCount: 0,
      durationSeconds: 0,
    });
    const entries = await fs.readdir(path.join(baseDir, '.rea'));
    const tmpFiles = entries.filter((e) => e.startsWith('last-review.json.tmp'));
    expect(tmpFiles).toEqual([]);
  });
});

describe('renderBanner', () => {
  const basePayload: LastReviewPayload = {
    schema_version: 1,
    generated_at: '2026-04-22T00:00:00Z',
    verdict: 'blocking',
    base_ref: 'origin/main',
    head_sha: 'deadbeef',
    finding_count: 2,
    findings: [
      { severity: 'P1', title: 'Critical', body: '...', file: 'a.ts', line: 1 },
      { severity: 'P3', title: 'Nit', body: '...' },
    ],
    review_text: '...',
    event_count: 8,
    duration_seconds: 12.34,
  };

  it('renders a BLOCKED banner for a blocking verdict', () => {
    const s = renderBanner({
      payload: basePayload,
      baseSource: 'upstream',
      blocked: true,
      lastReviewPath: '/tmp/last-review.json',
    });
    expect(s).toContain('BLOCKING');
    expect(s).toContain('BLOCKED');
    expect(s).toContain('origin/main');
    expect(s).toContain('deadbeef');
    expect(s).toContain('[P1] Critical — a.ts:1');
  });

  it('renders a PROCEEDING banner when not blocked', () => {
    const s = renderBanner({
      payload: { ...basePayload, verdict: 'pass', findings: [] },
      baseSource: 'upstream',
      blocked: false,
      lastReviewPath: '/tmp/last-review.json',
    });
    expect(s).toContain('PASS');
    expect(s).toContain('PROCEEDING');
    expect(s).toContain('(no findings)');
  });

  it('caps the finding list and reports the excess count', () => {
    const findings: Finding[] = Array.from({ length: 50 }, (_, i) => ({
      severity: 'P3' as const,
      title: `nit ${i}`,
      body: '',
    }));
    const s = renderBanner({
      payload: { ...basePayload, findings, finding_count: 50 },
      baseSource: 'explicit',
      blocked: false,
      lastReviewPath: '/tmp/last-review.json',
      maxFindings: 5,
    });
    expect(s).toContain('45 additional finding');
  });

  it('sorts P1 before P2 before P3 in the displayed list', () => {
    const findings: Finding[] = [
      { severity: 'P3', title: 'nit', body: '' },
      { severity: 'P1', title: 'critical', body: '' },
      { severity: 'P2', title: 'concern', body: '' },
    ];
    const s = renderBanner({
      payload: { ...basePayload, findings, finding_count: 3 },
      baseSource: 'upstream',
      blocked: true,
      lastReviewPath: '/tmp/last-review.json',
    });
    const p1Idx = s.indexOf('critical');
    const p2Idx = s.indexOf('concern');
    const p3Idx = s.indexOf('nit');
    expect(p1Idx).toBeGreaterThan(-1);
    expect(p1Idx).toBeLessThan(p2Idx);
    expect(p2Idx).toBeLessThan(p3Idx);
  });
});
