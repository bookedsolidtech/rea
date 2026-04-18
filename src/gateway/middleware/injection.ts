import type { Middleware, InvocationContext } from './chain.js';
import { InvocationStatus } from '../../policy/types.js';
import { wrapRegex, type SafeRegex } from '../redact-safe/match-timeout.js';

/**
 * Known prompt injection phrases (lowercase for case-insensitive matching).
 * These patterns are commonly used to override system instructions in tool
 * descriptions or resource content returned by downstream MCP servers.
 */
export const INJECTION_PHRASES: readonly string[] = [
  'ignore previous instructions',
  'disregard your',
  'your new instructions are',
  'system prompt override',
  'forget all previous',
  // 'you are now' is too broad — fires on "you are now connected", "you are now in /home/foo", etc.
  // The role-reassignment vector is "you are now a [different persona]" — the trailing space+article
  // is what distinguishes injection from ordinary status messages.
  'you are now a ',
  'you are now an ',
];

/**
 * Base64-token scanner regex. The only regex the injection middleware runs
 * against untrusted payloads; wrapped in `SafeRegex` at middleware creation
 * time so a catastrophic input cannot hang the event loop. See G3
 * (`src/gateway/redact-safe/match-timeout.ts`).
 */
export const INJECTION_BASE64_PATTERN = /[A-Za-z0-9+/]{20,}={0,2}/g;

/**
 * Base64 shape-validation regex used by `tryDecodeBase64`. Shorter inputs are
 * rejected before we reach this test; the pattern itself is linear, so the
 * SafeRegex wrap is purely a defense-in-depth measure.
 */
export const INJECTION_BASE64_SHAPE = /^[A-Za-z0-9+/]+=*$/;

/**
 * Audit metadata key for injection-scan regex timeouts. Multiple timeouts in
 * one invocation append to an array under this key.
 */
export const INJECTION_TIMEOUT_METADATA_KEY = 'injection.regex_timeout';

export interface InjectionTimeoutEvent {
  event: 'injection.regex_timeout';
  pattern_source: 'default';
  pattern_id: string;
  input_bytes: number;
  timeout_ms: number;
}

interface CompiledInjectionPatterns {
  base64Token: SafeRegex;
  base64Shape: SafeRegex;
}

/**
 * Decode a base64 string, returning the decoded text or null if decoding fails.
 * Only decodes if the input looks like base64 (64-char alphabet, length divisible by 4 or padded).
 */
