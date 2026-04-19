/**
 * G6 — Pre-push hook fallback installer.
 *
 * Ships alongside `commit-msg.ts` as a second-line defender for the
 * protected-path Codex audit gate. The primary path is `.husky/pre-push`,
 * which rea copies into the consumer's `.husky/` via the canonical copy
 * module. That file only runs when the consumer has husky active
 * (`core.hooksPath` points at `.husky/`). Consumers who have never run
 * `husky install`, or who have disabled husky entirely, would otherwise get
 * ZERO pre-push enforcement — and the protected-path gate is exactly the
 * thing we cannot let silently lapse.
 *
 * The fallback writes a small shell script that `exec`s the same
 * `push-review-gate.sh` logic the Claude Code hook already runs. The gate
 * itself is shared — we do NOT duplicate its 700 lines.
 *
 * ## Install policy (decision tree, documented)
 *
 * Given a consumer repo, we must decide where (if anywhere) to install a
 * fallback `pre-push`:
 *
 *   1. `core.hooksPath` unset (vanilla git):
 *      → Install `.git/hooks/pre-push`. This is the only path git will fire.
 *        `.husky/pre-push` sits on disk as a source-of-truth copy but is not
 *        consulted by git directly.
 *
 *   2. `core.hooksPath` set to a directory containing an EXECUTABLE,
 *      governance-carrying `pre-push`:
 *      → Do NOT install. A hook is "governance-carrying" when it either
 *        carries our `FALLBACK_MARKER` (rea-managed) or execs / invokes
 *        `.claude/hooks/push-review-gate.sh` (consumer-wired delegation).
 *        This is the happy path for any project running husky 9+ that has
 *        wired the gate.
 *
 *   3. `core.hooksPath` set to a directory with a pre-push that is NOT
 *      governance-carrying (wrong bits, unrelated script, lint-only husky
 *      hook, directory, etc.):
 *      → Classify as foreign. Leave it alone, warn the user, and let
 *        `rea doctor` downgrade the check to `warn` so the gap is visible.
 *
 *   4. `core.hooksPath` set to a directory WITHOUT a pre-push:
 *      → Install into the configured hooksPath (as `pre-push`). This is the
 *        "hooksPath is set but nothing lives there yet" case. The active
 *        hook directory has changed; we install where git will actually look.
 *
 * Idempotency: every install writes a stable managed header
 * (`# rea:pre-push-fallback v1`). Re-running `rea init` detects the header
 * by ANCHORED match (exact second line after the shebang) and refreshes in
 * place; it NEVER overwrites a hook without our marker — if the consumer
 * has their own pre-push already, we warn and skip. Substring matches are
 * deliberately rejected: a consumer comment, a grep log, or copy-pasted
 * snippet containing the sentinel must not reclassify a foreign file as
 * rea-managed.
 *
 * ## Why not just rely on `.husky/pre-push`?
 *
 * Three concrete failure modes we saw during 0.2.x dogfooding:
 *   - Consumer hasn't run `husky install` (fresh clone, pnpm hasn't run
 *     postinstall yet, etc.). `.husky/pre-push` exists but git's hooksPath
 *     still points at `.git/hooks/`. No enforcement.
 *   - Consumer deliberately uses `core.hooksPath=./custom-hooks` with a
 *     different tool. `.husky/pre-push` is dead weight.
 *   - CI or release automation disables husky via `HUSKY=0`. Again, no
 *     enforcement at push time.
 *
 * The protected-path Codex audit requirement is too important to let any
 * of those slip through silently. See THREAT_MODEL.md §Governance for the
 * full rationale.
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

/**
 * Marker baked into every rea-installed fallback pre-push hook. Used for
 * idempotency: on re-run we refresh files carrying the marker and refuse
 * to touch anything that doesn't.
 *
 * Bump the version suffix whenever the embedded script semantics change so
 * upgrades can migrate old installs. Comparison is NOT a substring match —
 * see `isReaManagedFallback` for the anchored form required to classify
 * a file as rea-managed.
 */
export const FALLBACK_MARKER = '# rea:pre-push-fallback v1';

/**
 * Fixed two-line prelude every rea-managed fallback hook opens with. Used
 * to distinguish a real rea install from a file that merely happens to
 * contain the marker substring (consumer comment, grep log, copy-pasted
 * snippet, etc.). The equality check is exact-bytes, anchored at offset 0.
 */
