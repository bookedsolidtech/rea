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
 *   2. `core.hooksPath` set to a directory containing an executable `pre-push`:
 *      → Do NOT install. The consumer's active pre-push is already in play;
 *        writing another copy under `.git/hooks/` would be dead weight that
 *        git ignores, and dropping one into the configured hooksPath would
 *        collide with a file the consumer/husky owns. This is the happy path
 *        for any project running husky 9+.
 *
 *   3. `core.hooksPath` set to a directory WITHOUT a pre-push:
 *      → Install into the configured hooksPath (as `pre-push`). This is the
 *        "hooksPath is set but nothing lives there yet" case. The active
 *        hook directory has changed; we install where git will actually look.
 *
 * Idempotency: every install writes a stable managed header
 * (`# rea:pre-push-fallback v1`). Re-running `rea init` detects the header
 * and refreshes in place; it NEVER overwrites a hook without our marker —
 * if the consumer has their own pre-push already, we warn and skip.
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
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { warn } from '../utils.js';

const execFileAsync = promisify(execFile);

/**
 * Marker baked into every rea-installed fallback pre-push hook. Used for
 * idempotency: on re-run we refresh files carrying the marker and refuse
 * to touch anything that doesn't.
 *
 * Bump the version suffix whenever the embedded script semantics change so
 * upgrades can migrate old installs. Comparison is exact-string, not regex.
 */
export const FALLBACK_MARKER = '# rea:pre-push-fallback v1';

/**
 * Content of the fallback hook. Intentionally minimal: delegates all real
 * work to `.claude/hooks/push-review-gate.sh`, which is the shared gate
 * already covered by tests. The only logic here is the "which gate to
 * call" resolution.
 *
 * The stdin contract of git's native pre-push (one line per refspec) is
 * passed through to the gate verbatim. The gate already knows how to parse
 * that shape — see `parse_prepush_stdin` in `push-review-gate.sh`.
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
GATE="\${REA_ROOT}/.claude/hooks/push-review-gate.sh"

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
  /** Active pre-push already present in the hooks directory. */
  | { action: 'skip'; reason: 'active-pre-push-present'; hookPath: string }
  /** Consumer owns a non-rea pre-push; refusing to stomp it. */
  | { action: 'skip'; reason: 'foreign-pre-push'; hookPath: string }
  /** Write a fresh hook. */
  | { action: 'install'; hookPath: string }
  /** Refresh an existing rea-managed hook (marker match). */
  | { action: 'refresh'; hookPath: string };

/**
 * Classify what we should do at `targetDir` based on current state. Pure —
 * reads the filesystem and git config but performs no writes. Split out so
 * tests can drive every branch without going through the write path.
 */
export async function classifyPrePushInstall(
  targetDir: string,
): Promise<InstallDecision> {
  const hooksInfo = await resolveHooksDir(targetDir);

  // Decide which directory we're targeting. Rules from the module header:
  //   - hooksPath unset → `.git/hooks/pre-push`
  //   - hooksPath set and has an existing pre-push → skip entirely
  //   - hooksPath set and no existing pre-push → install into hooksPath
  let targetHookPath: string;
  if (hooksInfo.configured && hooksInfo.dir !== null) {
    const candidate = path.join(hooksInfo.dir, 'pre-push');
    if (fs.existsSync(candidate)) {
      // hooksPath is set AND a pre-push is already there. Happy path for
      // husky-based repos: the canonical `.husky/pre-push` copy is live.
      // Do not install a second copy; do not touch `.git/hooks/`.
      return {
        action: 'skip',
        reason: 'active-pre-push-present',
        hookPath: candidate,
      };
    }
    targetHookPath = candidate;
  } else {
    targetHookPath = path.join(targetDir, '.git', 'hooks', 'pre-push');
  }

  if (!fs.existsSync(targetHookPath)) {
    return { action: 'install', hookPath: targetHookPath };
  }

  // A file exists at the target path. Distinguish rea-managed (carries our
  // marker) from foreign (consumer's own hook, do not stomp).
  try {
    const existing = await fsPromises.readFile(targetHookPath, 'utf8');
    if (existing.includes(FALLBACK_MARKER)) {
      return { action: 'refresh', hookPath: targetHookPath };
    }
    return {
      action: 'skip',
      reason: 'foreign-pre-push',
      hookPath: targetHookPath,
    };
  } catch {
    // Unreadable. Treat as foreign to err on the side of not destroying
    // what we cannot inspect.
    return {
      action: 'skip',
      reason: 'foreign-pre-push',
      hookPath: targetHookPath,
    };
  }
}

