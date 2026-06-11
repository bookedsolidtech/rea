/**
 * Integration suite — in-process `runReview` end-to-end (required gate).
 *
 * AC-1 (canonical record + preflight coverage), AC-2 (last-review.json),
 * AC-9 (exit-code semantics unchanged), AC-13 (served_by captured).
 *
 * Real temp git repo + real `.rea/audit.jsonl`; the openrouter execution is
 * injected via `deps.executeOpenRouterReview` so NO network is touched. Exit
 * codes are intercepted via `process.exit` spy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReview, resolveRepoRoot, type ReviewOutcome } from './review.js';
import { computePreflight } from './preflight.js';
import { invalidatePolicyCache } from '../policy/loader.js';
import {
  OpenRouterProvider,
  OpenRouterExternalRefusedError,
  executeOpenRouterReview,
  type OpenRouterTransport,
  type TransportResponse,
} from './review-openrouter.js';
import {
  recordTelemetry,
  metricsFilePath,
} from '../gateway/observability/codex-telemetry.js';

let tmpDir: string;
let prevCwd: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writePolicy(provider: string): void {
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
      `  provider: ${provider}`,
      '  local_review:',
      '    mode: enforced',
      '',
    ].join('\n'),
  );
  invalidatePolicyCache(tmpDir);
}

function writePolicyWithMode(provider: string, mode: 'enforced' | 'off'): void {
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
      `  provider: ${provider}`,
      '  local_review:',
      `    mode: ${mode}`,
      '',
    ].join('\n'),
  );
  invalidatePolicyCache(tmpDir);
}

function orOutcome(over: Partial<ReviewOutcome> = {}): ReviewOutcome {
  // headSha + contentToken match the real working tree so preflight can match.
  return {
    verdict: 'pass',
    findingCount: 0,
    baseRef: 'refs/remotes/origin/main',
    headSha: 'unused-overwritten-below',
    contentToken: 'unused-overwritten-below',
    durationSeconds: 3.2,
    model: 'openai/gpt-oss-120b',
    reasoningEffort: 'medium',
    findings: [],
    reviewText: 'verdict: pass',
    eventCount: 1,
    servedBy: 'fireworks',
    dataPolicyRequested: 'deny',
    dataPolicyEnforced: 'routing-requested',
    ...over,
  };
}

/** Compute the real head sha + content token of the working tree. */
function realTokens(): { headSha: string; contentToken: string } {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir })
    .toString()
    .trim();
  // Tree token: `git stash create` fingerprint OR the HEAD tree. We mirror
  // computeTreeToken by reading it through a fresh review run; simpler: use
  // the same helper.
  return { headSha, contentToken: '' };
}

interface Captured {
  exitCode: number;
  stdout: string;
}

