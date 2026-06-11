/**
 * OpenRouter provider unit suite (mocked transport — required gate).
 *
 * Covers: AC-10 (happy path adapter + request assertions), AC-3 (malformed →
 * error, never silent pass), AC-12 (429 ladder + repair retry), AC-4
 * (redact-before-send), backend-pin violation, AC-5 (path-guard primary with
 * redactor stubbed to no-op).
 *
 * NO test performs a real outbound request — the `OpenRouterTransport` is
 * injected as a captured fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  executeOpenRouterReview,
  OpenRouterProvider,
  OpenRouterExternalRefusedError,
  OpenRouterUnauthorizedError,
  OpenRouterUnavailableError,
  OpenRouterInvalidPolicyError,
  resolveOpenRouterPolicy,
  adaptOpenRouterResponse,
  reconcileVerdict,
  extractServedBy,
  extractUsage,
  defaultTransport,
  assembleDiff,
  DiffAssemblyError,
  diffStdoutOrThrow,
  MAX_FINDINGS,
  type OpenRouterTransport,
  type TransportResponse,
} from './review-openrouter.js';
import { invalidatePolicyCache } from '../policy/loader.js';
import type { ReviewOutcome } from './review.js';
import * as redact from '../gateway/middleware/redact.js';

let tmpDir: string;
let prevCwd: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** A deterministic codex fallback outcome for ladder tests. */
function codexOutcome(over: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    verdict: 'pass',
    findingCount: 0,
    baseRef: 'b',
    headSha: 'h',
    contentToken: 't',
    durationSeconds: 1,
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    findings: [],
    reviewText: '',
    eventCount: 0,
    ...over,
  };
}

/** Build a transport that returns the given canned responses in order. */
function cannedTransport(responses: TransportResponse[]): {
  transport: OpenRouterTransport;
  calls: Array<{ url: string; body: unknown; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  let i = 0;
  const transport: OpenRouterTransport = {
    async post(url, body, headers) {
      calls.push({ url, body, headers });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r as TransportResponse;
    },
  };
  return { transport, calls };
}

/** A well-formed chat/completions response carrying a JSON review content. */
function reviewResponse(
  verdict: string,
  findings: unknown[],
  opts: { provider?: string; usage?: unknown } = {},
): TransportResponse {
  const body = {
    id: 'x',
    model: 'openai/gpt-oss-120b',
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdict, findings }) } }],
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  };
  return { status: 200, json: body, text: JSON.stringify(body) };
}

const env = { OPENROUTER_API_KEY: 'sk-or-test-sentinel' };
const noSleep = async (): Promise<void> => undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-or-'));
  prevCwd = process.cwd();
  git(['init', '-q'], tmpDir);
  git(['config', 'user.email', 'or@test.test'], tmpDir);
  git(['config', 'user.name', 'OR'], tmpDir);
  git(['config', 'commit.gpgsign', 'false'], tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const add = (a, b) => a + b;\n');
  git(['add', 'app.ts'], tmpDir);
  git(['commit', '-qm', 'baseline'], tmpDir);
  // A working-tree change so there's a diff to review.
  fs.appendFileSync(path.join(tmpDir, 'app.ts'), 'export const div = (a, b) => a / b;\n');
});

afterEach(() => {
  process.chdir(prevCwd);
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Enumerator returning a single clean path so the path-guard sends. */
const cleanEnum = () => ({ paths: ['app.ts'], errored: false });

describe('adaptOpenRouterResponse (AC-10 / AC-3)', () => {
  it('T-OK-01: well-formed blocking + P1 finding maps field-for-field', () => {
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: 'blocking',
              findings: [{ severity: 'P1', title: 't', body: 'b', file: 'a.ts', line: 12 }],
            }),
          },
        },
      ],
    };
    const parsed = adaptOpenRouterResponse(body);
    expect(parsed?.verdict).toBe('blocking');
    expect(parsed?.findings).toEqual([
      { severity: 'P1', title: 't', body: 'b', file: 'a.ts', line: 12 },
    ]);
  });

  it('T-OK-04: finding with no file/line OMITS those keys', () => {
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: 'concerns',
              findings: [{ severity: 'P2', title: 't', body: 'b' }],
            }),
          },
        },
      ],
    };
    const parsed = adaptOpenRouterResponse(body);
    const f = parsed?.findings[0] as Record<string, unknown>;
    expect('file' in f).toBe(false);
    expect('line' in f).toBe(false);
  });

  it('T-DEG-01: non-JSON content → undefined (→ error path)', () => {
    expect(
      adaptOpenRouterResponse({ choices: [{ message: { content: 'not json <<<' } }] }),
    ).toBeUndefined();
  });

  it('T-DEG-02: missing verdict → undefined', () => {
    expect(
      adaptOpenRouterResponse({
        choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
      }),
    ).toBeUndefined();
  });

  it('T-DEG-03: verdict not in enum → undefined', () => {
    expect(
      adaptOpenRouterResponse({
        choices: [{ message: { content: JSON.stringify({ verdict: 'approve', findings: [] }) } }],
      }),
    ).toBeUndefined();
  });

  it('T-DEG-04: finding severity P4 → undefined', () => {
    expect(
      adaptOpenRouterResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'concerns',
                findings: [{ severity: 'P4', title: 't', body: 'b' }],
              }),
            },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it('T-DEG-05: empty choices → undefined', () => {
    expect(adaptOpenRouterResponse({ choices: [] })).toBeUndefined();
  });
});

