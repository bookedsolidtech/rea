/**
 * Unit tests for `runGateSpecCheck` (G1 spec-gate). The threshold /
 * committed-spec paths run against REAL temp git repos with staged diffs;
 * the git-unavailable posture uses an injected git runner.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runGateSpecCheck,
  G1_TOOL_NAME,
  G1_SHADOW_TOOL_NAME,
  type SpecGateGitRunner,
} from './gate.js';
import type { GateMode } from '../policy/types.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-spec-gate-'));
}
function rm(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function git(repo: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

function initRepo(repo: string): void {
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.hooksPath', '/dev/null']);
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  git(repo, ['add', 'seed.txt']);
  git(repo, ['commit', '-q', '-m', 'init']);
}

function writePolicy(
  root: string,
  g1: { mode: GateMode | 'absent'; diffLines?: number; diffFiles?: number },
): void {
  fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  const gates =
    g1.mode === 'absent'
      ? ''
      : `artifact_gates:
  g1_spec:
    mode: ${g1.mode}
    diff_lines: ${g1.diffLines ?? 10}
    diff_files: ${g1.diffFiles ?? 2}
`;
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

function writeTasks(root: string, records: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  const lines = records.map((rec) =>
    JSON.stringify({
      id: 'T-0001',
      subject: 's',
      status: 'in_progress',
      active: true,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...rec,
    }),
  );
  fs.writeFileSync(path.join(root, '.rea', 'tasks.jsonl'), lines.join('\n') + '\n');
}

/** Stage a new file with `lineCount` lines to produce a net-additive diff. */
function stageBigChange(repo: string, name: string, lineCount: number): void {
  const body = Array.from({ length: lineCount }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(repo, name), body);
  git(repo, ['add', name]);
}

function auditContains(root: string, toolName: string): boolean {
  const p = path.join(root, '.rea', 'audit.jsonl');
  if (!fs.existsSync(p)) return false;
  return fs.readFileSync(p, 'utf8').includes(`"${toolName}"`);
}

const failingGit: SpecGateGitRunner = () => ({ status: 1, stdout: '' });

