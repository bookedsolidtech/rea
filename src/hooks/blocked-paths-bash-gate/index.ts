/**
 * Node-binary port of `hooks/blocked-paths-bash-gate.sh`.
 *
 * 0.35.0 Phase 3 port (paired tier-1 scanner-shim). This was a thin
 * bash shim over `rea hook scan-bash --mode blocked` — the heavy
 * lifting (the parser-backed AST walker that closes 9 bypass classes
 * from helix-023 + discord-ops Round 13) lives in `src/hooks/bash-
 * scanner/`.
 *
 * The Node-binary port preserves the same byte-for-byte verdict shape
 * and exit-code contract but eliminates the bash-shim → node-CLI →
 * scanner-module subprocess hop. The caller is now `rea hook blocked-
 * paths-bash-gate`, which calls `runBlockedScan` directly.
 *
 * Behavioral contract — preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with shared banner.
 *   2. Read stdin via `parseHookPayload`. Empty/missing command → exit 0
 *      (the bash gate's `[[ -z "$payload" ]] && exit 0` guard).
 *   3. Non-Bash tool calls bypass — Claude Code's hook matcher already
 *      filters to Bash but defense-in-depth.
 *   4. Load policy permissively (a partial/migrating policy.yaml with
 *      unknown keys must NOT collapse the `blocked_paths` list — same
 *      lesson from 0.33.0 round-1 P3 + 0.34.0 round-2 P2).
 *   5. Empty `blocked_paths` → allow (no-op). Mirrors
 *      `runBlockedScan({ blockedPaths: [] }, cmd)` short-circuit.
 *   6. Run `runBlockedScan` against the command.
 *   7. Verdict `block` → exit 2 with the scanner's reason. Verdict
 *      `allow` → exit 0.
 *
 * Audit-log parity: emits a `rea.hook.blocked-paths-bash-gate` entry
 * (best-effort, never blocks the verdict on audit failure).
 */

import type { Buffer } from 'node:buffer';
import path from 'node:path';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots, listSiblingWorktreeRoots } from '../../lib/worktree-roots.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import { runBlockedScan, type Verdict } from '../bash-scanner/index.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../audit/append.js';

export interface BlockedPathsBashGateOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface BlockedPathsBashGateResult {
  exitCode: number;
  stderr: string;
  /** Final verdict from the scanner (test seam). */
  verdict: Verdict | null;
}

/**
 * Load `blocked_paths` from `<reaRoot>/.rea/policy.yaml` permissively.
 *
 * Why not `loadPolicy`? The strict zod loader refuses partial / unknown
 * keys (it's strict-mode by design). A consumer running a migrating
 * policy.yaml or holding legacy keys would have their `blocked_paths`
 * effectively wiped — silently. The bash gate's pre-0.35.0 yaml grep
 * scanned for the key directly with no schema validation; we mirror
 * that permissive posture by reading `blocked_paths` from the parsed
 * YAML directly without validation.
 *
 * Returns `[]` on any failure (missing file, bad YAML, missing key,
 * unexpected type). Empty list is the "no enforcement" no-op state.
 */
function loadBlockedPathsPermissive(reaRoot: string): string[] {
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  if (!fs.existsSync(policyPath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  const obj = parsed as Record<string, unknown>;
  const bp = obj['blocked_paths'];
  if (!Array.isArray(bp)) return [];
  const out: string[] = [];
  for (const entry of bp) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Pure executor. Returns `{ exitCode, stderr, verdict }`; the CLI
 * wrapper translates them into `process.stderr.write` + `process.exit`.
 */
export async function runBlockedPathsBashGate(
  options: BlockedPathsBashGateOptions = {},
): Promise<BlockedPathsBashGateResult> {
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 1. Read + parse stdin FIRST (0.54.0 worktree roots): the payload's
  //    `cwd` feeds root resolution, so parsing must precede the HALT
  //    check. Deliberate reorder — a malformed payload still refuses
  //    before any root-dependent decision is made.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let toolName = '';
  let cmd = '';
  let payloadCwd = '';
  try {
    const payload = parseHookPayload(stdinRaw);
    toolName = payload.toolName;
    cmd = payload.command;
    payloadCwd = payload.cwd;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr(
        `blocked-paths-bash-gate: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr, verdict: { verdict: 'block', reason: err.message } };
    }
    throw err;
  }

  // 2. Roots + HALT. Policy/scan key off the LOCAL (worktree) root;
  //    audit + the kill switch key off the COMMON (repository) root.
  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(payloadCwd, options.reaRoot);
  const halt = checkHaltRoots(reaRoot, commonRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, verdict: { verdict: 'block', reason: 'rea HALT active' } };
  }

  // 3. Non-Bash tool calls bypass.
  if (toolName !== '' && toolName !== 'Bash') {
    return { exitCode: 0, stderr, verdict: null };
  }

  // 4. Empty command → allow.
  if (cmd.length === 0) {
    return { exitCode: 0, stderr, verdict: null };
  }

  // 5. Load policy permissively.
  const blockedPaths = loadBlockedPathsPermissive(reaRoot);

  // 6. Empty list → allow — unless a CROSS root could contribute its
  //    own blocked_paths (round-12 P1); the scanner's union handles it.
  const siblingRootsForScan = listSiblingWorktreeRoots(commonRoot, reaRoot);
  if (blockedPaths.length === 0 && commonRoot === reaRoot && siblingRootsForScan.length === 0) {
    return { exitCode: 0, stderr, verdict: { verdict: 'allow' } };
  }

  // 7. Scan.
  const verdict = runBlockedScan(
    {
      reaRoot,
      commonRoot,
      siblingRoots: siblingRootsForScan,
      blockedPaths,
      // Round-11 P1: cross-root targets also honor the TARGET stream's
      // own blocked_paths (union semantics).
      blockedPathsForRoot: (root) => loadBlockedPathsPermissive(root),
    },
    cmd,
  );

  // 8. Audit — best-effort, never changes verdict.
  try {
    await appendAuditRecord(commonRoot, {
      tool_name: 'rea.hook.blocked-paths-bash-gate',
      server_name: 'rea',
      tier: Tier.Read,
      status: verdict.verdict === 'allow' ? InvocationStatus.Allowed : InvocationStatus.Denied,
      metadata: {
        verdict: verdict.verdict,
        ...(verdict.detected_form !== undefined ? { detected_form: verdict.detected_form } : {}),
        ...(verdict.hit_pattern !== undefined ? { hit_pattern: verdict.hit_pattern } : {}),
        command_preview: cmd.slice(0, 256),
      },
    });
  } catch {
    /* best-effort */
  }

  if (verdict.verdict === 'block') {
    if (typeof verdict.reason === 'string' && verdict.reason.length > 0) {
      writeStderr(verdict.reason + '\n');
    }
    return { exitCode: 2, stderr, verdict };
  }
  return { exitCode: 0, stderr, verdict };
}

/**
 * CLI entry point — `rea hook blocked-paths-bash-gate`.
 */
export async function runHookBlockedPathsBashGate(
  options: BlockedPathsBashGateOptions = {},
): Promise<void> {
  const result = await runBlockedPathsBashGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
