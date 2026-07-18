/**
 * G2 — verification-gate (Artifact Gates, 0.54.0+).
 *
 * A PreToolUse Write/Edit/MultiEdit/NotebookEdit gate over
 * `.rea/tasks.jsonl`. It refuses a write whose RESULTING file content
 * transitions ANY task record to `status: 'completed'` while its
 * `evidence` is empty or absent. Defence-in-depth with the CLI invariant
 * already enforced in `rea tasks complete` (`src/cli/tasks.ts`): the CLI
 * refuses a no-evidence completion, and this gate refuses the same
 * transition when it arrives via a raw file write instead of the CLI.
 *
 * ## Doctrine (deterministic — no model judgment)
 *
 * The gate performs an EXISTENCE check only: parse the resulting JSONL,
 * fold to latest-per-id, and flag any `completed` record with no
 * evidence. It never evaluates the QUALITY of evidence — a single path
 * satisfies it. Three modes (from `policy.artifact_gates.g2_verify.mode`):
 *
 *   - `off`     — silent no-op (exit 0), byte-identical to the gate not
 *                 existing. This is the default when the policy block (or
 *                 the whole policy) is absent.
 *   - `shadow`  — log a `rea.gate.g2.shadow` would-block audit event and
 *                 ALLOW (exit 0). NEVER blocks.
 *   - `enforce` — log a `rea.gate.g2` deny audit event and BLOCK (exit 2)
 *                 with a banner. NEVER prompts — the gate must survive an
 *                 overnight autonomous run, so it fails into the
 *                 artifact/audit trail, not an interactive question.
 *
 * ## UNCERTAIN ≡ REFUSE (at enforce only)
 *
 * A malformed payload, or an `Edit`/`MultiEdit` whose resulting file
 * cannot be reconstructed, is UNCERTAIN. At `enforce` the gate refuses
 * (it cannot prove the write is safe); at `shadow` it logs + allows; at
 * `off` it is silent. The shadow tool name (`rea.gate.g2.shadow`) mirrors
 * the review-shadow precedent (`src/audit/local-review-event.ts`): a
 * distinct name that no coverage accept-list consults.
 *
 * ## Order of operations
 *
 * stdin is parsed FIRST so the payload's `cwd` can feed worktree root
 * resolution (mirrors `changeset-security-gate`). HALT keys off BOTH
 * roots (repo-wide kill switch); policy keys off the LOCAL (worktree)
 * root; audit lands on the COMMON (repository) root.
 */

import type { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots } from '../../lib/worktree-roots.js';
import {
  parseWriteHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import { loadPolicy } from '../../policy/loader.js';
import type { GateMode } from '../../policy/types.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../audit/append.js';

/** Canonical audit tool name for an enforced G2 refusal. */
export const G2_TOOL_NAME = 'rea.gate.g2' as const;
/**
 * Shadow audit tool name — a would-block event that never blocks. A
 * distinct sibling name (like `rea.local_review.shadow`) that no coverage
 * accept-list consults.
 */
export const G2_SHADOW_TOOL_NAME = 'rea.gate.g2.shadow' as const;
const SERVER_NAME = 'rea' as const;

export interface VerifyGateOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
  stdoutWrite?: (s: string) => void;
}

export interface VerifyGateResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const TASKS_RELATIVE = '.rea/tasks.jsonl';

/**
 * True when `filePath` names `.rea/tasks.jsonl` (relative or absolute,
 * Windows or POSIX separators). The gate only acts on this one file.
 */
function isTasksJsonl(filePath: string): boolean {
  if (filePath.length === 0) return false;
  const posix = filePath.replace(/\\/g, '/');
  return posix === TASKS_RELATIVE || posix.endsWith('/' + TASKS_RELATIVE);
}

/**
 * Canonicalize an absolute path, tolerating a not-yet-existing leaf.
 *
 * Round-19 F2: if `abs` is ITSELF a symlink, follow it (readlink + resolve
 * against its dir) EVEN WHEN the target does not exist yet — chained links are
 * followed iteratively, depth-guarded. `realpathSync` throws on a dangling
 * link, and the parent-only fallback would canonicalize the LINK's own path
 * (`.../tasklog`) instead of its target, so `tasklog -> .rea/tasks.jsonl` on a
 * fresh repo (before `tasks.jsonl` exists) would slip past G2 enforce. This
 * mirrors the bash shim's `_vg_resolve` (single-level readlink even for a
 * non-existent target).
 *
 * For a non-symlink (or once the chain terminates at a non-link name): return
 * `realpathSync(abs)` if it exists, else `realpath(dirname)+basename` so a
 * not-yet-created leaf still canonicalizes under its resolved parent.
 *
 * Fail-safe by construction: every fs call is guarded, so an unresolvable path
 * yields `null`. The caller treats `null` as "no match" — an unresolvable path
 * NEVER turns a previously-allowed write into a refusal; this only ADDS
 * detection where canonicalization SUCCEEDS and reveals a link to the store.
 */
