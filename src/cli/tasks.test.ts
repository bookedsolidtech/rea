/**
 * Tests for the `rea tasks` command surface (the `run*` helpers, not the
 * commander wiring). Each helper takes an explicit `baseDir` and returns an
 * exit code, so we drive them against `fs.mkdtempSync` temp dirs and assert on
 * captured stdout / console output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runTasksAdd,
  runTasksStart,
  runTasksActivate,
  runTasksEvidence,
  runTasksSpec,
  runTasksComplete,
  runTasksList,
  runTasksShow,
} from './tasks.js';
import { readTasks, activeTask, updateTasks } from '../tasks/store.js';

let baseDir: string;
let out: string[];
let logs: string[];
let errs: string[];

beforeEach(() => {
  baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-tasks-cli-')));
  out = [];
  logs = [];
  errs = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('happy path: add → start → activate → evidence → complete', () => {
  it('walks a task through its full lifecycle', () => {
    expect(runTasksAdd(baseDir, { subject: 'first task' })).toBe(0);
    let tasks = readTasks(baseDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('T-0001');
    expect(tasks[0]?.status).toBe('pending');

    expect(runTasksStart(baseDir, 'T-0001')).toBe(0);
    expect(readTasks(baseDir)[0]?.status).toBe('in_progress');

    expect(runTasksActivate(baseDir, 'T-0001')).toBe(0);
    expect(activeTask(readTasks(baseDir))?.id).toBe('T-0001');

    expect(runTasksEvidence(baseDir, 'T-0001', { add: ['docs/proof.md'] })).toBe(0);
    expect(readTasks(baseDir)[0]?.evidence).toEqual(['docs/proof.md']);

    expect(runTasksComplete(baseDir, 'T-0001')).toBe(0);
    tasks = readTasks(baseDir);
    expect(tasks[0]?.status).toBe('completed');
    expect(tasks[0]?.active).toBe(false);
  });
});

describe('add options', () => {
  it('records optional fields via conditional spreads', () => {
    runTasksAdd(baseDir, {
      subject: 'spec task',
      description: 'needs a spec',
      requiresSpec: true,
      spec: 'specs/x.md',
      blockedBy: ['T-0000'],
    });
    const t = readTasks(baseDir)[0];
    expect(t?.description).toBe('needs a spec');
    expect(t?.requires_spec).toBe(true);
    expect(t?.spec).toBe('specs/x.md');
    expect(t?.blocked_by).toEqual(['T-0000']);
  });

  it('assigns monotonic ids', () => {
    runTasksAdd(baseDir, { subject: 'a' });
    runTasksAdd(baseDir, { subject: 'b' });
    expect(readTasks(baseDir).map((t) => t.id)).toEqual(['T-0001', 'T-0002']);
  });

  it('rejects a blank --subject with a clean refusal, not a zod throw (round-27 P3)', () => {
    expect(runTasksAdd(baseDir, { subject: '' })).toBe(1);
    expect(runTasksAdd(baseDir, { subject: '   ' })).toBe(1);
    expect(errs.join('\n')).toMatch(/subject/i);
    expect(readTasks(baseDir)).toHaveLength(0);
  });
});

describe('complete refuses without evidence', () => {
  it('exits non-zero and leaves the task unchanged', () => {
    runTasksAdd(baseDir, { subject: 'no evidence' });
    const code = runTasksComplete(baseDir, 'T-0001');
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/no evidence/i);
    expect(readTasks(baseDir)[0]?.status).toBe('pending');
  });

  it('rejects BLANK evidence — `--add ""` is not usable evidence (round-10 P2)', () => {
    runTasksAdd(baseDir, { subject: 'blank' });
    // A blank/whitespace --add is rejected outright.
    expect(runTasksEvidence(baseDir, 'T-0001', { add: ['', '   '] })).toBe(1);
    // And complete still refuses because no usable evidence was recorded.
    expect(runTasksComplete(baseDir, 'T-0001')).toBe(1);
    expect(readTasks(baseDir)[0]?.status).toBe('pending');
  });

  it('refuses to re-complete an already-terminal task (round-31 P2)', () => {
    runTasksAdd(baseDir, { subject: 'done' });
    runTasksEvidence(baseDir, 'T-0001', { add: ['docs/proof.md'] });
    expect(runTasksComplete(baseDir, 'T-0001')).toBe(0);
    const firstUpdatedAt = readTasks(baseDir)[0]?.updated_at;
    // Completing again must refuse — not append another completed row / bump ts.
    expect(runTasksComplete(baseDir, 'T-0001')).toBe(1);
    expect(errs.join('\n')).toMatch(/already completed/i);
    expect(readTasks(baseDir)[0]?.updated_at).toBe(firstUpdatedAt);
  });
});

describe('activate flips others inactive', () => {
  it('leaves exactly one active task', () => {
    runTasksAdd(baseDir, { subject: 'a' });
    runTasksAdd(baseDir, { subject: 'b' });
    runTasksActivate(baseDir, 'T-0001');
    runTasksActivate(baseDir, 'T-0002');
    const tasks = readTasks(baseDir);
    const activeIds = tasks.filter((t) => t.active).map((t) => t.id);
    expect(activeIds).toEqual(['T-0002']);
    expect(activeTask(tasks)?.id).toBe('T-0002');
  });
});

describe('start refuses terminal tasks (round-20 P2)', () => {
  it('a completed task cannot be reopened via start', () => {
    runTasksAdd(baseDir, { subject: 'done' });
    runTasksEvidence(baseDir, 'T-0001', { add: ['docs/proof.md'] });
    expect(runTasksComplete(baseDir, 'T-0001')).toBe(0);
    expect(runTasksStart(baseDir, 'T-0001')).toBe(1);
    expect(errs.join('\n')).toMatch(/completed/i);
    expect(readTasks(baseDir)[0]?.status).toBe('completed');
  });
});

describe('activate refuses terminal tasks (round-16 P2)', () => {
  it('a completed task cannot be re-activated (no contradictory active:true row)', () => {
    runTasksAdd(baseDir, { subject: 'done' });
    runTasksEvidence(baseDir, 'T-0001', { add: ['docs/proof.md'] });
    expect(runTasksComplete(baseDir, 'T-0001')).toBe(0);
    // Activating a completed task must refuse, not append active:true.
    expect(runTasksActivate(baseDir, 'T-0001')).toBe(1);
    expect(errs.join('\n')).toMatch(/completed/i);
    const tasks = readTasks(baseDir);
    expect(tasks[0]?.status).toBe('completed');
    expect(tasks[0]?.active).toBe(false);
    expect(activeTask(tasks)).toBeFalsy();
  });
});

describe('evidence refuses terminal tasks (round-48 P2)', () => {
  it('a completed task cannot accept late evidence (no append, no updated_at bump)', () => {
    runTasksAdd(baseDir, { subject: 'done' });
    runTasksEvidence(baseDir, 'T-0001', { add: ['docs/proof.md'] });
    expect(runTasksComplete(baseDir, 'T-0001')).toBe(0);
    const before = readTasks(baseDir)[0];
    const evidenceBefore = before?.evidence;
    const updatedAtBefore = before?.updated_at;
    // Late evidence on a completed task must refuse — not append or bump ts.
    expect(runTasksEvidence(baseDir, 'T-0001', { add: ['docs/late.md'] })).toBe(1);
    expect(errs.join('\n')).toMatch(/completed/i);
    const after = readTasks(baseDir)[0];
    expect(after?.evidence).toEqual(evidenceBefore);
    expect(after?.updated_at).toBe(updatedAtBefore);
  });

  it('a cancelled task cannot accept evidence (no append, no updated_at bump)', () => {
    runTasksAdd(baseDir, { subject: 'to cancel' });
    // No cancel command on this surface — append a terminal cancelled row
    // directly through the store to set up the terminal state.
    updateTasks(baseDir, (tasks) => {
      const t = tasks.find((x) => x.id === 'T-0001');
      if (t === undefined) return [];
      return [{ ...t, status: 'cancelled', active: false, updated_at: new Date().toISOString() }];
    });
    const before = readTasks(baseDir)[0];
    const evidenceBefore = before?.evidence;
    const updatedAtBefore = before?.updated_at;
    expect(runTasksEvidence(baseDir, 'T-0001', { add: ['docs/x.md'] })).toBe(1);
    expect(errs.join('\n')).toMatch(/cancelled/i);
    const after = readTasks(baseDir)[0];
    expect(after?.evidence).toEqual(evidenceBefore);
    expect(after?.updated_at).toBe(updatedAtBefore);
  });

  it('still appends evidence to a pending/in_progress task', () => {
    runTasksAdd(baseDir, { subject: 'live' });
    expect(runTasksEvidence(baseDir, 'T-0001', { add: ['docs/a.md'] })).toBe(0);
    runTasksStart(baseDir, 'T-0001');
    expect(runTasksEvidence(baseDir, 'T-0001', { add: ['docs/b.md'] })).toBe(0);
    expect(readTasks(baseDir)[0]?.evidence).toEqual(['docs/a.md', 'docs/b.md']);
  });
});

describe('not-found handling', () => {
  it('returns 1 for start/activate/evidence/spec/complete/show on a missing id', () => {
    expect(runTasksStart(baseDir, 'T-9999')).toBe(1);
    expect(runTasksActivate(baseDir, 'T-9999')).toBe(1);
    expect(runTasksEvidence(baseDir, 'T-9999', { add: ['x'] })).toBe(1);
    expect(runTasksSpec(baseDir, 'T-9999', { set: 'specs/x.md' })).toBe(1);
    expect(runTasksComplete(baseDir, 'T-9999')).toBe(1);
    expect(runTasksShow(baseDir, 'T-9999')).toBe(1);
  });
});

describe('spec mutator (round-49 P2)', () => {
  it('sets the spec path on a pending task and bumps updated_at', () => {
    runTasksAdd(baseDir, { subject: 'needs a spec' });
    const before = readTasks(baseDir)[0];
    expect(before?.spec).toBeUndefined();
    expect(runTasksSpec(baseDir, 'T-0001', { set: 'specs/plan.md' })).toBe(0);
    const after = readTasks(baseDir)[0];
    expect(after?.spec).toBe('specs/plan.md');
    expect(after?.updated_at).not.toBe(before?.updated_at);
    expect(after?.status).toBe('pending');
  });

  it('sets requires_spec true then false', () => {
    runTasksAdd(baseDir, { subject: 'flag toggling' });
    expect(runTasksSpec(baseDir, 'T-0001', { requiresSpec: true })).toBe(0);
    expect(readTasks(baseDir)[0]?.requires_spec).toBe(true);
    expect(runTasksSpec(baseDir, 'T-0001', { requiresSpec: false })).toBe(0);
    expect(readTasks(baseDir)[0]?.requires_spec).toBe(false);
  });

  it('sets a spec on an in_progress task', () => {
    runTasksAdd(baseDir, { subject: 'live' });
    runTasksStart(baseDir, 'T-0001');
    expect(runTasksSpec(baseDir, 'T-0001', { set: 'specs/live.md' })).toBe(0);
    const t = readTasks(baseDir)[0];
    expect(t?.status).toBe('in_progress');
    expect(t?.spec).toBe('specs/live.md');
  });

  it('sets both --set and requires_spec in a single call', () => {
    runTasksAdd(baseDir, { subject: 'both' });
    expect(runTasksSpec(baseDir, 'T-0001', { set: 'specs/both.md', requiresSpec: true })).toBe(0);
    const t = readTasks(baseDir)[0];
    expect(t?.spec).toBe('specs/both.md');
    expect(t?.requires_spec).toBe(true);
  });

  it('errors when no mutation flag is given (record unchanged)', () => {
    runTasksAdd(baseDir, { subject: 'no flags' });
    const before = readTasks(baseDir)[0];
    expect(runTasksSpec(baseDir, 'T-0001', {})).toBe(1);
    expect(errs.join('\n')).toMatch(/at least one of/i);
    const after = readTasks(baseDir)[0];
    expect(after?.spec).toBeUndefined();
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it('rejects a blank --set path', () => {
    runTasksAdd(baseDir, { subject: 'blank spec' });
    expect(runTasksSpec(baseDir, 'T-0001', { set: '   ' })).toBe(1);
    expect(errs.join('\n')).toMatch(/non-blank/i);
    expect(readTasks(baseDir)[0]?.spec).toBeUndefined();
  });

  it('refuses a completed task (no write, record unchanged)', () => {
    runTasksAdd(baseDir, { subject: 'done' });
    runTasksEvidence(baseDir, 'T-0001', { add: ['docs/proof.md'] });
    expect(runTasksComplete(baseDir, 'T-0001')).toBe(0);
    const before = readTasks(baseDir)[0];
    expect(runTasksSpec(baseDir, 'T-0001', { set: 'specs/x.md' })).toBe(1);
    expect(errs.join('\n')).toMatch(/completed/i);
    const after = readTasks(baseDir)[0];
    expect(after?.spec).toBeUndefined();
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it('refuses a cancelled task (no write, record unchanged)', () => {
    runTasksAdd(baseDir, { subject: 'to cancel' });
    updateTasks(baseDir, (tasks) => {
      const t = tasks.find((x) => x.id === 'T-0001');
      if (t === undefined) return [];
      return [{ ...t, status: 'cancelled', active: false, updated_at: new Date().toISOString() }];
    });
    const before = readTasks(baseDir)[0];
    expect(runTasksSpec(baseDir, 'T-0001', { requiresSpec: true })).toBe(1);
    expect(errs.join('\n')).toMatch(/cancelled/i);
    const after = readTasks(baseDir)[0];
    expect(after?.requires_spec).toBe(before?.requires_spec);
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it('--json emits the updated record', () => {
    runTasksAdd(baseDir, { subject: 'json out' });
    out.length = 0;
    expect(runTasksSpec(baseDir, 'T-0001', { set: 'specs/j.md', json: true })).toBe(0);
    const parsed = JSON.parse(out.join('')) as { id: string; spec: string };
    expect(parsed.id).toBe('T-0001');
    expect(parsed.spec).toBe('specs/j.md');
  });
});

describe('list / show output shapes', () => {
  it('list --json emits the folded task array', () => {
    runTasksAdd(baseDir, { subject: 'a' });
    runTasksAdd(baseDir, { subject: 'b' });
    out.length = 0;
    expect(runTasksList(baseDir, { json: true })).toBe(0);
    const parsed = JSON.parse(out.join('')) as Array<{ id: string; subject: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed.map((t) => t.id)).toEqual(['T-0001', 'T-0002']);
  });

  it('list (human) marks the active task with *', () => {
    runTasksAdd(baseDir, { subject: 'a' });
    runTasksAdd(baseDir, { subject: 'b' });
    runTasksActivate(baseDir, 'T-0002');
    logs.length = 0;
    runTasksList(baseDir, {});
    const joined = logs.join('\n');
    expect(joined).toMatch(/\*\s+T-0002/);
    expect(joined).toMatch(/T-0001/);
  });

  it('show --json emits the single record', () => {
    runTasksAdd(baseDir, { subject: 'only' });
    out.length = 0;
    expect(runTasksShow(baseDir, 'T-0001', { json: true })).toBe(0);
    const parsed = JSON.parse(out.join('')) as { id: string; subject: string; status: string };
    expect(parsed.id).toBe('T-0001');
    expect(parsed.subject).toBe('only');
    expect(parsed.status).toBe('pending');
  });

  it('list reports empty store', () => {
    expect(runTasksList(baseDir, {})).toBe(0);
    expect(logs.join('\n')).toMatch(/No tasks/);
  });
});
