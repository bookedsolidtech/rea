/**
 * Thin wrapper around `mvdan-sh` — the GopherJS-compiled JS port of
 * the upstream Go bash parser at `mvdan.cc/sh/v3/syntax`.
 *
 * Why a wrapper:
 *   1. The parser instance is mutable (it tracks state across calls
 *      to `Parse`). Construct once per process; serialize all parses
 *      through it. Multiple concurrent Node CLI invocations get one
 *      parser each — fine, it's cheap.
 *   2. The library throws Go-style error objects with `.Error()`
 *      methods, not native JS Errors. Normalize them to native Error
 *      with a clean message.
 *   3. Callers care only about three outcomes: parsed, parse-failed,
 *      or unexpected JS-level throw. Collapse the Go-vs-JS-error
 *      ambiguity to a single discriminated union.
 *
 * 0.23.0 — first release of this module. Pinned to mvdan-sh@0.10.1
 * (deprecated upstream but functionally complete; see issue 1145).
 * If we ever migrate to `sh-syntax` (the WASM successor), this
 * wrapper is the only file that changes — everything downstream
 * works against `BashFile`/`BashNode` from our local d.ts shim.
 */

import mvdanSh from 'mvdan-sh';
import type { BashFile } from 'mvdan-sh';

/**
 * Singleton parser. mvdan-sh's `NewParser` is documented as reusable
 * across calls; spinning up a fresh one per scan adds 1-2ms with no
 * correctness benefit.
 *
 * Imported via the default export — the package ships CommonJS with
 * a single `module.exports = { syntax: ... }` shape; under ESM the
 * named-export `{ syntax }` form fails because the property is
 * dynamically assigned in the GopherJS-generated body and Node's
 * named-exports synthesis cannot see it.
 */
const parser = mvdanSh.syntax.NewParser();

export type ParseResult = { ok: true; file: BashFile } | { ok: false; error: string };

/**
 * Parse a bash command string into an AST. Returns a tagged union so
 * the caller never has to wrap this in try/catch — every failure mode
 * (Go parse error, JS throw, weird native return) is collapsed to
 * `{ ok: false, error }`.
 *
 * Empty / whitespace-only input is a no-op success — the parser
 * returns a `File` with zero `Stmts`, which the walker will yield
 * zero detections for. Equivalent to the bash gates' `[[ -z "$CMD" ]]
 * && exit 0` guard.
 */
export function parseBashCommand(src: string): ParseResult {
  try {
    const file = parser.Parse(src, 'rea-bash-scanner.sh');
    // Defensive: GopherJS sometimes returns a node missing the Stmts
    // field on certain edge-case inputs (we have not reproduced one,
    // but the file-IO layer the original Go uses is mocked out and
    // failure modes are not perfectly characterized). Treat that as
    // "parse failure" rather than "empty file" so we fail closed.
    if (file === null || file === undefined) {
      return { ok: false, error: 'parser returned null file' };
    }
    return { ok: true, file };
  } catch (e) {
    // Go errors come through as objects with `.Error()` methods. Native
    // JS errors have `.message`. Anything else gets stringified.
    const error = goErrorMessage(e) ?? jsErrorMessage(e) ?? String(e);
    return { ok: false, error };
  }
}

function goErrorMessage(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'Error' in e) {
    const fn = (e as { Error?: unknown }).Error;
    if (typeof fn === 'function') {
      try {
        const msg: unknown = fn.call(e);
        if (typeof msg === 'string') return msg;
      } catch {
        // Fall through to other strategies.
      }
    }
  }
  return null;
}

function jsErrorMessage(e: unknown): string | null {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return null;
}
