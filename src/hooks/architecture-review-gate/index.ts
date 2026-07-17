/**
 * Node-binary port of `hooks/architecture-review-gate.sh`.
 *
 * 0.33.0 Phase 1 port #4 — the SIMPLEST tier-1 port.
 *
 * PostToolUse Write/Edit advisory. Reads `policy.architecture_review.
 * patterns` and prints an advisory banner to stderr when the just-
 * written file path begins with one of the configured prefixes.
 * ALWAYS exits 0 — this is a nudge, not a gate.
 *
 * Behavioral contract preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with the shared banner. (Even though the
 *      gate is advisory, HALT short-circuits ALL hooks.)
 *   2. `policy.architecture_advisory: false` short-circuit → exit 0
 *      silently. The bash hook reads the policy file with a grep
 *      `architecture_advisory: false`; we mirror via the canonical
 *      YAML loader.
 *   3. Read stdin → `tool_input.file_path` (the bash hook uses
 *      `notebook_path` too via fall-through, but the original
 *      `jq -r '.tool_input.file_path // empty'` expression does NOT
 *      fall through to notebook_path. We preserve that exactly).
 *   4. Empty file_path → exit 0.
 *   5. Path normalization mirrors `_lib/path-normalize.sh::normalize_path`:
 *        - Convert backslashes to forward slashes (Windows / Git Bash).
 *        - URL-decode `%xx` sequences.
 *        - Strip a leading `<REA_ROOT>/` prefix if present so
 *          `policy.architecture_review.patterns` can use repo-relative
 *          patterns.
 *   6. Read `policy.architecture_review.patterns`. Empty / unset →
 *      silent no-op (exit 0). The bst-internal profile pins rea-
 *      source patterns; consumer projects opt in by populating their
 *      own list.
 *   7. First prefix match wins. Emit the advisory banner to stderr;
 *      exit 0.
 *
 * Distinct from the other 0.33.0 ports: this gate is POSTToolUse
 * (fires AFTER the write, advisory only). The shim that invokes it
 * should NOT fail-closed on missing CLI — the pre-0.33.0 bash hook
 * was already a silent no-op when the policy was unset.
 */

import type { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots } from '../../lib/worktree-roots.js';
import {
  parseWriteHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';

export interface ArchitectureReviewGateOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface ArchitectureReviewGateResult {
  exitCode: number;
  stderr: string;
  /** Test seam — the matched pattern (or `null`). */
  matched: string | null;
}

/**
 * Normalize the incoming file path. Mirrors
 * `hooks/_lib/path-normalize.sh::normalize_path`:
 *   - backslashes → forward slashes
 *   - URL-decoded
 *   - leading `<REA_ROOT>/` stripped (when applicable)
 *
 * Pre-0.16.0 the bash hook ONLY stripped the REA_ROOT prefix, which
 * meant Windows / Git Bash backslash paths bypassed advisory.
 */
function normalizePath(rawPath: string, reaRoot: string): string {
  let p = rawPath.replace(/\\/g, '/');
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed % escape — leave the string unchanged. The bash
    // helper's `printf '%b'` behavior is similar (passes through).
  }
  // Strip leading <REA_ROOT>/. Compare normalized forms.
  const normRoot = reaRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normRoot.length > 0) {
    if (p === normRoot) return '';
    const withSep = normRoot + '/';
    if (p.startsWith(withSep)) {
      p = p.slice(withSep.length);
    }
  }
  // 2026-05-15 codex round-1 P3 fix: strip chains of leading `./`
  // segments. Mirrors `_lib/path-normalize.sh::path_canonical_form`.
  // Pre-fix `./src/gateway/foo.ts` did NOT match the `src/gateway/`
  // pattern because the leading `./` was preserved. Bash's
  // path_canonical_form collapses `./` chains, so `./src/...`,
  // `././src/...`, etc. all reduce to `src/...`.
  while (p.startsWith('./')) {
    p = p.slice(2);
  }
  return p;
}

function buildAdvisoryBanner(filePath: string, matched: string): string {
  return [
    'ARCHITECTURE ADVISORY: Sensitive path modified\n',
    '\n',
    `  File: ${filePath}\n`,
    `  Category: ${matched}\n`,
    '\n',
    '  This file is in an architecture-sensitive directory.\n',
    '  Consider: Does this change maintain backward compatibility?\n',
    '  Consider: Should this be reviewed by the principal-engineer agent?\n',
  ].join('');
}

