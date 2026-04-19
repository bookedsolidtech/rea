/**
 * Structured gateway logger (G5).
 *
 * Minimal JSON-lines logger for `rea serve` and its collaborators. The existing
 * codebase had `console.error`/`console.warn` scattered across the gateway;
 * that worked for humans tailing stderr but made logs impossible to parse for
 * future tooling (shipping to syslog, aggregating in a dashboard, greping
 * per-session).
 *
 * Design constraints (from the task spec):
 *
 *   1. NO dependency — pino would be overkill, and dep weight matters for an
 *      install-anywhere CLI. ~30 lines of hand-rolled code is enough.
 *   2. Respect `REA_LOG_LEVEL` (info default; debug for future verbose hooks).
 *   3. Pretty-print on a TTY stderr; emit JSON lines on non-TTY (CI, redirected
 *      stderr, process-supervised runs).
 *   4. Preserve the `[rea-serve]` / `[rea]` prefix convention — the helix smoke
 *      test greps for these. Pretty-mode prints them explicitly; JSON mode
 *      carries them as structured fields.
 *   5. Never throw. A logger that can crash the gateway is a bad trade.
 *
 * ## What this is NOT
 *
 * - Not an OpenTelemetry integration — see {@link ./observability/metrics.ts}
 *   for counters/gauges. Logs and metrics are separate concerns.
 * - Not the audit log — `.rea/audit.jsonl` is a hash-chained, tamper-evident
 *   record of tool calls. This module is free-form operator observability.
 * - Not a file logger. Records go to stderr only. If you need durable logs,
 *   redirect the process's stderr.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Ordered lowest → highest. A record is emitted iff its level ≥ current. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Structured fields every record carries. Additional fields are allowed. */
export interface LogFields {
  /** Short verb-ish name — `downstream.connect`, `circuit.open`, etc. */
  event: string;
  /** Running gateway session id, when known. Omitted from startup records. */
  session_id?: string;
  /** Name of a downstream MCP server, when the record is server-scoped. */
  server_name?: string;
  /** Human-readable message. JSON mode carries it verbatim. */
  message: string;
  /** Any additional context. Values must be JSON-serializable. */
  [key: string]: unknown;
}

export interface Logger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
  /** Spawn a logger that merges `base` into every record. */
  child(base: Partial<LogFields>): Logger;
}

export interface LoggerOptions {
  /** Minimum level to emit. Default from REA_LOG_LEVEL env, else 'info'. */
  level?: LogLevel;
  /** Sink for serialized records. Defaults to `process.stderr`. */
  stream?: NodeJS.WritableStream;
  /**
   * Force output mode. Default: auto — JSON when `stream.isTTY !== true`,
   * pretty when the stream is a TTY.
   */
  mode?: 'json' | 'pretty';
  /** Clock injection for tests. Default: `Date.now`. */
  now?: () => number;
  /** Base fields merged into every record (used by `child()`). */
  base?: Partial<LogFields>;
}

/**
 * Parse `REA_LOG_LEVEL`. Unknown values fall back to 'info' — we never want
 * startup to fail because an operator typo'd an env var.
 */
export function resolveLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return 'info';
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
  ) {
    return normalized;
  }
  return 'info';
}

/**
 * ANSI color helpers. Kept tiny — we don't pull chalk to color four words.
 * A non-TTY writer never hits these because pretty mode only runs on a TTY.
 */
const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
};

function levelColor(level: LogLevel): string {
  switch (level) {
    case 'error':
      return COLOR.red;
    case 'warn':
      return COLOR.yellow;
    case 'info':
      return COLOR.green;
    case 'debug':
      return COLOR.cyan;
  }
}

/**
 * Resolve `mode` from options and stream. A non-TTY stream always gets JSON —
 * that is the well-defined contract for supervisors like systemd or Claude
 * Code's MCP runner which redirect our stderr.
 */
