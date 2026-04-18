import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APIError } from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSelfReviewer, type MessagesCreateFn } from './claude-self.js';
import type { ReviewRequest } from './types.js';

const REQ: ReviewRequest = {
  diff: 'diff --git a/foo b/foo\n+ new line',
  commit_log: 'feat: add thing',
  branch: 'feat/x',
  head_sha: 'deadbeef',
  target: 'origin/main',
};

function okCreate(jsonPayload: string): MessagesCreateFn {
  return vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: jsonPayload }],
  });
}

describe('ClaudeSelfReviewer', () => {
  const originalEnv = process.env['ANTHROPIC_API_KEY'];
  const originalCwd = process.cwd();
  let cwdStash: string;

  beforeAll(async () => {
    // Redirect process.cwd() to a scratch dir so the reviewer's default
    // telemetry write lands in a throwaway location instead of polluting
    // the real `.rea/metrics.jsonl` under the repo root.
    cwdStash = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-claude-self-cwd-')),
    );
    process.chdir(cwdStash);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(cwdStash, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = originalEnv;
  });

  describe('isAvailable', () => {
    it('returns false when ANTHROPIC_API_KEY is unset', async () => {
      const reviewer = new ClaudeSelfReviewer();
      await expect(reviewer.isAvailable()).resolves.toBe(false);
    });

    it('returns true when ANTHROPIC_API_KEY is present', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
      const reviewer = new ClaudeSelfReviewer();
      await expect(reviewer.isAvailable()).resolves.toBe(true);
    });

    it('returns true when an explicit create fn is injected (test path)', async () => {
      const reviewer = new ClaudeSelfReviewer({ create: okCreate('{}') });
      await expect(reviewer.isAvailable()).resolves.toBe(true);
    });

    it('treats empty-string API key as unavailable', async () => {
      const reviewer = new ClaudeSelfReviewer({ apiKey: '' });
      await expect(reviewer.isAvailable()).resolves.toBe(false);
    });
  });

  describe('identity', () => {
    it('pins name and version', () => {
      const reviewer = new ClaudeSelfReviewer({ create: okCreate('{}') });
      expect(reviewer.name).toBe('claude-self');
      expect(reviewer.version).toBe('claude-opus-4-7');
    });

    it('accepts a model override for the version', () => {
      const reviewer = new ClaudeSelfReviewer({
        create: okCreate('{}'),
        model: 'claude-opus-4-8-future',
      });
      expect(reviewer.version).toBe('claude-opus-4-8-future');
    });
  });

  describe('review — success path', () => {
    it('parses a well-formed model response and stamps degraded=true', async () => {
      const payload = JSON.stringify({
        verdict: 'concerns',
        summary: 'one issue found',
        findings: [
          {
            category: 'security',
            severity: 'high',
            file: 'src/foo.ts',
            line: 12,
            issue: 'missing auth check',
            evidence: '+ app.get("/admin", ...)',
            suggested_fix: 'require auth middleware',
          },
        ],
      });
      const reviewer = new ClaudeSelfReviewer({ create: okCreate(payload) });
      const result = await reviewer.review(REQ);
      expect(result.verdict).toBe('concerns');
      expect(result.summary).toBe('one issue found');
      expect(result.reviewer_name).toBe('claude-self');
      expect(result.reviewer_version).toBe('claude-opus-4-7');
      expect(result.degraded).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.line).toBe(12);
      expect(result.error).toBeUndefined();
    });

    it('drops malformed findings entries rather than erroring the whole review', async () => {
      const payload = JSON.stringify({
        verdict: 'pass',
        summary: 'ok',
        findings: [
          { category: 'security', severity: 'high', file: 'a', issue: 'ok' },
          { category: 'nope', severity: 'high', file: 'b', issue: 'bad category' },
          null,
          { not: 'a finding' },
        ],
      });
      const reviewer = new ClaudeSelfReviewer({ create: okCreate(payload) });
      const result = await reviewer.review(REQ);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.file).toBe('a');
    });

    it('always sets degraded=true even if the model returns false', async () => {
      const payload = JSON.stringify({
        verdict: 'pass',
        summary: 'ok',
        findings: [],
        degraded: false,
      });
      const reviewer = new ClaudeSelfReviewer({ create: okCreate(payload) });
      const result = await reviewer.review(REQ);
      expect(result.degraded).toBe(true);
    });
  });

  describe('review — error paths', () => {
    it('returns verdict=error when API key is missing', async () => {
      const reviewer = new ClaudeSelfReviewer();
      const result = await reviewer.review(REQ);
      expect(result.verdict).toBe('error');
      expect(result.error).toMatch(/ANTHROPIC_API_KEY/);
      expect(result.degraded).toBe(true);
    });

    it('returns verdict=error when the model output is unparseable', async () => {
      const reviewer = new ClaudeSelfReviewer({
        create: okCreate('not json at all'),
      });
      const result = await reviewer.review(REQ);
      expect(result.verdict).toBe('error');
      expect(result.error).toMatch(/unparseable/);
      expect(result.degraded).toBe(true);
    });

    it('returns verdict=error when the model returns an invalid verdict', async () => {
      const reviewer = new ClaudeSelfReviewer({
        create: okCreate(JSON.stringify({ verdict: 'lgtm', summary: 'x', findings: [] })),
      });
      const result = await reviewer.review(REQ);
      expect(result.verdict).toBe('error');
      expect(result.error).toMatch(/verdict/);
    });

    it('returns verdict=error with message on APIError (rate limit / 5xx)', async () => {
      const rateLimitErr = new APIError(
        429,
        { error: { message: 'rate_limit' } },
        'rate_limit',
        new Headers(),
      );
      const create: MessagesCreateFn = vi.fn().mockRejectedValue(rateLimitErr);
      const reviewer = new ClaudeSelfReviewer({ create });
      const result = await reviewer.review(REQ);
      expect(result.verdict).toBe('error');
      expect(result.error).toMatch(/API 429/);
    });

    it('returns verdict=error on generic network error', async () => {
      const netErr = new Error('ECONNRESET');
      const create: MessagesCreateFn = vi.fn().mockRejectedValue(netErr);
      const reviewer = new ClaudeSelfReviewer({ create });
      const result = await reviewer.review(REQ);
      expect(result.verdict).toBe('error');
      expect(result.error).toMatch(/ECONNRESET/);
    });
  });

  describe('review — diff truncation', () => {
    it('truncates diffs over 200KB and flags it in the summary', async () => {
      const bigDiff = 'x'.repeat(250 * 1024);
      const receivedParams: Array<Parameters<MessagesCreateFn>[0]> = [];
      const create: MessagesCreateFn = vi.fn().mockImplementation(async (params) => {
        receivedParams.push(params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ verdict: 'pass', summary: 'ok', findings: [] }),
            },
          ],
        };
      });
      const reviewer = new ClaudeSelfReviewer({ create });
      const result = await reviewer.review({ ...REQ, diff: bigDiff });
      expect(result.verdict).toBe('pass');
      expect(result.summary).toMatch(/truncated/i);
      expect(result.degraded).toBe(true);
      // Confirm we actually sent a shorter payload upstream.
      const userContent = receivedParams[0]?.messages[0]?.content ?? '';
      // The user message wraps the diff; the included diff itself must not
      // exceed 200KB.
      const diffStart = userContent.indexOf('## Diff\n');
      expect(diffStart).toBeGreaterThan(-1);
      expect(userContent.length).toBeLessThan(bigDiff.length);
      expect(userContent).toMatch(/NOTE: The diff was truncated/);
    });

    it('does NOT flag truncation for diffs under the cap', async () => {
      const reviewer = new ClaudeSelfReviewer({
        create: okCreate(JSON.stringify({ verdict: 'pass', summary: 'ok', findings: [] })),
      });
      const result = await reviewer.review(REQ);
      expect(result.summary).toBe('ok');
    });
  });

  describe('telemetry (G11.5)', () => {
    it('records invocation_type=adversarial-review on success with exit_code 0', async () => {
      const recorded: Array<{ baseDir: string; input: Record<string, unknown> }> = [];
      const reviewer = new ClaudeSelfReviewer({
        create: okCreate(
          JSON.stringify({ verdict: 'pass', summary: 'ok', findings: [] }),
        ),
        baseDir: '/tmp/telemetry-test',
        recordTelemetryFn: async (baseDir, input) => {
          recorded.push({ baseDir, input: input as unknown as Record<string, unknown> });
        },
      });
      await reviewer.review(REQ);
      // Telemetry is fire-and-forget; give the microtask queue a nudge.
      await new Promise((resolve) => setImmediate(resolve));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.baseDir).toBe('/tmp/telemetry-test');
      expect(recorded[0]?.input['invocation_type']).toBe('adversarial-review');
      expect(recorded[0]?.input['exit_code']).toBe(0);
      expect(typeof recorded[0]?.input['duration_ms']).toBe('number');
    });

    it('records exit_code=1 and stderr on API error', async () => {
      const recorded: Array<Record<string, unknown>> = [];
      const rateLimitErr = new APIError(
        429,
        { error: { message: 'rate_limit' } },
        'rate_limit',
        new Headers(),
      );
      const create: MessagesCreateFn = vi.fn().mockRejectedValue(rateLimitErr);
      const reviewer = new ClaudeSelfReviewer({
        create,
        recordTelemetryFn: async (_base, input) => {
          recorded.push(input as unknown as Record<string, unknown>);
        },
      });
      await reviewer.review(REQ);
      await new Promise((resolve) => setImmediate(resolve));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.['exit_code']).toBe(1);
      expect(String(recorded[0]?.['stderr'])).toMatch(/429/);
    });

    it('records exit_code=1 on unparseable output', async () => {
      const recorded: Array<Record<string, unknown>> = [];
      const reviewer = new ClaudeSelfReviewer({
        create: okCreate('this is not JSON'),
        recordTelemetryFn: async (_base, input) => {
          recorded.push(input as unknown as Record<string, unknown>);
        },
      });
      await reviewer.review(REQ);
      await new Promise((resolve) => setImmediate(resolve));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.['exit_code']).toBe(1);
    });

    it('telemetry write failure does not impact the review result (fail-soft)', async () => {
      const reviewer = new ClaudeSelfReviewer({
        create: okCreate(
          JSON.stringify({ verdict: 'pass', summary: 'ok', findings: [] }),
        ),
        // Deliberately throwing telemetry fn; the outer review must still
        // return a real ReviewResult.
        recordTelemetryFn: () => {
          throw new Error('telemetry boom');
        },
      });
      const result = await reviewer.review(REQ);
      expect(result.verdict).toBe('pass');
    });

    it('missing API key path is NOT instrumented (no SDK call to measure)', async () => {
      const recorded: Array<Record<string, unknown>> = [];
      const reviewer = new ClaudeSelfReviewer({
        recordTelemetryFn: async (_base, input) => {
          recorded.push(input as unknown as Record<string, unknown>);
        },
      });
      await reviewer.review(REQ);
      await new Promise((resolve) => setImmediate(resolve));
      // No telemetry rows — we short-circuit before hitting the SDK.
      expect(recorded).toHaveLength(0);
    });
  });
});
