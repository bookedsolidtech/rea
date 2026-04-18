/**
 * Merge rea's required hook registrations into a consumer's
 * `.claude/settings.json` without ever silently overwriting consumer-authored
 * entries.
 *
 * Rules per hook-group `(event, matcher, command)`:
 *
 *   1. `${matcher}::${command}` already present on the same event  → no-op.
 *   2. Same matcher, different command  → append and warn (the consumer may
 *      need to chain the hooks manually if order matters).
 *   3. Novel matcher  → append as a new matcher group.
 *
 * Writes are atomic: serialize to `settings.json.tmp`, then rename. This keeps
 * the file intact under crash or signal-interrupt.
 *
 * We deliberately do NOT validate the shape of existing entries beyond the
 * minimum needed to merge. The harness is the source of truth for the schema;
 * if a consumer has hand-authored unusual entries, we trust them and merge
 * around their structure.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';

export interface DesiredHook {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
}

export interface DesiredHookGroup {
  event: HookEvent;
  matcher: string;
  hooks: DesiredHook[];
}

export interface MergeResult {
  merged: Record<string, unknown>;
  warnings: string[];
  addedCount: number;
  skippedCount: number;
}

interface ExistingHook {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
}

interface ExistingMatcherGroup {
  matcher?: string;
  hooks?: ExistingHook[];
}

function deepClone<T>(value: T): T {
  // structuredClone is available on Node 22+ (engines.node enforces this).
  return structuredClone(value);
}

function ensureHooksShape(settings: Record<string, unknown>): Record<string, ExistingMatcherGroup[]> {
  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  settings.hooks = hooks;
  return hooks as Record<string, ExistingMatcherGroup[]>;
}

function keyFor(matcher: string, command: string): string {
  return `${matcher}::${command}`;
}

/**
 * Pure merge function — takes the existing settings object and the desired
 * hooks and returns the merged settings plus a list of warnings. Does NOT
 * touch disk.
 */
export function mergeSettings(
  existing: Record<string, unknown>,
  desired: DesiredHookGroup[],
): MergeResult {
  const merged = deepClone(existing);
  const hooks = ensureHooksShape(merged);
  const warnings: string[] = [];
  let addedCount = 0;
  let skippedCount = 0;

  for (const want of desired) {
    const existingGroups = hooks[want.event] ?? [];

    // Build a set of already-registered (matcher, command) pairs across all
    // groups for this event. Most consumer files have one group per matcher,
    // but we handle the multi-group case defensively.
    const seen = new Set<string>();
    for (const g of existingGroups) {
      if (typeof g.matcher !== 'string') continue;
      for (const h of g.hooks ?? []) {
        if (typeof h.command === 'string') seen.add(keyFor(g.matcher, h.command));
      }
    }

    // Find or create a group with exactly this matcher. Track whether the
    // group pre-existed so we only warn when rea chains onto consumer-authored
    // hooks — not when multiple rea defaults share the same matcher group we
    // just created this run.
    const preExisting = existingGroups.find((g) => g.matcher === want.matcher);
    let targetGroup = preExisting;
    const wasPreExisting = preExisting !== undefined;

    for (const wantHook of want.hooks) {
      const k = keyFor(want.matcher, wantHook.command);
      if (seen.has(k)) {
        skippedCount += 1;
        continue;
      }
      if (targetGroup === undefined) {
        targetGroup = { matcher: want.matcher, hooks: [] };
        existingGroups.push(targetGroup);
        hooks[want.event] = existingGroups;
        warnings.push(
          `added novel matcher "${want.matcher}" to event ${want.event}`,
        );
      } else if (wasPreExisting) {
        // Same matcher existed already in the consumer file; we're chaining
        // new commands onto something the consumer owns. Warn so they review
        // ordering semantics.
        warnings.push(
          `chained new command onto existing matcher "${want.matcher}" for event ${want.event}: ${wantHook.command} — verify hook ordering is still correct`,
        );
      }
      if (!Array.isArray(targetGroup.hooks)) targetGroup.hooks = [];
      targetGroup.hooks.push({
        type: wantHook.type,
        command: wantHook.command,
        ...(wantHook.timeout !== undefined ? { timeout: wantHook.timeout } : {}),
        ...(wantHook.statusMessage !== undefined
          ? { statusMessage: wantHook.statusMessage }
          : {}),
      });
      seen.add(k);
      addedCount += 1;
    }
  }

  return { merged, warnings, addedCount, skippedCount };
}

