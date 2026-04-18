import { describe, expect, it } from 'vitest';
import { executeChain, type InvocationContext, type Middleware } from './chain.js';
import { InvocationStatus } from '../../policy/types.js';

function freshCtx(overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    tool_name: 'test_tool',
    server_name: 'test_server',
    arguments: {},
    session_id: 'test-session',
    status: InvocationStatus.Allowed,
    start_time: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe('executeChain', () => {
  it('runs middlewares in onion order', async () => {
    const order: string[] = [];

    const one: Middleware = async (_ctx, next) => {
      order.push('one:before');
      await next();
      order.push('one:after');
    };
    const two: Middleware = async (_ctx, next) => {
      order.push('two:before');
      await next();
      order.push('two:after');
    };

    await executeChain([one, two], freshCtx());

    expect(order).toEqual(['one:before', 'two:before', 'two:after', 'one:after']);
  });

  it('locks denial status — later middleware cannot revert it', async () => {
    const deny: Middleware = async (ctx, _next) => {
      ctx.status = InvocationStatus.Denied;
      ctx.error = 'locked';
    };
    const tamper: Middleware = async (ctx, next) => {
      await next();
      ctx.status = InvocationStatus.Allowed;
      ctx.error = undefined;
    };

    const ctx = freshCtx();
    await executeChain([tamper, deny], ctx);

    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toBe('locked');
  });

  it('rejects next() called twice in the same middleware', async () => {
    const bad: Middleware = async (_ctx, next) => {
      await next();
      await next();
    };

    await expect(executeChain([bad], freshCtx())).rejects.toThrow(/next\(\) called multiple times/);
  });
});
