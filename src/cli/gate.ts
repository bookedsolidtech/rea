/**
 * G1 — spec-gate (Artifact Gates, 0.54.0+).
 *
 * `rea gate spec-check` — a commit-time deterministic gate. It fires when
 * the staged net diff is non-trivial (total changed lines exceed
 * `diff_lines` OR the changed-file count exceeds `diff_files`) OR the
 * active task is flagged `requires_spec`. When it fires, it requires the
 * active task to exist AND reference a `spec` path that BOTH exists on
 * disk AND is committed at HEAD (`git cat-file -e HEAD:<spec>`). Below the
 * threshold with no `requires_spec`, the gate is SILENT (exit 0) — the
 * load-bearing "just do it" branch for single-smart-zone work.
 *
 * ## Doctrine (deterministic — no model judgment)
 *
 * The gate checks EXISTENCE + git-committed-ness only. It never reads the
 * spec's contents or judges its quality. Three modes (from
 * `policy.artifact_gates.g1_spec.mode`):
 *
 *   - `off`     — silent no-op (exit 0). Default when the policy block (or
 *                 the whole policy) is absent.
 *   - `shadow`  — log a `rea.gate.g1.shadow` would-block audit event and
 *                 ALLOW (exit 0). NEVER blocks.
 *   - `enforce` — log a `rea.gate.g1` deny audit event and BLOCK (exit 2)
 *                 with a banner. NEVER prompts — the gate fails into the
 *                 audit trail, not an interactive question, so an overnight
 *                 autonomous run survives it.
 *
 * ## UNCERTAIN ≡ REFUSE (at enforce only)
 *
 * If git is unavailable (the staged diff or the committed-spec probe
 * cannot be computed) or the task store is unreadable, the gate is
 * UNCERTAIN. At `enforce` it refuses; at `shadow` it logs + allows; at
 * `off` it is silent.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { loadPolicy } from '../policy/loader.js';
import type { GateMode } from '../policy/types.js';
import { readTasks, activeTask } from '../tasks/store.js';
import type { TaskRecord } from '../tasks/types.js';
import { resolveLocalRoot, resolveCommonRoot } from '../lib/worktree-roots.js';
import { checkHaltRoots, formatHaltBanner } from '../hooks/_lib/halt-check.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../audit/append.js';

/** Canonical audit tool name for an enforced G1 refusal. */
export const G1_TOOL_NAME = 'rea.gate.g1' as const;
/** Shadow audit tool name — a would-block event that never blocks. */
export const G1_SHADOW_TOOL_NAME = 'rea.gate.g1.shadow' as const;
const SERVER_NAME = 'rea' as const;

/**
 * Minimal git runner seam. Returns the process status (non-zero = failure)
 * and captured stdout. Injectable so tests can drive the git-unavailable
 * posture without a real broken repo.
 */
export interface SpecGateGitRunner {
  (args: string[]): { status: number; stdout: string };
}

export interface GateSpecCheckOptions {
  /** Override the resolved local root (tests). Production resolves from cwd. */
  reaRoot?: string;
  /** Override the git runner (tests). Production spawns real `git`. */
  gitRunner?: SpecGateGitRunner;
  stderrWrite?: (s: string) => void;
  stdoutWrite?: (s: string) => void;
}

export interface GateResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function makeRealGitRunner(cwd: string): SpecGateGitRunner {
  return (args: string[]) => {
    try {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
      return { status: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout ?? '' };
    } catch {
      return { status: 1, stdout: '' };
    }
  };
}

interface DiffStat {
  ok: boolean;
  totalLines: number;
  fileCount: number;
}

/**
 * Parse `git diff --cached --numstat` output. Each line is
 * `<added>\t<deleted>\t<path>`; binary files render added/deleted as `-`
 * (counted as 0 lines but still 1 file). A non-zero git status → `ok:
 * false` (uncertain); empty output with status 0 is a clean, zero-change
 * result (below threshold), NOT uncertain.
 */
function computeStagedDiff(git: SpecGateGitRunner): DiffStat {
  const res = git(['diff', '--cached', '--numstat']);
  if (res.status !== 0) return { ok: false, totalLines: 0, fileCount: 0 };
  let totalLines = 0;
  let fileCount = 0;
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    fileCount += 1;
    const added = parts[0] === '-' ? 0 : Number.parseInt(parts[0] ?? '', 10);
    const deleted = parts[1] === '-' ? 0 : Number.parseInt(parts[1] ?? '', 10);
    if (Number.isFinite(added)) totalLines += added;
    if (Number.isFinite(deleted)) totalLines += deleted;
  }
  return { ok: true, totalLines, fileCount };
}