const FALLBACK_PRELUDE = `#!/bin/sh\n${FALLBACK_MARKER}\n`;

/**
 * Any reference to this token in a pre-push hook's body counts as a
 * consumer-wired delegation to the shared review gate. Used to distinguish
 * a legitimate custom pre-push that still honors rea governance from a
 * lint-only husky hook that would silently bypass it.
 */
const GATE_DELEGATION_TOKEN = '.claude/hooks/push-review-gate.sh';

/**
 * True when `content` starts with the exact rea fallback prelude. The
 * marker must appear as the second line, immediately after the shebang,
 * with no leading whitespace, no alternate shebang (`#!/usr/bin/env sh`),
 * and no interposed blank lines. Anything else is foreign.
 *
 * Rejecting a substring match is what stops a consumer comment like
 * `# Hint: the old rea:pre-push-fallback v1 marker moved into .husky/` from
 * accidentally classifying a user's own hook as rea-managed and then
 * getting overwritten on the next `rea init`.
 */
export function isReaManagedFallback(content: string): boolean {
  return content.startsWith(FALLBACK_PRELUDE);
}

/**
 * True when `content` contains a reference to `push-review-gate.sh`. Used
 * as a softer signal that a consumer-owned pre-push still wires the shared
 * gate (e.g. a husky 9 file that runs lint AND execs the gate). Combined
 * with "exists AND executable", a gate-referencing foreign hook is a
 * legitimate integration point — doctor reports `pass`, install skips.
 *
 * A file that does NOT reference the gate and is NOT rea-managed is
 * classified as foreign even if it exists and is executable: the governance
 * requirement is not satisfied and we need the user to see the warning.
 */
export function referencesReviewGate(content: string): boolean {
  return content.includes(GATE_DELEGATION_TOKEN);
}

/**
 * Classification of an on-disk pre-push file relative to rea governance.
 * Mirrors the decision tree in the module header.
 */
type HookClassification =
  | { kind: 'rea-managed' }
  | { kind: 'gate-delegating' }
  | { kind: 'foreign'; reason: 'no-marker' | 'unreadable' | 'not-a-file' };

/**
 * Read `hookPath` and classify. Does not consult file mode — callers are
 * expected to combine this with an executable-bit check where relevant.
 * A directory, symlink-to-directory, ENOENT, or unreadable file is "foreign"
 * so that we never silently clobber anything we cannot inspect.
 */
async function classifyExistingHook(
  hookPath: string,
): Promise<HookClassification> {
  let stat: fs.Stats;
  try {
    stat = await fsPromises.stat(hookPath);
  } catch {
    return { kind: 'foreign', reason: 'not-a-file' };
  }
  if (!stat.isFile()) {
    return { kind: 'foreign', reason: 'not-a-file' };
  }
  let content: string;
  try {
    content = await fsPromises.readFile(hookPath, 'utf8');
  } catch {
    return { kind: 'foreign', reason: 'unreadable' };
  }
  if (isReaManagedFallback(content)) return { kind: 'rea-managed' };
  if (referencesReviewGate(content)) return { kind: 'gate-delegating' };
  return { kind: 'foreign', reason: 'no-marker' };
}

/**
 * Content of the fallback hook. Intentionally minimal: delegates all real
 * work to `.claude/hooks/push-review-gate.sh`, which is the shared gate
 * already covered by tests. The only logic here is the "which gate to
 * call" resolution.
 *
 * The stdin contract of git's native pre-push (one line per refspec) is
 * passed through to the gate verbatim. The gate already knows how to parse
 * that shape — see `parse_prepush_stdin` in `push-review-gate.sh`.
 *
 * IMPORTANT: The first two lines are fixed and must remain byte-identical
 * to `FALLBACK_PRELUDE`. `isReaManagedFallback` anchors on them.
 */