function canonicalizePath(abs: string, depth = 0): string | null {
  if (depth >= 40) return null; // cyclic / pathological link chain — give up
  // Follow a symlink leaf manually so a DANGLING link resolves to its target,
  // not to the link's own path.
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      const resolved = path.isAbsolute(target) ? target : path.join(path.dirname(abs), target);
      return canonicalizePath(resolved, depth + 1);
    }
  } catch {
    /* lstat/readlink failed — fall through to the realpath attempts below */
  }
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return null;
    }
  }
}

/**
 * True when `filePath` — after symlink resolution — points at the real
 * `.rea/tasks.jsonl` of the worktree (or the primary checkout). Closes the
 * round-12 F3 gap: a `Write`/`Edit` to `tasklog -> .rea/tasks.jsonl` mutates
 * the real store, but its raw `file_path` does not literally name it, so
 * `isTasksJsonl` alone would wave it through. Mirrors the bash-tier gate's
 * symlink canonicalization (`bash-scanner` resolves redirect/cp/mv targets).
 */
function resolvesToTasksJsonl(
  reaRoot: string,
  commonRoot: string,
  payloadCwd: string,
  filePath: string,
): boolean {
  if (filePath.length === 0) return false;
  const roots = commonRoot.length > 0 && commonRoot !== reaRoot ? [reaRoot, commonRoot] : [reaRoot];
  const storeCanons: string[] = [];
  for (const root of roots) {
    const c = canonicalizePath(path.resolve(root, TASKS_RELATIVE));
    if (c !== null) storeCanons.push(c);
  }
  if (storeCanons.length === 0) return false;

  const candidates = path.isAbsolute(filePath)
    ? [filePath]
    : [
        path.resolve(reaRoot, filePath),
        ...(payloadCwd.length > 0 ? [path.resolve(payloadCwd, filePath)] : []),
      ];
  for (const cand of candidates) {
    const cc = canonicalizePath(cand);
    if (cc !== null && storeCanons.includes(cc)) return true;
  }
  return false;
}

interface LooseTaskRecord {
  id?: unknown;
  status?: unknown;
  evidence?: unknown;
}

/**
 * Parse resulting JSONL content, fold to latest-per-id (last write wins —
 * matching `readTasks`), and return the ids of every record that ends in
 * `status: 'completed'` with empty/absent `evidence`. Records without a
 * string `id` that are still `completed`-without-evidence surface as
 * `(unknown)` so a malformed completion can't slip through un-flagged.
 *
 * Deterministic: JSON structure only, no content evaluation.
 */
export function detectBadCompletions(content: string): string[] {
  const folded = new Map<string, LooseTaskRecord>();
  const anonymous: LooseTaskRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // tolerant — a partial trailing line is skipped, like the store reader
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const rec = parsed as LooseTaskRecord;
    if (typeof rec.id === 'string' && rec.id.length > 0) {
      folded.set(rec.id, rec);
    } else {
      anonymous.push(rec);
    }
  }
  // Round-10 P2: a usable evidence array needs at least one NON-BLANK
  // string path — `evidence: [""]` / whitespace is not evidence.
  const hasEvidence = (rec: LooseTaskRecord): boolean =>
    Array.isArray(rec.evidence) &&
    rec.evidence.some((e) => typeof e === 'string' && e.trim().length > 0);
  const isBad = (rec: LooseTaskRecord): boolean => rec.status === 'completed' && !hasEvidence(rec);
  const bad: string[] = [];
  for (const [id, rec] of folded) {
    if (isBad(rec)) bad.push(id);
  }
  for (const rec of anonymous) {
    if (isBad(rec)) bad.push('(unknown)');
  }
  return bad;
}

/**
 * Multiset difference `after \ before` (round-10 P2). Each element of
 * `after` is kept unless matched one-for-one by an element of `before`,
 * so a bad-completion id already present in the prior store is not
 * re-flagged, while a genuinely new one (or an extra anonymous bad row)
 * still surfaces.
 */
function multisetDiff(after: string[], before: string[]): string[] {
  const counts = new Map<string, number>();
  for (const b of before) counts.set(b, (counts.get(b) ?? 0) + 1);
  const out: string[] = [];
  for (const a of after) {
    const c = counts.get(a) ?? 0;
    if (c > 0) counts.set(a, c - 1);
    else out.push(a);
  }
  return out;
}