function banner(reason: string): string {
  return (
    `ARTIFACT GATE G1 (spec): commit blocked — ${reason}\n\n` +
    `This change is non-trivial (or the active ticket requires a spec) but no ` +
    `committed spec is referenced by the active task.\n` +
    `Create a spec, commit it, and point the active ticket at it:\n` +
    `  rea tasks add --subject "<title>" --spec <path> --requires-spec\n` +
    `  rea tasks activate <id>\n` +
    `then stage + commit the spec before this change.\n`
  );
}

export async function runGateSpecCheck(options: GateSpecCheckOptions = {}): Promise<GateResult> {
  let stderr = '';
  let stdout = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };
  // stdout is unused by the gate today (no JSON protocol at commit time),
  // but the seam mirrors the hook shape for symmetry / future use.
  const writeStdout = (s: string): void => {
    stdout += s;
    if (options.stdoutWrite) options.stdoutWrite(s);
  };
  void writeStdout;

  const localRoot = options.reaRoot ?? resolveLocalRoot(process.cwd());
  const { commonRoot } = resolveCommonRoot(localRoot, () => {});

  // HALT is uniform across the gate tier and BINDS BEFORE the gate mode
  // (round-18 F1). A frozen repo blocks the commit (exit 2) even when
  // `g1_spec.mode` is `off` (the DEFAULT) — the freeze contract is not
  // conditional on opting into the spec gate. Mirrors G2
  // (`src/hooks/verify-gate/index.ts`), which checks HALT before its own
  // mode short-circuit. Resolved across BOTH the local (worktree) and common
  // (primary-checkout) roots via the shared `checkHaltRoots` helper.
  const halt = checkHaltRoots(localRoot, commonRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, stdout };
  }

  // Resolve the gate mode — a missing/invalid policy or absent
  // artifact_gates block resolves to `off` (default-off).
  let mode: GateMode = 'off';
  let diffLines = 150;
  let diffFiles = 5;
  try {
    const policy = loadPolicy(localRoot);
    const g1 = policy.artifact_gates?.g1_spec;
    if (g1 !== undefined) {
      mode = g1.mode;
      diffLines = g1.diff_lines;
      diffFiles = g1.diff_files;
    }
  } catch {
    mode = 'off';
  }
  if (mode === 'off') {
    return { exitCode: 0, stderr, stdout };
  }

  const git = options.gitRunner ?? makeRealGitRunner(localRoot);

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
      /* best-effort */
    }
  };

  const resolveVerdict = async (
    reason: string,
    metadata: Record<string, unknown>,
    bannerText: string,
  ): Promise<GateResult> => {
    if (mode === 'shadow') {
      await audit(G1_SHADOW_TOOL_NAME, InvocationStatus.Allowed, {
        would_block: true,
        reason,
        ...metadata,
      });
      return { exitCode: 0, stderr, stdout };
    }
    // enforce
    await audit(G1_TOOL_NAME, InvocationStatus.Denied, { reason, ...metadata });
    writeStderr(bannerText);
    return { exitCode: 2, stderr, stdout };
  };

  // Read the task store from the WORKING TREE (not the git index) — this is
  // correct by design, not the round-28 P1 concern. `.rea/tasks.jsonl` is a
  // managed `.gitignore` entry (rounds 15/16): it is LOCAL per-worktree working
  // state and is NEVER staged, so there is no "staged task store" to read —
  // `git cat-file :.rea/tasks.jsonl` would always be empty. The active-task
  // pointer is intentionally local; the artifact G1 requires to be COMMITTED is
  // the SPEC it references, which IS verified against the index below. An
  // unreadable store is UNCERTAIN.
  let tasks: TaskRecord[];
  try {
    tasks = readTasks(localRoot);
  } catch {
    return resolveVerdict(
      'task store unreadable',
      { uncertain: 'tasks_unreadable' },
      banner('the task store (.rea/tasks.jsonl) could not be read'),
    );
  }
  const active = activeTask(tasks);
  const requiresSpec = active?.requires_spec === true;

  // Compute the staged diff. Git failure is UNCERTAIN (we can neither size
  // the diff nor verify a committed spec without git).
  const diff = computeStagedDiff(git);
  if (!diff.ok) {
    return resolveVerdict(
      'git unavailable',
      { uncertain: 'git_unavailable' },
      banner('git was unavailable to inspect the staged diff'),
    );
  }

  const overThreshold = diff.totalLines > diffLines || diff.fileCount > diffFiles;
  const triggered = overThreshold || requiresSpec;

  // Below threshold and no requires_spec → the SILENT "just do it" branch.
  if (!triggered) {
    return { exitCode: 0, stderr, stdout };
  }

  // Triggered — require an active task with a committed, on-disk spec.
  const specPath = typeof active?.spec === 'string' ? active.spec : '';
  const metaCommon: Record<string, unknown> = {
    diff_lines: diff.totalLines,
    diff_files: diff.fileCount,
    threshold_lines: diffLines,
    threshold_files: diffFiles,
    over_threshold: overThreshold,
    requires_spec: requiresSpec,
    ...(active !== null ? { active_task: active.id } : {}),
    ...(specPath.length > 0 ? { spec: specPath } : {}),
  };

  if (active === null) {
    return resolveVerdict('no active task', metaCommon, banner('no active task references a spec'));
  }
  if (specPath.length === 0) {
    return resolveVerdict(
      'active task has no spec',
      metaCommon,
      banner(`the active task ${active.id} references no spec`),
    );
  }
  // Round-10 P2: the spec must resolve to a FILE, not a directory. Both
  // `existsSync('docs')` and `git cat-file -e HEAD:docs` (a tree object)
  // succeed for a directory, which would let a non-trivial diff pass G1
  // with no spec document at all.
  let specIsFileOnDisk = false;
  try {
    specIsFileOnDisk = fs.statSync(path.join(localRoot, specPath)).isFile();
  } catch {
    specIsFileOnDisk = false;
  }
  if (!specIsFileOnDisk) {
    return resolveVerdict(
      'spec missing on disk',
      metaCommon,
      banner(`the spec ${specPath} does not exist on disk as a file`),
    );
  }
  // `cat-file -t` returns the object type; require a `blob` (a FILE), not a
  // `tree` (a directory). Resolve against the INDEX (`:${specPath}`) — the
  // state being committed — NOT the working tree or HEAD. The index covers
  // BOTH cases in one check: a newly-staged spec (the commit that introduces
  // it — round-27 P1: a HEAD-only check deadlocked this flow) AND an
  // already-tracked unchanged spec (git keeps tracked files in the index). It
  // deliberately does NOT fall back to HEAD (round-28 P2): a spec staged for
  // REMOVAL (`git rm --cached`) is gone from the index but still at HEAD, so a
  // HEAD fallback would wrongly pass a commit that deletes the required spec. A
  // directory is a `tree`, and a path with no index entry fails, so both stay
  // rejected.
  const stagedType = git(['cat-file', '-t', `:${specPath}`]);
  const committedAsFile = stagedType.status === 0 && stagedType.stdout.trim() === 'blob';
  if (!committedAsFile) {
    return resolveVerdict(
      'spec not committed',
      metaCommon,
      banner(`the spec ${specPath} is not committed as a file (not staged in the index)`),
    );
  }
  // Round-29 P2: a SYMLINK is also a `blob` to `cat-file -t`, and the earlier
  // `statSync` FOLLOWS it to whatever it points at — so a committed symlink
  // spec pointing at an external / machine-local file would pass, satisfying G1
  // with a non-portable document that isn't actually versioned as the spec. A
  // symlink is index mode `120000` (vs `100644`/`100755` for a regular file);
  // reject it so the spec must be a real versioned document.
  const stagedStat = git(['ls-files', '--stage', '--', specPath]);
  const stagedFileMode = stagedStat.stdout.trim().split(/\s+/)[0] ?? '';
  if (stagedFileMode === '120000') {
    return resolveVerdict(
      'spec is a symlink',
      metaCommon,
      banner(`the spec ${specPath} is a symlink, not a real versioned document`),
    );
  }

  // Pass — a committed spec is referenced by the active task.
  return { exitCode: 0, stderr, stdout };
}

