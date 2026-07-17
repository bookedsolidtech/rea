/**
 * Node-binary port of `hooks/blocked-paths-enforcer.sh`.
 *
 * 0.35.0 Phase 4 port (paired Write/Edit tier). Enforces
 * `policy.blocked_paths` against Write/Edit/MultiEdit/NotebookEdit
 * tool calls. Sibling of `blocked-paths-bash-gate` (Bash-tier) — same
 * policy data, different surface.
 *
 * Behavioral contract — preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with shared banner.
 *   2. Read stdin, extract `tool_input.file_path` (or `notebook_path`).
 *      Missing/empty → exit 0.
 *   3. Load policy permissively (a partial / migrating policy.yaml
 *      must NOT collapse the blocked_paths list).
 *   4. Empty `blocked_paths` → exit 0.
 *   5. §5a path-traversal rejection. Refuses any path with a `..`
 *      segment in EITHER the raw form OR the normalized form. Also
 *      catches URL-encoded traversal (`%2E%2E/`, `..%2F`, etc.)
 *      against the raw input.
 *   6. §5a-bis interior `/./` segment rejection (0.29.0 helix-/./-class).
 *      NORMALIZED form only — `normalize_path` already strips leading
 *      `./` segments, so anything remaining is interior by construction.
 *   7. Agent-writable allow-list short-circuit (`.rea/tasks.jsonl`,
 *      `.rea/audit/`) — even if blocked_paths includes `.rea/` as a
 *      prefix block, these are PM-data writeables.
 *   8. Match the normalized path against each blocked entry:
 *        - directory prefix (entry ends with `/`)
 *        - glob (entry contains `*`)
 *        - exact (lower-case, case-INSENSITIVE)
 *      Match → exit 2 with reason.
 *   9. §H.2 intermediate-symlink resolution. If the parent dir exists,
 *      resolve its realpath. If the resolved target falls inside a
 *      blocked entry, refuse.
 *
 * Audit-log parity: emits a `rea.hook.blocked-paths-enforcer` entry.
 */

import type { Buffer } from 'node:buffer';
import path from 'node:path';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots } from '../../lib/worktree-roots.js';
import {
  parseWriteHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import {
  normalizePath,
  hasTraversalSegment,
  hasInteriorDotSegment,
  resolveCanonRoot,
  resolveParentRealpath,
} from '../_lib/path-normalize.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../audit/append.js';

export interface BlockedPathsEnforcerOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface BlockedPathsEnforcerResult {
  exitCode: number;
  stderr: string;
  /** Test seam — when the gate blocks, the matched blocked-paths entry. */
  matched: string | null;
}

const AGENT_WRITABLE: readonly string[] = ['.rea/tasks.jsonl', '.rea/audit/'];

/** Match `pathLc` against a single blocked entry. Returns true on hit. */
function matchBlockedEntry(pathLc: string, blockedEntry: string): boolean {
  const entryLc = blockedEntry.toLowerCase();
  // Directory prefix.
  if (entryLc.endsWith('/')) {
    if (pathLc.startsWith(entryLc)) return true;
    if (pathLc === entryLc.slice(0, -1)) return true;
    return false;
  }
  // Glob (contains *).
  if (entryLc.includes('*')) {
    // Convert glob to regex: . → \., * → .*; anchor to whole string.
    const escaped = entryLc.replace(/[.+^${}()|[\]\\]/g, (m) => `\\${m}`);
    const re = '^' + escaped.replace(/\*/g, '.*') + '$';
    try {
      return new RegExp(re).test(pathLc);
    } catch {
      return false;
    }
  }
  // Exact.
  return pathLc === entryLc;
}

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
    if (typeof entry === 'string' && entry.length > 0) out.push(entry);
  }
  return out;
}