describe('STRUCTURAL FIX 1 (round-6) — response-ingress sanitizer', () => {
  function adaptContent(payload: unknown): ReturnType<typeof adaptOpenRouterResponse> {
    return adaptOpenRouterResponse({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    });
  }

  it('P1-1: a secret quoted in a finding body is REDACTED by the adapter', () => {
    // Build an AWS-key-shaped string at runtime so the test source + on-disk
    // file never contain a literal key (secret-scanner hook).
    const plantedSecret = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
    const parsed = adaptContent({
      verdict: 'concerns',
      findings: [{ severity: 'P2', title: `key ${plantedSecret}`, body: `found ${plantedSecret}` }],
    });
    const f = parsed!.findings[0]!;
    expect(f.title).not.toContain(plantedSecret);
    expect(f.body).not.toContain(plantedSecret);
    expect(f.body).toContain('[REDACTED]');
  });

  it('P2-3: control chars are stripped from finding title/body', () => {
    const parsed = adaptContent({
      verdict: 'concerns',
      findings: [{ severity: 'P2', title: 'a\x00b\x1bc', body: 'x\x07y\x00z' }],
    });
    const f = parsed!.findings[0]!;
    // NUL + ESC + BEL stripped; printable chars kept.
    expect(f.title).toBe('abc');
    expect(f.body).toBe('xyz');
  });

  it('P2-2: findings array is capped at MAX_FINDINGS with a truncation flag', () => {
    const many = Array.from({ length: MAX_FINDINGS + 25 }, (_v, i) => ({
      severity: 'P3',
      title: `n${i}`,
      body: 'b',
    }));
    const parsed = adaptContent({ verdict: 'pass', findings: many });
    expect(parsed!.findings.length).toBe(MAX_FINDINGS);
    expect(parsed!.truncated).toBe(true);
  });

  it('round-12: a P1 PAST the MAX_FINDINGS cap still drives the verdict (no under-classification)', () => {
    // 50 P3s then a P1 at index MAX_FINDINGS — the P1 is dropped from STORAGE
    // (truncated) but MUST still make the verdict blocking, or a buggy/hostile
    // response could launder a severe issue into a stored `pass` that preflight
    // accepts. The verdict is derived from the FULL payload, not the stored set.
    const many = [
      ...Array.from({ length: MAX_FINDINGS }, (_v, i) => ({ severity: 'P3', title: `n${i}`, body: 'b' })),
      { severity: 'P1', title: 'hidden blocker past the cap', body: 'b' },
    ];
    const parsed = adaptContent({ verdict: 'pass', findings: many });
    expect(parsed!.truncated).toBe(true);
    expect(parsed!.findings.length).toBe(MAX_FINDINGS);
    expect(parsed!.verdict).toBe('blocking');
  });

  it('P2-2: a giant finding body is byte-capped (+ truncated marker)', () => {
    const huge = 'x'.repeat(64 * 1024); // 64 KB
    const parsed = adaptContent({
      verdict: 'concerns',
      findings: [{ severity: 'P2', title: 't', body: huge }],
    });
    const f = parsed!.findings[0]!;
    expect(Buffer.byteLength(f.body, 'utf8')).toBeLessThan(huge.length);
    expect(f.body).toContain('[truncated]');
  });

  it('P1-2 / round-11: extractServedBy REJECTS control-char IDs (no laundering into a pin match); DROPS oversize / non-conforming', () => {
    // Round-11: validate the RAW value — a control char makes the served_by
    // invalid/undeterminable → DROPPED. (Pre-round-11 this sanitized
    // `fire\x00works` → `fireworks`, which LAUNDERED a forged ID into a clean
    // value that would PASS a backend_pin match — the bug codex round-11 found.)
    expect(extractServedBy({ provider: 'fire\x00works' })).toBeUndefined();
    // Any control char → DROPPED, regardless of what the remainder would be.
    expect(extractServedBy({ provider: 'fire\x00 works' })).toBeUndefined();
    expect(extractServedBy({ provider: 'fire\tworks' })).toBeUndefined();
    // Oversize (>64 chars) → DROPPED.
    expect(extractServedBy({ provider: 'a'.repeat(65) })).toBeUndefined();
    // Spaces / disallowed chars → DROPPED.
    expect(extractServedBy({ provider: 'has space' })).toBeUndefined();
    expect(extractServedBy({ provider: 'evil/../x' })).toBeUndefined();
    // A conforming value passes through unchanged.
    expect(extractServedBy({ provider: 'fireworks' })).toBe('fireworks');
    expect(extractServedBy({ provider: 'together.ai-v2_1' })).toBe('together.ai-v2_1');
  });

  it('P1-2: a forged served_by="codex" is char-valid but is just a STRING — never coverage', () => {
    // It passes the char-class (it's a normal word), but it is only metadata —
    // the audit `provider` field is set by the lane, not by served_by. This
    // test pins that extractServedBy returns it verbatim (it's a valid label);
    // the forgery cannot mint coverage because served_by is never the provider.
    expect(extractServedBy({ provider: 'codex' })).toBe('codex');
  });

  it('P3-1: extractUsage clamps absurd / negative / non-finite token counts', () => {
    expect(extractUsage({ usage: { prompt_tokens: 1e18, completion_tokens: 5 } }).input).toBe(
      100_000_000,
    );
    expect(extractUsage({ usage: { prompt_tokens: -5, completion_tokens: 5 } }).input).toBeUndefined();
    expect(
      extractUsage({ usage: { prompt_tokens: Infinity, completion_tokens: 5 } }).input,
    ).toBeUndefined();
    expect(extractUsage({ usage: { prompt_tokens: 1200, completion_tokens: 300 } })).toEqual({
      input: 1200,
      output: 300,
    });
  });
});

describe('FIX J (codex round-5) — verdict derived from findings; never trust the self-verdict', () => {
  function adapt(verdict: string, findings: unknown[]): { verdict: string; n: number } | undefined {
    const body = {
      choices: [{ message: { content: JSON.stringify({ verdict, findings }) } }],
    };
    const p = adaptOpenRouterResponse(body);
    return p === undefined ? undefined : { verdict: p.verdict, n: p.findings.length };
  }

  it('reconcileVerdict takes the MORE SEVERE of model verdict vs inferVerdict(findings)', () => {
    expect(reconcileVerdict('pass', [{ severity: 'P1', title: 't', body: 'b' }])).toBe('blocking');
    expect(reconcileVerdict('pass', [{ severity: 'P2', title: 't', body: 'b' }])).toBe('concerns');
    expect(reconcileVerdict('pass', [])).toBe('pass');
    // Model's HIGHER severity wins (don't downgrade a blocking with no findings).
    expect(reconcileVerdict('blocking', [{ severity: 'P3', title: 't', body: 'b' }])).toBe('blocking');
    expect(reconcileVerdict('blocking', [])).toBe('blocking');
    expect(reconcileVerdict('concerns', [{ severity: 'P1', title: 't', body: 'b' }])).toBe('blocking');
  });

  it('{verdict:pass, findings:[P1]} → adapter returns blocking (findings win)', () => {
    expect(adapt('pass', [{ severity: 'P1', title: 't', body: 'b' }])).toEqual({
      verdict: 'blocking',
      n: 1,
    });
  });

  it('{verdict:pass, findings:[]} → pass (no downgrade, no upgrade)', () => {
    expect(adapt('pass', [])).toEqual({ verdict: 'pass', n: 0 });
  });

  it('{verdict:blocking, findings:[P3]} → blocking (model higher severity wins)', () => {
    expect(adapt('blocking', [{ severity: 'P3', title: 't', body: 'b' }])).toEqual({
      verdict: 'blocking',
      n: 1,
    });
  });

  it('{verdict:concerns, findings:[P1]} → blocking (findings win)', () => {
    expect(adapt('concerns', [{ severity: 'P1', title: 't', body: 'b' }])).toEqual({
      verdict: 'blocking',
      n: 1,
    });
  });
});