export interface PrePushInstallResult {
  decision: InstallDecision;
  /** Absolute path of the file written, if any. */
  written?: string;
  /** User-facing warnings accumulated during install. */
  warnings: string[];
}

async function writeExecutable(dst: string, content: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(dst), { recursive: true });
  // Write atomically via a temp file in the same directory so a crash can't
  // leave a partial hook on disk. Chmod happens on the temp file before
  // rename, so git sees an executable file the instant it appears.
  const tmp = `${dst}.rea-tmp-${process.pid}`;
  await fsPromises.writeFile(tmp, content, { encoding: 'utf8', mode: 0o755 });
  try {
    await fsPromises.chmod(tmp, 0o755);
    await fsPromises.rename(tmp, dst);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename failed.
    await fsPromises.unlink(tmp).catch(() => undefined);
    throw err;
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
): Promise<PrePushInstallResult> {
  const result: PrePushInstallResult = { decision: { action: 'install', hookPath: '' }, warnings: [] };

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

  const decision = await classifyPrePushInstall(targetDir);
  result.decision = decision;

  switch (decision.action) {
    case 'install':
    case 'refresh': {
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
            `leaving it untouched. Add \`exec .claude/hooks/push-review-gate.sh "$@"\` ` +
            `to it manually to wire the Codex audit gate.`,
        );
      }
      // 'active-pre-push-present' is the happy husky path — no warning.
      return result;
    }
  }
}

/**
 * Doctor check: at least one pre-push hook (Husky OR git fallback OR the
 * configured hooksPath location) must exist AND be executable. Returns a
 * small record the doctor module can turn into a CheckResult.
 *
 * "Executable" is defined as having any of the user/group/other exec bits
 * set, matching the existing `checkHooksInstalled` convention.
 */
export interface PrePushDoctorState {
  /** Every candidate path we consulted, with its live status on disk. */
  candidates: Array<{
    path: string;
    exists: boolean;
    executable: boolean;
    /** `true` when the file content carries our rea marker. */
    reaManaged: boolean;
  }>;
  /** At least one candidate exists and is executable. */
  ok: boolean;
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
    try {
      const stat = await fsPromises.stat(p);
      exists = stat.isFile();
      if (exists) {
        executable = (stat.mode & 0o111) !== 0;
        try {
          const content = await fsPromises.readFile(p, 'utf8');
          reaManaged = content.includes(FALLBACK_MARKER);
        } catch {
          // unreadable — leave reaManaged=false
        }
      }
    } catch {
      // ENOENT or other stat failure — leave defaults.
    }
    candidates.push({ path: p, exists, executable, reaManaged });
  }

  // A candidate only counts as "active" when git would actually fire it.
  // If core.hooksPath is set, only the candidate inside that directory is
  // active. Otherwise only `.git/hooks/pre-push` is active. `.husky/pre-push`
  // on its own, without hooksPath pointing at `.husky/`, never fires —
  // report it for context but do not let it satisfy `ok`.
  const activePath = hooksInfo.configured && hooksInfo.dir !== null
    ? path.join(hooksInfo.dir, 'pre-push')
    : path.join(targetDir, '.git', 'hooks', 'pre-push');
  const active = candidates.find((c) => c.path === activePath);
  const ok = active !== undefined && active.exists && active.executable;

  return { candidates, ok };
}
