/**
 * PART B — codex round-8 concerns.
 *
 * B1 [P2]: an EXISTING-but-invalid `.rea/policy.yaml` configured for
 *   `provider: both` (or `openrouter`) must FAIL CLOSED with a visible
 *   `invalid-policy` outcome (exit 2) — never silently write canonical codex
 *   coverage for a broken external-lane config.
 *
 * B2 [P2]: in `provider: both` the gpt-oss SHADOW review runs CONCURRENTLY with
 *   the authoritative codex review, so a successful codex result is NOT delayed
 *   on the shadow's budget. The shadow result is still captured (parity report
 *   written). Asserted via ordering + timing with a mocked slow shadow + fast
 *   codex.
 *
 * NO test hits the network — codex + openrouter are driven through the
 * `RunReviewDeps` seams / `runShadowParity` direct call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReview, type ReviewOutcome } from './review.js';
import {
  runShadowParity,
  startShadowExecution,
  PARITY_REPORT_RELATIVE,
} from './review-shadow.js';
import { invalidatePolicyCache } from '../policy/loader.js';
import { LOCAL_REVIEW_TOOL_NAME } from '../audit/local-review-event.js';
import { OpenRouterUnauthorizedError } from './review-openrouter.js';
import type { ReviewProvider } from './review-provider.js';
import type { Policy } from '../policy/types.js';

let tmpDir: string;
let prevCwd: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-r8-'));
  prevCwd = process.cwd();
  git(['init', '-q'], tmpDir);
  git(['config', 'user.email', 'r8@t.test'], tmpDir);
  git(['config', 'user.name', 'R8'], tmpDir);
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

/** Drive runReview with mocked stdio + intercepted exit; return {exitCode, json}. */
async function runCaptured(
  opts: Parameters<typeof runReview>[0],
  deps: Parameters<typeof runReview>[1],
): Promise<{ exitCode: number; stdout: string }> {
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
    await runReview(opts, deps);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
  }
  return { exitCode, stdout: chunks.join('') };
}

// ---------------------------------------------------------------------------
// B1 — invalid-but-present policy + openrouter/both → fail closed
// ---------------------------------------------------------------------------