describe('runGateSpecCheck', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rm(root);
  });

  it('mode off → silent exit 0 even over threshold', async () => {
    initRepo(root);
    writePolicy(root, { mode: 'off' });
    stageBigChange(root, 'big.txt', 50);
    const r = await runGateSpecCheck({ reaRoot: root });
    expect(r.exitCode).toBe(0);
    expect(auditContains(root, G1_TOOL_NAME)).toBe(false);
  });

  it('below threshold, no requires_spec → silent exit 0 (the "just do it" branch)', async () => {
    initRepo(root);
    writePolicy(root, { mode: 'enforce', diffLines: 10, diffFiles: 2 });
    stageBigChange(root, 'small.txt', 1);
    const r = await runGateSpecCheck({ reaRoot: root });
    expect(r.exitCode).toBe(0);
  });

  it('over threshold + no active spec → enforce blocks (exit 2 + audit deny)', async () => {
    initRepo(root);
    writePolicy(root, { mode: 'enforce', diffLines: 10, diffFiles: 2 });
    stageBigChange(root, 'big.txt', 50);
    const r = await runGateSpecCheck({ reaRoot: root });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('ARTIFACT GATE G1');
    expect(auditContains(root, G1_TOOL_NAME)).toBe(true);
  });

  it('over threshold + no active spec → shadow logs + allows (exit 0)', async () => {
    initRepo(root);
    writePolicy(root, { mode: 'shadow', diffLines: 10, diffFiles: 2 });
    stageBigChange(root, 'big.txt', 50);
    const r = await runGateSpecCheck({ reaRoot: root });
    expect(r.exitCode).toBe(0);
    expect(auditContains(root, G1_SHADOW_TOOL_NAME)).toBe(true);
    expect(auditContains(root, G1_TOOL_NAME)).toBe(false);
  });

  it('over threshold + committed spec referenced by active task → pass (exit 0)', async () => {
    initRepo(root);
    // Commit a spec.
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# spec\n');
    git(root, ['add', 'docs/spec.md']);
    git(root, ['commit', '-q', '-m', 'add spec']);
    writePolicy(root, { mode: 'enforce', diffLines: 10, diffFiles: 2 });
    writeTasks(root, [{ spec: 'docs/spec.md', requires_spec: true }]);
    stageBigChange(root, 'big.txt', 50);
    const r = await runGateSpecCheck({ reaRoot: root });
    expect(r.exitCode).toBe(0);
  });

  it('over threshold + spec STAGED in THIS commit (not yet at HEAD) → pass (round-27 P1)', async () => {
    // The documented `rea tasks add --spec … --requires-spec` flow introduces
    // the spec IN the same commit: it is staged but cannot be at HEAD yet. A
    // HEAD-only check would deadlock the only commit that could satisfy it.
    initRepo(root);
    writePolicy(root, { mode: 'enforce', diffLines: 10, diffFiles: 2 });
    writeTasks(root, [{ spec: 'docs/spec.md', requires_spec: true }]);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# spec\n');
    git(root, ['add', 'docs/spec.md']); // staged, NOT committed
    stageBigChange(root, 'big.txt', 50);
    const r = await runGateSpecCheck({ reaRoot: root });
    expect(r.exitCode).toBe(0);
  });

  it('over threshold + spec is a committed DIRECTORY → enforce blocks (round-10 P2)', async () => {
    initRepo(root);
    // Commit a directory (not a spec document). Both existsSync('docs')
    // and `git cat-file -e HEAD:docs` (a tree) succeed — the gate must
    // still reject it as not a file.
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', '.keep'), 'x');
    git(root, ['add', 'docs/.keep']);
    git(root, ['commit', '-q', '-m', 'add docs dir']);
    writePolicy(root, { mode: 'enforce', diffLines: 10, diffFiles: 2 });
    writeTasks(root, [{ spec: 'docs', requires_spec: true }]);
    stageBigChange(root, 'big.txt', 50);
    const r = await runGateSpecCheck({ reaRoot: root });
    expect(r.exitCode).toBe(2);
  });

  it('over threshold + spec on disk but NOT committed → enforce blocks (exit 2)', async () => {
    initRepo(root);
    // Spec exists on disk but is never committed at HEAD.
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# spec\n');
    writePolicy(root, { mode: 'enforce', diffLines: 10, diffFiles: 2 });
    writeTasks(root, [{ spec: 'docs/spec.md' }]);
    stageBigChange(root, 'big.txt', 50);
    const r = await runGateSpecCheck({ reaRoot: root });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('not committed');
  });

  it('requires_spec forces the trigger even below threshold (no spec → enforce blocks)', async () => {
    initRepo(root);
    writePolicy(root, { mode: 'enforce', diffLines: 10, diffFiles: 2 });
    writeTasks(root, [{ requires_spec: true }]); // active, no spec
    stageBigChange(root, 'small.txt', 1); // below threshold
    const r = await runGateSpecCheck({ reaRoot: root });
    expect(r.exitCode).toBe(2);
  });

  it('git unavailable → uncertain: enforce refuses (exit 2)', async () => {
    // No git repo needed — inject a failing runner.
    writePolicy(root, { mode: 'enforce' });
    const r = await runGateSpecCheck({ reaRoot: root, gitRunner: failingGit });
    expect(r.exitCode).toBe(2);
    expect(auditContains(root, G1_TOOL_NAME)).toBe(true);
  });

  it('git unavailable → uncertain: shadow logs + allows (exit 0)', async () => {
    writePolicy(root, { mode: 'shadow' });
    const r = await runGateSpecCheck({ reaRoot: root, gitRunner: failingGit });
    expect(r.exitCode).toBe(0);
    expect(auditContains(root, G1_SHADOW_TOOL_NAME)).toBe(true);
  });

  it('missing policy → off (exit 0)', async () => {
    const r = await runGateSpecCheck({ reaRoot: root, gitRunner: failingGit });
    expect(r.exitCode).toBe(0);
  });

  // Round-18 F1 — HALT binds BEFORE the mode short-circuit. A frozen repo
  // blocks the commit regardless of gate mode, including the DEFAULT `off`.
  it('HALT → exit 2 (BEFORE the off short-circuit), enforce mode', async () => {
    writePolicy(root, { mode: 'enforce' });
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen\n');
    const r = await runGateSpecCheck({ reaRoot: root, gitRunner: failingGit });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('REA HALT');
  });

  it('mode off (DEFAULT) + HALT present → exit 2 (freeze is not conditional on opt-in)', async () => {
    writePolicy(root, { mode: 'off' });
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen while off\n');
    const r = await runGateSpecCheck({ reaRoot: root, gitRunner: failingGit });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('REA HALT');
  });

  it('mode off + NO HALT → silent exit 0 (freeze absent = proceed)', async () => {
    writePolicy(root, { mode: 'off' });
    const r = await runGateSpecCheck({ reaRoot: root, gitRunner: failingGit });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('absent artifact_gates block + HALT → exit 2 (default-off still freezes)', async () => {
    writePolicy(root, { mode: 'absent' });
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen\n');
    const r = await runGateSpecCheck({ reaRoot: root, gitRunner: failingGit });
    expect(r.exitCode).toBe(2);
  });

  it('common-root HALT (worktree) freezes a local commit even at mode off', async () => {
    // Real linked worktree: local = worktree, common = primary checkout.
    initRepo(root);
    const wt = `${root}-wt`;
    git(root, ['worktree', 'add', '-q', wt, '-b', 'wt-halt-branch']);
    try {
      // HALT lives on the COMMON (primary) root; the worktree has NO policy
      // (→ mode off) and NO local HALT.
      fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen by primary\n');
      const r = await runGateSpecCheck({ reaRoot: wt });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('REA HALT');
    } finally {
      rm(wt);
    }
  });
});
