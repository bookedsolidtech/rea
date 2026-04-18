import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  metricsFilePath,
  recordTelemetry,
  summarizeTelemetry,
  type TelemetryRecord,
} from './codex-telemetry.js';

/** Create a fresh scratch dir; caller is responsible for cleanup via the registry. */
async function scratch(): Promise<string> {
  return fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-telemetry-test-')),
  );
}

async function readLines(filePath: string): Promise<string[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw.split('\n').filter((l) => l.length > 0);
}

describe('recordTelemetry', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('writes a single JSONL row with the expected shape', async () => {
    const dir = await scratch();
    cleanup.push(dir);

    await recordTelemetry(dir, {
      invocation_type: 'adversarial-review',
      input_text: 'diff content here',
      output_text: '{"verdict":"pass"}',
      duration_ms: 1234,
      exit_code: 0,
    });

    const lines = await readLines(metricsFilePath(dir));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as TelemetryRecord;
    expect(parsed.invocation_type).toBe('adversarial-review');
    expect(parsed.duration_ms).toBe(1234);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.rate_limited).toBe(false);
    expect(parsed.estimated_input_tokens).toBeGreaterThan(0);
    expect(parsed.estimated_output_tokens).toBeGreaterThan(0);
    expect(typeof parsed.timestamp).toBe('string');
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow();
  });

  it('creates .rea/ if absent before writing', async () => {
    const dir = await scratch();
    cleanup.push(dir);

    await recordTelemetry(dir, {
      invocation_type: 'review',
      input_text: 'x',
      output_text: 'y',
      duration_ms: 0,
      exit_code: 0,
    });

    const stat = await fs.stat(path.join(dir, '.rea'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('never stores input_text or output_text — payload must not leak', async () => {
    const dir = await scratch();
    cleanup.push(dir);
    const SECRET_INPUT = 'THIS_IS_INPUT_MARKER_DO_NOT_STORE_ME';
    const SECRET_OUTPUT = 'THIS_IS_OUTPUT_MARKER_DO_NOT_STORE_ME';

    await recordTelemetry(dir, {
      invocation_type: 'review',
      input_text: SECRET_INPUT,
      output_text: SECRET_OUTPUT,
      duration_ms: 1,
      exit_code: 0,
    });

    const raw = await fs.readFile(metricsFilePath(dir), 'utf8');
    expect(raw).not.toContain(SECRET_INPUT);
    expect(raw).not.toContain(SECRET_OUTPUT);
  });

  it('multiple writes append chronologically without interleaving', async () => {
    const dir = await scratch();
    cleanup.push(dir);

    for (let i = 0; i < 5; i += 1) {
      await recordTelemetry(dir, {
        invocation_type: 'review',
        input_text: 'a',
        output_text: 'b',
        duration_ms: i * 10,
        exit_code: 0,
      });
    }

    const lines = await readLines(metricsFilePath(dir));
    expect(lines).toHaveLength(5);
    const parsed = lines.map((l) => JSON.parse(l) as TelemetryRecord);
    // Every line must be valid JSON — no interleaving.
    expect(parsed.map((p) => p.duration_ms)).toEqual([0, 10, 20, 30, 40]);
  });

  describe('rate-limit detection', () => {
    const realWorldCases: Array<{ name: string; stderr: string; expected: boolean }> = [
      {
        name: 'OpenAI 429 response',
        stderr: 'Error: 429 Too Many Requests — rate limit reached for gpt-5',
        expected: true,
      },
      {
        name: 'Anthropic-style rate-limit phrasing',
        stderr: 'APIError: rate_limit_error (status 429)',
        expected: true,
      },
      {
        name: 'Codex usage-limit banner',
        stderr: 'You have exceeded quota for the free tier of this model.',
        expected: true,
      },
      {
        name: 'usage limit wording',
        stderr: 'usage limit hit — please retry later',
        expected: true,
      },
      {
        name: 'clean success',
        stderr: '',
        expected: false,
      },
      {
        name: 'generic failure unrelated to rate-limits',
        stderr: 'Error: ENOENT: no such file or directory',
        expected: false,
      },
    ];

    it.each(realWorldCases)(
      'stderr "$name" → rate_limited=$expected',
      async ({ stderr, expected }) => {
        const dir = await scratch();
        cleanup.push(dir);
        await recordTelemetry(dir, {
          invocation_type: 'review',
          input_text: 'a',
          output_text: 'b',
          duration_ms: 1,
          exit_code: expected ? 1 : 0,
          stderr,
        });
        const lines = await readLines(metricsFilePath(dir));
        const parsed = JSON.parse(lines[0] ?? '') as TelemetryRecord;
        expect(parsed.rate_limited).toBe(expected);
      },
    );
  });

  it('write failure surfaces a single stderr warning and does not throw', async () => {
    // Point at a path whose parent cannot be created (a regular file in the
    // `.rea/` slot). appendFile will fail; the call must still resolve.
    const dir = await scratch();
    cleanup.push(dir);
    await fs.writeFile(path.join(dir, '.rea'), 'not a dir');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => {
      warnings.push(String(msg));
    };
    try {
      await expect(
        recordTelemetry(dir, {
          invocation_type: 'review',
          input_text: 'x',
          output_text: 'y',
          duration_ms: 0,
          exit_code: 0,
        }),
      ).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatch(/codex telemetry write failed/);
  });
});

describe('summarizeTelemetry', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    // Anchor "now" so day bucketing is deterministic.
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  it('missing file → all-zero summary, no throw', async () => {
    const dir = await scratch();
    cleanup.push(dir);
    const summary = await summarizeTelemetry(dir, 7);
    expect(summary.window_days).toBe(7);
    expect(summary.invocations_per_day).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(summary.total_estimated_tokens).toBe(0);
    expect(summary.rate_limited_count).toBe(0);
    expect(summary.avg_latency_ms).toBe(0);
  });

  it('groups correctly by day and respects windowDays', async () => {
    const dir = await scratch();
    cleanup.push(dir);
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });

    // Write 3 records today and 1 yesterday. Use `recordTelemetry` so we
    // exercise the real write path; the frozen clock keeps timestamps
    // under control.
    await recordTelemetry(dir, {
      invocation_type: 'review',
      input_text: 'abcd',
      output_text: 'efgh',
      duration_ms: 100,
      exit_code: 0,
    });
    await recordTelemetry(dir, {
      invocation_type: 'review',
      input_text: 'abcd',
      output_text: 'efgh',
      duration_ms: 200,
      exit_code: 0,
    });

    // Advance one day.
    vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
    await recordTelemetry(dir, {
      invocation_type: 'review',
      input_text: 'abcd',
      output_text: 'efgh',
      duration_ms: 300,
      exit_code: 0,
      stderr: '429 rate limit',
    });

    const summary = await summarizeTelemetry(dir, 3);
    expect(summary.window_days).toBe(3);
    // Most-recent-first — today has 1, yesterday has 2.
    expect(summary.invocations_per_day[0]).toBe(1);
    expect(summary.invocations_per_day[1]).toBe(2);
    expect(summary.invocations_per_day[2]).toBe(0);
    expect(summary.rate_limited_count).toBe(1);
    expect(summary.avg_latency_ms).toBe((100 + 200 + 300) / 3);
  });

  it('skips malformed lines without throwing', async () => {
    const dir = await scratch();
    cleanup.push(dir);
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    const filePath = metricsFilePath(dir);
    const goodLine =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        invocation_type: 'review',
        estimated_input_tokens: 1,
        estimated_output_tokens: 1,
        duration_ms: 10,
        exit_code: 0,
        rate_limited: false,
      }) + '\n';
    await fs.writeFile(filePath, `not json\n${goodLine}{"broken": true}\n`);
    const summary = await summarizeTelemetry(dir, 1);
    // Only the one valid "today" record should count.
    expect(summary.invocations_per_day[0]).toBe(1);
  });

  it('records outside the window are excluded', async () => {
    const dir = await scratch();
    cleanup.push(dir);
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    const filePath = metricsFilePath(dir);
    // Ten days ago.
    const staleTs = new Date('2026-04-08T12:00:00Z').toISOString();
    const line =
      JSON.stringify({
        timestamp: staleTs,
        invocation_type: 'review',
        estimated_input_tokens: 50,
        estimated_output_tokens: 50,
        duration_ms: 999,
        exit_code: 0,
        rate_limited: true,
      }) + '\n';
    await fs.writeFile(filePath, line);
    const summary = await summarizeTelemetry(dir, 7);
    expect(summary.invocations_per_day.every((n) => n === 0)).toBe(true);
    expect(summary.total_estimated_tokens).toBe(0);
    expect(summary.rate_limited_count).toBe(0);
  });
});
