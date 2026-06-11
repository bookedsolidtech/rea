/**
 * PART A — commit-aware review (0.50.x).
 *
 * `gpt-oss-120b` rejects a >~350KB diff BEFORE inference, so when the whole
 * diff won't fit one context window we review PER COMMIT (each commit a
 * coherent unit) and merge. These tests cover:
 *   - enumerateReviewUnits (commits oldest→newest + trailing working-tree)
 *   - mergeUnitAttempts (verdict = max severity, findings union + cap)
 *   - per-commit e2e through the mocked transport (multiple units → multiple
 *     sends → ONE merged outcome)
 *   - fail-closed on an over-budget unit and on a malformed unit
 *   - `whole` granularity is byte-identical (one send)
 *
 * NO test performs a real outbound request — the transport is injected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeOpenRouterReview,
  enumerateReviewUnits,
  mergeUnitAttempts,
  OPENROUTER_CONTEXT_BUDGET_BYTES,
  OpenRouterExternalRefusedError,
  type OpenRouterTransport,
  type TransportResponse,
} from './review-openrouter.js';
import { realChangedPaths, realPerCommitChangedPaths } from './review-pathguard.js';
import { EMPTY_TREE_SHA } from '../audit/content-token.js';
import type { Finding } from '../hooks/push-gate/findings.js';
import type { ParsedReview } from './review-openrouter.js';

let tmpDir: string;
let prevCwd: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const env = { OPENROUTER_API_KEY: 'sk-or-test-sentinel' };
const noSleep = async (): Promise<void> => undefined;

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

/**
 * A transport that returns a DISTINCT canned response per call (in order),
 * falling back to the last when calls exceed the array — so a per-commit run
 * with N units can be given N distinct responses.
 */
function sequenceTransport(responses: TransportResponse[]): {
  transport: OpenRouterTransport;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const transport: OpenRouterTransport = {
    async post(url, body) {
      calls.push({ url, body });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r as TransportResponse;
    },
  };
  return { transport, calls };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-or-ca-'));
  prevCwd = process.cwd();
  git(['init', '-q'], tmpDir);
  git(['config', 'user.email', 'ca@test.test'], tmpDir);
  git(['config', 'user.name', 'CA'], tmpDir);
  git(['config', 'commit.gpgsign', 'false'], tmpDir);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Make N commits, each touching a distinct file, on top of a baseline. */
function makeCommits(n: number): void {
  fs.writeFileSync(path.join(tmpDir, 'base.ts'), 'export const base = 1;\n');
  git(['add', 'base.ts'], tmpDir);
  git(['commit', '-qm', 'baseline'], tmpDir);
  for (let i = 1; i <= n; i += 1) {
    fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), `export const v${i} = ${i};\n`);
    git(['add', `f${i}.ts`], tmpDir);
    git(['commit', '-qm', `commit ${i}`], tmpDir);
  }
}

// ---------------------------------------------------------------------------
// enumerateReviewUnits
// ---------------------------------------------------------------------------

