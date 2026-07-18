/**
 * Artifact Gates §5 — turn-budget reflex. Makes the turn-budget folklore real.
 *
 * Consuming CLAUDE.md files used to state a per-session tool-call budget in
 * PROSE ("wrap up around N turns") and rely on the model to remember and
 * self-enforce it. This module surfaces the SAME numbers through the gateway:
 * policy-declared `warn_turns` / `halt_turns` thresholds drive AUDITED warn /
 * refuse events instead of a prompt the model may ignore.
 *
 * # Where it runs
 *
 * Folded into the EXISTING `billing-cap-halt` PostToolUse Bash hook path (NOT a
 * new hook — a second registration would collide with concurrent install-layer
 * work). On each PostToolUse invocation the hook increments a per-session
 * counter and, on a threshold crossing, emits the corresponding audited event.
 *
 * # State model
 *
 *   - The counter is LOCAL, per worktree + per session:
 *     `<localRoot>/.rea/turn-count.<session>.json`. A session id comes from
 *     `CLAUDE_SESSION_ID` (resolved by the caller); with no session id it
 *     degrades to a single `<localRoot>/.rea/turn-count.json`.
 *   - Audit records go to the COMMON root (repo-wide hash chain), like every
 *     other audited event. HALT — when `response: halt` fires — is also written
 *     to the COMMON root so a budget wall in one worktree freezes every stream.
 *
 * # Threshold-crossing semantics (ONCE, not repeated)
 *
 * The counter file records which thresholds have already fired
 * (`warn_emitted` / `halt_emitted`). A warn is emitted exactly once, on the
 * first turn at/after `warn_turns`; the `response` is applied exactly once, on
 * the first turn at/after `halt_turns`. Turns AFTER a crossing do not re-emit.
 *
 * # Overnight-safe (spec §6)
 *
 * NEVER an interactive prompt. The two effects are (a) an audited event and
 * (b) a one-shot stderr banner; `halt` additionally writes the existing
 * `.rea/HALT` kill-switch. All non-blocking to unattended runs.
 *
 * # Fail posture
 *
 * Best-effort and FAIL-SAFE: a counter read/write failure or an audit failure
 * must never break the PostToolUse call. An OPT-IN budget that cannot persist
 * its counter degrades to "no accounting" rather than freezing the session —
 * consistent with the billing reflex's conservatism against self-inflicted
 * denial-of-service. The one exception is an explicit `response: halt` on a
 * confirmed crossing, which writes HALT by design.
 */

import fs from 'node:fs';
import path from 'node:path';
import properLockfile from 'proper-lockfile';
import { appendAuditRecord } from '../../audit/append.js';
import { writeHaltFile, sanitizeHaltReason } from '../../cli/freeze.js';
import { InvocationStatus, Tier } from '../../policy/types.js';

export type TurnBudgetResponse = 'warn' | 'halt' | 'off';

/**
 * Resolved turn-budget config, as read permissively from
 * `spend_governance.turn_budget`. `null` = feature off (block absent, `off`,
 * or a malformed/invalid shape — an OPT-IN budget with a bad shape degrades to
 * off, since it is a budget knob, not a safety backstop).
 */
export interface TurnBudgetConfig {
  warnTurns: number;
  haltTurns: number;
  response: TurnBudgetResponse;
}

/** On-disk per-session counter shape. */
interface TurnCountState {
  count: number;
  warn_emitted: boolean;
  halt_emitted: boolean;
}

export interface TurnBudgetOptions {
  /** LOCAL worktree root — where the counter file lives. */
  localRoot: string;
  /** COMMON (primary) root — where audit + HALT are written. */
  commonRoot: string;
  /** Resolved config, or `null` when the feature is off. */
  config: TurnBudgetConfig | null;
  /** Session id (from `CLAUDE_SESSION_ID`); undefined → single shared file. */
  sessionId?: string;
  /** Sink for the one-shot banner. */
  stderrWrite: (s: string) => void;
}

export interface TurnBudgetResult {
  /** What this invocation did. */
  action: 'noop' | 'warn' | 'halt';
  /** The counter value AFTER incrementing (null when the feature is off). */
  count: number | null;
  /** Whether this invocation wrote `.rea/HALT`. */
  haltWritten: boolean;
}