/**
 * Reconstruct the RESULTING `.rea/tasks.jsonl` content for the write.
 *
 *   - Write / NotebookEdit (or unknown tool): `content` IS the resulting
 *     file (the whole-file payload).
 *   - Edit: read the current file and apply `old_string` → `new_string`
 *     (honoring `replace_all`), trying the repo-root and cwd bases like
 *     `changeset-security-gate`.
 *   - MultiEdit: read the current file and apply each `edits[]` entry in
 *     order.
 *
 * Returns `null` when an Edit/MultiEdit result cannot be reconstructed
 * (unreadable/missing file, an `old_string` that is absent or not
 * locatable) — the caller treats `null` as UNCERTAIN.
 */
function reconstructResult(
  reaRoot: string,
  payloadCwd: string,
  filePath: string,
  toolName: string,
  content: string,
  stdinRaw: string | Buffer,
): string | null {
  if (toolName !== 'Edit' && toolName !== 'MultiEdit') {
    return content;
  }
  const current = readCurrentFile(reaRoot, payloadCwd, filePath);
  if (current === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof stdinRaw === 'string' ? stdinRaw : stdinRaw.toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const ti = (parsed as { tool_input?: unknown }).tool_input;
  if (ti === null || typeof ti !== 'object') return null;

  if (toolName === 'Edit') {
    const rec = ti as { old_string?: unknown; new_string?: unknown; replace_all?: unknown };
    if (typeof rec.old_string !== 'string') return null;
    return applyEdit(current, rec.old_string, typeof rec.new_string === 'string' ? rec.new_string : '', rec.replace_all === true);
  }

  // MultiEdit — apply each edit in order against the running content.
  const edits = (ti as { edits?: unknown }).edits;
  if (!Array.isArray(edits) || edits.length === 0) return null;
  let running = current;
  for (const edit of edits) {
    if (edit === null || typeof edit !== 'object') return null;
    const e = edit as { old_string?: unknown; new_string?: unknown; replace_all?: unknown };
    if (typeof e.old_string !== 'string') return null;
    const next = applyEdit(
      running,
      e.old_string,
      typeof e.new_string === 'string' ? e.new_string : '',
      e.replace_all === true,
    );
    if (next === null) return null;
    running = next;
  }
  return running;
}

/** Apply a single old→new replacement; returns null when `old` is absent/non-locatable. */
function applyEdit(current: string, oldStr: string, newStr: string, replaceAll: boolean): string | null {
  if (oldStr.length === 0 || !current.includes(oldStr)) return null;
  if (replaceAll) return current.split(oldStr).join(newStr);
  const idx = current.indexOf(oldStr);
  return current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
}

/** Read the current on-disk `.rea/tasks.jsonl`, trying repo-root then cwd bases. */
function readCurrentFile(reaRoot: string, payloadCwd: string, filePath: string): string | null {
  const candidates = path.isAbsolute(filePath)
    ? [filePath]
    : [
        path.resolve(reaRoot, filePath),
        ...(payloadCwd.length > 0 ? [path.resolve(payloadCwd, filePath)] : []),
      ];
  for (const cand of candidates) {
    try {
      return fs.readFileSync(cand, 'utf8');
    } catch {
      /* try the next base */
    }
  }
  return null;
}

function banner(taskIds: string[]): string {
  const label =
    taskIds.length === 1 ? `ticket ${taskIds[0]}` : `tickets ${taskIds.join(', ')}`;
  return (
    `ARTIFACT GATE G2 (verification): ${label} cannot close without evidence.\n\n` +
    `A task record was written with status "completed" but no evidence.\n` +
    `Record evidence before completing:\n` +
    `  rea tasks evidence <id> --add <path>\n` +
    `then complete via \`rea tasks complete <id>\` (which enforces the same invariant).\n`
  );
}

function uncertainBanner(reason: string): string {
  return (
    `ARTIFACT GATE G2 (verification): refusing on uncertainty (${reason}).\n` +
    `The resulting .rea/tasks.jsonl could not be verified free of a ` +
    `no-evidence completion. Re-issue the write as a full-file Write, or ` +
    `use \`rea tasks\` to mutate the store.\n`
  );
}

/** Emit the Claude Code PreToolUse deny JSON on stdout plus the reason on stderr. */
function emitJsonBlock(reason: string): { json: string; stderr: string } {
  const obj = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  return { json: JSON.stringify(obj) + '\n', stderr: reason + '\n' };
}

export async function runVerifyGate(options: VerifyGateOptions = {}): Promise<VerifyGateResult> {
  let stderr = '';
  let stdout = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };
  const writeStdout = (s: string): void => {
    stdout += s;
    if (options.stdoutWrite) options.stdoutWrite(s);
  };

  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  // Parse FIRST (for cwd); a parse error is UNCERTAIN, resolved per-mode below.
  let toolName = '';
  let filePath = '';
  let content = '';
  let payloadCwd = '';
  let parseError = false;
  try {
    const payload = parseWriteHookPayload(stdinRaw);
    toolName = payload.toolName;
    filePath = payload.filePath;
    content = payload.content;
    payloadCwd = payload.cwd;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      parseError = true;
    } else {
      throw err;
    }
  }

  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(payloadCwd, options.reaRoot);

  // HALT is uniform across the hook tier — the kill switch always wins.
  const halt = checkHaltRoots(reaRoot, commonRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, stdout };
  }

  // Resolve the gate mode. A missing/invalid policy, or an absent
  // artifact_gates block, resolves to `off` — the gate is default-off.
  let mode: GateMode = 'off';
  try {
    const policy = loadPolicy(reaRoot);
    mode = policy.artifact_gates?.g2_verify.mode ?? 'off';
  } catch {
    mode = 'off';
  }
  if (mode === 'off') {
    return { exitCode: 0, stderr, stdout };
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

  // UNCERTAIN: malformed payload.
  if (parseError) {
    return resolveVerdict({
      mode,
      reason: 'malformed_payload',
      metadata: { would_block: true, reason: 'malformed_payload' },
      bannerText: uncertainBanner('malformed payload'),
      audit,
      writeStderr,
      writeStdout,
      stderrRef: () => stderr,
      stdoutRef: () => stdout,
    });
  }

  // Only act on `.rea/tasks.jsonl` — the literal name (fast path) OR a
  // symlink resolving to it (round-12 F3). The resolved check canonicalizes
  // `file_path` and its parent, so `tasklog -> .rea/tasks.jsonl` is caught;
  // it is fail-safe (an unresolvable path yields no match, never a crash).
  if (
    !isTasksJsonl(filePath) &&
    !resolvesToTasksJsonl(reaRoot, commonRoot, payloadCwd, filePath)
  ) {
    return { exitCode: 0, stderr, stdout };
  }

  const resulting = reconstructResult(reaRoot, payloadCwd, filePath, toolName, content, stdinRaw);
  if (resulting === null) {
    // UNCERTAIN: an Edit/MultiEdit whose result can't be reconstructed.
    return resolveVerdict({
      mode,
      reason: 'unreconstructable_edit',
      metadata: { would_block: true, reason: 'unreconstructable_edit', file_path: filePath },
      bannerText: uncertainBanner('edit result not reconstructable'),
      audit,
      writeStderr,
      writeStdout,
      stderrRef: () => stderr,
      stdoutRef: () => stdout,
    });
  }

  // Round-10 P2: block only completions NEWLY introduced by THIS write —
  // a pre-existing historical `completed`-without-evidence row (e.g.
  // from before opting into G2) must not deadlock every later write.
  // Multiset diff of bad-completion ids: resulting minus prior.
  const priorContent = readCurrentFile(reaRoot, payloadCwd, filePath) ?? '';
  const badIds = multisetDiff(detectBadCompletions(resulting), detectBadCompletions(priorContent));
  if (badIds.length === 0) {
    return { exitCode: 0, stderr, stdout };
  }

  return resolveVerdict({
    mode,
    reason: 'no_evidence_completion',
    metadata: { would_block: true, task_ids: badIds, file_path: filePath },
    bannerText: banner(badIds),
    audit,
    writeStderr,
    writeStdout,
    stderrRef: () => stderr,
    stdoutRef: () => stdout,
  });
}