describe('enumerateReviewUnits', () => {
  it('lists commits oldest→newest, each carrying its OWN patch, labelled by sha+subject', () => {
    makeCommits(3);
    const base = execFileSync('git', ['rev-parse', 'HEAD~3'], { cwd: tmpDir }).toString().trim();
    const units = enumerateReviewUnits(tmpDir, base);
    expect(units.length).toBe(3);
    // Oldest first.
    expect(units[0]!.label).toMatch(/^commit [0-9a-f]{7}: commit 1$/);
    expect(units[1]!.label).toMatch(/: commit 2$/);
    expect(units[2]!.label).toMatch(/: commit 3$/);
    // Each unit's diff contains ONLY that commit's file (within-commit scope).
    expect(units[0]!.diff).toContain('f1.ts');
    expect(units[0]!.diff).not.toContain('f2.ts');
    expect(units[2]!.diff).toContain('f3.ts');
    expect(units[2]!.diff).not.toContain('f1.ts');
  });

  it('appends a trailing working-tree unit when uncommitted tracked changes exist', () => {
    makeCommits(2);
    const base = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: tmpDir }).toString().trim();
    // Modify a tracked file without committing.
    fs.appendFileSync(path.join(tmpDir, 'base.ts'), 'export const extra = 2;\n');
    const units = enumerateReviewUnits(tmpDir, base);
    expect(units.length).toBe(3); // 2 commits + working-tree
    expect(units[2]!.label).toBe('working-tree');
    expect(units[2]!.diff).toContain('base.ts');
    expect(units[2]!.diff).toContain('extra');
  });

  it('does NOT append a working-tree unit when the tree is clean', () => {
    makeCommits(2);
    const base = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: tmpDir }).toString().trim();
    const units = enumerateReviewUnits(tmpDir, base);
    expect(units.every((u) => u.label !== 'working-tree')).toBe(true);
  });

  it('union of all unit paths equals the whole-diff changed-path set (invariant)', () => {
    makeCommits(3);
    const base = execFileSync('git', ['rev-parse', 'HEAD~3'], { cwd: tmpDir }).toString().trim();
    fs.appendFileSync(path.join(tmpDir, 'base.ts'), 'export const extra = 9;\n');
    const units = enumerateReviewUnits(tmpDir, base);
    // The whole-diff changed-path set from git plumbing (committed ∪ working).
    const committed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: tmpDir,
    })
      .toString()
      .split('\n')
      .filter(Boolean);
    const working = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: tmpDir })
      .toString()
      .split('\n')
      .filter(Boolean);
    const wholeSet = new Set([...committed, ...working]);
    // Extract changed paths from each unit's patch headers (`+++ b/<path>`).
    const unitSet = new Set<string>();
    for (const u of units) {
      for (const m of u.diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) unitSet.add(m[1]!);
    }
    expect([...unitSet].sort()).toEqual([...wholeSet].sort());
  });

  it('handles a root commit (no parent) by diffing against the empty tree', () => {
    // A single root commit, reviewed from the empty-tree base.
    fs.writeFileSync(path.join(tmpDir, 'root.ts'), 'export const root = 1;\n');
    git(['add', 'root.ts'], tmpDir);
    git(['commit', '-qm', 'root commit'], tmpDir);
    const units = enumerateReviewUnits(tmpDir, EMPTY_TREE_SHA);
    expect(units.length).toBe(1);
    expect(units[0]!.label).toMatch(/: root commit$/);
    expect(units[0]!.diff).toContain('root.ts');
  });
});

// ---------------------------------------------------------------------------
// realPerCommitChangedPaths — codex round-13 P1 (the per-commit sent-path union)
// ---------------------------------------------------------------------------

describe('realPerCommitChangedPaths (codex round-13 P1)', () => {
  it('includes a file added in commit A and REVERTED in commit B — absent from the NET diff', () => {
    // base → A (adds secret.env) → B (removes secret.env) → HEAD.
    fs.writeFileSync(path.join(tmpDir, 'base.ts'), 'export const base = 1;\n');
    git(['add', 'base.ts'], tmpDir);
    git(['commit', '-qm', 'baseline'], tmpDir);
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir }).toString().trim();
    fs.writeFileSync(path.join(tmpDir, 'secret.env'), 'TOKEN=abc\n');
    git(['add', 'secret.env'], tmpDir);
    git(['commit', '-qm', 'A: add secret.env'], tmpDir);
    git(['rm', '-q', 'secret.env'], tmpDir);
    git(['commit', '-qm', 'B: remove secret.env'], tmpDir);

    // The NET diff (base...HEAD) does NOT mention secret.env (added then removed).
    const net = realChangedPaths(tmpDir, base);
    expect(net.errored).toBe(false);
    expect(net.paths).not.toContain('secret.env');

    // But the PER-COMMIT union DOES — it is in commit A's patch, which
    // per-commit mode would send. This is exactly the guard gap codex caught.
    const union = realPerCommitChangedPaths(tmpDir, base);
    expect(union.errored).toBe(false);
    expect(union.paths).toContain('secret.env');
  });

  it('codex round-14 P1: enumerates ALL committed paths when base is the EMPTY_TREE_SHA (no fail-open)', () => {
    fs.writeFileSync(path.join(tmpDir, 'base.ts'), 'export const base = 1;\n');
    git(['add', 'base.ts'], tmpDir);
    git(['commit', '-qm', 'baseline'], tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.rea', 'committed-gov.yaml'), 'x: 1\n');
    git(['add', '.rea/committed-gov.yaml'], tmpDir);
    git(['commit', '-qm', 'add committed governance file'], tmpDir);

    // With base = empty-tree (new repo / no upstream), `enumerateReviewUnits`
    // uploads every commit over `<empty-tree>..HEAD`. The guard MUST enumerate
    // the same set — including the committed `.rea/` path — or it fails OPEN.
    const union = realPerCommitChangedPaths(tmpDir, EMPTY_TREE_SHA);
    expect(union.errored).toBe(false);
    expect(union.paths).toContain('.rea/committed-gov.yaml');
    expect(union.paths).toContain('base.ts');
  });
});

