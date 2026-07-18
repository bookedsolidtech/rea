/**
 * Append-only JSONL task store — modeled on the audit store (`src/audit/`).
 *
 * ## Shape
 *
 * `.rea/tasks.jsonl` holds one JSON `TaskRecord` per line. Mutations NEVER
 * rewrite a line; they APPEND a fresh full record with the same `id`. The
 * reader (`readTasks`) folds to the latest record per `id` — last write wins.
 * This mirrors the audit log's append-only discipline and keeps writes cheap
 * and crash-safe (a partial trailing line is simply skipped on the next read).
 *
 * ## Locking
 *
 * Every append takes a `proper-lockfile` lock on the `.rea/` directory (NOT on
 * `tasks.jsonl` directly — the file may not exist on first write), matching
 * the audit store's `withAuditLock` discipline. The sync `lockSync` variant is
 * used because the store's public surface is synchronous (the two consuming
 * features need a stable, simple, sync interface). A bounded retry with a real
 * synchronous sleep (`Atomics.wait`) absorbs the low contention a task store
 * sees without a CPU-burning spin.
 *
 * ## Test seam
 *
 * Every function takes an explicit `baseDir` (the directory that CONTAINS
 * `.rea/`). No reliance on `process.cwd()`, so unit tests drive the store
 * against `fs.mkdtempSync` temp dirs — same discipline as the rest of the repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import properLockfile from 'proper-lockfile';
import { TaskRecordSchema } from './schema.js';
import type { TaskRecord } from './types.js';

const REA_DIR = '.rea';
const TASKS_FILE = 'tasks.jsonl';

/** Lock envelope mirroring the audit store: stale reclaim at 10s, lock the
 *  parent dir (`realpath: false` so a not-yet-created file is fine). */
const LOCK_OPTIONS: Parameters<typeof properLockfile.lockSync>[1] = {
  stale: 10_000,
  realpath: false,
};

function tasksPath(baseDir: string): string {
  return path.join(baseDir, REA_DIR, TASKS_FILE);
}

/** Synchronous sleep without a CPU-burning spin — parks the thread for `ms`. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the `.rea/` directory lock synchronously, retrying briefly if
 * another writer holds it. `proper-lockfile` surfaces a held lock as an error
 * with `code: 'ELOCKED'`; any other error propagates immediately.
 */
function acquireLock(lockTarget: string): () => void {
  const maxAttempts = 40;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return properLockfile.lockSync(lockTarget, LOCK_OPTIONS);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const held = code === 'ELOCKED' || /lock/i.test((e as Error).message ?? '');
      if (!held || attempt === maxAttempts - 1) throw e;
      sleepSync(20);
    }
  }
  // Unreachable — the loop either returns a release fn or throws.
  throw new Error(`tasks: could not acquire lock on ${lockTarget}`);
}

/** Best-effort fsync of the tasks file after an append (durability, non-fatal). */
function fsyncFile(file: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    fs.fsyncSync(fd);
  } catch {
    // fsync failure is not fatal — the append itself already succeeded.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignored */
      }
    }
  }
}

/**
 * Read `<baseDir>/.rea/tasks.jsonl`, parse each line, and fold to the latest
 * record per `id` (last write wins). Malformed lines (bad JSON or records that
 * fail schema validation) are skipped tolerantly — a single corrupt append
 * never poisons the whole store. A missing file yields `[]`.
 *
 * Iteration order of the result follows FIRST-seen order per id (a task keeps
 * its creation position even as later mutations update it), which gives stable
 * `rea tasks list` output.
 */
export function readTasks(baseDir: string): TaskRecord[] {
  const file = tasksPath(baseDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const byId = new Map<string, TaskRecord>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // malformed JSON — skip tolerantly (matches audit reader)
    }
    const result = TaskRecordSchema.safeParse(parsed);
    if (!result.success) continue; // shape violation — skip tolerantly
    // zod omits absent optionals, so the parsed object is exactOptional-clean;
    // the cast only bridges zod's `T | undefined` optional inference.
    byId.set(result.data.id, result.data as TaskRecord);
  }
  return [...byId.values()];
}

/**
 * Atomically append one validated task record as a `\n`-terminated JSONL line.
 * Creates `.rea/` if absent. The write is serialized cross-process via a
 * `proper-lockfile` lock on `.rea/`, then fsynced. Throws if `record` fails
 * schema validation (a malformed OWN write is a programming error, not a
 * tolerable read-side corruption).
 */
export function appendTask(baseDir: string, record: TaskRecord): void {
  // Validate our own write up front — fail loud on a malformed record.
  TaskRecordSchema.parse(record);

  const reaDir = path.join(baseDir, REA_DIR);
  fs.mkdirSync(reaDir, { recursive: true });
  const file = tasksPath(baseDir);
  const line = JSON.stringify(record) + '\n';

  const release = acquireLock(reaDir);
  try {
    fs.appendFileSync(file, line);
    fsyncFile(file);
  } finally {
    try {
      release();
    } catch {
      // Releasing a reclaimed/stale lock can fail; the append already landed.
    }
  }
}

/**
 * Resolve the single active, non-completed task from a folded task list, or
 * `null`. Enforces the read side of the "at most one active non-completed
 * task per project" invariant — if the store somehow holds more than one, the
 * first in iteration order wins.
 */
export function activeTask(tasks: TaskRecord[]): TaskRecord | null {
  for (const t of tasks) {
    if (t.active && t.status !== 'completed') return t;
  }
  return null;
}

/**
 * Compute the next monotonic task id (`T-000N`) from a folded task list. The
 * suffix is one greater than the highest existing numeric suffix, zero-padded
 * to at least 4 digits. An empty store yields `T-0001`.
 */
export function nextTaskId(tasks: TaskRecord[]): string {
  let max = 0;
  for (const t of tasks) {
    const m = /^T-(\d+)$/.exec(t.id);
    if (m && m[1] !== undefined) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return `T-${String(max + 1).padStart(4, '0')}`;
}
