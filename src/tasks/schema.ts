/**
 * Zod schema for the `.rea/tasks.jsonl` task store. Strict so an unknown or
 * mistyped field fails loudly rather than silently round-tripping — mirrors
 * the project convention in `src/policy/loader.ts`.
 *
 * The schema is the single source of truth for what a valid on-disk task line
 * looks like. `store.ts` uses it both to VALIDATE writes (throw on our own
 * malformed record) and to TOLERANTLY skip malformed READ lines (safeParse).
 */

import { z } from 'zod';
import type { TaskRecord } from './types.js';

/** Repo-relative path to the task store. Owner-confirmed (`.rea/`, NOT `.reagent/`). */
export const TASKS_RELPATH = '.rea/tasks.jsonl';

/** Task lifecycle status values. Matches `TaskStatus` in `./types.ts`. */
export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

/**
 * Strict task-record schema. Field-for-field with `TaskRecord`.
 *
 * `id` is pinned to the `T-<digits>` shape (at least 4 digits) so a folded id
 * always sorts and parses in `nextTaskId`. Optional fields use `.optional()`;
 * absent optionals are OMITTED from the parsed object (zod does not inject
 * `undefined` keys), which keeps the folded records compatible with the
 * project's `exactOptionalPropertyTypes` posture.
 */
export const TaskRecordSchema = z
  .object({
    id: z.string().regex(/^T-\d{4,}$/),
    subject: z.string().min(1),
    description: z.string().optional(),
    status: TaskStatusSchema,
    active: z.boolean(),
    spec: z.string().optional(),
    requires_spec: z.boolean().optional(),
    evidence: z.array(z.string()).optional(),
    blocked_by: z.array(z.string()).optional(),
    external_ref: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

/**
 * Compile-time assurance that the schema output stays assignable to the
 * hand-written `TaskRecord` interface. If the two drift, this line fails to
 * type-check.
 */
export type TaskRecordFromSchema = z.infer<typeof TaskRecordSchema>;
const _typeCheck: (r: TaskRecord) => TaskRecordFromSchema = (r) => r;
void _typeCheck;