/**
 * Atomic write via tmp-file + rename.
 *
 * Portability note (finding #8): POSIX `rename(2)` atomically replaces the
 * destination if it exists, but Windows `MoveFileEx` without
 * `MOVEFILE_REPLACE_EXISTING` fails with `EEXIST`/`EPERM` on a non-empty
 * destination — and Node's `fs.rename` does not pass that flag on Win32. So on
 * Windows, a straight rename over an existing `settings.json` fails and
 * `rea init` cannot update consumer settings.
 *
 * We handle this inline rather than taking a dependency: try `rename`; if it
 * fails with `EEXIST` or `EPERM`, `unlink` the destination and retry. This
 * opens a tiny window where the file is missing between unlink and rename, but
 * a crash in that window leaves the `.tmp` file on disk as a recoverable
 * artifact — strictly better than a corrupted merge. We prefer no dependency
 * over `write-file-atomic`: every dep on a governance tool is a supply-chain
 * surface, and this shim is small enough to audit here.
 */
export async function writeSettingsAtomic(
  settingsPath: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const dir = path.dirname(settingsPath);
  await fsPromises.mkdir(dir, { recursive: true });
  const tmp = `${settingsPath}.tmp`;
  const serialized = JSON.stringify(settings, null, 2) + '\n';
  await fsPromises.writeFile(tmp, serialized, 'utf8');
  try {
    await fsPromises.rename(tmp, settingsPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') {
      // Clean up the tmp file on unexpected failure so we don't leave litter.
      await fsPromises.unlink(tmp).catch(() => {
        /* best-effort; original error is the one that matters */
      });
      throw err;
    }
    // Windows: destination exists and rename refuses to replace it. Remove
    // and retry. If the second rename also fails, propagate — something
    // stranger is going on (permissions, read-only volume) that the operator
    // needs to see.
    await fsPromises.unlink(settingsPath);
    try {
      await fsPromises.rename(tmp, settingsPath);
    } catch (retryErr) {
      await fsPromises.unlink(tmp).catch(() => {
        /* best-effort cleanup */
      });
      throw retryErr;
    }
  }
}

/**
 * Read `${targetDir}/.claude/settings.json` if present; return an empty object
 * otherwise. The wizard/`--yes` path will then populate env defaults
 * elsewhere; this function only concerns itself with structural parsing.
 */
export function readSettings(targetDir: string): {
  settings: Record<string, unknown>;
  settingsPath: string;
  existed: boolean;
} {
  const settingsPath = path.join(targetDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { settings: {}, settingsPath, existed: false };
  }
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { settings: parsed, settingsPath, existed: true };
  } catch (err) {
    throw new Error(
      `Failed to parse ${settingsPath}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Desired hook registrations that `rea init` installs on every run. Mirrors
 * the shape of the `.claude/settings.json` that this repo dogfoods. Keep in
 * lockstep with `hooks/` filenames.
 */
export function defaultDesiredHooks(): DesiredHookGroup[] {
  const base = '"$CLAUDE_PROJECT_DIR"/.claude/hooks';
  return [
    {
      event: 'PreToolUse',
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: `${base}/dangerous-bash-interceptor.sh`, timeout: 10000, statusMessage: 'Checking command safety...' },
        { type: 'command', command: `${base}/env-file-protection.sh`, timeout: 5000, statusMessage: 'Checking for .env file reads...' },
        { type: 'command', command: `${base}/dependency-audit-gate.sh`, timeout: 15000, statusMessage: 'Verifying package exists...' },
        { type: 'command', command: `${base}/security-disclosure-gate.sh`, timeout: 5000, statusMessage: 'Checking disclosure policy...' },
        { type: 'command', command: `${base}/pr-issue-link-gate.sh`, timeout: 5000, statusMessage: 'Checking PR for issue reference...' },
        { type: 'command', command: `${base}/attribution-advisory.sh`, timeout: 5000, statusMessage: 'Checking for AI attribution...' },
      ],
    },
    {
      event: 'PreToolUse',
      matcher: 'Write|Edit',
      hooks: [
        { type: 'command', command: `${base}/secret-scanner.sh`, timeout: 15000, statusMessage: 'Scanning for credentials...' },
        { type: 'command', command: `${base}/settings-protection.sh`, timeout: 5000, statusMessage: 'Checking settings protection...' },
        { type: 'command', command: `${base}/blocked-paths-enforcer.sh`, timeout: 5000, statusMessage: 'Checking blocked paths...' },
        { type: 'command', command: `${base}/changeset-security-gate.sh`, timeout: 5000, statusMessage: 'Checking changeset for security leaks...' },
      ],
    },
    {
      event: 'PostToolUse',
      matcher: 'Write|Edit',
      hooks: [
        { type: 'command', command: `${base}/architecture-review-gate.sh`, timeout: 10000, statusMessage: 'Checking architecture impact...' },
      ],
    },
  ];
}
