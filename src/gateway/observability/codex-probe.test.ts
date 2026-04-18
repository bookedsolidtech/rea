import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexProbe, type ExecFileFn } from './codex-probe.js';

/**
 * Build an exec stub that responds differently per invocation. The stub is
 * keyed on the first argument (so we can distinguish `--version` from
 * `catalog`). Unknown args throw a loud error so tests don't pass on a
 * branch they didn't intend to exercise.
 */
function routedExec(
  handlers: Partial<{
    version: () => Promise<{ stdout: string; stderr: string }>;
    catalog: () => Promise<{ stdout: string; stderr: string }>;
  }>,
): ExecFileFn {
  return vi.fn((_file, args) => {
    const first = args[0];
    if (first === '--version') {
      if (!handlers.version) {
        throw new Error('test did not stub --version');
      }
      return handlers.version();
    }
    if (first === 'catalog') {
      if (!handlers.catalog) {
        throw new Error('test did not stub catalog');
      }
      return handlers.catalog();
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  });
}

/** Build a timeout-style error that matches what execFile throws on timeout. */
function timeoutError(): Error {
  return Object.assign(new Error('killed'), { signal: 'SIGTERM' });
}

/** Build an ENOENT-style error that matches an uninstalled binary. */
function enoentError(): Error {
  return Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
}

describe('CodexProbe', () => {
  describe('probe()', () => {
    it('exit 0 on both probes → cli_responsive: true', async () => {
      const exec = routedExec({
        version: () => Promise.resolve({ stdout: 'codex 1.2.3\n', stderr: '' }),
        catalog: () => Promise.resolve({ stdout: '[]', stderr: '' }),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const state = await probe.probe();
      expect(state.cli_installed).toBe(true);
      expect(state.cli_authenticated).toBe(true);
      expect(state.cli_responsive).toBe(true);
      expect(state.version).toBe('codex 1.2.3');
      expect(state.last_error).toBeUndefined();
    });

    it('exit non-zero on --version → cli_installed: false, last_error populated', async () => {
      const exec = routedExec({
        version: () => Promise.reject(Object.assign(new Error('exit 1'), { code: 1 })),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const state = await probe.probe();
      expect(state.cli_installed).toBe(false);
      expect(state.cli_authenticated).toBe(false);
      expect(state.cli_responsive).toBe(false);
      expect(state.last_error).toBeDefined();
    });

    it('ENOENT on --version → last_error notes not installed', async () => {
      const exec = routedExec({
        version: () => Promise.reject(enoentError()),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const state = await probe.probe();
      expect(state.cli_installed).toBe(false);
      expect(state.last_error).toMatch(/not installed/i);
    });

    it('timeout on --version → last_error includes "timeout"', async () => {
      const exec = routedExec({
        version: () => Promise.reject(timeoutError()),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const state = await probe.probe();
      expect(state.cli_installed).toBe(false);
      expect(state.last_error).toMatch(/timeout/i);
    });

    it('version parsed from stdout', async () => {
      const exec = routedExec({
        version: () => Promise.resolve({ stdout: '  codex 0.9.1  \n', stderr: '' }),
        catalog: () => Promise.resolve({ stdout: '', stderr: '' }),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const state = await probe.probe();
      expect(state.version).toBe('codex 0.9.1');
    });

    it('unrecognized catalog subcommand → degraded-skip, authenticated if version succeeded', async () => {
      // This is the documented assumption in the module header: if Codex
      // doesn't ship `catalog --json`, we don't penalize the operator.
      const exec = routedExec({
        version: () => Promise.resolve({ stdout: 'codex 1.0.0', stderr: '' }),
        catalog: () =>
          Promise.reject(
            Object.assign(new Error("unknown command 'catalog'"), { code: 1 }),
          ),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const state = await probe.probe();
      expect(state.cli_installed).toBe(true);
      expect(state.cli_authenticated).toBe(true);
      expect(state.cli_responsive).toBe(true);
    });

    it('catalog fails with a genuine error → cli_responsive false, last_error populated', async () => {
      const exec = routedExec({
        version: () => Promise.resolve({ stdout: 'codex 1.0.0', stderr: '' }),
        catalog: () =>
          Promise.reject(
            Object.assign(new Error('401 unauthorized'), { code: 1 }),
          ),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const state = await probe.probe();
      expect(state.cli_installed).toBe(true);
      expect(state.cli_authenticated).toBe(false);
      expect(state.cli_responsive).toBe(false);
      expect(state.last_error).toMatch(/unauthorized/i);
    });

    it('catalog timeout → cli_responsive false with timeout note', async () => {
      const exec = routedExec({
        version: () => Promise.resolve({ stdout: 'codex 1.0.0', stderr: '' }),
        catalog: () => Promise.reject(timeoutError()),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const state = await probe.probe();
      expect(state.cli_authenticated).toBe(false);
      expect(state.last_error).toMatch(/timeout/i);
    });

    it('last_probe_at is populated with an ISO-8601 timestamp', async () => {
      const exec = routedExec({
        version: () => Promise.resolve({ stdout: 'codex 1.0.0', stderr: '' }),
        catalog: () => Promise.resolve({ stdout: '[]', stderr: '' }),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const state = await probe.probe();
      // Roundtripping through Date should preserve a valid ISO-8601.
      expect(() => new Date(state.last_probe_at).toISOString()).not.toThrow();
    });

    it('concurrent probe() calls share a single in-flight exec', async () => {
      let versionCalls = 0;
      let resolveVersion: ((v: { stdout: string; stderr: string }) => void) | undefined;
      const exec = routedExec({
        version: () =>
          new Promise((resolve) => {
            versionCalls += 1;
            resolveVersion = resolve;
          }),
        catalog: () => Promise.resolve({ stdout: '[]', stderr: '' }),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const p1 = probe.probe();
      const p2 = probe.probe();
      const p3 = probe.probe();
      // Only one version exec should have been kicked off even though three
      // callers awaited.
      expect(versionCalls).toBe(1);
      resolveVersion?.({ stdout: 'codex 1.0.0', stderr: '' });
      const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
      expect(s1.cli_installed).toBe(true);
      expect(s2).toEqual(s1);
      expect(s3).toEqual(s1);
    });

    it('getState() is safe before any probe', () => {
      const probe = new CodexProbe({ execFileFn: routedExec({}) });
      const state = probe.getState();
      expect(state.cli_responsive).toBe(false);
      expect(state.cli_installed).toBe(false);
      expect(state.cli_authenticated).toBe(false);
    });
  });

  describe('start() / stop() lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('start() schedules periodic probes; stop() cancels', async () => {
      let calls = 0;
      const exec: ExecFileFn = vi.fn((_file, args) => {
        if (args[0] === '--version') calls += 1;
        return Promise.resolve({ stdout: 'codex 1.0.0', stderr: '' });
      });
      const probe = new CodexProbe({ execFileFn: exec });
      probe.start(1_000);
      // Initial probe is fire-and-forget; drain microtasks.
      await vi.runOnlyPendingTimersAsync();
      const afterStart = calls;
      expect(afterStart).toBeGreaterThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(1_500);
      expect(calls).toBeGreaterThan(afterStart);

      probe.stop();
      const frozen = calls;
      await vi.advanceTimersByTimeAsync(5_000);
      // No further probes after stop.
      expect(calls).toBe(frozen);
    });

    it('start() is idempotent', async () => {
      const exec: ExecFileFn = vi
        .fn()
        .mockResolvedValue({ stdout: 'codex 1.0.0', stderr: '' });
      const probe = new CodexProbe({ execFileFn: exec });
      probe.start(10_000);
      probe.start(10_000); // second call must not install a second interval
      await vi.runOnlyPendingTimersAsync();
      // No assertion on exact call count; we only need to prove stop()
      // fully cleans up — a double-registered interval would survive it.
      probe.stop();
      const frozen = (exec as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect((exec as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
        frozen,
      );
    });

    it('stop() before start() is a no-op', () => {
      const probe = new CodexProbe({ execFileFn: routedExec({}) });
      expect(() => probe.stop()).not.toThrow();
    });
  });

  describe('onStateChange()', () => {
    it('fires only on a state transition, not every probe', async () => {
      const exec = routedExec({
        version: () => Promise.resolve({ stdout: 'codex 1.0.0', stderr: '' }),
        catalog: () => Promise.resolve({ stdout: '[]', stderr: '' }),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const listener = vi.fn();
      probe.onStateChange(listener);

      await probe.probe();
      expect(listener).toHaveBeenCalledTimes(1); // unknown → responsive

      await probe.probe();
      // Same state again — listener must not re-fire.
      expect(listener).toHaveBeenCalledTimes(1);

      await probe.probe();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires again when state transitions in either direction', async () => {
      let versionOk = true;
      const exec: ExecFileFn = vi.fn((_file, args) => {
        if (args[0] === '--version') {
          return versionOk
            ? Promise.resolve({ stdout: 'codex 1.0.0', stderr: '' })
            : Promise.reject(enoentError());
        }
        return Promise.resolve({ stdout: '[]', stderr: '' });
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const listener = vi.fn();
      probe.onStateChange(listener);

      await probe.probe();
      expect(listener).toHaveBeenCalledTimes(1);

      versionOk = false;
      await probe.probe();
      expect(listener).toHaveBeenCalledTimes(2);

      versionOk = true;
      await probe.probe();
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it('unsubscribe stops further deliveries', async () => {
      const exec = routedExec({
        version: () => Promise.resolve({ stdout: 'codex 1.0.0', stderr: '' }),
        catalog: () => Promise.resolve({ stdout: '[]', stderr: '' }),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      const listener = vi.fn();
      const off = probe.onStateChange(listener);
      await probe.probe();
      expect(listener).toHaveBeenCalledTimes(1);
      off();
      // Force a state transition so the remaining listener-free path fires.
      // Swap the exec to fail.
      (probe as unknown as { exec: ExecFileFn }).exec = () =>
        Promise.reject(enoentError());
      await probe.probe();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('listener errors do not break the probe', async () => {
      const exec = routedExec({
        version: () => Promise.resolve({ stdout: 'codex 1.0.0', stderr: '' }),
        catalog: () => Promise.resolve({ stdout: '[]', stderr: '' }),
      });
      const probe = new CodexProbe({ execFileFn: exec });
      probe.onStateChange(() => {
        throw new Error('listener boom');
      });
      await expect(probe.probe()).resolves.toBeDefined();
    });
  });
});
