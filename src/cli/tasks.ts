/**
 * `rea tasks` — CRUD surface over the `.rea/tasks.jsonl` append-only task
 * store (`src/tasks/`). Every mutation appends a FULL updated record; the
 * reader folds to the latest per id. The store is the shared keystone for the
 * Artifact Gates and `rea dash` features, so this command is a thin, stable
 * shell over `src/tasks/store.ts` — all invariants live in the store + schema.
 *
 * Subcommands:
 *   - `add`      create a pending task
 *   - `start`    → in_progress
 *   - `activate` set active:true, flip all others active:false
 *   - `evidence` append evidence paths
 *   - `complete` → completed (REFUSES when evidence is empty — the G2
 *                  verification invariant at the CLI tier)
 *   - `list` / `show` read views (`--json` for machine output)
 *
 * The `run*` functions take an explicit `baseDir` and return a process exit
 * code (0 = ok, non-zero = refuse/not-found) so they are unit-testable without
 * driving commander or touching `process.cwd()`.
 */

import type { Command } from 'commander';
import { readTasks, updateTasks, activeTask, nextTaskId } from '../tasks/store.js';
import { resolveLocalRoot } from '../lib/worktree-roots.js';
import type { TaskRecord } from '../tasks/types.js';
import { err, log } from './utils.js';

function nowIso(): string {
  return new Date().toISOString();
}

function findTask(tasks: TaskRecord[], id: string): TaskRecord | undefined {
  return tasks.find((t) => t.id === id);
}

/** Strip ASCII control codes before a disk-sourced field reaches the terminal. */
function clean(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, '?');
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function emit(record: TaskRecord, json: boolean | undefined, human: string): void {
  if (json === true) {
    printJson(record);
  } else {
    log(human);
  }
}

export interface TasksAddOptions {
  subject: string;
  description?: string;
  requiresSpec?: boolean;
  spec?: string;
  blockedBy?: string[];
  json?: boolean;
}

export function runTasksAdd(baseDir: string, opts: TasksAddOptions): number {
  // Round-27 P3: Commander accepts `--subject ""`, but TaskRecordSchema
  // requires a non-empty subject — forwarding a blank straight in throws an
  // uncaught zod error instead of a normal CLI refusal like the other
  // mutations. Reject it up front.
  if (opts.subject.trim().length === 0) {
    err('Task subject must not be empty.');
    return 1;
  }
  let record!: TaskRecord;
  updateTasks(baseDir, (tasks) => {
    const now = nowIso();
    record = {
      id: nextTaskId(tasks),
      subject: opts.subject,
      status: 'pending',
      active: false,
      created_at: now,
      updated_at: now,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.requiresSpec === true ? { requires_spec: true } : {}),
      ...(opts.spec !== undefined ? { spec: opts.spec } : {}),
      ...(opts.blockedBy && opts.blockedBy.length > 0 ? { blocked_by: opts.blockedBy } : {}),
    };
    return [record];
  });
  emit(record, opts.json, `Added ${record.id}: ${clean(record.subject)}`);
  return 0;
}

export interface TasksIdOptions {
  json?: boolean;
}

export function runTasksStart(baseDir: string, id: string, opts: TasksIdOptions = {}): number {
  let updated: TaskRecord | undefined;
  let terminal: string | undefined;
  updateTasks(baseDir, (tasks) => {
    const t = findTask(tasks, id);
    if (t === undefined) return [];
    // Round-20 P2: `completed`/`cancelled` are terminal — refuse reopening
    // them, matching runTasksActivate. Otherwise `complete && start` would
    // reopen closed work into in_progress and break the lifecycle invariant
    // the tracker, G1, and rea dash rely on.
    if (t.status === 'completed' || t.status === 'cancelled') {
      terminal = t.status;
      return [];
    }
    updated = { ...t, status: 'in_progress', updated_at: nowIso() };
    return [updated];
  });
  if (terminal !== undefined) {
    err(`Cannot start ${clean(id)}: task is ${terminal}. Terminal tasks cannot be reopened.`);
    return 1;
  }
  if (updated === undefined) {
    err(`No such task: ${clean(id)}`);
    return 1;
  }
  emit(updated, opts.json, `Started ${id} (in_progress)`);
  return 0;
}

export function runTasksActivate(baseDir: string, id: string, opts: TasksIdOptions = {}): number {
  let updated: TaskRecord | undefined;
  let terminal: string | undefined;
  updateTasks(baseDir, (tasks) => {
    const t = findTask(tasks, id);
    if (t === undefined) return [];
    // Round-16 P2: refuse activating a terminal task. Appending
    // `active: true` to a completed/cancelled record produces a
    // contradictory row that `activeTask()` ignores — the command would
    // report "Activated" while `tasks list` shows no active task and G1
    // sees no active ticket. Leave the store untouched and error instead.
    if (t.status === 'completed' || t.status === 'cancelled') {
      terminal = t.status;
      return [];
    }
    const now = nowIso();
    // Flip every OTHER currently-active task off, then activate this one —
    // all appended atomically under one lock.
    const out: TaskRecord[] = [];
    for (const other of tasks) {
      if (other.id !== id && other.active) {
        out.push({ ...other, active: false, updated_at: now });
      }
    }
    updated = { ...t, active: true, updated_at: now };
    out.push(updated);
    return out;
  });
  if (terminal !== undefined) {
    err(`Cannot activate ${clean(id)}: task is ${terminal}. Only pending/in_progress tasks can be activated.`);
    return 1;
  }
  if (updated === undefined) {
    err(`No such task: ${clean(id)}`);
    return 1;
  }
  emit(updated, opts.json, `Activated ${id}`);
  return 0;
}