interface ResolveVerdictArgs {
  mode: GateMode;
  reason: string;
  metadata: Record<string, unknown>;
  bannerText: string;
  audit: (
    toolNameForRecord: string,
    status: InvocationStatus,
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  writeStderr: (s: string) => void;
  writeStdout: (s: string) => void;
  stderrRef: () => string;
  stdoutRef: () => string;
}

/**
 * Shared shadow/enforce resolution: shadow logs a would-block event and
 * allows (exit 0); enforce logs a deny event, emits the deny JSON + banner,
 * and blocks (exit 2).
 */
async function resolveVerdict(args: ResolveVerdictArgs): Promise<VerifyGateResult> {
  if (args.mode === 'shadow') {
    await args.audit(G2_SHADOW_TOOL_NAME, InvocationStatus.Allowed, args.metadata);
    return { exitCode: 0, stderr: args.stderrRef(), stdout: args.stdoutRef() };
  }
  // enforce
  await args.audit(G2_TOOL_NAME, InvocationStatus.Denied, args.metadata);
  const out = emitJsonBlock(args.bannerText);
  args.writeStdout(out.json);
  args.writeStderr(out.stderr);
  return { exitCode: 2, stderr: args.stderrRef(), stdout: args.stdoutRef() };
}

/**
 * CLI entry — `rea hook verify-gate`.
 */
export async function runHookVerifyGate(options: VerifyGateOptions = {}): Promise<void> {
  const result = await runVerifyGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
    stdoutWrite: (s) => process.stdout.write(s),
  });
  process.exit(result.exitCode);
}
