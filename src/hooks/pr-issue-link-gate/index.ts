/**
 * Node-binary port of `hooks/pr-issue-link-gate.sh`.
 *
 * 0.32.0 Phase 1 Pilot #1 — selected first because the bash original
 * has the smallest dependency surface in the hook tree:
 *
 *   - No segment splitter (just substring match on `gh pr create`)
 *   - No `--body-file` resolution
 *   - No multi-pattern catalog
 *   - Advisory only (always exits 0)
 *
 * That makes it the safest place to validate the playbook end-to-end:
 * archive bash → write TS module → wire `rea hook pr-issue-link-gate`
 * subcommand → replace .sh with a 15-line shim → mirror to
 * `.claude/hooks/pr-issue-link-gate.sh` (PROTECTED — staged for git
 * apply) → byte-fidelity test → consumer migration via `rea upgrade`
 * picks up the new shim on next install.
 *
 * Behavioral contract — preserves bash hook byte-for-byte:
 *
 *   1. HALT check — exits 2 with banner when `.rea/HALT` is present.
 *      Bash original called `check_halt` from `_lib/halt-check.sh`;
 *      Node port calls the shared `checkHalt` primitive in
 *      `src/hooks/_lib/halt-check.ts`. Same fail-closed posture.
 *   2. Reads stdin payload, extracts `tool_input.command`. When the
 *      tool isn't `Bash`, exits 0 silently (matches bash original
 *      `[[ "$TOOL_NAME" != "Bash" ]] && exit 0`).
 *   3. When command does NOT contain `gh\s+pr\s+create`, exits 0.
 *   4. When command DOES contain a closing keyword paired with `#N`
 *      (case-insensitive `closes`/`fixes`/`resolves` + whitespace +
 *      `#` + digits), exits 0 — the agent has already linked an issue.
 *   5. Otherwise, prints the same advisory banner to stderr and exits
 *      0 (advisory only — never blocks).
 *
 * Wider-net pattern choice: the bash original used `grep -qiE
 * 'gh\s+pr\s+create'` (free `\s` shorthand). The Node port uses the
 * equivalent JavaScript regex `/gh\s+pr\s+create/i` — same byte
 * outcomes for ASCII inputs, which is the only shape `gh` accepts.
 */

import type { Buffer } from 'node:buffer';
import { checkHalt, formatHaltBanner } from '../_lib/halt-check.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';

export interface PrIssueLinkGateOptions {
  /**
   * Override REA_ROOT. Production caller relies on
   * `$CLAUDE_PROJECT_DIR` → `process.cwd()`. Tests set this.
   */
  reaRoot?: string;
  /**
   * Pre-supplied stdin bytes. When set, skip the stdin read and feed
   * this string into `parseHookPayload`. Tests use this to avoid
   * touching `process.stdin`.
   */
  stdinOverride?: string | Buffer;
  /**
   * Test seam — receives every stderr write the gate produces. Default
   * is `(s) => process.stderr.write(s)`.
   */
  stderrWrite?: (s: string) => void;
}

/**
 * Result tuple — `{ exitCode, stderr }`. The CLI wrapper translates
 * `exitCode` into `process.exit`; tests inspect `stderr` for the
 * advisory banner shape.
 *
 * `exitCode` follows the bash hook's contract:
 *   0 — allow / advisory only
 *   2 — HALT active OR malformed payload (fail-closed)
 *
 * The bash hook itself never exits non-zero except via `check_halt`;
 * the Node port adds the malformed-JSON fail-closed exit mirroring
 * `runHookScanBash`'s posture (an attacker who can craft a payload
 * shouldn't get a free allow).
 */
export interface PrIssueLinkGateResult {
  exitCode: number;
  /** Full stderr concatenated for test inspection. */
  stderr: string;
}

const ADVISORY_BANNER = [
  'PR ISSUE LINK ADVISORY: This PR does not reference a GitHub issue.\n',
  '\n',
  'When a PR body includes a closing reference, GitHub automatically:\n',
  '  - Closes the issue when the PR merges to the default branch\n',
  '  - Creates a cross-reference in the issue timeline\n',
  '  - Links the PR in the CHANGELOG context\n',
  '\n',
  'Add to the --body:\n',
  '  closes #N    closes one issue\n',
  '  fixes #N     same effect\n',
  '  resolves #N  same effect\n',
  '  closes #N, closes #M   closes multiple issues\n',
  '\n',
  'If this is a chore, release, or hotfix PR with no upstream issue, you may proceed.\n',
].join('');

/**
 * Pure executor — no `process.exit`, no stdin read (when
 * `stdinOverride` is set), no HALT-check side effects beyond reading
 * the file. Returns the exit code + full stderr; the CLI wrapper
 * applies them to the actual process.
 */
export async function runPrIssueLinkGate(
  options: PrIssueLinkGateOptions = {},
): Promise<PrIssueLinkGateResult> {
  const reaRoot =
    options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 1. HALT check — fail-closed (exit 2).
  const halt = checkHalt(reaRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr };
  }

  // 2. Read stdin.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let toolName = '';
  let cmd = '';
  try {
    const payload = parseHookPayload(stdinRaw);
    toolName = payload.toolName;
    cmd = payload.command;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr(
        `pr-issue-link-gate: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr };
    }
    throw err;
  }

  // 3. Only Bash tool calls.
  if (toolName !== '' && toolName !== 'Bash') {
    return { exitCode: 0, stderr };
  }

  // 4. Only `gh pr create`.
  if (!/gh\s+pr\s+create/i.test(cmd)) {
    return { exitCode: 0, stderr };
  }

  // 5. Closing keyword paired with `#N` → satisfied, no advisory.
  if (/(closes|fixes|resolves)\s+#[0-9]+/i.test(cmd)) {
    return { exitCode: 0, stderr };
  }

  // 6. Advisory.
  writeStderr(ADVISORY_BANNER);
  return { exitCode: 0, stderr };
}

/**
 * CLI entry — `rea hook pr-issue-link-gate`. Wires the pure executor
 * to `process.stderr.write` + `process.exit`. Mirrors the wiring
 * pattern in `runHookScanBash` / `runHookCodexReview`.
 */
export async function runHookPrIssueLinkGate(
  options: PrIssueLinkGateOptions = {},
): Promise<void> {
  const result = await runPrIssueLinkGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}

// Internal export — used by the byte-fidelity test to assert the
// advisory banner string hasn't drifted vs. the bash hook's
// `printf` lines.
export const __INTERNAL_ADVISORY_BANNER_FOR_TESTS = ADVISORY_BANNER;

