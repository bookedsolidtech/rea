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
  runTasksComplete,
  runTasksList,
  runTasksShow,
} from './tasks.js';
import { readTasks, activeTask } from '../tasks/store.js';

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

describe('not-found handling', () => {
  it('returns 1 for start/activate/evidence/complete/show on a missing id', () => {
    expect(runTasksStart(baseDir, 'T-9999')).toBe(1);
    expect(runTasksActivate(baseDir, 'T-9999')).toBe(1);
    expect(runTasksEvidence(baseDir, 'T-9999', { add: ['x'] })).toBe(1);
    expect(runTasksComplete(baseDir, 'T-9999')).toBe(1);
    expect(runTasksShow(baseDir, 'T-9999')).toBe(1);
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
