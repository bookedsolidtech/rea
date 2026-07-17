/**
 * Node-binary port of `hooks/protected-paths-bash-gate.sh`.
 *
 * 0.35.0 Phase 3 port (paired tier-1 scanner-shim). Like blocked-paths-
 * bash-gate but uses `runProtectedScan` against the
 * `policy.protected_writes` / `policy.protected_paths_relax` resolved
 * set. The bash gate was already a thin shim over the parser-backed
 * scanner; this port drops the shim → CLI → scanner subprocess hop.
 *
 * Behavioral contract — preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with shared banner.
 *   2. Read stdin via `parseHookPayload`. Empty/missing command → exit 0.
 *   3. Non-Bash tool calls bypass.
 *   4. REA_HOOK_PATCH_SESSION-class bypass: when the env var is set with
 *      a non-empty reason, the scanner's protected-set is RELAXED for
 *      .claude/hooks/ — the patch-session pattern. Implemented by
 *      appending `.claude/hooks/` to the relax list when the env var is
 *      live (this mirrors the bash gate's §6b semantics for the Bash
 *      tier).
 *   5. Load policy permissively (same lesson as 0.34.0 round-2 P2).
 *   6. Run `runProtectedScan` with the resolved policy context.
 *   7. Verdict `block` → exit 2; `allow` → exit 0.
 *
 * Audit-log parity: emits a `rea.hook.protected-paths-bash-gate` entry.
 */

import type { Buffer } from 'node:buffer';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots, listSiblingWorktreeRoots } from '../../lib/worktree-roots.js';
import { resolveProtectedPatterns } from '../_lib/protected-paths.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import { runProtectedScan, type Verdict } from '../bash-scanner/index.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../audit/append.js';

export interface ProtectedPathsBashGateOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
  /**
   * Test seam — overrides `process.env.REA_HOOK_PATCH_SESSION`. The
   * CLI wrapper omits, letting the real env var govern the bypass.
   */
  patchSessionOverride?: string;
}

export interface ProtectedPathsBashGateResult {
  exitCode: number;
  stderr: string;
  /** Final verdict (test seam). Null when the gate short-circuited
   *  before scanning (HALT, non-Bash, empty cmd). */
  verdict: Verdict | null;
}

interface PermissivePolicy {
  protectedWrites?: string[];
  protectedRelax: string[];
}

/**
 * Passwd-derived absolute home for the `~/.rea` global-root scanner gate.
 * `os.userInfo().homedir` (libuv `getpwuid_r`), NEVER `$HOME` / `$XDG_*`.
 * Undefined on passwd-lookup failure or a non-absolute home → gate
 * disabled (feature-absent parity, mirroring `shim_global_entry_gate`).
 */
function passwdDerivedHome(): string | undefined {
  try {
    const home = os.userInfo().homedir;
    if (typeof home === 'string' && home.startsWith('/')) return home;
  } catch {
    /* no passwd entry → gate disabled */
  }
  return undefined;
}

function loadPolicyPermissive(reaRoot: string): PermissivePolicy {
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  const empty: PermissivePolicy = { protectedRelax: [] };
  if (!fs.existsSync(policyPath)) return empty;
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty;
  }
  const obj = parsed as Record<string, unknown>;
  const out: PermissivePolicy = { protectedRelax: [] };
  if (Array.isArray(obj['protected_writes'])) {
    out.protectedWrites = [];
    for (const e of obj['protected_writes']) {
      if (typeof e === 'string' && e.length > 0) out.protectedWrites.push(e);
    }
  }
  if (Array.isArray(obj['protected_paths_relax'])) {
    for (const e of obj['protected_paths_relax']) {
      if (typeof e === 'string' && e.length > 0) out.protectedRelax.push(e);
    }
  }
  return out;
}

