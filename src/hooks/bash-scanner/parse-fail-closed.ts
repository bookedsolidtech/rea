/**
 * Parser-failure handling. The contract: any failure of the parser
 * (malformed bash, unterminated quote, etc.) returns BLOCK with a
 * canned reason. NEVER ALLOW on parse failure — that is the entire
 * bug class this 0.23.0 rewrite exists to close.
 *
 * Lifted into its own module so the bash-shim contract is easy to
 * eyeball: the verdict shape on parse failure is a stable wire format,
 * and snapshot-tested in `verdict-shape.test.ts`.
 */

import { parseFailureVerdict, type Verdict } from './verdict.js';

export interface ParseFailureInput {
  /** The raw parser error message (already normalized to a string). */
  parserMessage: string;
  /** The original command string the parser rejected (truncated for log size). */
  originalCommand?: string;
}

/**
 * Build a parse-failure verdict. Wraps `parseFailureVerdict` so callers
 * have a single import point for both the construction logic and the
 * "must always block" contract.
 *
 * Implementation note: we intentionally DO NOT include `originalCommand`
 * in the verdict body. The parser message alone is enough for the
 * operator to debug, and including the full command in a JSON wire-
 * format that flows through stderr risks log-injection vectors (a
 * crafted command could embed ANSI escapes in its literals). The
 * `input` field is consumed only by structured logging in callers
 * that opt in to it.
 */
export function buildParseFailureVerdict(input: ParseFailureInput): Verdict {
  return parseFailureVerdict(input.parserMessage);
}
