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

  // ─────────────────────────── baseline semantics ───────────────────────────

  it('allows when HALT is absent', async () => {
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();
    let nextCalled = false;
    await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
    expect(ctx.metadata.halt_decision).toBe('absent');
    expect(ctx.metadata.halt_at_invocation).toBeNull();
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
    expect(ctx.metadata.halt_decision).toBe('present');
    expect(typeof ctx.metadata.halt_at_invocation).toBe('string');
    // ISO-8601 (roughly)
    expect(ctx.metadata.halt_at_invocation as string).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it('denies when HALT is a directory (platform-dependent path, deny is invariant)', async () => {
    await fs.mkdir(path.join(baseDir, '.rea', 'HALT'));
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();
    await mw(ctx, async () => {
      throw new Error('next should not be called');
    });
    expect(ctx.status).toBe(InvocationStatus.Denied);
    // On Linux, open() on a directory succeeds → decision 'present'; read fails
    //   → generic "HALT present" message.
    // On macOS, open() on a directory fails with EISDIR → decision 'unknown' →
    //   fail-closed denial.
    expect(ctx.metadata.halt_decision).toMatch(/^(present|unknown)$/);
    expect(ctx.error ?? '').toMatch(/Kill switch/);
  });

  it('caps HALT read size', async () => {
    const hugeReason = 'x'.repeat(4096);
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), hugeReason, 'utf8');
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();
    await mw(ctx, async () => {
      throw new Error('next should not be called');
    });
    expect(ctx.status).toBe(InvocationStatus.Denied);
    // Error message must not include the full 4096 bytes
    expect((ctx.error ?? '').length).toBeLessThan(2048);
    expect(ctx.metadata.halt_decision).toBe('present');
  });

  // ─────────────────────── G4 — atomicity & semantics ───────────────────────

  it('G4: HALT created between chain start and terminal does NOT cancel the invocation', async () => {
    // HALT is absent when kill-switch runs. Then, BEFORE the terminal runs,
    // the test creates HALT. The invocation must still complete successfully
    // because HALT is read exactly once, at chain entry.
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();

    let terminalRan = false;
    await mw(ctx, async () => {
      // Simulate the downstream chain + terminal: create HALT mid-flight, then
      // "execute". A well-behaved kill-switch must NOT re-check.
      await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'created mid-invocation\n', 'utf8');
      // yield a tick to let any (buggy) watcher fire
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      terminalRan = true;
    });

    expect(terminalRan).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
    expect(ctx.metadata.halt_decision).toBe('absent');
    expect(ctx.metadata.halt_at_invocation).toBeNull();
  });

  it('G4: HALT removed mid-invocation does NOT rescue a denied call', async () => {
    // HALT is present at entry → deny. If the test removes HALT immediately
    // after, the denial must stand: the terminal never runs.
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'freeze\n', 'utf8');
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();

    let terminalRan = false;
    await mw(ctx, async () => {
      terminalRan = true;
    });

    // Simulate the operator removing HALT *after* the middleware already
    // returned the denial. The denial is already final.
    await fs.rm(path.join(baseDir, '.rea', 'HALT'));

    expect(terminalRan).toBe(false);
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.metadata.halt_decision).toBe('present');
  });

  it('G4: decisions are per-invocation, never cached across invocations', async () => {
    const mw = createKillSwitchMiddleware(baseDir);

    // Invocation 1 — HALT present → deny.
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'round 1\n', 'utf8');
    const ctx1 = freshCtx();
    await mw(ctx1, async () => {
      throw new Error('next should not be called');
    });
    expect(ctx1.status).toBe(InvocationStatus.Denied);
    expect(ctx1.metadata.halt_decision).toBe('present');

    // HALT removed.
    await fs.rm(path.join(baseDir, '.rea', 'HALT'));

    // Invocation 2 — HALT absent → allow. Proves no caching.
    const ctx2 = freshCtx();
    let nextCalled = false;
    await mw(ctx2, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(ctx2.status).toBe(InvocationStatus.Allowed);
    expect(ctx2.metadata.halt_decision).toBe('absent');
  });

  it('G4: ENOENT → next() runs (regression)', async () => {
    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();
    let nextCalled = false;
    await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
    expect(ctx.metadata.halt_decision).toBe('absent');
  });

  it('G4: non-ENOENT errno fails closed (EACCES simulated)', async () => {
    // Simulate a filesystem error that is NOT ENOENT by pointing baseDir at a
    // path we do not have permission to read. We do this by creating HALT with
    // mode 0o000 and reading it as the invoking user — on POSIX this yields
    // EACCES on open. Root skips permission checks; on CI we run as non-root,
    // so this is a reliable signal. If the assertion cannot hold (e.g. running
    // as root), the test short-circuits to the generic "not allowed" assertion.
    const haltPath = path.join(baseDir, '.rea', 'HALT');
    await fs.writeFile(haltPath, 'locked\n', 'utf8');
    await fs.chmod(haltPath, 0o000);

    const mw = createKillSwitchMiddleware(baseDir);
    const ctx = freshCtx();

    try {
      let terminalRan = false;
      await mw(ctx, async () => {
        terminalRan = true;
      });

      // Restore perms so afterEach can clean up.
      await fs.chmod(haltPath, 0o600).catch(() => {});

      // Two acceptable outcomes depending on privilege level:
      //   - Non-root (typical CI): open EACCES → halt_decision = 'unknown', denied, terminal skipped.
      //   - Root (rare): open succeeds → halt_decision = 'present', denied, terminal skipped.
      // Either way, the terminal MUST NOT run.
      expect(terminalRan).toBe(false);
      expect(ctx.status).toBe(InvocationStatus.Denied);
      expect(ctx.metadata.halt_decision).toMatch(/^(unknown|present)$/);
      if (ctx.metadata.halt_decision === 'unknown') {
        expect(ctx.error ?? '').toMatch(/Kill switch check failed/);
      }
    } finally {
      await fs.chmod(haltPath, 0o600).catch(() => {});
    }
  });

  it('G4: concurrency — 10 invocations observe the state at THEIR own chain entry', async () => {
    const mw = createKillSwitchMiddleware(baseDir);

    // Two batches of 5 invocations, flipped across a HALT toggle. Each
    // invocation must reflect the state at its OWN chain entry — not a cached
    // snapshot, not the state of a sibling.
    async function runInvocation(): Promise<InvocationContext> {
      const ctx = freshCtx();
      let terminalRan = false;
      await mw(ctx, async () => {
        terminalRan = true;
      });
      // Record whether the terminal actually ran for later cross-check.
      ctx.metadata.terminal_ran = terminalRan;
      return ctx;
    }

    // Batch 1: HALT absent at entry → all 5 should allow.
    const batch1 = await Promise.all(Array.from({ length: 5 }, () => runInvocation()));

    // Toggle: HALT now present.
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'batch 2\n', 'utf8');

    // Batch 2: HALT present at entry → all 5 should deny.
    const batch2 = await Promise.all(Array.from({ length: 5 }, () => runInvocation()));

    for (const ctx of batch1) {
      expect(ctx.status).toBe(InvocationStatus.Allowed);
      expect(ctx.metadata.halt_decision).toBe('absent');
      expect(ctx.metadata.terminal_ran).toBe(true);
    }
    for (const ctx of batch2) {
      expect(ctx.status).toBe(InvocationStatus.Denied);
      expect(ctx.metadata.halt_decision).toBe('present');
      expect(ctx.metadata.terminal_ran).toBe(false);
    }
  });

  // ─────────────────── G5 blocker #4 — metrics integration ───────────────────

  it('marks the halt-check gauge on every invocation (HALT absent path)', async () => {
    const { MetricsRegistry } = await import('../observability/metrics.js');
    const metrics = new MetricsRegistry();
    // Registry starts with a startup-time mark, so reset it explicitly to
    // the far past so we can detect a fresh per-call mark.
    metrics.markHaltCheck(0);
    const beforeSnap = metrics.snapshot();
    expect(beforeSnap.lastHaltCheckMs).toBe(0);

    const mw = createKillSwitchMiddleware(baseDir, metrics);
    const ctx = freshCtx();
    await mw(ctx, async () => {
      /* terminal */
    });

    const afterSnap = metrics.snapshot();
    // The middleware must have refreshed the gauge to a recent wall-clock
    // moment, regardless of whether HALT was absent.
    expect(afterSnap.lastHaltCheckMs).not.toBeNull();
    expect(afterSnap.lastHaltCheckMs).toBeGreaterThan(beforeSnap.lastHaltCheckMs ?? 0);
  });

  it('marks the halt-check gauge on the HALT-present (deny) path', async () => {
    const { MetricsRegistry } = await import('../observability/metrics.js');
    const metrics = new MetricsRegistry();
    metrics.markHaltCheck(0);

    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'denied\n', 'utf8');
    const mw = createKillSwitchMiddleware(baseDir, metrics);
    const ctx = freshCtx();
    await mw(ctx, async () => {
      throw new Error('next should not be called');
    });

    expect(ctx.status).toBe(InvocationStatus.Denied);
    const snap = metrics.snapshot();
    // The gauge is marked BEFORE the fs.open — denial does not skip the mark.
    expect(snap.lastHaltCheckMs).not.toBeNull();
    expect(snap.lastHaltCheckMs).toBeGreaterThan(0);
  });

  it('swallows an infallible metrics failure without changing middleware behavior', async () => {
    // A registry whose markHaltCheck throws must not take down the chain.
    const brokenMetrics = {
      markHaltCheck(): void {
        throw new Error('metrics boom');
      },
    } as unknown as import('../observability/metrics.js').MetricsRegistry;

    const mw = createKillSwitchMiddleware(baseDir, brokenMetrics);
    const ctx = freshCtx();
    let nextCalled = false;
    await expect(
      mw(ctx, async () => {
        nextCalled = true;
      }),
    ).resolves.not.toThrow();
    expect(nextCalled).toBe(true);
    expect(ctx.metadata.halt_decision).toBe('absent');
  });
});
