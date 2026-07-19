/**
 * Node-binary port of `hooks/env-file-protection.sh`.
 *
 * 0.33.0 Phase 1 port #1 (tier-1 advisory/single-purpose hooks).
 *
 * Behavioral contract — preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with the shared banner.
 *   2. Read stdin, extract `tool_input.command`.
 *   3. Only Bash tool calls (matches the bash hook's PreToolUse Bash
 *      matcher — non-Bash payloads bypass).
 *   4. Empty command → exit 0.
 *   5. Three independent block patterns:
 *        - segment-anchored `source ... .env` / `. ... .env`
 *        - segment-anchored `cp ... .env`
 *        - any-segment co-occurrence of a text-reading utility
 *          (cat/head/tail/less/more/grep/sed/awk/bat/strings/printf/
 *           xargs/tee/jq/python -c/ruby -e) AND a `.env*`/`.envrc`
 *          filename WITHIN THE SAME segment. The co-occurrence
 *          property is critical: multi-segment commands like
 *          `echo "fix: don't cat .env" ; touch foo.env` would
 *          false-positive under two independent any-segment booleans.
 *   6. Match → exit 2 with the matching advisory banner; otherwise
 *      exit 0.
 *
 * Pattern parity with the bash hook is by-design verbatim. The bash
 * regex bodies are reused literally so a future addition to the
 * utility list lands in one place. Case-insensitive (`grep -qiE` in
 * bash; `new RegExp(..., 'i')` here) — same posture.
 */

import type { Buffer } from 'node:buffer';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots } from '../../lib/worktree-roots.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import {
  anySegmentStartsWith,
  anySegmentMatchesBoth,
} from '../_lib/segments.js';

export interface EnvFileProtectionOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface EnvFileProtectionResult {
  exitCode: number;
  stderr: string;
}

/**
 * Patterns mirroring the bash hook's PATTERN_* shell vars.
 *
 * `PATTERN_UTILITY` — text-reading utilities. Bash uses
 *   `(cat|head|tail|less|more|grep|sed|awk|bat|strings|printf|xargs|
 *    tee|jq|python3?[[:space:]]+-c|ruby[[:space:]]+-e)[[:space:]]`.
 *   We carry the same body; bash POSIX char classes are translated to
 *   their JavaScript regex equivalents (`[[:space:]]` → `\s`).
 *
 * `PATTERN_SOURCE` / `PATTERN_CP_ENV` — anchored at segment start. The
 *   `any_segment_starts_with` walker strips leading prefixes (sudo,
 *   env-var assignments) before applying the regex, so we DO NOT
 *   re-anchor with `^` here.
 *
 * `PATTERN_ENV_FILE` — matches `.env*`, `.env.local`, `.envrc`, etc.
 *   The trailing `(\s|"|'|$)` boundary in the bash hook keeps it from
 *   matching `foo.environment` style identifiers; we preserve that.
 */
const PATTERN_UTILITY =
  '(cat|head|tail|less|more|grep|sed|awk|bat|strings|printf|xargs|tee|jq|python3?\\s+-c|ruby\\s+-e)\\s';
const PATTERN_SOURCE = "(source|\\.)\\s+[^;|&]*\\.env";
const PATTERN_CP_ENV = "cp\\s+[^;|&]*\\.env";
const PATTERN_ENV_FILE = '(\\.env[a-zA-Z0-9._-]*|\\.envrc)(\\s|"|\'|$)';

const MAX_DISPLAY_CMD_LEN = 100;
function truncate(cmd: string): string {
  if (cmd.length <= MAX_DISPLAY_CMD_LEN) return cmd;
  return cmd.slice(0, MAX_DISPLAY_CMD_LEN) + '...';
}

function buildSourceBanner(cmd: string): string {
  return [
    'ENV FILE PROTECTION: Direct sourcing or copying of .env files is blocked.\n',
    '\n',
    `  Command: ${truncate(cmd)}\n`,
    '\n',
    '  Rule: Load credentials in code only — never via shell source or cp.\n',
    '  Use: process.env.VAR_NAME, os.environ["VAR_NAME"], etc.\n',
  ].join('');
}

function buildReadBanner(cmd: string): string {
  return [
    'ENV FILE PROTECTION: Reading .env files via Bash is blocked.\n',
    '\n',
    `  Command: ${truncate(cmd)}\n`,
    '\n',
    '  Rule: Load credentials in code only, never via shell.\n',
    '  Use: process.env.VAR_NAME, os.environ["VAR_NAME"], etc.\n',
    '  .env files must not be read via shell utilities in agent sessions.\n',
  ].join('');
}

/**
 * Pure executor. Returns `{ exitCode, stderr }`; the CLI wrapper
 * translates them into `process.stderr.write` + `process.exit`.
 */
export async function runEnvFileProtection(
  options: EnvFileProtectionOptions = {},
): Promise<EnvFileProtectionResult> {
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 2. Read stdin.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let toolName = '';
  let cmd = '';
  let payloadCwd = '';
  try {
    const payload = parseHookPayload(stdinRaw);
    payloadCwd = payload.cwd;
    toolName = payload.toolName;
    cmd = payload.command;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr(
        `env-file-protection: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr };
    }
    throw err;
  }

  // Roots + HALT (0.54.0 worktree state): the payload's `cwd` feeds the
  // resolution ladder, so stdin is parsed FIRST — a deliberate reorder.
  // Policy/path checks key off the LOCAL (worktree) root; audit and the
  // kill switch key off the COMMON (repository) root.
  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(payloadCwd, options.reaRoot);
  // 1. HALT check — fail-closed (exit 2).
  const halt = checkHaltRoots(reaRoot, commonRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr };
  }

  // 3. Only Bash tool calls. The bash hook's PreToolUse Bash matcher
  //    only fires for Bash dispatches, but the shim's relevance pre-
  //    gate is a substring scan that can over-trigger; the CLI
  //    re-checks for safety.
  if (toolName !== '' && toolName !== 'Bash') {
    return { exitCode: 0, stderr };
  }

  // 4. Empty command → allow.
  if (cmd.length === 0) {
    return { exitCode: 0, stderr };
  }

  // 5a. Direct source/cp of .env — segment-anchored.
  if (
    anySegmentStartsWith(cmd, PATTERN_SOURCE) ||
    anySegmentStartsWith(cmd, PATTERN_CP_ENV)
  ) {
    writeStderr(buildSourceBanner(cmd));
    return { exitCode: 2, stderr };
  }

  // 5b. Utility + .env co-occurrence within the same segment.
  if (anySegmentMatchesBoth(cmd, PATTERN_UTILITY, PATTERN_ENV_FILE)) {
    writeStderr(buildReadBanner(cmd));
    return { exitCode: 2, stderr };
  }

  return { exitCode: 0, stderr };
}

/**
 * CLI entry point — `rea hook env-file-protection`.
 */
export async function runHookEnvFileProtection(
  options: EnvFileProtectionOptions = {},
): Promise<void> {
  const result = await runEnvFileProtection({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}

// Internal exports for byte-fidelity / banner-drift tests.
export const __INTERNAL_PATTERNS_FOR_TESTS = {
  PATTERN_UTILITY,
  PATTERN_SOURCE,
  PATTERN_CP_ENV,
  PATTERN_ENV_FILE,
};