async function runReviewCaptured(
  deps: Parameters<typeof runReview>[1],
  opts: Parameters<typeof runReview>[0] = { json: true },
): Promise<Captured> {
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-int-'));
  prevCwd = process.cwd();
  git(['init', '-q'], tmpDir);
  git(['config', 'user.email', 'int@test.test'], tmpDir);
  git(['config', 'user.name', 'Int'], tmpDir);
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

function readAuditRecords(): Array<Record<string, unknown>> {
  const p = path.join(tmpDir, '.rea', 'audit.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('AC-1 — openrouter canonical record + preflight coverage', () => {
  it('T-INT-01/02: openrouter pass writes rea.local_review and preflight accepts as coverage', async () => {
    writePolicy('openrouter');
    const { headSha } = realTokens();
    // The execute seam returns a pass outcome whose headSha/contentToken
    // match the real tree (we read them via the real provider path in a
    // second pass would be circular — instead we capture them from
    // computeTreeToken indirectly by letting the provider compute them).
    const seam = vi.fn(async (baseDir: string): Promise<ReviewOutcome> => {
      // Compute the real content token the way the provider would.
      const { computeTreeToken } = await import('../audit/content-token.js');
      return orOutcome({ headSha, contentToken: computeTreeToken(baseDir) });
    });
    const run = await runReviewCaptured({ executeOpenRouterReview: seam });
    expect(run.exitCode).toBe(0);

    const records = readAuditRecords();
    const canonical = records.find((r) => r.tool_name === 'rea.local_review');
    expect(canonical).toBeDefined();
    const meta = canonical!.metadata as Record<string, unknown>;
    expect(meta.provider).toBe('openrouter');
    expect(meta.verdict).toBe('pass');
    expect(meta.model).toBe('openai/gpt-oss-120b');
    expect(meta.reasoning_effort).toBe('medium');
    expect(typeof meta.content_token).toBe('string');

    // The JSON payload advertises provider:openrouter.
    const jsonLine = run.stdout.split('\n').filter(Boolean).find((l) => l.startsWith('{'));
    const payload = JSON.parse(jsonLine!) as Record<string, unknown>;
    expect(payload.provider).toBe('openrouter');
    expect(payload.status).toBe('pass');

    // The real coverage proof.
    invalidatePolicyCache(tmpDir);
    const pf = await computePreflight(tmpDir, {});
    expect(pf.outcome.status).toBe('clean');
  });

  it('AC-13: served_by recorded on the audit record', async () => {
    writePolicy('openrouter');
    const { headSha } = realTokens();
    const seam = vi.fn(async (baseDir: string): Promise<ReviewOutcome> => {
      const { computeTreeToken } = await import('../audit/content-token.js');
      return orOutcome({ headSha, contentToken: computeTreeToken(baseDir), servedBy: 'fireworks' });
    });
    await runReviewCaptured({ executeOpenRouterReview: seam });
    const records = readAuditRecords();
    const canonical = records.find((r) => r.tool_name === 'rea.local_review')!;
    const meta = canonical.metadata as Record<string, unknown>;
    expect(meta.served_by).toBe('fireworks');
    // M1 (round-8): the record states the REQUESTED posture + a derived
    // enforcement — never the old `'deny-training'` literal.
    expect(meta.data_policy_requested).toBe('deny');
    expect(meta.data_policy_enforced).toBe('routing-requested');
    expect('data_policy' in meta).toBe(false); // the old field is GONE
    // Round-16 P3: `provider_version` is a BINARY/SDK version. The openrouter
    // path has none — the model is recorded in `model` — so it is OMITTED here,
    // no longer the model id the availability probe returns (which made
    // provider_version === model and unreliable for tooling).
    expect('provider_version' in meta).toBe(false);
    // Ordering contract: data_policy_* land AFTER served_by.
    const keys = Object.keys(meta);
    expect(keys.indexOf('data_policy_requested')).toBeGreaterThan(keys.indexOf('served_by'));
  });

  it('round-16: provider_version is OMITTED on an openrouter success (not the model id)', async () => {
    writePolicy('openrouter');
    const { headSha } = realTokens();
    const seam = vi.fn(async (baseDir: string): Promise<ReviewOutcome> => {
      const { computeTreeToken } = await import('../audit/content-token.js');
      return orOutcome({ headSha, contentToken: computeTreeToken(baseDir), servedBy: 'fireworks' });
    });
    await runReviewCaptured({ executeOpenRouterReview: seam });
    const meta = readAuditRecords().find((r) => r.tool_name === 'rea.local_review')!
      .metadata as Record<string, unknown>;
    expect(meta.provider_version).toBeUndefined();
    expect(meta.model).toBe('openai/gpt-oss-120b'); // the model id lives in `model`, not provider_version
  });
});

describe('round-16: nested-cwd / git-root resolution', () => {
  it('resolveRepoRoot from a nested subdirectory returns the git toplevel', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-root-'));
    git(['init', '-q'], repo);
    const sub = path.join(repo, 'packages', 'api', 'src');
    fs.mkdirSync(sub, { recursive: true });
    expect(fs.realpathSync(resolveRepoRoot(sub))).toBe(fs.realpathSync(repo));
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('resolveRepoRoot outside a git repo falls back to the given cwd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-nogit-'));
    expect(resolveRepoRoot(tmp)).toBe(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('codex round-20 P1: a subproject with its own .rea/ STILL resolves to the git toplevel (package-local .rea/ unsupported)', () => {
    // git paths are repo-root-relative + preflight/push-gate read the top-level
    // .rea/, so the git toplevel is authoritative — a package-local .rea/ inside
    // a larger checkout is NOT a separate review root (round-19's nearest-.rea/
    // proposal was reverted because it broke path-joining + push-gate coverage).
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-mono-'));
    git(['init', '-q'], repo);
    const pkg = path.join(repo, 'packages', 'api');
    fs.mkdirSync(path.join(pkg, '.rea'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
    expect(fs.realpathSync(resolveRepoRoot(pkg))).toBe(fs.realpathSync(repo));
    expect(fs.realpathSync(resolveRepoRoot(path.join(pkg, 'src')))).toBe(fs.realpathSync(repo));
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe('FIX A (codex round-3) — audit names the provider that ACTUALLY ran', () => {
  it('openrouter configured but FELL BACK to codex → audit provider:codex, no served_by; JSON matches', async () => {
    writePolicy('openrouter');
    const { headSha } = realTokens();
    // The execute seam returns a CODEX-FALLBACK-shaped outcome (as the real
    // provider would after a path-guard refusal): actualProviderId=codex,
    // a codex version, and NO servedBy/dataPolicy.
    const seam = vi.fn(async (baseDir: string): Promise<ReviewOutcome> => {
      const { computeTreeToken } = await import('../audit/content-token.js');
      return {
        verdict: 'pass',
        findingCount: 0,
        baseRef: 'refs/remotes/origin/main',
        headSha,
        contentToken: computeTreeToken(baseDir),
        durationSeconds: 1,
        model: 'gpt-5.4',
        reasoningEffort: 'high',
        findings: [],
        reviewText: '',
        eventCount: 0,
        // codex-fallback provenance — NO servedBy/dataPolicy:
        actualProviderId: 'codex',
        actualProviderVersion: 'codex-cli 9.9.9-int',
      };
    });
    const run = await runReviewCaptured({ executeOpenRouterReview: seam });
    expect(run.exitCode).toBe(0);
    const canonical = readAuditRecords().find((r) => r.tool_name === 'rea.local_review')!;
    const meta = canonical.metadata as Record<string, unknown>;
    // The record NAMES codex — the provider that really reviewed.
    expect(meta.provider).toBe('codex');
    expect(meta.provider_version).toBe('codex-cli 9.9.9-int');
    expect('served_by' in meta).toBe(false);
    // M1 (round-8): a codex-fallback record carries NO data-policy fields.
    expect('data_policy' in meta).toBe(false);
    expect('data_policy_requested' in meta).toBe(false);
    expect('data_policy_enforced' in meta).toBe(false);
    // The --json provider field matches.
    const jsonLine = run.stdout.split('\n').filter(Boolean).find((l) => l.startsWith('{'));
    const payload = JSON.parse(jsonLine!) as Record<string, unknown>;
    expect(payload.provider).toBe('codex');
  });

  it('openrouter SUCCESS → audit provider:openrouter + served_by; JSON matches', async () => {
    writePolicy('openrouter');
    const { headSha } = realTokens();
    const seam = vi.fn(async (baseDir: string): Promise<ReviewOutcome> => {
      const { computeTreeToken } = await import('../audit/content-token.js');
      return orOutcome({
        headSha,
        contentToken: computeTreeToken(baseDir),
        actualProviderId: 'openrouter',
        servedBy: 'fireworks',
      });
    });
    const run = await runReviewCaptured({ executeOpenRouterReview: seam });
    const canonical = readAuditRecords().find((r) => r.tool_name === 'rea.local_review')!;
    const meta = canonical.metadata as Record<string, unknown>;
    expect(meta.provider).toBe('openrouter');
    expect(meta.served_by).toBe('fireworks');
    const jsonLine = run.stdout.split('\n').filter(Boolean).find((l) => l.startsWith('{'));
    const payload = JSON.parse(jsonLine!) as Record<string, unknown>;
    expect(payload.provider).toBe('openrouter');
  });
});

describe('FIX C (codex round-3) — metrics.jsonl records the real exit status end-to-end', () => {
  /** Mirror selectProvider's production telemetry sink: maps row.exitCode →
   *  metrics.jsonl exit_code. We wire it onto the real OpenRouterProvider to
   *  prove a fallback writes a NON-ZERO exit_code (not the old hard-coded 0). */
  function readMetricsRows(): Array<Record<string, unknown>> {
    const p = metricsFilePath(tmpDir);
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('malformed transport response → metrics row exit_code != 0 (was hard-coded 0)', async () => {
    process.chdir(tmpDir);
    // A transport that always returns non-JSON content → malformed → repair
    // retry → still malformed → fall back to codex. The telemetry sink runs on
    // the post-transport failure path.
    const transport = {
      async post() {
        return {
          status: 200,
          json: { choices: [{ message: { content: 'not json at all' } }] },
          text: 'x',
        };
      },
    };
    const provider = OpenRouterProvider({
      env: { OPENROUTER_API_KEY: 'sk-or-test' },
      transport,
      sleep: async () => undefined,
      enumerate: () => ({ paths: ['app.ts'], errored: false }),
      codexFallback: async () => orOutcome({ actualProviderId: 'codex' }),
      // Map exactly as selectProvider does (exit_code from the real row).
      onTelemetry: async (row) => {
        await recordTelemetry(tmpDir, {
          invocation_type: 'review',
          input_text: '',
          output_text: '',
          duration_ms: row.durationMs,
          exit_code: row.exitCode,
          provider: 'openrouter',
          model: row.model,
          ...(row.fellBack ? { stderr: 'fell back to codex' } : {}),
        });
      },
    });
    await provider.execute(tmpDir, {});
    const rows = readMetricsRows();
    expect(rows.length).toBe(1);
    // The load-bearing assertion: a failed/fell-back attempt is NOT exit 0.
    expect(rows[0]!.exit_code).not.toBe(0);
    expect(rows[0]!.provider).toBe('openrouter');
  });
});

describe('AC-2 — last-review.json', () => {
  it('T-INT-03: concerns outcome writes schema-compatible last-review.json', async () => {
    writePolicy('openrouter');
    const { headSha } = realTokens();
    const seam = vi.fn(async (baseDir: string): Promise<ReviewOutcome> => {
      const { computeTreeToken } = await import('../audit/content-token.js');
      return orOutcome({
        verdict: 'concerns',
        findingCount: 1,
        headSha,
        contentToken: computeTreeToken(baseDir),
        findings: [{ severity: 'P2', title: 'x', body: 'y', file: 'app.ts', line: 2 }],
      });
    });
    await runReviewCaptured({ executeOpenRouterReview: seam });
    const lr = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.rea', 'last-review.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(lr.schema_version).toBe(1);
    expect(lr.verdict).toBe('concerns');
    expect(Array.isArray(lr.findings)).toBe(true);
    expect((lr.findings as unknown[]).length).toBe(1);
  });
});

describe('AC-9 — exit-code semantics unchanged (openrouter)', () => {
  const cases: Array<[ReviewOutcome['verdict'], 'concerns' | 'blocking', number]> = [
    ['pass', 'blocking', 0],
    ['concerns', 'blocking', 0],
    ['concerns', 'concerns', 1],
    ['blocking', 'blocking', 2],
  ];
  for (const [verdict, strictFailOn, expected] of cases) {
    it(`T-EXIT: ${verdict} + strictFailOn=${strictFailOn} → exit ${expected}`, async () => {
      writePolicy('openrouter');
      const { headSha } = realTokens();
      const seam = vi.fn(async (baseDir: string): Promise<ReviewOutcome> => {
        const { computeTreeToken } = await import('../audit/content-token.js');
        return orOutcome({ verdict, headSha, contentToken: computeTreeToken(baseDir) });
      });
      const run = await runReviewCaptured(
        { executeOpenRouterReview: seam },
        { json: true, strictFailOn },
      );
      expect(run.exitCode).toBe(expected);
    });
  }

  it('error verdict from the openrouter execute seam → exit 2', async () => {
    writePolicy('openrouter');
    // The seam throws → runReview audits an error record + exits 2.
    const seam = vi.fn(async (): Promise<ReviewOutcome> => {
      throw new Error('malformed model output');
    });
    const run = await runReviewCaptured({ executeOpenRouterReview: seam });
    expect(run.exitCode).toBe(2);
    const records = readAuditRecords();
    const err = records.find(
      (r) => r.tool_name === 'rea.local_review' && r.status === 'error',
    );
    expect(err).toBeDefined();
    expect((err!.metadata as Record<string, unknown>).provider).toBe('openrouter');
  });
});

describe('openrouter unavailable (no key) — enforced refuses, off skips', () => {
  it('enforced + provider unavailable → exit 2', async () => {
    writePolicy('openrouter');
    // No OPENROUTER_API_KEY in env → the real provider's isAvailable is false.
    // Use providerOverride to force an unavailable openrouter provider
    // deterministically (no dependence on ambient env).
    const run = await runReviewCaptured({
      providerOverride: {
        id: 'openrouter',
        isAvailable: async () => ({ available: false }),
        execute: async () => orOutcome(),
        classifyError: () => 'unavailable',
        unavailableMessage: () => ['OPENROUTER_API_KEY not set'],
      },
    });
    expect(run.exitCode).toBe(2);
    // codex P2: under --json the unavailable exit emits a structured payload so
    // automation can parse EVERY non-execution outcome from stdout.
    const jsonLine = run.stdout.split('\n').filter(Boolean).find((l) => l.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const payload = JSON.parse(jsonLine as string);
    expect(payload.status).toBe('error');
    expect(payload.provider).toBe('openrouter');
    expect(payload.reason).toBe('provider-unavailable');
    expect(payload.exit_code).toBe(2);
  });
});

describe('FIX H (codex round-4) — external refused + codex unavailable honors local_review.mode', () => {
  /** A provider whose `execute` throws the mode-deferred refused error — exactly
   *  what the real openrouter provider throws when the external lane refuses and
   *  codex is not installed. */
  function refusedOpenRouterProvider(): Parameters<typeof runReviewCaptured>[0] {
    return {
      providerOverride: {
        id: 'openrouter',
        isAvailable: async () => ({ available: true, version: 'openai/gpt-oss-120b' }),
        execute: async () => {
          throw new OpenRouterExternalRefusedError('path-guard', 'deadbeef', 'origin/main');
        },
        classifyError: () => 'external-refused-no-fallback',
        unavailableMessage: () => [],
      },
    };
  }

  it('mode: off + refused + codex absent → exit 0 + skipped_unavailable (NOT exit 2)', async () => {
    writePolicyWithMode('openrouter', 'off');
    const run = await runReviewCaptured(refusedOpenRouterProvider());
    // The documented opt-out: exit 0, NOT 2.
    expect(run.exitCode).toBe(0);
    const records = readAuditRecords();
    const skip = records.find(
      (r) => r.tool_name === 'rea.local_review.skipped_unavailable',
    );
    expect(skip).toBeDefined();
    expect((skip!.metadata as Record<string, unknown>).provider).toBe('openrouter');
    expect((skip!.metadata as Record<string, unknown>).reason).toBe(
      'openrouter-refused-and-codex-unavailable',
    );
    // NO canonical coverage-bearing record was written (it's a skip, not a pass).
    const canonical = records.find((r) => r.tool_name === 'rea.local_review');
    expect(canonical).toBeUndefined();
    // JSON surface advertises the skip + the refusal class (forensic).
    const jsonLine = run.stdout.split('\n').filter(Boolean).find((l) => l.startsWith('{'));
    const payload = JSON.parse(jsonLine!) as Record<string, unknown>;
    expect(payload.status).toBe('skipped');
    expect(payload.refusal_class).toBe('path-guard');
  });

  it('mode: off + OPERATIONAL failure (malformed) + codex absent → exit 2 ERROR, not a skip (codex round-2 P2)', async () => {
    writePolicyWithMode('openrouter', 'off');
    const run = await runReviewCaptured({
      providerOverride: {
        id: 'openrouter',
        isAvailable: async () => ({ available: true, version: 'openai/gpt-oss-120b' }),
        execute: async () => {
          // A REAL provider failure: the external lane was contacted and
          // returned malformed JSON twice; codex is absent → operational refusal.
          throw new OpenRouterExternalRefusedError('malformed', 'deadbeef', 'origin/main');
        },
        classifyError: (e: unknown) =>
          e instanceof OpenRouterExternalRefusedError ? e.refusalClass : 'unknown',
        unavailableMessage: () => [],
      },
    });
    // mode:off must NOT swallow a real provider failure — it surfaces as exit 2,
    // exactly like a codex execution failure does regardless of mode.
    expect(run.exitCode).toBe(2);
    const records = readAuditRecords();
    const errRec = records.find(
      (r) => r.tool_name === 'rea.local_review' && r.status === 'error',
    );
    expect(errRec).toBeDefined();
    expect((errRec!.metadata as Record<string, unknown>).kind).toBe('malformed');
    // It is NOT recorded as a benign skip.
    const skip = records.find((r) => r.tool_name === 'rea.local_review.skipped_unavailable');
    expect(skip).toBeUndefined();
  });

  it('mode: enforced + refused + codex absent → exit 2 (error record)', async () => {
    writePolicyWithMode('openrouter', 'enforced');
    const run = await runReviewCaptured(refusedOpenRouterProvider());
    expect(run.exitCode).toBe(2);
    const records = readAuditRecords();
    // Under enforced mode it is an ERROR (not a skip).
    const errRec = records.find(
      (r) => r.tool_name === 'rea.local_review' && r.status === 'error',
    );
    expect(errRec).toBeDefined();
    const skip = records.find((r) => r.tool_name === 'rea.local_review.skipped_unavailable');
    expect(skip).toBeUndefined();
  });

  it('codex AVAILABLE + refused → codex fallback runs (exit per codex verdict), mode irrelevant', async () => {
    // When codex is available, the real provider runs the codex fallback and
    // returns a normal outcome (never throws OpenRouterExternalRefusedError).
    // Model this with a providerOverride whose execute returns a codex-stamped
    // pass outcome (what the real fallback produces).
    writePolicyWithMode('openrouter', 'off');
    const { headSha } = realTokens();
    const run = await runReviewCaptured({
      providerOverride: {
        id: 'openrouter',
        isAvailable: async () => ({ available: true, version: 'openai/gpt-oss-120b' }),
        execute: async (baseDir: string) => {
          const { computeTreeToken } = await import('../audit/content-token.js');
          return orOutcome({
            headSha,
            contentToken: computeTreeToken(baseDir),
            actualProviderId: 'codex',
            actualProviderVersion: 'codex-cli 1.0.0',
          });
        },
        classifyError: () => 'unknown',
        unavailableMessage: () => [],
      },
    });
    // codex pass → exit 0, and a canonical record naming codex was written.
    expect(run.exitCode).toBe(0);
    const canonical = readAuditRecords().find((r) => r.tool_name === 'rea.local_review')!;
    expect((canonical.metadata as Record<string, unknown>).provider).toBe('codex');
  });
});

describe('FIX J (codex round-5) — a model pass with a P1 finding is recorded as BLOCKING', () => {
  /** A transport that returns a chat/completions body whose content is the
   *  given verdict/findings JSON. */
  function verdictTransport(verdict: string, findings: unknown[]): OpenRouterTransport {
    const body = {
      provider: 'fireworks',
      choices: [{ message: { content: JSON.stringify({ verdict, findings }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    return {
      async post(): Promise<TransportResponse> {
        return { status: 200, json: body, text: JSON.stringify(body) };
      },
    };
  }

  it('end-to-end: {verdict:pass, findings:[P1]} → exit 2, BLOCKING record, preflight REFUSES coverage', async () => {
    writePolicy('openrouter');
    const { headSha } = realTokens();
    // Drive runReview with a seam that calls the REAL executeOpenRouterReview
    // (so the adapter's verdict reconciliation runs) against a mock transport
    // that returns the mismatched pass+P1 body.
    const seam = async (baseDir: string): Promise<ReviewOutcome> =>
      executeOpenRouterReview(baseDir, {}, {
        transport: verdictTransport('pass', [
          { severity: 'P1', title: 'sql injection', body: 'unsanitized', file: 'app.ts', line: 2 },
        ]),
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
        sleep: async () => undefined,
        enumerate: () => ({ paths: ['app.ts'], errored: false }),
      });
    void headSha;
    const run = await runReviewCaptured({ executeOpenRouterReview: seam });
    // Findings win: blocking → exit 2, NOT a silent pass.
    expect(run.exitCode).toBe(2);
    const canonical = readAuditRecords().find((r) => r.tool_name === 'rea.local_review')!;
    const meta = canonical.metadata as Record<string, unknown>;
    expect(meta.verdict).toBe('blocking');
    expect(meta.provider).toBe('openrouter');
    // status denied (blocking) — NOT allowed.
    expect(canonical.status).toBe('denied');
    // The --json surface reports blocking.
    const jsonLine = run.stdout.split('\n').filter(Boolean).find((l) => l.startsWith('{'));
    const payload = JSON.parse(jsonLine!) as Record<string, unknown>;
    expect(payload.status).toBe('blocking');

    // Preflight does NOT accept this as coverage (a blocking/denied review is
    // not coverage — proves the mismatched pass cannot launder into coverage).
    invalidatePolicyCache(tmpDir);
    const pf = await computePreflight(tmpDir, {});
    expect(pf.outcome.status).toBe('refuse');
  });

  it('end-to-end: {verdict:pass, findings:[]} → exit 0, pass record, preflight CLEAN', async () => {
    writePolicy('openrouter');
    const seam = async (baseDir: string): Promise<ReviewOutcome> =>
      executeOpenRouterReview(baseDir, {}, {
        transport: verdictTransport('pass', []),
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
        sleep: async () => undefined,
        enumerate: () => ({ paths: ['app.ts'], errored: false }),
      });
    const run = await runReviewCaptured({ executeOpenRouterReview: seam });
    expect(run.exitCode).toBe(0);
    const canonical = readAuditRecords().find((r) => r.tool_name === 'rea.local_review')!;
    expect((canonical.metadata as Record<string, unknown>).verdict).toBe('pass');
    invalidatePolicyCache(tmpDir);
    const pf = await computePreflight(tmpDir, {});
    expect(pf.outcome.status).toBe('clean');
  });
});

describe('STRUCTURAL FIX 1 (round-6) — model secrets are redacted before reaching audit + last-review', () => {
  it('a secret quoted in a model finding body is REDACTED in audit metadata + .rea/last-review.json', async () => {
    writePolicy('openrouter');
    // Runtime-built AWS-key-shaped secret so neither the test source nor the
    // fixture ever contains a literal key (secret-scanner hook).
    const plantedSecret = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
    const body = {
      provider: 'fireworks',
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: 'concerns',
              findings: [
                { severity: 'P2', title: 'leaked key', body: `code echoes ${plantedSecret}` },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const transport = {
      async post(): Promise<TransportResponse> {
        return { status: 200, json: body, text: JSON.stringify(body) };
      },
    };
    const seam = async (baseDir: string): Promise<ReviewOutcome> =>
      executeOpenRouterReview(baseDir, {}, {
        transport,
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
        sleep: async () => undefined,
        enumerate: () => ({ paths: ['app.ts'], errored: false }),
      });
    await runReviewCaptured({ executeOpenRouterReview: seam });

    // The hash-chained audit + last-review.json must NOT contain the secret.
    const auditRaw = fs.readFileSync(path.join(tmpDir, '.rea', 'audit.jsonl'), 'utf8');
    expect(auditRaw).not.toContain(plantedSecret);
    const lr = fs.readFileSync(path.join(tmpDir, '.rea', 'last-review.json'), 'utf8');
    expect(lr).not.toContain(plantedSecret);
    expect(lr).toContain('[REDACTED]');
  });

  it('a forged served_by with a control char is sanitized in the audit record (never verbatim)', async () => {
    writePolicy('openrouter');
    const NUL = String.fromCharCode(0);
    const body = {
      // Round-11: a NUL makes served_by invalid/undeterminable → extractServedBy
      // DROPS it (returns undefined). It is NOT sanitized to `fireworks` — that
      // laundered a forged ID into a clean value that would pass a backend_pin.
      provider: `fire${NUL}works`,
      choices: [{ message: { content: JSON.stringify({ verdict: 'pass', findings: [] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const transport = {
      async post(): Promise<TransportResponse> {
        return { status: 200, json: body, text: JSON.stringify(body) };
      },
    };
    const seam = async (baseDir: string): Promise<ReviewOutcome> =>
      executeOpenRouterReview(baseDir, {}, {
        transport,
        env: { OPENROUTER_API_KEY: 'sk-or-test' },
        sleep: async () => undefined,
        enumerate: () => ({ paths: ['app.ts'], errored: false }),
      });
    await runReviewCaptured({ executeOpenRouterReview: seam });
    const canonical = readAuditRecords().find((r) => r.tool_name === 'rea.local_review')!;
    const meta = canonical.metadata as Record<string, unknown>;
    expect(meta.served_by).toBeUndefined(); // round-11: forged control-char ID OMITTED (not laundered)
    // No NUL byte landed in the serialized audit record.
    const auditRaw = fs.readFileSync(path.join(tmpDir, '.rea', 'audit.jsonl'), 'utf8');
    expect(auditRaw.includes(NUL)).toBe(false);
  });
});
