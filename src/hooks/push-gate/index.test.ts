import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PUSH_GATE_DEFAULT_AUTO_NARROW_THRESHOLD,
  PUSH_GATE_DEFAULT_CODEX_REQUIRED,
  PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
  PUSH_GATE_DEFAULT_TIMEOUT_MS,
} from './policy.js';
import { parsePrePushStdin, runPushGate, type PushGateDeps } from './index.js';
import type { GitExecutor } from './codex-runner.js';

function fakeGit(overrides: Partial<GitExecutor> = {}): GitExecutor {
  return {
    tryRevParse: () => '',
    trySymbolicRef: () => '',
    headSha: () => 'deadbeef1234567890abcdef1234567890abcdef',
    diffNames: () => ['src/changed.ts'],
    revListCount: () => null,
    ...overrides,
  };
}

const DEFAULT_POLICY = {
  codex_required: PUSH_GATE_DEFAULT_CODEX_REQUIRED,
  concerns_blocks: PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
  timeout_ms: PUSH_GATE_DEFAULT_TIMEOUT_MS,
  last_n_commits: undefined,
  auto_narrow_threshold: PUSH_GATE_DEFAULT_AUTO_NARROW_THRESHOLD,
  policyMissing: false,
};

function baseDeps(baseDir: string, overrides: Partial<PushGateDeps> = {}): PushGateDeps {
  return {
    baseDir,
    env: {},
    stderr: () => undefined,
    git: fakeGit(),
    readHalt: () => ({ halted: false }),
    resolvePolicy: async () => DEFAULT_POLICY,
    runCodex: async () => ({
      reviewText: 'No issues.',
      eventCount: 3,
      durationSeconds: 1.2,
    }),
    appendAudit: async () =>
      ({
        timestamp: new Date().toISOString(),
        session_id: 'test',
        tool_name: 'rea.push_gate.reviewed',
        server_name: 'rea',
        tier: 'read',
        status: 'allowed',
        autonomy_level: 'L1',
        duration_ms: 0,
        prev_hash: '',
        emission_source: 'other',
        hash: 'x',
      }) as unknown as Awaited<ReturnType<PushGateDeps['appendAudit'] & {}>>,
    ...overrides,
  };
}

describe('runPushGate — HALT kill-switch', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-halt-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('returns exitCode 1 when HALT is active, before any other work', async () => {
    let codexInvoked = false;
    const result = await runPushGate(
      baseDeps(baseDir, {
        readHalt: () => ({ halted: true, reason: 'audit freeze' }),
        runCodex: async () => {
          codexInvoked = true;
          return { reviewText: '', eventCount: 0, durationSeconds: 0 };
        },
      }),
    );
    expect(result.status).toBe('halted');
    expect(result.exitCode).toBe(1);
    expect(codexInvoked).toBe(false);
  });
});

describe('runPushGate — codex_required: false', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-dis-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('short-circuits with exitCode 0 and status=disabled', async () => {
    let codexInvoked = false;
    const result = await runPushGate(
      baseDeps(baseDir, {
        resolvePolicy: async () => ({ ...DEFAULT_POLICY, codex_required: false }),
        runCodex: async () => {
          codexInvoked = true;
          return { reviewText: '', eventCount: 0, durationSeconds: 0 };
        },
      }),
    );
    expect(result.status).toBe('disabled');
    expect(result.exitCode).toBe(0);
    expect(codexInvoked).toBe(false);
  });
});

describe('runPushGate — REA_SKIP_PUSH_GATE waiver', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-skip-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('skips gate when the env var is set with a non-empty value', async () => {
    let codexInvoked = false;
    const result = await runPushGate(
      baseDeps(baseDir, {
        env: { REA_SKIP_PUSH_GATE: 'urgent hotfix — tracked in #1234' },
        runCodex: async () => {
          codexInvoked = true;
          return { reviewText: '', eventCount: 0, durationSeconds: 0 };
        },
      }),
    );
    expect(result.status).toBe('skipped');
    expect(result.exitCode).toBe(0);
    expect(codexInvoked).toBe(false);
  });

  it('HALT wins over REA_SKIP_PUSH_GATE', async () => {
    const result = await runPushGate(
      baseDeps(baseDir, {
        env: { REA_SKIP_PUSH_GATE: 'ignore halt please' },
        readHalt: () => ({ halted: true, reason: 'audit freeze' }),
      }),
    );
    expect(result.status).toBe('halted');
  });

  it('does NOT skip when the var is set to empty string', async () => {
    let codexInvoked = false;
    await runPushGate(
      baseDeps(baseDir, {
        env: { REA_SKIP_PUSH_GATE: '' },
        runCodex: async () => {
          codexInvoked = true;
          return { reviewText: '', eventCount: 0, durationSeconds: 0 };
        },
      }),
    );
    expect(codexInvoked).toBe(true);
  });
});

