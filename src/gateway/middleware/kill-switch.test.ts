import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKillSwitchMiddleware } from './kill-switch.js';
import type { InvocationContext } from './chain.js';
import { InvocationStatus } from '../../policy/types.js';

function freshCtx(): InvocationContext {
  return {
    tool_name: 't',
    server_name: 's',
    arguments: {},
    session_id: 'sess',
    status: InvocationStatus.Allowed,
    start_time: Date.now(),
    metadata: {},
  };
}

describe('kill-switch middleware', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-halt-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('allows when HALT is absent', async () => {
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();
    let nextCalled = false;
    await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('denies when HALT is present', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'smoke test reason\n', 'utf8');
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();
    await mw(ctx, async () => {
      throw new Error('next should not be called');
    });
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toContain('smoke test reason');
  });

  it('denies when HALT is a directory', async () => {
    await fs.mkdir(path.join(baseDir, '.rea', 'HALT'));
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();
    await mw(ctx, async () => {});
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toContain('non-file');
  });

  it('caps HALT read size', async () => {
    const hugeReason = 'x'.repeat(4096);
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), hugeReason, 'utf8');
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();
    await mw(ctx, async () => {});
    expect(ctx.status).toBe(InvocationStatus.Denied);
    // Error message must not include the full 4096 bytes
    expect((ctx.error ?? '').length).toBeLessThan(2048);
  });
});