describe('executeOpenRouterReview — happy path + request assertions (AC-10)', () => {
  it('T-OK-03: pass + empty findings → verdict pass, request carries schema + model + key', async () => {
    process.chdir(tmpDir);
    const { transport, calls } = cannedTransport([
      reviewResponse('pass', [], {
        provider: 'fireworks',
        usage: { prompt_tokens: 900, completion_tokens: 100 },
      }),
    ]);
    const outcome = await executeOpenRouterReview(
      tmpDir,
      {},
      { transport, env, sleep: noSleep, enumerate: cleanEnum },
    );
    expect(outcome.verdict).toBe('pass');
    expect(outcome.findingCount).toBe(0);
    expect(outcome.model).toBe('openai/gpt-oss-120b');
    expect(outcome.servedBy).toBe('fireworks');
    // M1 (round-8): requested='deny'; no backend_pin → enforced='routing-requested'.
    expect(outcome.dataPolicyRequested).toBe('deny');
    expect(outcome.dataPolicyEnforced).toBe('routing-requested');
    // FIX A (round-2): openrouter ACTUALLY served → actualProviderId openrouter.
    expect(outcome.actualProviderId).toBe('openrouter');
    // Request body assertions.
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect((body.response_format as Record<string, unknown>).type).toBe('json_schema');
    expect((body.provider as Record<string, unknown>).data_collection).toBe('deny');
    expect((body.provider as Record<string, unknown>).allow_fallbacks).toBe(false);
    // Authorization header built from the INJECTED env, never logged.
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-or-test-sentinel');
    expect(calls[0]!.url).toContain('/chat/completions');
  });

  it('T-OK-02: concerns with P2 only → concerns', async () => {
    process.chdir(tmpDir);
    const { transport } = cannedTransport([
      reviewResponse('concerns', [{ severity: 'P2', title: 'x', body: 'y' }]),
    ]);
    const outcome = await executeOpenRouterReview(
      tmpDir,
      {},
      { transport, env, sleep: noSleep, enumerate: cleanEnum },
    );
    expect(outcome.verdict).toBe('concerns');
    expect(outcome.findingCount).toBe(1);
  });
});

describe('AC-3 — malformed model output → error (never silent pass)', () => {
  it('malformed twice + no codex fallback → THROWS (never a silent pass); FIX H mode-deferred type', async () => {
    process.chdir(tmpDir);
    const bad: TransportResponse = {
      status: 200,
      json: { choices: [{ message: { content: 'not json at all <<<' } }] },
      text: 'x',
    };
    const { transport, calls } = cannedTransport([bad, bad]);
    // FIX H (round-4): with NO codex fallback wired, a refused/malformed run
    // throws the mode-deferred `OpenRouterExternalRefusedError` (runReview then
    // honors local_review.mode: off→skip, enforced→exit 2) instead of the old
    // always-exit-2 `OpenRouterMalformedError`. Either way it THROWS — the AC-3
    // "never a silent pass" guarantee holds (no pass outcome is returned).
    await expect(
      executeOpenRouterReview(tmpDir, {}, { transport, env, sleep: noSleep, enumerate: cleanEnum }),
    ).rejects.toBeInstanceOf(OpenRouterExternalRefusedError);
    // ONE repair retry issued (2 calls total), never a silent pass.
    expect(calls.length).toBe(2);
  });

  it('round-14 [P1]: a 401 auth failure THROWS unauthorized (no silent codex downgrade) even when codex IS available', async () => {
    process.chdir(tmpDir);
    const unauthorized: TransportResponse = { status: 401, json: {}, text: '' };
    const { transport, calls } = cannedTransport([unauthorized]);
    const codexFallback = vi.fn(async () => codexOutcome());
    let thrown: unknown;
    try {
      await executeOpenRouterReview(tmpDir, {}, {
        transport,
        env,
        sleep: noSleep,
        enumerate: cleanEnum,
        codexFallback,
      });
    } catch (e) {
      thrown = e;
    }
    // Round-15 P2: an AUTH failure is a DISTINCT error type (not the
    // codex-unavailable `OpenRouterExternalRefusedError`) so the operator-facing
    // message/audit names the real cause (the key), not "codex is not installed".
    expect(thrown).toBeInstanceOf(OpenRouterUnauthorizedError);
    expect((thrown as Error).message).toMatch(/OPENROUTER_API_KEY/);
    // The KEY round-14 property: an AUTH failure must NOT silently downgrade to
    // codex (that masks a revoked/expired key). codex was available but NOT used.
    expect(codexFallback).not.toHaveBeenCalled();
    // No repair retry for an auth failure (it is not malformed model output).
    expect(calls.length).toBe(1);
  });

  it('malformed twice WITH codex available but unwired probe → still falls back to codex (mode irrelevant)', async () => {
    process.chdir(tmpDir);
    const bad: TransportResponse = {
      status: 200,
      json: { choices: [{ message: { content: 'nope' } }] },
      text: 'x',
    };
    const { transport } = cannedTransport([bad, bad]);
    // codexFallback wired, codexAvailable absent → assumed available → runs.
    const codexFallback = vi.fn(async () => codexOutcome({ verdict: 'pass' }));
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
    });
    expect(codexFallback).toHaveBeenCalledOnce();
    expect(outcome.actualProviderId).toBe('codex');
  });

  it('negative guard: malformed body does NOT produce a pass outcome', async () => {
    process.chdir(tmpDir);
    const bad: TransportResponse = {
      status: 200,
      json: { choices: [{ message: { content: '{not valid' } }] },
      text: 'x',
    };
    const { transport } = cannedTransport([bad, bad]);
    let outcome: ReviewOutcome | undefined;
    try {
      outcome = await executeOpenRouterReview(
        tmpDir,
        {},
        { transport, env, sleep: noSleep, enumerate: cleanEnum },
      );
    } catch {
      /* expected throw */
    }
    expect(outcome).toBeUndefined();
  });
});

