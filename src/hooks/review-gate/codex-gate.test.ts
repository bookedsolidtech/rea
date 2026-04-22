/**
 * Unit tests for `codex-gate.ts`.
 *
 * Coverage matrix:
 *
 *   - Policy bypass: codex_required=false → not_required, no audit writes.
 *   - Waiver unset: codex_required=true, no env → required.
 *   - Waiver set + CI + allow_skip_in_ci=false → BlockedError (CI refuse).
 *   - Waiver set + CI + allow_skip_in_ci=true → waiver_active (allowed).
 *   - Waiver set + no actor → BlockedError (no actor).
 *   - Waiver set + actor → waiver_active + audit record emitted.
 *   - verifyCodexReceipt: all three decision kinds.
 *   - renderWaiverBanner snapshot.
 *   - Audit-emit failure → BlockedError (fails closed, §647-651 parity).
 *
 * Tests use a real tmpdir so the audit hash chain is exercised end-to-
 * end. GitRunner is a vi.fn() so actor lookup paths are deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateCodexGate,
  renderWaiverBanner,
  verifyCodexReceipt,
  type CodexGateDecision,
} from './codex-gate.js';
import type { GitRunner, GitRunResult } from './diff.js';
import { BlockedError } from './errors.js';
import type { ResolvedPolicy } from './policy.js';

const HEAD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'review-gate-codex-test-'));
  await mkdir(join(dir, '.rea'), { recursive: true });
  // Policy file the loader reads — minimal valid shape.
  await writeFile(
    join(dir, '.rea', 'policy.yaml'),
    [
      'version: "1"',
      'profile: "test"',
      'autonomy_level: L1',
      'max_autonomy_level: L2',
      'review:',
      '  codex_required: true',
      '',
    ].join('\n'),
  );
  return dir;
}

/**
 * Build a stubbed GitRunner whose `git config --get user.email` /
 * `user.name` return the given values. Any other git invocation returns
 * a successful-empty-stdout result so unrelated calls don't throw.
 */
