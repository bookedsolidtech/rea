#!/usr/bin/env node
/**
 * Tiny standalone helper used by shell hooks that need to consult a single
 * scalar policy field without pulling in a full CLI subcommand.
 *
 * Usage:
 *   node dist/scripts/read-policy-field.js <dotted.path>
 *
 * Exit codes:
 *   0 — field resolved; value printed to stdout (single line, no trailing
 *       metadata).
 *   1 — field is not present in the policy (also no policy file). stdout is
 *       empty; the caller should decide whether missing means "default" or
 *       "fail".
 *   2 — the policy file exists but is malformed (YAML error, schema error,
 *       any exception). stderr carries a short diagnostic; stdout is empty.
 *
 * The split between 1 and 2 matters because the push gate fail-closes on
 * malformed policy (treat codex_required=true) but is permitted to accept the
 * documented default when the field is simply absent.
 *
 * ## Why a standalone script instead of a CLI subcommand?
 *
 * Shell hooks fire thousands of times a day. A full `rea policy get ...`
 * subcommand would drag in commander, the prompts library, and the whole CLI
 * surface for what is a one-line lookup. A dedicated script keeps the import
 * graph tiny (loader + yaml + zod) and the startup cost minimal.
 *
 * ## Supported paths
 *
 * Only top-level and one-level-nested fields are supported; this matches the
 * shape of the Policy schema. Anything deeper is an over-fetch that the
 * caller should refactor to a schema method instead.
 */

import path from 'node:path';
import { loadPolicy } from '../policy/loader.js';
import type { Policy } from '../policy/types.js';

const EXIT_OK = 0;
const EXIT_MISSING = 1;
const EXIT_MALFORMED = 2;

function resolveDotted(obj: unknown, dottedPath: string): unknown {
  const parts = dottedPath.split('.');
  let cursor: unknown = obj;
  for (const key of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function main(): number {
  const [, , dottedPath] = process.argv;
  if (dottedPath === undefined || dottedPath.length === 0) {
    process.stderr.write('usage: read-policy-field <dotted.path> (e.g. review.codex_required)\n');
    return EXIT_MALFORMED;
  }

  const baseDir = process.env['REA_ROOT'] ?? process.cwd();

  let policy: Policy;
  try {
    policy = loadPolicy(baseDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish "file missing" (exit 1) from "file present but malformed"
    // (exit 2). loadPolicy throws a message starting with "Policy file not
    // found" in the missing case.
    if (/Policy file not found/.test(msg)) {
      return EXIT_MISSING;
    }
    process.stderr.write(`read-policy-field: ${msg}\n`);
    return EXIT_MALFORMED;
  }

  const value = resolveDotted(policy, dottedPath);
  if (value === undefined) {
    return EXIT_MISSING;
  }

  // Only emit scalars. Arrays and objects are refused so a caller can't
  // accidentally get a JSON blob back and misparse it.
  if (value === null || typeof value === 'object') {
    process.stderr.write(
      `read-policy-field: ${dottedPath} is not a scalar (got ${value === null ? 'null' : typeof value})\n`,
    );
    return EXIT_MALFORMED;
  }

  process.stdout.write(String(value) + '\n');
  return EXIT_OK;
}

// Only run when invoked as a script (not when imported in tests).
// path.basename strips the file extension differences between .js and .ts so
// this works in both the compiled and the ts-node paths.
const invokedAs = process.argv[1] ?? '';
if (path.basename(invokedAs).startsWith('read-policy-field')) {
  process.exit(main());
}

// Exported for tests. Keeping the internal name distinct makes it obvious
// that this module has a CLI entry point.
export { main as runReadPolicyField };