describe('AC-12 — degradation ladder', () => {
  it('T-DEG-06: persistent 429 → exhausts then falls back to codex', async () => {
    process.chdir(tmpDir);
    const r429: TransportResponse = { status: 429, json: {}, text: '' };
    const { transport, calls } = cannedTransport([r429, r429, r429]);
    const sleeps: number[] = [];
    const codexFallback = vi.fn(async () => codexOutcome());
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      enumerate: cleanEnum,
      codexFallback,
    });
    expect(codexFallback).toHaveBeenCalledOnce();
    expect(outcome.model).toBe('gpt-5.4'); // codex produced it
    // backoff was attempted with increasing delays.
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
    // bounded retries (3 attempts).
    expect(calls.length).toBe(3);
  });

  it('T-DEG-07: 500 transport error → ladder falls back, call count bounded', async () => {
    process.chdir(tmpDir);
    const r500: TransportResponse = { status: 500, json: {}, text: '' };
    const { transport, calls } = cannedTransport([r500, r500, r500]);
    const codexFallback = vi.fn(async () => codexOutcome());
    await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
    });
    expect(codexFallback).toHaveBeenCalledOnce();
    expect(calls.length).toBe(3);
  });

  it('T-DEG-08: malformed once then well-formed on repair retry → success (no escalation)', async () => {
    process.chdir(tmpDir);
    const bad: TransportResponse = {
      status: 200,
      json: { choices: [{ message: { content: 'nope' } }] },
      text: 'x',
    };
    const good = reviewResponse('concerns', [{ severity: 'P2', title: 'z', body: 'b' }]);
    const { transport, calls } = cannedTransport([bad, good]);
    const codexFallback = vi.fn();
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
    });
    expect(outcome.verdict).toBe('concerns');
    expect(codexFallback).not.toHaveBeenCalled();
    expect(calls.length).toBe(2); // original + ONE repair retry
  });

  it('T-DEG-09: malformed twice → escalate to codex', async () => {
    process.chdir(tmpDir);
    const bad: TransportResponse = {
      status: 200,
      json: { choices: [{ message: { content: 'nope' } }] },
      text: 'x',
    };
    const { transport } = cannedTransport([bad, bad]);
    const codexFallback = vi.fn(async () =>
      codexOutcome({ verdict: 'blocking', findingCount: 1, findings: [{ severity: 'P1', title: 'x', body: 'y' }] }),
    );
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
    });
    expect(codexFallback).toHaveBeenCalledOnce();
    expect(outcome.verdict).toBe('blocking');
  });
});

describe('AC-4 — redact-before-send', () => {
  it('T-RED-01: a planted secret in the diff is redacted before the outbound body', async () => {
    process.chdir(tmpDir);
    // Build an AWS-access-key-shaped string at RUNTIME (concatenated parts) so
    // neither this test source nor the planted fixture file ever contains a
    // literal key the secret-scanner hook would block. The shape matches the
    // redactor's `AKIA[0-9A-Z]{16}` pattern.
    const plantedSecret = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
    fs.appendFileSync(path.join(tmpDir, 'app.ts'), `\nconst k = "${plantedSecret}"; // planted\n`);
    const { transport, calls } = cannedTransport([reviewResponse('pass', [])]);
    await executeOpenRouterReview(
      tmpDir,
      {},
      { transport, env, sleep: noSleep, enumerate: cleanEnum },
    );
    const body = JSON.stringify(calls[0]!.body);
    expect(body).not.toContain(plantedSecret);
    expect(body).toContain('[REDACTED]');
  });

  it('round-17 P1: a CUSTOM policy.redact.patterns secret is redacted before the outbound body', async () => {
    process.chdir(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      [
        'version: "0.50.0"',
        'profile: open-source-no-codex',
        'installed_by: t',
        'installed_at: "2026-06-08T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths: []',
        'protected_paths_relax: []',
        'notification_channel: ""',
        'redact:',
        '  patterns:',
        '    - name: org-token',
        '      regex: "ORGSECRET-[0-9]+"',
        '',
      ].join('\n'),
    );
    invalidatePolicyCache(tmpDir);
    const orgSecret = 'ORGSECRET-' + '12345'; // matches the org pattern, NOT a built-in
    fs.appendFileSync(path.join(tmpDir, 'app.ts'), `\nconst tkn = "${orgSecret}";\n`);
    const { transport, calls } = cannedTransport([reviewResponse('pass', [])]);
    await executeOpenRouterReview(tmpDir, {}, { transport, env, sleep: noSleep, enumerate: cleanEnum });
    const body = JSON.stringify(calls[0]!.body);
    expect(body).not.toContain(orgSecret); // org-configured secret never leaves the machine
  });

  it('round-17 P2: a CUSTOM-pattern secret echoed in a finding body is redacted by the sanitizer', () => {
    const orgSecret = 'ORGSECRET-' + '67890';
    const patterns = [
      ...redact.compileDefaultSecretPatterns({ source: 'default' }),
      ...redact.compileUserRedactPatterns([{ name: 'org-token', regex: 'ORGSECRET-[0-9]+' }]),
    ];
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: 'concerns',
              findings: [{ severity: 'P2', title: 't', body: `the model leaked ${orgSecret} here` }],
            }),
          },
        },
      ],
    };
    const parsed = adaptOpenRouterResponse(body, patterns);
    expect(parsed!.findings[0]!.body).not.toContain(orgSecret);
  });

  it('redact timeout → ABORT send, fall back to codex (refusal_class redact-timeout)', async () => {
    process.chdir(tmpDir);
    // Force the redactor to report a timeout via the sentinel.
    vi.spyOn(redact, 'redactSecrets').mockReturnValue({
      output: redact.REDACT_TIMEOUT_SENTINEL,
      redacted: ['x'],
      timedOut: true,
    });
    const { transport, calls } = cannedTransport([reviewResponse('pass', [])]);
    const refusals: string[] = [];
    const codexFallback = vi.fn(async () => codexOutcome());
    await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
      onRefusedExternal: (info) => {
        refusals.push(info.refusalClass);
      },
    });
    // NO outbound transport call — the send was aborted before assembly.
    expect(calls.length).toBe(0);
    expect(refusals).toContain('redact-timeout');
    expect(codexFallback).toHaveBeenCalledOnce();
  });
});

describe('backend-pin verification', () => {
  it('served-by NOT in pin → discard findings, fall back to codex', async () => {
    process.chdir(tmpDir);
    // The response is served by an UNPINNED backend.
    const resp = reviewResponse('blocking', [{ severity: 'P1', title: 'x', body: 'y' }], {
      provider: 'someone-else',
    });
    const { transport } = cannedTransport([resp]);
    const refusals: string[] = [];
    const codexFallback = vi.fn(async () => codexOutcome());
    // Pin to fireworks via a policy file in the temp repo.
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      [
        'version: "0.50.0"',
        'profile: open-source-no-codex',
        'installed_by: t',
        'installed_at: "2026-06-08T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths: []',
        'protected_paths_relax: []',
        'notification_channel: ""',
        'review:',
        '  providers:',
        '    openrouter:',
        '      backend_pin: ["fireworks"]',
        '',
      ].join('\n'),
    );
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
      onRefusedExternal: (info) => {
        refusals.push(info.refusalClass);
      },
    });
    expect(refusals).toContain('backend-pin-violation');
    expect(codexFallback).toHaveBeenCalledOnce();
    expect(outcome.model).toBe('gpt-5.4'); // codex produced it
  });
});

