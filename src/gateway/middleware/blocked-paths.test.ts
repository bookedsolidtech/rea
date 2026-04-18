import { describe, expect, it } from 'vitest';
import { createBlockedPathsMiddleware } from './blocked-paths.js';
import type { InvocationContext } from './chain.js';
import { AutonomyLevel, InvocationStatus, type Policy } from '../../policy/types.js';

function stubPolicy(blocked: string[]): Policy {
  return {
    version: '1',
    profile: 'test',
    installed_by: 'test',
    installed_at: '2026-04-18',
    autonomy_level: AutonomyLevel.L1,
    max_autonomy_level: AutonomyLevel.L2,
    promotion_requires_human_approval: true,
    block_ai_attribution: true,
    blocked_paths: blocked,
    notification_channel: '',
  };
}

function freshCtx(args: Record<string, unknown>): InvocationContext {
  return {
    tool_name: 'Write',
    server_name: 'local',
    arguments: args,
    session_id: 's',
    status: InvocationStatus.Allowed,
    start_time: Date.now(),
    metadata: {},
  };
}

describe('blocked-paths middleware', () => {
  it('denies when an argument contains a blocked path', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ file_path: '/project/.env' });
    await mw(ctx, async () => {});
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toContain('.env');
  });

  it('always protects .rea/ regardless of policy', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy([]));
    const ctx = freshCtx({ file_path: '/project/.rea/policy.yaml' });
    await mw(ctx, async () => {});
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toContain('.rea/');
  });

  it('normalizes URL-encoded path separators', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ file_path: '/project%2F.env' });
    await mw(ctx, async () => {});
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('allows unrelated paths through', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ file_path: '/project/src/index.ts' });
    let nextCalled = false;
    await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });
});
