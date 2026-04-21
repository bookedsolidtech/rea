/**
 * Defect E (rea#78) regression tests — REA's own CLI must not be denied by
 * REA's own middleware, and when a Bash invocation IS denied the message must
 * include which command tripped the gate.
 *
 * Scenarios covered:
 *   1. `Bash { command: 'rea cache check ...' }` at L0 is allowed (Read tier).
 *   2. `Bash { command: 'rea audit record codex-review ...' }` at L1 is allowed
 *      (Read tier, not Write — recording its own audit entry is an append-only
 *      diagnostic event).
 *   3. `Bash { command: 'rea cache set <sha> pass ...' }` at L1 is allowed
 *      (Write tier).
 *   4. `Bash { command: 'rea freeze --reason ...' }` at L1 is denied
 *      (Destructive tier exceeds L1 ceiling) AND the deny-reason contains
 *      "freeze", not just "Bash".
 *   5. `ctx.metadata.reason_code === 'tier_exceeds_autonomy'` on tier denies.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPolicyMiddleware } from '../../src/gateway/middleware/policy.js';
import type { InvocationContext } from '../../src/gateway/middleware/chain.js';
import { AutonomyLevel, InvocationStatus, Tier, type Policy } from '../../src/policy/types.js';

function stubPolicy(level: AutonomyLevel): Policy {
  return {
    version: '1',
    profile: 'test',
    installed_by: 'test',
    installed_at: '2026-04-21',
    autonomy_level: level,
    max_autonomy_level: AutonomyLevel.L3,
    promotion_requires_human_approval: true,
    block_ai_attribution: true,
    blocked_paths: [],
    notification_channel: '',
  };
}

function bashCtx(command: string): InvocationContext {
  return {
    tool_name: 'Bash',
    server_name: 'local',
    arguments: { command },
    session_id: 's',
    status: InvocationStatus.Allowed,
    start_time: Date.now(),
    tier: Tier.Write,
    metadata: {},
  };
}

async function run(
  mw: ReturnType<typeof createPolicyMiddleware>,
  ctx: InvocationContext,
): Promise<boolean> {
  let nextCalled = false;
  await mw(ctx, async () => {
    nextCalled = true;
  });
  return nextCalled;
}

describe('policy middleware — rea-subcommand tier reclassification (Defect E)', () => {
  // Post-Codex review: fully-trusted invocations require an absolute path
  // matching a known entry-point suffix (or `npx rea …`). Bare `rea …` is
  // PATH-spoofable and treated as weak trust — Read subcommands fall through
  // to the generic Bash Write default; destructive subcommands keep the
  // upgrade defensively.
  it('allows `/usr/local/bin/rea cache check` at L0 (Read tier)', async () => {
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L0));
    const ctx = bashCtx('/usr/local/bin/rea cache check abc --branch feat/x --base main');
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
    expect(ctx.tier).toBe(Tier.Read);
  });

  it('denies `npx rea doctor` at L0 (weak trust post-pass-3 — no Read downgrade)', async () => {
    // Pass-3 Codex Finding 2: `npx` on a cache-cold machine is download +
    // install + execute, which is not Read-tier. `npx rea …` is now weak-trust
    // just like bare `rea`; L0 agents must use an absolute install path
    // (`/usr/local/bin/rea`, `/…/node_modules/.bin/rea`) to get the Read
    // downgrade.
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L0));
    const ctx = bashCtx('npx rea doctor');
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('denies bare `rea cache check` at L0 (weak trust, no downgrade)', async () => {
    // Weak-trust invocations no longer downgrade to Read — an L0 agent must
    // use npx or an absolute path. This closes PATH-spoofing attacks where
    // `./rea` or a malicious shim earlier on PATH could impersonate rea.
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L0));
    const ctx = bashCtx('rea cache check abc --branch feat/x --base main');
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('allows `/usr/local/bin/rea audit record codex-review ...` at L1 (Read tier)', async () => {
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L1));
    const ctx = bashCtx(
      '/usr/local/bin/rea audit record codex-review --head-sha abc --branch feat/x --target main --verdict pass --finding-count 0',
    );
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.tier).toBe(Tier.Read);
  });

  it('allows `/usr/local/bin/rea cache set ... pass` at L1 (Write tier)', async () => {
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L1));
    const ctx = bashCtx('/usr/local/bin/rea cache set abc pass --branch feat/x --base main');
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.tier).toBe(Tier.Write);
  });

  it('denies `rea freeze` at L1 even under weak trust (Destructive upgrade preserved)', async () => {
    // Critical: weak-trust bare `rea` STILL classifies `freeze` as Destructive
    // so the L1 ceiling blocks it, regardless of whether the binary on PATH
    // is provably ours. Otherwise `rea freeze` at L1 would fall through to
    // the generic Bash Write default — a regression.
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L1));
    const ctx = bashCtx('rea freeze --reason "stopping"');
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.tier).toBe(Tier.Destructive);
  });

  it('denies `/usr/local/bin/rea freeze` at L1 (Destructive exceeds ceiling)', async () => {
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L1));
    const ctx = bashCtx('/usr/local/bin/rea freeze --reason "stopping"');
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.tier).toBe(Tier.Destructive);
  });
});

describe('policy middleware — Bash deny-reason composition (Defect E)', () => {
  it('includes "rea freeze" subcommand in deny message', async () => {
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L1));
    const ctx = bashCtx('rea freeze --reason "stop"');
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toContain('rea freeze');
    expect(ctx.error).not.toMatch(/^Autonomy level L1 does not allow \S+-tier tools\. Tool: Bash$/);
  });

  it('sets reason_code=tier_exceeds_autonomy metadata on tier denies', async () => {
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L1));
    const ctx = bashCtx('rea freeze --reason x');
    await run(mw, ctx);
    expect(ctx.metadata['reason_code']).toBe('tier_exceeds_autonomy');
  });

  it('includes truncated non-rea Bash command in deny message', async () => {
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L0));
    const cmd = 'npm install --save-dev some-package';
    const ctx = bashCtx(cmd);
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toContain('Bash (');
    expect(ctx.error).toContain('npm install');
  });

  it('truncates overly long Bash commands in deny message', async () => {
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L0));
    const longCmd = 'npm install ' + 'x'.repeat(500);
    const ctx = bashCtx(longCmd);
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toBeDefined();
    expect(ctx.error!.length).toBeLessThan(longCmd.length);
  });
});

describe('policy middleware — live policy reload (existing behavior preserved)', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-policy-mw-'));
    baseDir = await fs.realpath(baseDir);
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  async function writePolicyFile(level: AutonomyLevel): Promise<void> {
    const yaml = [
      'version: "1"',
      'profile: "minimal"',
      'installed_by: "tester"',
      'installed_at: "2026-04-21T00:00:00Z"',
      `autonomy_level: ${level}`,
      'max_autonomy_level: L3',
      'promotion_requires_human_approval: true',
      'block_ai_attribution: true',
      'blocked_paths: []',
      'notification_channel: ""',
      '',
    ].join('\n');
    await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
  }

  it('rea-subcommand classification survives policy live-reload', async () => {
    await writePolicyFile(AutonomyLevel.L1);
    const mw = createPolicyMiddleware(stubPolicy(AutonomyLevel.L1), undefined, baseDir);

    const ctx = bashCtx('/usr/local/bin/rea cache check abc --branch feat/x --base main');
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.tier).toBe(Tier.Read);
  });
});
