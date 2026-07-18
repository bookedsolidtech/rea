/**
 * Pre-commit hook installer for the G1 spec-gate (Artifact Gates, 0.54.0+).
 *
 * The pre-commit hook invokes `rea gate spec-check`, which is a DEFAULT-OFF
 * deterministic gate (`policy.artifact_gates.g1_spec.mode` defaults to
 * `off`). Because the gate is off unless a consumer opts in, this installer
 * carries a SINGLE managed marker pair plus a foreign-hook guard — no
 * multi-version migration machinery (the marker is v1; v1 never shipped, so
 * there is no legacy install to migrate).
 *
 * ## Active-hooks-path resolution (round-12 F1)
 *
 * A hook is only useful at the path git actually fires. This installer
 * mirrors `installPrePushFallback`'s 4-case `core.hooksPath` resolution
 * EXACTLY so `artifact_gates.g1_spec.mode: enforce` gives real commit-time
 * protection in every install topology, not just Husky:
 *
 *   1. `core.hooksPath` unset (vanilla git)
 *        → install `.git/hooks/pre-commit` (via `git rev-parse --git-path
 *          hooks/pre-commit`). `.husky/pre-commit` is still shipped as the
 *          canonical source-of-truth copy (manifest-tracked, refreshed by
 *          `rea upgrade`'s reconcile loop) but git does not fire it.
 *   2. `core.hooksPath=.husky` (typical Husky 9)
 *        → install `.husky/pre-commit`.
 *   3. `core.hooksPath` set elsewhere with a foreign pre-commit present
 *        → leave it alone (foreign posture); `rea doctor` flags the gap.
 *   4. `core.hooksPath` set but the target dir has no pre-commit
 *        → install the managed hook there (that is where git looks).
 *
 * Reuses `resolveHooksDir` from `pre-push.ts`; `resolveGitHookPath` is
 * replicated here (it is `pre-push`-internal) so both installers derive the
 * active path identically.
 *
 * ## Install policy
 *
 *   - absent      → install the managed hook
 *   - rea-managed → refresh (idempotent — re-running produces the same file)
 *   - foreign     → leave alone; the operator wires the fragment themselves
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import type fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveHooksDir } from './pre-push.js';

const execFileAsync = promisify(execFile);

/**
 * Header marker (line 2, immediately after the shebang) identifying a
 * rea-managed pre-commit hook. v1 — first release of the G1 spec-gate
 * pre-commit fragment.
 */
export const PRE_COMMIT_MARKER = '# rea:pre-commit-spec-gate v1';

/**
 * Body marker (line 3). A hook that carries the header marker but has an
 * emptied body is NOT classified as rea-managed — a real rea hook carries
 * both markers.
 */
export const PRE_COMMIT_BODY_MARKER = '# rea:pre-commit-body-v1';

/**
 * The POSIX-sh body. Mirrors the pre-push v6 CLI-resolution ladder — most
 * importantly the `REA_CLI_ROOT` worktree fallback — but stays minimal: HALT
 * is handled inside `rea gate spec-check` itself (it probes both roots), so
 * the body only resolves the rea CLI and dispatches. A missing CLI is
 * fail-OPEN here (exit 0) — the gate is default-off, so a consumer without a
 * built CLI must not have every commit blocked.
 *
 * ## Worktree fallback (round-12 F2)
 *
 * A linked worktree frequently has no local install — `node_modules/.bin/rea`
 * and `dist/cli/index.js` live only in the PRIMARY checkout. Without the
 * `REA_CLI_ROOT` seam the body would fall straight through to the fail-open
 * `exit 0` and the spec gate would silently never run in a worktree. Mirrors
 * `pre-push.ts`'s v6 body: resolve the CLI from the worktree first, then the
 * primary checkout (verified same-repository), then a global/PATH `rea`
 * (round-17 F2). Unlike pre-push there is NO `npx --no-install` tier, and the
 * gate FAILS OPEN (round-15 P1 + round-17 F2): every tier runs through
 * `_rea_spec_gate`, which blocks ONLY on a genuine G1 refusal (exit 2), so an
 * absent / too-old / broken CLI at any tier is `exit 0`, never a blocked commit.
 */
