/**
 * G2 (Bash-tier) — verify-gate Bash write guard (Artifact Gates, 0.54.0+).
 *
 * The editor-tier verify-gate (`src/hooks/verify-gate/`) refuses a
 * Write/Edit/MultiEdit/NotebookEdit to `.rea/tasks.jsonl` that completes a
 * task without evidence. That gate is BYPASSABLE via a raw Bash redirect:
 *
 *     echo '{"id":"t1","status":"completed"}' > .rea/tasks.jsonl
 *     python -c "..." > .rea/tasks.jsonl
 *     tee .rea/tasks.jsonl < payload
 *
 * A Bash command's RESULTING file content cannot be inspected before the
 * command runs, so this gate cannot replicate the editor gate's
 * evidence-existence check. Instead it takes the only sound enforce posture
 * for an un-inspectable write: under `g2_verify.mode` shadow/enforce it
 * REFUSES (enforce) / LOGS (shadow) any Bash command that WRITES or
 * REDIRECTS to `.rea/tasks.jsonl`, directing the agent to the sanctioned
 * `rea tasks` CLI (which enforces the evidence invariant). Under `off` the
 * command is allowed byte-identically (no scan, no audit).
 *
 * ## Write-target detection — reuse, do not hand-roll
 *
 * Target detection delegates to the AST-backed `runBlockedScan`
 * (`src/hooks/bash-scanner/`) with a single synthetic blocked entry,
 * `.rea/tasks.jsonl`. That machinery already models every shell write form
 * the blocked_paths gate models — `>`/`>>`/`&>` redirects, `tee`, `cp`/`mv`
 * destinations, `dd of=`, `install`, `sed -i`, nested `sh -c`, symlink
 * resolution, and refuse-on-uncertainty for dynamic targets — so this gate
 * inherits all of it without re-parsing redirects. A `block` verdict means
 * "this command writes to `.rea/tasks.jsonl`".
 *
 * ## Out of scope (documented residuals)
 *
 *   - `python -c "open('.rea/tasks.jsonl','w')"` and other interpreter-
 *     internal writes: the walker models SHELL write targets, not what an
 *     interpreter does with its argv. The editor gate + `rea tasks` CLI
 *     remain the primary enforcement; this gate closes the shell-redirect
 *     class only.
 *   - A fully-dynamic target whose command never names the store
 *     (`F=$(...); echo x > "$F"` with the assignment in a PRIOR command):
 *     the relevance pre-gate skips it, matching the editor gate's
 *     file-path scoping and the shim's relevance filter.
 *
 * ## Order of operations
 *
 * stdin is parsed FIRST so the payload `cwd` can feed worktree root
 * resolution (mirrors `blocked-paths-bash-gate`). HALT keys off BOTH roots
 * (repo-wide kill switch); the gate mode keys off the LOCAL (worktree)
 * root; audit lands on the COMMON (repository) root. `off` is resolved
 * before any scan so a non-opted-in repo is byte-identical to the gate not
 * existing.
 */

import type { Buffer } from 'node:buffer';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots, listSiblingWorktreeRoots } from '../../lib/worktree-roots.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import { runBlockedScan } from '../bash-scanner/index.js';
import { loadPolicy } from '../../policy/loader.js';
import type { GateMode } from '../../policy/types.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../audit/append.js';
// Reuse the editor-gate audit tool names so BOTH G2 gates land under the
// same vocabulary — a coverage accept-list keyed on `rea.gate.g2` sees the
// Bash-tier refusal exactly like the editor-tier one; the shadow sibling
// (`rea.gate.g2.shadow`) is likewise shared.
import { G2_TOOL_NAME, G2_SHADOW_TOOL_NAME } from '../verify-gate/index.js';

const SERVER_NAME = 'rea' as const;

/**
 * The synthetic blocked entry fed to `runBlockedScan`. Project-relative,
 * lowercase — the scanner normalizes targets against the (worktree /
 * primary-checkout) root and matches case-insensitively.
 */
const TASKS_RELATIVE = '.rea/tasks.jsonl';

export interface VerifyGateBashGateOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface VerifyGateBashGateResult {
  exitCode: number;
  stderr: string;
  /** Resolved gate mode (test seam). */
  mode: GateMode;
  /** True when a write to `.rea/tasks.jsonl` was detected (test seam). */
  detected: boolean;
}

/**
 * Relevance pre-gate. The scanner only needs to run when the command
 * plausibly names the task store — the filename `tasks.jsonl` cannot be
 * obfuscated away (the file IS named that), so requiring BOTH substrings is
 * robust to quoting/backslash tricks on the path prefix while still bounding
 * the scan (and the refuse-on-uncertainty posture) to plausibly-relevant
 * commands. Case-insensitive for defence-in-depth.
 */
function commandReferencesTaskStore(cmd: string): boolean {
  return /tasks/i.test(cmd) && /jsonl/i.test(cmd);
}

function refusalBanner(): string {
  return (
    `ARTIFACT GATE G2 (verification, bash-tier): direct shell write to ` +
    `.rea/tasks.jsonl refused.\n\n` +
    `A raw redirect / tee / cp / mv into the task store bypasses the evidence\n` +
    `invariant the store enforces. Use the sanctioned CLI instead:\n\n` +
    `  rea tasks add "<title>"\n` +
    `  rea tasks evidence <id> --add <path>\n` +
    `  rea tasks complete <id>   # refuses a no-evidence completion\n\n` +
    `The editor-tier G2 gate enforces the same on Write/Edit; this gate closes\n` +
    `the Bash redirect path. Gate posture: policy.artifact_gates.g2_verify.mode.\n`
  );
}