describe('AC-5 — path-guard is PRIMARY (redactor stubbed to no-op)', () => {
  it('strawn-legal never external even with redactor disabled — transport never called', async () => {
    process.chdir(tmpDir);
    // STUB the redactor to a pass-through no-op. This proves the PATH-GUARD,
    // not redaction, is what keeps strawn-legal off the wire.
    vi.spyOn(redact, 'redactSecrets').mockImplementation((input: string) => ({
      output: input,
      redacted: [],
      timedOut: false,
    }));
    const { transport, calls } = cannedTransport([reviewResponse('pass', [])]);
    const refusals: string[] = [];
    const codexFallback = vi.fn(async () => codexOutcome());
    await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: () => ({ paths: ['strawn-legal/contract.md'], errored: false }),
      codexFallback,
      onRefusedExternal: (info) => {
        refusals.push(info.refusalClass);
      },
    });
    // Data did NOT leave the machine — strongest possible assertion.
    expect(calls.length).toBe(0);
    expect(refusals).toContain('path-guard');
    expect(codexFallback).toHaveBeenCalledOnce();
  });
});

describe('OpenRouterProvider — availability', () => {
  it('isAvailable false when key absent; true (version=model) when present', async () => {
    const p1 = OpenRouterProvider({ env: {} });
    expect((await p1.isAvailable(tmpDir)).available).toBe(false);
    const p2 = OpenRouterProvider({ env });
    const a = await p2.isAvailable(tmpDir);
    expect(a.available).toBe(true);
    expect(a.version).toBe('openai/gpt-oss-120b');
  });

  it('unavailableMessage never echoes the key', () => {
    const p = OpenRouterProvider({ env });
    const lines = p.unavailableMessage().join('\n');
    expect(lines).not.toContain('sk-or-test-sentinel');
  });

  it('classifyError keeps the specific kind for each known error (codex P3: 401/403 → unauthorized)', () => {
    const p = OpenRouterProvider({ env });
    expect(p.classifyError(new OpenRouterUnauthorizedError('deadbeef', 'origin/main'))).toBe(
      'unauthorized',
    );
    expect(p.classifyError(new OpenRouterUnavailableError('x'))).toBe('unavailable');
    expect(p.classifyError(new Error('something else'))).toBe('unknown');
  });

  it('classifyError surfaces the refusal class for an external-refused error (codex round-2 P2)', () => {
    const p = OpenRouterProvider({ env });
    expect(
      p.classifyError(new OpenRouterExternalRefusedError('malformed', 'deadbeef', 'origin/main')),
    ).toBe('malformed');
    expect(
      p.classifyError(new OpenRouterExternalRefusedError('path-guard', 'deadbeef', 'origin/main')),
    ).toBe('path-guard');
  });

  it('OpenRouterExternalRefusedError.isOperationalFailure splits contacted-and-failed from deliberate non-send (codex round-2 P2)', () => {
    const op = (cls: string) =>
      new OpenRouterExternalRefusedError(cls, 'h', 'b').isOperationalFailure;
    // contacted the provider and it failed
    for (const c of ['malformed', 'backend-pin-violation', 'timeout', 'http-exhausted']) {
      expect(op(c), `${c} is operational`).toBe(true);
    }
    // never sent / deliberate local refusal
    for (const c of [
      'path-guard',
      'path-override',
      'git-enumeration-error',
      'invalid-policy',
      'diff-too-large',
      'redact-timeout',
      'diff-error',
    ]) {
      expect(op(c), `${c} is NOT operational`).toBe(false);
    }
  });
});

describe('FIX C (codex round-3) — telemetry records the REAL exit status', () => {
  interface TelRow {
    exitCode: number;
    fellBack: boolean;
    rateLimited: boolean;
    servedBy?: string;
  }

  it('clean openrouter success → telemetry exit_code 0, fellBack false', async () => {
    process.chdir(tmpDir);
    const rows: TelRow[] = [];
    const { transport } = cannedTransport([
      reviewResponse('pass', [], { provider: 'fireworks', usage: { prompt_tokens: 100, completion_tokens: 10 } }),
    ]);
    await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      onTelemetry: (row) => {
        rows.push(row as TelRow);
      },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.exitCode).toBe(0);
    expect(rows[0]!.fellBack).toBe(false);
  });

  it('malformed (after repair) → telemetry exit_code != 0, fellBack true', async () => {
    process.chdir(tmpDir);
    const rows: TelRow[] = [];
    const bad: TransportResponse = {
      status: 200,
      json: { choices: [{ message: { content: 'not json' } }] },
      text: 'x',
    };
    const { transport } = cannedTransport([bad, bad]);
    const codexFallback = vi.fn(async () => codexOutcome());
    await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
      onTelemetry: (row) => {
        rows.push(row as TelRow);
      },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.exitCode).not.toBe(0);
    expect(rows[0]!.fellBack).toBe(true);
  });

  it('backend-pin violation → telemetry exit_code != 0, fellBack true', async () => {
    process.chdir(tmpDir);
    const rows: TelRow[] = [];
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      [
        'version: "0.50.0"',
        'profile: open-source-no-codex',
        'installed_by: t',
        'installed_at: "2026-06-08T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths: []',
        'protected_paths_relax: []',
        'notification_channel: ""',
        'review:',
        '  providers:',
        '    openrouter:',
        '      backend_pin: ["fireworks"]',
        '',
      ].join('\n'),
    );
    invalidatePolicyCache(tmpDir);
    const { transport } = cannedTransport([
      reviewResponse('blocking', [{ severity: 'P1', title: 'x', body: 'y' }], { provider: 'other' }),
    ]);
    const codexFallback = vi.fn(async () => codexOutcome());
    await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
      onTelemetry: (row) => {
        rows.push(row as TelRow);
      },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.exitCode).not.toBe(0);
    expect(rows[0]!.fellBack).toBe(true);
  });

  it('persistent 429 → telemetry exit_code != 0, fellBack true, rateLimited true', async () => {
    process.chdir(tmpDir);
    const rows: TelRow[] = [];
    const r429: TransportResponse = { status: 429, json: {}, text: '' };
    const { transport } = cannedTransport([r429, r429, r429]);
    const codexFallback = vi.fn(async () => codexOutcome());
    await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
      onTelemetry: (row) => {
        rows.push(row as TelRow);
      },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.exitCode).not.toBe(0);
    expect(rows[0]!.fellBack).toBe(true);
    expect(rows[0]!.rateLimited).toBe(true);
  });

  it('round-15 P3: an unauthorized (401) failure records fellBack:FALSE (no codex ran)', async () => {
    process.chdir(tmpDir);
    const rows: TelRow[] = [];
    const unauthorized: TransportResponse = { status: 401, json: {}, text: '' };
    const { transport } = cannedTransport([unauthorized]);
    const codexFallback = vi.fn(async () => codexOutcome());
    try {
      await executeOpenRouterReview(tmpDir, {}, {
        transport,
        env,
        sleep: noSleep,
        enumerate: cleanEnum,
        codexFallback,
        onTelemetry: (row) => {
          rows.push(row as TelRow);
        },
      });
    } catch {
      /* unauthorized SURFACES (throws) — expected */
    }
    expect(rows.length).toBe(1);
    expect(rows[0]!.exitCode).not.toBe(0);
    // P3: the row must NOT claim a codex fallback — none happened.
    expect(rows[0]!.fellBack).toBe(false);
    expect(codexFallback).not.toHaveBeenCalled();
  });
});

