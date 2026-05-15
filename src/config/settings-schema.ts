/**
 * Class M — `.claude/settings.json` zod schema (0.30.0+).
 *
 * Consumer-side validation for the Claude Code harness `settings.json`
 * file. The harness itself accepts a JSON object with a documented
 * shape; rea adds a strict subset of that shape so a typo in a hook
 * registration ("statusMessasge", "PreToolUze") doesn't silently
 * disable a load-bearing rea hook on a consumer's install.
 *
 * Two modes:
 *   - Default (`mode: 'warn'`) — `rea doctor` logs a warn for any
 *     unknown top-level key, unknown hook event, or unrecognized
 *     matcher pattern. Existing consumer files that haven't seen the
 *     schema before keep working without action.
 *   - Strict (`mode: 'strict'`) — `rea doctor --strict` fails on any
 *     zod failure, on path-traversal in a `command` value, and when
 *     a rea-shipped hook (`EXPECTED_HOOKS`) is missing from the
 *     PreToolUse / PostToolUse registrations. Used by CI gates that
 *     want a hard floor.
 *
 * Path-traversal is checked OUTSIDE zod (see `validateNoTraversal`)
 * — zod's job is shape; ours is to make sure a `command` literally
 * cannot reference `..` after stripping `$CLAUDE_PROJECT_DIR`. The
 * harness expands the variable at exec time, so the on-disk value
 * is the right anchor for the check.
 */

import { z } from 'zod';
import { EXPECTED_HOOKS } from '../cli/doctor.js';
import { defaultDesiredHooks } from '../cli/install/settings-merge.js';

/**
 * Hook event names the harness honors. Strict union so a typo
 * ("PreToolUze") fails closed. The union mirrors Anthropic's
 * published list as of 2026-05; new events get added here as the
 * harness ships them.
 */
export const HOOK_EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'Notification',
  'SessionStart',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * Hook-command entry. `statusMessage` is REQUIRED to ALLOW (not to
 * require) because every canonical entry rea ships carries one — the
 * harness uses it for the spinner status line, and omitting it would
 * be technically valid but degrade UX. `timeout` is optional; when
 * present must be a positive int up to the harness ceiling of
 * 600_000 ms (10 minutes).
 */
export const HookCommandSchema = z
  .object({
    type: z.literal('command'),
    command: z.string().min(1, 'hook command must be a non-empty string'),
    timeout: z.number().int().positive().max(600_000).optional(),
    statusMessage: z.string().optional(),
  })
  .strict();

export type HookCommand = z.infer<typeof HookCommandSchema>;

/**
 * Hook entry group: a matcher pattern (string like `Bash` or
 * `Write|Edit|MultiEdit|NotebookEdit`) plus its list of hook commands.
 * The matcher is opaque to the schema — the harness parses it as a
 * pipe-separated tool-name list. Empty matcher is rejected.
 */
export const HookEntrySchema = z
  .object({
    matcher: z.string().min(1, 'hook matcher must be a non-empty string'),
    hooks: z.array(HookCommandSchema).min(1, 'each matcher must register at least one hook'),
  })
  .strict();

export type HookEntry = z.infer<typeof HookEntrySchema>;

/**
 * Top-level `.claude/settings.json` shape.
 *
 * `permissions` is pass-through (`z.record`) because it carries
 * harness-defined structure that rea is not the source of truth for.
 * `env` is a string-to-string map. `model` is a free string (the
 * harness validates the model name at runtime).
 *
 * Each hook-event field is strict — a typo in the event name fails
 * the parse instead of silently registering on a phantom event.
 */
export const SettingsSchema = z
  .object({
    env: z.record(z.string()).optional(),
    permissions: z.unknown().optional(),
    model: z.string().optional(),
    hooks: z
      .object({
        PreToolUse: z.array(HookEntrySchema).optional(),
        PostToolUse: z.array(HookEntrySchema).optional(),
        UserPromptSubmit: z.array(HookEntrySchema).optional(),
        Stop: z.array(HookEntrySchema).optional(),
        SubagentStop: z.array(HookEntrySchema).optional(),
        PreCompact: z.array(HookEntrySchema).optional(),
        Notification: z.array(HookEntrySchema).optional(),
        SessionStart: z.array(HookEntrySchema).optional(),
      })
      .strict()
      .optional(),
  })
  // Codex round 4 P1: top-level is .passthrough(), NOT .strict().
  // Claude Code keeps adding harness-side top-level keys (model,
  // permissions, env, future entries) and rea is NOT the source of
  // truth for them. A strict top-level would refuse to validate the
  // moment Claude Code ships a new key, breaking `rea upgrade` for
  // every consumer mid-version. Hook events are still strict (a
  // matcher typo in a known event must fail loudly).
  .passthrough();