function fallbackHookContent(): string {
  return `#!/bin/sh
${FALLBACK_MARKER}
#
# Fallback pre-push hook installed by \`rea init\` when Husky is not the
# active git hook path. Do NOT edit by hand: re-run \`rea init\` to refresh.
#
# This file delegates to .claude/hooks/push-review-gate.sh so there is
# exactly one implementation of the push-review logic across rea, Husky,
# and vanilla git installs. Removing this file disables the protected-path
# Codex gate for terminal-initiated pushes; prefer switching to Husky
# instead.

set -eu

REA_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
GATE="\${REA_ROOT}/${GATE_DELEGATION_TOKEN}"

if [ ! -x "\$GATE" ]; then
  printf 'rea: push-review-gate missing or not executable at %s\\n' "\$GATE" >&2
  printf '  Run \`rea init\` to reinstall, or \`pnpm build\` if rea was built from source.\\n' >&2
  exit 1
fi

exec "\$GATE" "\$@"
`;
}

/**
 * Read `core.hooksPath` via `git config --get`. Mirrors the helper in
 * `commit-msg.ts` — we consult git, never regex-match `.git/config` —
 * so section-scoped keys (`[worktree]`, `[alias]`, includes) resolve the
 * same way git itself resolves them.
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

/**
 * Resolve a configured `core.hooksPath` (possibly relative) to an absolute
 * path relative to `targetDir`, or `null` if the key is unset.
 */
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

export type InstallDecision =
  /** Active pre-push already present and governance-carrying. */
  | { action: 'skip'; reason: 'active-pre-push-present'; hookPath: string }
  /** Consumer owns a non-rea pre-push; refusing to stomp it. */
  | { action: 'skip'; reason: 'foreign-pre-push'; hookPath: string }
  /** Write a fresh hook. */
  | { action: 'install'; hookPath: string }
  /** Refresh an existing rea-managed hook (marker match). */
  | { action: 'refresh'; hookPath: string };

/**
 * Resolve the hook path we would target given the current git config and
 * on-disk state. Split out so `installPrePushFallback` can re-resolve it
 * immediately before the write to close the classify → write TOCTOU window.
 */
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
  return {
    hookPath: path.join(targetDir, '.git', 'hooks', 'pre-push'),
    hooksPathConfigured: false,
  };
}

/**
 * Classify what we should do at `targetDir` based on current state. Pure —
 * reads the filesystem and git config but performs no writes. Split out so
 * tests can drive every branch without going through the write path.
 *
 * NOTE: The result is a snapshot. `installPrePushFallback` re-resolves and
 * re-classifies immediately before writing to defend against a husky
 * install or concurrent `rea init` running between classify and write.
 */
export async function classifyPrePushInstall(
  targetDir: string,
): Promise<InstallDecision> {
  const { hookPath, hooksPathConfigured } = await resolveTargetHookPath(targetDir);

  // Fast path: no file at the target → always an install. Executable-bit
  // and content classification only apply when something already lives
  // there.
  if (!fs.existsSync(hookPath)) {
    return { action: 'install', hookPath };
  }

  // A file exists at the target. Classify before deciding.
  const classification = await classifyExistingHook(hookPath);
  if (classification.kind === 'rea-managed') {
    return { action: 'refresh', hookPath };
  }

  // Non-rea file present. Whether we call it "active governance hook" or
  // "foreign" depends on whether it (a) looks like a real executable git
  // hook AND (b) actually references the shared review gate. Mere existence
  // of SOMETHING at the path does NOT satisfy governance — that was the
  // 0.2.x hole where a lint-only husky hook silently bypassed the Codex
  // audit gate.
  let executable = false;
  try {
    const stat = await fsPromises.stat(hookPath);
    executable = stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    executable = false;
  }

  if (
    hooksPathConfigured &&
    executable &&
    classification.kind === 'gate-delegating'
  ) {
    // Consumer-owned executable hook that wires the gate. Happy path for
    // husky projects that added their own linting before the gate exec.
    return {
      action: 'skip',
      reason: 'active-pre-push-present',
      hookPath,
    };
  }

  // Everything else is foreign — warn, leave alone, let doctor surface it.
  return {
    action: 'skip',
    reason: 'foreign-pre-push',
    hookPath,
  };
}

export interface PrePushInstallResult {
  decision: InstallDecision;
  /** Absolute path of the file written, if any. */
  written?: string;
  /** User-facing warnings accumulated during install. */
  warnings: string[];
}