const BODY_TEMPLATE = `set -eu

# REA spec-gate (G1, Artifact Gates). The gate logic — staged-diff sizing,
# active-task + committed-spec resolution, off/shadow/enforce dispatch, and
# audit — lives in \`src/cli/gate.ts\` and is invoked via
# \`rea gate spec-check\`. This stub only resolves the rea CLI and dispatches.
#
# The gate is DEFAULT-OFF (policy.artifact_gates.g1_spec.mode defaults to
# off), so a missing CLI fails OPEN (exit 0) rather than blocking every
# commit on a repo whose CLI is not built.

REA_ROOT=\$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Round-12 F2 (worktree fallback, mirrors pre-push v6): a linked worktree
# frequently has no local install (node_modules/dist live only in the
# PRIMARY checkout). Resolve the CLI from ONE seam: the worktree first, then
# the primary checkout (.git-file discriminator, verified same-repository),
# then the in-project dist / global tier below. REA_ROOT itself stays the worktree
# — HALT and policy resolve against it inside \`rea gate spec-check\`; only CLI
# dispatch follows REA_CLI_ROOT.
REA_CLI_ROOT="\$REA_ROOT"
if [ ! -x "\${REA_ROOT}/node_modules/.bin/rea" ] && [ ! -f "\${REA_ROOT}/dist/cli/index.js" ] \\
   && [ -f "\${REA_ROOT}/.git" ]; then
  _rea_common_dir=\$(git -C "\$REA_ROOT" rev-parse --git-common-dir 2>/dev/null || true)
  case "\$_rea_common_dir" in
    "") : ;;
    /*) : ;;
    *) _rea_common_dir="\${REA_ROOT}/\${_rea_common_dir}" ;;
  esac
  if [ -n "\$_rea_common_dir" ]; then
    _rea_common=\$(dirname "\$_rea_common_dir")
    # Verify the dirname candidate is the SAME repository (its git-common-dir
    # resolves to ours) — a bare/separate-git-dir layout nesting metadata
    # under an UNRELATED checkout must not have its CLI executed against this
    # repo's commit.
    _rea_same_repo=0
    if [ -d "\${_rea_common}/.rea" ] || [ -e "\${_rea_common}/.git" ]; then
      _cc=\$(git -C "\$_rea_common" rev-parse --git-common-dir 2>/dev/null || true)
      case "\$_cc" in "") : ;; /*) : ;; *) _cc="\${_rea_common}/\${_cc}" ;; esac
      if [ -n "\$_cc" ]; then
        _x=\$(cd "\$_cc" 2>/dev/null && pwd -P) || _x="\$_cc"
        _y=\$(cd "\$_rea_common_dir" 2>/dev/null && pwd -P) || _y="\$_rea_common_dir"
        [ "\$_x" = "\$_y" ] && _rea_same_repo=1
      fi
    fi
    # A foreign nested checkout (verification failed) OR a --separate-git-dir
    # primary whose metadata is external — fall back to git's first listed
    # worktree (THIS repo's main one).
    if [ "\$_rea_same_repo" = "0" ]; then
      _rea_common=\$(git -C "\$REA_ROOT" worktree list --porcelain 2>/dev/null \\
        | sed -n 's/^worktree //p' | head -n 1)
    fi
    if [ -n "\$_rea_common" ] && [ "\$_rea_common" != "\$REA_ROOT" ] \\
       && { [ -d "\${_rea_common}/.rea" ] || [ -e "\${_rea_common}/.git" ]; } \\
       && { [ -x "\${_rea_common}/node_modules/.bin/rea" ] \\
            || { [ -f "\${_rea_common}/dist/cli/index.js" ] && [ -f "\${_rea_common}/package.json" ] \\
                 && grep -q '"name": *"@bookedsolid/rea"' "\${_rea_common}/package.json" 2>/dev/null; }; }; then
      REA_CLI_ROOT="\$_rea_common"
    fi
  fi
fi

# FAIL OPEN (round-15 P1 + round-17 F2). The ONLY non-zero hook exit is a
# WORKING rea CLI — in-project OR global — actually running \`gate spec-check\`
# and G1 genuinely REFUSING, which the CLI signals with exit code 2 (see
# src/cli/gate.ts: enforce-block / UNCERTAIN-at-enforce → exitCode 2; off /
# shadow / pass → 0). Every "CLI missing / too-old / broken" path is exit 0 —
# the gate is DEFAULT-OFF and must be invisible until a repo opts in.
#
# \`_rea_spec_gate\` enforces that discipline uniformly across tiers: run the
# resolved CLI and block ONLY on exit 2. A too-old CLI without the \`gate\`
# subcommand errors with a NON-2 code (commander unknown-command → 1), so it
# fails OPEN. That exit-code discipline is exactly what lets the global/PATH
# tier be reintroduced here: round-15 removed the old on-PATH and
# network-auto-install fallbacks because they propagated a HARD non-zero on a
# fresh clone / too-old / cache-miss, bricking every commit. The
# network-auto-install fallback is NOT reintroduced (nothing is ever
# auto-fetched); only an ALREADY-INSTALLED global \`rea\` is reached, and only
# its genuine exit-2 refusal blocks. The dist tier stays guarded by the
# package.json name grep so a foreign \`dist/cli/index.js\` can never be invoked.
_rea_spec_gate() {
  if "\$@" gate spec-check; then
    exit 0
  else
    _rc=\$?
    [ "\$_rc" -eq 2 ] && exit 2
    exit 0
  fi
}

if [ -x "\${REA_CLI_ROOT}/node_modules/.bin/rea" ]; then
  _rea_spec_gate "\${REA_CLI_ROOT}/node_modules/.bin/rea"
elif [ -f "\${REA_CLI_ROOT}/dist/cli/index.js" ] && [ -f "\${REA_CLI_ROOT}/package.json" ] \\
     && grep -q '"name": *"@bookedsolid/rea"' "\${REA_CLI_ROOT}/package.json" 2>/dev/null; then
  _rea_spec_gate node "\${REA_CLI_ROOT}/dist/cli/index.js"
elif command -v rea >/dev/null 2>&1; then
  # Global / PATH rea (e.g. \`rea install --global\`). Reached only when no
  # in-project CLI resolved. Same exit-2-only discipline: a too-old or broken
  # global CLI fails OPEN; only a genuine G1 refusal (exit 2) blocks.
  _rea_spec_gate rea
else
  # No rea CLI anywhere — fail OPEN (the gate is default-off).
  exit 0
fi
`;