describe('runPushGate — REA_SKIP_CODEX_REVIEW waiver (Fix B / 0.12.0)', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-skipcdx-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('skips gate when REA_SKIP_CODEX_REVIEW is set with a non-empty reason', async () => {
    let codexInvoked = false;
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    const result = await runPushGate(
      baseDeps(baseDir, {
        env: { REA_SKIP_CODEX_REVIEW: 'helixir-migration 2026-04-26' },
        runCodex: async () => {
          codexInvoked = true;
          return { reviewText: '', eventCount: 0, durationSeconds: 0 };
        },
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    expect(result.status).toBe('skipped');
    expect(result.exitCode).toBe(0);
    expect(codexInvoked).toBe(false);
    const skipped = audited.find((e) => e.tool === 'rea.push_gate.skipped');
    expect(skipped?.meta?.skip_var).toBe('REA_SKIP_CODEX_REVIEW');
    expect(skipped?.meta?.reason).toBe('helixir-migration 2026-04-26');
  });

  it('does NOT skip when REA_SKIP_CODEX_REVIEW is set to empty string', async () => {
    let codexInvoked = false;
    await runPushGate(
      baseDeps(baseDir, {
        env: { REA_SKIP_CODEX_REVIEW: '' },
        runCodex: async () => {
          codexInvoked = true;
          return { reviewText: '', eventCount: 0, durationSeconds: 0 };
        },
      }),
    );
    expect(codexInvoked).toBe(true);
  });

  it('REA_SKIP_PUSH_GATE wins when both env vars are set', async () => {
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    await runPushGate(
      baseDeps(baseDir, {
        env: {
          REA_SKIP_PUSH_GATE: 'canonical waiver',
          REA_SKIP_CODEX_REVIEW: 'should-not-win',
        },
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    const skipped = audited.find((e) => e.tool === 'rea.push_gate.skipped');
    expect(skipped?.meta?.skip_var).toBe('REA_SKIP_PUSH_GATE');
    expect(skipped?.meta?.reason).toBe('canonical waiver');
  });

  it('audits skip_var=REA_SKIP_PUSH_GATE on the original waiver', async () => {
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    await runPushGate(
      baseDeps(baseDir, {
        env: { REA_SKIP_PUSH_GATE: 'urgent hotfix' },
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    const skipped = audited.find((e) => e.tool === 'rea.push_gate.skipped');
    expect(skipped?.meta?.skip_var).toBe('REA_SKIP_PUSH_GATE');
  });
});

describe('runPushGate — --last-n-commits / policy.review.last_n_commits (Fix D / 0.12.0)', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-lastn-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('uses HEAD~N when --last-n-commits flag is set; audit metadata reflects last-n-commits source', async () => {
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    let codexBaseRef = '';
    const result = await runPushGate(
      baseDeps(baseDir, {
        lastNCommits: 3,
        git: fakeGit({
          tryRevParse: (args) => {
            // Resolver asks `git rev-parse --verify --quiet HEAD~3^{commit}`.
            if (args.some((a) => /~\d+\^\{commit\}$/.test(a))) {
              return 'cafefeed1234567890abcdef1234567890abcdef';
            }
            return '';
          },
        }),
        runCodex: async ({ baseRef }) => {
          codexBaseRef = baseRef;
          return { reviewText: 'No issues.', eventCount: 1, durationSeconds: 0.1 };
        },
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    expect(result.status).toBe('pass');
    expect(codexBaseRef).toBe('cafefeed1234567890abcdef1234567890abcdef');
    const reviewed = audited.find((e) => e.tool === 'rea.push_gate.reviewed');
    expect(reviewed?.meta?.base_source).toBe('last-n-commits');
    expect(reviewed?.meta?.last_n_commits).toBe(3);
  });

  it('warns and uses empty-tree when even HEAD~1 does not resolve (single-commit history)', async () => {
    const stderr: string[] = [];
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    await runPushGate(
      baseDeps(baseDir, {
        lastNCommits: 50,
        stderr: (line) => stderr.push(line),
        git: fakeGit({
          tryRevParse: () => '', // single-commit — every probe (incl. ~1) fails
        }),
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    // Warning: requested ~50 not reachable; reviewing all 1 commits.
    expect(stderr.some((l) => /~50 not reachable; reviewing all 1 commits/.test(l))).toBe(true);
    const reviewed = audited.find((e) => e.tool === 'rea.push_gate.reviewed');
    expect(reviewed?.meta?.last_n_commits).toBe(1);
    expect(reviewed?.meta?.last_n_commits_requested).toBe(50);
  });

  it('full clone, branch shorter than N: includes the root commit (empty-tree base; K+1 commits reviewed)', async () => {
    // Regression for [P1] Codex 2026-04-29 (first finding): when
    // last_n_commits is larger than the branch history on a FULL
    // clone, the resolver must include the root commit's changes.
    // Diffing against the oldest reachable commit (HEAD~K) would
    // silently EXCLUDE that commit (`git diff base..HEAD` excludes
    // `base`). The fix: clamp to empty-tree and report
    // `last_n_commits: K+1` (every commit reviewed, root included).
    const reachableDepths = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const stderr: string[] = [];
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    await runPushGate(
      baseDeps(baseDir, {
        lastNCommits: 50,
        stderr: (line) => stderr.push(line),
        git: fakeGit({
          tryRevParse: (args) => {
            if (args.includes('--is-shallow-repository')) return 'false';
            for (const a of args) {
              const m = /~(\d+)\^\{commit\}$/.exec(a);
              if (m !== null) {
                const depth = Number(m[1]);
                if (reachableDepths.has(depth)) {
                  return `cafe${depth.toString(16).padStart(36, '0')}`;
                }
                return '';
              }
            }
            return '';
          },
        }),
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    expect(stderr.some((l) => /~50 not reachable; reviewing all 13 commits/.test(l))).toBe(true);
    const reviewed = audited.find((e) => e.tool === 'rea.push_gate.reviewed');
    expect(reviewed?.meta?.base_source).toBe('last-n-commits');
    expect(reviewed?.meta?.last_n_commits).toBe(13);
    expect(reviewed?.meta?.last_n_commits_requested).toBe(50);
  });

  it('shallow clone, depth shorter than N: clamps to ~K SHA so the review does not balloon to every tracked file', async () => {
    // Regression for [P1] Codex 2026-04-29 (second finding): on a
    // SHALLOW clone the deepest reachable commit is NOT the root —
    // older history exists on the remote. Using empty-tree as the
    // base would make the review include every tracked file in the
    // checkout, defeating the narrowing the operator asked for. The
    // fix: when --is-shallow-repository is true, diff against
    // <headRef>~K SHA and report `last_n_commits: K`.
    const reachableDepths = new Set([1, 2, 3, 4, 5]);
    const stderr: string[] = [];
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    await runPushGate(
      baseDeps(baseDir, {
        lastNCommits: 50,
        stderr: (line) => stderr.push(line),
        git: fakeGit({
          tryRevParse: (args) => {
            if (args.includes('--is-shallow-repository')) return 'true';
            for (const a of args) {
              const m = /~(\d+)\^\{commit\}$/.exec(a);
              if (m !== null) {
                const depth = Number(m[1]);
                if (reachableDepths.has(depth)) {
                  return `cafe${depth.toString(16).padStart(36, '0')}`;
                }
                return '';
              }
            }
            return '';
          },
        }),
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    expect(stderr.some((l) => /~50 not reachable; reviewing all 5 commits/.test(l))).toBe(true);
    const reviewed = audited.find((e) => e.tool === 'rea.push_gate.reviewed');
    expect(reviewed?.meta?.base_source).toBe('last-n-commits');
    expect(reviewed?.meta?.last_n_commits).toBe(5);
    expect(reviewed?.meta?.last_n_commits_requested).toBe(50);
  });

  it('CLI flag wins over policy key when both are set', async () => {
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    await runPushGate(
      baseDeps(baseDir, {
        lastNCommits: 2,
        resolvePolicy: async () => ({
          codex_required: true,
          concerns_blocks: true,
          timeout_ms: 1_800_000,
          last_n_commits: 7,
          policyMissing: false,
        }),
        git: fakeGit({
          tryRevParse: (args) =>
            args.some((a) => /~\d+\^\{commit\}$/.test(a))
              ? 'beefcafe1234567890abcdef1234567890abcdef'
              : '',
        }),
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    const reviewed = audited.find((e) => e.tool === 'rea.push_gate.reviewed');
    expect(reviewed?.meta?.last_n_commits).toBe(2);
  });

  it('--base wins over --last-n-commits and emits a stderr warning', async () => {
    const stderr: string[] = [];
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    await runPushGate(
      baseDeps(baseDir, {
        explicitBase: 'origin/release-1.0',
        lastNCommits: 5,
        stderr: (line) => stderr.push(line),
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    const reviewed = audited.find((e) => e.tool === 'rea.push_gate.reviewed');
    expect(reviewed?.meta?.base_source).toBe('explicit');
    expect(stderr.some((l) => l.includes('--base origin/release-1.0 overrides'))).toBe(true);
  });

  it('walks back from the PUSHED ref (refspec.localSha), not local HEAD, when both are present', async () => {
    // Regression for the codex-adversarial finding 2026-04-29:
    // `git push origin some-other-branch` had the gate computing
    // HEAD~N (current checkout) instead of <pushed-sha>~N.
    const probedRefs: string[] = [];
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    await runPushGate(
      baseDeps(baseDir, {
        lastNCommits: 2,
        refspecs: [
          {
            localRef: 'refs/heads/feature-x',
            localSha: 'aaaa11111111111111111111111111111111aaaa',
            remoteRef: 'refs/heads/feature-x',
            remoteSha: 'bbbb22222222222222222222222222222222bbbb',
          },
        ],
        git: fakeGit({
          headSha: () => 'cccc33333333333333333333333333333333cccc', // local HEAD differs
          tryRevParse: (args) => {
            const probe = args.find((a) => /~\d+\^\{commit\}$/.test(a));
            if (probe !== undefined) probedRefs.push(probe);
            // Resolve `<pushedSha>~2^{commit}` to a base SHA.
            if (args.some((a) => a === 'aaaa11111111111111111111111111111111aaaa~2^{commit}')) {
              return '0000999999999999999999999999999999990000';
            }
            return '';
          },
        }),
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    // The resolver must have probed the PUSHED sha, not the local HEAD.
    expect(probedRefs.some((r) => r.startsWith('aaaa1111'))).toBe(true);
    expect(probedRefs.some((r) => r.startsWith('cccc3333'))).toBe(false);
    const reviewed = audited.find((e) => e.tool === 'rea.push_gate.reviewed');
    expect(reviewed?.meta?.base_source).toBe('last-n-commits');
    expect(reviewed?.meta?.head_sha).toBe('aaaa11111111111111111111111111111111aaaa');
  });

  it('policy.review.last_n_commits applies when CLI flag is unset', async () => {
    const audited: Array<{ tool: string; meta?: Record<string, unknown> }> = [];
    await runPushGate(
      baseDeps(baseDir, {
        resolvePolicy: async () => ({
          codex_required: true,
          concerns_blocks: true,
          timeout_ms: 1_800_000,
          last_n_commits: 4,
          policyMissing: false,
        }),
        git: fakeGit({
          tryRevParse: (args) =>
            args.some((a) => /~\d+\^\{commit\}$/.test(a))
              ? 'feedcafe1234567890abcdef1234567890abcdef'
              : '',
        }),
        appendAudit: async (_baseDir, record) => {
          audited.push({ tool: record.tool_name, meta: record.metadata });
          return {} as never;
        },
      }),
    );
    const reviewed = audited.find((e) => e.tool === 'rea.push_gate.reviewed');
    expect(reviewed?.meta?.base_source).toBe('last-n-commits');
    expect(reviewed?.meta?.last_n_commits).toBe(4);
  });
});

describe('runPushGate — empty diff', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-empty-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('returns empty-diff / exitCode 0 without invoking codex', async () => {
    let codexInvoked = false;
    const result = await runPushGate(
      baseDeps(baseDir, {
        git: fakeGit({ diffNames: () => [] }),
        runCodex: async () => {
          codexInvoked = true;
          return { reviewText: '', eventCount: 0, durationSeconds: 0 };
        },
      }),
    );
    expect(result.status).toBe('empty-diff');
    expect(result.exitCode).toBe(0);
    expect(codexInvoked).toBe(false);
  });
});

describe('runPushGate — verdict mapping', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-verdict-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('pass → exitCode 0', async () => {
    const result = await runPushGate(baseDeps(baseDir));
    expect(result.status).toBe('pass');
    expect(result.exitCode).toBe(0);
  });

  it('blocking → exitCode 2', async () => {
    const result = await runPushGate(
      baseDeps(baseDir, {
        runCodex: async () => ({
          reviewText: '- [P1] Must fix — src/a.ts:1',
          eventCount: 3,
          durationSeconds: 1,
        }),
      }),
    );
    expect(result.status).toBe('blocking');
    expect(result.exitCode).toBe(2);
  });

  it('concerns + concerns_blocks=true → exitCode 2', async () => {
    const result = await runPushGate(
      baseDeps(baseDir, {
        runCodex: async () => ({
          reviewText: '- [P2] Significant concern — src/a.ts:1',
          eventCount: 3,
          durationSeconds: 1,
        }),
      }),
    );
    expect(result.status).toBe('concerns');
    expect(result.exitCode).toBe(2);
  });

  it('concerns + concerns_blocks=false → exitCode 0 (policy opt-out)', async () => {
    const result = await runPushGate(
      baseDeps(baseDir, {
        resolvePolicy: async () => ({ ...DEFAULT_POLICY, concerns_blocks: false }),
        runCodex: async () => ({
          reviewText: '- [P2] Significant concern — src/a.ts:1',
          eventCount: 3,
          durationSeconds: 1,
        }),
      }),
    );
    expect(result.status).toBe('concerns');
    expect(result.exitCode).toBe(0);
  });

  it('concerns + REA_ALLOW_CONCERNS=1 → exitCode 0 (per-push override)', async () => {
    const result = await runPushGate(
      baseDeps(baseDir, {
        env: { REA_ALLOW_CONCERNS: '1' },
        runCodex: async () => ({
          reviewText: '- [P2] Concern — src/a.ts:1',
          eventCount: 3,
          durationSeconds: 1,
        }),
      }),
    );
    expect(result.status).toBe('concerns');
    expect(result.exitCode).toBe(0);
  });

  it('writes .rea/last-review.json on every successful codex run', async () => {
    await runPushGate(baseDeps(baseDir));
    const raw = await fs.readFile(path.join(baseDir, '.rea', 'last-review.json'), 'utf8');
    const payload = JSON.parse(raw) as { verdict: string; finding_count: number };
    expect(payload.verdict).toBe('pass');
    expect(payload.finding_count).toBe(0);
  });
});

describe('runPushGate — pre-push stdin refspecs', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-refspec-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('diffs against the refspec remote_sha, not the upstream ladder, when stdin carries a refspec', async () => {
    let codexInvokedWithBase = '';
    const REMOTE_SHA = 'a'.repeat(40);
    const LOCAL_SHA = 'b'.repeat(40);
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: [
          {
            localRef: 'refs/heads/feature',
            localSha: LOCAL_SHA,
            remoteRef: 'refs/heads/release/1.0',
            remoteSha: REMOTE_SHA,
          },
        ],
        git: fakeGit({
          tryRevParse: () => 'origin/main',
          headSha: () => 'UNUSED-because-refspec-wins',
          diffNames: () => ['src/change.ts'],
        }),
        runCodex: async (opts) => {
          codexInvokedWithBase = opts.baseRef;
          return { reviewText: '', eventCount: 1, durationSeconds: 0.1 };
        },
      }),
    );
    expect(codexInvokedWithBase).toBe(REMOTE_SHA);
  });

  it('uses the refspec local_sha as head_sha (not git HEAD)', async () => {
    const REMOTE_SHA = 'a'.repeat(40);
    const LOCAL_SHA = 'b'.repeat(40);
    const result = await runPushGate(
      baseDeps(baseDir, {
        refspecs: [
          {
            localRef: 'refs/heads/feature',
            localSha: LOCAL_SHA,
            remoteRef: 'refs/heads/release/1.0',
            remoteSha: REMOTE_SHA,
          },
        ],
        git: fakeGit({ headSha: () => 'DIFFERENT-HEAD' }),
      }),
    );
    expect(result.headSha).toBe(LOCAL_SHA);
  });

  it('falls back to the upstream ladder when refspec remote_sha is the null SHA (new remote ref)', async () => {
    let codexInvokedWithBase = '';
    const NULL = '0'.repeat(40);
    const LOCAL_SHA = 'b'.repeat(40);
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: [
          {
            localRef: 'refs/heads/feature',
            localSha: LOCAL_SHA,
            remoteRef: 'refs/heads/feature',
            remoteSha: NULL,
          },
        ],
        git: fakeGit({
          tryRevParse: (args) => (args.includes('@{upstream}') ? 'origin/main' : ''),
          diffNames: () => ['src/change.ts'],
        }),
        runCodex: async (opts) => {
          codexInvokedWithBase = opts.baseRef;
          return { reviewText: '', eventCount: 1, durationSeconds: 0.1 };
        },
      }),
    );
    expect(codexInvokedWithBase).toBe('origin/main');
  });

  it('skips deletion refspecs (local_sha = null SHA) and moves on', async () => {
    let codexInvokedWithBase = '';
    const NULL = '0'.repeat(40);
    const REMOTE_SHA = 'a'.repeat(40);
    const LOCAL_SHA = 'b'.repeat(40);
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: [
          { localRef: '', localSha: NULL, remoteRef: 'refs/heads/stale', remoteSha: REMOTE_SHA },
          {
            localRef: 'refs/heads/feature',
            localSha: LOCAL_SHA,
            remoteRef: 'refs/heads/release',
            remoteSha: REMOTE_SHA,
          },
        ],
        runCodex: async (opts) => {
          codexInvokedWithBase = opts.baseRef;
          return { reviewText: '', eventCount: 1, durationSeconds: 0.1 };
        },
      }),
    );
    expect(codexInvokedWithBase).toBe(REMOTE_SHA);
  });
});

describe('parsePrePushStdin', () => {
  it('parses a single well-formed refspec line', () => {
    const raw = 'refs/heads/feat aaaaaa refs/heads/main bbbbbb\n';
    const parsed = parsePrePushStdin(raw);
    expect(parsed).toEqual([
      {
        localRef: 'refs/heads/feat',
        localSha: 'aaaaaa',
        remoteRef: 'refs/heads/main',
        remoteSha: 'bbbbbb',
      },
    ]);
  });

  it('parses multiple refspec lines', () => {
    const raw = [
      'refs/heads/a 1111111111111111111111111111111111111111 refs/heads/a 2222222222222222222222222222222222222222',
      'refs/heads/b 3333333333333333333333333333333333333333 refs/heads/b 4444444444444444444444444444444444444444',
      '',
    ].join('\n');
    const parsed = parsePrePushStdin(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.localRef).toBe('refs/heads/a');
    expect(parsed[1]?.localRef).toBe('refs/heads/b');
  });

  it('drops blank lines and malformed (not-four-fields) lines silently', () => {
    const raw = 'a b\nrefs/heads/x SHA1 refs/heads/y SHA2\n\n';
    const parsed = parsePrePushStdin(raw);
    expect(parsed).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(parsePrePushStdin('')).toEqual([]);
    expect(parsePrePushStdin('   \n   \n')).toEqual([]);
  });
});

describe('runPushGate — codex errors', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-err-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('exitCode 2 + status=error when codex throws', async () => {
    const result = await runPushGate(
      baseDeps(baseDir, {
        runCodex: async () => {
          throw new Error('simulated codex explosion');
        },
      }),
    );
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Auto-narrow on large divergence (J / 0.13.0)
// ---------------------------------------------------------------------------

describe('runPushGate — auto-narrow on large divergence (J / 0.13.0)', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-pg-idx-an-')));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  // Auto-narrow only fires when the base was resolved from the active
  // refspec's remoteSha (i.e. previously-pushed remote tip of THIS
  // branch). All tests below provide such a refspec unless explicitly
  // probing the suppression path.
  const REMOTE_SHA = 'r'.repeat(40);
  const LOCAL_SHA = 'l'.repeat(40);
  const refspecPushedTip = () => [
    {
      localRef: 'refs/heads/feature',
      localSha: LOCAL_SHA,
      remoteRef: 'refs/heads/feature',
      remoteSha: REMOTE_SHA,
    },
  ];

  it('fires when commit count exceeds threshold and base came from refspec remote tip', async () => {
    let stderrText = '';
    let auditMeta: Record<string, unknown> | null = null;
    const result = await runPushGate(
      baseDeps(baseDir, {
        refspecs: refspecPushedTip(),
        stderr: (line) => {
          stderrText += line;
        },
        // 80 commits behind base — well above default threshold of 30.
        git: fakeGit({
          tryRevParse: (args) => {
            // last-n-commits ~10 re-resolve uses LOCAL_SHA (refspec's
            // localSha) as headRef and walks back 10 commits.
            if (args.some((a) => /~10\^\{commit\}/.test(a))) return 'narrowed-base-sha';
            return '';
          },
          revListCount: () => 80,
          diffNames: () => ['src/changed.ts'],
        }),
        appendAudit: async (
          _baseDir,
          rec: { tool_name?: string; metadata?: Record<string, unknown> },
        ) => {
          if (rec.tool_name === 'rea.push_gate.reviewed') {
            auditMeta = rec.metadata ?? null;
          }
          return {} as never;
        },
      }),
    );
    expect(result.status).toBe('pass');
    expect(stderrText).toMatch(/auto-narrow/);
    expect(stderrText).toMatch(/80 commits behind/);
    expect(stderrText).toMatch(/last 10 commits/);
    expect(auditMeta).not.toBeNull();
    expect((auditMeta as { auto_narrowed?: boolean }).auto_narrowed).toBe(true);
    expect((auditMeta as { original_commit_count?: number }).original_commit_count).toBe(80);
  });

  it('does NOT fire when base came from the upstream ladder (initial push, no refspec)', async () => {
    // Critical safety case (codex-review 0.13.0 [P1]): a long-lived branch
    // pushed for the FIRST time would resolve base via the upstream ladder
    // (origin/HEAD or origin/main). Auto-narrow MUST NOT fire there —
    // earlier commits on the branch may never have been Codex-reviewed.
    let stderrText = '';
    let auditMeta: Record<string, unknown> | null = null;
    await runPushGate(
      baseDeps(baseDir, {
        // NO refspecs — gate falls through to the upstream ladder.
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          tryRevParse: (args) => {
            // Resolver finds origin/main via the ladder.
            if (args.includes('refs/remotes/origin/main')) return 'orig-main-sha';
            return '';
          },
          revListCount: () => 80, // 80 commits ahead, but still no auto-narrow
          diffNames: () => ['src/x.ts'],
        }),
        appendAudit: async (
          _baseDir,
          rec: { tool_name?: string; metadata?: Record<string, unknown> },
        ) => {
          if (rec.tool_name === 'rea.push_gate.reviewed') auditMeta = rec.metadata ?? null;
          return {} as never;
        },
      }),
    );
    expect(stderrText).not.toMatch(/auto-narrow/);
    expect((auditMeta as { auto_narrowed?: boolean } | null)?.auto_narrowed).toBeUndefined();
  });

  it('does NOT fire when refspec remoteSha is the null SHA (new remote ref / first push of branch)', async () => {
    const NULL = '0'.repeat(40);
    let stderrText = '';
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: [
          {
            localRef: 'refs/heads/new-feature',
            localSha: LOCAL_SHA,
            remoteRef: 'refs/heads/new-feature',
            remoteSha: NULL,
          },
        ],
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          tryRevParse: (args) => {
            if (args.includes('refs/remotes/origin/main')) return 'orig-main-sha';
            return '';
          },
          revListCount: () => 999,
          diffNames: () => ['x.ts'],
        }),
      }),
    );
    expect(stderrText).not.toMatch(/auto-narrow/);
  });

  it('does NOT fire when commit count <= threshold', async () => {
    let stderrText = '';
    let auditMeta: Record<string, unknown> | null = null;
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: refspecPushedTip(),
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          revListCount: () => 5, // way under threshold
          diffNames: () => ['src/x.ts'],
        }),
        appendAudit: async (
          _baseDir,
          rec: { tool_name?: string; metadata?: Record<string, unknown> },
        ) => {
          if (rec.tool_name === 'rea.push_gate.reviewed') auditMeta = rec.metadata ?? null;
          return {} as never;
        },
      }),
    );
    expect(stderrText).not.toMatch(/auto-narrow/);
    expect((auditMeta as { auto_narrowed?: boolean } | null)?.auto_narrowed).toBeUndefined();
  });

  it('suppresses when --last-n-commits is set (operator picked an explicit window)', async () => {
    let stderrText = '';
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: refspecPushedTip(),
        lastNCommits: 5,
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          tryRevParse: (args) => {
            if (args.some((a) => /~5\^\{commit\}/.test(a))) return 'last5-sha';
            return '';
          },
          revListCount: () => 999,
          diffNames: () => ['x.ts'],
        }),
      }),
    );
    expect(stderrText).not.toMatch(/auto-narrow/);
  });

  it('suppresses when --base is set (operator picked an explicit ref)', async () => {
    let stderrText = '';
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: refspecPushedTip(),
        explicitBase: 'origin/feature-x',
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          revListCount: () => 999,
          diffNames: () => ['x.ts'],
        }),
      }),
    );
    expect(stderrText).not.toMatch(/auto-narrow/);
  });

  it('suppresses when policy.review.last_n_commits is set', async () => {
    let stderrText = '';
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: refspecPushedTip(),
        resolvePolicy: async () => ({ ...DEFAULT_POLICY, last_n_commits: 5 }),
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          tryRevParse: (args) => {
            if (args.some((a) => /~5\^\{commit\}/.test(a))) return 'pol-last5-sha';
            return '';
          },
          revListCount: () => 999,
          diffNames: () => ['x.ts'],
        }),
      }),
    );
    expect(stderrText).not.toMatch(/auto-narrow/);
  });

  it('disabled by policy.review.auto_narrow_threshold: 0', async () => {
    let stderrText = '';
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: refspecPushedTip(),
        resolvePolicy: async () => ({ ...DEFAULT_POLICY, auto_narrow_threshold: 0 }),
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          revListCount: () => 9999,
          diffNames: () => ['x.ts'],
        }),
      }),
    );
    expect(stderrText).not.toMatch(/auto-narrow/);
  });

  it('does not fire when revListCount returns null (range unresolvable)', async () => {
    let stderrText = '';
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: refspecPushedTip(),
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          revListCount: () => null,
          diffNames: () => ['x.ts'],
        }),
      }),
    );
    expect(stderrText).not.toMatch(/auto-narrow/);
  });

  it('fires at exactly threshold+1 (boundary check)', async () => {
    let stderrText = '';
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: refspecPushedTip(),
        resolvePolicy: async () => ({ ...DEFAULT_POLICY, auto_narrow_threshold: 30 }),
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          tryRevParse: (args) => {
            if (args.some((a) => /~10\^\{commit\}/.test(a))) return 'narrow-sha';
            return '';
          },
          revListCount: () => 31, // > threshold by exactly 1
          diffNames: () => ['x.ts'],
        }),
      }),
    );
    expect(stderrText).toMatch(/auto-narrow/);
  });

  it('does not fire at exactly threshold (boundary check)', async () => {
    let stderrText = '';
    await runPushGate(
      baseDeps(baseDir, {
        refspecs: refspecPushedTip(),
        resolvePolicy: async () => ({ ...DEFAULT_POLICY, auto_narrow_threshold: 30 }),
        stderr: (line) => {
          stderrText += line;
        },
        git: fakeGit({
          revListCount: () => 30, // == threshold
          diffNames: () => ['x.ts'],
        }),
      }),
    );
    expect(stderrText).not.toMatch(/auto-narrow/);
  });
});
