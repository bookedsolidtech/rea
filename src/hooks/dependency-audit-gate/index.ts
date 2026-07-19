/**
 * Node-binary port of `hooks/dependency-audit-gate.sh`.
 *
 * 0.33.0 Phase 1 port #2.
 *
 * Detects npm/pnpm/yarn `install|i|add` invocations and verifies that
 * every named package exists on the npm registry before allowing the
 * install. The original bash hook is the LARGEST member of the 0.33.0
 * tier-1 batch (179 LOC) and the only one in this tier that makes a
 * NETWORK call (spawning `npm view <pkg> name`).
 *
 * Behavioral contract preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with shared banner.
 *   2. Read stdin → `tool_input.command`. Non-Bash tool → exit 0.
 *   3. Empty command → exit 0.
 *   4. Use the shared quote-aware segmenter to split on shell command
 *      separators (`;`, `&&`, `||`, `|`, `&`, newline). For each
 *      segment whose prefix-stripped head matches the install pattern
 *      (`(npm install|i|add) | (pnpm add|install|i) | (yarn add)`),
 *      extract the package-name tokens after the install command.
 *      Skip tokens that:
 *        - start with `-` (flags)
 *        - start with `./`, `/`, `../` (path installs)
 *        - contain shell metacharacters (`=`, `>`, `<`, `&`, `|`, `;`,
 *          `$`, backtick, quotes)
 *        - use workspace/link/file/git+ prefixes
 *      Strip trailing `@version` so `lodash@^4.0` → `lodash`.
 *   5. For each extracted package (capped at 5 per command — same
 *      cap as the bash hook), spawn `npm view <pkg> name` with a 5s
 *      timeout (when GNU `timeout` is available; falls back to a
 *      JS-side timeout otherwise). Failed lookups accumulate.
 *   6. If any failures, emit the same multi-line banner to stderr
 *      and exit 2. Otherwise exit 0.
 *
 * Key fidelity choices:
 *   - Segment-anchored: heredoc bodies / commit-message text that
 *     happens to contain `pnpm install` does NOT trigger; the bash
 *     hook's 0.15.0 fix is reproduced here via `splitSegments` +
 *     anchor-on-segment-head.
 *   - Env-prefix strip: `CI=1 pnpm add foo` → `pnpm add foo` for
 *     matching purposes. The segments helper strips leading
 *     `VAR=value` env-var assignments and shell prefixes (`sudo`,
 *     `exec`, `time`).
 *   - Network failure is a registry-not-found verdict, same as the
 *     bash hook's `npm view` exit≠0 → "package missing" — we don't
 *     distinguish ECONNREFUSED from "package not found", matching the
 *     bash hook's fail-closed posture.
 */

import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots } from '../../lib/worktree-roots.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import { splitSegments } from '../_lib/segments.js';

export interface DependencyAuditGateOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
  /**
   * Test seam — replaces the live `npm view` spawn. Returns `true`
   * when the package is verified to exist, `false` otherwise. The
   * production caller binds this to the real `npm view <pkg> name`
   * spawn with a 5s timeout.
   */
  verifyPackage?: (pkg: string) => Promise<boolean>;
}

export interface DependencyAuditGateResult {
  exitCode: number;
  stderr: string;
  /**
   * Test seam — packages this run attempted to verify, in order.
   * Useful for assertion-driven tests without grepping stderr.
   */
  checkedPackages: string[];
  failedPackages: string[];
}

/**
 * Cap on packages verified per command. Mirrors the bash hook's
 * `if [[ $CHECKED -gt 5 ]]; then break; fi`. Designed to keep the
 * hook latency bounded — `npm view` against a slow registry can
 * take seconds per call.
 */
const MAX_PACKAGES_PER_COMMAND = 5;

/**
 * Per-package `npm view` timeout. Mirrors the bash hook's
 * `timeout 5 npm view ...` (or fall-through to no-timeout when
 * `timeout` is unavailable). We always enforce in JS-space so the
 * Node port doesn't depend on a coreutils binary.
 */
const NPM_VIEW_TIMEOUT_MS = 5_000;

/**
 * Regex matching the install-command pattern at the head of a
 * prefix-stripped segment. Case-insensitive (bash `grep -qiE`).
 *
 * Note: segments.ts's `stripSegmentPrefix` already removes leading
 * `sudo`, `exec`, `time` and `VAR=value` env-vars, so we don't need
 * to repeat them here.
 */
const INSTALL_PATTERN = /^(npm\s+(install|i|add)|pnpm\s+(add|install|i)|yarn\s+add)\s+/i;

/**
 * Tokens that look like flags or paths — never npm registry packages.
 */
function looksLikeFlagOrPath(token: string): boolean {
  if (token.startsWith('-')) return true;
  if (token.startsWith('./')) return true;
  if (token.startsWith('/')) return true;
  if (token.startsWith('../')) return true;
  return false;
}

/**
 * Tokens that contain shell metacharacters — never valid npm package
 * names. The bash hook lists this set explicitly in a single conditional;
 * we mirror it character-for-character.
 */
function hasShellMeta(token: string): boolean {
  return (
    token.includes('=') ||
    token.includes('>') ||
    token.includes('<') ||
    token.includes('&') ||
    token.includes('|') ||
    token.includes(';') ||
    token.includes('$') ||
    token.includes('`') ||
    token.includes('"') ||
    token.includes("'")
  );
}

/**
 * Tokens that use a workspace / link / file / git+ protocol — never
 * resolvable via the npm registry.
 */
