/**
 * Pre-push hook installer (0.11.0 stateless push-gate).
 *
 * The 0.11.0 push-gate is a single 15-line shell stub that delegates to
 * `rea hook push-gate` — no structural parsing of a bash body, no audit-log
 * grep, no cache lookup. This module writes that stub into the right
 * location and refuses to stomp foreign hooks.
 *
 * ## Install policy (decision tree)
 *
 * 1. `core.hooksPath` unset (vanilla git):
 *    → Install `.git/hooks/pre-push` (via `git rev-parse --git-path`). The
 *      `.husky/pre-push` file is shipped by `rea init` as a source-of-truth
 *      copy but is not consulted by git unless `core.hooksPath=.husky` is
 *      set.
 *
 * 2. `core.hooksPath=.husky` (typical Husky 9 install):
 *    → Do NOT install the `.git/hooks/pre-push` fallback. `.husky/pre-push`
 *      is already rea's canonical gate and lives under the canonical copy
 *      module (see `src/cli/install/copy.ts`). `rea upgrade` refreshes it
 *      there.
 *
 * 3. `core.hooksPath` set to anything else, and a foreign pre-push lives
 *    under it:
 *    → Leave it alone, warn the operator, let `rea doctor` flag the gap.
 *
 * 4. `core.hooksPath` set but the target directory has no pre-push:
 *    → Install the stub there — that's where git will look.
 *
 * Idempotency: every install writes a stable marker header. Re-running
 * `rea init` / `rea upgrade` refreshes files carrying the marker and
 * NEVER overwrites a hook without one. The marker comparison is
 * anchored at byte 0 (exact line after the shebang), not a substring
 * match — otherwise a comment or log output that happens to contain
 * the marker text could cause a foreign hook to be reclassified as
 * rea-managed and silently stomped.
 *
 * ## Stub body
 *
 * The body is 15 lines of POSIX sh:
 *
 *   - If `.rea/HALT` exists, print the reason and exit 1.
 *   - Otherwise `exec rea hook push-gate`, which runs `codex exec review`
 *     against the diff and exits 0/1/2 accordingly.
 *
 * All real work lives in `src/hooks/push-gate/index.ts`. Keeping the
 * shell body minimal means the only things that could regress are HALT
 * detection and the exec path — both trivially testable.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import properLockfile from 'proper-lockfile';
import { warn } from '../utils.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/**
 * Marker baked into every rea-installed fallback pre-push hook. Anchored on
 * the second line of the file (immediately after the shebang) for
 * classification. Bump the version suffix whenever the body semantics
 * change so upgrades can migrate old installs cleanly.
 *
 * v2 — 0.11.0 stateless push-gate body (no bash core, no audit grep).
 * v1 — 0.10.x and prior, delegated to `.claude/hooks/push-review-gate.sh`.
 */
export const FALLBACK_MARKER = '# rea:pre-push-fallback v2';

/** Legacy v1 marker — used by upgrade migration to detect old installs. */
export const LEGACY_FALLBACK_MARKER_V1 = '# rea:pre-push-fallback v1';

/**
 * Marker present in the shipped `.husky/pre-push` governance gate. The
 * second line of the shipped husky hook is this marker — rea upgrade
 * detects it to refresh in-place. Bump the suffix whenever the body
 * changes; pre-0.11 markers live in `LEGACY_HUSKY_GATE_MARKER_V1`.
 */
export const HUSKY_GATE_MARKER = '# rea:husky-pre-push-gate v2';

/** Legacy v1 husky marker for migration. */
export const LEGACY_HUSKY_GATE_MARKER_V1 = '# rea:husky-pre-push-gate v1';

/**
 * Body-level marker so a hook that carries the header marker but has an
 * empty body (stubbed out by a consumer) is NOT classified as rea-managed.
 * A real rea hook always carries both markers.
 */
export const HUSKY_GATE_BODY_MARKER = '# rea:gate-body-v2';

/** Legacy body marker — used by upgrade migration detection. */
export const LEGACY_HUSKY_GATE_BODY_MARKER_V1 = '# rea:gate-body-v1';