export interface TasksEvidenceOptions {
  add: string[];
  json?: boolean;
}

export function runTasksEvidence(baseDir: string, id: string, opts: TasksEvidenceOptions): number {
  // Round-10 P2: reject blank/whitespace evidence entries — `--add ''`
  // is not a usable artifact path and must not satisfy the G2 invariant.
  const additions = opts.add.filter((e) => e.trim().length > 0);
  if (additions.length === 0) {
    err('evidence requires at least one non-blank --add <path>');
    return 1;
  }
  let updated: TaskRecord | undefined;
  let merged: string[] = [];
  let terminal: string | undefined;
  updateTasks(baseDir, (tasks) => {
    const t = findTask(tasks, id);
    if (t === undefined) return [];
    // Round-48 P2: `completed`/`cancelled` are terminal and immutable, like
    // start/activate/complete already treat them. Appending evidence to a
    // terminal task both violates terminal-immutability and bumps updated_at,
    // which re-surfaces finished work in `rea dash`'s recency-keyed review
    // bucket. Decide inside the locked transform (no TOCTOU) and return []
    // to abort the write.
    if (t.status === 'completed' || t.status === 'cancelled') {
      terminal = t.status;
      return [];
    }
    merged = [...(t.evidence ?? []), ...additions];
    updated = { ...t, evidence: merged, updated_at: nowIso() };
    return [updated];
  });
  if (terminal !== undefined) {
    err(`Cannot add evidence to ${clean(id)}: task is ${terminal}. Evidence can only be added to pending/in_progress tasks.`);
    return 1;
  }
  if (updated === undefined) {
    err(`No such task: ${clean(id)}`);
    return 1;
  }
  emit(updated, opts.json, `Evidence added to ${id} (${merged.length} total)`);
  return 0;
}

export function runTasksComplete(baseDir: string, id: string, opts: TasksIdOptions = {}): number {
  let updated: TaskRecord | undefined;
  let outcome: 'ok' | 'not-found' | 'no-evidence' | 'terminal' = 'not-found';
  let terminalStatus: string | undefined;
  updateTasks(baseDir, (tasks) => {
    const t = findTask(tasks, id);
    if (t === undefined) {
      outcome = 'not-found';
      return [];
    }
    // Round-31 P2: `completed`/`cancelled` are terminal and immutable, like
    // start/activate already treat them. Re-completing a completed task would
    // bump updated_at and keep it alive in dash's 7-day review queue; completing
    // a CANCELLED task would silently rewrite its terminal state. Refuse both.
    if (t.status === 'completed' || t.status === 'cancelled') {
      outcome = 'terminal';
      terminalStatus = t.status;
      return [];
    }
    // G2 verification invariant at the CLI tier: a task cannot be
    // completed without USABLE (non-blank) recorded evidence — checked
    // against the LOCKED snapshot so a concurrent evidence add is
    // honored. Round-10 P2: a blank/whitespace entry is not evidence.
    if (!(t.evidence ?? []).some((e) => e.trim().length > 0)) {
      outcome = 'no-evidence';
      return [];
    }
    outcome = 'ok';
    updated = { ...t, status: 'completed', active: false, updated_at: nowIso() };
    return [updated];
  });
  if (outcome === 'not-found') {
    err(`No such task: ${clean(id)}`);
    return 1;
  }
  if (outcome === 'terminal') {
    err(`Cannot complete ${clean(id)}: task is already ${terminalStatus}. Terminal tasks are immutable.`);
    return 1;
  }
  if (outcome === 'no-evidence') {
    err(
      `Cannot complete ${id}: no evidence recorded. ` +
        `Add evidence first: rea tasks evidence ${id} --add <path>`,
    );
    return 1;
  }
  emit(updated as TaskRecord, opts.json, `Completed ${id}`);
  return 0;
}

export function runTasksList(baseDir: string, opts: TasksIdOptions = {}): number {
  const tasks = readTasks(baseDir);
  if (opts.json === true) {
    printJson(tasks);
    return 0;
  }
  if (tasks.length === 0) {
    log('No tasks.');
    return 0;
  }
  const active = activeTask(tasks);
  for (const t of tasks) {
    const marker = active !== null && active.id === t.id ? '*' : ' ';
    log(`${marker} ${t.id}  [${t.status}]  ${clean(t.subject)}`);
  }
  return 0;
}