/** The full pre-commit hook file content. */
export function preCommitHookContent(): string {
  return `#!/bin/sh
${PRE_COMMIT_MARKER}
${PRE_COMMIT_BODY_MARKER}
#
# Pre-commit hook installed by rea for the G1 spec-gate. Do NOT edit by
# hand — re-run the installer to refresh. See src/cli/gate.ts.

${BODY_TEMPLATE}`;
}

/**
 * True when `content` is a rea-managed pre-commit hook — shebang on line
 * 1, header marker on line 2, body marker on line 3. Strict anchored
 * matching (no substring search) so a comment mentioning the marker can't
 * reclassify a foreign hook.
 */
export function isReaManagedPreCommit(content: string): boolean {
  if (!content.startsWith('#!/bin/sh\n')) return false;
  const lines = content.split('\n');
  return lines[1] === PRE_COMMIT_MARKER && lines[2] === PRE_COMMIT_BODY_MARKER;
}

// ---------------------------------------------------------------------------
// Active-hooks-path resolution (round-12 F1) — mirrors pre-push.ts
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path git itself would fire for `hooks/pre-commit`.
 * Works across vanilla repos, linked worktrees (shared hooks dir), and
 * submodules. Replicated from `pre-push.ts` (there it is module-internal).
 */
async function resolveGitHookPath(targetDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', targetDir, 'rev-parse', '--git-path', 'hooks/pre-commit'],
      { encoding: 'utf8' },
    );
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return null;
    return path.isAbsolute(trimmed) ? trimmed : path.join(targetDir, trimmed);
  } catch {
    return null;
  }
}