function uncertainBanner(reason: string): string {
  return (
    `ARTIFACT GATE G2 (verification, bash-tier): refusing on uncertainty ` +
    `(${reason}).\n` +
    `The Bash command could not be verified free of a write to .rea/tasks.jsonl.\n` +
    `Mutate the task store via \`rea tasks\` instead.\n`
  );
}

/**
 * Pure executor. Returns `{ exitCode, stderr, mode, detected }`; the CLI
 * wrapper translates them into `process.stderr.write` + `process.exit`.
 */
export async function runVerifyGateBashGate(
  options: VerifyGateBashGateOptions = {},
): Promise<VerifyGateBashGateResult> {
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  // Parse FIRST (for cwd). A parse error is UNCERTAIN, resolved per-mode below.
  let toolName = '';
  let cmd = '';
  let payloadCwd = '';
  let parseError = false;
  try {
    const payload = parseHookPayload(stdinRaw);
    toolName = payload.toolName;
    cmd = payload.command;
    payloadCwd = payload.cwd;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      parseError = true;
    } else {
      throw err;
    }
  }

  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(payloadCwd, options.reaRoot);

  // HALT — uniform across the hook tier, the kill switch always wins.
  const halt = checkHaltRoots(reaRoot, commonRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, mode: 'off', detected: false };
  }

  // Resolve the gate mode. A missing/invalid policy or absent artifact_gates
  // block resolves to `off` — the gate is default-off. Mirrors the editor
  // gate's strict-loader-then-off posture so BOTH G2 gates agree on mode.
  let mode: GateMode = 'off';
  try {
    const policy = loadPolicy(reaRoot);
    mode = policy.artifact_gates?.g2_verify.mode ?? 'off';
  } catch {
    mode = 'off';
  }

  // OFF → byte-identical to the gate not existing. No scan, no audit.
  if (mode === 'off') {
    return { exitCode: 0, stderr, mode, detected: false };
  }

  const audit = async (
    toolNameForRecord: string,
    status: InvocationStatus,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await appendAuditRecord(commonRoot, {
        tool_name: toolNameForRecord,
        server_name: SERVER_NAME,
        tier: Tier.Write,
        status,
        metadata,
      });
    } catch {
      /* best-effort — an audit-write failure must not change the verdict */
    }
  };

  const resolveHit = async (
    metadata: Record<string, unknown>,
    banner: string,
  ): Promise<VerifyGateBashGateResult> => {
    if (mode === 'shadow') {
      await audit(G2_SHADOW_TOOL_NAME, InvocationStatus.Allowed, { ...metadata, source: 'bash' });
      return { exitCode: 0, stderr, mode, detected: true };
    }
    // enforce
    await audit(G2_TOOL_NAME, InvocationStatus.Denied, { ...metadata, source: 'bash' });
    writeStderr(banner);
    return { exitCode: 2, stderr, mode, detected: true };
  };

  // UNCERTAIN: malformed payload. UNCERTAIN ≡ REFUSE at enforce; log at shadow.
  if (parseError) {
    return resolveHit(
      { would_block: true, reason: 'malformed_payload' },
      uncertainBanner('malformed payload'),
    );
  }

  // Non-Bash tool calls bypass (Claude Code already filters, defence-in-depth).
  if (toolName !== '' && toolName !== 'Bash') {
    return { exitCode: 0, stderr, mode, detected: false };
  }

  // Empty command → allow.
  if (cmd.length === 0) {
    return { exitCode: 0, stderr, mode, detected: false };
  }

  // Relevance pre-gate: skip the scan (and its refuse-on-uncertainty posture)
  // for commands that do not name the task store.
  if (!commandReferencesTaskStore(cmd)) {
    return { exitCode: 0, stderr, mode, detected: false };
  }

  // Detect a shell write to `.rea/tasks.jsonl` by reusing the AST-backed
  // blocked-scan with a single synthetic entry. A `block` verdict = a write
  // (static match) OR an unresolvable target on a store-naming command
  // (refuse-on-uncertainty) — both are G2 hits.
  const siblingRoots = listSiblingWorktreeRoots(commonRoot, reaRoot);
  const verdict = runBlockedScan(
    {
      reaRoot,
      commonRoot,
      siblingRoots,
      blockedPaths: [TASKS_RELATIVE],
      // A cross-root target (worktree → primary/sibling) is still the task
      // store of THAT stream — union with the same synthetic entry.
      blockedPathsForRoot: () => [TASKS_RELATIVE],
    },
    cmd,
  );

  if (verdict.verdict !== 'block') {
    return { exitCode: 0, stderr, mode, detected: false };
  }

  return resolveHit(
    {
      would_block: true,
      reason: 'bash_write_to_tasks',
      ...(verdict.detected_form !== undefined ? { detected_form: verdict.detected_form } : {}),
      command_preview: cmd.slice(0, 256),
    },
    refusalBanner(),
  );
}

/**
 * CLI entry point — `rea hook verify-gate-bash-gate`.
 */
export async function runHookVerifyGateBashGate(
  options: VerifyGateBashGateOptions = {},
): Promise<void> {
  const result = await runVerifyGateBashGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