function makeActorRunner(email: string, name: string): GitRunner {
  return vi.fn((args: readonly string[]): GitRunResult => {
    if (args[0] === 'config' && args[1] === '--get') {
      const key = args[2];
      if (key === 'user.email') return { status: email.length > 0 ? 0 : 1, stdout: email, stderr: '' };
      if (key === 'user.name') return { status: name.length > 0 ? 0 : 1, stdout: name, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
}

/** Build an explicit resolved-policy object — avoids reading YAML in every test. */
function policyOf(input: { codex_required: boolean; allow_skip_in_ci?: boolean }): ResolvedPolicy {
  return {
    codex_required: input.codex_required,
    allow_skip_in_ci: input.allow_skip_in_ci ?? false,
    policy: null,
    warning: null,
  };
}

describe('evaluateCodexGate — policy bypass', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns not_required when codex_required=false; no audit write', async () => {
    const runner = makeActorRunner('dev@example.com', 'Dev');
    const decision = await evaluateCodexGate({
      baseDir: dir,
      runner,
      head_sha: HEAD_SHA,
      target: 'main',
      metadata_source: 'prepush-stdin',
      policy: policyOf({ codex_required: false }),
      skipEnv: { push_review_reason: null, codex_review_reason: 'whatever' }, // even with waiver set
      ci: true, // even in CI
    });
    expect(decision.kind).toBe('not_required');
    // No audit file should have been created.
    await expect(readFile(join(dir, '.rea', 'audit.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('evaluateCodexGate — no waiver', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns required when codex_required=true and REA_SKIP_CODEX_REVIEW unset', async () => {
    const runner = makeActorRunner('dev@example.com', 'Dev');
    const decision = await evaluateCodexGate({
      baseDir: dir,
      runner,
      head_sha: HEAD_SHA,
      target: 'main',
      metadata_source: 'prepush-stdin',
      policy: policyOf({ codex_required: true }),
      skipEnv: { push_review_reason: null, codex_review_reason: null },
      ci: false,
    });
    expect(decision.kind).toBe('required');
  });

  it('treats empty-string waiver as unset (bash non-empty semantics)', async () => {
    const runner = makeActorRunner('dev@example.com', 'Dev');
    const decision = await evaluateCodexGate({
      baseDir: dir,
      runner,
      head_sha: HEAD_SHA,
      target: 'main',
      metadata_source: 'prepush-stdin',
      policy: policyOf({ codex_required: true }),
      // readSkipEnv translates '' → null; to simulate, explicitly pass null.
      skipEnv: { push_review_reason: null, codex_review_reason: null },
      ci: false,
    });
    expect(decision.kind).toBe('required');
  });
});

describe('evaluateCodexGate — waiver refusals', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('BlockedError when CI is set and allow_skip_in_ci is not true', async () => {
    const runner = makeActorRunner('dev@example.com', 'Dev');
    await expect(
      evaluateCodexGate({
        baseDir: dir,
        runner,
        head_sha: HEAD_SHA,
        target: 'main',
        metadata_source: 'prepush-stdin',
        policy: policyOf({ codex_required: true, allow_skip_in_ci: false }),
        skipEnv: { push_review_reason: null, codex_review_reason: 'agent opinion' },
        ci: true,
      }),
    ).rejects.toMatchObject({
      name: 'BlockedError',
      code: 'PUSH_BLOCKED_SKIP_REFUSED_IN_CI',
      exitCode: 2,
    });
  });

  it('allows waiver in CI when allow_skip_in_ci=true', async () => {
    const runner = makeActorRunner('dev@example.com', 'Dev');
    const decision = await evaluateCodexGate({
      baseDir: dir,
      runner,
      head_sha: HEAD_SHA,
      target: 'main',
      metadata_source: 'prepush-stdin',
      policy: policyOf({ codex_required: true, allow_skip_in_ci: true }),
      skipEnv: { push_review_reason: null, codex_review_reason: 'operator-authorized' },
      ci: true,
    });
    expect(decision.kind).toBe('waiver_active');
  });

  it('BlockedError when no resolvable actor', async () => {
    const runner = makeActorRunner('', '');
    await expect(
      evaluateCodexGate({
        baseDir: dir,
        runner,
        head_sha: HEAD_SHA,
        target: 'main',
        metadata_source: 'prepush-stdin',
        policy: policyOf({ codex_required: true }),
        skipEnv: { push_review_reason: null, codex_review_reason: 'agent' },
        ci: false,
      }),
    ).rejects.toMatchObject({
      name: 'BlockedError',
      code: 'PUSH_BLOCKED_SKIP_NO_ACTOR',
      exitCode: 2,
    });
  });

  it('falls back to user.name when user.email is empty', async () => {
    const runner = makeActorRunner('', 'Dev Name');
    const decision = await evaluateCodexGate({
      baseDir: dir,
      runner,
      head_sha: HEAD_SHA,
      target: 'main',
      metadata_source: 'prepush-stdin',
      policy: policyOf({ codex_required: true }),
      skipEnv: { push_review_reason: null, codex_review_reason: 'agent' },
      ci: false,
    });
    expect(decision.kind).toBe('waiver_active');
    if (decision.kind === 'waiver_active') {
      expect(decision.actor).toBe('Dev Name');
    }
  });
});

describe('evaluateCodexGate — happy path emits audit record', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits codex.review.skipped with the right shape', async () => {
    const runner = makeActorRunner('dev@example.com', 'Dev');
    const decision = await evaluateCodexGate({
      baseDir: dir,
      runner,
      head_sha: HEAD_SHA,
      target: 'dev',
      metadata_source: 'prepush-stdin',
      policy: policyOf({ codex_required: true }),
      skipEnv: { push_review_reason: null, codex_review_reason: 'agent-authorized scope' },
      ci: false,
    });
    expect(decision.kind).toBe('waiver_active');
    const audit = await readFile(join(dir, '.rea', 'audit.jsonl'), 'utf8');
    const lines = audit.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as {
      tool_name: string;
      server_name: string;
      metadata: Record<string, unknown>;
    };
    expect(parsed.tool_name).toBe('codex.review.skipped');
    expect(parsed.server_name).toBe('rea.escape_hatch');
    expect(parsed.metadata).toMatchObject({
      head_sha: HEAD_SHA,
      target: 'dev',
      reason: 'agent-authorized scope',
      actor: 'dev@example.com',
      verdict: 'skipped',
      metadata_source: 'prepush-stdin',
    });
  });

  it('BlockedError when audit emit fails (unwritable .rea)', async () => {
    // Make .rea unwritable to force the append to throw.
    const reaDir = join(dir, '.rea');
    await chmod(reaDir, 0o555);
    try {
      const runner = makeActorRunner('dev@example.com', 'Dev');
      await expect(
        evaluateCodexGate({
          baseDir: dir,
          runner,
          head_sha: HEAD_SHA,
          target: 'main',
          metadata_source: 'prepush-stdin',
          policy: policyOf({ codex_required: true }),
          skipEnv: { push_review_reason: null, codex_review_reason: 'x' },
          ci: false,
        }),
      ).rejects.toMatchObject({
        name: 'BlockedError',
        code: 'PUSH_BLOCKED_SKIP_AUDIT_FAILED',
        exitCode: 2,
      });
    } finally {
      await chmod(reaDir, 0o755);
    }
  });
});

describe('verifyCodexReceipt', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns true for not_required regardless of audit state', async () => {
    const ok = await verifyCodexReceipt({ kind: 'not_required' }, dir, HEAD_SHA);
    expect(ok).toBe(true);
  });

  it('returns true for waiver_active regardless of audit state', async () => {
    const decision: CodexGateDecision = {
      kind: 'waiver_active',
      reason: 'x',
      actor: 'dev',
      head_sha: HEAD_SHA,
      metadata_source: 'prepush-stdin',
    };
    const ok = await verifyCodexReceipt(decision, dir, HEAD_SHA);
    expect(ok).toBe(true);
  });

  it('returns false for required when no audit file exists', async () => {
    const ok = await verifyCodexReceipt({ kind: 'required' }, dir, HEAD_SHA);
    expect(ok).toBe(false);
  });

  it('returns true for required when a qualifying codex.review exists', async () => {
    const rec = {
      tool_name: 'codex.review',
      emission_source: 'rea-cli',
      metadata: { head_sha: HEAD_SHA, verdict: 'pass' },
    };
    await writeFile(
      join(dir, '.rea', 'audit.jsonl'),
      JSON.stringify(rec) + '\n',
    );
    const ok = await verifyCodexReceipt({ kind: 'required' }, dir, HEAD_SHA);
    expect(ok).toBe(true);
  });

  it('returns false for required when only forged records exist (defect P)', async () => {
    const forged = {
      tool_name: 'codex.review',
      emission_source: 'other',
      metadata: { head_sha: HEAD_SHA, verdict: 'pass' },
    };
    await writeFile(
      join(dir, '.rea', 'audit.jsonl'),
      JSON.stringify(forged) + '\n',
    );
    const ok = await verifyCodexReceipt({ kind: 'required' }, dir, HEAD_SHA);
    expect(ok).toBe(false);
  });
});