describe('FIX N (codex round-8) — git diff materialization fails CLOSED', () => {
  it('diffStdoutOrThrow: status 0 → stdout (incl. legit empty); non-zero → diff-error; ENOBUFS → diff-too-large', () => {
    expect(diffStdoutOrThrow({ status: 0, stdout: 'PATCH' } as never, 'x')).toBe('PATCH');
    // A legitimately empty diff (no changes) is NOT a failure.
    expect(diffStdoutOrThrow({ status: 0, stdout: '' } as never, 'x')).toBe('');
    let nonZero: unknown;
    try {
      diffStdoutOrThrow({ status: 128, stdout: '' } as never, 'x');
    } catch (e) {
      nonZero = e;
    }
    expect(nonZero).toBeInstanceOf(DiffAssemblyError);
    expect((nonZero as DiffAssemblyError).kind).toBe('diff-error');
    let enobufs: unknown;
    try {
      diffStdoutOrThrow(
        { error: Object.assign(new Error('buf'), { code: 'ENOBUFS' }) } as never,
        'x',
      );
    } catch (e) {
      enobufs = e;
    }
    expect((enobufs as DiffAssemblyError).kind).toBe('diff-too-large');
  });

  it('assembleDiff THROWS DiffAssemblyError on a git failure (never silently empty → false pass)', () => {
    process.chdir(tmpDir);
    // A bad base ref → `git diff <bad>...HEAD` exits non-zero → must THROW,
    // not collapse to '' (which would review an empty patch and pass).
    let thrown: unknown;
    try {
      assembleDiff(tmpDir, 'no-such-ref-deadbeef');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DiffAssemblyError);
    expect((thrown as DiffAssemblyError).kind).toBe('diff-error');
  });

  it('executeOpenRouterReview falls back to codex when the diff cannot materialize (no false pass)', async () => {
    process.chdir(tmpDir);
    // Force a diff failure via a bad explicit base; the openrouter lane must
    // NOT send/pass — it must fail closed to codex.
    const { transport, calls } = cannedTransport([reviewResponse('pass', [])]);
    const codexFallback = vi.fn(async () => codexOutcome({ verdict: 'concerns' }));
    const outcome = await executeOpenRouterReview(
      tmpDir,
      { base: 'no-such-ref-deadbeef' },
      { transport, env, sleep: noSleep, enumerate: cleanEnum, codexFallback },
    );
    expect(codexFallback).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(0); // never reached the transport
    expect(outcome.actualProviderId).toBe('codex');
  });
});

describe('FIX O (codex round-8) — billable usage preserved on failed-but-200 responses', () => {
  it('backend-pin violation with a usage block records the REAL tokens, not zero', async () => {
    process.chdir(tmpDir);
    const rows: Array<{ exitCode: number; fellBack: boolean; inputTokens?: number; outputTokens?: number }> =
      [];
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      [
        'version: "0.50.0"',
        'profile: open-source-no-codex',
        'installed_by: t',
        'installed_at: "2026-06-08T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths: []',
        'protected_paths_relax: []',
        'notification_channel: ""',
        'review:',
        '  providers:',
        '    openrouter:',
        '      backend_pin: ["fireworks"]',
        '',
      ].join('\n'),
    );
    invalidatePolicyCache(tmpDir);
    // A billable 200 served by an UN-pinned backend (pin violation) that still
    // reported usage — the tokens were billed and must be recorded.
    const { transport } = cannedTransport([
      reviewResponse('blocking', [{ severity: 'P1', title: 'x', body: 'y' }], {
        provider: 'other',
        usage: { prompt_tokens: 1234, completion_tokens: 56 },
      }),
    ]);
    const codexFallback = vi.fn(async () => codexOutcome());
    await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
      onTelemetry: (row) => {
        rows.push(row as (typeof rows)[number]);
      },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.exitCode).not.toBe(0);
    expect(rows[0]!.fellBack).toBe(true);
    // FIX O: the billable 200 consumed tokens → recorded, not zero/undefined.
    expect(rows[0]!.inputTokens).toBe(1234);
    expect(rows[0]!.outputTokens).toBe(56);
  });
});

