/**
 * 0.50.x telemetry back-compat + per-provider spend (AC-14 support).
 *
 * - A codex-shaped row (no provider/model/usage fields) is byte-identical
 *   to a pre-0.50.x row.
 * - An openrouter row carries provider/model/served_by/usage/cost.
 * - `summarizeTelemetry` buckets spend per provider (absent provider → codex)
 *   and OMITS `est_cost_usd_by_provider` when no in-window row carried a cost.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordTelemetry,
  summarizeTelemetry,
  metricsFilePath,
} from './codex-telemetry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-tel-or-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readRows(): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(metricsFilePath(tmpDir), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('telemetry — 0.50.x provider fields', () => {
  it('codex-shaped row carries NONE of the new keys (byte back-compat)', async () => {
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: 'abcd',
      output_text: 'ef',
      duration_ms: 100,
      exit_code: 0,
    });
    const row = readRows()[0] as Record<string, unknown>;
    expect('provider' in row).toBe(false);
    expect('model' in row).toBe(false);
    expect('served_by' in row).toBe(false);
    expect('input_tokens' in row).toBe(false);
    expect('output_tokens' in row).toBe(false);
    expect('est_cost_usd' in row).toBe(false);
    // The original keys are exactly the pre-0.50.x set.
    expect(Object.keys(row).sort()).toEqual(
      [
        'duration_ms',
        'estimated_input_tokens',
        'estimated_output_tokens',
        'exit_code',
        'invocation_type',
        'rate_limited',
        'timestamp',
      ].sort(),
    );
  });

  it('openrouter row carries provider/model/served_by/usage/cost', async () => {
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: '',
      output_text: '',
      duration_ms: 900,
      exit_code: 0,
      provider: 'openrouter',
      model: 'openai/gpt-oss-120b',
      served_by: 'fireworks',
      usage: { input_tokens: 1200, output_tokens: 200, est_cost_usd: 0.0001 },
    });
    const row = readRows()[0] as Record<string, unknown>;
    expect(row.provider).toBe('openrouter');
    expect(row.model).toBe('openai/gpt-oss-120b');
    expect(row.served_by).toBe('fireworks');
    expect(row.input_tokens).toBe(1200);
    expect(row.output_tokens).toBe(200);
    expect(row.est_cost_usd).toBe(0.0001);
  });

  it('summarizeTelemetry buckets spend per provider; absent provider → codex', async () => {
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: '',
      output_text: '',
      duration_ms: 100,
      exit_code: 0,
      provider: 'openrouter',
      usage: { est_cost_usd: 0.002 },
    });
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: '',
      output_text: '',
      duration_ms: 100,
      exit_code: 0,
      // no provider → codex bucket
      usage: { est_cost_usd: 1.5 },
    });
    const summary = await summarizeTelemetry(tmpDir);
    expect(summary.est_cost_usd_by_provider).toEqual({ openrouter: 0.002, codex: 1.5 });
  });

  it('summarizeTelemetry OMITS est_cost_usd_by_provider when no cost rows exist', async () => {
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: 'a',
      output_text: 'b',
      duration_ms: 100,
      exit_code: 0,
    });
    const summary = await summarizeTelemetry(tmpDir);
    expect(summary.est_cost_usd_by_provider).toBeUndefined();
  });

  it('FIX E (round-3): total tokens use EXACT openrouter tokens (not the 0 estimate) + codex estimate', async () => {
    // An openrouter row: empty text → estimated_* = 0, but exact tokens present.
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: '', // → estimated_input_tokens 0
      output_text: '', // → estimated_output_tokens 0
      duration_ms: 100,
      exit_code: 0,
      provider: 'openrouter',
      usage: { input_tokens: 1200, output_tokens: 300 }, // exact = 1500
    });
    // A codex row: estimated only (no exact field). 'abcdefgh' (8 chars) →
    // ceil(8/4)=2 in; 'wxyz' (4) → ceil(4/4)=1 out → 3 estimated.
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: 'abcdefgh',
      output_text: 'wxyz',
      duration_ms: 100,
      exit_code: 0,
      // no provider, no exact usage → codex-style estimate
    });
    const summary = await summarizeTelemetry(tmpDir);
    // 1500 (openrouter exact) + 3 (codex estimate) = 1503 — NOT 3 (the bug
    // would drop the openrouter 1500 to 0).
    expect(summary.total_estimated_tokens).toBe(1503);
  });

  it('FIX E (round-3): a row with BOTH exact + estimated prefers the exact value', async () => {
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: 'xxxx', // estimate would be 1
      output_text: 'yyyy', // estimate would be 1
      duration_ms: 100,
      exit_code: 0,
      provider: 'openrouter',
      usage: { input_tokens: 1000, output_tokens: 500 }, // exact = 1500
    });
    const summary = await summarizeTelemetry(tmpDir);
    // Exact wins: 1500, not the 2-token estimate.
    expect(summary.total_estimated_tokens).toBe(1500);
  });
});
