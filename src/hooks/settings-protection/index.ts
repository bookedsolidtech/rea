/**
 * Node-binary port of `hooks/settings-protection.sh`.
 *
 * 0.35.0 Phase 4 port. The LARGEST hook in the repo at 582 LOC of
 * bash — this is the gate that protects `.claude/settings.json`,
 * `.claude/hooks/*`, `.husky/*`, `.rea/policy.yaml`, and `.rea/HALT`
 * from agent writes. Without it the entire governance layer can be
 * disabled by an agent's own Write tool.
 *
 * Behavioral contract — preserves the bash hook section by section:
 *
 *   1. HALT check → exit 2 with shared banner.
 *   2. Read stdin, extract `tool_input.file_path` (or `notebook_path`
 *      via the shared Write payload parser). Missing → exit 0.
 *
 *   §5a Path-traversal reject (`..` segment in raw OR normalized form).
 *   §5a-bis Interior `/./` segment reject (NORMALIZED form only).
 *
 *   §5b Extension-surface allow-list. `.husky/{commit-msg,pre-push,
 *       pre-commit,prepare-commit-msg}.d/*` is the documented consumer
 *       extension surface — fragments here are NOT protected, with
 *       two defense-in-depth checks:
 *         (a) Final-component symlink refusal (`fs.lstatSync().isSymbolicLink()`).
 *         (b) Intermediate-directory symlink resolution — the parent's
 *             realpath must STILL end in `/.husky/<surface>.d/` or
 *             `/.husky/<surface>.d` (directory-boundary anchored per
 *             0.20.1 helix-021 #3).
 *
 *   §6  Default-protected list resolution. Sourced from
 *       `_lib/protected-paths.ts`'s `resolveProtectedPatterns` which
 *       honors `protected_writes` (full override) and
 *       `protected_paths_relax` (subtractor). Match runs case-insensitive.
 *
 *   §6c Intermediate-symlink resolution against the hard-protected list
 *       (helix-016 H.1 fix). Parallel to §5b's surface-only check, this
 *       runs against ANY protected pattern.
 *
 *   §6b REA_HOOK_PATCH_SESSION unlock for `.claude/hooks/` (the only
 *       patch-session pattern). When the env var is set with a non-
 *       empty reason, audit-log the edit (via the shared TS audit
 *       primitive — directly, no shell-out gymnastics) and allow.
 *       Audit-append failure is fail-closed — block the edit and
 *       surface the failure. This preserves hash-chain integrity.
 *
 *   §6c-bis Patch-session patterns blocked when env var is NOT set.
 *
 * Stderr formatting is preserved verbatim from the bash hook so
 * existing log-parsing consumers (if any) keep working.
 */

import type { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
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
import {
  resolveProtectedPatterns,
  matchAny,
  isExtensionSurface,
  PATCH_SESSION_PATTERNS,
  sanitizeForStderr,
} from '../_lib/protected-paths.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../audit/append.js';

export interface SettingsProtectionOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
  /** Test seam — overrides `process.env.REA_HOOK_PATCH_SESSION`. */
  patchSessionOverride?: string;
  /** Test seam — overrides `process.env.CLAUDE_SESSION_ID`. */
  sessionIdOverride?: string;
}

export interface SettingsProtectionResult {
  exitCode: number;
  stderr: string;
  /**
   * When the gate blocks: the matched pattern (one of PROTECTED_PATTERNS,
   * PATCH_SESSION_PATTERNS, or a §5a/§5a-bis sentinel string).
   */
  matched: string | null;
  /** When the gate blocks via §5b extension-surface symlink refusal. */
  surfaceSymlinkRefused: boolean;
  /** When the gate allows under REA_HOOK_PATCH_SESSION. */
  patchSessionAllowed: boolean;
}