describe('FIX A (codex round-3) — codex-fallback outcome carries codex provenance', () => {
  it('path-guard refusal → outcome.actualProviderId=codex, codex version, NO served_by/data_policy', async () => {
    process.chdir(tmpDir);
    const { transport, calls } = cannedTransport([reviewResponse('pass', [])]);
    const codexFallback = vi.fn(async () => codexOutcome({ model: 'gpt-5.4' }));
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      // Sensitive path → path-guard refuses → codex fallback.
      enumerate: () => ({ paths: ['strawn-legal/contract.md'], errored: false }),
      codexFallback,
      codexProbeVersion: () => 'codex-cli 9.9.9-fix-a',
    });
    // No outbound openrouter call; codex actually ran.
    expect(calls.length).toBe(0);
    expect(codexFallback).toHaveBeenCalledOnce();
    expect(outcome.actualProviderId).toBe('codex');
    expect(outcome.actualProviderVersion).toBe('codex-cli 9.9.9-fix-a');
    // OpenRouter-only provenance is ABSENT on a codex-served outcome.
    expect(outcome.servedBy).toBeUndefined();
    expect(outcome.dataPolicyRequested).toBeUndefined();
    expect(outcome.dataPolicyEnforced).toBeUndefined();
    expect(outcome.model).toBe('gpt-5.4'); // codex produced it
  });

  it('backend-pin violation → codex-fallback outcome stamped codex (not openrouter)', async () => {
    process.chdir(tmpDir);
    // Pin to fireworks; response served by an UNPINNED backend → fall back.
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      [
        'version: "0.50.0"',
        'profile: open-source-no-codex',
        'installed_by: t',
        'installed_at: "2026-06-08T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths: []',
        'protected_paths_relax: []',
        'notification_channel: ""',
        'review:',
        '  providers:',
        '    openrouter:',
        '      backend_pin: ["fireworks"]',
        '',
      ].join('\n'),
    );
    invalidatePolicyCache(tmpDir);
    const { transport } = cannedTransport([
      reviewResponse('blocking', [{ severity: 'P1', title: 'x', body: 'y' }], {
        provider: 'someone-else',
      }),
    ]);
    const codexFallback = vi.fn(async () => codexOutcome({ model: 'gpt-5.4' }));
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
      codexProbeVersion: () => 'codex-cli 1.2.3',
    });
    expect(outcome.actualProviderId).toBe('codex');
    expect(outcome.actualProviderVersion).toBe('codex-cli 1.2.3');
    expect(outcome.servedBy).toBeUndefined();
  });
});

describe('FIX 3 (codex round-2) — invalid policy fails CLOSED (no permissive send)', () => {
  /** Write an INVALID openrouter policy into the temp repo (unknown sub-field
   *  → zod-strict load failure). */
  function writeInvalidPolicy(): void {
    const reaDir = path.join(tmpDir, '.rea');
    fs.mkdirSync(reaDir, { recursive: true });
    fs.writeFileSync(
      path.join(reaDir, 'policy.yaml'),
      [
        'version: "0.50.0"',
        'profile: open-source-no-codex',
        'installed_by: t',
        'installed_at: "2026-06-08T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths: []',
        'protected_paths_relax: []',
        'notification_channel: ""',
        'review:',
        '  providers:',
        '    openrouter:',
        '      model: "openai/gpt-oss-120b"',
        '      bogus_unknown_field: true', // strict → load fails
        '',
      ].join('\n'),
    );
    invalidatePolicyCache(tmpDir);
  }

  it('resolveOpenRouterPolicy THROWS OpenRouterInvalidPolicyError on an existing-but-invalid policy', async () => {
    writeInvalidPolicy();
    await expect(resolveOpenRouterPolicy(tmpDir)).rejects.toBeInstanceOf(
      OpenRouterInvalidPolicyError,
    );
  });

  it('executeOpenRouterReview refuses external (codex fallback), NEVER sends with empty blocked_paths', async () => {
    process.chdir(tmpDir);
    writeInvalidPolicy();
    const { transport, calls } = cannedTransport([reviewResponse('pass', [])]);
    const refusals: string[] = [];
    const codexFallback = vi.fn(async () => codexOutcome());
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: cleanEnum,
      codexFallback,
      onRefusedExternal: (info) => {
        refusals.push(info.refusalClass);
      },
    });
    // NO outbound openrouter call — the invalid policy failed closed BEFORE send.
    expect(calls.length).toBe(0);
    expect(refusals).toContain('invalid-policy');
    expect(codexFallback).toHaveBeenCalledOnce();
    expect(outcome.model).toBe('gpt-5.4'); // codex produced it
  });

  it('a genuinely MISSING policy does NOT fail closed (defaults are safe)', async () => {
    process.chdir(tmpDir);
    // No .rea/policy.yaml at all → defaults apply, the send proceeds.
    const { transport, calls } = cannedTransport([reviewResponse('pass', [])]);
    const outcome = await executeOpenRouterReview(
      tmpDir,
      {},
      { transport, env, sleep: noSleep, enumerate: cleanEnum },
    );
    expect(outcome.verdict).toBe('pass');
    expect(calls.length).toBe(1); // the send happened (missing != invalid)
  });
});

