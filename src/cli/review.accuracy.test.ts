/**
 * T-ACCURACY-1..8 (codex round-8, class closure) — record-vs-reality invariant.
 *
 * For EACH of the 8 openrouter/both paths, assert the WRITTEN record(s) match
 * what the code ACTUALLY did — closing the "records overclaim reality" class
 * (M1 data_policy requested-vs-verified, M2 fallback_provider truth, M3 fresh
 * parity on shadow-unavailable, plus the already-green FIX A/C/K/L invariants).
 *
 * These drive the REAL provider path end-to-end through `runReview` /
 * `runShadowParity` against a mock transport (via `deps.__testProviderSeams`),
 * with NO network. Each test reads the on-disk audit log / parity report and
 * asserts the records are accurate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runReview,
  selectProvider,
  type ReviewOutcome,
  type RunReviewDeps,
  type ShadowCapture,
} from './review.js';
import { invalidatePolicyCache } from '../policy/loader.js';
import { runShadowParity, PARITY_REPORT_RELATIVE } from './review-shadow.js';
import { InvocationStatus, type Policy } from '../policy/types.js';
import type { OpenRouterTransport, TransportResponse } from './review-openrouter.js';

let tmpDir: string;
let prevCwd: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const BASE_POLICY = [
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
];

function writePolicy(extra: string[]): void {
  fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.rea', 'policy.yaml'), [...BASE_POLICY, ...extra].join('\n') + '\n');
  invalidatePolicyCache(tmpDir);
}

/** A transport returning a canned chat/completions body. */
function cannedTransport(
  content: unknown,
  opts: { provider?: string; usage?: unknown } = {},
): OpenRouterTransport {
  const body = {
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    choices: [{ message: { content: JSON.stringify(content) } }],
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  };
  return {
    async post(): Promise<TransportResponse> {
      return { status: 200, json: body, text: JSON.stringify(body) };
    },
  };
}