/**
 * Permissively parse a raw `spend_governance.turn_budget` block into a
 * {@link TurnBudgetConfig}, or `null` when the feature should be off. Mirrors
 * the billing reader's tolerance (never the strict loader, which throws on any
 * stray key anywhere in the file), but for an OPT-IN knob: an ABSENT or
 * malformed block resolves to OFF, not to a protective default.
 *
 * Off (returns `null`) when:
 *   - the block is absent / not an object,
 *   - `warn_turns` or `halt_turns` is missing or not a positive integer,
 *   - `warn_turns > halt_turns` (the loader `.refine` rejects it; a warn above
 *     the halt threshold can never fire),
 *   - `response` is `off`.
 */
export function parseTurnBudget(raw: unknown): TurnBudgetConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const block = raw as Record<string, unknown>;
  const warnTurns = block['warn_turns'];
  const haltTurns = block['halt_turns'];
  if (
    typeof warnTurns !== 'number' ||
    typeof haltTurns !== 'number' ||
    !Number.isInteger(warnTurns) ||
    !Number.isInteger(haltTurns) ||
    warnTurns <= 0 ||
    haltTurns <= 0 ||
    warnTurns > haltTurns
  ) {
    return null;
  }
  const rawResp = block['response'];
  const response: TurnBudgetResponse =
    rawResp === 'halt' || rawResp === 'off' || rawResp === 'warn' ? rawResp : 'warn';
  if (response === 'off') return null;
  return { warnTurns, haltTurns, response };
}

/** Sanitize a session id into a filename-safe token, or '' if unusable. */
function sessionToken(sessionId: string | undefined): string {
  if (typeof sessionId !== 'string') return '';
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.slice(0, 128);
}

function counterPath(localRoot: string, sessionId: string | undefined): string {
  const token = sessionToken(sessionId);
  const name = token === '' ? 'turn-count.json' : `turn-count.${token}.json`;
  return path.join(localRoot, '.rea', name);
}

function readState(file: string): TurnCountState {
  const empty: TurnCountState = { count: 0, warn_emitted: false, halt_emitted: false };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const p = parsed as Record<string, unknown>;
  const rawCount = p['count'];
  // Round-31 P2: `.rea/turn-count*.json` is writable local state — reject
  // IMPOSSIBLE values instead of trusting them, or a stale/tampered file (a
  // negative count, or emitted-flags at count 0) would silently suppress every
  // future warn/halt crossing for the session. A count must be a non-negative
  // integer; and no threshold (>= 1) can have been crossed at count 0, so a
  // flag set while count is 0 is impossible — clear both.
  const count =
    typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : 0;
  const warn_emitted = count > 0 && p['warn_emitted'] === true;
  const halt_emitted = count > 0 && p['halt_emitted'] === true;
  return { count, warn_emitted, halt_emitted };
}

/**
 * Persist the counter state. Returns `true` when the new state (count +
 * emitted flags) actually reached disk, `false` on any failure. FAIL-SAFE:
 * never throws — a counter that cannot persist degrades to no-accounting, never
 * a broken PostToolUse call. The boolean lets `updateCounter` suppress a
 * threshold crossing it could not record: without the persisted
 * `warn_emitted`/`halt_emitted` flags, the next call would re-read the stale
 * state and re-fire the SAME crossing (a repeated halt/banner under
 * `response: halt`).
 */
function writeState(file: string, state: TurnCountState): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Lock envelope for the per-session counter, mirroring the task store
 * (`src/tasks/store.ts`) and audit store: stale reclaim at 10s, `realpath:
 * false` so a not-yet-created counter file is a valid lock target. The lock
 * sidecar is `<counter>.lock` (gitignored via the `.rea/turn-count*` globs).
 */
const COUNTER_LOCK_OPTIONS: Parameters<typeof properLockfile.lockSync>[1] = {
  stale: 10_000,
  realpath: false,
};

/** Synchronous sleep without a CPU-burning spin — parks the thread for `ms`. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the per-session counter lock synchronously, retrying briefly when a
 * concurrent tool invocation holds it. FAIL-SAFE by design (unlike the task
 * store, which throws): the turn counter must NEVER break a tool call, so on
 * ANY failure — lock held past the retry budget, or a lockfile error — this
 * returns `null` and the caller degrades to a best-effort UNLOCKED increment.
 * A rare lost increment under contention-plus-lock-failure is acceptable; a
 * thrown error out of a PostToolUse hook is not.
 */