describe('FIX 2 (codex round-2) — REA_OPENROUTER_FIXTURE is an inert/unknown var', () => {
  it('REA_OPENROUTER_FIXTURE set + NO key → provider is NOT available (no env-var trust path)', async () => {
    // The shipped provider must NOT become available from an env fixture. With
    // no key, even with the var set, isAvailable is false — the var is inert.
    const p = OpenRouterProvider({
      env: { REA_OPENROUTER_FIXTURE: '/tmp/attacker-controlled.json' },
    });
    const a = await p.isAvailable(tmpDir);
    expect(a.available).toBe(false);
  });

  it('REA_OPENROUTER_FIXTURE set + key present → execute does NOT read the file (uses the real transport)', async () => {
    process.chdir(tmpDir);
    // A canned response that, if the env-var fixture were honored, would mint a
    // PASS. We assert the provider IGNORES the var and uses the injected/real
    // transport instead — proving the file is never consulted.
    const { transport, calls } = cannedTransport([reviewResponse('blocking', [{ severity: 'P1', title: 'real', body: 'b' }])]);
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      // Key present so the gate passes; fixture var set but MUST be inert.
      env: { OPENROUTER_API_KEY: 'sk-or-test', REA_OPENROUTER_FIXTURE: '/tmp/evil.json' },
      sleep: noSleep,
      enumerate: cleanEnum,
    });
    // The verdict came from the injected transport, NOT a file the var points at.
    expect(outcome.verdict).toBe('blocking');
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('FIX G (codex round-4) — timeout_ms bounds the request; never hangs', () => {
  /** A transport whose `post` NEVER resolves (simulates a stalled handshake).
   *  It honors the AbortSignal so we can also confirm the signal is wired. */
  function neverResolvingTransport(): { transport: OpenRouterTransport; aborted: () => boolean } {
    let wasAborted = false;
    const transport: OpenRouterTransport = {
      post(_url, _body, _headers, signal) {
        return new Promise<TransportResponse>((_resolve, reject) => {
          // Never resolve on its own. If the caller aborts, surface it.
          signal?.addEventListener('abort', () => {
            wasAborted = true;
            reject(new Error('aborted'));
          });
        });
      },
    };
    return { transport, aborted: () => wasAborted };
  }

  it('a stalled transport aborts at ~timeout_ms and falls over to codex (does NOT hang)', async () => {
    process.chdir(tmpDir);
    // Short timeout via policy so the bound is tiny + deterministic.
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      [
        'version: "0.50.0"',
        'profile: open-source-no-codex',
        'installed_by: t',
        'installed_at: "2026-06-08T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths: []',
        'protected_paths_relax: []',
        'notification_channel: ""',
        'review:',
        '  providers:',
        '    openrouter:',
        '      timeout_ms: 50',
        '',
      ].join('\n'),
    );
    invalidatePolicyCache(tmpDir);
    const { transport, aborted } = neverResolvingTransport();
    const refusals: string[] = [];
    const codexFallback = vi.fn(async () => codexOutcome());
    const t0 = Date.now();
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      // Real (tiny) sleep so the backoff between attempts is bounded but real.
      sleep: async (ms) => {
        await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
      },
      enumerate: cleanEnum,
      codexFallback,
      onRefusedExternal: (info) => {
        refusals.push(info.refusalClass);
      },
    });
    const elapsed = Date.now() - t0;
    // It returned (no hang) via the codex fallback.
    expect(codexFallback).toHaveBeenCalledOnce();
    expect(outcome.model).toBe('gpt-5.4'); // codex produced it
    // The refusal class names the timeout.
    expect(refusals).toContain('timeout');
    // The signal was actually wired into the transport (real fetch would abort).
    expect(aborted()).toBe(true);
    // Bounded: 3 attempts × 50ms + tiny backoff — comfortably under 2s.
    expect(elapsed).toBeLessThan(2000);
  }, 10000);

  it('timeout-driven fallback records non-zero telemetry exit_code + fellBack', async () => {
    process.chdir(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      [
        'version: "0.50.0"',
        'profile: open-source-no-codex',
        'installed_by: t',
        'installed_at: "2026-06-08T00:00:00Z"',
        'autonomy_level: L1',
        'max_autonomy_level: L2',
        'promotion_requires_human_approval: true',
        'block_ai_attribution: true',
        'blocked_paths: []',
        'protected_paths_relax: []',
        'notification_channel: ""',
        'review:',
        '  providers:',
        '    openrouter:',
        '      timeout_ms: 30',
        '',
      ].join('\n'),
    );
    invalidatePolicyCache(tmpDir);
    const { transport } = neverResolvingTransport();
    const rows: Array<{ exitCode: number; fellBack: boolean }> = [];
    await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: async () => undefined,
      enumerate: cleanEnum,
      codexFallback: async () => codexOutcome(),
      onTelemetry: (row) => {
        rows.push(row as { exitCode: number; fellBack: boolean });
      },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.exitCode).not.toBe(0);
    expect(rows[0]!.fellBack).toBe(true);
  }, 10000);
});

describe('FIX H (codex round-4) — external refused + codex unavailable → mode-deferred error', () => {
  it('refused + codexAvailable()=false → throws OpenRouterExternalRefusedError (NOT runs codex)', async () => {
    process.chdir(tmpDir);
    const { transport, calls } = cannedTransport([reviewResponse('pass', [])]);
    const codexFallback = vi.fn(async () => codexOutcome());
    let thrown: unknown;
    try {
      await executeOpenRouterReview(tmpDir, {}, {
        transport,
        env,
        sleep: noSleep,
        // Sensitive path → path-guard refuses.
        enumerate: () => ({ paths: ['strawn-legal/x.md'], errored: false }),
        codexFallback,
        codexAvailable: () => false, // codex NOT installed
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OpenRouterExternalRefusedError);
    expect((thrown as OpenRouterExternalRefusedError).refusalClass).toContain('path-guard');
    // codex was NOT run (it's unavailable) and no outbound send happened.
    expect(codexFallback).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it('refused + codexAvailable()=true → runs codex fallback (unchanged)', async () => {
    process.chdir(tmpDir);
    const { transport } = cannedTransport([reviewResponse('pass', [])]);
    const codexFallback = vi.fn(async () => codexOutcome());
    const outcome = await executeOpenRouterReview(tmpDir, {}, {
      transport,
      env,
      sleep: noSleep,
      enumerate: () => ({ paths: ['strawn-legal/x.md'], errored: false }),
      codexFallback,
      codexAvailable: () => true,
    });
    expect(codexFallback).toHaveBeenCalledOnce();
    expect(outcome.actualProviderId).toBe('codex');
  });
});

describe('BOUNDED HARDENING (round-6) — defaultTransport body cap + redirect refusal', () => {
  let server: http.Server | undefined;
  let url = '';

  function listen(handler: http.RequestListener): Promise<void> {
    // Round-18 P1: send `Connection: close` so undici (Node fetch) does NOT keep
    // the socket alive — otherwise `server.close()` waits on the pooled
    // keep-alive connection and each test hangs ~15s. (Production is a one-shot
    // CLI: the process exits and the OS reclaims the socket, so no prod leak.)
    server = http.createServer((req, res) => {
      res.setHeader('Connection', 'close');
      handler(req, res);
    });
    return new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        url = `http://127.0.0.1:${port}/api/v1/chat/completions`;
        resolve();
      });
    });
  }

  afterEach(async () => {
    if (server !== undefined) {
      server.closeAllConnections?.(); // force-drop any lingering socket (Node 18.2+)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('P2-1: a response body over the cap is REJECTED (no unbounded text())', async () => {
    // Stream a body far larger than the 4MB cap.
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'x'.repeat(1024 * 1024); // 1MB
      // Write 8MB total — over the 4MB cap.
      let n = 0;
      const writeMore = (): void => {
        if (n >= 8) {
          res.end();
          return;
        }
        n += 1;
        res.write(chunk, writeMore);
      };
      writeMore();
    });
    await expect(
      defaultTransport.post(url, { x: 1 }, { authorization: 'Bearer t' }),
    ).rejects.toThrow(/exceeded .* bytes|refused/i);
  }, 15000);

  it('P3-2: a redirect (302) is REFUSED, not silently followed', async () => {
    await listen((_req, res) => {
      // 302 to an arbitrary host — must be refused by redirect:'error'.
      res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
      res.end();
    });
    await expect(
      defaultTransport.post(url, { x: 1 }, { authorization: 'Bearer t' }),
    ).rejects.toThrow();
  }, 15000);

  it('a normal small response is read fine (cap does not break the happy path)', async () => {
    const body = JSON.stringify({
      provider: 'fireworks',
      choices: [{ message: { content: JSON.stringify({ verdict: 'pass', findings: [] }) } }],
    });
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    const r = await defaultTransport.post(url, { x: 1 }, { authorization: 'Bearer t' });
    expect(r.status).toBe(200);
    expect((r.json as Record<string, unknown>).provider).toBe('fireworks');
  }, 15000);
});