export async function runProtectedPathsBashGate(
  options: ProtectedPathsBashGateOptions = {},
): Promise<ProtectedPathsBashGateResult> {
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 2. Read + parse stdin.
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
        `protected-paths-bash-gate: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr, verdict: { verdict: 'block', reason: err.message } };
    }
    throw err;
  }

  // Roots + HALT (0.54.0 worktree state): the payload's `cwd` feeds the
  // resolution ladder, so stdin is parsed FIRST — a deliberate reorder.
  // Policy/path checks key off the LOCAL (worktree) root; audit and the
  // kill switch key off the COMMON (repository) root.
  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(payloadCwd, options.reaRoot);
  // 1. HALT check.
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
  const policy = loadPolicyPermissive(reaRoot);
  const relax = [...policy.protectedRelax];

  // 6. REA_HOOK_PATCH_SESSION — relax .claude/hooks/ when env var is
  //    set with a non-empty reason. Mirrors settings-protection.sh §6b
  //    posture (the Bash-tier counterpart wasn't enforcing this against
  //    .claude/hooks/ until 0.35.0 — that gap is closed here).
  const patchSession =
    options.patchSessionOverride ?? process.env['REA_HOOK_PATCH_SESSION'] ?? '';
  if (patchSession.length > 0) {
    relax.push('.claude/hooks/');
  }

  // 7. Scan. Passwd-derived home enables the `~/.rea` global-root gate
  //    (safe-global-CLI). Never `$HOME` / `$XDG_*` — an agent can move
  //    those in-process; a passwd-lookup failure disables the gate
  //    (feature-absent parity, mirroring the shim's silent "unavailable").
  const passwdHome = passwdDerivedHome();
  const verdict = runProtectedScan(
    {
      reaRoot,
      // 0.54.0: absolute writes into the primary checkout's shared
      // `.rea/` state — or a sibling worktree's governed state
      // (round-10 P1) — match the protected list via cross-root
      // normalization.
      commonRoot,
      siblingRoots: listSiblingWorktreeRoots(commonRoot, reaRoot),
      protectedPatternsForRoot: protectedPatternsForRootPermissive,
      policy: {
        ...(policy.protectedWrites !== undefined
          ? { protected_writes: policy.protectedWrites }
          : {}),
        protected_paths_relax: relax,
      },
      ...(passwdHome !== undefined ? { passwdHome } : {}),
      stderr: (line) => writeStderr(line),
    },
    cmd,
  );

  // 8. Audit.
  try {
    await appendAuditRecord(commonRoot, {
      tool_name: 'rea.hook.protected-paths-bash-gate',
      server_name: 'rea',
      tier: Tier.Read,
      status: verdict.verdict === 'allow' ? InvocationStatus.Allowed : InvocationStatus.Denied,
      metadata: {
        verdict: verdict.verdict,
        ...(verdict.detected_form !== undefined ? { detected_form: verdict.detected_form } : {}),
        ...(verdict.hit_pattern !== undefined ? { hit_pattern: verdict.hit_pattern } : {}),
        ...(patchSession.length > 0 ? { patch_session: true } : {}),
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


// Round-12 P2: resolve a TARGET root's own protected pattern set (its
// protected_writes | invariants, its relax applied). Permissive read —
// a broken target policy degrades to [] (the strict defaults still
// apply via the union in the scanner).
function protectedPatternsForRootPermissive(root: string): {
  patterns: readonly string[];
  overridePatterns: readonly string[];
} {
  try {
    const parsed = parseYaml(fs.readFileSync(path.join(root, '.rea', 'policy.yaml'), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { patterns: [], overridePatterns: [] };
    }
    const rec = parsed as Record<string, unknown>;
    const writes = Array.isArray(rec['protected_writes'])
      ? (rec['protected_writes'] as unknown[]).filter(
          (e): e is string => typeof e === 'string' && e.length > 0,
        )
      : undefined;
    const relax = Array.isArray(rec['protected_paths_relax'])
      ? (rec['protected_paths_relax'] as unknown[]).filter(
          (e): e is string => typeof e === 'string' && e.length > 0,
        )
      : [];
    const resolved = resolveProtectedPatterns({
      ...(writes !== undefined ? { protectedWrites: writes } : {}),
      protectedPathsRelax: relax,
    });
    // Round-28 P2: overridePatterns keep their precedence over the
    // husky .d extension allow-list on cross-root writes.
    return { patterns: resolved.patterns, overridePatterns: resolved.overridePatterns };
  } catch {
    return { patterns: [], overridePatterns: [] };
  }
}

export async function runHookProtectedPathsBashGate(
  options: ProtectedPathsBashGateOptions = {},
): Promise<void> {
  const result = await runProtectedPathsBashGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