/**
 * Remove any stale `.rea-tmp-*` siblings left over from a crashed previous
 * install. Best-effort; non-fatal if scanning fails. Siblings are scoped to
 * the same directory as `dst` so we only touch files we would have created.
 *
 * A previous implementation used a deterministic PID-based suffix which
 * could (a) collide across concurrent installs in the same process, and
 * (b) leave a predictable 0o755 sibling on crash. Random suffixes plus
 * proactive cleanup closes both windows.
 */
async function cleanupStaleTempFiles(dst: string): Promise<void> {
  const dir = path.dirname(dst);
  const prefix = `${path.basename(dst)}.rea-tmp-`;
  let entries: string[];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return; // dir doesn't exist yet — nothing to clean.
  }
  await Promise.all(
    entries
      .filter((e) => e.startsWith(prefix))
      .map((e) =>
        fsPromises.unlink(path.join(dir, e)).catch(() => undefined),
      ),
  );
}

/**
 * Atomically write `content` to `dst` with executable bits set. Uses
 * `O_EXCL` on the temp file so a race against another installer (or a
 * stale sibling we missed) fails fast instead of silently overwriting.
 */
async function writeExecutable(dst: string, content: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(dst), { recursive: true });
  // Random suffix + `wx` open flag: PID was observed to collide during
  // concurrent installs in the same process (e.g. two worktrees running
  // `rea init` back-to-back, or a test harness driving the function in
  // parallel). UUIDs are collision-free for our purposes and `wx` fails
  // loudly if anything we didn't expect is in the way.
  const tmp = `${dst}.rea-tmp-${crypto.randomUUID()}`;
  // `open` with `'wx'` == O_WRONLY|O_CREAT|O_EXCL. Mode bits on the open
  // call itself so the file is executable the moment it appears on disk.
  const handle = await fsPromises.open(tmp, 'wx', 0o755);
  try {
    await handle.writeFile(content, 'utf8');
    // Some platforms ignore the open-time mode argument; force the bits
    // again before rename for belt-and-suspenders.
    await handle.chmod(0o755);
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await fsPromises.rename(tmp, dst);
  } catch (err) {
    await fsPromises.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Options controlling `installPrePushFallback`. Exposed primarily for
 * tests — production callers get sensible defaults.
 */
export interface InstallPrePushOptions {
  /**
   * Serialize concurrent installs via an advisory lockfile under `.git/`.
   * Defaults to `true`. Tests that simulate concurrent races must keep
   * this on; the only reason to turn it off is unit-testing a specific
   * write branch in isolation.
   */
  useLock?: boolean;
  /**
   * Called exactly once inside the advisory lock, after classification
   * and before re-resolution + write. Test-only seam that lets a race
   * partner drop a file in between those two steps so we can assert on
   * the re-check behavior. Invoked with the classified target path.
   * Production callers never set this.
   */
  onBeforeReresolve?: (hookPath: string) => Promise<void> | void;
}

/**
 * Acquire a short-lived advisory lock under `.git/` so two concurrent
 * `rea init` runs do not race on the same pre-push hook. The `.git/`
 * directory is guaranteed to exist before we reach this (we check up
 * front) and is the only reliably-writable location that a consumer won't
 * be surprised to find a `.lock` in.
 *
 * proper-lockfile is already a runtime dep (audit chain uses it). Stale
 * timeout is deliberately short — install is a few hundred milliseconds
 * in the worst case, and a crashed run should not block the next one for
 * long.
 */
async function withInstallLock<T>(
  targetDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockTarget = path.join(targetDir, '.git');
  const release = await properLockfile.lock(lockTarget, {
    stale: 10_000,
    retries: {
      retries: 20,
      factor: 1.3,
      minTimeout: 15,
      maxTimeout: 200,
      randomize: true,
    },
    realpath: false,
    lockfilePath: path.join(lockTarget, 'rea-pre-push-install.lock'),
  });
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // Release can legitimately fail if stale-detection already freed
      // the lockfile. Work completed; swallow.
    }
  }
}

/**
 * Install (or refresh, or skip) the fallback pre-push hook at `targetDir`.
 * Idempotent: safe to call on every `rea init`, including re-runs over an
 * existing install. Never overwrites a foreign hook.
 *
 * Requires `targetDir/.git` to exist. Non-git directories are skipped with
 * a warning — same shape as `installCommitMsgHook`.
 */
