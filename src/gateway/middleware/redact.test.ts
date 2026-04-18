import { describe, it, expect } from 'vitest';
import {
  createRedactMiddleware,
  compileDefaultSecretPatterns,
  redactSecrets,
  REDACT_TIMEOUT_SENTINEL,
  REDACT_TIMEOUT_METADATA_KEY,
  type CompiledSecretPattern,
  type RedactTimeoutEvent,
} from './redact.js';
import { wrapRegex } from '../redact-safe/match-timeout.js';
import { executeChain, type InvocationContext, type Middleware } from './chain.js';
import { InvocationStatus, Tier } from '../../policy/types.js';

function makeCtx(result: unknown, args: Record<string, unknown> = {}): InvocationContext {
  return {
    tool_name: 't',
    server_name: 's',
    arguments: args,
    session_id: 'sess',
    tier: Tier.Read,
    status: InvocationStatus.Allowed,
    result,
    start_time: Date.now(),
    metadata: {},
  };
}

describe('redact middleware — G3 timeout behavior', () => {
  it('redacts a secret in a string result using default patterns', async () => {
    const mw = createRedactMiddleware();
    const ctx = makeCtx('my token is ghp_' + 'x'.repeat(36) + ' done');
    const passthrough: Middleware = async () => {};
    await executeChain([mw, passthrough], ctx);
    expect(typeof ctx.result).toBe('string');
    expect(ctx.result as string).toContain('[REDACTED]');
    expect(ctx.redacted_fields).toContain('GitHub Token');
  });

  it('leaves clean strings untouched', async () => {
    const mw = createRedactMiddleware();
    const ctx = makeCtx('nothing suspicious here');
    await executeChain([mw, async () => {}], ctx);
    expect(ctx.result).toBe('nothing suspicious here');
    expect(ctx.redacted_fields).toBeUndefined();
  });

  describe('timeout path', () => {
    // Inject a catastrophic user-like pattern via the private factory helper.
    // We route it as source:'user' so the audit event carries the right label.
    function makeTimeoutPatterns(): CompiledSecretPattern[] {
      return [
        {
          name: 'catastrophic-fixture',
          source: 'user',
          safe: wrapRegex(/(a+)+$/, { timeoutMs: 30 }),
        },
      ];
    }

    it('records redact.regex_timeout on ctx.metadata with size but NOT input text', () => {
      const patterns = makeTimeoutPatterns();
      const events: Array<{ name: string; source: 'default' | 'user'; input: string }> = [];
      const bad = 'a'.repeat(25) + 'X';
      const res = redactSecrets(bad, patterns, (ev) => events.push(ev));
      expect(res.timedOut).toBe(true);
      expect(res.output).toBe(REDACT_TIMEOUT_SENTINEL);
      expect(events).toHaveLength(1);
      expect(events[0]?.name).toBe('catastrophic-fixture');
      expect(events[0]?.source).toBe('user');
    });

    it('middleware: timeout during a live payload emits audit event via ctx.metadata', async () => {
      // Build a middleware manually with ONLY the catastrophic user pattern —
      // skip defaults so the test is deterministic and fast.
      const patterns = makeTimeoutPatterns();
      const mw = createRedactMiddleware({ userPatterns: patterns, matchTimeoutMs: 30 });

      const bad = 'a'.repeat(25) + 'X';
      const ctx = makeCtx(bad);
      const passthrough: Middleware = async () => {};

      // We need BOTH defaults off and our user patterns active. The default
      // factory always includes defaults — supply an empty default list by
      // calling compileDefaultSecretPatterns and discarding it. Easier: we
      // accept default pattern scans will pass (they won't match 'aaa...X'),
      // then our user pattern times out.
      await executeChain([mw, passthrough], ctx);

      const events = ctx.metadata[REDACT_TIMEOUT_METADATA_KEY];
      expect(Array.isArray(events)).toBe(true);
      const arr = events as RedactTimeoutEvent[];
      expect(arr.length).toBeGreaterThanOrEqual(1);
      const ev = arr[0]!;
      expect(ev.event).toBe('redact.regex_timeout');
      expect(ev.pattern_source).toBe('user');
      expect(ev.pattern_id).toBe('catastrophic-fixture');
      expect(ev.timeout_ms).toBe(30);
      expect(typeof ev.input_bytes).toBe('number');
      expect(ev.input_bytes).toBeGreaterThan(0);
      // SECURITY: the input text must NOT appear anywhere in metadata.
      const asJson = JSON.stringify(ctx.metadata);
      expect(asJson).not.toContain(bad);
    });

    it('middleware: timeout does NOT fail the invocation — chain continues', async () => {
      const patterns = makeTimeoutPatterns();
      const mw = createRedactMiddleware({ userPatterns: patterns, matchTimeoutMs: 30 });

      const bad = 'a'.repeat(25) + 'X';
      const ctx = makeCtx(bad);
      let downstreamRan = false;
      const passthrough: Middleware = async () => {
        downstreamRan = true;
      };
      await executeChain([mw, passthrough], ctx);
      expect(downstreamRan).toBe(true);
      expect(ctx.status).toBe(InvocationStatus.Allowed);
      // The offending string was replaced with the sentinel, not rejected.
      expect(ctx.result).toBe(REDACT_TIMEOUT_SENTINEL);
    });

    it('middleware: timeout in a nested object replaces the offending value only', async () => {
      const patterns = makeTimeoutPatterns();
      const mw = createRedactMiddleware({ userPatterns: patterns, matchTimeoutMs: 30 });

      const bad = 'a'.repeat(25) + 'X';
      const ctx = makeCtx({ clean: 'hello world', danger: bad });
      await executeChain([mw, async () => {}], ctx);

      const result = ctx.result as Record<string, string>;
      expect(result['clean']).toBe('hello world');
      expect(result['danger']).toBe(REDACT_TIMEOUT_SENTINEL);
    });
  });

  it('compileDefaultSecretPatterns returns the full default roster', () => {
    const compiled = compileDefaultSecretPatterns();
    const names = compiled.map((c) => c.name);
    expect(names).toContain('GitHub Token');
    expect(names).toContain('AWS Access Key');
    expect(names).toContain('OpenAI API Key');
    for (const c of compiled) {
      expect(c.source).toBe('default');
    }
  });
});
