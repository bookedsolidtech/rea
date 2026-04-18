import { InvocationStatus, type Tier } from '../../policy/types.js';

export interface InvocationContext {
  tool_name: string;
  server_name: string;
  arguments: Record<string, unknown>;
  session_id: string;
  tier?: Tier;
  status: InvocationStatus;
  error?: string;
  result?: unknown;
  start_time: number;
  redacted_fields?: string[];
  metadata: Record<string, unknown>;
}

export type NextFn = () => Promise<void>;
export type Middleware = (ctx: InvocationContext, next: NextFn) => Promise<void>;

/**
 * Execute a middleware chain in onion (koa-style) order.
 *
 * SECURITY: Once status is set to Denied, it is locked for the remainder
 * of the chain. No middleware can revert a denial.
 */
export function executeChain(
  middlewares: Middleware[],
  ctx: InvocationContext,
): Promise<void> {
  let index = -1;
  let deniedOnce = false;
  let savedError: string | undefined;

  function dispatch(i: number): Promise<void> {
    if (i <= index) {
      return Promise.reject(new Error('next() called multiple times'));
    }
    index = i;

    const mw = middlewares[i];
    if (!mw) {
      return Promise.resolve();
    }

    return Promise.resolve(mw(ctx, () => dispatch(i + 1))).then(() => {
      if (ctx.status === InvocationStatus.Denied && !deniedOnce) {
        deniedOnce = true;
        savedError = ctx.error;
      }

      if (deniedOnce && ctx.status !== InvocationStatus.Denied) {
        ctx.status = InvocationStatus.Denied;
        ctx.error = savedError ?? 'Denial status was tampered with — re-locked';
      }
    });
  }

  return dispatch(0);
}

/**
 * Type-safe factory for building named middleware chains.
 * Returns a function that executes the chain with a fresh context.
 */
export function createMiddlewareChain(middlewares: Middleware[]) {
  return (ctx: InvocationContext): Promise<void> => executeChain(middlewares, ctx);
}