// ---------------------------------------------------------------------------
// Body templates
// ---------------------------------------------------------------------------

/**
 * The canonical 0.11.0 stub body, used for BOTH `.git/hooks/pre-push`
 * fallback AND `.husky/pre-push` (same code, same markers — the only
 * difference is the header marker on line 2 which identifies the install
 * shape for upgrade classification).
 *
 * Hand-maintained POSIX sh. Keep under 20 lines. Every statement must be
 * meaningful — ballast breaks the "shell body does only HALT + exec" story
 * that makes the gate trivially auditable.
 */
const BODY_TEMPLATE = `set -eu

# REA push-gate (0.11.0+). The heavy lifting — git diff resolution, Codex
# invocation, verdict inference, audit write — lives in
# \`src/hooks/push-gate/\` and is invoked via \`rea hook push-gate\`.
# This stub only short-circuits on the kill-switch and resolves the rea
# binary (in priority: project node_modules/.bin/rea → PATH → npx).
#
# The 0.10.x hooks assumed rea was on PATH. Consumers who bootstrap via
# \`npx @bookedsolid/rea init\` have no persistent global rea install, so
# the bare \`exec rea\` pattern fails with "rea: not found" on push. We
# resolve against the project-local node_modules/.bin first, then PATH,
# then fall back to npx so the gate runs in every documented setup.

REA_ROOT=\$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -f "\${REA_ROOT}/.rea/HALT" ]; then
  reason=\$(awk 'NR==1 { print; exit }' "\${REA_ROOT}/.rea/HALT" 2>/dev/null || printf 'unknown')
  [ -z "\${reason:-}" ] && reason='unknown'
  printf 'REA HALT: %s\\nAll push operations suspended. Run: rea unfreeze\\n' "\$reason" >&2
  exit 1
fi

# The pre-push stdin carries one line per refspec (local_ref local_sha
# remote_ref remote_sha). Forward stdin verbatim via process substitution
# — the \`rea hook push-gate\` CLI reads it via process.stdin to pick up
# the actual push base. Empty stdin (direct invocation, CI, etc.) is
# handled by the CLI falling back to upstream → origin/HEAD resolution.

REA_BIN=""
if [ -x "\${REA_ROOT}/node_modules/.bin/rea" ]; then
  REA_BIN="\${REA_ROOT}/node_modules/.bin/rea"
elif command -v rea >/dev/null 2>&1; then
  REA_BIN="rea"
elif command -v npx >/dev/null 2>&1; then
  # Last resort: npx will resolve the package from npm or the cache.
  # Pass \`--no-install\` so a rare cache-cold machine surfaces a clear
  # error instead of silently downloading at push time.
  REA_BIN="npx --no-install @bookedsolid/rea"
else
  printf 'rea: cannot locate the rea CLI. Install locally (\`pnpm add -D @bookedsolid/rea\`) or globally (\`npm i -g @bookedsolid/rea\`).\\n' >&2
  exit 2
fi

# \$@ carries the pre-push arguments (git passes <remote-name> <remote-url>).
# Stdin is inherited by \`exec\` → the CLI sees it unchanged.
exec \$REA_BIN hook push-gate "\$@"
`;

/** Fallback hook body — `.git/hooks/pre-push` in vanilla-git installs. */
export function fallbackHookContent(): string {
  return `#!/bin/sh
${FALLBACK_MARKER}
${HUSKY_GATE_BODY_MARKER}
#
# Fallback pre-push hook installed by \`rea init\` (vanilla git, no Husky).
# Do NOT edit by hand: re-run \`rea init\` or \`rea upgrade\` to refresh.
#
# Governance contract: HALT kill-switch check, then delegate to
# \`rea hook push-gate\`. The push-gate runs \`codex exec review --json\`
# against the diff and exits 0 (pass / empty-diff / disabled / skip),
# 1 (HALT — how we got here only when the file appeared mid-push),
# or 2 (blocked verdict, timeout, Codex error).

${BODY_TEMPLATE}`;
}

