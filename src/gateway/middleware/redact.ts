import type { Middleware, InvocationContext } from './chain.js';
import {
  wrapRegex,
  type SafeRegex,
  type MatchTimeoutOptions,
} from '../redact-safe/match-timeout.js';

/**
 * Patterns that match common secret formats.
 * Each pattern has a name (for audit logging) and a regex.
 *
 * SECURITY: Patterns use case-insensitive flag where applicable.
 * SECURITY: Input is sanitized (null bytes stripped) before matching.
 * SECURITY (G3): Every pattern is wrapped in a `SafeRegex` with a per-call
 *   timeout so a catastrophic backtracker cannot hang the gateway. See
 *   `src/gateway/redact-safe/match-timeout.ts`.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/gi },
  {
    name: 'AWS Secret Key',
    pattern: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi,
  },
  { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  {
    name: 'Generic API Key',
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9\-_.]{20,}["']?/gi,
  },
  { name: 'Bearer Token', pattern: /bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi },
  // PEM armor header — canonical format uses single spaces. Bounded repetition
  // avoids the nested-`\s+` ReDoS pattern that safe-regex flags on the broader
  // form (`\s+(?:FOO\s+|BAR\s+)?PRIVATE\s+KEY-----`). PEMs with non-space
  // separators are non-standard and not in our threat model.
  { name: 'Private Key', pattern: /-----BEGIN (?:(?:RSA|EC|DSA) )?PRIVATE KEY-----/gi },
  { name: 'Discord Token', pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/g },
  // Base64-encoded AWS access key (AKIA... in base64 starts with QUTJQ)
  { name: 'Base64 AWS Key', pattern: /QUtJQ[A-Za-z0-9+/]{17,}={0,2}/g },
  // Anthropic API keys (sk-ant-api03-... and similar)
  { name: 'Anthropic API Key', pattern: /sk-ant-[a-zA-Z0-9\-_]{32,}/g },
  // OpenAI API keys — project keys (sk-proj-...) and legacy (sk-...)
  { name: 'OpenAI Project Key', pattern: /sk-proj-[a-zA-Z0-9\-_]{32,}/g },
  { name: 'OpenAI API Key', pattern: /sk-[a-zA-Z0-9]{32,}/g },
  // Hugging Face access tokens
  { name: 'Hugging Face Token', pattern: /hf_[a-zA-Z0-9]{32,}/g },
];

/**
 * Sentinel inserted when a redaction pattern exceeds its timeout budget. The
 * original field is replaced entirely — the middleware never lets a potentially
 * secret-bearing string pass through when the scanner failed to complete.
 */
export const REDACT_TIMEOUT_SENTINEL = '[REDACTED: pattern timeout]';

/**
 * Identifier for the timeout audit event. Emitted on `ctx.metadata` as an
 * array under this key so multiple timeouts in one invocation are recorded.
 */
export const REDACT_TIMEOUT_METADATA_KEY = 'redact.regex_timeout';

export interface RedactTimeoutEvent {
  event: 'redact.regex_timeout';
  pattern_source: 'default' | 'user';
  pattern_id: string;
  input_bytes: number;
  timeout_ms: number;
}

/**
 * Strip null bytes and other control characters that could break regex matching.
 */