describe('renderWaiverBanner', () => {
  it('renders the waiver banner with the recorded actor and reason', () => {
    const banner = renderWaiverBanner({
      kind: 'waiver_active',
      reason: 'agent-authorized scope',
      actor: 'dev@example.com',
      head_sha: HEAD_SHA,
      metadata_source: 'prepush-stdin',
    });
    expect(banner).toContain('CODEX REVIEW WAIVER active');
    expect(banner).toContain('Reason:   agent-authorized scope');
    expect(banner).toContain('Actor:    dev@example.com');
    expect(banner).toContain(`Head SHA: ${HEAD_SHA}`);
    expect(banner).toContain('tool_name=codex.review.skipped');
    expect(banner.endsWith('\n')).toBe(true);
  });

  it('renders <unknown> when head_sha is empty', () => {
    const banner = renderWaiverBanner({
      kind: 'waiver_active',
      reason: 'x',
      actor: 'dev',
      head_sha: '',
      metadata_source: 'prepush-stdin',
    });
    expect(banner).toContain('Head SHA: <unknown>');
  });
});

/** Ensure the BlockedError class lineage is still exported correctly. */
describe('error types', () => {
  it('BlockedError carries exitCode 2 and ReviewGateError discriminator', async () => {
    const dir = await freshRepo();
    try {
      const runner = makeActorRunner('', '');
      let caught: unknown = null;
      try {
        await evaluateCodexGate({
          baseDir: dir,
          runner,
          head_sha: HEAD_SHA,
          target: 'main',
          metadata_source: 'prepush-stdin',
          policy: policyOf({ codex_required: true }),
          skipEnv: { push_review_reason: null, codex_review_reason: 'x' },
          ci: false,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BlockedError);
      if (caught instanceof BlockedError) {
        expect(caught.exitCode).toBe(2);
        expect(caught.code).toBe('PUSH_BLOCKED_SKIP_NO_ACTOR');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