export async function runBlockedPathsEnforcer(
  options: BlockedPathsEnforcerOptions = {},
): Promise<BlockedPathsEnforcerResult> {
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

  let filePath = '';
  let payloadCwd = '';
  try {
    const payload = parseWriteHookPayload(stdinRaw);
    payloadCwd = payload.cwd;
    filePath = payload.filePath;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr(
        `blocked-paths-enforcer: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr, matched: null };
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
    return { exitCode: 2, stderr, matched: null };
  }
  if (filePath.length === 0) {
    return { exitCode: 0, stderr, matched: null };
  }

  // 3. Load policy permissively.
  const blockedPaths = loadBlockedPathsPermissive(reaRoot);
  if (blockedPaths.length === 0) {
    return { exitCode: 0, stderr, matched: null };
  }

  // 4. Normalize.
  let normalized = normalizePath(filePath, reaRoot);
  // 0.54.0 worktree state (review round-4): an absolute target that
  // normalizePath left ABSOLUTE (outside the local root) but that lands
  // INSIDE the COMMON root re-normalizes common-relative, so the
  // protected/blocked patterns match the primary checkout's shared
  // enforcement state from a worktree session. Symlink checks below
  // keep using the raw (absolute) filePath — only pattern matching
  // consumes the relative form.
  if (
    commonRoot !== reaRoot &&
    path.isAbsolute(normalized) &&
    (path.resolve(normalized) === path.resolve(commonRoot) ||
      path.resolve(normalized).startsWith(path.resolve(commonRoot) + path.sep))
  ) {
    normalized = normalizePath(filePath, commonRoot);
  }
  const lowerNorm = normalized.toLowerCase();

  // 5. §5a path-traversal rejection. Both raw + normalized.
  const rawTraversal = hasTraversalSegment(filePath.replace(/\\/g, '/'));
  const normTraversal = hasTraversalSegment(normalized);
  // URL-encoded traversal check on raw input.
  const urlEncodedTraversal = /%2[Ee]%2[Ee]|%2[Ee]\.|\.%2[Ee]/.test(filePath);
  if (rawTraversal || normTraversal || urlEncodedTraversal) {
    writeStderr('BLOCKED PATH: path traversal rejected\n');
    writeStderr('\n');
    writeStderr(`  File: ${filePath}\n`);
    writeStderr("  Rule: path contains a '..' segment; rewrite to a canonical\n");
    writeStderr('        project-relative path without traversal.\n');
    return { exitCode: 2, stderr, matched: null };
  }

  // 6. §5a-bis interior `/./` segment rejection.
  if (hasInteriorDotSegment(normalized)) {
    writeStderr('BLOCKED PATH: interior dot-segment rejected\n');
    writeStderr('\n');
    writeStderr(`  File: ${filePath}\n`);
    writeStderr("  Rule: path contains an interior '/./' segment; rewrite to a\n");
    writeStderr('        canonical project-relative path without dot segments.\n');
    return { exitCode: 2, stderr, matched: null };
  }

  // 7. Agent-writable allow-list.
  for (const writable of AGENT_WRITABLE) {
    if (normalized === writable) return { exitCode: 0, stderr, matched: null };
    if (writable.endsWith('/') && normalized.startsWith(writable)) {
      return { exitCode: 0, stderr, matched: null };
    }
  }

  // 8. Match against blocked_paths.
  let matched: string | null = null;
  for (const blocked of blockedPaths) {
    if (matchBlockedEntry(lowerNorm, blocked)) {
      matched = blocked;
      break;
    }
  }
  if (matched !== null) {
    const isGlob = matched.includes('*');
    writeStderr('BLOCKED PATH: Write denied by policy\n');
    writeStderr('\n');
    writeStderr(`  File: ${filePath}\n`);
    writeStderr(`  Blocked by: ${matched}${isGlob ? ' (glob pattern)' : ''}\n`);
    writeStderr('  Source: .rea/policy.yaml → blocked_paths\n');
    if (matched.endsWith('/')) {
      writeStderr('\n');
      writeStderr('  This path is protected by policy. To modify it, a human must\n');
      writeStderr('  either update blocked_paths in policy.yaml or edit the file directly.\n');
    }
    await maybeAudit(commonRoot, 'denied', matched, filePath);
    return { exitCode: 2, stderr, matched };
  }

  // 9. §H.2 intermediate-symlink resolution.
  const symMatched = checkSymlinkResolution(filePath, blockedPaths, reaRoot);
  if (symMatched !== null) {
    writeStderr('BLOCKED PATH: intermediate-symlink resolution blocked\n');
    writeStderr('\n');
    writeStderr(`  Logical:  ${filePath}\n`);
    writeStderr(`  Resolved: ${symMatched.resolvedTarget}\n`);
    writeStderr(`  Blocked by: ${symMatched.entry}\n`);
    writeStderr('  Source: .rea/policy.yaml → blocked_paths\n');
    writeStderr('\n');
    writeStderr('  Rule: an intermediate directory of the path is a symlink\n');
    writeStderr('        whose target falls inside a blocked policy entry.\n');
    await maybeAudit(commonRoot, 'denied', symMatched.entry, filePath);
    return { exitCode: 2, stderr, matched: symMatched.entry };
  }

  await maybeAudit(commonRoot, 'allowed', null, filePath);
  return { exitCode: 0, stderr, matched: null };
}

/**
 * Symlink-resolution check — mirrors `hooks/blocked-paths-enforcer.sh`
 * §H.2. Returns the matched entry + resolved target form, or null.
 */
function checkSymlinkResolution(
  filePath: string,
  blockedPaths: readonly string[],
  reaRoot: string,
): { entry: string; resolvedTarget: string } | null {
  // Only attempt resolution if the target exists or its parent dir
  // exists — matches the bash `if [[ -e "$FILE_PATH" || -d ... ]]`.
  let targetExists = false;
  try {
    targetExists = fs.existsSync(filePath);
  } catch {
    /* fall through */
  }
  const parentDir = path.dirname(filePath);
  let parentExists = false;
  try {
    parentExists = fs.statSync(parentDir).isDirectory();
  } catch {
    /* falls through */
  }
  if (!targetExists && !parentExists) return null;
  if (!parentExists) return null;

  const resolvedParent = resolveParentRealpath(filePath);
  if (resolvedParent.length === 0) return null;

  const canonRoot = resolveCanonRoot(reaRoot);
  // Resolved parent must be inside REA_ROOT for the check to be
  // meaningful — external paths are out of scope (the logical-path
  // matchers handle them).
  if (resolvedParent !== canonRoot && !resolvedParent.startsWith(canonRoot + '/')) {
    return null;
  }
  const relativeResolved =
    resolvedParent === canonRoot ? '' : resolvedParent.slice(canonRoot.length + 1);
  const resolvedTarget = relativeResolved.length > 0
    ? `${relativeResolved}/${path.basename(filePath)}`
    : path.basename(filePath);
  const resolvedTargetLc = resolvedTarget.toLowerCase();
  for (const blocked of blockedPaths) {
    if (matchBlockedEntry(resolvedTargetLc, blocked)) {
      return { entry: blocked, resolvedTarget };
    }
  }
  return null;
}

async function maybeAudit(
  auditRoot: string,
  status: 'allowed' | 'denied',
  matched: string | null,
  filePath: string,
): Promise<void> {
  try {
    await appendAuditRecord(auditRoot, {
      tool_name: 'rea.hook.blocked-paths-enforcer',
      server_name: 'rea',
      tier: Tier.Write,
      status: status === 'allowed' ? InvocationStatus.Allowed : InvocationStatus.Denied,
      metadata: {
        ...(matched !== null ? { matched } : {}),
        file_path_preview: filePath.slice(0, 256),
      },
    });
  } catch {
    /* best-effort */
  }
}

export async function runHookBlockedPathsEnforcer(
  options: BlockedPathsEnforcerOptions = {},
): Promise<void> {
  const result = await runBlockedPathsEnforcer({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
