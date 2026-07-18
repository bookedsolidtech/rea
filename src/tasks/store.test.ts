/**
 * Unit tests for the `.rea/tasks.jsonl` append-only store. Drives the store
 * against `fs.mkdtempSync` temp dirs with an explicit `baseDir` — no reliance
 * on `process.cwd()`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTasks, appendTask, activeTask, nextTaskId } from './store.js';
import type { TaskRecord } from './types.js';

let baseDir: string;

beforeEach(() => {
  baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-tasks-')));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function make(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  const now = '2026-07-17T00:00:00.000Z';
  return {
    id,
    subject: `subject ${id}`,
    status: 'pending',
    active: false,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function tasksFile(): string {
  return path.join(baseDir, '.rea', 'tasks.jsonl');
}

describe('readTasks', () => {
  it('returns [] when the file is missing', () => {
    expect(readTasks(baseDir)).toEqual([]);
  });

  it('reads back appended records and creates .rea/ on first write', () => {
    appendTask(baseDir, make('T-0001'));
    appendTask(baseDir, make('T-0002'));
    const tasks = readTasks(baseDir);
    expect(tasks.map((t) => t.id)).toEqual(['T-0001', 'T-0002']);
    expect(fs.existsSync(tasksFile())).toBe(true);
  });

  it('folds to the latest record per id (last write wins)', () => {
    appendTask(baseDir, make('T-0001', { status: 'pending' }));
    appendTask(baseDir, make('T-0001', { status: 'in_progress' }));
    appendTask(baseDir, make('T-0001', { status: 'completed', evidence: ['a.txt'] }));
    const tasks = readTasks(baseDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('completed');
    expect(tasks[0]?.evidence).toEqual(['a.txt']);
  });

  it('preserves first-seen order per id across updates', () => {
    appendTask(baseDir, make('T-0001'));
    appendTask(baseDir, make('T-0002'));
    appendTask(baseDir, make('T-0001', { status: 'in_progress' }));
    expect(readTasks(baseDir).map((t) => t.id)).toEqual(['T-0001', 'T-0002']);
  });

  it('skips malformed lines tolerantly (bad JSON and shape violations)', () => {
    fs.mkdirSync(path.join(baseDir, '.rea'), { recursive: true });
    const good = JSON.stringify(make('T-0001'));
    const badShape = JSON.stringify({ id: 'T-0002', subject: '', status: 'nope' });
    const notJson = '{ this is not json';
    fs.writeFileSync(tasksFile(), `${good}\n${notJson}\n${badShape}\n\n`);
    const tasks = readTasks(baseDir);
    expect(tasks.map((t) => t.id)).toEqual(['T-0001']);
  });

  it('skips a partial (unterminated) trailing line', () => {
    fs.mkdirSync(path.join(baseDir, '.rea'), { recursive: true });
    const good = JSON.stringify(make('T-0001'));
    const partial = JSON.stringify(make('T-0002')).slice(0, 20);
    fs.writeFileSync(tasksFile(), `${good}\n${partial}`);
    expect(readTasks(baseDir).map((t) => t.id)).toEqual(['T-0001']);
  });
});

describe('appendTask', () => {
  it('throws on a schema-invalid record (bad id shape)', () => {
    expect(() => appendTask(baseDir, make('bad-id'))).toThrow();
  });
});

describe('activeTask', () => {
  it('returns null when nothing is active', () => {
    expect(activeTask([make('T-0001'), make('T-0002')])).toBeNull();
  });

  it('returns the single active, non-completed task', () => {
    const tasks = [
      make('T-0001', { active: false }),
      make('T-0002', { active: true, status: 'in_progress' }),
    ];
    expect(activeTask(tasks)?.id).toBe('T-0002');
  });

  it('ignores an active task that is completed', () => {
    const tasks = [make('T-0001', { active: true, status: 'completed', evidence: ['e'] })];
    expect(activeTask(tasks)).toBeNull();
  });
});

describe('nextTaskId', () => {
  it('yields T-0001 for an empty store', () => {
    expect(nextTaskId([])).toBe('T-0001');
  });

  it('yields one past the highest numeric suffix', () => {
    expect(nextTaskId([make('T-0001'), make('T-0007'), make('T-0003')])).toBe('T-0008');
  });

  it('keeps at least 4 digits but grows beyond', () => {
    expect(nextTaskId([make('T-9999')])).toBe('T-10000');
  });
});