/**
 * Strict variant for `rea doctor --strict`. Same shape as `SettingsSchema`
 * but rejects unknown top-level keys. Used only by the CI-gate path,
 * never by `rea upgrade`. Exported so the doctor can opt into stricter
 * validation when consumers explicitly request it.
 */
export const SettingsSchemaStrict = SettingsSchema.extend({}).strict();

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Path-traversal check on every `command` value. Zod's job is shape;
 * this lives OUTSIDE the schema so the rule is auditable separately.
 *
 * Algorithm:
 *   1. Strip `$CLAUDE_PROJECT_DIR` (the harness expands this at exec).
 *   2. Strip `"$CLAUDE_PROJECT_DIR"` (the canonical quoted form rea
 *      itself emits).
 *   3. Search for `..<sep>` segments in what remains. A literal `..`
 *      anywhere in the path is treated as traversal.
 *
 * Returns a list of `{ event, matcher, index, command, reason }`
 * tuples. Empty list = clean.
 */
export interface TraversalFinding {
  event: string;
  matcher: string;
  index: number;
  command: string;
  reason: string;
}

const TRAVERSAL_RE = /\.\.[/\\]/;

export function validateNoTraversal(settings: Settings): TraversalFinding[] {
  const findings: TraversalFinding[] = [];
  const hooks = settings.hooks;
  if (hooks === undefined) return findings;
  for (const event of HOOK_EVENT_NAMES) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const group of entries) {
      for (let i = 0; i < group.hooks.length; i += 1) {
        const hook = group.hooks[i]!;
        const stripped = hook.command
          .replace(/"\$CLAUDE_PROJECT_DIR"/g, '')
          .replace(/\$CLAUDE_PROJECT_DIR/g, '');
        if (TRAVERSAL_RE.test(stripped)) {
          findings.push({
            event,
            matcher: group.matcher,
            index: i,
            command: hook.command,
            reason: 'contains `..` path segment outside $CLAUDE_PROJECT_DIR',
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Result of validating a consumer `.claude/settings.json`.
 *
 *   - `parsed: true`  — zod parse succeeded; the schema-typed value is
 *     `settings`.
 *   - `parsed: false` — zod failed; `errors` is the list of
 *     `z.ZodIssue` strings.
 *
 * Findings are accumulated regardless of zod success:
 *   - `traversalFindings` — `..` segments inside `command` values.
 *   - `missingReaHooks` — rea-shipped hooks (`EXPECTED_HOOKS`) that do
 *     not appear in any `command` value across PreToolUse +
 *     PostToolUse. Strict-mode `rea doctor` fails on a non-empty
 *     list.
 *
 * Lossy-but-useful: when zod fails, we still try the traversal +
 * missing-hooks checks against the raw input so the operator sees as
 * much information as possible per `rea doctor` invocation.
 */
export interface SettingsValidationResult {
  parsed: boolean;
  settings: Settings | null;
  errors: string[];
  traversalFindings: TraversalFinding[];
  missingReaHooks: string[];
  /**
   * Schema-passes-but-not-strict warnings: unknown top-level keys,
   * unknown hook event names that we recognized as strings but didn't
   * match the union. Empty when nothing surprising lurks.
   */
  warnings: string[];
}

/**
 * Validate a parsed JSON object against the settings schema.
 *
 * Strategy: try `SettingsSchema.parse(input)`. On success run the
 * traversal + missing-hooks checks. On failure fall back to a
 * best-effort scan of any `hooks: { PreToolUse: [...] }` shape we
 * recognize, so the operator still sees traversal + missing-hooks
 * findings.
 *
 * `strict` selects the schema:
 *   - `false` (default) — `SettingsSchema`, top-level `.passthrough()`.
 *     Unknown harness keys pass. Used by `rea upgrade` and advisory
 *     `rea doctor`.
 *   - `true` — `SettingsSchemaStrict`, top-level `.strict()`. Unknown
 *     keys fail the parse. Used only by `rea doctor --strict` (the CI
 *     gate path). 0.30.1 round-5 P2: the strict schema existed since
 *     0.30.0 but `validateSettings` never accepted the selector, so
 *     `rea doctor --strict` silently ran the lenient schema.
 */
export function validateSettings(
  input: unknown,
  options: { strict?: boolean } = {},
): SettingsValidationResult {
  const result: SettingsValidationResult = {
    parsed: false,
    settings: null,
    errors: [],
    traversalFindings: [],
    missingReaHooks: [],
    warnings: [],
  };

  const schema = options.strict === true ? SettingsSchemaStrict : SettingsSchema;
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    result.parsed = true;
    result.settings = parsed.data;
    result.traversalFindings = validateNoTraversal(parsed.data);
    result.missingReaHooks = findMissingReaHooks(parsed.data);
  } else {
    result.errors = parsed.error.issues.map(
      (i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`,
    );
    // Best-effort fallback scan on the raw input so the operator sees
    // every finding in one shot.
    const recovered = recoverSettingsShape(input);
    if (recovered !== null) {
      result.traversalFindings = validateNoTraversal(recovered);
      result.missingReaHooks = findMissingReaHooks(recovered);
    }
  }

  return result;
}

/**
 * Cross-check: every name in `EXPECTED_HOOKS` should appear as the
 * basename of at least one `command` across PreToolUse + PostToolUse.
 * Returns the missing list (empty when complete).
 *
 * Defensive: `EXPECTED_HOOKS` is sourced from `doctor.ts` so the
 * single edit-point is preserved (new hook adds → both doctor's
 * file-existence check AND this schema check pick it up).
 */
export function findMissingReaHooks(settings: Settings): string[] {
  const registeredCommands = new Set<string>();
  const hooks = settings.hooks;
  if (hooks !== undefined) {
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      for (const group of entries) {
        for (const hook of group.hooks) {
          registeredCommands.add(hook.command);
        }
      }
    }
  }
  const missing: string[] = [];
  for (const name of EXPECTED_HOOKS) {
    const found = Array.from(registeredCommands).some((cmd) => cmd.endsWith(`/${name}`));
    if (!found) missing.push(name);
  }
  return missing;
}

/**
 * Compute the desired-hooks registration that `rea init` would emit
 * for a fresh install. Exported so `rea doctor --strict` can show the
 * operator the exact set the schema is enforcing without forcing them
 * to dig through source.
 */
export function expectedHookNames(): string[] {
  // Single source of truth: the canonical desired-hooks list.
  const out = new Set<string>();
  for (const group of defaultDesiredHooks()) {
    for (const hook of group.hooks) {
      const tail = hook.command.split('/').pop() ?? '';
      if (tail.length > 0) out.add(tail);
    }
  }
  return Array.from(out).sort();
}

/**
 * Best-effort shape recovery when zod parse fails. Walks `input` and
 * extracts as much of the `Settings` shape as possible, dropping any
 * field that doesn't structurally match. Used ONLY to feed the
 * traversal + missing-hooks checks — never returned to the caller as
 * a "parsed" result.
 */
function recoverSettingsShape(input: unknown): Settings | null {
  if (input === null || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const hooks = o['hooks'];
  if (hooks === null || typeof hooks !== 'object') return null;
  const h = hooks as Record<string, unknown>;
  const recovered: Settings = { hooks: {} };
  const recoveredHooks: NonNullable<Settings['hooks']> = {};
  for (const event of HOOK_EVENT_NAMES) {
    const entries = h[event];
    if (!Array.isArray(entries)) continue;
    const goodEntries: HookEntry[] = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as { matcher?: unknown; hooks?: unknown };
      if (typeof e.matcher !== 'string') continue;
      if (!Array.isArray(e.hooks)) continue;
      const goodHooks: HookCommand[] = [];
      for (const hk of e.hooks) {
        if (hk === null || typeof hk !== 'object') continue;
        const c = hk as {
          type?: unknown;
          command?: unknown;
          timeout?: unknown;
          statusMessage?: unknown;
        };
        if (c.type !== 'command') continue;
        if (typeof c.command !== 'string' || c.command.length === 0) continue;
        const out: HookCommand = { type: 'command', command: c.command };
        if (typeof c.timeout === 'number' && Number.isInteger(c.timeout) && c.timeout > 0) {
          out.timeout = c.timeout;
        }
        if (typeof c.statusMessage === 'string') {
          out.statusMessage = c.statusMessage;
        }
        goodHooks.push(out);
      }
      if (goodHooks.length > 0) {
        goodEntries.push({ matcher: e.matcher, hooks: goodHooks });
      }
    }
    if (goodEntries.length > 0) {
      recoveredHooks[event] = goodEntries;
    }
  }
  recovered.hooks = recoveredHooks;
  return recovered;
}
