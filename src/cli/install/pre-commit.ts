/**
 * Pre-commit hook installer for the G1 spec-gate (Artifact Gates, 0.54.0+).
 *
 * The `.husky/pre-commit` hook invokes `rea gate spec-check`, which is a
 * DEFAULT-OFF deterministic gate (`policy.artifact_gates.g1_spec.mode`
 * defaults to `off`). Because the gate is off unless a consumer opts in,
 * this installer is intentionally MINIMAL — it does NOT carry the full
 * v-marker migration machinery of `pre-push.ts`. A single managed marker
 * pair plus a foreign-hook guard is enough.
 *
 * ## Install policy
 *
 *   - absent      → install the managed hook
 *   - rea-managed → refresh (idempotent — re-running produces the same file)
 *   - foreign     → leave alone; the operator wires the fragment themselves
 *
 * NOTE (orchestrator hand-off): this module is deliberately NOT yet wired
 * into `src/cli/install/canonical.ts` (DirMapping / synthetic set),
 * `manifest-schema` (source kind), `rea init`, or `rea upgrade`. Wiring it
 * touches the canonical enumeration + manifest + perf-baseline surface,
 * which is the "large/risky install-layer" work the gate spec flagged to
 * defer. The gate LOGIC (`src/cli/gate.ts`) is fully functional and
 * `rea gate spec-check` is registered; this file provides the ready hook
 * body + a testable installer for that follow-up.
 */

import crypto from 'node:crypto';
import type fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

/**
 * Header marker (line 2, immediately after the shebang) identifying a
 * rea-managed pre-commit hook. v1 — first release of the G1 spec-gate
 * pre-commit fragment.
 */
export const PRE_COMMIT_MARKER = '# rea:pre-commit-spec-gate v1';

/**
 * Body marker (line 3). A hook that carries the header marker but has an
 * emptied body is NOT classified as rea-managed — a real rea hook carries
 * both markers.
 */
export const PRE_COMMIT_BODY_MARKER = '# rea:pre-commit-body-v1';

/**
 * The POSIX-sh body. Mirrors the pre-push CLI-resolution ladder but stays
 * minimal: HALT is handled inside `rea gate spec-check` itself (it probes
 * both roots), so the body only resolves the rea CLI and dispatches. A
 * missing CLI is fail-OPEN here (exit 0) — the gate is default-off, so a
 * consumer without a built CLI must not have every commit blocked.
 */
const BODY_TEMPLATE = `set -eu

# REA spec-gate (G1, Artifact Gates). The gate logic — staged-diff sizing,
# active-task + committed-spec resolution, off/shadow/enforce dispatch, and
# audit — lives in \`src/cli/gate.ts\` and is invoked via
# \`rea gate spec-check\`. This stub only resolves the rea CLI and dispatches.
#
# The gate is DEFAULT-OFF (policy.artifact_gates.g1_spec.mode defaults to
# off), so a missing CLI fails OPEN (exit 0) rather than blocking every
# commit on a repo whose CLI is not built.

REA_ROOT=\$(git rev-parse --show-toplevel 2>/dev/null || pwd)

if [ -x "\${REA_ROOT}/node_modules/.bin/rea" ]; then
  "\${REA_ROOT}/node_modules/.bin/rea" gate spec-check
elif [ -f "\${REA_ROOT}/dist/cli/index.js" ] && [ -f "\${REA_ROOT}/package.json" ] \\
     && grep -q '"name": *"@bookedsolid/rea"' "\${REA_ROOT}/package.json" 2>/dev/null; then
  node "\${REA_ROOT}/dist/cli/index.js" gate spec-check
elif command -v rea >/dev/null 2>&1; then
  rea gate spec-check
elif command -v npx >/dev/null 2>&1; then
  npx --no-install @bookedsolid/rea gate spec-check
else
  # CLI unreachable — fail OPEN (the gate is default-off).
  exit 0
fi
`;

/** The full `.husky/pre-commit` file content. */
export function preCommitHookContent(): string {
  return `#!/bin/sh
${PRE_COMMIT_MARKER}
${PRE_COMMIT_BODY_MARKER}
#
# Pre-commit hook installed by rea for the G1 spec-gate. Do NOT edit by
# hand — re-run the installer to refresh. See src/cli/gate.ts.

${BODY_TEMPLATE}`;
}

/**
 * True when `content` is a rea-managed pre-commit hook — shebang on line
 * 1, header marker on line 2, body marker on line 3. Strict anchored
 * matching (no substring search) so a comment mentioning the marker can't
 * reclassify a foreign hook.
 */
export function isReaManagedPreCommit(content: string): boolean {
  if (!content.startsWith('#!/bin/sh\n')) return false;
  const lines = content.split('\n');
  return lines[1] === PRE_COMMIT_MARKER && lines[2] === PRE_COMMIT_BODY_MARKER;
}

export type PreCommitDecision =
  | { action: 'install'; hookPath: string }
  | { action: 'refresh'; hookPath: string }
  | { action: 'skip'; reason: 'foreign-pre-commit'; hookPath: string };

/**
 * Classify the existing `.husky/pre-commit` at `targetDir`.
 */
export async function classifyPreCommit(targetDir: string): Promise<PreCommitDecision> {
  const hookPath = path.join(targetDir, '.husky', 'pre-commit');
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(hookPath);
  } catch {
    return { action: 'install', hookPath };
  }
  if (!stat.isFile()) return { action: 'skip', reason: 'foreign-pre-commit', hookPath };
  let content: string;
  try {
    content = await fsPromises.readFile(hookPath, 'utf8');
  } catch {
    return { action: 'skip', reason: 'foreign-pre-commit', hookPath };
  }
  if (isReaManagedPreCommit(content)) return { action: 'refresh', hookPath };
  return { action: 'skip', reason: 'foreign-pre-commit', hookPath };
}

export interface PreCommitInstallResult {
  decision: PreCommitDecision;
  written?: string;
}

/**
 * Install (or refresh) the managed `.husky/pre-commit` hook. Never
 * overwrites a foreign hook. Writes atomically via a temp file + rename.
 */
export async function installPreCommitHook(options: {
  targetDir: string;
}): Promise<PreCommitInstallResult> {
  const decision = await classifyPreCommit(options.targetDir);
  if (decision.action === 'skip') {
    return { decision };
  }
  const dir = path.dirname(decision.hookPath);
  await fsPromises.mkdir(dir, { recursive: true });
  const rand = crypto.randomBytes(8).toString('hex');
  const tmp = path.join(dir, `${path.basename(decision.hookPath)}.rea-tmp-${rand}`);
  await fsPromises.writeFile(tmp, preCommitHookContent(), { encoding: 'utf8', mode: 0o755 });
  try {
    await fsPromises.chmod(tmp, 0o755);
  } catch {
    /* filesystems that don't honor mode — writeFile already set it */
  }
  await fsPromises.rename(tmp, decision.hookPath);
  return { decision, written: decision.hookPath };
}