/** Husky hook body — `.husky/pre-push` when hooksPath=.husky. */
export function huskyHookContent(): string {
  return `#!/bin/sh
${HUSKY_GATE_MARKER}
${HUSKY_GATE_BODY_MARKER}
#
# Husky pre-push hook installed by \`rea init\` / \`rea upgrade\`. Do NOT
# edit by hand — the file is refreshed on every rea upgrade.
#
# Governance contract: HALT kill-switch check, then delegate to
# \`rea hook push-gate\`. See src/hooks/push-gate/index.ts.

${BODY_TEMPLATE}`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * True when `content` starts with the exact rea fallback prelude (shebang
 * + v2 marker). Strict: the marker must be on line 2, nothing interposed,
 * no leading whitespace. Substring matches are deliberately rejected.
 */
export function isReaManagedFallback(content: string): boolean {
  if (!content.startsWith('#!/bin/sh\n')) return false;
  const secondLineEnd = content.indexOf('\n', 10);
  if (secondLineEnd < 0) return false;
  const secondLine = content.slice(10, secondLineEnd);
  return secondLine === FALLBACK_MARKER;
}

/**
 * True when `content` is the legacy v1 fallback (`.git/hooks/pre-push`
 * that delegated to `.claude/hooks/push-review-gate.sh`). Used by `rea
 * upgrade` to migrate — we overwrite these unconditionally because we
 * control the entire body shape.
 */
export function isLegacyReaManagedFallback(content: string): boolean {
  if (!content.startsWith('#!/bin/sh\n')) return false;
  const secondLineEnd = content.indexOf('\n', 10);
  if (secondLineEnd < 0) return false;
  const secondLine = content.slice(10, secondLineEnd);
  return secondLine === LEGACY_FALLBACK_MARKER_V1;
}

/**
 * True when `content` carries the rea Husky gate markers in the canonical
 * positions — shebang on line 1, `HUSKY_GATE_MARKER` on line 2,
 * `HUSKY_GATE_BODY_MARKER` on line 3.
 *
 * Why three anchored lines instead of a substring search: the 0.10.x
 * implementation lived in ~2000 lines of structural parser because the old
 * body varied. The 0.11.0 body is hand-templated and stable — anchored
 * matching on three fixed lines closes the classification question with
 * six comparisons.
 */
export function isReaManagedHuskyGate(content: string): boolean {
  return hasHeaderMarkers(content, HUSKY_GATE_MARKER, HUSKY_GATE_BODY_MARKER);
}

/**
 * True when `content` is the legacy v1 Husky gate (`.husky/pre-push` from
 * 0.10.x and earlier). Used to trigger the upgrade migration.
 */
export function isLegacyReaManagedHuskyGate(content: string): boolean {
  return hasHeaderMarkers(
    content,
    LEGACY_HUSKY_GATE_MARKER_V1,
    LEGACY_HUSKY_GATE_BODY_MARKER_V1,
  );
}

function hasHeaderMarkers(content: string, header: string, body: string): boolean {
  if (!content.startsWith('#!/bin/sh\n')) return false;
  const lines = content.split('\n');
  // lines[0] = "#!/bin/sh"
  // lines[1] = header marker
  // lines[2] = body marker
  return lines[1] === header && lines[2] === body;
}

/**
 * True when `content` looks like a user-authored pre-push that still
 * invokes `rea hook push-gate` (a legitimate governance-carrying custom
 * hook). We don't attempt to parse control flow — the 0.10.x attempt at
 * that produced 800 lines of heuristics that still had gaps. Instead, we
 * match only on the substring `rea hook push-gate` preceded by one of
 * `exec`, `$(`, \``, `;`, or line-start whitespace. A comment containing
 * the phrase does NOT qualify (leading `#`).
 *
 * Governance-carrying is a soft signal: `rea doctor` uses it to print
 * "external (delegates to rea hook push-gate)" rather than "foreign".
 * `classifyPrePushInstall` maps it to "skip / active-pre-push-present"
 * — we don't overwrite consumer-authored hooks that respect the gate.
 */
export function referencesReviewGate(content: string): boolean {
  // Strip full-line comments before searching — the grep regex matches
  // whitespace-anchored phrases but not commented-out ones.
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    // Line starts with `#` (possibly leading whitespace)? comment — skip.
    if (/^\s*#/.test(rawLine)) continue;
    if (/(?:^|\s|;|`|\$\()\s*(?:exec\s+)?rea\s+hook\s+push-gate\b/.test(rawLine)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hook resolution
// ---------------------------------------------------------------------------

/**
 * Read `core.hooksPath` via `git config --get`. Returns `null` when unset.
 */
async function readHooksPathFromGit(targetDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', targetDir, 'config', '--get', 'core.hooksPath'],
      { encoding: 'utf8' },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function resolveHooksDir(
  targetDir: string,
): Promise<{ dir: string | null; configured: boolean }> {
  const configured = await readHooksPathFromGit(targetDir);
  if (configured === null) {
    return { dir: null, configured: false };
  }
  const absolute = path.isAbsolute(configured)
    ? configured
    : path.join(targetDir, configured);
  return { dir: absolute, configured: true };
}

/**
 * Resolve the absolute path git itself would fire for `hooks/<name>`. Works
 * across vanilla repos, linked worktrees (shared hooks dir), and submodules.
 */
async function resolveGitHookPath(
  targetDir: string,
  hookName: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', targetDir, 'rev-parse', '--git-path', `hooks/${hookName}`],
      { encoding: 'utf8' },
    );
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return null;
    return path.isAbsolute(trimmed) ? trimmed : path.join(targetDir, trimmed);
  } catch {
    return null;
  }
}

async function resolveTargetHookPath(targetDir: string): Promise<{
  hookPath: string;
  hooksPathConfigured: boolean;
}> {
  const hooksInfo = await resolveHooksDir(targetDir);
  if (hooksInfo.configured && hooksInfo.dir !== null) {
    return {
      hookPath: path.join(hooksInfo.dir, 'pre-push'),
      hooksPathConfigured: true,
    };
  }
  const gitHookPath = await resolveGitHookPath(targetDir, 'pre-push');
  if (gitHookPath !== null) {
    return { hookPath: gitHookPath, hooksPathConfigured: false };
  }
  return {
    hookPath: path.join(targetDir, '.git', 'hooks', 'pre-push'),
    hooksPathConfigured: false,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ClassifyExistingHook =
  | { kind: 'absent' }
  | { kind: 'rea-managed' }
  | { kind: 'rea-managed-legacy-v1' }
  | { kind: 'rea-managed-husky' }
  | { kind: 'rea-managed-husky-legacy-v1' }
  | { kind: 'gate-delegating' }
  | { kind: 'foreign'; reason: string };

export async function classifyExistingHook(
  hookPath: string,
): Promise<ClassifyExistingHook> {
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(hookPath);
  } catch {
    return { kind: 'absent' };
  }
  if (stat.isDirectory()) return { kind: 'foreign', reason: 'is-directory' };
  if (stat.isSymbolicLink()) return { kind: 'foreign', reason: 'is-symlink' };
  if (!stat.isFile()) return { kind: 'foreign', reason: 'not-regular-file' };

  let content: string;
  try {
    content = await fsPromises.readFile(hookPath, 'utf8');
  } catch (e) {
    return {
      kind: 'foreign',
      reason: `read-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (isReaManagedHuskyGate(content)) return { kind: 'rea-managed-husky' };
  if (isLegacyReaManagedHuskyGate(content)) return { kind: 'rea-managed-husky-legacy-v1' };
  if (isReaManagedFallback(content)) return { kind: 'rea-managed' };
  if (isLegacyReaManagedFallback(content)) return { kind: 'rea-managed-legacy-v1' };
  if (referencesReviewGate(content)) return { kind: 'gate-delegating' };
  return { kind: 'foreign', reason: 'no-marker' };
}

// ---------------------------------------------------------------------------
// Decision + install
// ---------------------------------------------------------------------------

export type InstallDecision =
  | { action: 'skip'; reason: 'active-pre-push-present'; hookPath: string }
  | { action: 'skip'; reason: 'foreign-pre-push'; hookPath: string }
  | { action: 'install'; hookPath: string }
  | { action: 'refresh'; hookPath: string };

export async function classifyPrePushInstall(
  targetDir: string,
): Promise<InstallDecision> {
  const { hookPath } = await resolveTargetHookPath(targetDir);
  const classification = await classifyExistingHook(hookPath);

  if (classification.kind === 'absent') {
    return { action: 'install', hookPath };
  }
  if (
    classification.kind === 'rea-managed' ||
    classification.kind === 'rea-managed-legacy-v1'
  ) {
    return { action: 'refresh', hookPath };
  }
  if (
    classification.kind === 'rea-managed-husky' ||
    classification.kind === 'rea-managed-husky-legacy-v1'
  ) {
    // Canonical husky gate — never touched by the fallback installer. The
    // canonical copy module refreshes it.
    return { action: 'skip', reason: 'active-pre-push-present', hookPath };
  }

  // Non-rea file exists. Executable + references the gate → governance-
  // carrying; skip with 'active-pre-push-present'. Else foreign.
  let executable = false;
  try {
    const stat = await fsPromises.stat(hookPath);
    executable = stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    executable = false;
  }
  if (executable && classification.kind === 'gate-delegating') {
    return { action: 'skip', reason: 'active-pre-push-present', hookPath };
  }
  return { action: 'skip', reason: 'foreign-pre-push', hookPath };
}

export interface PrePushInstallResult {
  decision: InstallDecision;
  written?: string;
  warnings: string[];
}

export interface InstallPrePushFallbackOptions {
  targetDir: string;
}

/**
 * Install (or refresh) the `.git/hooks/pre-push` stub when there is no
 * active governance-carrying hook. Never overwrites foreign hooks.
 *
 * Concurrency: a proper-lockfile-based advisory lock on the git common-dir
 * serializes concurrent installs (two `rea init` runs in the same repo).
 * Atomicity: fresh installs use `link(2)` (atomic create-or-fail); refresh
 * uses `rename(2)` with a dev+ino+mtime guard against mid-write
 * replacement.
 */
export async function installPrePushFallback(
  options: InstallPrePushFallbackOptions,
): Promise<PrePushInstallResult> {
  const warnings: string[] = [];
  const lockDir = await resolveLockDir(options.targetDir);
  await fsPromises.mkdir(lockDir, { recursive: true });
  const release = await properLockfile.lock(lockDir, {
    retries: { retries: 6, minTimeout: 100, maxTimeout: 500 },
    realpath: false,
  });
  try {
    // Re-classify AFTER acquiring the lock — another installer or husky
    // postinstall might have written a hook while we waited.
    const decision = await classifyPrePushInstall(options.targetDir);
    if (decision.action === 'skip') {
      if (decision.reason === 'foreign-pre-push') {
        warnings.push(
          `foreign pre-push at ${decision.hookPath} — leaving alone. Run \`rea doctor\` to see the governance gap.`,
        );
      }
      return { decision, warnings };
    }

    // Capture identity BEFORE writing, so the refresh path can detect a
    // concurrent modification between the lock-scoped re-classify and the
    // final rename.
    let guard: RefreshGuard = { kind: 'absent' };
    if (decision.action === 'refresh') {
      try {
        const st = await fsPromises.stat(decision.hookPath);
        guard = {
          kind: 'present',
          dev: st.dev,
          ino: st.ino,
          mtimeMs: st.mtimeMs,
          size: st.size,
        };
      } catch {
        // Vanished between classify and stat — downgrade to install.
        guard = { kind: 'absent' };
      }
    }

    await cleanupStaleTempFiles(decision.hookPath);
    await writeExecutable({
      dst: decision.hookPath,
      content: fallbackHookContent(),
      exclusive: decision.action === 'install',
      guard,
    });
    if (decision.action === 'refresh') {
      warn(`refreshed rea-managed pre-push at ${decision.hookPath}`);
    }
    return { decision, written: decision.hookPath, warnings };
  } finally {
    await release();
  }
}

async function resolveLockDir(targetDir: string): Promise<string> {
  // Lock at `${git-common-dir}/rea-prepush.lockdir` so concurrent installs
  // in the same repo (or across linked worktrees sharing the common dir)
  // serialize. Fall back to the target dir if git is unreachable.
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', targetDir, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8' },
    );
    const commonDir = stdout.trim();
    if (commonDir.length > 0) {
      const absolute = path.isAbsolute(commonDir)
        ? commonDir
        : path.join(targetDir, commonDir);
      return path.join(absolute, 'rea-prepush.lockdir');
    }
  } catch {
    // fall through
  }
  return path.join(targetDir, '.rea-prepush.lockdir');
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

type RefreshGuard =
  | { kind: 'absent' }
  | { kind: 'present'; dev: number; ino: number; mtimeMs: number; size: number };

class RefreshRaceError extends Error {
  code = 'REA_REFRESH_RACE' as const;
  constructor(dst: string) {
    super(
      `refresh aborted: ${dst} was modified by another writer between ` +
        `classify and rename. Re-run \`rea init\` to re-evaluate.`,
    );
    this.name = 'RefreshRaceError';
  }
}

async function cleanupStaleTempFiles(dst: string): Promise<void> {
  const dir = path.dirname(dst);
  const prefix = `${path.basename(dst)}.rea-tmp-`;
  let entries: string[];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return;
  }
  const candidates = entries.filter((e) => e.startsWith(prefix));
  await Promise.all(
    candidates.map(async (name) => {
      const abs = path.join(dir, name);
      try {
        const st = await fsPromises.lstat(abs);
        if (!st.isFile()) return;
      } catch {
        return;
      }
      let body: string;
      try {
        body = await fsPromises.readFile(abs, 'utf8');
      } catch {
        return;
      }
      if (!body.startsWith('#!/bin/sh')) return;
      if (
        !body.includes(FALLBACK_MARKER) &&
        !body.includes(HUSKY_GATE_MARKER) &&
        !body.includes(LEGACY_FALLBACK_MARKER_V1) &&
        !body.includes(LEGACY_HUSKY_GATE_MARKER_V1)
      ) {
        return;
      }
      await fsPromises.unlink(abs).catch(() => undefined);
    }),
  );
}

async function verifyRefreshGuard(dst: string, guard: RefreshGuard): Promise<void> {
  if (guard.kind === 'absent') return;
  let current: fs.Stats;
  try {
    current = await fsPromises.stat(dst);
  } catch {
    throw new RefreshRaceError(dst);
  }
  if (
    current.dev !== guard.dev ||
    current.ino !== guard.ino ||
    current.mtimeMs !== guard.mtimeMs ||
    current.size !== guard.size
  ) {
    throw new RefreshRaceError(dst);
  }
}

interface WriteExecutableOptions {
  dst: string;
  content: string;
  exclusive: boolean;
  guard: RefreshGuard;
}

async function writeExecutable(opts: WriteExecutableOptions): Promise<void> {
  const dir = path.dirname(opts.dst);
  await fsPromises.mkdir(dir, { recursive: true });
  const rand = crypto.randomBytes(8).toString('hex');
  const tmp = path.join(dir, `${path.basename(opts.dst)}.rea-tmp-${rand}`);
  await fsPromises.writeFile(tmp, opts.content, { encoding: 'utf8', mode: 0o755 });
  try {
    await fsPromises.chmod(tmp, 0o755);
  } catch {
    // chmod may fail on filesystems that don't honor mode (Windows, some
    // network shares) — writeFile already set mode, move on.
  }
  try {
    if (opts.exclusive) {
      // Atomic create-or-fail. EEXIST → a racing writer won; give up.
      await fsPromises.link(tmp, opts.dst);
      await fsPromises.unlink(tmp).catch(() => undefined);
      return;
    }
    // Refresh path: verify guard, then rename. Guard detection closes the
    // classify→rename window.
    await verifyRefreshGuard(opts.dst, opts.guard);
    await fsPromises.rename(tmp, opts.dst);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (opts.exclusive && (code === 'EXDEV' || code === 'EPERM' || code === 'ENOSYS')) {
      // Cross-device or unsupported link(2). Fall back to copyFile with
      // EXCL flag — strictly worse (observable empty/partial window) but
      // better than refusing the install on network mounts.
      await fsPromises.copyFile(tmp, opts.dst, fs.constants.COPYFILE_EXCL);
      await fsPromises.unlink(tmp).catch(() => undefined);
      return;
    }
    if (!opts.exclusive && code === 'EXDEV') {
      await verifyRefreshGuard(opts.dst, opts.guard);
      await fsPromises.copyFile(tmp, opts.dst);
      await fsPromises.unlink(tmp).catch(() => undefined);
      return;
    }
    await fsPromises.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Doctor seam
// ---------------------------------------------------------------------------

export interface PrePushCandidate {
  path: string;
  exists: boolean;
  executable: boolean;
  /** The marker classification of the file (if it exists). */
  kind?: ClassifyExistingHook['kind'];
  /** True when a rea-authored marker is present. */
  reaManaged?: boolean;
  /** True when the body contains `rea hook push-gate`. */
  delegatesToGate?: boolean;
}

export interface PrePushDoctorState {
  ok: boolean;
  activePath: string | null;
  /**
   * Foreign file detected at the active path — present + executable but
   * neither rea-managed nor gate-delegating. Treated as a hard fail
   * (silent-bypass risk).
   */
  activeForeign: boolean;
  candidates: PrePushCandidate[];
}

/**
 * Read-only probe used by `rea doctor`. Inspects every plausible hook
 * location and reports whether governance is active.
 */
export async function inspectPrePushState(
  targetDir: string,
): Promise<PrePushDoctorState> {
  const configured = await readHooksPathFromGit(targetDir);
  const activePathResult = await resolveTargetHookPath(targetDir);

  // Candidate list is the active path plus the "other" canonical locations
  // (`.husky/pre-push` and `.git/hooks/pre-push`). Deduplicate by absolute
  // path — worktree shared hooks means two candidates can resolve to the
  // same file.
  const candidatePaths = new Set<string>();
  candidatePaths.add(activePathResult.hookPath);
  candidatePaths.add(path.join(targetDir, '.husky', 'pre-push'));
  // `.git/hooks/pre-push` via git's actual resolution (worktree-safe).
  const gitHookPath = await resolveGitHookPath(targetDir, 'pre-push');
  if (gitHookPath !== null) candidatePaths.add(gitHookPath);

  const candidates: PrePushCandidate[] = [];
  for (const p of candidatePaths) {
    const cand: PrePushCandidate = {
      path: p,
      exists: false,
      executable: false,
    };
    try {
      const st = await fsPromises.stat(p);
      cand.exists = st.isFile();
      cand.executable = cand.exists && (st.mode & 0o111) !== 0;
    } catch {
      // absent
    }
    if (cand.exists) {
      const cls = await classifyExistingHook(p);
      cand.kind = cls.kind;
      cand.reaManaged =
        cls.kind === 'rea-managed' ||
        cls.kind === 'rea-managed-husky' ||
        cls.kind === 'rea-managed-legacy-v1' ||
        cls.kind === 'rea-managed-husky-legacy-v1';
      cand.delegatesToGate = cls.kind === 'gate-delegating';
    }
    candidates.push(cand);
  }

  const active = candidates.find((c) => c.path === activePathResult.hookPath);
  const activeIsGovernance =
    active !== undefined &&
    active.exists &&
    active.executable &&
    (active.reaManaged === true || active.delegatesToGate === true);
  const activeForeign =
    active !== undefined &&
    active.exists &&
    active.executable &&
    active.reaManaged !== true &&
    active.delegatesToGate !== true;

  // Silence `configured` unused warning — it's semantically relevant even if
  // we don't surface it in state today (doctor may consume later).
  void configured;

  return {
    ok: activeIsGovernance,
    activePath: activePathResult.hookPath,
    activeForeign,
    candidates,
  };
}
