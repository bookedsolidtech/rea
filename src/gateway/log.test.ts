import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { buildRegexRedactor, createLogger, resolveLogLevel } from './log.js';
import { SECRET_PATTERNS } from './middleware/redact.js';

/**
 * Collect every chunk written to a stream into an array of UTF-8 strings.
 * Used instead of PassThrough so we can flip `isTTY` freely.
 */
class CaptureStream extends Writable {
  public readonly chunks: string[] = [];
  public override isTTY = false;

  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    cb();
  }
}

function fixedClock(iso: string): () => number {
  const ms = Date.parse(iso);
  return () => ms;
}

describe('resolveLogLevel', () => {
  it('defaults to info when the env var is undefined', () => {
    expect(resolveLogLevel(undefined)).toBe('info');
  });

  it('normalizes known levels case-insensitively', () => {
    expect(resolveLogLevel('DEBUG')).toBe('debug');
    expect(resolveLogLevel(' Warn ')).toBe('warn');
    expect(resolveLogLevel('error')).toBe('error');
  });

  it('falls back to info on unknown values (never throws)', () => {
    expect(resolveLogLevel('chatty')).toBe('info');
    expect(resolveLogLevel('')).toBe('info');
  });
});

describe('logger — JSON mode', () => {
  it('emits a parseable JSON line with timestamp, level, event, message', () => {
    const stream = new CaptureStream();
    const log = createLogger({
      stream,
      mode: 'json',
      now: fixedClock('2026-04-18T10:00:00Z'),
      level: 'info',
    });

    log.info({ event: 'downstream.connect', server_name: 'slack', message: 'connected' });

    expect(stream.chunks.length).toBe(1);
    const line = stream.chunks[0]!.trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['event']).toBe('downstream.connect');
    expect(parsed['server_name']).toBe('slack');
    expect(parsed['message']).toBe('connected');
    expect(parsed['timestamp']).toBe('2026-04-18T10:00:00.000Z');
  });

  it('filters records below the minimum level', () => {
    const stream = new CaptureStream();
    const log = createLogger({ stream, mode: 'json', level: 'warn' });

    log.debug({ event: 'debug.noise', message: 'ignored' });
    log.info({ event: 'info.noise', message: 'ignored' });
    log.warn({ event: 'warn.kept', message: 'kept' });
    log.error({ event: 'error.kept', message: 'kept' });

    expect(stream.chunks.length).toBe(2);
    const first = JSON.parse(stream.chunks[0]!) as { event: string };
    const second = JSON.parse(stream.chunks[1]!) as { event: string };
    expect(first.event).toBe('warn.kept');
    expect(second.event).toBe('error.kept');
  });

  it('survives an unserializable field without throwing', () => {
    const stream = new CaptureStream();
    const log = createLogger({ stream, mode: 'json', level: 'info' });

    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;

    expect(() => log.info({ event: 'weird', message: 'test', cyclic })).not.toThrow();

    // A fallback line is still emitted.
    expect(stream.chunks.length).toBe(1);
    const parsed = JSON.parse(stream.chunks[0]!) as { event: string; message: string };
    expect(parsed.event).toBe('weird');
  });

  it('merges base fields from child() into every record', () => {
    const stream = new CaptureStream();
    const root = createLogger({ stream, mode: 'json', level: 'info' });
    const child = root.child({ session_id: 'abc-123' });

    child.info({ event: 'x', message: 'y' });

    const parsed = JSON.parse(stream.chunks[0]!) as { session_id: string };
    expect(parsed.session_id).toBe('abc-123');
  });
});

