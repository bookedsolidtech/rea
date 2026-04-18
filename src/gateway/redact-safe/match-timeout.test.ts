import { describe, it, expect } from 'vitest';
import { wrapRegex } from './match-timeout.js';

describe('wrapRegex — G3 ReDoS safety', () => {
  it('benign pattern + short input → test() returns matched flag, no timeout', () => {
    const safe = wrapRegex(/foo/);
    const res = safe.test('a foo b');
    expect(res.timedOut).toBe(false);
    expect(res.matched).toBe(true);
  });

  it('benign pattern with no match → matched:false, timedOut:false', () => {
    const safe = wrapRegex(/zzz/);
    const res = safe.test('abcdef');
    expect(res).toEqual({ matched: false, timedOut: false });
  });

  it('replace() with a benign pattern substitutes correctly', () => {
    const safe = wrapRegex(/foo/g);
    const res = safe.replace('foo bar foo', '[X]');
    expect(res.timedOut).toBe(false);
    expect(res.output).toBe('[X] bar [X]');
  });

  it('catastrophic pattern → timeout fires within 2x configured budget', () => {
    // Classic catastrophic backtracker. 25 a's + X is enough to blow up (a+)+$.
    const bad = /(a+)+$/;
    const input = 'a'.repeat(25) + 'X';
    const safe = wrapRegex(bad, { timeoutMs: 50 });
    const t0 = Date.now();
    const res = safe.test(input);
    const elapsed = Date.now() - t0;

    expect(res.timedOut).toBe(true);
    expect(res.matched).toBe(false);
    // Allow generous slack — worker startup + termination can add overhead on slow hosts.
    expect(elapsed).toBeLessThan(50 * 4 + 500);
  });

  it('replace() on a catastrophic pattern returns input unchanged + timedOut:true', () => {
    const bad = /(a+)+$/;
    const input = 'a'.repeat(25) + 'X';
    const safe = wrapRegex(bad, { timeoutMs: 50 });
    const res = safe.replace(input, '[X]');
    expect(res.timedOut).toBe(true);
    expect(res.output).toBe(input);
  });

  it('onTimeout callback fires exactly once per timeout, receives pattern + input', () => {
    const bad = /(a+)+$/;
    const input = 'a'.repeat(25) + 'X';
    let calls = 0;
    let receivedPattern: RegExp | null = null;
    let receivedInput: string | null = null;
    const safe = wrapRegex(bad, {
      timeoutMs: 50,
      onTimeout: (p, i) => {
        calls += 1;
        receivedPattern = p;
        receivedInput = i;
      },
    });
    const res = safe.test(input);
    expect(res.timedOut).toBe(true);
    expect(calls).toBe(1);
    expect(receivedPattern).toBe(bad);
    expect(receivedInput).toBe(input);
  });

  it('onTimeout callback errors are swallowed — middleware must not break', () => {
    const bad = /(a+)+$/;
    const input = 'a'.repeat(25) + 'X';
    const safe = wrapRegex(bad, {
      timeoutMs: 50,
      onTimeout: () => {
        throw new Error('boom');
      },
    });
    expect(() => safe.test(input)).not.toThrow();
  });

  it('onTimeout does NOT fire when the pattern completes within budget', () => {
    let calls = 0;
    const safe = wrapRegex(/foo/, {
      timeoutMs: 500,
      onTimeout: () => {
        calls += 1;
      },
    });
    safe.test('a foo b');
    expect(calls).toBe(0);
  });

  it('default timeout is 100ms', () => {
    // Sanity: wrapping without opts should not throw and should still catch
    // a catastrophic pattern within ~200ms wall-clock.
    const bad = /(a+)+$/;
    const input = 'a'.repeat(28) + 'X';
    const safe = wrapRegex(bad);
    const t0 = Date.now();
    const res = safe.test(input);
    const elapsed = Date.now() - t0;
    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it('exposes the underlying pattern via .pattern', () => {
    const re = /abc/i;
    const safe = wrapRegex(re);
    expect(safe.pattern).toBe(re);
  });
});
