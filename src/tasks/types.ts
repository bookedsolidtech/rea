/**
 * Task-store record types — the shared keystone for the Artifact Gates and
 * `rea dash` features. `.rea/tasks.jsonl` is an append-only JSONL log; the
 * reader folds to the latest record per `id` (last write wins). The on-disk
 * shape is validated by `TaskRecordSchema` in `./schema.ts`.
 *
 * Interface stability matters: two downstream features consume this contract.
 * Fields are additive-only — never rename or repurpose an existing field.
 */

/**
 * Task lifecycle status. A task is created `pending`, moves to `in_progress`
 * when work starts, and terminates as `completed` or `cancelled`.
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/**
 * A single task record. Serialized one-per-line into `.rea/tasks.jsonl`.
 *
 * INVARIANT (enforced by the CLI, not the type): at most ONE task per project
 * may be `active: true` while non-completed. `activeTask()` in `./store.ts`
 * resolves that single active task from a folded task list.
 */
export interface TaskRecord {
  /** Monotonic id, format `T-0001` (zero-padded to at least 4 digits). */
  id: string;
  /** Short human title. Required. */
  subject: string;
  /** Optional longer description. */
  description?: string;
  /** Lifecycle status. */
  status: TaskStatus;
  /** Whether this is the project's active task. At most one active non-completed. */
  active: boolean;
  /** Repo-relative path to a spec document, when one exists. */
  spec?: string;
  /** Whether this task requires a spec before it can proceed. */
  requires_spec?: boolean;
  /** Repo-relative paths to evidence artifacts (the G2 verification invariant). */
  evidence?: string[];
  /** Ids of tasks that block this one. */
  blocked_by?: string[];
  /** Free-form external reference (issue URL, PR, ticket id, …). */
  external_ref?: string;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 last-update timestamp (bumped on every mutation append). */
  updated_at: string;
}