export function runTasksShow(baseDir: string, id: string, opts: TasksIdOptions = {}): number {
  const tasks = readTasks(baseDir);
  const t = findTask(tasks, id);
  if (t === undefined) {
    err(`No such task: ${clean(id)}`);
    return 1;
  }
  if (opts.json === true) {
    printJson(t);
    return 0;
  }
  log(`${t.id}  [${t.status}]${t.active ? ' (active)' : ''}`);
  log(`  Subject:      ${clean(t.subject)}`);
  if (t.description !== undefined) log(`  Description:   ${clean(t.description)}`);
  if (t.requires_spec === true) log(`  Requires spec: yes`);
  if (t.spec !== undefined) log(`  Spec:         ${clean(t.spec)}`);
  if (t.blocked_by !== undefined && t.blocked_by.length > 0) {
    log(`  Blocked by:   ${t.blocked_by.map(clean).join(', ')}`);
  }
  if (t.evidence !== undefined && t.evidence.length > 0) {
    log(`  Evidence:     ${t.evidence.map(clean).join(', ')}`);
  }
  if (t.external_ref !== undefined) log(`  External ref: ${clean(t.external_ref)}`);
  log(`  Created:      ${clean(t.created_at)}`);
  log(`  Updated:      ${clean(t.updated_at)}`);
  return 0;
}

/**
 * Register `rea tasks <subcommand>` on the root program. Each action resolves
 * `baseDir` from the resolved project root and exits non-zero when the `run*` helper
 * reports a refusal / not-found.
 */
export function registerTasksCommand(program: Command): void {
  const tasks = program
    .command('tasks')
    .description('Manage the .rea/tasks.jsonl task store (append-only; latest-per-id wins).');

  tasks
    .command('add')
    .description('Create a pending task.')
    .requiredOption('--subject <s>', 'task subject / title')
    .option('--description <d>', 'longer description')
    .option('--requires-spec', 'mark that this task requires a spec')
    .option('--spec <path>', 'repo-relative spec path')
    .option('--blocked-by <ids...>', 'task ids this task is blocked by')
    .option('--json', 'emit the created record as JSON')
    .action(
      (opts: {
        subject: string;
        description?: string;
        requiresSpec?: boolean;
        spec?: string;
        blockedBy?: string[];
        json?: boolean;
      }) => {
        const code = runTasksAdd(resolveLocalRoot(process.cwd()), {
          subject: opts.subject,
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.requiresSpec !== undefined ? { requiresSpec: opts.requiresSpec } : {}),
          ...(opts.spec !== undefined ? { spec: opts.spec } : {}),
          ...(opts.blockedBy !== undefined ? { blockedBy: opts.blockedBy } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        });
        if (code !== 0) process.exit(code);
      },
    );

  tasks
    .command('start <id>')
    .description('Mark a task in_progress.')
    .option('--json', 'emit the updated record as JSON')
    .action((id: string, opts: { json?: boolean }) => {
      const code = runTasksStart(resolveLocalRoot(process.cwd()), id, { ...(opts.json !== undefined ? { json: opts.json } : {}) });
      if (code !== 0) process.exit(code);
    });

  tasks
    .command('activate <id>')
    .description('Set this task active and flip every other task inactive.')
    .option('--json', 'emit the updated record as JSON')
    .action((id: string, opts: { json?: boolean }) => {
      const code = runTasksActivate(resolveLocalRoot(process.cwd()), id, { ...(opts.json !== undefined ? { json: opts.json } : {}) });
      if (code !== 0) process.exit(code);
    });

  tasks
    .command('evidence <id>')
    .description('Append one or more repo-relative evidence paths to a task.')
    .requiredOption('--add <path...>', 'evidence path(s) to append')
    .option('--json', 'emit the updated record as JSON')
    .action((id: string, opts: { add: string[]; json?: boolean }) => {
      const code = runTasksEvidence(resolveLocalRoot(process.cwd()), id, {
        add: opts.add,
        ...(opts.json !== undefined ? { json: opts.json } : {}),
      });
      if (code !== 0) process.exit(code);
    });

  tasks
    .command('complete <id>')
    .description('Mark a task completed. Refuses when the task has no evidence.')
    .option('--json', 'emit the updated record as JSON')
    .action((id: string, opts: { json?: boolean }) => {
      const code = runTasksComplete(resolveLocalRoot(process.cwd()), id, { ...(opts.json !== undefined ? { json: opts.json } : {}) });
      if (code !== 0) process.exit(code);
    });

  tasks
    .command('list')
    .description('List all tasks (folded latest-per-id).')
    .option('--json', 'emit the task array as JSON')
    .action((opts: { json?: boolean }) => {
      const code = runTasksList(resolveLocalRoot(process.cwd()), { ...(opts.json !== undefined ? { json: opts.json } : {}) });
      if (code !== 0) process.exit(code);
    });

  tasks
    .command('show <id>')
    .description('Show one task.')
    .option('--json', 'emit the record as JSON')
    .action((id: string, opts: { json?: boolean }) => {
      const code = runTasksShow(resolveLocalRoot(process.cwd()), id, { ...(opts.json !== undefined ? { json: opts.json } : {}) });
      if (code !== 0) process.exit(code);
    });
}
