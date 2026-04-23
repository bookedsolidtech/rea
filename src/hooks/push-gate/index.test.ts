import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
    ...overrides,
  };
}

const DEFAULT_POLICY = {
  codex_required: PUSH_GATE_DEFAULT_CODEX_REQUIRED,
  concerns_blocks: PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
  timeout_ms: PUSH_GATE_DEFAULT_TIMEOUT_MS,
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