describe('logger — pretty mode (TTY)', () => {
  it('prints the [rea-serve] prefix so helix grep still matches', () => {
    const stream = new CaptureStream();
    stream.isTTY = true;
    const log = createLogger({ stream, level: 'info' });

    log.info({ event: 'session.start', message: 'hello' });

    expect(stream.chunks.length).toBe(1);
    const line = stream.chunks[0]!;
    expect(line).toContain('[rea-serve]');
    expect(line).toContain('session.start');
    expect(line).toContain('hello');
  });

  it('auto-selects json mode for a non-TTY stream', () => {
    const stream = new CaptureStream();
    stream.isTTY = false;
    const log = createLogger({ stream, level: 'info' });

    log.info({ event: 'e', message: 'm' });

    // A JSON line is parseable; a pretty line is not.
    const line = stream.chunks[0]!.trim();
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('pretty mode: a cyclic extra field is rendered as [unserializable] without dropping the record', () => {
    const stream = new CaptureStream();
    stream.isTTY = true;
    const log = createLogger({ stream, level: 'info' });

    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;

    expect(() =>
      log.info({ event: 'weird', message: 'test', cyclic }),
    ).not.toThrow();

    // The record must still reach the stream. Previously the pretty-mode
    // JSON.stringify on `cyclic` would throw and the whole line was dropped.
    expect(stream.chunks.length).toBe(1);
    const line = stream.chunks[0]!;
    expect(line).toContain('[rea-serve]');
    expect(line).toContain('weird');
    expect(line).toContain('test');
    // The unserializable field renders as the stable sentinel.
    expect(line).toContain('[unserializable]');
  });
});

describe('buildRegexRedactor', () => {
  it('replaces SECRET_PATTERNS matches with [REDACTED]', () => {
    const redact = buildRegexRedactor(SECRET_PATTERNS);

    // Known shapes from SECRET_PATTERNS:
    //   - AWS access key: AKIA + 16 uppercase alphanum
    //   - GitHub personal access token: ghp_ + ≥36 alphanum
    //   - Anthropic API key: sk-ant- + ≥32 alphanum
    const aws = 'AKIA' + 'A'.repeat(16);
    const gh = 'ghp_' + 'a'.repeat(40);
    const ant = 'sk-ant-' + 'a'.repeat(40);

    expect(redact(`leak: ${aws}`)).toBe('leak: [REDACTED]');
    expect(redact(`leak: ${gh}`)).toBe('leak: [REDACTED]');
    expect(redact(`leak: ${ant}`)).toBe('leak: [REDACTED]');
  });

  it('redacts multiple occurrences of the same pattern in one string', () => {
    const redact = buildRegexRedactor(SECRET_PATTERNS);
    const a = 'AKIA' + 'A'.repeat(16);
    const b = 'AKIA' + 'B'.repeat(16);
    const out = redact(`first ${a} and second ${b} keys`);
    expect(out).toBe('first [REDACTED] and second [REDACTED] keys');
  });

  it('is idempotent: redacting an already-redacted string does not corrupt it', () => {
    const redact = buildRegexRedactor(SECRET_PATTERNS);
    const clean = 'nothing sensitive here';
    expect(redact(clean)).toBe(clean);
    const once = redact(`leak: AKIA${'A'.repeat(16)}`);
    expect(redact(once)).toBe(once);
  });

  it('leaves non-secret strings unchanged', () => {
    const redact = buildRegexRedactor(SECRET_PATTERNS);
    expect(redact('connected to downstream slack')).toBe('connected to downstream slack');
    expect(redact('autonomy_level=L1 profile=bst-internal')).toBe(
      'autonomy_level=L1 profile=bst-internal',
    );
  });

  it('logger integration: redacts a secret in a log field before serialization', () => {
    const stream = new CaptureStream();
    const log = createLogger({
      stream,
      mode: 'json',
      level: 'info',
      redactField: buildRegexRedactor(SECRET_PATTERNS),
    });

    const secret = 'AKIA' + 'A'.repeat(16);
    log.error({
      event: 'downstream.error',
      message: `child process died with env AWS_KEY=${secret}`,
    });

    const parsed = JSON.parse(stream.chunks[0]!) as { message: string };
    expect(parsed.message).not.toContain('AKIA');
    expect(parsed.message).toContain('[REDACTED]');
  });

  it('logger integration: a redactor that throws falls back to [redactor-error] instead of crashing the logger', () => {
    const stream = new CaptureStream();
    const log = createLogger({
      stream,
      mode: 'json',
      level: 'info',
      redactField: () => {
        throw new Error('boom');
      },
    });

    expect(() => log.info({ event: 'e', message: 'normally-safe' })).not.toThrow();
    const parsed = JSON.parse(stream.chunks[0]!) as { message: string };
    expect(parsed.message).toBe('[redactor-error]');
  });

  it('logger integration: child() loggers inherit the parent redactor', () => {
    const stream = new CaptureStream();
    const root = createLogger({
      stream,
      mode: 'json',
      level: 'info',
      redactField: buildRegexRedactor(SECRET_PATTERNS),
    });
    const child = root.child({ session_id: 'abc-123' });

    const secret = 'ghp_' + 'a'.repeat(40);
    child.info({ event: 'x', message: `token=${secret}` });
    const parsed = JSON.parse(stream.chunks[0]!) as { message: string; session_id: string };
    expect(parsed.session_id).toBe('abc-123');
    expect(parsed.message).toContain('[REDACTED]');
    expect(parsed.message).not.toContain('ghp_');
  });
});