/**
 * CLI entry — `rea gate spec-check`. Exits with the resolved code.
 */
export async function runGateSpecCheckCli(): Promise<void> {
  const result = await runGateSpecCheck({
    stderrWrite: (s) => process.stderr.write(s),
    stdoutWrite: (s) => process.stdout.write(s),
  });
  process.exit(result.exitCode);
}

/**
 * Register `rea gate <subcommand>` on the root program.
 */
export function registerGateCommand(program: Command): void {
  const gate = program
    .command('gate')
    .description(
      'Artifact Gates (deterministic, model-judgment-free process gates). ' +
        'Governed by policy.artifact_gates; each gate is off | shadow | enforce.',
    );

  gate
    .command('spec-check')
    .description(
      'G1 spec-gate (commit-time). When the staged net diff is non-trivial ' +
        '(> artifact_gates.g1_spec.diff_lines lines OR > diff_files files) or the active ' +
        'task is requires_spec, require the active task to reference a committed, on-disk ' +
        'spec. off → exit 0; shadow → audit rea.gate.g1.shadow + exit 0; enforce → audit ' +
        'rea.gate.g1 + exit 2 (no prompt). UNCERTAIN (git/tasks unavailable) refuses at enforce.',
    )
    .action(async () => {
      await runGateSpecCheckCli();
    });
}
