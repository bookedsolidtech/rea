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
      ['bucket', 'buckets', 'files_scanned', 'peak_index', 'schema_version', 'total_events', 'window'].sort(),
    );
    expect(Object.keys(result.bucket).sort()).toEqual(['raw', 'seconds']);
    expect(Object.keys(result.window).sort()).toEqual(['end', 'seconds', 'start']);
    for (const b of result.buckets) {
      expect(Object.keys(b).sort()).toEqual(['count', 'end', 'start']);
    }
  });
});