/**
 * The 4-case resolution, identical in shape to
 * `pre-push.ts::resolveTargetHookPath`:
 *
 *   - `core.hooksPath` configured → `<hooksPath>/pre-commit`.
 *   - else, git resolvable        → `git rev-parse --git-path hooks/pre-commit`.
 *   - else (non-git / git failed) → `<targetDir>/.git/hooks/pre-commit`.
 */
export async function resolveTargetHookPath(
  targetDir: string,
): Promise<{ hookPath: string; hooksPathConfigured: boolean }> {
  const hooksInfo = await resolveHooksDir(targetDir);
  if (hooksInfo.configured && hooksInfo.dir !== null) {
    let dir = hooksInfo.dir;
    // Round-13 F1 — Husky 9 default layout: `core.hooksPath=.husky/_` points
    // at the GENERATED stub dir. git fires `.husky/_/pre-commit` (a stub that
    // sources `.husky/_/h`, which execs the USER hook `.husky/pre-commit`).
    // Writing a managed hook INTO `_/` would be (a) classified foreign and
    // skipped, and (b) clobbered by husky's stub regeneration. Install at the
    // USER hook path — the parent of the `_` stub dir — which the stub sources.
    if (path.basename(dir) === '_' && path.basename(path.dirname(dir)) === '.husky') {
      dir = path.dirname(dir);
    }
    return { hookPath: path.join(dir, 'pre-commit'), hooksPathConfigured: true };
  }
  const gitHookPath = await resolveGitHookPath(targetDir);
  if (gitHookPath !== null) {
    return { hookPath: gitHookPath, hooksPathConfigured: false };
  }
  return {
    hookPath: path.join(targetDir, '.git', 'hooks', 'pre-commit'),
    hooksPathConfigured: false,
  };
}

export type PreCommitDecision =
  | { action: 'install'; hookPath: string }
  | { action: 'refresh'; hookPath: string }
  | { action: 'skip'; reason: 'foreign-pre-commit'; hookPath: string };

/**
 * Classify the existing pre-commit at the path git actually fires for
 * `targetDir` (resolved via `resolveTargetHookPath`).
 */
export async function classifyPreCommit(targetDir: string): Promise<PreCommitDecision> {
  const { hookPath } = await resolveTargetHookPath(targetDir);
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(hookPath);
  } catch {
    return { action: 'install', hookPath };
  }
  // A symlink / directory / device at the hook path is foreign — never
  // written through (mirrors pre-push's non-regular-file refusal).
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { action: 'skip', reason: 'foreign-pre-commit', hookPath };
  }
  let content: string;
  try {
    content = await fsPromises.readFile(hookPath, 'utf8');
  } catch {
    return { action: 'skip', reason: 'foreign-pre-commit', hookPath };
  }
  if (isReaManagedPreCommit(content)) return { action: 'refresh', hookPath };
  return { action: 'skip', reason: 'foreign-pre-commit', hookPath };
}

export interface PreCommitInstallResult {
  decision: PreCommitDecision;
  written?: string;
}

/**
 * Install (or refresh) the managed pre-commit hook at the path git actually
 * fires (per `resolveTargetHookPath`). Never overwrites a foreign hook.
 * Writes atomically via a temp file + rename.
 */
export async function installPreCommitHook(options: {
  targetDir: string;
}): Promise<PreCommitInstallResult> {
  const decision = await classifyPreCommit(options.targetDir);
  if (decision.action === 'skip') {
    return { decision };
  }
  const dir = path.dirname(decision.hookPath);
  await fsPromises.mkdir(dir, { recursive: true });
  const rand = crypto.randomBytes(8).toString('hex');
  const tmp = path.join(dir, `${path.basename(decision.hookPath)}.rea-tmp-${rand}`);
  await fsPromises.writeFile(tmp, preCommitHookContent(), { encoding: 'utf8', mode: 0o755 });
  try {
    await fsPromises.chmod(tmp, 0o755);
  } catch {
    /* filesystems that don't honor mode — writeFile already set it */
  }
  await fsPromises.rename(tmp, decision.hookPath);
  return { decision, written: decision.hookPath };
}