/** Codex-shaped outcome (what a fake codex fallback returns). */
function codexOutcome(over: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    verdict: 'pass',
    findingCount: 0,
    baseRef: 'refs/remotes/origin/main',
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

interface Captured {
  exitCode: number;
  stdout: string;
}

async function runReviewCaptured(deps: RunReviewDeps): Promise<Captured> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown): boolean => {
    chunks.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let exitCode = -999;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__${exitCode}`);
  }) as never);
  try {
    await runReview({ json: true }, deps);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
  }
  return { exitCode, stdout: chunks.join('') };
}

function readAuditRecords(): Array<Record<string, unknown>> {
  const p = path.join(tmpDir, '.rea', 'audit.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function rec(toolName: string): Record<string, unknown> | undefined {
  return readAuditRecords().find((r) => r.tool_name === toolName);
}
function meta(r: Record<string, unknown> | undefined): Record<string, unknown> {
  return (r?.metadata ?? {}) as Record<string, unknown>;
}

/** A clean changed-path set (sends). */
const cleanEnum = () => ({ paths: ['app.ts'], errored: false });
/** A sensitive (strawn-legal) changed-path set (path-guard refuses). */
const sensitiveEnum = () => ({ paths: ['strawn-legal/contract.md'], errored: false });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-acc-'));
  prevCwd = process.cwd();
  git(['init', '-q'], tmpDir);
  git(['config', 'user.email', 'a@t.test'], tmpDir);
  git(['config', 'user.name', 'A'], tmpDir);
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

describe('record-vs-reality (T-ACCURACY-1..8)', () => {
  it('T-ACCURACY-1: openrouter SUCCESS → provider:openrouter, data_policy requested+enforced, served_by present', async () => {
    writePolicy(['review:', '  provider: openrouter']);
    const run = await runReviewCaptured({
      __testProviderSeams: {
        transport: cannedTransport(
          { verdict: 'pass', findings: [] },
          { provider: 'fireworks', usage: { prompt_tokens: 100, completion_tokens: 10 } },
        ),
        enumerate: cleanEnum,
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
      },
    });
    expect(run.exitCode).toBe(0);
    const m = meta(rec('rea.local_review'));
    expect(m.provider).toBe('openrouter');
    expect(m.served_by).toBe('fireworks');
    // M1: no pin set → enforced is routing-requested; NO 'deny-training' literal.
    expect(m.data_policy_requested).toBe('deny');
    expect(m.data_policy_enforced).toBe('routing-requested');
    expect('data_policy' in m).toBe(false);
  });

  it('T-ACCURACY-1b: openrouter SUCCESS with a MATCHING pin → data_policy_enforced=pin-verified', async () => {
    writePolicy([
      'review:',
      '  provider: openrouter',
      '  providers:',
      '    openrouter:',
      '      backend_pin: ["fireworks"]',
    ]);
    await runReviewCaptured({
      __testProviderSeams: {
        transport: cannedTransport({ verdict: 'pass', findings: [] }, { provider: 'fireworks' }),
        enumerate: cleanEnum,
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
      },
    });
    const m = meta(rec('rea.local_review'));
    expect(m.served_by).toBe('fireworks');
    expect(m.data_policy_requested).toBe('deny');
    expect(m.data_policy_enforced).toBe('pin-verified'); // served_by ∈ pin
  });

  it('T-ACCURACY-2: REFUSE + codex AVAILABLE → refused_external fallback_provider:codex, then codex review, NO data_policy', async () => {
    writePolicy(['review:', '  provider: openrouter']);
    const codexFallback = vi.fn(async () => codexOutcome({ verdict: 'pass' }));
    const run = await runReviewCaptured({
      __testProviderSeams: {
        transport: cannedTransport({ verdict: 'pass', findings: [] }),
        enumerate: sensitiveEnum, // path-guard refuses
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
        codexAvailable: () => true,
        codexFallback,
        codexProbeVersion: () => 'codex-cli 1.0.0',
      },
    });
    expect(run.exitCode).toBe(0);
    expect(codexFallback).toHaveBeenCalledOnce(); // codex ACTUALLY ran
    // refused_external accurately names codex as the fallback that ran.
    const refused = meta(rec('rea.local_review.refused_external'));
    expect(refused.attempted_provider).toBe('openrouter');
    expect(refused.fallback_provider).toBe('codex');
    expect(refused.refusal_class).toContain('path-guard');
    // The canonical review record names codex; NO data_policy_* (codex served).
    const m = meta(rec('rea.local_review'));
    expect(m.provider).toBe('codex');
    expect('data_policy_requested' in m).toBe(false);
    expect('data_policy_enforced' in m).toBe(false);
    expect('served_by' in m).toBe(false);
  });

  it('T-ACCURACY-3: REFUSE + codex ABSENT + mode:off → refused_external fallback_provider:NONE, skipped_unavailable, exit 0', async () => {
    writePolicy(['review:', '  provider: openrouter', '  local_review:', '    mode: off']);
    const codexFallback = vi.fn(async () => codexOutcome());
    const run = await runReviewCaptured({
      __testProviderSeams: {
        transport: cannedTransport({ verdict: 'pass', findings: [] }),
        enumerate: sensitiveEnum,
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
        codexAvailable: () => false, // codex NOT installed
        codexFallback, // wired but unavailable → must not run
      },
    });
    // mode:off opt-out → exit 0.
    expect(run.exitCode).toBe(0);
    expect(codexFallback).not.toHaveBeenCalled(); // codex did NOT run
    // M2: the refusal record says fallback_provider:none (codex never ran).
    const refused = meta(rec('rea.local_review.refused_external'));
    expect(refused.fallback_provider).toBe('none');
    // The skip record is written; NO coverage-bearing canonical record.
    expect(rec('rea.local_review.skipped_unavailable')).toBeDefined();
    expect(rec('rea.local_review')).toBeUndefined();
  });

  it('T-ACCURACY-4: REFUSE + codex ABSENT + mode:enforced → refused_external fallback_provider:NONE, error exit 2', async () => {
    writePolicy(['review:', '  provider: openrouter', '  local_review:', '    mode: enforced']);
    const codexFallback = vi.fn(async () => codexOutcome());
    const run = await runReviewCaptured({
      __testProviderSeams: {
        transport: cannedTransport({ verdict: 'pass', findings: [] }),
        enumerate: sensitiveEnum,
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
        codexAvailable: () => false,
        codexFallback,
      },
    });
    expect(run.exitCode).toBe(2);
    expect(codexFallback).not.toHaveBeenCalled();
    const refused = meta(rec('rea.local_review.refused_external'));
    expect(refused.fallback_provider).toBe('none');
    // Enforced mode → an error record (not a skip).
    const errRec = readAuditRecords().find(
      (r) => r.tool_name === 'rea.local_review' && r.status === 'error',
    );
    expect(errRec).toBeDefined();
    expect(rec('rea.local_review.skipped_unavailable')).toBeUndefined();
  });

  it('T-ACCURACY-5: backend-pin violation → refused_external (class backend-pin-violation) + codex fallback runs', async () => {
    writePolicy([
      'review:',
      '  provider: openrouter',
      '  providers:',
      '    openrouter:',
      '      backend_pin: ["fireworks"]',
    ]);
    const codexFallback = vi.fn(async () => codexOutcome({ verdict: 'pass' }));
    const run = await runReviewCaptured({
      __testProviderSeams: {
        // served by an UNPINNED backend → backend-pin violation.
        transport: cannedTransport({ verdict: 'pass', findings: [] }, { provider: 'someone-else' }),
        enumerate: cleanEnum,
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
        codexAvailable: () => true,
        codexFallback,
        codexProbeVersion: () => 'codex-cli 1.0.0',
      },
    });
    expect(run.exitCode).toBe(0);
    expect(codexFallback).toHaveBeenCalledOnce();
    const refused = meta(rec('rea.local_review.refused_external'));
    expect(refused.refusal_class).toBe('backend-pin-violation');
    expect(refused.fallback_provider).toBe('codex');
    // The canonical record is codex (not a forged openrouter pin-verified).
    expect(meta(rec('rea.local_review')).provider).toBe('codex');
  });

  // Rows 6-8 exercise `provider: both` shadow/parity via runShadowParity with
  // the REAL shadow provider (selectProvider shadow wiring + mock transport).
  function shadowProviderWith(
    transport: OpenRouterTransport,
    enumPaths: string[],
    shadowCapture: ShadowCapture,
    available = true,
  ) {
    return selectProvider(
      'openrouter',
      {},
      {
        baseDir: tmpDir,
        policy: undefined,
        testTransport: transport,
        testEnumerate: () => ({ paths: enumPaths, errored: false }),
        testEnv: available ? { OPENROUTER_API_KEY: 'sk-or-test' } : {},
      },
      { shadow: true, shadowCapture },
    );
  }

  it('T-ACCURACY-6: both SHADOW REFUSE → NO refused_external; shadow record error; parity openrouter_refused', async () => {
    const shadowCapture: ShadowCapture = {};
    const audits: Array<{ tool: string }> = [];
    const safeAudit = async (
      _b: string,
      tool: string,
      _s: InvocationStatus,
      _m: Record<string, unknown>,
      _p: Policy | undefined,
    ): Promise<void> => {
      audits.push({ tool });
    };
    const report = await runShadowParity({
      baseDir: tmpDir,
      options: {},
      policy: undefined,
      codexOutcome: codexOutcome({ verdict: 'pass', headSha: 'h', contentToken: 't' }),
      shadowProvider: shadowProviderWith(
        cannedTransport({ verdict: 'pass', findings: [] }),
        ['strawn-legal/contract.md'],
        shadowCapture,
      ),
      shadowCapture,
      safeAudit,
    });
    // No refused_external audit in shadow mode (FIX K, kept green).
    expect(audits.some((a) => a.tool === 'rea.local_review.refused_external')).toBe(false);
    expect(audits.some((a) => a.tool === 'rea.local_review.shadow')).toBe(true);
    expect(report!.openrouter_refused?.refusal_class).toContain('path-guard');
    expect(report!.malformed).toBe(true);
    expect(report!.openrouter_est_cost_usd).toBe(0);
  });

  it('T-ACCURACY-7: both SHADOW UNAVAILABLE → parity rewritten openrouter_unavailable:true (not stale)', async () => {
    // Pre-seed a STALE parity report that must be overwritten.
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, PARITY_REPORT_RELATIVE),
      JSON.stringify({ schema_version: 1, stale: true, openrouter_verdict: 'pass' }) + '\n',
    );
    const audits: Array<{ tool: string }> = [];
    const safeAudit = async (_b: string, tool: string): Promise<void> => {
      audits.push({ tool });
    };
    const shadowCapture: ShadowCapture = {};
    const report = await runShadowParity({
      baseDir: tmpDir,
      options: {},
      policy: undefined,
      codexOutcome: codexOutcome({ verdict: 'pass' }),
      // available=false → unavailable branch.
      shadowProvider: shadowProviderWith(
        cannedTransport({ verdict: 'pass', findings: [] }),
        ['app.ts'],
        shadowCapture,
        false,
      ),
      shadowCapture,
      safeAudit,
    });
    // M3: a FRESH unavailable report was written (not the stale one).
    expect(report!.openrouter_unavailable).toBe(true);
    expect(report!.malformed).toBe(true);
    expect(report!.openrouter_verdict).toBe('error');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, PARITY_REPORT_RELATIVE), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk.openrouter_unavailable).toBe(true);
    expect('stale' in onDisk).toBe(false); // the stale report is GONE
    // The shadow audit record is still written; codex stays authoritative.
    expect(audits.some((a) => a.tool === 'rea.local_review.shadow')).toBe(true);
  });

  it('T-ACCURACY-8: both SHADOW SUCCESS → shadow data_policy_* per ruling, real cost, full parity', async () => {
    const shadowCapture: ShadowCapture = {};
    const audits: Array<{ tool: string; meta: Record<string, unknown> }> = [];
    const safeAudit = async (
      _b: string,
      tool: string,
      _s: InvocationStatus,
      m: Record<string, unknown>,
      _p: Policy | undefined,
    ): Promise<void> => {
      audits.push({ tool, meta: m });
    };
    const report = await runShadowParity({
      baseDir: tmpDir,
      options: {},
      policy: undefined,
      codexOutcome: codexOutcome({
        verdict: 'concerns',
        findings: [{ severity: 'P2', title: 'x', body: 'y' }],
      }),
      shadowProvider: shadowProviderWith(
        cannedTransport(
          { verdict: 'concerns', findings: [{ severity: 'P2', title: 'x', body: 'y' }] },
          { provider: 'fireworks', usage: { prompt_tokens: 100000, completion_tokens: 20000 } },
        ),
        ['app.ts'],
        shadowCapture,
      ),
      shadowCapture,
      safeAudit,
    });
    // The shadow record carries the honest data-policy posture (no pin → routing).
    const shadowRec = audits.find((a) => a.tool === 'rea.local_review.shadow')!;
    expect(shadowRec.meta.data_policy_requested).toBe('deny');
    expect(shadowRec.meta.data_policy_enforced).toBe('routing-requested');
    expect('data_policy' in shadowRec.meta).toBe(false);
    // FIX L: the parity report records the REAL non-zero cost.
    expect(report!.openrouter_est_cost_usd).toBeGreaterThan(0);
    expect(report!.openrouter_refused).toBeUndefined();
    expect(report!.openrouter_unavailable).toBeUndefined();
    expect(report!.malformed).toBe(false);
    expect(report!.verdict_agreement).toBe(true);
  });
});