function isWorkspaceProtocol(token: string): boolean {
  return (
    token.startsWith('workspace:') ||
    token.startsWith('link:') ||
    token.startsWith('file:') ||
    token.startsWith('git+')
  );
}

/**
 * Strip a trailing `@version` from a package spec.
 *
 *   lodash         → lodash
 *   lodash@4.17.21 → lodash
 *   @scope/pkg     → @scope/pkg (leading-@ preserved)
 *   @scope/pkg@1   → @scope/pkg
 *
 * Mirrors the bash hook's `sed -E 's/@[^@/]+$//'`. The pattern strips
 * a trailing `@<chars-without-/-or-@>` only — leading-scope `@` is
 * untouched because it has either a `/` or another `@` to the right.
 */
function stripVersion(token: string): string {
  const stripped = token.replace(/@[^@/]+$/, '');
  return stripped.length === 0 ? token : stripped;
}

/**
 * Extract package-name tokens from a single segment that has already
 * been matched against the install pattern. The bash hook's logic is
 * reproduced verbatim.
 */
function extractFromSegmentHead(head: string): string[] {
  // After the install pattern, the remainder is the argv-style token
  // list (still as a string). Whitespace-separated tokens, no shell
  // parsing required at this point because segments are already
  // unquoted by `splitSegments`.
  const afterCmd = head.replace(INSTALL_PATTERN, '');
  const tokens = afterCmd.split(/\s+/).filter((t) => t.length > 0);
  const out: string[] = [];
  for (const token of tokens) {
    if (looksLikeFlagOrPath(token)) continue;
    if (hasShellMeta(token)) continue;
    if (isWorkspaceProtocol(token)) continue;
    out.push(stripVersion(token));
  }
  return out;
}

/**
 * Walk every segment of the command. For each segment whose stripped
 * head matches the install pattern, contribute its package tokens.
 */
export function extractPackages(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of splitSegments(cmd)) {
    if (!INSTALL_PATTERN.test(seg.head)) continue;
    out.push(...extractFromSegmentHead(seg.head));
  }
  return out;
}

/**
 * Real verifier — spawns `npm view <pkg> name`. Resolves `true` when
 * the registry confirms the package exists; `false` on timeout,
 * non-zero exit, or spawn failure. The bash hook treats all three
 * the same (`npm view` exit ≠ 0 → fail).
 */
export function verifyPackageReal(pkg: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (ok: boolean): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn('npm', ['view', pkg, 'name'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* best effort */
      }
      settle(false);
    }, NPM_VIEW_TIMEOUT_MS);
    timer.unref?.();
    child.on('exit', (code) => {
      settle(code === 0);
    });
    child.on('error', () => {
      settle(false);
    });
  });
}

function buildFailureBanner(failed: string[]): string {
  const lines = [
    'DEPENDENCY AUDIT: Package not found on npm registry\n',
    '\n',
    '  The following packages could not be verified:\n',
  ];
  for (const pkg of failed) {
    lines.push(`  - ${pkg}\n`);
  }
  lines.push('\n');
  lines.push('  Rule: All packages must exist on the npm registry before installation.\n');
  lines.push('  Check: Is the package name spelled correctly? Does it exist on npmjs.com?\n');
  return lines.join('');
}

export async function runDependencyAuditGate(
  options: DependencyAuditGateOptions = {},
): Promise<DependencyAuditGateResult> {
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };
  const checkedPackages: string[] = [];
  const failedPackages: string[] = [];

  // 2. Stdin.
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
        `dependency-audit-gate: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr, checkedPackages, failedPackages };
    }
    throw err;
  }

  // Roots + HALT (0.54.0 worktree state): the payload's `cwd` feeds the
  // resolution ladder, so stdin is parsed FIRST — a deliberate reorder.
  // Policy/path checks key off the LOCAL (worktree) root; audit and the
  // kill switch key off the COMMON (repository) root.
  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(payloadCwd, options.reaRoot);
  // 1. HALT.
  const halt = checkHaltRoots(reaRoot, commonRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, checkedPackages, failedPackages };
  }

  if (toolName !== '' && toolName !== 'Bash') {
    return { exitCode: 0, stderr, checkedPackages, failedPackages };
  }
  if (cmd.length === 0) {
    return { exitCode: 0, stderr, checkedPackages, failedPackages };
  }

  const packages = extractPackages(cmd);
  if (packages.length === 0) {
    return { exitCode: 0, stderr, checkedPackages, failedPackages };
  }

  const verify = options.verifyPackage ?? verifyPackageReal;
  for (const pkg of packages) {
    if (checkedPackages.length >= MAX_PACKAGES_PER_COMMAND) break;
    if (pkg.length === 0) continue;
    checkedPackages.push(pkg);
    const ok = await verify(pkg);
    if (!ok) failedPackages.push(pkg);
  }

  if (failedPackages.length > 0) {
    writeStderr(buildFailureBanner(failedPackages));
    return { exitCode: 2, stderr, checkedPackages, failedPackages };
  }

  return { exitCode: 0, stderr, checkedPackages, failedPackages };
}

/**
 * CLI entry — `rea hook dependency-audit-gate`.
 */
export async function runHookDependencyAuditGate(
  options: DependencyAuditGateOptions = {},
): Promise<void> {
  const result = await runDependencyAuditGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}

export const __INTERNAL_INSTALL_PATTERN_FOR_TESTS = INSTALL_PATTERN;
export const __INTERNAL_MAX_PACKAGES_FOR_TESTS = MAX_PACKAGES_PER_COMMAND;
