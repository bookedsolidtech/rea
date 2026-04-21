/**
 * Defect H (rea#79) regression tests — dot-anchored blocked-path patterns.
 *
 * Background: the default always-blocked list includes `.rea/`. Before the
 * fix, `matchesBlockedPattern()` performed segment-suffix matching which
 * caused `.rea/` to trip on `Projects/rea/Bug Reports/note.md` (any folder
 * named `rea` without a leading dot). This silently blocked all Obsidian-
 * style project folders that happened to share the governance directory's
 * name.
 *
 * Expected behavior after the fix:
 *   - A pattern whose base starts with `.` (e.g. `.rea/`, `.env`, `.husky/`)
 *     only matches leading-dot filesystem entries.
 *   - `rea/` (no leading dot) still matches bare `rea/` anywhere per
 *     segment-suffix semantics — operators who WANT that behavior opt in by
 *     dropping the dot.
 *   - `.rea` as a file (no trailing slash) still exact-matches `.rea` as a
 *     file but not as a directory component.
 */

import { describe, expect, it } from 'vitest';
import { createBlockedPathsMiddleware } from '../../src/gateway/middleware/blocked-paths.js';
import type { InvocationContext } from '../../src/gateway/middleware/chain.js';
import { AutonomyLevel, InvocationStatus, type Policy } from '../../src/policy/types.js';

function stubPolicy(blocked: string[]): Policy {
  return {
    version: '1',
    profile: 'test',
    installed_by: 'test',
    installed_at: '2026-04-21',
    autonomy_level: AutonomyLevel.L1,
    max_autonomy_level: AutonomyLevel.L2,
    promotion_requires_human_approval: true,
    block_ai_attribution: true,
    blocked_paths: blocked,
    notification_channel: '',
  };
}

function ctxFor(filePath: string, tool = 'Write'): InvocationContext {
  return {
    tool_name: tool,
    server_name: 'local',
    arguments: { file_path: filePath },
    session_id: 's',
    status: InvocationStatus.Allowed,
    start_time: Date.now(),
    metadata: {},
  };
}

async function run(
  mw: ReturnType<typeof createBlockedPathsMiddleware>,
  ctx: InvocationContext,
): Promise<boolean> {
  let nextCalled = false;
  await mw(ctx, async () => {
    nextCalled = true;
  });
  return nextCalled;
}

describe('blocked-paths dot-anchor — .rea/ vs rea/ boundary', () => {
  it('blocks a write to .rea/policy.yaml (the intended target)', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy([]));
    const ctx = ctxFor('/project/.rea/policy.yaml');
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('ALLOWS a write to Projects/rea/Bug Reports/note.md (Obsidian folder spelled rea)', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy([]));
    const ctx = ctxFor('/Projects/rea/Bug Reports/note.md');
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('ALLOWS a write to a file literally named rea at repo root', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy([]));
    const ctx = ctxFor('/project/rea');
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('ALLOWS a path whose first segment is rea (relative, no leading dot)', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy([]));
    const ctx = ctxFor('rea/docs/architecture.md');
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
  });

  it('blocks .rea/ at any depth (nested monorepo package)', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy([]));
    const ctx = ctxFor('/project/packages/tools/.rea/policy.yaml');
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });
});

describe('blocked-paths dot-anchor — user-supplied dot patterns', () => {
  it('.husky/ blocks .husky/pre-push but NOT husky/pre-push', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.husky/']));

    const blocked = ctxFor('/project/.husky/pre-push');
    await run(mw, blocked);
    expect(blocked.status).toBe(InvocationStatus.Denied);

    const allowed = ctxFor('/project/husky/pre-push');
    const nextCalled = await run(mw, allowed);
    expect(nextCalled).toBe(true);
  });

  it('.env blocks a file named .env but NOT a file named env', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));

    const blocked = ctxFor('/project/.env');
    await run(mw, blocked);
    expect(blocked.status).toBe(InvocationStatus.Denied);

    const allowed = ctxFor('/project/env');
    const nextCalled = await run(mw, allowed);
    expect(nextCalled).toBe(true);
  });

  it('.env does not block a file named environment.config.ts', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = ctxFor('/project/src/environment.config.ts');
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
  });
});

describe('blocked-paths dot-anchor — non-dot patterns unchanged', () => {
  it('rea/ (no dot) still blocks any rea/ segment — operator opt-in', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['rea/']));
    const ctx = ctxFor('/Projects/rea/note.md');
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('node_modules/ still matches via segment-suffix semantics', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['node_modules/']));
    const ctx = ctxFor('/project/packages/a/node_modules/lodash/index.js');
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });
});