export async function installPrePushFallback(
  targetDir: string,
  options: InstallPrePushOptions = {},
): Promise<PrePushInstallResult> {
  const result: PrePushInstallResult = {
    decision: { action: 'install', hookPath: '' },
    warnings: [],
  };

  const gitDir = path.join(targetDir, '.git');
  if (!fs.existsSync(gitDir)) {
    result.warnings.push(
      '.git/ not found — skipping pre-push fallback (not a git repo?)',
    );
    // Return a synthetic skip decision so callers can log uniformly.
    result.decision = {
      action: 'skip',
      reason: 'foreign-pre-push',
      hookPath: path.join(targetDir, '.git', 'hooks', 'pre-push'),
    };
    return result;
  }

  const useLock = options.useLock !== false;
  const run = async (): Promise<PrePushInstallResult> => {
    // Classify once for the caller-visible decision. We re-resolve
    // immediately before the write to close the TOCTOU window.
    const decision = await classifyPrePushInstall(targetDir);
    result.decision = decision;

    // Clean up stale temp files from any crashed previous install. Runs
    // on every entry, not only the write branches, so a doctor-mode run
    // or a re-entrance after a crash consistently leaves the dir tidy.
    await cleanupStaleTempFiles(decision.hookPath);

    switch (decision.action) {
      case 'install':
      case 'refresh': {
        if (options.onBeforeReresolve !== undefined) {
          await options.onBeforeReresolve(decision.hookPath);
        }

        // Re-resolve hooksPath and re-inspect the destination just before
        // the rename. Between the classification above and this point,
        // `husky install` could have flipped `core.hooksPath`, or a second
        // `rea init` could have landed a file. Bail out safely if anything
        // unexpected appeared; the user can re-run to converge.
        const resolved = await resolveTargetHookPath(targetDir);
        if (resolved.hookPath !== decision.hookPath) {
          result.warnings.push(
            `core.hooksPath changed during install — expected ${decision.hookPath}, ` +
              `now ${resolved.hookPath}. Re-run \`rea init\` to install into the current location.`,
          );
          result.decision = {
            action: 'skip',
            reason: 'foreign-pre-push',
            hookPath: resolved.hookPath,
          };
          return result;
        }

        // Re-classify the destination. For `install` the fast rule is
        // "file must still be absent". For `refresh` the rule is "still
        // rea-managed"; a file that got replaced by a consumer between
        // classify and write must not be clobbered.
        const reCheck = await classifyExistingHook(decision.hookPath);
        if (decision.action === 'install') {
          if (reCheck.kind !== 'foreign' || reCheck.reason !== 'not-a-file') {
            // Something appeared. Do NOT stomp.
            result.warnings.push(
              `pre-push hook at ${decision.hookPath} appeared during install — ` +
                `leaving it untouched. Re-run \`rea init\` to re-evaluate.`,
            );
            result.decision = {
              action: 'skip',
              reason: 'foreign-pre-push',
              hookPath: decision.hookPath,
            };
            return result;
          }
        } else {
          // refresh
          if (reCheck.kind !== 'rea-managed') {
            result.warnings.push(
              `pre-push hook at ${decision.hookPath} is no longer rea-managed — ` +
                `leaving it untouched.`,
            );
            result.decision = {
              action: 'skip',
              reason: 'foreign-pre-push',
              hookPath: decision.hookPath,
            };
            return result;
          }
        }

        await writeExecutable(decision.hookPath, fallbackHookContent());
        result.written = decision.hookPath;
        if (decision.action === 'refresh') {
          // Informational — refreshing our own marker is the idempotent
          // path, not a warning condition.
          warn(`refreshed rea-managed pre-push at ${decision.hookPath}`);
        }
        return result;
      }
      case 'skip': {
        if (decision.reason === 'foreign-pre-push') {
          result.warnings.push(
            `pre-push hook at ${decision.hookPath} is not rea-managed — ` +
              `leaving it untouched. Add \`exec ${GATE_DELEGATION_TOKEN} "$@"\` ` +
              `to it manually to wire the Codex audit gate.`,
          );
        }
        // 'active-pre-push-present' is the happy husky path — no warning.
        return result;
      }
    }
  };

  if (!useLock) return run();
  return withInstallLock(targetDir, run);
}

