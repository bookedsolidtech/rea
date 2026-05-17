/**
 * Tests for `rea audit timeline` (0.46.0 charter item 2).
 *
 * Pins:
 *   - Bucket resolution (HOUR/DAY aliases + duration form)
 *   - Bucket alignment to UTC epoch lattice
 *   - --since fills zero-count buckets across the window
 *   - --since unset emits only buckets containing records
 *   - Peak detection (incl. first-occurrence tie-breaking)
 *   - JSON-vs-text rendering + histogram bar shape
 *   - Bounds: MAX_BUCKETS guard, malformed flags
 *   - Rotated-file walk
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeAuditTimeline,
  renderAuditTimeline,
  resolveBucketSeconds,
  AuditTimelineOptionError,
  AUDIT_TIMELINE_SCHEMA_VERSION,
  MAX_BUCKETS,
} from '../../src/cli/audit-timeline.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../src/audit/append.js';

async function setupRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-timeline-')));
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  return dir;
}

async function emit(
  baseDir: string,
  args: { toolName: string; sessionId: string; timestamp?: string },
): Promise<void> {
  await appendAuditRecord(baseDir, {
    tool_name: args.toolName,
    server_name: 'test',
    tier: Tier.Read,
    status: InvocationStatus.Allowed,
    session_id: args.sessionId,
    ...(args.timestamp !== undefined ? { timestamp: args.timestamp } : {}),
  });
}

describe('resolveBucketSeconds', () => {
  it('accepts HOUR / H / 1H', () => {
    expect(resolveBucketSeconds('HOUR')).toBe(3600);
    expect(resolveBucketSeconds('hour')).toBe(3600);
    expect(resolveBucketSeconds('H')).toBe(3600);
    expect(resolveBucketSeconds('1H')).toBe(3600);
  });

  it('accepts DAY / D / 1D', () => {
    expect(resolveBucketSeconds('DAY')).toBe(86400);
    expect(resolveBucketSeconds('day')).toBe(86400);
    expect(resolveBucketSeconds('D')).toBe(86400);
    expect(resolveBucketSeconds('1D')).toBe(86400);
  });

  it('accepts compact duration form', () => {
    expect(resolveBucketSeconds('15m')).toBe(15 * 60);
    expect(resolveBucketSeconds('30m')).toBe(30 * 60);
    expect(resolveBucketSeconds('2h')).toBe(2 * 3600);
    expect(resolveBucketSeconds('1d')).toBe(86400);
  });

  it('rejects empty / malformed input', () => {
    expect(() => resolveBucketSeconds('')).toThrow(AuditTimelineOptionError);
    expect(() => resolveBucketSeconds('   ')).toThrow(AuditTimelineOptionError);
    expect(() => resolveBucketSeconds('5y')).toThrow(AuditTimelineOptionError);
    expect(() => resolveBucketSeconds('nope')).toThrow(AuditTimelineOptionError);
  });
});

describe('computeAuditTimeline — basic bucketing', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns zero buckets on an empty log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const result = await computeAuditTimeline({ baseDir: dir });
    expect(result.schema_version).toBe(AUDIT_TIMELINE_SCHEMA_VERSION);
    expect(result.total_events).toBe(0);
    expect(result.buckets).toEqual([]);
    expect(result.peak_index).toBe(-1);
  });

  it('aligns buckets to the UTC hour boundary (default)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, {
      toolName: 'A',
      sessionId: 's',
      timestamp: '2026-05-16T14:23:45.000Z',
    });
    const result = await computeAuditTimeline({ baseDir: dir });
    expect(result.buckets.length).toBe(1);
    expect(result.buckets[0]!.start).toBe('2026-05-16T14:00:00.000Z');
    expect(result.buckets[0]!.end).toBe('2026-05-16T15:00:00.000Z');
    expect(result.buckets[0]!.count).toBe(1);
  });

  it('aligns buckets to the UTC day boundary with --bucket=DAY', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, {
      toolName: 'A',
      sessionId: 's',
      timestamp: '2026-05-16T14:23:45.000Z',
    });
    const result = await computeAuditTimeline({ baseDir: dir, bucket: 'DAY' });
    expect(result.buckets[0]!.start).toBe('2026-05-16T00:00:00.000Z');
    expect(result.buckets[0]!.end).toBe('2026-05-17T00:00:00.000Z');
  });

  it('counts records within the same bucket together', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    for (let i = 0; i < 5; i += 1) {
      await emit(dir, {
        toolName: 'A',
        sessionId: 's',
        timestamp: `2026-05-16T14:${String(10 + i).padStart(2, '0')}:00.000Z`,
      });
    }
    const result = await computeAuditTimeline({ baseDir: dir });
    expect(result.buckets.length).toBe(1);
    expect(result.buckets[0]!.count).toBe(5);
  });

  it('splits records across buckets by timestamp', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T14:30:00.000Z' });
    await emit(dir, { toolName: 'B', sessionId: 's', timestamp: '2026-05-16T15:30:00.000Z' });
    await emit(dir, { toolName: 'C', sessionId: 's', timestamp: '2026-05-16T15:45:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir });
    expect(result.buckets.length).toBe(2);
    expect(result.buckets[0]!.count).toBe(1);
    expect(result.buckets[1]!.count).toBe(2);
  });

  it('boundary records land in the lower-bound bucket [start, end)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T15:00:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir });
    expect(result.buckets.length).toBe(1);
    expect(result.buckets[0]!.start).toBe('2026-05-16T15:00:00.000Z');
  });

  it('peak_index points at the busiest bucket', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T14:00:00.000Z' });
    await emit(dir, { toolName: 'B', sessionId: 's', timestamp: '2026-05-16T15:00:00.000Z' });
    await emit(dir, { toolName: 'C', sessionId: 's', timestamp: '2026-05-16T15:30:00.000Z' });
    await emit(dir, { toolName: 'D', sessionId: 's', timestamp: '2026-05-16T16:00:00.000Z' });
    // Without --since, only buckets containing records appear (3
    // buckets here: 14h, 15h, 16h).
    const result = await computeAuditTimeline({ baseDir: dir });
    expect(result.buckets.length).toBe(3);
    // 15h bucket has 2 records → peak.
    expect(result.peak_index).toBe(1);
  });

  it('ties go to the first-occurrence bucket', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T14:00:00.000Z' });
    await emit(dir, { toolName: 'B', sessionId: 's', timestamp: '2026-05-16T15:00:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir });
    // Both buckets have count=1 → peak is the first.
    expect(result.peak_index).toBe(0);
  });
});

describe('computeAuditTimeline — --since window + zero-count filling', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('fills zero-count buckets across the window when --since is set', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T17:00:00.000Z');
    // Only 1 event mid-window.
    await emit(dir, {
      toolName: 'A',
      sessionId: 's',
      timestamp: '2026-05-16T15:30:00.000Z',
    });
    const result = await computeAuditTimeline({ baseDir: dir, since: '4h', now });
    // Window is 13:00 → 17:00 inclusive of both boundary hours = 5 buckets.
    expect(result.buckets.length).toBe(5);
    const total = result.buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(1);
    // The one event lands at 15:00 → index 2.
    const zeroes = result.buckets.filter((b) => b.count === 0).length;
    expect(zeroes).toBe(4);
  });

  it('emits only event-bearing buckets when --since is omitted', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-10T14:00:00.000Z' });
    await emit(dir, { toolName: 'B', sessionId: 's', timestamp: '2026-05-16T14:00:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir });
    // Without --since we don't fill the 6-day gap.
    expect(result.buckets.length).toBe(2);
  });

  it('drops records strictly after `now` when --since is set', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T11:30:00.000Z' });
    // Future-dated — drop.
    await emit(dir, { toolName: 'Future', sessionId: 's', timestamp: '2026-05-16T13:00:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir, since: '1h', now });
    expect(result.total_events).toBe(1);
  });

  it('rejects malformed --since', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await expect(computeAuditTimeline({ baseDir: dir, since: 'forever' })).rejects.toThrow(
      AuditTimelineOptionError,
    );
  });

  it('rejects bucket+since combinations that would emit > MAX_BUCKETS', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    // 30 days at 1s buckets = 2,592,000 buckets — well past MAX_BUCKETS.
    const now = new Date('2026-05-16T12:00:00.000Z');
    await expect(
      computeAuditTimeline({ baseDir: dir, since: '30d', bucket: '1s', now }),
    ).rejects.toThrow(AuditTimelineOptionError);
  });

  // 0.47.0 charter item 1: the MAX_BUCKETS error must carry concrete
  // remediation, not just "use a larger --bucket". Pin the substring
  // shape so dashboard consumers + operators can rely on the
  // `bucket=` / `since=` / `Try` anchors.
  it('helpful error includes concrete bucket+since suggestions (0.47.0 charter item 1)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    // 21d × 15m = ~2016 buckets — over the 2000 limit.
    try {
      await computeAuditTimeline({ baseDir: dir, since: '21d', bucket: '15m', now });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AuditTimelineOptionError);
      const msg = (e as Error).message;
      expect(msg).toContain('bucket=15m');
      expect(msg).toContain('since=21d');
      expect(msg).toContain('Try');
      // Suggestion should point at a wider bucket OR a narrower since.
      expect(msg).toMatch(/--bucket=\d+[hdw]|--since=\d+[smhdw]/);
      // The MAX_BUCKETS=2000 anchor is part of the documented contract.
      expect(msg).toContain('MAX_BUCKETS=2000');
    }
  });

  it('suggestion picks the smallest fitting wider bucket', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    try {
      // 90d × 1h = 2160 buckets — exceeds; 4h would fit at ~540.
      await computeAuditTimeline({ baseDir: dir, since: '90d', bucket: '1h', now });
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      // 1d also fits, but 4h is the smallest fitting wider unit and
      // wins under our ascending-candidate strategy. Either is OK as
      // a suggestion — pin only the property "something larger than 1h
      // appears".
      expect(msg).toMatch(/--bucket=(4h|1d|1w)/);
    }
  });

  it('honors MAX_BUCKETS at the alignment-emit boundary', async () => {
    // 1h window at 1m buckets → 60 buckets, well below MAX_BUCKETS;
    // 21d at 15m → ~2016 buckets which sits right at MAX_BUCKETS.
    // Just confirm a comfortable size resolves without throw.
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    const result = await computeAuditTimeline({
      baseDir: dir,
      since: '1h',
      bucket: '1m',
      now,
    });
    expect(result.buckets.length).toBeLessThanOrEqual(MAX_BUCKETS);
    expect(result.buckets.length).toBe(61); // 1h inclusive of both boundary minutes
  });
});

describe('computeAuditTimeline — rotated audit walks', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('walks rotated audit files by default', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const rotated = path.join(dir, '.rea', 'audit-20260515-100000.jsonl');
    const r = {
      timestamp: '2026-05-15T10:00:01.000Z',
      session_id: 'old',
      tool_name: 'OldTool',
      server_name: 'test',
      tier: 'read',
      status: 'allowed',
      autonomy_level: 'L1',
      duration_ms: 0,
      emission_source: 'other',
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    await fs.writeFile(rotated, `${JSON.stringify(r)}\n`, 'utf8');
    await emit(dir, { toolName: 'NewTool', sessionId: 'new', timestamp: '2026-05-16T14:00:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir });
    expect(result.files_scanned.length).toBe(2);
    expect(result.total_events).toBe(2);
    expect(result.buckets.length).toBe(2);
  });
});

describe('renderAuditTimeline', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('emits a no-events notice on an empty log', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const result = await computeAuditTimeline({ baseDir: dir });
    const out = renderAuditTimeline(result);
    expect(out).toContain('No events in the audit log.');
  });

  it('renders histogram bars + peak marker', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T17:00:00.000Z');
    // 1 event in 14h bucket, 3 events in 15h bucket (peak), 1 event 16h.
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T14:30:00.000Z' });
    await emit(dir, { toolName: 'B', sessionId: 's', timestamp: '2026-05-16T15:10:00.000Z' });
    await emit(dir, { toolName: 'B', sessionId: 's', timestamp: '2026-05-16T15:20:00.000Z' });
    await emit(dir, { toolName: 'B', sessionId: 's', timestamp: '2026-05-16T15:30:00.000Z' });
    await emit(dir, { toolName: 'C', sessionId: 's', timestamp: '2026-05-16T16:30:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir, since: '4h', now });
    const out = renderAuditTimeline(result);
    expect(out).toContain('▁');
    expect(out).toContain('← peak');
    expect(out).toContain('rea audit timeline');
    expect(out).toContain('hourly');
  });

  it('shows date-only timestamp when bucket is DAY', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T14:30:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir, bucket: 'DAY' });
    const out = renderAuditTimeline(result);
    // Day buckets show YYYY-MM-DD without HH:MM noise.
    expect(out).toMatch(/2026-05-16\b/);
    expect(out).toContain('daily');
    // No HH:MM segment after the date in the bucket line.
    expect(out).not.toMatch(/2026-05-16 \d{2}:\d{2}/);
  });

  // Codex round-1 P2 (0.46.0): the idle-window case must render the
  // zero-filled histogram, not collapse to the generic "No events"
  // notice. The whole point of `timeline --since X` is to surface
  // silence as visible-but-empty rows so the operator can distinguish
  // "the command never ran in this window" from "the command ran but
  // I forgot to pass --since".
  it('renders zero-filled buckets in idle --since windows (codex round-1 P2)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T15:00:00.000Z');
    // No events, but --since=3h → 4 zero buckets in the window.
    const result = await computeAuditTimeline({ baseDir: dir, since: '3h', now });
    expect(result.total_events).toBe(0);
    expect(result.buckets.length).toBe(4);
    const out = renderAuditTimeline(result);
    // The zero-filled histogram must be visible, NOT short-circuited.
    expect(out).not.toContain('No events in the requested window.');
    // Every bucket appears as a 0-event row.
    expect(out).toMatch(/2026-05-16 12:00.*0 events/);
    expect(out).toMatch(/2026-05-16 13:00.*0 events/);
    expect(out).toMatch(/2026-05-16 14:00.*0 events/);
    expect(out).toMatch(/2026-05-16 15:00.*0 events/);
    // No peak marker on zero rows.
    expect(out).not.toContain('← peak');
  });

  // Negative control for the above: empty audit log + no --since must
  // still emit the generic notice (the buckets array is empty in this
  // case, so the no-events early-return remains correct).
  it('still emits the no-events notice when buckets is empty', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const result = await computeAuditTimeline({ baseDir: dir });
    const out = renderAuditTimeline(result);
    expect(out).toContain('No events in the audit log.');
  });

  it('shows duration cadence label when using compact-duration bucket', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T14:30:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir, bucket: '15m' });
    const out = renderAuditTimeline(result);
    expect(out).toContain('every 15m');
  });
});

describe('computeAuditTimeline — JSON shape stability', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('produces a stable JSON shape', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T14:00:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir });
    expect(Object.keys(result).sort()).toEqual(
      [
        'bucket',
        'buckets',
        'clamped_since',
        'files_scanned',
        'peak_index',
        'schema_version',
        'total_events',
        'window',
      ].sort(),
    );
    expect(Object.keys(result.bucket).sort()).toEqual(['raw', 'seconds']);
    expect(Object.keys(result.window).sort()).toEqual(['end', 'seconds', 'start']);
    for (const b of result.buckets) {
      expect(Object.keys(b).sort()).toEqual(['count', 'end', 'start']);
    }
    // 0.47.0 charter item 2: clamped_since is null in the common case.
    expect(result.clamped_since).toBeNull();
  });
});

// 0.47.0 charter item 2 — long-history repo usability. When the
// operator omits --since on a long-history audit log, the timeline
// auto-clamps to the widest window that fits at the requested cadence
// and surfaces the clamp via `clamped_since` + a `note:` line in the
// human renderer. Pre-0.47.0 the same input would have thrown at the
// post-scan `keys.length > MAX_BUCKETS` guard with a generic message.
describe('computeAuditTimeline — auto-clamp on long history (0.47.0 charter item 2)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('does NOT clamp a sparse log just because its span is wide (codex round-3 P1)', async () => {
    // Codex round-3 P1: the all-time path emits only event-bearing
    // buckets. A two-event log spanning 365d at --bucket=15m produces
    // only 2 buckets — well under MAX_BUCKETS — so the clamp must NOT
    // fire on span alone. Pre-fix the pre-scan clamp would have dropped
    // the older record here. The corrected post-scan recovery only
    // fires when the OBSERVED bucket count exceeds MAX_BUCKETS.
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    await emit(dir, {
      toolName: 'Ancient',
      sessionId: 'ancient',
      timestamp: '2025-05-16T12:00:00.000Z',
    });
    await emit(dir, {
      toolName: 'Fresh',
      sessionId: 'fresh',
      timestamp: '2026-05-16T11:30:00.000Z',
    });
    const result = await computeAuditTimeline({ baseDir: dir, bucket: '15m', now });
    // Both records visible, no clamp.
    expect(result.clamped_since).toBeNull();
    expect(result.total_events).toBe(2);
    expect(result.buckets.length).toBe(2);
  });

  it('does NOT clamp when --since is explicit (even if it would exceed MAX_BUCKETS)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    // Explicit --since=21d × --bucket=15m = 2016 buckets — over.
    // The operator asked for this window explicitly; we throw with the
    // helpful error rather than silently clamping.
    await expect(
      computeAuditTimeline({ baseDir: dir, since: '21d', bucket: '15m', now }),
    ).rejects.toThrow(AuditTimelineOptionError);
  });

  it('does NOT clamp on a short-history log (common case)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:00:00.000Z');
    // Log spans only ~30m — way under MAX_BUCKETS at any sensible cadence.
    await emit(dir, { toolName: 'A', sessionId: 's', timestamp: '2026-05-16T11:30:00.000Z' });
    await emit(dir, { toolName: 'B', sessionId: 's', timestamp: '2026-05-16T11:45:00.000Z' });
    const result = await computeAuditTimeline({ baseDir: dir, now });
    expect(result.clamped_since).toBeNull();
    // No --since → window stays null too (the auto-clamp path is the
    // only thing that sets a window without --since).
    expect(result.window.seconds).toBeNull();
  });

  it('renders the clamp note inline when fired', async () => {
    // A dense log spanning > MAX_BUCKETS at the requested cadence —
    // build 2001 hourly records so the observed bucket count exceeds
    // MAX_BUCKETS=2000 and the post-scan auto-clamp triggers.
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const lines: string[] = [];
    const anchor = new Date('2026-05-16T12:00:00.000Z').getTime();
    for (let i = 0; i <= MAX_BUCKETS; i += 1) {
      const stepsFromEarliest = MAX_BUCKETS - i;
      const ts = new Date(anchor - stepsFromEarliest * 3600 * 1000).toISOString();
      lines.push(
        JSON.stringify({
          timestamp: ts,
          session_id: 's',
          tool_name: 'T',
          server_name: 'test',
          tier: 'read',
          status: 'allowed',
          autonomy_level: 'L1',
          duration_ms: 0,
          emission_source: 'other',
          prev_hash: '0'.repeat(64),
          hash: i.toString(16).padStart(64, '0'),
        }),
      );
    }
    await fs.writeFile(auditPath, lines.join('\n') + '\n', 'utf8');
    const now = new Date('2026-05-16T13:00:00.000Z');
    const result = await computeAuditTimeline({ baseDir: dir, bucket: '1h', now });
    expect(result.clamped_since).not.toBeNull();
    const out = renderAuditTimeline(result);
    expect(out).toContain('note:');
    expect(out).toContain('--since not specified');
    expect(out).toContain('auto-clamped');
    expect(out).toContain('--bucket=1h');
  });

  // Codex round-3 P2 (0.47.0): when the post-scan auto-clamp fires,
  // the window anchor must come from OBSERVED bucket data (the last
  // bucket key in the sorted list), not from disk metadata. That
  // ensures the anchor survives the empty-current-file case (just
  // after rotation) and the out-of-order-timestamp case
  // (caller-supplied timestamps can put older records last in the
  // file). Validate by building a dense log where the LAST line is
  // older than the middle — the clamp must still anchor on the
  // newest OBSERVED timestamp, not on the last line.
  it('clamp anchor uses observed-max timestamp, not last-line-of-file (codex round-3 P2)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const lines: string[] = [];
    const anchor = new Date('2026-05-16T12:00:00.000Z').getTime();
    // 2001 hourly records, but write the SECOND-TO-LAST line with
    // the newest timestamp and the LAST line with an older one — so
    // a last-line-only heuristic would anchor too early.
    for (let i = 0; i <= MAX_BUCKETS; i += 1) {
      const stepsFromEarliest = MAX_BUCKETS - i;
      const ts = new Date(anchor - stepsFromEarliest * 3600 * 1000).toISOString();
      lines.push(
        JSON.stringify({
          timestamp: ts,
          session_id: 's',
          tool_name: 'T',
          server_name: 'test',
          tier: 'read',
          status: 'allowed',
          autonomy_level: 'L1',
          duration_ms: 0,
          emission_source: 'other',
          prev_hash: '0'.repeat(64),
          hash: i.toString(16).padStart(64, '0'),
        }),
      );
    }
    // Swap the last two lines so the file's tail is OLDER than the
    // record just before it.
    const tmp = lines[lines.length - 1]!;
    lines[lines.length - 1] = lines[lines.length - 2]!;
    lines[lines.length - 2] = tmp;
    await fs.writeFile(auditPath, lines.join('\n') + '\n', 'utf8');
    const now = new Date('2026-05-16T13:00:00.000Z');
    const result = await computeAuditTimeline({ baseDir: dir, bucket: '1h', now });
    expect(result.clamped_since).not.toBeNull();
    // The newest observed key sits at the anchor instant. The
    // window's end-of-window must be the bucket-end of that key
    // (anchor + 1h), NOT some earlier instant.
    const expectedEnd = new Date(anchor + 60 * 60 * 1000).getTime();
    expect(new Date(result.window.end!).getTime()).toBe(expectedEnd);
  });

  // Codex round-5 P1 (0.47.0): on a SPARSE long-history log, the
  // post-scan clamp must slice the keys array (newest MAX_BUCKETS
  // entries) rather than imposing a contiguous time window. A
  // time-window clamp on a sparse log discards far more than the
  // oldest buckets — it discards every bucket older than
  // `anchor - MAX_BUCKETS * bucketSize`, which on a sparse log might
  // be 99% of the data. Slicing keys preserves the newest 2000
  // event-bearing buckets exactly.
  it('sparse-log post-scan clamp keeps newest MAX_BUCKETS event-bearing buckets (codex round-5 P1)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const lines: string[] = [];
    // One event per DAY across MAX_BUCKETS+1 days at --bucket=1h.
    // Under a contiguous time-window clamp anchored at the newest
    // event, only ~83 hourly buckets in the last 1999h would survive
    // (the rest of the days are out of window). Under the correct
    // newest-keys slice, all 2001 keys remain after the first one
    // is sliced off → 2000 buckets, matching MAX_BUCKETS.
    const anchor = new Date('2026-05-16T12:00:00.000Z').getTime();
    for (let i = 0; i <= MAX_BUCKETS; i += 1) {
      const stepsFromEarliest = MAX_BUCKETS - i;
      // 1 day apart, not 1 hour — the sparse layout that breaks
      // contiguous-window clamping.
      const ts = new Date(anchor - stepsFromEarliest * 86400 * 1000).toISOString();
      lines.push(
        JSON.stringify({
          timestamp: ts,
          session_id: 's',
          tool_name: 'T',
          server_name: 'test',
          tier: 'read',
          status: 'allowed',
          autonomy_level: 'L1',
          duration_ms: 0,
          emission_source: 'other',
          prev_hash: '0'.repeat(64),
          hash: i.toString(16).padStart(64, '0'),
        }),
      );
    }
    await fs.writeFile(auditPath, lines.join('\n') + '\n', 'utf8');
    const now = new Date('2026-05-16T13:00:00.000Z');
    const result = await computeAuditTimeline({ baseDir: dir, bucket: '1h', now });
    expect(result.clamped_since).not.toBeNull();
    // The contiguous-window mistake would have given ~83 buckets;
    // the correct slice gives the full MAX_BUCKETS.
    expect(result.buckets.length).toBe(MAX_BUCKETS);
    // And total_events should reflect the kept buckets, not just
    // the lattice slot count.
    expect(result.total_events).toBe(MAX_BUCKETS);
    // Codex round-6 P2 (0.47.0): sparse clamps must NOT report a
    // contiguous window — `window.seconds` filled with a 48,001h
    // span would mislead dashboards into deriving wildly-wrong
    // rates. Window stays null.
    expect(result.window.seconds).toBeNull();
    expect(result.window.start).toBeNull();
    expect(result.window.end).toBeNull();
    // Codex round-8 P2 (0.47.0): clamped_since stays a parseable
    // DURATION (`<DUR>`) per the charter contract — sparse-clamp's
    // earlier "newest N buckets" label broke dashboards parsing it
    // as a duration. The "sparseness" is signaled by `window.*`
    // being null, not by overloading clamped_since.
    expect(result.clamped_since).toMatch(/^\d+[smhdw]$/);
  });

  // Codex round-4 P2 (0.47.0): the post-scan auto-clamp must use the
  // FULL MAX_BUCKETS budget, not MAX_BUCKETS - 1. The alignment-slack
  // +1 only applies to fixed-window emit (synthesizing boundary
  // buckets from a --since/start lattice) — when we're cherry-picking
  // from already-observed bucket keys, MAX_BUCKETS keys fit exactly
  // MAX_BUCKETS buckets. Pre-fix the clamp dropped one extra observed
  // bucket from the newest window.
  it('post-scan clamp preserves the full MAX_BUCKETS budget (codex round-4 P2)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const lines: string[] = [];
    const anchor = new Date('2026-05-16T12:00:00.000Z').getTime();
    for (let i = 0; i <= MAX_BUCKETS; i += 1) {
      const stepsFromEarliest = MAX_BUCKETS - i;
      const ts = new Date(anchor - stepsFromEarliest * 3600 * 1000).toISOString();
      lines.push(
        JSON.stringify({
          timestamp: ts,
          session_id: 's',
          tool_name: 'T',
          server_name: 'test',
          tier: 'read',
          status: 'allowed',
          autonomy_level: 'L1',
          duration_ms: 0,
          emission_source: 'other',
          prev_hash: '0'.repeat(64),
          hash: i.toString(16).padStart(64, '0'),
        }),
      );
    }
    await fs.writeFile(auditPath, lines.join('\n') + '\n', 'utf8');
    const now = new Date('2026-05-16T13:00:00.000Z');
    const result = await computeAuditTimeline({ baseDir: dir, bucket: '1h', now });
    expect(result.clamped_since).not.toBeNull();
    // Full MAX_BUCKETS preserved (not MAX_BUCKETS - 1).
    expect(result.buckets.length).toBe(MAX_BUCKETS);
  });

  // Codex round-9 P2/P3 (0.47.0): when auto-clamp fires, the
  // rendered header must describe the CLAMPED window (not the
  // misleading "last <DUR>" derived from window.seconds), and the
  // remediation note must point at a WIDER bucket (same bucket
  // would re-trigger the clamp).
  it('renderer header + note describe the clamp shape (codex round-9 P2/P3)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const lines: string[] = [];
    const anchor = new Date('2026-05-16T12:00:00.000Z').getTime();
    for (let i = 0; i <= MAX_BUCKETS; i += 1) {
      const stepsFromEarliest = MAX_BUCKETS - i;
      const ts = new Date(anchor - stepsFromEarliest * 3600 * 1000).toISOString();
      lines.push(
        JSON.stringify({
          timestamp: ts,
          session_id: 's',
          tool_name: 'T',
          server_name: 'test',
          tier: 'read',
          status: 'allowed',
          autonomy_level: 'L1',
          duration_ms: 0,
          emission_source: 'other',
          prev_hash: '0'.repeat(64),
          hash: i.toString(16).padStart(64, '0'),
        }),
      );
    }
    await fs.writeFile(auditPath, lines.join('\n') + '\n', 'utf8');
    const now = new Date('2026-05-16T13:00:00.000Z');
    const result = await computeAuditTimeline({ baseDir: dir, bucket: '1h', now });
    const out = renderAuditTimeline(result);
    // Header describes the clamp, not "last <DUR>" (which would
    // imply now-anchoring on stale logs).
    expect(out).toContain('clamped to');
    expect(out).not.toMatch(/^rea audit timeline \(last \d+/m);
    // Note points at a WIDER bucket — same bucket would re-trigger.
    expect(out).toContain('WIDER --bucket');
  });

  // Codex round-8 P2 (0.47.0): `clamped_since` is always a
  // PARSEABLE duration string (the charter contract). It's
  // informational, not reproducible — `--since` always anchors on
  // `now`, so a clamp anchored at an older record can't round-trip.
  // The note text in the renderer makes that explicit; the JSON
  // shape guarantees parseability so dashboards never fail on a
  // sparse-clamp branch.
  it('clamped_since is always a parseable duration string (codex round-8 P2)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const lines: string[] = [];
    // Dense hourly log spanning MAX_BUCKETS+1 hours → contiguous clamp.
    const anchor = new Date('2026-05-16T12:00:00.000Z').getTime();
    for (let i = 0; i <= MAX_BUCKETS; i += 1) {
      const stepsFromEarliest = MAX_BUCKETS - i;
      const ts = new Date(anchor - stepsFromEarliest * 3600 * 1000).toISOString();
      lines.push(
        JSON.stringify({
          timestamp: ts,
          session_id: 's',
          tool_name: 'T',
          server_name: 'test',
          tier: 'read',
          status: 'allowed',
          autonomy_level: 'L1',
          duration_ms: 0,
          emission_source: 'other',
          prev_hash: '0'.repeat(64),
          hash: i.toString(16).padStart(64, '0'),
        }),
      );
    }
    await fs.writeFile(auditPath, lines.join('\n') + '\n', 'utf8');
    const now = new Date('2026-05-16T13:00:00.000Z');
    const result = await computeAuditTimeline({ baseDir: dir, bucket: '1h', now });
    expect(result.clamped_since).not.toBeNull();
    // Must match the `<N><unit>` shape so dashboards can pass it to
    // their own duration parsers without branching on the clamp mode.
    expect(result.clamped_since).toMatch(/^\d+[smhdw]$/);
  });

  // Codex round-6 P3 (0.47.0): when the post-alignment guard fires
  // on a near-boundary input, the error must report a consistent
  // count — pre-fix the message could say "= 2000 buckets exceeds
  // MAX_BUCKETS=2000" (self-contradictory). The reported count must
  // match what would actually be emitted.
  it('post-alignment overflow error reports the actual aligned count (codex round-6 P3)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    // --since=2000h --bucket=1h with `now` mid-hour: projected=2000
    // pre-alignment, but emit=2001 after alignment slack. Pre-fix
    // the error message would say "exceeds MAX_BUCKETS=2000" with
    // an "=2000 buckets" left-hand side. With the fix, the
    // left-hand count must be > MAX_BUCKETS.
    const now = new Date('2026-05-16T12:34:56.000Z'); // non-aligned
    let msg = '';
    try {
      await computeAuditTimeline({ baseDir: dir, since: '2000h', bucket: '1h', now });
    } catch (e) {
      msg = (e as Error).message;
    }
    // Extract "= NNNN buckets" from the message.
    const m = /=\s+(\d+)\s+buckets exceeds MAX_BUCKETS=(\d+)/.exec(msg);
    expect(m).not.toBeNull();
    const reported = Number.parseInt(m![1]!, 10);
    const max = Number.parseInt(m![2]!, 10);
    expect(reported).toBeGreaterThan(max);
  });

  // Codex round-4 P2 (0.47.0): the wider-bucket suggestion must
  // account for alignment slack — `ceil(N/S)` alone underestimates
  // the post-alignment count by 1, so a suggestion landing exactly
  // at MAX_BUCKETS would re-throw when the operator pastes it.
  it('wider-bucket suggestion accounts for alignment slack (codex round-4 P2)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:34:56.000Z'); // non-aligned
    let msg = '';
    try {
      await computeAuditTimeline({ baseDir: dir, since: '2000h', bucket: '1m', now });
    } catch (e) {
      msg = (e as Error).message;
    }
    const tryIdx = msg.indexOf('Try');
    expect(tryIdx).toBeGreaterThan(-1);
    const trySection = msg.slice(tryIdx);
    const m = /--bucket=(\d+[hdw])\b/.exec(trySection);
    expect(m).not.toBeNull();
    const suggestedBucket = m![1]!;
    // Re-run with the suggested bucket — must NOT throw.
    const result = await computeAuditTimeline({
      baseDir: dir,
      since: '2000h',
      bucket: suggestedBucket,
      now,
    });
    expect(result.buckets.length).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  // Codex round-2 P2 (0.47.0): a log that spans exactly
  // `MAX_BUCKETS * bucketSeconds` with activity at both edges still
  // emits MAX_BUCKETS+1 buckets after alignment. The auto-clamp must
  // fire at `projected >= MAX_BUCKETS`, not strictly `>`, or the
  // exact-boundary case still throws at the post-scan guard.
  it('auto-clamp fires at the exact MAX_BUCKETS boundary (codex round-2 P2)', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    // Build a synthetic log of MAX_BUCKETS+1 hourly events (so the
    // post-scan keys.length would be MAX_BUCKETS+1 if the clamp
    // didn't fire). Bypass the chained appendAuditRecord (which would
    // hash-chain each one) by writing minimal records directly — this
    // is a boundary-shape test, not a chain-integrity test.
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    const lines: string[] = [];
    // 2001 hourly events ending at the anchor instant. Write in
    // CHRONOLOGICAL ORDER (oldest first) since the audit log is
    // append-only by insert-time, and measureLogBounds depends on
    // first-line-of-file being the earliest.
    const anchor = new Date('2026-05-16T12:00:00.000Z').getTime();
    for (let i = 0; i <= MAX_BUCKETS; i += 1) {
      const stepsFromEarliest = MAX_BUCKETS - i;
      const ts = new Date(anchor - stepsFromEarliest * 3600 * 1000).toISOString();
      lines.push(
        JSON.stringify({
          timestamp: ts,
          session_id: 's',
          tool_name: 'T',
          server_name: 'test',
          tier: 'read',
          status: 'allowed',
          autonomy_level: 'L1',
          duration_ms: 0,
          emission_source: 'other',
          prev_hash: '0'.repeat(64),
          hash: i.toString(16).padStart(64, '0'),
        }),
      );
    }
    await fs.writeFile(auditPath, lines.join('\n') + '\n', 'utf8');
    const now = new Date('2026-05-16T13:00:00.000Z');
    // Without the >= boundary fix this throws at the post-scan
    // `keys.length > MAX_BUCKETS` guard.
    const result = await computeAuditTimeline({ baseDir: dir, bucket: '1h', now });
    expect(result.clamped_since).not.toBeNull();
    expect(result.buckets.length).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  // Codex round-1 P2 (0.47.0): the suggested `--since` value in the
  // overflow error must itself survive the post-alignment guard. Pre-fix
  // the suggestion used `MAX_BUCKETS * bucketSeconds` which throws at
  // the +1 boundary on most non-aligned `now` values.
  it('suggested --since value in overflow error actually fits', async () => {
    const dir = await setupRepo();
    cleanup.push(dir);
    const now = new Date('2026-05-16T12:34:56.000Z'); // non-aligned
    let msg = '';
    try {
      await computeAuditTimeline({ baseDir: dir, since: '2001h', bucket: '1h', now });
    } catch (e) {
      msg = (e as Error).message;
    }
    // Parse the suggested --since value out of the error text. The
    // error echoes the operator's input as `--since=<original>` first,
    // then suggests a fitting value after the `Try` marker — anchor on
    // `Try` so we capture the SUGGESTION, not the echo.
    const tryIdx = msg.indexOf('Try');
    expect(tryIdx).toBeGreaterThan(-1);
    const trySection = msg.slice(tryIdx);
    const m = /--since=(\d+[smhdw])\b/.exec(trySection);
    expect(m).not.toBeNull();
    const suggested = m![1]!;
    // Re-run with the suggestion and confirm it doesn't throw.
    const result = await computeAuditTimeline({
      baseDir: dir,
      since: suggested,
      bucket: '1h',
      now,
    });
    expect(result.buckets.length).toBeLessThanOrEqual(MAX_BUCKETS);
  });
});