function tryDecodeBase64(input: string, safe: CompiledInjectionPatterns): string | null {
  // Quick heuristic: must be at least 20 chars and use only base64 chars
  if (input.length < 20) return null;
  const shape = safe.base64Shape.test(input);
  if (shape.timedOut || !shape.matched) return null;
  try {
    return Buffer.from(input, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export interface ScanForInjectionOptions {
  onTimeout?: (patternId: string, input: string) => void;
}

/**
 * Build compiled injection patterns with the provided timeout. Precompiled at
 * middleware creation so the worker spawn is the only per-call overhead.
 */
export function compileInjectionPatterns(
  timeoutMs: number,
  onTimeout?: (patternId: string, input: string) => void,
): CompiledInjectionPatterns {
  return {
    base64Token: wrapRegex(INJECTION_BASE64_PATTERN, {
      timeoutMs,
      ...(onTimeout
        ? { onTimeout: (_p, i) => onTimeout('INJECTION_BASE64_PATTERN', i) }
        : {}),
    }),
    base64Shape: wrapRegex(INJECTION_BASE64_SHAPE, {
      timeoutMs,
      ...(onTimeout
        ? { onTimeout: (_p, i) => onTimeout('INJECTION_BASE64_SHAPE', i) }
        : {}),
    }),
  };
}

/**
 * Scan a string for known prompt injection phrases.
 * Also decodes base64 tokens and checks the decoded content.
 * Returns an array of matched phrase descriptions, empty if clean.
 *
 * The `safe` parameter carries precompiled SafeRegex wrappers; callers build
 * it once via `compileInjectionPatterns`.
 */
export function scanForInjection(
  input: string,
  safe: CompiledInjectionPatterns,
): string[] {
  if (!input || typeof input !== 'string') return [];

  const lower = input.toLowerCase();
  const matches: string[] = [];

  // Check literal phrases (indexOf — no regex, no ReDoS surface).
  for (const phrase of INJECTION_PHRASES) {
    if (lower.includes(phrase)) {
      matches.push(`literal: "${phrase}"`);
    }
  }

  // Check base64-encoded variants — scan word-like tokens that look like
  // base64. The regex match is bounded via SafeRegex (timeout + hard worker
  // kill).
  const tokenResult = safe.base64Token.matchAll(input);
  const base64Tokens = tokenResult.matches;
  for (const token of base64Tokens) {
    const decoded = tryDecodeBase64(token, safe);
    if (!decoded) continue;
    const decodedLower = decoded.toLowerCase();
    for (const phrase of INJECTION_PHRASES) {
      if (decodedLower.includes(phrase)) {
        matches.push(`base64-encoded: "${phrase}"`);
        break; // One report per token is enough
      }
    }
  }

  return matches;
}

/**
 * Scan an unknown value recursively, collecting all injection matches.
 * Walks strings, arrays, and plain objects.
 */
function scanValue(value: unknown, matches: string[], safe: CompiledInjectionPatterns): void {
  if (typeof value === 'string') {
    matches.push(...scanForInjection(value, safe));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scanValue(item, matches, safe);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      scanValue(v, matches, safe);
    }
  }
}

export type InjectionAction = 'block' | 'warn';

export interface InjectionMiddlewareOptions {
  /** Timeout budget for each regex call. Default 100ms. */
  matchTimeoutMs?: number;
}

/**
 * Record a regex-timeout event on `ctx.metadata`. Array-valued so multiple
 * timeouts in one invocation are all recorded.
 *
 * SECURITY: The input text is NEVER written into metadata — only `input_bytes`.
 */
function recordInjectionTimeout(
  ctx: InvocationContext,
  patternId: string,
  inputBytes: number,
  timeoutMs: number,
): void {
  const ev: InjectionTimeoutEvent = {
    event: 'injection.regex_timeout',
    pattern_source: 'default',
    pattern_id: patternId,
    input_bytes: inputBytes,
    timeout_ms: timeoutMs,
  };
  const existing = ctx.metadata[INJECTION_TIMEOUT_METADATA_KEY];
  if (Array.isArray(existing)) {
    existing.push(ev);
  } else {
    ctx.metadata[INJECTION_TIMEOUT_METADATA_KEY] = [ev];
  }
}

/**
 * PostToolUse middleware: scans tool results for prompt injection patterns.
 *
 * Operates on tool output (ctx.result) returned from downstream MCP servers.
 * On detection:
 *   - Always logs to audit metadata and emits a warning to stderr.
 *   - If action is 'block' (default), sets ctx.status to Denied and blocks the result.
 *   - If action is 'warn', allows the result through with a warning only.
 *
 * SECURITY: Checking PostToolUse (after downstream execution, before the result
 * reaches the LLM) is the correct place to catch injection in tool descriptions
 * and resource content coming from potentially untrusted downstream servers.
 *
 * SECURITY (G3): The only regexes this middleware runs are wrapped in
 * `SafeRegex` with a 100ms default per-call timeout. On timeout the scanner
 * records an audit event and proceeds — blocking is governed by the literal
 * substring checks (which have no ReDoS surface).
 */
export function createInjectionMiddleware(
  action: InjectionAction = 'block',
  opts: InjectionMiddlewareOptions = {},
): Middleware {
  const timeoutMs = opts.matchTimeoutMs ?? 100;
  return async (ctx, next) => {
    await next();

    // Only scan if we have a result to inspect
    if (ctx.result == null) return;

    const safe = compileInjectionPatterns(timeoutMs, (patternId, input) => {
      recordInjectionTimeout(ctx, patternId, Buffer.byteLength(input, 'utf8'), timeoutMs);
    });

    const matches: string[] = [];
    scanValue(ctx.result, matches, safe);

    if (matches.length === 0) return;

    // Deduplicate matches
    const unique = [...new Set(matches)];

    // Always log to audit metadata
    ctx.metadata.injection_matches = unique;

    // Always emit warning to stderr
    process.stderr.write(
      `[rea] INJECTION-GUARD: Prompt injection pattern detected in tool "${ctx.tool_name}" result\n`,
    );
    for (const match of unique) {
      process.stderr.write(`  Pattern: ${match}\n`);
    }
    process.stderr.write(
      `  Action: ${action} — review the downstream server "${ctx.server_name}" for compromise.\n`,
    );

    if (action === 'block') {
      ctx.status = InvocationStatus.Denied;
      ctx.error = `Prompt injection detected in tool result (${unique.length} pattern(s) matched). Result blocked.`;
      ctx.result = undefined;
    }
  };
}