/**
 * Doctor check: at least one pre-push hook (Husky OR git fallback OR the
 * configured hooksPath location) must exist AND be executable AND carry
 * governance (rea marker or gate delegation). Returns a small record the
 * doctor module can turn into a CheckResult.
 *
 * "Executable" is defined as having any of the user/group/other exec bits
 * set, matching the existing `checkHooksInstalled` convention. A file that
 * is executable but does not wire the Codex review gate is intentionally
 * classified as non-governing: `ok=false` + `activeForeign=true`, which
 * doctor turns into a `warn`, not a `pass`.
 */
export interface PrePushDoctorState {
  /** Every candidate path we consulted, with its live status on disk. */
  candidates: Array<{
    path: string;
    exists: boolean;
    executable: boolean;
    /** `true` when the file content carries our anchored rea prelude. */
    reaManaged: boolean;
    /** `true` when the body references the shared review gate. */
    delegatesToGate: boolean;
  }>;
  /**
   * The candidate path git would actually fire right now, given current
   * `core.hooksPath`. May or may not exist.
   */
  activePath: string;
  /**
   * True when the active candidate exists, is executable, AND carries
   * governance (rea marker OR references the review gate).
   */
  ok: boolean;
  /**
   * True when the active candidate exists + is executable but does NOT
   * carry governance. This is the "silent bypass" case doctor surfaces as
   * a warn. Distinct from `ok=false + absent` (which is a hard fail).
   */
  activeForeign: boolean;
}

export async function inspectPrePushState(
  targetDir: string,
): Promise<PrePushDoctorState> {
  const candidatePaths: string[] = [];
  const hooksInfo = await resolveHooksDir(targetDir);

  // Priority order matches install policy:
  //   1. Configured hooksPath (husky or custom)
  //   2. `.git/hooks/pre-push` (fallback target)
  //   3. `.husky/pre-push` (source-of-truth copy, may be inert if husky
  //      isn't wired up yet)
  if (hooksInfo.configured && hooksInfo.dir !== null) {
    candidatePaths.push(path.join(hooksInfo.dir, 'pre-push'));
  }
  candidatePaths.push(path.join(targetDir, '.git', 'hooks', 'pre-push'));
  candidatePaths.push(path.join(targetDir, '.husky', 'pre-push'));

  // De-duplicate while preserving order (hooksPath may already point at
  // `.husky/` on husky projects).
  const seen = new Set<string>();
  const uniq = candidatePaths.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  const candidates: PrePushDoctorState['candidates'] = [];
  for (const p of uniq) {
    let exists = false;
    let executable = false;
    let reaManaged = false;
    let delegatesToGate = false;
    try {
      const stat = await fsPromises.stat(p);
      exists = stat.isFile();
      if (exists) {
        executable = (stat.mode & 0o111) !== 0;
        try {
          const content = await fsPromises.readFile(p, 'utf8');
          reaManaged = isReaManagedFallback(content);
          delegatesToGate = referencesReviewGate(content);
        } catch {
          // unreadable — leave both false
        }
      }
    } catch {
      // ENOENT or other stat failure — leave defaults.
    }
    candidates.push({ path: p, exists, executable, reaManaged, delegatesToGate });
  }

  // A candidate only counts as "active" when git would actually fire it.
  // If core.hooksPath is set, only the candidate inside that directory is
  // active. Otherwise only `.git/hooks/pre-push` is active. `.husky/pre-push`
  // on its own, without hooksPath pointing at `.husky/`, never fires —
  // report it for context but do not let it satisfy `ok`.
  const activePath =
    hooksInfo.configured && hooksInfo.dir !== null
      ? path.join(hooksInfo.dir, 'pre-push')
      : path.join(targetDir, '.git', 'hooks', 'pre-push');
  const active = candidates.find((c) => c.path === activePath);
  const activeExistsExec =
    active !== undefined && active.exists && active.executable;
  const activeGoverns =
    active !== undefined && (active.reaManaged || active.delegatesToGate);
  const ok = activeExistsExec && activeGoverns;
  const activeForeign = activeExistsExec && !activeGoverns;

  return { candidates, activePath, ok, activeForeign };
}