function resolveMode(
  stream: NodeJS.WritableStream,
  explicit: LoggerOptions['mode'],
): 'json' | 'pretty' {
  if (explicit !== undefined) return explicit;
  const isTTY = (stream as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;
  return isTTY ? 'pretty' : 'json';
}

/**
 * Stringify a record body. We do NOT use JSON.stringify's replacer argument
 * for ordering — JSON.stringify preserves insertion order for string keys,
 * so composing the record in a stable order is enough.
 */
function serialize(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // Last-ditch: drop unserializable values. A logger that throws on a
    // circular ref in a user-supplied field would be a denial-of-service
    // surface on its own daemon.
    return JSON.stringify({
      timestamp: record['timestamp'],
      level: record['level'],
      event: record['event'],
      message: '[unserializable log record]',
    });
  }
}

/**
 * Pretty-format for a human reader. Keeps the `[rea-serve]` prefix convention
 * so the helix smoke test's grep still matches.
 */
function formatPretty(
  level: LogLevel,
  timestamp: string,
  fields: LogFields & Record<string, unknown>,
): string {
  const color = levelColor(level);
  const levelTag = level.toUpperCase().padEnd(5);
  const event = fields.event;
  const message = fields.message;
  // Extract the well-known fields we already rendered.
  const { event: _e, message: _m, session_id, server_name, ...rest } = fields;
  void _e;
  void _m;

  const extras: string[] = [];
  if (server_name !== undefined) extras.push(`server=${server_name}`);
  if (session_id !== undefined) extras.push(`session=${String(session_id).slice(0, 8)}`);
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'timestamp' || k === 'level') continue;
    extras.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  const extrasStr = extras.length > 0 ? ` ${COLOR.dim}${extras.join(' ')}${COLOR.reset}` : '';

  return `${COLOR.dim}${timestamp}${COLOR.reset} ${color}${levelTag}${COLOR.reset} [rea-serve] ${event}: ${message}${extrasStr}\n`;
}

class BasicLogger implements Logger {
  private readonly minLevel: number;
  private readonly stream: NodeJS.WritableStream;
  private readonly mode: 'json' | 'pretty';
  private readonly now: () => number;
  private readonly base: Partial<LogFields>;

  constructor(opts: LoggerOptions) {
    const level = opts.level ?? resolveLogLevel(process.env['REA_LOG_LEVEL']);
    this.minLevel = LEVEL_ORDER[level];
    this.stream = opts.stream ?? process.stderr;
    this.mode = resolveMode(this.stream, opts.mode);
    this.now = opts.now ?? Date.now;
    this.base = opts.base ?? {};
  }

  debug(fields: LogFields): void {
    this.emit('debug', fields);
  }
  info(fields: LogFields): void {
    this.emit('info', fields);
  }
  warn(fields: LogFields): void {
    this.emit('warn', fields);
  }
  error(fields: LogFields): void {
    this.emit('error', fields);
  }

  child(base: Partial<LogFields>): Logger {
    return new BasicLogger({
      level: inverseLevel(this.minLevel),
      stream: this.stream,
      mode: this.mode,
      now: this.now,
      base: { ...this.base, ...base },
    });
  }

  private emit(level: LogLevel, raw: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    // Merge in base fields; explicit fields win.
    const merged: LogFields & Record<string, unknown> = { ...this.base, ...raw } as LogFields &
      Record<string, unknown>;

    const timestamp = new Date(this.now()).toISOString();

    try {
      let line: string;
      if (this.mode === 'json') {
        const record = { timestamp, level, ...merged };
        line = serialize(record) + '\n';
      } else {
        line = formatPretty(level, timestamp, merged);
      }
      this.stream.write(line);
    } catch {
      // Last resort — the stream rejected our write. Swallow; nothing we do
      // here can improve the situation.
    }
  }
}

/**
 * Recover the log level name from its numeric order. Only used when creating
 * a child logger so the child inherits the parent's level without a second env
 * lookup.
 */
function inverseLevel(order: number): LogLevel {
  for (const [name, n] of Object.entries(LEVEL_ORDER)) {
    if (n === order) return name as LogLevel;
  }
  return 'info';
}

/**
 * Create a logger. Defaults are appropriate for `rea serve` at runtime;
 * tests inject `stream`, `mode`, and `now` directly.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  return new BasicLogger(opts);
}