function sanitizeInput(input: string): string {
  return input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/**
 * A compiled secret pattern — the original `RegExp` plus a `SafeRegex` wrapper
 * that carries the configured timeout + audit callback. Precompiled at
 * middleware-creation time so the per-call worker spawn is the only overhead.
 */
export interface CompiledSecretPattern {
  name: string;
  source: 'default' | 'user';
  safe: SafeRegex;
}

/**
 * Build a list of compiled SECRET_PATTERNS using the provided timeout options.
 * Exported so the middleware factory can reuse it with its own `onTimeout`.
 */
export function compileDefaultSecretPatterns(
  opts: MatchTimeoutOptions & { source?: 'default' | 'user' } = {},
): CompiledSecretPattern[] {
  const source = opts.source ?? 'default';
  return SECRET_PATTERNS.map(({ name, pattern }) => ({
    name,
    source,
    safe: wrapRegex(pattern, opts),
  }));
}

/**
 * Redact secrets from a string, returning the redacted string and the list of
 * pattern names that matched. Timeouts are reported via `onTimeout` — the
 * caller is responsible for audit accounting.
 *
 * On timeout for a given pattern, the scanner replaces the entire input with
 * `REDACT_TIMEOUT_SENTINEL` (see the comment above the sentinel) and short-
 * circuits further scanning of that value. This is the safe choice: we cannot
 * let an un-scanned string leak downstream.
 */
export function redactSecrets(
  input: string,
  patterns: CompiledSecretPattern[],
  onTimeout?: (ev: { name: string; source: 'default' | 'user'; input: string }) => void,
): { output: string; redacted: string[]; timedOut: boolean } {
  let output = sanitizeInput(input);
  const redacted: string[] = [];

  for (const { name, source, safe } of patterns) {
    const t = safe.test(output);
    if (t.timedOut) {
      if (onTimeout) onTimeout({ name, source, input: output });
      return { output: REDACT_TIMEOUT_SENTINEL, redacted: [name], timedOut: true };
    }
    if (!t.matched) continue;

    const r = safe.replace(output, '[REDACTED]');
    if (r.timedOut) {
      if (onTimeout) onTimeout({ name, source, input: output });
      return { output: REDACT_TIMEOUT_SENTINEL, redacted: [name], timedOut: true };
    }
    output = r.output;
    redacted.push(name);
  }

  return { output, redacted, timedOut: false };
}

export interface RedactMiddlewareOptions {
  /** Timeout budget for each regex test/replace call. Default 100ms. */
  matchTimeoutMs?: number;
  /** Optional user-supplied patterns (loaded from policy). */
  userPatterns?: CompiledSecretPattern[];
}

/**
 * Helper: push a timeout event onto `ctx.metadata[REDACT_TIMEOUT_METADATA_KEY]`.
 * Uses an array so multiple timeouts in one invocation are all recorded.
 *
 * SECURITY: The input text is NEVER put into metadata — only `input_bytes`.
 */
function recordTimeoutOnCtx(
  ctx: InvocationContext,
  name: string,
  source: 'default' | 'user',
  inputBytes: number,
  timeoutMs: number,
): void {
  const ev: RedactTimeoutEvent = {
    event: 'redact.regex_timeout',
    pattern_source: source,
    pattern_id: name,
    input_bytes: inputBytes,
    timeout_ms: timeoutMs,
  };
  const existing = ctx.metadata[REDACT_TIMEOUT_METADATA_KEY];
  if (Array.isArray(existing)) {
    existing.push(ev);
  } else {
    ctx.metadata[REDACT_TIMEOUT_METADATA_KEY] = [ev];
  }
}

/**
 * Build the redact middleware with a configured timeout budget and (optionally)
 * user-supplied patterns loaded from policy. Both default and user patterns are
 * wrapped in `SafeRegex` so every regex the middleware runs is bounded.
 *
 * SECURITY: For non-string results, redaction operates on individual string
 * values within the object structure rather than JSON.stringify → replace →
 * JSON.parse, which could corrupt the result if a replacement changes JSON
 * structure.
 */
export function createRedactMiddleware(opts: RedactMiddlewareOptions = {}): Middleware {
  const timeoutMs = opts.matchTimeoutMs ?? 100;
  const defaultPatterns = compileDefaultSecretPatterns({ timeoutMs, source: 'default' });
  const userPatterns = opts.userPatterns ?? [];
  const allPatterns = [...defaultPatterns, ...userPatterns];

  return async (ctx, next) => {
    const recordTimeout = (name: string, source: 'default' | 'user', input: string): void => {
      recordTimeoutOnCtx(ctx, name, source, Buffer.byteLength(input, 'utf8'), timeoutMs);
    };

    // SECURITY: Pre-execution — scan arguments for secrets before they reach the downstream tool.
    if (ctx.arguments) {
      const argRedacted: string[] = [];
      redactDeep(ctx.arguments, argRedacted, allPatterns, recordTimeout);
      if (argRedacted.length > 0) {
        ctx.redacted_fields = [...new Set(argRedacted)];
      }
    }

    await next();

    if (ctx.result == null) return;

    if (typeof ctx.result === 'string') {
      const { output, redacted } = redactSecrets(ctx.result, allPatterns, (ev) =>
        recordTimeout(ev.name, ev.source, ev.input),
      );
      if (redacted.length > 0) {
        ctx.result = output;
        ctx.redacted_fields = [...new Set([...(ctx.redacted_fields ?? []), ...redacted])];
      }
      return;
    }

    // For objects, deeply redact all string values in-place
    const allRedacted: string[] = [];
    redactDeep(ctx.result, allRedacted, allPatterns, recordTimeout);
    if (allRedacted.length > 0) {
      ctx.redacted_fields = [...new Set([...(ctx.redacted_fields ?? []), ...allRedacted])];
    }
  };
}

/**
 * Default-configured redact middleware (100ms timeout, default patterns only).
 * Preserved for callers that don't need to configure; `createRedactMiddleware`
 * is the new canonical factory.
 */
export const redactMiddleware: Middleware = createRedactMiddleware();

/**
 * Recursively walk an object/array and redact string values in-place.
 * Uses a WeakSet to guard against circular references.
 */
function redactDeep(
  obj: unknown,
  redacted: string[],
  patterns: CompiledSecretPattern[],
  onTimeout: (name: string, source: 'default' | 'user', input: string) => void,
  seen = new WeakSet(),
): void {
  if (obj == null || typeof obj !== 'object') return;

  // Guard against circular references
  if (seen.has(obj as object)) return;
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') {
        const { output, redacted: r } = redactSecrets(obj[i], patterns, (ev) =>
          onTimeout(ev.name, ev.source, ev.input),
        );
        if (r.length > 0) {
          obj[i] = output;
          redacted.push(...r);
        }
      } else {
        redactDeep(obj[i], redacted, patterns, onTimeout, seen);
      }
    }
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (typeof record[key] === 'string') {
      const { output, redacted: r } = redactSecrets(record[key] as string, patterns, (ev) =>
        onTimeout(ev.name, ev.source, ev.input),
      );
      if (r.length > 0) {
        record[key] = output;
        redacted.push(...r);
      }
    } else {
      redactDeep(record[key], redacted, patterns, onTimeout, seen);
    }
  }
}