function acquireCounterLock(file: string): (() => void) | null {
  // Ensure `.rea/` exists so `<file>.lock` can be created alongside a
  // not-yet-written counter file.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* if the dir cannot be created the RMW's own writes will no-op too */
  }
  const maxAttempts = 40;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return properLockfile.lockSync(file, COUNTER_LOCK_OPTIONS);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const held = code === 'ELOCKED' || /lock/i.test((e as Error).message ?? '');
      if (!held || attempt === maxAttempts - 1) return null; // degrade to unlocked
      sleepSync(20);
    }
  }
  return null;
}

/** Result of a single locked counter increment. */
export interface CounterUpdate {
  /** The counter value AFTER incrementing. */
  count: number;
  /** True when this increment first crossed `warn_turns`. */
  crossedWarn: boolean;
  /** True when this increment first crossed `halt_turns`. */
  crossedHalt: boolean;
}

/**
 * Serialized read→increment→write of the per-session counter. The lock scope is
 * TIGHT — only the counter file's RMW — so the (slower) audit append + HALT
 * write happen OUTSIDE the lock. Two tool invocations finishing close together
 * (the parallel-tool scenario the budget exists to police) each observe the
 * other's write instead of both reading N and writing N+1.
 *
 * The `*_emitted` flags are persisted here (under the lock) so a threshold
 * crossing is computed and recorded atomically with the increment — a crossing
 * fires exactly once even under concurrency.
 */
export function updateCounter(file: string, config: TurnBudgetConfig): CounterUpdate {
  const release = acquireCounterLock(file);
  try {
    const state = readState(file);
    state.count += 1;
    const count = state.count;
    const crossedWarn = count >= config.warnTurns && !state.warn_emitted;
    const crossedHalt = count >= config.haltTurns && !state.halt_emitted;
    // Persist the incremented counter + updated emitted flags BEFORE the caller
    // acts, so a crash mid-action does not re-fire the same crossing next turn.
    if (crossedWarn) state.warn_emitted = true;
    if (crossedHalt) state.halt_emitted = true;
    // A crossing may only be REPORTED if the new state (with its emitted flags)
    // actually PERSISTED. If the write is lost (read-only checkout / perms /
    // transient FS error), the on-disk state does NOT advance — so the next
    // call re-reads the stale state and recomputes the SAME crossing. Reporting
    // it now would therefore GUARANTEE a duplicate (a repeated halt/banner in
    // `response: halt`), defeating the once-per-crossing design. Suppress the
    // crossing on a failed persist; it fires exactly once on the first call
    // whose write succeeds. FAIL-SAFE: `writeState` never throws, so a
    // persistence failure degrades this call to no-accounting, never a broken
    // tool call.
    const persisted = writeState(file, state);
    return {
      count,
      crossedWarn: persisted && crossedWarn,
      crossedHalt: persisted && crossedHalt,
    };
  } finally {
    if (release !== null) {
      try {
        release();
      } catch {
        /* releasing a best-effort lock must never throw out of the hook */
      }
    }
  }
}

async function recordTurnBudgetAudit(
  commonRoot: string,
  kind: 'warn' | 'halt',
  info: { count: number; warnTurns: number; haltTurns: number; response: TurnBudgetResponse; haltWritten: boolean },
): Promise<void> {
  try {
    await appendAuditRecord(commonRoot, {
      tool_name: kind === 'halt' ? 'rea.spend.turn_budget_halt' : 'rea.spend.turn_budget_warn',
      server_name: 'billing-cap-halt',
      // A halt DENIES further work; a warn is advisory and ALLOWS the call.
      status: kind === 'halt' ? InvocationStatus.Denied : InvocationStatus.Allowed,
      tier: Tier.Destructive,
      metadata: {
        kind: 'turn-budget',
        event: kind,
        count: info.count,
        warn_turns: info.warnTurns,
        halt_turns: info.haltTurns,
        response: info.response,
        halt_written: info.haltWritten,
      },
    });
  } catch {
    /* observability is secondary — never let an audit failure break the gate */
  }
}

function buildWarnBanner(count: number, threshold: number, atHaltThreshold: boolean): string {
  const head = atHaltThreshold
    ? 'TURN BUDGET: halt threshold reached (response=warn — no freeze)'
    : 'TURN BUDGET: warn threshold reached';
  return [
    `${head}\n`,
    '\n',
    `  Session tool-calls: ${count} (threshold ${threshold}).\n`,
    '  This budget lives in policy (spend_governance.turn_budget), not prose.\n',
    '  Wrap up the current unit of work rather than opening new lines of effort.\n',
  ].join('');
}

