/**
 * Unit tests for `runVerifyGate` (G2 verification-gate) and its
 * deterministic completion detector.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runVerifyGate,
  detectBadCompletions,
  G2_TOOL_NAME,
  G2_SHADOW_TOOL_NAME,
} from './index.js';
import type { GateMode } from '../../policy/types.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-verify-gate-'));
}
function rm(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function writePolicy(root: string, g2Mode: GateMode | 'absent'): void {
  fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  const gates =
    g2Mode === 'absent'
      ? ''
      : `artifact_gates:\n  g2_verify:\n    mode: ${g2Mode}\n`;
  const yaml = `version: "0.54.0"
profile: bst-internal
installed_by: test
installed_at: "2026-01-01T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
blocked_paths: []
${gates}`;
  fs.writeFileSync(path.join(root, '.rea', 'policy.yaml'), yaml);
}

function taskLine(rec: Record<string, unknown>): string {
  return JSON.stringify({
    id: 'T-0001',
    subject: 's',
    active: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...rec,
  });
}

function writePayload(opts: { filePath?: string; content?: string; toolName?: string }): string {
  const ti: Record<string, unknown> = {};
  if (opts.filePath !== undefined) ti['file_path'] = opts.filePath;
  if (opts.content !== undefined) ti['content'] = opts.content;
  return JSON.stringify({ tool_name: opts.toolName ?? 'Write', tool_input: ti });
}

function editPayload(opts: {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): string {
  return JSON.stringify({
    tool_name: 'Edit',
    tool_input: {
      file_path: opts.filePath,
      old_string: opts.oldString,
      new_string: opts.newString,
      ...(opts.replaceAll !== undefined ? { replace_all: opts.replaceAll } : {}),
    },
  });
}

function auditContains(root: string, toolName: string): boolean {
  const p = path.join(root, '.rea', 'audit.jsonl');
  if (!fs.existsSync(p)) return false;
  return fs.readFileSync(p, 'utf8').includes(`"${toolName}"`);
}

const COMPLETED_NO_EVIDENCE = taskLine({ status: 'completed' });
const COMPLETED_WITH_EVIDENCE = taskLine({ status: 'completed', evidence: ['docs/proof.md'] });

describe('detectBadCompletions', () => {
  it('flags a completed record with no evidence', () => {
    expect(detectBadCompletions(COMPLETED_NO_EVIDENCE)).toEqual(['T-0001']);
  });

  it('flags a completed record whose evidence entries are all blank (round-10 P2)', () => {
    expect(detectBadCompletions(taskLine({ status: 'completed', evidence: ['  ', ''] }))).toEqual([
      'T-0001',
    ]);
  });
  it('allows a completed record with evidence', () => {
    expect(detectBadCompletions(COMPLETED_WITH_EVIDENCE)).toEqual([]);
  });
  it('allows a completed record with empty-array evidence flagged', () => {
    expect(detectBadCompletions(taskLine({ status: 'completed', evidence: [] }))).toEqual(['T-0001']);
  });
  it('folds last-write-wins per id (later cancelled supersedes bad completed)', () => {
    const content =
      taskLine({ status: 'completed' }) + '\n' + taskLine({ status: 'cancelled' });
    expect(detectBadCompletions(content)).toEqual([]);
  });
  it('ignores pending/in_progress records without evidence', () => {
    expect(detectBadCompletions(taskLine({ status: 'in_progress' }))).toEqual([]);
  });
  it('tolerates malformed lines', () => {
    const content = '{not json\n' + COMPLETED_WITH_EVIDENCE;
    expect(detectBadCompletions(content)).toEqual([]);
  });
});

describe('runVerifyGate', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rm(root);
  });

  it('mode off → silent exit 0, no audit', async () => {
    writePolicy(root, 'off');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({ filePath: '.rea/tasks.jsonl', content: COMPLETED_NO_EVIDENCE }),
    });
    expect(r.exitCode).toBe(0);
    expect(auditContains(root, G2_TOOL_NAME)).toBe(false);
    expect(auditContains(root, G2_SHADOW_TOOL_NAME)).toBe(false);
  });

  it('does NOT deadlock on a pre-existing bad row — only NEW completions block (round-10 P2)', async () => {
    writePolicy(root, 'enforce');
    // Prior store already carries a historical completed-without-evidence
    // row (e.g. from before opting into G2).
    const historical = COMPLETED_NO_EVIDENCE + '\n';
    fs.writeFileSync(path.join(root, '.rea', 'tasks.jsonl'), historical);
    // An UNRELATED write (add a fresh pending task) must pass — the
    // historical bad row is not a new transition introduced here.
    const unrelated =
      historical +
      taskLine({ id: 'T-0002', status: 'pending' }) +
      '\n';
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({ filePath: '.rea/tasks.jsonl', content: unrelated }),
    });
    expect(r.exitCode).toBe(0);
    // …but NEWLY completing T-0002 without evidence still blocks.
    const newBad =
      historical + taskLine({ id: 'T-0002', status: 'completed' }) + '\n';
    const r2 = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({ filePath: '.rea/tasks.jsonl', content: newBad }),
    });
    expect(r2.exitCode).toBe(2);
  });

  it('absent artifact_gates block → treated as off (exit 0)', async () => {
    writePolicy(root, 'absent');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({ filePath: '.rea/tasks.jsonl', content: COMPLETED_NO_EVIDENCE }),
    });
    expect(r.exitCode).toBe(0);
  });

  it('missing policy → off (exit 0)', async () => {
    // No policy.yaml written at all.
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({ filePath: '.rea/tasks.jsonl', content: COMPLETED_NO_EVIDENCE }),
    });
    expect(r.exitCode).toBe(0);
  });

  it('enforce + completed-without-evidence (Write) → exit 2 + banner + audit deny', async () => {
    writePolicy(root, 'enforce');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({ filePath: '.rea/tasks.jsonl', content: COMPLETED_NO_EVIDENCE }),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('T-0001');
    expect(r.stderr).toContain('evidence');
    expect(r.stdout).toContain('"permissionDecision":"deny"');
    expect(auditContains(root, G2_TOOL_NAME)).toBe(true);
  });

  it('shadow + completed-without-evidence → exit 0 + shadow audit (never blocks)', async () => {
    writePolicy(root, 'shadow');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({ filePath: '.rea/tasks.jsonl', content: COMPLETED_NO_EVIDENCE }),
    });
    expect(r.exitCode).toBe(0);
    expect(auditContains(root, G2_SHADOW_TOOL_NAME)).toBe(true);
    expect(auditContains(root, G2_TOOL_NAME)).toBe(false);
  });

  it('enforce + completed-WITH-evidence → allow (exit 0)', async () => {
    writePolicy(root, 'enforce');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({
        filePath: '.rea/tasks.jsonl',
        content: COMPLETED_WITH_EVIDENCE,
      }),
    });
    expect(r.exitCode).toBe(0);
    expect(auditContains(root, G2_TOOL_NAME)).toBe(false);
  });

  it('enforce + non-tasks.jsonl path → ignored (exit 0)', async () => {
    writePolicy(root, 'enforce');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({ filePath: 'src/foo.ts', content: COMPLETED_NO_EVIDENCE }),
    });
    expect(r.exitCode).toBe(0);
  });

  it('enforce + Edit reconstruction that introduces a bad completion → exit 2', async () => {
    writePolicy(root, 'enforce');
    // Seed the on-disk file with an in_progress record; the Edit flips it to completed.
    const before = taskLine({ status: 'in_progress' });
    fs.writeFileSync(path.join(root, '.rea', 'tasks.jsonl'), before + '\n');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: editPayload({
        filePath: '.rea/tasks.jsonl',
        oldString: '"status":"in_progress"',
        newString: '"status":"completed"',
      }),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('T-0001');
  });

  it('enforce + Edit reconstruction that keeps evidence → allow (exit 0)', async () => {
    writePolicy(root, 'enforce');
    const before = taskLine({ status: 'in_progress', evidence: ['docs/proof.md'] });
    fs.writeFileSync(path.join(root, '.rea', 'tasks.jsonl'), before + '\n');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: editPayload({
        filePath: '.rea/tasks.jsonl',
        oldString: '"status":"in_progress"',
        newString: '"status":"completed"',
      }),
    });
    expect(r.exitCode).toBe(0);
  });

  it('enforce + unreconstructable Edit (no current file) → refuse (exit 2, uncertain)', async () => {
    writePolicy(root, 'enforce');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: editPayload({
        filePath: '.rea/tasks.jsonl',
        oldString: 'nonexistent',
        newString: 'x',
      }),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toLowerCase()).toContain('uncertain');
  });

  it('shadow + unreconstructable Edit → log + allow (exit 0)', async () => {
    writePolicy(root, 'shadow');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: editPayload({
        filePath: '.rea/tasks.jsonl',
        oldString: 'nonexistent',
        newString: 'x',
      }),
    });
    expect(r.exitCode).toBe(0);
    expect(auditContains(root, G2_SHADOW_TOOL_NAME)).toBe(true);
  });

  it('enforce + malformed payload → refuse (exit 2, uncertain)', async () => {
    writePolicy(root, 'enforce');
    const r = await runVerifyGate({ reaRoot: root, stdinOverride: '{not json' });
    expect(r.exitCode).toBe(2);
  });

  it('off + malformed payload → silent exit 0 (mode gates before uncertainty)', async () => {
    writePolicy(root, 'off');
    const r = await runVerifyGate({ reaRoot: root, stdinOverride: '{not json' });
    expect(r.exitCode).toBe(0);
  });

  it('HALT → exit 2 regardless of mode', async () => {
    writePolicy(root, 'off');
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen\n');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({ filePath: '.rea/tasks.jsonl', content: COMPLETED_WITH_EVIDENCE }),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('REA HALT');
  });

  // ── Round-12 F3: symlinked task-store paths ──────────────────────────
  // A Write/Edit to `tasklog -> .rea/tasks.jsonl` mutates the real store but
  // its raw file_path does not literally name it. The gate now canonicalizes
  // (realpath) before the isTasksJsonl test — mirroring the bash-tier gate.
  it.skipIf(process.platform === 'win32')(
    'F3: Write through a symlink resolving to the store blocks under enforce',
    async () => {
      writePolicy(root, 'enforce');
      const store = path.join(root, '.rea', 'tasks.jsonl');
      fs.writeFileSync(store, ''); // store exists so realpath can follow the link
      const link = path.join(root, 'tasklog');
      fs.symlinkSync(store, link);
      const r = await runVerifyGate({
        reaRoot: root,
        stdinOverride: writePayload({ filePath: link, content: COMPLETED_NO_EVIDENCE }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain('permissionDecision');
    },
  );

  // Round-19 F2 — the FRESH-REPO case: the alias resolves to the store even
  // though `tasks.jsonl` does NOT exist yet. Pre-fix, `canonicalizePath`
  // resolved the dangling link to its OWN path (`.../tasklog`), so the FIRST
  // Write through the alias bypassed enforce.
  it.skipIf(process.platform === 'win32')(
    'F2: first Write through a DANGLING alias (store not yet created) blocks under enforce',
    async () => {
      writePolicy(root, 'enforce');
      // NOTE: `.rea/tasks.jsonl` is intentionally NOT created. The link dangles.
      const store = path.join(root, '.rea', 'tasks.jsonl');
      const link = path.join(root, 'tasklog');
      fs.symlinkSync(store, link);
      expect(fs.existsSync(store)).toBe(false); // truly dangling
      const r = await runVerifyGate({
        reaRoot: root,
        stdinOverride: writePayload({ filePath: link, content: COMPLETED_NO_EVIDENCE }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain('permissionDecision');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'F3: a symlink to an UNRELATED file is not treated as the store (exit 0)',
    async () => {
      writePolicy(root, 'enforce');
      const other = path.join(root, 'other.json');
      fs.writeFileSync(other, '{}');
      const link = path.join(root, 'tasklog');
      fs.symlinkSync(other, link);
      const r = await runVerifyGate({
        reaRoot: root,
        stdinOverride: writePayload({ filePath: link, content: COMPLETED_NO_EVIDENCE }),
      });
      expect(r.exitCode).toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'F3: an unresolvable symlink is fail-safe (never crashes; exit 0 at enforce)',
    async () => {
      writePolicy(root, 'enforce');
      // Dangling link → realpath throws; the fallback resolves the link's own
      // parent+name, which is NOT the store, so the gate treats it as no-match.
      const link = path.join(root, 'tasklog');
      fs.symlinkSync(path.join(root, 'does-not-exist'), link);
      const r = await runVerifyGate({
        reaRoot: root,
        stdinOverride: writePayload({ filePath: link, content: COMPLETED_NO_EVIDENCE }),
      });
      expect(r.exitCode).toBe(0);
    },
  );

  // ── Round-26 P2 — cross-repo isolation ───────────────────────────────────
  // The pre-fix `isTasksJsonl` suffix-match governed ANY repo's store. The
  // match is now repo-scoped: a Write to a FOREIGN repo's store while the gate
  // is rooted at repo A must NOT be governed by A's policy.
  it('P2: a Write to a FOREIGN repo B store under repo A enforce → exit 0 (not governed)', async () => {
    writePolicy(root, 'enforce'); // root = repo A
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-verify-gate-B-'));
    try {
      fs.mkdirSync(path.join(repoB, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(repoB, '.rea', 'tasks.jsonl'), ''); // B's real store
      // A completed-no-evidence write to B's store — WOULD block if A governed it.
      const res = await runVerifyGate({
        reaRoot: root, // gate rooted at repo A
        stdinOverride: writePayload({
          filePath: path.join(repoB, '.rea', 'tasks.jsonl'),
          content: COMPLETED_NO_EVIDENCE,
        }),
      });
      expect(res.exitCode).toBe(0);
      // And nothing was audited into repo A's chain.
      expect(fs.existsSync(path.join(root, '.rea', 'audit.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(repoB, { recursive: true, force: true });
    }
  });

  it('P2 control: repo A still governs its OWN store (in-repo literal → exit 2)', async () => {
    writePolicy(root, 'enforce');
    const r = await runVerifyGate({
      reaRoot: root,
      stdinOverride: writePayload({
        filePath: path.join(root, '.rea', 'tasks.jsonl'), // A's own store, absolute
        content: COMPLETED_NO_EVIDENCE,
      }),
    });
    expect(r.exitCode).toBe(2);
  });

  // ── Round-27 P1 — sibling worktree governance ────────────────────────────
  // Two linked worktrees of one primary. From worktree A's gate, a
  // completed-without-evidence Write to worktree B's store must be governed
  // (siblings share commonRoot) — while a truly foreign repo stays ungoverned.
  function git(repo: string, ...args: string[]): void {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  }

  it('P1: a Write to a SIBLING worktree store under worktree A enforce → exit 2 (governed)', async () => {
    const primary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-vg-primary-')));
    const wtA = `${primary}-A`;
    const wtB = `${primary}-B`;
    try {
      execFileSync('git', ['init', '-q', primary], { stdio: 'ignore' });
      git(primary, 'config', 'user.email', 't@t');
      git(primary, 'config', 'user.name', 't');
      git(primary, 'config', 'commit.gpgsign', 'false');
      git(primary, 'commit', '-q', '--allow-empty', '-m', 'init');
      git(primary, 'worktree', 'add', '-q', wtA, '-b', 'stream-a');
      git(primary, 'worktree', 'add', '-q', wtB, '-b', 'stream-b');

      // Gate is rooted at worktree A (enforce); worktree B has its own store.
      writePolicy(wtA, 'enforce');
      fs.mkdirSync(path.join(wtB, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(wtB, '.rea', 'tasks.jsonl'), ''); // B's real store

      const r = await runVerifyGate({
        reaRoot: wtA, // local = A, common = primary, siblings include B
        stdinOverride: writePayload({
          filePath: path.join(wtB, '.rea', 'tasks.jsonl'),
          content: COMPLETED_NO_EVIDENCE,
        }),
      });
      expect(r.exitCode).toBe(2);
    } finally {
      fs.rmSync(wtA, { recursive: true, force: true });
      fs.rmSync(wtB, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  });

  it('P1 + P2 together: sibling store → governed (2), FOREIGN repo store → NOT governed (0)', async () => {
    const primary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-vg-primary2-')));
    const wtA = `${primary}-A`;
    const wtB = `${primary}-B`;
    const foreign = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-vg-foreign-')));
    try {
      execFileSync('git', ['init', '-q', primary], { stdio: 'ignore' });
      git(primary, 'config', 'user.email', 't@t');
      git(primary, 'config', 'user.name', 't');
      git(primary, 'config', 'commit.gpgsign', 'false');
      git(primary, 'commit', '-q', '--allow-empty', '-m', 'init');
      git(primary, 'worktree', 'add', '-q', wtA, '-b', 's-a');
      git(primary, 'worktree', 'add', '-q', wtB, '-b', 's-b');
      writePolicy(wtA, 'enforce');
      fs.mkdirSync(path.join(wtB, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(wtB, '.rea', 'tasks.jsonl'), '');
      // A separate git repo (NOT a worktree of primary) with its own store.
      execFileSync('git', ['init', '-q', foreign], { stdio: 'ignore' });
      fs.mkdirSync(path.join(foreign, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(foreign, '.rea', 'tasks.jsonl'), '');

      const sibling = await runVerifyGate({
        reaRoot: wtA,
        stdinOverride: writePayload({
          filePath: path.join(wtB, '.rea', 'tasks.jsonl'),
          content: COMPLETED_NO_EVIDENCE,
        }),
      });
      expect(sibling.exitCode).toBe(2); // sibling governed

      const foreignRes = await runVerifyGate({
        reaRoot: wtA,
        stdinOverride: writePayload({
          filePath: path.join(foreign, '.rea', 'tasks.jsonl'),
          content: COMPLETED_NO_EVIDENCE,
        }),
      });
      expect(foreignRes.exitCode).toBe(0); // foreign NOT governed (isolation holds)
    } finally {
      fs.rmSync(wtA, { recursive: true, force: true });
      fs.rmSync(wtB, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });
});