/**
 * Read `policy.architecture_review.patterns`. Returns `[]` on:
 *   - policy file missing
 *   - YAML unparseable
 *   - architecture_review unset
 *   - architecture_review.patterns unset/empty/non-list
 *
 * 2026-05-15 codex round-1 P3 fix: do NOT use `loadPolicy()` here.
 * The strict zod schema throws on legacy keys / extra fields, which
 * caused the catch to swallow patterns silently — a legacy policy.yaml
 * with one unknown key would disable the advisory entirely, with no
 * indication to the user.
 *
 * The bash original used `policy_list` (a non-strict reader). To match
 * that behavior we read the YAML directly via the same permissive
 * parser that `rea hook policy-get` uses (`yaml` package's `parse`),
 * then pull `architecture_review.patterns` as a list of strings. Any
 * non-string entry is filtered out. Unknown keys ELSEWHERE in the
 * policy are tolerated — only the patterns subset matters for this
 * advisory.
 */
function loadArchitecturePatterns(
  reaRoot: string,
  onWarning: (msg: string) => void,
): string[] {
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch {
    // File missing — bash hook treats this as "advisory disabled".
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    // Unparseable YAML — log to stderr (NOT silent) and return [].
    // The advisory still short-circuits to exit 0 since this is an
    // advisory tier, but the user sees a one-line warning instead of
    // mysterious silence.
    onWarning(
      'architecture-review-gate: policy.yaml is unparseable; advisory disabled\n',
    );
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  const ar = (parsed as Record<string, unknown>)['architecture_review'];
  if (ar === undefined || ar === null || typeof ar !== 'object' || Array.isArray(ar)) {
    return [];
  }
  const patterns = (ar as Record<string, unknown>)['patterns'];
  if (!Array.isArray(patterns)) return [];
  const out: string[] = [];
  for (const entry of patterns) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Quick policy-disable probe. The bash hook reads
 * `architecture_advisory: false` (legacy key — pre-0.20.1 toggle)
 * directly from policy.yaml via grep. The canonical loader doesn't
 * surface this key (it's not in the strict schema), so we re-read
 * the raw YAML text. Returns true when the key is present and
 * literally `false` (no other value disables the hook in the bash
 * implementation).
 */
function isAdvisoryDisabled(reaRoot: string): boolean {
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch {
    return false;
  }
  return /^architecture_advisory:\s*false\b/m.test(raw);
}

export async function runArchitectureReviewGate(
  options: ArchitectureReviewGateOptions = {},
): Promise<ArchitectureReviewGateResult> {
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 1. Stdin FIRST (0.54.0 worktree state): the payload's `cwd` feeds
  //    root resolution, so parsing precedes the HALT/disabled checks —
  //    a deliberate reorder.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let filePath = '';
  let payloadCwd = '';
  try {
    const payload = parseWriteHookPayload(stdinRaw);
    filePath = payload.filePath;
    payloadCwd = payload.cwd;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      // Advisory tier: silently exit 0 on malformed payload. The bash
      // hook used `jq -r '.tool_input.file_path // empty'` which
      // coerces malformed JSON to empty stdout, then exits 0. Mirror
      // that — never refuse on a parse error in the advisory path.
      return { exitCode: 0, stderr, matched: null };
    }
    throw err;
  }

  if (filePath.length === 0) {
    return { exitCode: 0, stderr, matched: null };
  }

  // 2. Roots + HALT + disabled. Policy keys off the LOCAL root; the
  //    kill switch probes both roots (repo-wide HALT, 0.54.0).
  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(payloadCwd, options.reaRoot);
  const halt = checkHaltRoots(reaRoot, commonRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, matched: null };
  }
  if (isAdvisoryDisabled(reaRoot)) {
    return { exitCode: 0, stderr, matched: null };
  }

  const normalized = normalizePath(filePath, reaRoot);
  if (normalized.length === 0) {
    return { exitCode: 0, stderr, matched: null };
  }

  const patterns = loadArchitecturePatterns(reaRoot, writeStderr);
  if (patterns.length === 0) {
    return { exitCode: 0, stderr, matched: null };
  }

  let matched: string | null = null;
  for (const pattern of patterns) {
    if (normalized.startsWith(pattern)) {
      matched = pattern;
      break;
    }
  }
  if (matched === null) {
    return { exitCode: 0, stderr, matched: null };
  }

  writeStderr(buildAdvisoryBanner(normalized, matched));
  return { exitCode: 0, stderr, matched };
}

/**
 * CLI entry — `rea hook architecture-review-gate`.
 */
export async function runHookArchitectureReviewGate(
  options: ArchitectureReviewGateOptions = {},
): Promise<void> {
  const result = await runArchitectureReviewGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