interface PermissivePolicy {
  protectedWrites?: string[];
  protectedRelax: string[];
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

/** sha256 of a file's contents, or '' on any failure. */
function sha256File(filePath: string): string {
  try {
    // Use the same shell helpers the bash hook tried in order so any
    // pre-existing operator scripts keep parity. Falling back to node
    // crypto when the file is present.
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return '';
  }
}

function gitConfig(reaRoot: string, key: string): string {
  try {
    return execSync(`git -C "${reaRoot.replace(/"/g, '\\"')}" config ${key}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export async function runSettingsProtection(
  options: SettingsProtectionOptions = {},
): Promise<SettingsProtectionResult> {
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
        `settings-protection: ${err.message} — refusing on uncertainty.\n`,
      );
      return {
        exitCode: 2,
        stderr,
        matched: null,
        surfaceSymlinkRefused: false,
        patchSessionAllowed: false,
      };
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
    return {
      exitCode: 2,
      stderr,
      matched: null,
      surfaceSymlinkRefused: false,
      patchSessionAllowed: false,
    };
  }
  if (filePath.length === 0) {
    return {
      exitCode: 0,
      stderr,
      matched: null,
      surfaceSymlinkRefused: false,
      patchSessionAllowed: false,
    };
  }

  // 3. Normalize.
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
  const safeFilePath = sanitizeForStderr(filePath);
  const safeNormalized = sanitizeForStderr(normalized);

  // §5a. Path traversal reject.
  const rawSlashed = filePath.replace(/\\/g, '/');
  const rawTraversal = hasTraversalSegment(rawSlashed);
  const normTraversal = hasTraversalSegment(normalized);
  if (rawTraversal || normTraversal) {
    writeStderr('SETTINGS PROTECTION: path traversal rejected\n');
    writeStderr('\n');
    writeStderr(`  File: ${safeFilePath}\n`);
    writeStderr("  Rule: path contains a '..' segment; rewrite to a canonical\n");
    writeStderr('        project-relative path without traversal.\n');
    return {
      exitCode: 2,
      stderr,
      matched: '__traversal__',
      surfaceSymlinkRefused: false,
      patchSessionAllowed: false,
    };
  }

  // §5a-bis. Interior /./ segment reject.
  if (hasInteriorDotSegment(normalized)) {
    writeStderr('SETTINGS PROTECTION: interior dot-segment rejected\n');
    writeStderr('\n');
    writeStderr(`  File: ${safeFilePath}\n`);
    writeStderr("  Rule: path contains an interior '/./' segment; rewrite to a\n");
    writeStderr('        canonical project-relative path without dot segments.\n');
    return {
      exitCode: 2,
      stderr,
      matched: '__interior_dot__',
      surfaceSymlinkRefused: false,
      patchSessionAllowed: false,
    };
  }

  // §5b. Extension-surface allow-list (.husky/{commit-msg,pre-push,
  //      pre-commit,prepare-commit-msg}.d/*).
  if (isExtensionSurface(normalized)) {
    // (a) Final-component symlink refusal.
    let isFinalSymlink = false;
    try {
      const st = fs.lstatSync(filePath);
      isFinalSymlink = st.isSymbolicLink();
    } catch {
      /* file doesn't exist — fine */
    }
    if (isFinalSymlink) {
      writeStderr('SETTINGS PROTECTION: symlink in extension surface refused\n');
      writeStderr('\n');
      writeStderr(`  File: ${safeFilePath}\n`);
      writeStderr('  Rule: .husky/{commit-msg,pre-push,prepare-commit-msg}.d/* must\n');
      writeStderr('        be regular files (a symlink could resolve to a protected\n');
      writeStderr('        package-managed body and bypass §6 protection).\n');
      return {
        exitCode: 2,
        stderr,
        matched: '__surface_symlink__',
        surfaceSymlinkRefused: true,
        patchSessionAllowed: false,
      };
    }
    // (b) Intermediate-directory symlink resolution.
    const parentDir = path.dirname(filePath);
    let parentIsDir = false;
    try {
      parentIsDir = fs.statSync(parentDir).isDirectory();
    } catch {
      /* parent doesn't exist — bash hook does nothing */
    }
    if (parentIsDir) {
      let resolvedParent = '';
      try {
        resolvedParent = fs.realpathSync(parentDir);
      } catch {
        /* fall-through with empty */
      }
      if (resolvedParent.length > 0) {
        // Directory-boundary anchored — 0.20.1 helix-021 #3 fix.
        // Match `*/.husky/{surface}.d` or `*/.husky/{surface}.d/*` exactly.
        //
        // Codex round-1 P2 fix: pre-commit IS in the documented
        // extension surface via isExtensionSurface(), so writes inside
        // .husky/pre-commit.d/ route through this branch. Without
        // `pre-commit` in this surfaces array the legitimate fragment
        // is denied as "extension path resolves outside surface".
        // The bash hook's surfaces list omitted `pre-commit` because
        // it was added later — preserve the bash behavior for the
        // OTHER surfaces but close the regression for pre-commit here.
        const surfaces = ['commit-msg', 'pre-push', 'pre-commit', 'prepare-commit-msg'];
        let matchedSurface = false;
        for (const s of surfaces) {
          const dir = `/.husky/${s}.d`;
          if (
            resolvedParent.endsWith(dir) ||
            resolvedParent.includes(dir + '/')
          ) {
            matchedSurface = true;
            break;
          }
        }
        if (!matchedSurface) {
          writeStderr('SETTINGS PROTECTION: extension path resolves outside surface\n');
          writeStderr('\n');
          writeStderr(`  Logical:  ${safeFilePath}\n`);
          writeStderr(`  Resolved: ${resolvedParent}\n`);
          writeStderr('  Rule: an intermediate directory of the extension path is a\n');
          writeStderr('        symlink whose target leaves .husky/{commit-msg,pre-push,prepare-commit-msg}.d/.\n');
          writeStderr('        Refused to prevent symlinked-parent bypass of the\n');
          writeStderr('        package-managed body protection.\n');
          return {
            exitCode: 2,
            stderr,
            matched: '__surface_parent_symlink__',
            surfaceSymlinkRefused: true,
            patchSessionAllowed: false,
          };
        }
      }
    }
    // Documented extension surface — allow.
    return {
      exitCode: 0,
      stderr,
      matched: null,
      surfaceSymlinkRefused: false,
      patchSessionAllowed: false,
    };
  }

  // §6. Default-protected list resolution.
  const permPolicy = loadPolicyPermissive(reaRoot);
  const resolution = resolveProtectedPatterns({
    ...(permPolicy.protectedWrites !== undefined
      ? { protectedWrites: permPolicy.protectedWrites }
      : {}),
    protectedPathsRelax: permPolicy.protectedRelax,
  });
  for (const adv of resolution.advisories) writeStderr(adv);

  // §6 match (case-insensitive — matchAny lowercases the pattern side).
  const directHit = matchAny(lowerNorm, resolution.patterns);
  if (directHit !== null) {
    writeStderr('SETTINGS PROTECTION: Modification blocked\n');
    writeStderr('\n');
    writeStderr(`  File: ${safeFilePath}\n`);
    writeStderr(`  Matched: ${directHit}\n`);
    writeStderr('  Rule: This file is protected from agent modification, including\n');
    writeStderr('        sessions with REA_HOOK_PATCH_SESSION set.\n');
    return {
      exitCode: 2,
      stderr,
      matched: directHit,
      surfaceSymlinkRefused: false,
      patchSessionAllowed: false,
    };
  }

  // §6c. Intermediate-symlink resolution against the hard-protected list.
  const symRefused = checkProtectedSymlinkResolution(
    filePath,
    resolution.patterns,
    reaRoot,
    commonRoot,
  );
  if (symRefused !== null) {
    writeStderr('SETTINGS PROTECTION: intermediate-symlink resolution blocked\n');
    writeStderr('\n');
    writeStderr(`  Logical:  ${safeFilePath}\n`);
    writeStderr(`  Resolved: ${symRefused.resolvedTarget}\n`);
    writeStderr(`  Matched:  ${symRefused.pattern}\n`);
    writeStderr('  Rule: an intermediate directory of the target path is a\n');
    writeStderr('        symlink whose target falls inside a hard-protected\n');
    writeStderr('        path. Refused to prevent symlinked-parent bypass.\n');
    return {
      exitCode: 2,
      stderr,
      matched: symRefused.pattern,
      surfaceSymlinkRefused: false,
      patchSessionAllowed: false,
    };
  }

  // §6b. REA_HOOK_PATCH_SESSION unlock for .claude/hooks/.
  const patchSession =
    options.patchSessionOverride ?? process.env['REA_HOOK_PATCH_SESSION'] ?? '';
  if (patchSession.length > 0) {
    const patchHit = matchAny(lowerNorm, PATCH_SESSION_PATTERNS);
    if (patchHit !== null) {
      const safeReason = sanitizeForStderr(patchSession);
      const shaBefore = sha256File(filePath);
      const actorName = gitConfig(reaRoot, 'user.name');
      const actorEmail = gitConfig(reaRoot, 'user.email');
      const sessionId =
        options.sessionIdOverride ?? process.env['CLAUDE_SESSION_ID'] ?? 'external';
      try {
        await appendAuditRecord(commonRoot, {
          session_id: sessionId,
          tool_name: 'hooks.patch.session',
          server_name: 'rea',
          tier: Tier.Write,
          status: InvocationStatus.Allowed,
          autonomy_level: 'unknown',
          duration_ms: 0,
          metadata: {
            reason: patchSession,
            file: normalized,
            sha_before: shaBefore,
            actor: { name: actorName, email: actorEmail },
            pid: process.pid,
            ppid: process.ppid,
          },
        });
      } catch (e) {
        // Fail closed — hash-chain integrity is the contract.
        const detail = e instanceof Error ? e.message : String(e);
        writeStderr('SETTINGS PROTECTION: audit-append failed; refusing hook-patch edit\n');
        writeStderr(`  File: ${safeFilePath}\n`);
        writeStderr('  Rule: hash-chained audit is required; no raw-jq fallback.\n');
        writeStderr(`  Detail: ${sanitizeForStderr(detail)}\n`);
        return {
          exitCode: 2,
          stderr,
          matched: patchHit,
          surfaceSymlinkRefused: false,
          patchSessionAllowed: false,
        };
      }
      writeStderr(
        `REA_HOOK_PATCH_SESSION: allowing edit to ${safeNormalized} (reason: ${safeReason})\n`,
      );
      return {
        exitCode: 0,
        stderr,
        matched: null,
        surfaceSymlinkRefused: false,
        patchSessionAllowed: true,
      };
    }
  }

  // §6c-bis. Patch-session patterns blocked when env var is NOT set.
  const patchHitBlocked = matchAny(lowerNorm, PATCH_SESSION_PATTERNS);
  if (patchHitBlocked !== null) {
    writeStderr('SETTINGS PROTECTION: Modification blocked\n');
    writeStderr('\n');
    writeStderr(`  File: ${safeFilePath}\n`);
    writeStderr(`  Matched: ${patchHitBlocked}\n`);
    writeStderr('  Rule: Files under this path are protected. To apply an upstream\n');
    writeStderr('        hook finding, set REA_HOOK_PATCH_SESSION=<reason> and retry.\n');
    return {
      exitCode: 2,
      stderr,
      matched: patchHitBlocked,
      surfaceSymlinkRefused: false,
      patchSessionAllowed: false,
    };
  }

  return {
    exitCode: 0,
    stderr,
    matched: null,
    surfaceSymlinkRefused: false,
    patchSessionAllowed: false,
  };
}

/**
 * §6c — intermediate-symlink resolution against the hard-protected list.
 * Mirrors `hooks/settings-protection.sh` lines ~410-444.
 */
function checkProtectedSymlinkResolution(
  filePath: string,
  patterns: readonly string[],
  reaRoot: string,
  commonRoot?: string,
): { pattern: string; resolvedTarget: string } | null {
  // Only attempt resolution if the target exists OR its parent dir exists.
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
    /* fall through */
  }
  if (!targetExists && !parentExists) return null;
  if (!parentExists) return null;

  const resolvedParent = resolveParentRealpath(filePath);
  if (resolvedParent.length === 0) return null;

  // 0.54.0 round-5 P1: a worktree-local symlink pointed at the PRIMARY
  // checkout resolves outside the local canon root — fall through to
  // the COMMON canon root so `shared -> <primary>/.rea` writes still
  // match the protected patterns for the repo-wide shared state.
  let canonRoot = resolveCanonRoot(reaRoot);
  if (resolvedParent !== canonRoot && !resolvedParent.startsWith(canonRoot + '/')) {
    if (commonRoot === undefined || commonRoot === reaRoot) return null;
    const canonCommon = resolveCanonRoot(commonRoot);
    if (resolvedParent !== canonCommon && !resolvedParent.startsWith(canonCommon + '/')) {
      return null;
    }
    canonRoot = canonCommon;
  }
  const relativeResolved =
    resolvedParent === canonRoot ? '' : resolvedParent.slice(canonRoot.length + 1);
  const resolvedTarget = relativeResolved.length > 0
    ? `${relativeResolved}/${path.basename(filePath)}`
    : path.basename(filePath);
  const resolvedTargetLc = resolvedTarget.toLowerCase();
  for (const pattern of patterns) {
    const patternLc = pattern.toLowerCase();
    if (resolvedTargetLc === patternLc) {
      return { pattern, resolvedTarget };
    }
    if (patternLc.endsWith('/') && resolvedTargetLc.startsWith(patternLc)) {
      return { pattern, resolvedTarget };
    }
  }
  return null;
}

export async function runHookSettingsProtection(
  options: SettingsProtectionOptions = {},
): Promise<void> {
  const result = await runSettingsProtection({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