// ---------------------------------------------------------------------------
// mergeUnitAttempts
// ---------------------------------------------------------------------------

function parsed(verdict: ParsedReview['verdict'], findings: Finding[], truncated = false): ParsedReview {
  return { verdict, findings, truncated };
}

describe('mergeUnitAttempts', () => {
  it('verdict = MAX severity over units (pass < concerns < blocking)', () => {
    const merged = mergeUnitAttempts(
      [
        { parsed: parsed('pass', []), usage: {} },
        { parsed: parsed('blocking', [{ severity: 'P1', title: 'x', body: 'y' }]), usage: {} },
        { parsed: parsed('concerns', [{ severity: 'P2', title: 'a', body: 'b' }]), usage: {} },
      ],
      false,
    );
    expect(merged.parsed.verdict).toBe('blocking');
  });

  it('findings = union of all units', () => {
    const merged = mergeUnitAttempts(
      [
        { parsed: parsed('concerns', [{ severity: 'P2', title: 'a', body: 'b' }]), usage: {} },
        { parsed: parsed('concerns', [{ severity: 'P2', title: 'c', body: 'd' }]), usage: {} },
      ],
      false,
    );
    expect(merged.parsed.findings.map((f) => f.title)).toEqual(['a', 'c']);
  });

  it('caps the union at MAX_FINDINGS and flags truncated', () => {
    const big: Finding[] = Array.from({ length: 40 }, (_, i) => ({
      severity: 'P3' as const,
      title: `t${i}`,
      body: 'b',
    }));
    const merged = mergeUnitAttempts(
      [
        { parsed: parsed('concerns', big), usage: {} },
        { parsed: parsed('concerns', big), usage: {} },
      ],
      false,
    );
    // 80 findings → capped at 50.
    expect(merged.parsed.findings.length).toBe(50);
    expect(merged.parsed.truncated).toBe(true);
  });

  it('propagates a unit-level truncation flag even when under the union cap', () => {
    const merged = mergeUnitAttempts(
      [{ parsed: parsed('pass', [], true), usage: {} }],
      false,
    );
    expect(merged.parsed.truncated).toBe(true);
  });

  it('codex round-11 P2: when capping, KEEPS the high-severity findings (P1/P2), drops P3s', () => {
    // First unit: 50 P3 noise findings. LAST unit: the P1 that drove the
    // blocking verdict. In unit order the P1 would be dropped by a naive cap —
    // the severity-aware cap must preserve it.
    const noise: Finding[] = Array.from({ length: 50 }, (_, i) => ({
      severity: 'P3' as const,
      title: `noise${i}`,
      body: 'b',
    }));
    const merged = mergeUnitAttempts(
      [
        { parsed: parsed('concerns', noise), usage: {} },
        { parsed: parsed('blocking', [{ severity: 'P1', title: 'CRITICAL', body: 'the real bug' }]), usage: {} },
      ],
      false,
    );
    expect(merged.parsed.findings.length).toBe(50);
    expect(merged.parsed.truncated).toBe(true);
    // The verdict is blocking (max over units) — the P1 that caused it MUST be present.
    expect(merged.parsed.verdict).toBe('blocking');
    const titles = merged.parsed.findings.map((f) => f.title);
    expect(titles).toContain('CRITICAL');
    // And the highest-severity finding sorts first.
    expect(merged.parsed.findings[0]?.severity).toBe('P1');
  });

  it('sums input/output usage and takes the first served_by', () => {
    const merged = mergeUnitAttempts(
      [
        { parsed: parsed('pass', []), usage: { input: 100, output: 10 }, servedBy: 'fireworks' },
        { parsed: parsed('pass', []), usage: { input: 200, output: 20 }, servedBy: 'deepinfra' },
      ],
      true,
    );
    expect(merged.usage).toEqual({ input: 300, output: 30 });
    expect(merged.servedBy).toBe('fireworks');
    expect(merged.rateLimited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// per-commit e2e through the executor
// ---------------------------------------------------------------------------

function policyWith(granularity: string, extra: string[] = []): void {
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
      '  provider: openrouter',
      '  providers:',
      '    openrouter:',
      `      review_granularity: ${granularity}`,
      ...extra,
      '',
    ].join('\n'),
  );
}

/** Enumerator returning ALL changed paths in `base...HEAD` so the guard sends. */
function enumFrom(base: string) {
  return () => ({
    paths: execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: tmpDir })
      .toString()
      .split('\n')
      .filter(Boolean),
    errored: false,
  });
}

describe('per-commit e2e (multiple units → multiple sends → one merged outcome)', () => {
  it('per-commit: 3 commits → 3 sends → merged verdict=max, findings union', async () => {
    makeCommits(3);
    policyWith('per-commit');
    const base = execFileSync('git', ['rev-parse', 'HEAD~3'], { cwd: tmpDir }).toString().trim();
    process.chdir(tmpDir);
    const { transport, calls } = sequenceTransport([
      reviewResponse('pass', [], { usage: { prompt_tokens: 100, completion_tokens: 10 } }),
      reviewResponse('concerns', [{ severity: 'P2', title: 'p2-c2', body: 'b' }], {
        usage: { prompt_tokens: 200, completion_tokens: 20 },
      }),
      reviewResponse('blocking', [{ severity: 'P1', title: 'p1-c3', body: 'b' }], {
        usage: { prompt_tokens: 300, completion_tokens: 30 },
      }),
    ]);
    const outcome = await executeOpenRouterReview(tmpDir, { base }, {
      transport,
      env,
      sleep: noSleep,
      enumerate: enumFrom(base),
    });
    // 3 commits → 3 sends.
    expect(calls.length).toBe(3);
    // Merged verdict = max severity (blocking from commit 3).
    expect(outcome.verdict).toBe('blocking');
    // Findings union (P2 + P1).
    expect(outcome.findingCount).toBe(2);
    expect(outcome.findings.map((f) => f.title).sort()).toEqual(['p1-c3', 'p2-c2']);
    // ONE merged outcome — openrouter served, actualProviderId openrouter.
    expect(outcome.actualProviderId).toBe('openrouter');
    expect(outcome.model).toBe('openai/gpt-oss-120b');
  });

  it('codex round-13 P1: per-commit guard REFUSES when a UNIT path is blocked, even if the NET diff is clean', async () => {
    makeCommits(2); // net diff: clean src files
    policyWith('per-commit');
    const base = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: tmpDir }).toString().trim();
    process.chdir(tmpDir);
    const { transport, calls } = sequenceTransport([reviewResponse('pass', [])]);
    let thrown: unknown;
    try {
      await executeOpenRouterReview(tmpDir, { base }, {
        transport,
        env,
        sleep: noSleep,
        enumerate: enumFrom(base), // NET diff → clean (whole-diff guard would pass)
        // PER-COMMIT union contains a GOVERNANCE path absent from the net diff
        // (e.g. a `.claude/settings.json` reverted before HEAD). The always-on
        // governance refuse-set means the per-commit guard MUST refuse.
        enumeratePerCommit: () => ({ paths: ['.claude/settings.json'], errored: false }),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OpenRouterExternalRefusedError);
    expect((thrown as OpenRouterExternalRefusedError).refusalClass).toBe('path-guard');
    // Refused BEFORE any unit was sent off-machine.
    expect(calls.length).toBe(0);
  });

  it('per-commit: a single all-pass commit set → merged pass', async () => {
    makeCommits(2);
    policyWith('per-commit');
    const base = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: tmpDir }).toString().trim();
    process.chdir(tmpDir);
    const { transport, calls } = sequenceTransport([reviewResponse('pass', [])]);
    const outcome = await executeOpenRouterReview(tmpDir, { base }, {
      transport,
      env,
      sleep: noSleep,
      enumerate: enumFrom(base),
    });
    expect(calls.length).toBe(2);
    expect(outcome.verdict).toBe('pass');
    expect(outcome.findingCount).toBe(0);
  });

  it('FAIL-CLOSED: a malformed unit (after repair) escalates the WHOLE review to codex', async () => {
    makeCommits(2);
    policyWith('per-commit');
    const base = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: tmpDir }).toString().trim();
    process.chdir(tmpDir);
    // First unit ok; second unit malformed twice (so repair fails) → escalate.
    const bad: TransportResponse = {
      status: 200,
      json: { choices: [{ message: { content: 'not json <<<' } }] },
      text: 'x',
    };
    const { transport } = sequenceTransport([reviewResponse('pass', []), bad, bad]);
    let thrown: unknown;
    try {
      await executeOpenRouterReview(tmpDir, { base }, {
        transport,
        env,
        sleep: noSleep,
        // No codexFallback wired → mode-deferred refusal type (never a pass).
        enumerate: enumFrom(base),
      });
    } catch (e) {
      thrown = e;
    }
    // FAIL-CLOSED: a non-ok unit escalates exactly like the whole-diff failure.
    expect(thrown).toBeInstanceOf(OpenRouterExternalRefusedError);
    expect((thrown as OpenRouterExternalRefusedError).refusalClass).toBe('malformed');
  });

  it('FAIL-CLOSED: a single over-context-budget unit escalates to codex; never sends it', async () => {
    // baseline → small commit → a commit whose OWN patch exceeds the context
    // budget. max_diff_bytes is left at the 1.5MB default so the WHOLE-diff cap
    // does NOT fire first — the per-UNIT context-budget guard is what trips,
    // proving an over-budget unit is never sent.
    fs.writeFileSync(path.join(tmpDir, 'base.ts'), 'export const base = 1;\n');
    git(['add', 'base.ts'], tmpDir);
    git(['commit', '-qm', 'baseline'], tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'small.ts'), 'export const s = 1;\n');
    git(['add', 'small.ts'], tmpDir);
    git(['commit', '-qm', 'small'], tmpDir);
    // A file just over the per-request context budget (no redactable content).
    fs.writeFileSync(
      path.join(tmpDir, 'big.ts'),
      'x'.repeat(OPENROUTER_CONTEXT_BUDGET_BYTES + 1024) + '\n',
    );
    git(['add', 'big.ts'], tmpDir);
    git(['commit', '-qm', 'big'], tmpDir);
    // max_diff_bytes large enough that the whole-diff cap is NOT the trigger.
    policyWith('per-commit', ['      max_diff_bytes: 5000000']);
    const base = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: tmpDir }).toString().trim();
    process.chdir(tmpDir);
    // First unit small → ok; the big unit must NOT be sent (over budget).
    const { transport, calls } = sequenceTransport([reviewResponse('pass', [])]);
    let thrown: unknown;
    try {
      await executeOpenRouterReview(tmpDir, { base }, {
        transport,
        env,
        sleep: noSleep,
        enumerate: enumFrom(base),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OpenRouterExternalRefusedError);
    expect((thrown as OpenRouterExternalRefusedError).refusalClass).toBe('diff-too-large');
    // The big unit was NEVER sent — only the small unit's send happened.
    expect(calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// auto granularity — budget threshold drives whole vs per-commit
// ---------------------------------------------------------------------------

describe('auto granularity — context budget threshold', () => {
  it('auto + small diff (under budget) → ONE send (whole path)', async () => {
    makeCommits(2);
    policyWith('auto');
    const base = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: tmpDir }).toString().trim();
    process.chdir(tmpDir);
    const { transport, calls } = sequenceTransport([reviewResponse('pass', [])]);
    const outcome = await executeOpenRouterReview(tmpDir, { base }, {
      transport,
      env,
      sleep: noSleep,
      enumerate: enumFrom(base),
    });
    // Small diff fits the budget → whole path → exactly ONE send.
    expect(calls.length).toBe(1);
    expect(outcome.verdict).toBe('pass');
  });

  /** Build a 2-commit branch whose COMBINED diff exceeds the context budget but
   *  whose individual commits each fit. Returns the base ref (HEAD~2). */
  function makeOverBudgetTwoCommits(): string {
    fs.writeFileSync(path.join(tmpDir, 'base.ts'), 'export const base = 1;\n');
    git(['add', 'base.ts'], tmpDir);
    git(['commit', '-qm', 'baseline'], tmpDir);
    const half = Math.floor(OPENROUTER_CONTEXT_BUDGET_BYTES * 0.7);
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'a'.repeat(half) + '\n');
    git(['add', 'a.ts'], tmpDir);
    git(['commit', '-qm', 'commit a'], tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'b'.repeat(half) + '\n');
    git(['add', 'b.ts'], tmpDir);
    git(['commit', '-qm', 'commit b'], tmpDir);
    return execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: tmpDir }).toString().trim();
  }

  it('codex round-11 P1: auto + over-budget NET diff → ESCALATES TO CODEX (not per-commit), NO openrouter send', async () => {
    const base = makeOverBudgetTwoCommits();
    policyWith('auto', ['      max_diff_bytes: 1500000']);
    process.chdir(tmpDir);
    const { transport, calls } = sequenceTransport([reviewResponse('pass', [])]);
    let thrown: unknown;
    try {
      await executeOpenRouterReview(tmpDir, { base }, {
        transport,
        env,
        sleep: noSleep,
        enumerate: enumFrom(base),
      });
    } catch (e) {
      thrown = e;
    }
    // auto must NOT silently adopt per-commit semantics as a gate substitute —
    // an over-budget NET diff goes to codex with correct net-diff semantics.
    expect(thrown).toBeInstanceOf(OpenRouterExternalRefusedError);
    expect((thrown as OpenRouterExternalRefusedError).refusalClass).toBe('diff-too-large');
    // The escalation is decided BEFORE any unit send — zero openrouter calls.
    expect(calls.length).toBe(0);
  });

  it('explicit per-commit + over-budget combined diff → per-commit (multiple sends, merged)', async () => {
    const base = makeOverBudgetTwoCommits();
    // EXPLICIT per-commit is the opt-in practice — it DOES chunk the over-budget
    // combined diff into per-commit units (with documented per-commit semantics).
    policyWith('per-commit', ['      max_diff_bytes: 1500000']);
    process.chdir(tmpDir);
    const { transport, calls } = sequenceTransport([
      reviewResponse('pass', []),
      reviewResponse('concerns', [{ severity: 'P2', title: 'x', body: 'y' }]),
    ]);
    const outcome = await executeOpenRouterReview(tmpDir, { base }, {
      transport,
      env,
      sleep: noSleep,
      enumerate: enumFrom(base),
    });
    expect(calls.length).toBe(2);
    expect(outcome.verdict).toBe('concerns');
  });

  it('codex round-16 P1: per-commit + whole diff OVER max_diff_bytes but each commit FITS → per-commit, NOT codex', async () => {
    // 3 commits, each adding a ~400-byte file. The WHOLE diff exceeds the small
    // max_diff_bytes, but each commit's unit is well under it. The whole-diff cap
    // must NOT short-circuit per-commit to codex — that would make per-commit
    // unusable for the large multi-commit branches it exists to handle.
    fs.writeFileSync(path.join(tmpDir, 'base.ts'), 'export const base = 1;\n');
    git(['add', 'base.ts'], tmpDir);
    git(['commit', '-qm', 'baseline'], tmpDir);
    for (let i = 1; i <= 3; i += 1) {
      fs.writeFileSync(
        path.join(tmpDir, `f${i}.ts`),
        `// ${'x'.repeat(400)}\nexport const v${i} = ${i};\n`,
      );
      git(['add', `f${i}.ts`], tmpDir);
      git(['commit', '-qm', `commit ${i}`], tmpDir);
    }
    policyWith('per-commit', ['      max_diff_bytes: 800']);
    const base = execFileSync('git', ['rev-parse', 'HEAD~3'], { cwd: tmpDir }).toString().trim();
    process.chdir(tmpDir);
    const { transport, calls } = sequenceTransport([
      reviewResponse('pass', []),
      reviewResponse('pass', []),
      reviewResponse('pass', []),
    ]);
    const outcome = await executeOpenRouterReview(tmpDir, { base }, {
      transport,
      env,
      sleep: noSleep,
      enumerate: enumFrom(base),
    });
    // 3 per-commit sends — the whole-diff cap did NOT force a codex fallback.
    expect(calls.length).toBe(3);
    expect(outcome.verdict).toBe('pass');
  });
});
