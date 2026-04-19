import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, resolveLogLevel } from './log.js';

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
});