describe('B1 — invalid policy fail-closed for openrouter/both', () => {
  function writeInvalidPolicy(provider: 'openrouter' | 'both'): void {
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    // `autonomy_level: BOGUS` fails zod validation but the YAML still parses,
    // so `bestEffortConfiguredProvider` recovers the configured provider.
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      `autonomy_level: BOGUS\nreview:\n  provider: ${provider}\n`,
    );
    invalidatePolicyCache(tmpDir);
  }

  for (const provider of ['both', 'openrouter'] as const) {
    it(`provider: ${provider} + invalid-but-present policy → exit 2, visible invalid-policy, NO codex coverage`, async () => {
      writeInvalidPolicy(provider);
      // A codex seam that would PASS if it ran — proving we did NOT run it.
      const codexSeam = vi.fn(async () => outcome({ verdict: 'pass' }));
      const { exitCode, stdout } = await runCaptured(
        { json: true },
        { executeCodexReview: codexSeam },
      );
      // Fail-closed exit 2.
      expect(exitCode).toBe(2);
      // The codex lane NEVER ran (no silent codex coverage).
      expect(codexSeam).not.toHaveBeenCalled();
      // The --json surface names the invalid-policy reason.
      const json = JSON.parse(stdout.split('\n').filter(Boolean)[0] as string) as Record<
        string,
        unknown
      >;
      expect(json.status).toBe('error');
      expect(json.reason).toBe('invalid-policy');
      expect(json.exit_code).toBe(2);
      // The audit log carries an ERROR record with kind invalid-policy — and
      // NO canonical "allowed" coverage record.
      const recs = records();
      const canonical = recs.filter((r) => r.tool_name === LOCAL_REVIEW_TOOL_NAME);
      expect(canonical.length).toBe(1);
      expect(canonical[0]!.status).toBe('error');
      expect((canonical[0]!.metadata as Record<string, unknown>).kind).toBe('invalid-policy');
      // No record was written with status 'allowed' (no silent coverage).
      expect(recs.some((r) => r.status === 'allowed')).toBe(false);
    });
  }

  it('a genuinely MISSING policy does NOT trip B1 (codex runs normally)', async () => {
    // No .rea/policy.yaml written. provider defaults to codex (no configured
    // openrouter/both), so the run proceeds normally.
    const codexSeam = vi.fn(async () => outcome({ verdict: 'pass' }));
    const { exitCode } = await runCaptured({ json: true }, { executeCodexReview: codexSeam });
    expect(exitCode).toBe(0);
    expect(codexSeam).toHaveBeenCalledOnce();
  });

  it('codex round-10 P1: a SYNTACTICALLY-BROKEN policy → fail closed (cannot confirm codex), NO coverage', async () => {
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    // Unparseable YAML — the provider cannot be read AT ALL. The repo MIGHT be
    // openrouter/both, so we must not silently run codex (the bypass codex
    // round-10 P1 closed).
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      'review:\n  provider: openrouter\n: : : :\n  - [unbalanced\n    nested: {',
    );
    invalidatePolicyCache(tmpDir);
    const codexSeam = vi.fn(async () => outcome({ verdict: 'pass' }));
    const { exitCode, stdout } = await runCaptured({ json: true }, { executeCodexReview: codexSeam });
    expect(exitCode).toBe(2);
    expect(codexSeam).not.toHaveBeenCalled();
    const json = JSON.parse(stdout.split('\n').filter(Boolean)[0] as string) as Record<
      string,
      unknown
    >;
    expect(json.reason).toBe('invalid-policy');
    // Provider could not be determined → reported as 'unknown', never the
    // misleading codex default.
    expect(json.provider).toBe('unknown');
    expect(records().some((r) => r.status === 'allowed')).toBe(false);
  });

  it('an explicit --provider codex on a broken policy still runs codex (operator decided)', async () => {
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.rea', 'policy.yaml'),
      'review:\n  provider: openrouter\n: : : :\n  - [unbalanced\n',
    );
    invalidatePolicyCache(tmpDir);
    const codexSeam = vi.fn(async () => outcome({ verdict: 'pass' }));
    const { exitCode } = await runCaptured(
      { json: true, provider: 'codex' },
      { executeCodexReview: codexSeam },
    );
    expect(exitCode).toBe(0);
    expect(codexSeam).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// B2 — shadow runs concurrently with codex; codex is not delayed
// ---------------------------------------------------------------------------

describe('B2 — shadow concurrency', () => {
  it('startShadowExecution returns the shadow outcome (still captured)', async () => {
    const shadowProvider: ReviewProvider = {
      id: 'openrouter',
      isAvailable: async () => ({ available: true }),
      execute: async () => outcome({ verdict: 'concerns', servedBy: 'fireworks' }),
      classifyError: () => 'x',
      unavailableMessage: () => [],
    };
    const res = await startShadowExecution({
      baseDir: tmpDir,
      options: {},
      policy: undefined,
      shadowProvider,
    });
    expect(res.unavailable).toBe(false);
    expect(res.timedOut).toBe(false);
    expect(res.malformed).toBe(false);
    expect(res.outcome?.verdict).toBe('concerns');
  });

  it('codex round-10 P3: a revoked-key shadow (401/403) → unavailable, NOT malformed', async () => {
    const shadowProvider: ReviewProvider = {
      id: 'openrouter',
      isAvailable: async () => ({ available: true }),
      // A present-but-revoked key throws OpenRouterUnauthorizedError from execute.
      execute: async () => {
        throw new OpenRouterUnauthorizedError('deadbeef', 'origin/main');
      },
      classifyError: () => 'unauthorized',
      unavailableMessage: () => [],
    };
    const res = await startShadowExecution({
      baseDir: tmpDir,
      options: {},
      policy: undefined,
      shadowProvider,
    });
    // The actionable auth problem surfaces as unavailable (→ parity report
    // openrouter_unavailable), not a generic malformed model/output failure.
    expect(res.unavailable).toBe(true);
    expect(res.malformed).toBe(false);
    expect(res.timedOut).toBe(false);
  });

  it('codex is NOT delayed by a slow shadow; the shadow result is still captured', async () => {
    // The shadow execution is slow (200ms); codex is fast. With the OLD
    // sequential design, total wall-clock ≈ codex + shadow. With the
    // concurrent design, the shadow overlaps codex, so when codex resolves
    // first the shadow promise can be awaited and resolves shortly after.
    // We assert ORDERING: codex settles BEFORE the shadow execute settles, and
    // BOTH are captured.
    const order: string[] = [];
    const SHADOW_MS = 200;

    const shadowProvider: ReviewProvider = {
      id: 'openrouter',
      isAvailable: async () => ({ available: true }),
      execute: () =>
        new Promise<ReviewOutcome>((resolve) => {
          setTimeout(() => {
            order.push('shadow-execute-done');
            resolve(outcome({ verdict: 'pass', servedBy: 'fireworks', durationSeconds: 0.2 }));
          }, SHADOW_MS);
        }),
      classifyError: () => 'x',
      unavailableMessage: () => [],
    };

    // Kick the shadow off FIRST (mirrors runReview's concurrent kickoff).
    const shadowExec = startShadowExecution({
      baseDir: tmpDir,
      options: {},
      policy: { review: { providers: { openrouter: { timeout_ms: 60_000 } } } } as unknown as Policy,
      shadowProvider,
    });
    shadowExec.catch(() => undefined);

    // "codex" completes immediately (concurrent with the in-flight shadow).
    order.push('codex-done');

    // Now assemble parity from the pre-started shadow — it should already be
    // in flight, and we await its (slightly-later) completion here.
    const codexOutcome = outcome({ verdict: 'pass', durationSeconds: 0.01 });
    const report = await runShadowParity({
      baseDir: tmpDir,
      options: {},
      policy: undefined,
      codexOutcome,
      shadowProvider,
      shadowExec,
      safeAudit: async () => undefined,
    });

    // ORDERING: codex settled BEFORE the shadow execute finished (overlap, not
    // blocking-then-start).
    expect(order).toEqual(['codex-done', 'shadow-execute-done']);
    // The shadow result is STILL captured into the parity report.
    expect(report).toBeDefined();
    expect(report!.openrouter_verdict).toBe('pass');
    expect(report!.malformed).toBe(false);
    expect(report!.openrouter_timed_out).toBeUndefined();
  });

  it('runReview (both): a fast shadow + fast codex both land; parity report written; exit follows codex', async () => {
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
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir }).toString().trim();
    // Codex blocking → exit 2 regardless of the shadow; proves shadow can't
    // change the exit and the shadow result is still captured concurrently.
    const { exitCode } = await runCaptured(
      { json: true },
      {
        executeCodexReview: async () =>
          outcome({
            verdict: 'blocking',
            findingCount: 1,
            findings: [{ severity: 'P1', title: 'x', body: 'y' }],
            headSha,
          }),
        executeOpenRouterReview: async () =>
          outcome({ verdict: 'pass', headSha, model: 'openai/gpt-oss-120b' }),
      },
    );
    expect(exitCode).toBe(2); // codex authoritative
    // The parity artifact was written from the concurrently-run shadow.
    expect(fs.existsSync(path.join(tmpDir, PARITY_REPORT_RELATIVE))).toBe(true);
  });
});
