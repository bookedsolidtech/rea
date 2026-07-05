/**
 * `provider: both` — shadow + parity (AC-6).
 *
 * The correctness requirement: the gpt-oss outcome is written under the
 * DISTINCT `rea.local_review.shadow` tool name and is NEVER preflight
 * coverage. Codex is authoritative and drives the exit code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReview, selectProvider, type ReviewOutcome, type ShadowCapture } from './review.js';
import { computePreflight } from './preflight.js';
import { invalidatePolicyCache } from '../policy/loader.js';
import { computeTreeToken } from '../audit/content-token.js';
import {
  LOCAL_REVIEW_TOOL_NAME,
  LOCAL_REVIEW_SHADOW_TOOL_NAME,
  LOCAL_REVIEW_REFUSED_EXTERNAL_TOOL_NAME,
} from '../audit/local-review-event.js';
import { appendAuditRecord } from '../audit/append.js';
import { Tier, InvocationStatus, type Policy } from '../policy/types.js';
import { runShadowParity, PARITY_REPORT_RELATIVE } from './review-shadow.js';
import type { OpenRouterTransport, TransportResponse } from './review-openrouter.js';

let tmpDir: string;
let prevCwd: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writeBothPolicy(): void {
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
      '  provider: both',
      '  local_review:',
      '    mode: enforced',
      '',
    ].join('\n'),
  );
  invalidatePolicyCache(tmpDir);
}

function outcome(over: Partial<ReviewOutcome>): ReviewOutcome {
  return {
    verdict: 'pass',
    findingCount: 0,
    baseRef: 'refs/remotes/origin/main',
    headSha: 'h',
    contentToken: 't',
    durationSeconds: 1,
    model: 'm',
    reasoningEffort: 'high',
    findings: [],
    reviewText: '',
    eventCount: 0,
    ...over,
  };
}

async function runBothCaptured(
  codexSeam: ReviewOutcome,
  shadowSeam: ReviewOutcome | (() => Promise<ReviewOutcome>),
): Promise<number> {
  vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let exitCode = -999;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__${exitCode}`);
  }) as never);
  try {
    await runReview(
      { json: true },
      {
        executeCodexReview: async () => codexSeam,
        executeOpenRouterReview:
          typeof shadowSeam === 'function' ? shadowSeam : async () => shadowSeam,
        // Default codex AVAILABLE so `provider: both` (codex authoritative)
        // does not depend on the real `codex` binary being installed — absent
        // in CI, which otherwise flips these to codex-unavailable behavior.
        __testProviderSeams: { codexAvailable: () => true },
      },
    );
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
  }
  return exitCode;
}

function records(): Array<Record<string, unknown>> {
  const p = path.join(tmpDir, '.rea', 'audit.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-both-'));
  prevCwd = process.cwd();
  git(['init', '-q'], tmpDir);
  git(['config', 'user.email', 'b@t.test'], tmpDir);
  git(['config', 'user.name', 'B'], tmpDir);
  git(['config', 'commit.gpgsign', 'false'], tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const add = (a, b) => a + b;\n');
  git(['add', 'app.ts'], tmpDir);
  git(['commit', '-qm', 'baseline'], tmpDir);
  process.chdir(tmpDir);
  invalidatePolicyCache();
});

afterEach(() => {
  process.chdir(prevCwd);
  vi.restoreAllMocks();
  invalidatePolicyCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AC-6 — provider: both shadow + parity', () => {
  it('T-SHADOW-01: codex under canonical name, gpt-oss under shadow name', async () => {
    writeBothPolicy();
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir }).toString().trim();
    const token = computeTreeToken(tmpDir);
    const exit = await runBothCaptured(
      outcome({ verdict: 'pass', headSha, contentToken: token, model: 'gpt-5.4' }),
      outcome({ verdict: 'pass', headSha, contentToken: token, model: 'openai/gpt-oss-120b' }),
    );
    expect(exit).toBe(0);
    const recs = records();
    const canonical = recs.find((r) => r.tool_name === LOCAL_REVIEW_TOOL_NAME);
    const shadow = recs.find((r) => r.tool_name === LOCAL_REVIEW_SHADOW_TOOL_NAME);
    expect(canonical).toBeDefined();
    expect(shadow).toBeDefined();
    expect((canonical!.metadata as Record<string, unknown>).provider).toBe('codex');
    expect((canonical!.metadata as Record<string, unknown>).model).toBe('gpt-5.4');
    expect((shadow!.metadata as Record<string, unknown>).provider).toBe('openrouter');
    // The parity artifact exists.
    expect(fs.existsSync(path.join(tmpDir, PARITY_REPORT_RELATIVE))).toBe(true);
  });

  it('T-SHADOW-02: a shadow-ONLY audit log does NOT cover HEAD (preflight refuses)', async () => {
    writeBothPolicy();
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir }).toString().trim();
    const token = computeTreeToken(tmpDir);
    // Hand-craft an audit log with ONLY a shadow record whose token matches.
    await appendAuditRecord(tmpDir, {
      tool_name: LOCAL_REVIEW_SHADOW_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headSha,
        content_token: token,
        base_ref: 'x',
        verdict: 'pass',
        finding_count: 0,
        provider: 'openrouter',
      },
    });
    invalidatePolicyCache(tmpDir);
    const pf = await computePreflight(tmpDir, {});
    // The shadow record is NOT coverage → refuse (no canonical review).
    expect(pf.outcome.status).toBe('refuse');
  });

  it('regression: a refused_external-only audit log does NOT cover HEAD (preflight refuses)', async () => {
    writeBothPolicy();
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir }).toString().trim();
    const token = computeTreeToken(tmpDir);
    await appendAuditRecord(tmpDir, {
      tool_name: LOCAL_REVIEW_REFUSED_EXTERNAL_TOOL_NAME,
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: headSha,
        content_token: token,
        attempted_provider: 'openrouter',
        fallback_provider: 'codex',
        refusal_class: 'path-guard',
        changed_path_count: 1,
        verdict: 'pass',
      },
    });
    invalidatePolicyCache(tmpDir);
    const pf = await computePreflight(tmpDir, {});
    expect(pf.outcome.status).toBe('refuse');
  });

  it('T-SHADOW-03: codex blocking authoritative + shadow pass → preflight refuses (codex wins)', async () => {
    writeBothPolicy();
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir }).toString().trim();
    const token = computeTreeToken(tmpDir);
    const exit = await runBothCaptured(
      outcome({
        verdict: 'blocking',
        findingCount: 1,
        findings: [{ severity: 'P1', title: 'x', body: 'y' }],
        headSha,
        contentToken: token,
        model: 'gpt-5.4',
      }),
      outcome({ verdict: 'pass', headSha, contentToken: token, model: 'openai/gpt-oss-120b' }),
    );
    // Codex blocking → exit 2 regardless of the shadow pass.
    expect(exit).toBe(2);
    invalidatePolicyCache(tmpDir);
    const pf = await computePreflight(tmpDir, {});
    // The canonical (codex) record is a blocking/denied verdict → refuse.
    expect(pf.outcome.status).toBe('refuse');
  });

  it('shadow lane never throws even when the openrouter seam throws', async () => {
    writeBothPolicy();
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir }).toString().trim();
    const token = computeTreeToken(tmpDir);
    const exit = await runBothCaptured(
      outcome({ verdict: 'pass', headSha, contentToken: token, model: 'gpt-5.4' }),
      async () => {
        throw new Error('shadow boom');
      },
    );
    // Codex pass authoritative → exit 0; the shadow throw is swallowed.
    expect(exit).toBe(0);
    const recs = records();
    // A shadow record (verdict error) is still written.
    const shadow = recs.find((r) => r.tool_name === LOCAL_REVIEW_SHADOW_TOOL_NAME);
    expect(shadow).toBeDefined();
    expect((shadow!.metadata as Record<string, unknown>).verdict).toBe('error');
  });
});

describe('T-PARITY-01 — parity report shape', () => {
  it('emits a parity report with the spec fields', async () => {
    const safeAudit = vi.fn(async () => undefined);
    const report = await runShadowParity({
      baseDir: tmpDir,
      options: {},
      policy: undefined,
      codexOutcome: outcome({
        verdict: 'concerns',
        findings: [{ severity: 'P2', title: 'shared', body: 'b' }],
        durationSeconds: 5,
      }),
      shadowProvider: {
        id: 'openrouter',
        isAvailable: async () => ({ available: true }),
        execute: async () =>
          outcome({
            verdict: 'concerns',
            findings: [
              { severity: 'P2', title: 'shared', body: 'b' },
              { severity: 'P3', title: 'extra-noise', body: 'n' },
            ],
            durationSeconds: 2,
            servedBy: 'fireworks',
          }),
        classifyError: () => 'x',
        unavailableMessage: () => [],
      },
      safeAudit,
    });
    expect(report).toBeDefined();
    expect(report!.schema_version).toBe(1);
    expect(report!.verdict_agreement).toBe(true);
    expect(report!.codex_verdict).toBe('concerns');
    expect(report!.openrouter_verdict).toBe('concerns');
    expect(report!.p2_overlap).toBe(1);
    expect(report!.fp_delta).toBe(1); // the P3 extra-noise
    expect(report!.malformed).toBe(false);
    expect(typeof report!.codex_latency_seconds).toBe('number');
    expect(typeof report!.openrouter_latency_seconds).toBe('number');
    // The shadow record was written under the shadow tool name.
    expect(safeAudit).toHaveBeenCalledWith(
      tmpDir,
      LOCAL_REVIEW_SHADOW_TOOL_NAME,
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it('codex round-6 P2: abandons a slow shadow at the single-attempt budget (does NOT hang)', async () => {
    const safeAudit = vi.fn(async () => undefined);
    const report = await runShadowParity({
      baseDir: tmpDir,
      options: {},
      // Tiny budget so the test is fast; the real default is 120s / timeout_ms.
      policy: { review: { providers: { openrouter: { timeout_ms: 20 } } } } as unknown as Policy,
      codexOutcome: outcome({ verdict: 'pass', findings: [], durationSeconds: 4 }),
      shadowProvider: {
        id: 'openrouter',
        isAvailable: async () => ({ available: true }),
        // A hung/unreachable backend — never resolves. The shadow must be
        // abandoned at the budget, NOT block the authoritative codex exit.
        execute: () => new Promise<ReviewOutcome>(() => {}),
        classifyError: () => 'x',
        unavailableMessage: () => [],
      },
      safeAudit,
    });
    expect(report).toBeDefined();
    expect(report!.openrouter_timed_out).toBe(true);
    expect(report!.malformed).toBe(true);
    expect(report!.openrouter_verdict).toBe('error');
    // The authoritative codex verdict is untouched by the shadow timeout.
    expect(report!.codex_verdict).toBe('pass');
  });
});

describe('FIX K + L (codex round-6) — shadow refusal: no false audit; parity records real cost', () => {
  /** A transport returning a canned chat/completions body (verdict+findings). */
  function cannedTransport(content: unknown, usage?: unknown): OpenRouterTransport {
    const body = {
      provider: 'fireworks',
      choices: [{ message: { content: JSON.stringify(content) } }],
      ...(usage !== undefined ? { usage } : {}),
    };
    return {
      async post(): Promise<TransportResponse> {
        return { status: 200, json: body, text: JSON.stringify(body) };
      },
    };
  }

  function makeCtx(testTransport: OpenRouterTransport, enumPaths: string[], policy?: Policy) {
    return {
      baseDir: tmpDir,
      policy,
      testTransport,
      testEnv: { OPENROUTER_API_KEY: 'sk-or-test' },
      testEnumerate: () => ({ paths: enumPaths, errored: false }),
    };
  }

  it('FIX K: shadow lane REFUSES (strawn-legal) → NO refused_external audit; parity notes the refusal; codex unaffected', async () => {
    process.chdir(tmpDir);
    const shadowCapture: ShadowCapture = {};
    // Build the REAL shadow openrouter provider exactly as runReview does, but
    // with a mock transport + a SENSITIVE changed path so the path-guard
    // refuses. No codex fallback is wired in shadow mode → it throws after
    // capturing the refusal.
    const shadowProvider = selectProvider(
      'openrouter',
      {},
      makeCtx(cannedTransport({ verdict: 'pass', findings: [] }), ['strawn-legal/contract.md']),
      { shadow: true, shadowCapture },
    );

    // Capture every safeAudit call so we can assert NO refused_external entry.
    const auditCalls: Array<{ tool: string; meta: Record<string, unknown> }> = [];
    const safeAudit = async (
      _baseDir: string,
      tool: string,
      _status: InvocationStatus,
      meta: Record<string, unknown>,
      _policy: Policy | undefined,
    ): Promise<void> => {
      auditCalls.push({ tool, meta });
    };

    const codexOutcome: ReviewOutcome = outcome({
      verdict: 'pass',
      headSha: 'h',
      contentToken: 't',
      model: 'gpt-5.4',
    });
    const report = await runShadowParity({
      baseDir: tmpDir,
      options: {},
      policy: undefined,
      codexOutcome,
      shadowProvider,
      shadowCapture,
      safeAudit,
    });

    // FIX K: the shadow lane captured a refusal — but NO refused_external audit
    // record was written (that would imply a codex fallback that never ran).
    expect(shadowCapture.refusal?.refusalClass).toContain('path-guard');
    const refusedExternal = auditCalls.find(
      (c) => c.tool === LOCAL_REVIEW_REFUSED_EXTERNAL_TOOL_NAME,
    );
    expect(refusedExternal).toBeUndefined();
    // The shadow record (informational) IS written under the shadow tool name.
    const shadowRec = auditCalls.find((c) => c.tool === LOCAL_REVIEW_SHADOW_TOOL_NAME);
    expect(shadowRec).toBeDefined();
    // The parity report surfaces the refusal (NOT an audit entry).
    expect(report).toBeDefined();
    expect(report!.openrouter_refused?.refusal_class).toContain('path-guard');
    expect(report!.malformed).toBe(true); // no parity data this run
    // A refused shadow run has zero cost (no successful billable call).
    expect(report!.openrouter_est_cost_usd).toBe(0);
  });

  it('FIX L: a successful shadow run records the REAL openrouter est-cost in the parity report', async () => {
    process.chdir(tmpDir);
    const shadowCapture: ShadowCapture = {};
    // Clean path + a usage block with real token counts → a real est-cost.
    const shadowProvider = selectProvider(
      'openrouter',
      {},
      makeCtx(
        cannedTransport(
          { verdict: 'concerns', findings: [{ severity: 'P2', title: 'x', body: 'y' }] },
          { prompt_tokens: 100000, completion_tokens: 20000 },
        ),
        ['app.ts'],
      ),
      { shadow: true, shadowCapture },
    );

    const safeAudit = async (): Promise<void> => undefined;
    const codexOutcome: ReviewOutcome = outcome({
      verdict: 'concerns',
      findings: [{ severity: 'P2', title: 'x', body: 'y' }],
    });
    const report = await runShadowParity({
      baseDir: tmpDir,
      options: {},
      policy: undefined,
      codexOutcome,
      shadowProvider,
      shadowCapture,
      safeAudit,
    });

    expect(report).toBeDefined();
    // FIX L: the est-cost is the REAL non-zero value (not the old hard-coded 0).
    expect(shadowCapture.estCostUsd).toBeGreaterThan(0);
    expect(report!.openrouter_est_cost_usd).toBe(shadowCapture.estCostUsd);
    expect(report!.openrouter_est_cost_usd).toBeGreaterThan(0);
    expect(report!.openrouter_refused).toBeUndefined();
  });
});