function buildHaltBanner(count: number, threshold: number): string {
  return [
    'TURN BUDGET HALT: session tool-call budget exhausted — session frozen\n',
    '\n',
    `  Session tool-calls: ${count} (halt threshold ${threshold}).\n`,
    '\n',
    '  .rea/HALT written — all governed tool calls are now blocked.\n',
    '  Review the session, then `rea unfreeze` to resume.\n',
  ].join('');
}

/**
 * Degraded banner for `response: halt` when `.rea/HALT` could NOT be written
 * (read-only checkout / perms / broken `.rea`). Must NOT claim the session is
 * frozen (it isn't). The hard stop still BLOCKS the current tool call (the
 * caller exits 2 regardless of the write outcome — a configured hard stop must
 * at minimum stop the call it fired on), but the freeze must be applied
 * manually so later calls are also blocked.
 */
function buildHaltWriteFailedBanner(count: number, threshold: number): string {
  return [
    'TURN BUDGET HALT (DEGRADED): tool-call budget exhausted but .rea/HALT could NOT be written\n',
    '\n',
    `  Session tool-calls: ${count} (halt threshold ${threshold}).\n`,
    '\n',
    '  This tool call is BLOCKED, but the session is NOT frozen (the HALT file\n',
    '  could not be created). Run `rea freeze` manually, or fix the filesystem\n',
    '  permissions so the budget reflex can write .rea/HALT.\n',
  ].join('');
}

/**
 * Increment the per-session turn counter and emit any threshold-crossing
 * events. Assumes the caller has already confirmed the session is NOT already
 * halted (the billing hook's HALT short-circuit runs first). A no-op when
 * `config` is `null`.
 */
export async function runTurnBudget(options: TurnBudgetOptions): Promise<TurnBudgetResult> {
  const { config, localRoot, commonRoot, sessionId, stderrWrite } = options;
  if (config === null) {
    return { action: 'noop', count: null, haltWritten: false };
  }

  // Serialized read→increment→write (the lock keeps the parallel-tool case
  // from losing an increment). Threshold crossings are computed atomically with
  // the increment; the audit/HALT side effects below run OUTSIDE the lock.
  const file = counterPath(localRoot, sessionId);
  const { count, crossedWarn, crossedHalt } = updateCounter(file, config);

  // The halt-threshold crossing supersedes the warn-threshold crossing when
  // both land on the same turn (e.g. warn_turns === halt_turns): the `response`
  // is the authoritative action.
  if (crossedHalt) {
    if (config.response === 'halt') {
      let haltWritten = false;
      try {
        writeHaltFile(
          commonRoot,
          sanitizeHaltReason(
            `turn-budget: session tool-call budget exhausted (${count} >= ${config.haltTurns}) — automated freeze`,
          ),
        );
        haltWritten = true;
      } catch {
        /* HALT could not be written (read-only FS / permissions). Still audit +
         * banner + exit 2 (via the caller) so the hard stop does not silently
         * downgrade to advisory. */
      }
      // Honest banner: only claim "frozen / HALT written" when the write
      // actually succeeded; otherwise the degraded banner (the call is still
      // blocked, but the operator must freeze manually).
      stderrWrite(
        haltWritten
          ? buildHaltBanner(count, config.haltTurns)
          : buildHaltWriteFailedBanner(count, config.haltTurns),
      );
      await recordTurnBudgetAudit(commonRoot, 'halt', {
        count,
        warnTurns: config.warnTurns,
        haltTurns: config.haltTurns,
        response: config.response,
        haltWritten,
      });
      return { action: 'halt', count, haltWritten };
    }
    // response === 'warn': audited advisory at the halt threshold, no freeze.
    stderrWrite(buildWarnBanner(count, config.haltTurns, true));
    await recordTurnBudgetAudit(commonRoot, 'warn', {
      count,
      warnTurns: config.warnTurns,
      haltTurns: config.haltTurns,
      response: config.response,
      haltWritten: false,
    });
    return { action: 'warn', count, haltWritten: false };
  }

  if (crossedWarn) {
    stderrWrite(buildWarnBanner(count, config.warnTurns, false));
    await recordTurnBudgetAudit(commonRoot, 'warn', {
      count,
      warnTurns: config.warnTurns,
      haltTurns: config.haltTurns,
      response: config.response,
      haltWritten: false,
    });
    return { action: 'warn', count, haltWritten: false };
  }

  return { action: 'noop', count, haltWritten: false };
}
