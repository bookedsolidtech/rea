/**
 * `rea hook delegation-advisory` — the 0.31.0 delegation *nudge*.
 *
 * 0.29.0 shipped the delegation-telemetry observability layer (the
 * `Agent|Skill` PreToolUse capture hook + `rea audit specialists`
 * reader). It could *see* delegation patterns but said nothing about
 * them. 0.31.0 closes the loop: the `delegation-advisory.sh` PostToolUse
 * hook (matcher `Bash|Edit|Write|MultiEdit|NotebookEdit`) pipes each
 * write-class tool call through this CLI, which maintains a per-session
 * counter and — the FIRST time the counter crosses
 * `policy.delegation_advisory.threshold` while the session has recorded
 * ZERO real delegation signals — prints a one-time stderr advisory.
 *
 * # Advisory, never gating
 *
 * The CLI ALWAYS exits 0 except under HALT (exit 2, to keep the
 * kill-switch contract uniform with the rest of the hook tree). It
 * NEVER blocks a tool call. The whole point is a nudge — "this session
 * has done a lot of work without delegating to a specialist" — not an
 * enforcement gate. A consumer who disagrees sets
 * `policy.delegation_advisory.enabled: false` (the schema default; only
 * `bst-internal*` profiles pin `true`) and the hook is a silent no-op.
 *
 * # State: the per-session counter directory
 *
 * State lives under `.rea/.delegation-advisory/`:
 *
 *   - `<state-key>.count`  — a single integer, the running write-class
 *     tool-call count for the session.
 *   - `<state-key>.fired` — a sentinel file; present once the advisory
 *     has fired for the session, so it never fires twice.
 *
 * The session id comes from the untrusted hook payload, so it is run
 * through `sessionStateKey` before it touches a filesystem path. That
 * key is `<readable-prefix>-<hash>`: a sanitized, length-capped prefix
 * (`[A-Za-z0-9._-]` only — keeps the directory glanceable) plus a short
 * SHA-256 hex digest of the RAW id. The hash suffix is the correctness
 * half — a bare sanitized prefix is lossy (`a/b` and `a:b` both
 * sanitize to `a_b`), so two distinct sessions would otherwise share
 * `count`/`fired` files and one could inherit the other's counter or
 * suppress the other's advisory. A missing / empty / non-string session
 * id collapses to the literal `unknown` key, so sessions Claude Code
 * didn't tag still get a (deliberately shared) counter rather than
 * crashing the hook — and that matches the `'unknown'` audit-form id
 * `runHookDelegationSignal` records for the same untagged sessions.
 *
 * The directory is best-effort: any filesystem error (ENOSPC, EACCES,
 * a read-only `.rea/`) is swallowed and the CLI exits 0. Losing the
 * nudge is acceptable; breaking tool dispatch is not.
 *
 * # The "did this session delegate" predicate
 *
 * A session has delegated when `.rea/audit.jsonl` contains at least one
 * `rea.delegation_signal` record whose `session_id_observed` matches
 * the current session AND that record counts as a REAL delegation per
 * `countsAsRealDelegation` (see `src/cli/roster.ts`): every `Skill`
 * signal counts; an `Agent` signal counts when its `subagent_type` is
 * a discovered curated specialist and not in the exempt set.
 *
 * Scanning the whole audit chain on every write-class tool call would
 * be wasteful, so the scan is gated: it only runs when the counter has
 * actually reached the threshold (the rare case). Below the threshold
 * the CLI just bumps the counter and exits.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  loadDelegationRecords,
  listRotatedAuditFiles,
  type DelegationRecord,
} from './audit-specialists.js';
import {
  discoverRoster,
  countsAsRealDelegation,
  DEFAULT_EXEMPT_SUBAGENTS,
} from './roster.js';
import { REA_DIR } from './utils.js';
import { resolveHookRoots } from '../lib/worktree-roots.js';

/**
 * Hook payload shape (untrusted). Claude Code's PostToolUse hook for
 * the write-class tools sends at least `tool_name` + `session_id`; we
 * defensively type every field as `unknown`.
 */
interface DelegationAdvisoryStdinPayload {
  tool_name?: unknown;
  session_id?: unknown;
}

/**
 * Resolved `policy.delegation_advisory` knobs the CLI actually acts on.
 * Defaults mirror `DelegationAdvisoryPolicySchema` in
 * `src/policy/loader.ts` — kept in sync by hand; the policy-schema test
 * pins both so drift fails loud.
 */
interface ResolvedAdvisoryPolicy {
  enabled: boolean;
  threshold: number;
  exemptSubagents: readonly string[];
}

const DEFAULT_THRESHOLD = 25;

export interface HookDelegationAdvisoryOptions {
  /**
   * Override REA_ROOT. Tests set this; the production caller relies on
   * `$CLAUDE_PROJECT_DIR` or `process.cwd()`.
   */
  reaRoot?: string;
  /**
   * Test seam — inject the resolved policy instead of reading
   * `.rea/policy.yaml`. Production omits; the CLI reads policy itself.
   */
  policyOverride?: ResolvedAdvisoryPolicy;
  /**
   * Test seam — inject stdin instead of reading the real stream.
   * Production omits.
   */
  stdinOverride?: string;
  /**
   * Test seam — override the sleep used by
   * `sessionHasRealDelegation`'s poll-and-backoff loop. Production
   * omits and uses real `setTimeout`-backed sleeps; tests pass a
   * controllable fake so the race-coverage tests don't wall-clock on
   * the real 500ms budget.
   *
   * 0.40.0 charter item 1.
   */
  sleepOverride?: (ms: number) => Promise<void>;
}

/**
 * Backoff schedule (in milliseconds) for `sessionHasRealDelegation`'s
 * poll-and-backoff loop.
 *
 * 0.40.0 charter item 1 — closes the `& disown` race between
 * `delegation-capture.sh` (which fire-and-forgets `rea hook
 * delegation-signal --detach &` for sub-50ms PreToolUse latency) and the
 * `delegation-advisory.sh` PostToolUse path (which reads the audit log
 * to decide whether the session has delegated). A `git commit` landing
 * within the narrow window between an Agent dispatch and the audit
 * append-on-disk would read the stale chain, see no delegation, fire
 * the nudge spuriously, AND write the `.fired` sentinel — silencing
 * every future advisory in the session even though delegation DID
 * happen.
 *
 * The schedule is delays BETWEEN re-reads (NOT cumulative): 50ms,
 * 150ms, 300ms. Total worst-case 500ms — acceptable hot-path budget
 * for a PostToolUse hook running on `Bash|Edit|Write|MultiEdit|
 * NotebookEdit`. The first read is immediate (no upfront delay), so a
 * session that DID delegate before threshold-crossing pays zero extra
 * latency. Only the rare "we crossed threshold while a recent
 * delegation signal hasn't yet hit disk" case pays the full budget,
 * and only ONCE per session (the `.fired` sentinel suppresses future
 * scans).
 *
 * Exported for the race-coverage test in
 * `delegation-advisory.test.ts` so it can assert on the schedule
 * without duplicating the constant.
 */
export const DELEGATION_POLL_BACKOFF_MS: readonly number[] = [50, 150, 300];

/**
 * Maximum length of the human-readable prefix in a state key. The full
 * key is `<prefix>-<16-hex-hash>`, so a 64-char cap keeps basenames well
 * under any filesystem limit while staying glanceable.
 */
const STATE_KEY_PREFIX_CAP = 64;

/**
 * Derive a filesystem-safe, **collision-free** per-session state-key
 * basename from an untrusted session id.
 *
 * Shape: `<readable-prefix>-<hash>` where
 *
 *   - `<readable-prefix>` is the raw id with every byte outside
 *     `[A-Za-z0-9._-]` replaced by `_`, length-capped at
 *     `STATE_KEY_PREFIX_CAP`. Path-traversal basenames (`.`, `..`) and
 *     an empty/all-stripped result collapse to `unknown`. This half is
 *     purely for human glanceability of the `.rea/.delegation-advisory/`
 *     directory — it is intentionally lossy.
 *   - `<hash>` is the first 16 hex chars of `sha256(raw)`. This is the
 *     correctness half: the sanitized prefix alone is lossy (`a/b` and
 *     `a:b` both sanitize to `a_b`), so without the hash two distinct
 *     sessions would share `count`/`fired` files — one could inherit the
 *     other's counter or suppress the other's advisory. The hash is
 *     computed over the RAW id, so distinct raw ids always get distinct
 *     keys.
 *
 * A missing / empty / non-string id returns the fixed key `unknown` (no
 * hash suffix) — every untagged session deliberately shares one counter,
 * matching the `'unknown'` audit-form id `runHookDelegationSignal`
 * records for the same sessions.
 *
 * The result is always a safe single path segment: no `/`, no `..`, no
 * leading dot beyond the literal `unknown`, bounded length.
 */
export function sessionStateKey(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  let prefix = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, STATE_KEY_PREFIX_CAP);
  // A prefix of `.` / `..` (or an all-stripped empty prefix) would make
  // the basename start with a traversal-looking token; normalize it.
  // The hash suffix still guarantees uniqueness, so this only affects
  // the readable half.
  if (prefix.length === 0 || prefix === '.' || prefix === '..') prefix = 'session';
  return `${prefix}-${hash}`;
}

/**
 * Read `.rea/policy.yaml` and resolve the `delegation_advisory` block.
 * Uses the canonical YAML parser (same as `rea hook policy-get`) so
 * inline and block forms agree. A missing file / missing block / parse
 * error all resolve to `enabled: false` — the safe default is "the
 * nudge is off", matching the schema-layer default and the OSS-profile
 * posture.
 *
 * The policy loader's strict zod schema is NOT used here: this CLI runs
 * on EVERY write-class tool call and must never fail-loud on an
 * unrelated policy typo (that's `rea doctor`'s job). A best-effort
 * shallow read is the right posture for an advisory hook.
 */
function resolveAdvisoryPolicy(reaRoot: string): ResolvedAdvisoryPolicy {
  const off: ResolvedAdvisoryPolicy = {
    enabled: false,
    threshold: DEFAULT_THRESHOLD,
    exemptSubagents: DEFAULT_EXEMPT_SUBAGENTS,
  };
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch {
    return off;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return off;
  }
  if (parsed === null || typeof parsed !== 'object') return off;
  const block = (parsed as Record<string, unknown>)['delegation_advisory'];
  if (block === null || block === undefined || typeof block !== 'object') {
    return off;
  }
  const b = block as Record<string, unknown>;
  const enabled = b['enabled'] === true;
  if (!enabled) return off;
  let threshold = DEFAULT_THRESHOLD;
  if (typeof b['threshold'] === 'number' && Number.isInteger(b['threshold']) && b['threshold'] > 0) {
    threshold = b['threshold'];
  }
  let exemptSubagents: readonly string[] = DEFAULT_EXEMPT_SUBAGENTS;
  if (Array.isArray(b['exempt_subagents'])) {
    const list = b['exempt_subagents'].filter((x): x is string => typeof x === 'string');
    // An explicit empty list IS meaningful (the operator wants every
    // Agent delegation to count) — only fall back to the default when
    // the key is absent, which is the `=== DEFAULT` identity above.
    exemptSubagents = list;
  }
  return { enabled, threshold, exemptSubagents };
}

/**
 * Read the per-session counter. Missing file / unparseable contents →
 * 0. Never throws.
 */
function readCounter(counterPath: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(counterPath, 'utf8');
  } catch {
    return 0;
  }
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Write the per-session counter. Best-effort — a write failure is
 * swallowed (the next invocation just re-reads the stale value, which
 * at worst delays the nudge by one tool call).
 */
function writeCounter(counterPath: string, value: number): void {
  try {
    fs.writeFileSync(counterPath, `${String(value)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * The advisory text. Factored out so the test can assert on it without
 * duplicating the prose. Printed to stderr (the hook's only output
 * channel) exactly once per session.
 */
export function advisoryMessage(count: number, threshold: number): string {
  return (
    `\nrea: DELEGATION ADVISORY\n` +
    `  This session has run ${String(count)} write-class tool calls ` +
    `(Bash/Edit/Write/MultiEdit/NotebookEdit) — at or past the configured ` +
    `threshold of ${String(threshold)} — without dispatching a curated ` +
    `specialist.\n` +
    `  rea's engineering model routes non-trivial work through the ` +
    `rea-orchestrator agent (or a domain specialist from .claude/agents/).\n` +
    `  Consider whether the remaining work would benefit from a specialist: ` +
    `plan/build/review loops, adversarial review, domain expertise.\n` +
    `  This is advisory only — it never blocks a tool call, and it fires ` +
    `at most once per session. Set policy.delegation_advisory.enabled: false ` +
    `to silence it.\n`
  );
}

/**
 * Scan the audit chain for a REAL delegation signal in the current
 * session. Returns `true` as soon as one is found (short-circuits).
 *
 * "Real" per `countsAsRealDelegation`: every `Skill` signal counts; an
 * `Agent` signal counts when its `subagent_type` is a discovered
 * curated specialist (live `.claude/agents/` roster) and not in the
 * exempt set.
 *
 * Reuses `loadDelegationRecords` from `audit-specialists.ts` so the
 * audit-record parsing / session filtering logic has a single home.
 *
 * # Rotated segments (0.31.0 round-2 P3)
 *
 * The scan walks rotated audit segments, not just the current
 * `.rea/audit.jsonl`. A long session can outlive an audit rotation: its
 * early `rea.delegation_signal` records land in a rotated file, and only
 * later write-class calls land in the current `audit.jsonl`. Scanning
 * the current file alone would miss that delegation and fire a
 * false-positive nudge at a session that DID delegate. We resolve the
 * full rotated set via `listRotatedAuditFiles` (the same resolution
 * `rea audit specialists --since` uses) and hand the EARLIEST rotated
 * filename to `loadDelegationRecords` as its `since` anchor —
 * `resolveAuditFileWalk` then walks that file, every later rotated file,
 * and the current `audit.jsonl` as the tail. No rotated files → the
 * `since` anchor is `undefined` and behavior is the pre-0.31.0
 * single-file walk.
 */
/**
 * Real-clock sleep used by the production poll-and-backoff loop.
 * Factored out so tests can swap it for a fake controllable scheduler
 * via `HookDelegationAdvisoryOptions.sleepOverride`.
 */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single audit-chain scan: returns `'delegated'` when a real
 * delegation signal is found, `'not-delegated'` when scanning succeeds
 * but no real signal is in the chain, and `'unreadable'` when audit
 * loading throws (the chain is missing / unreadable). Split out from
 * the polling loop so each retry runs identical scan logic.
 */
async function scanForRealDelegationOnce(
  reaRoot: string,
  sessionId: string,
  exemptSubagents: readonly string[],
  streamRoot?: string,
): Promise<'delegated' | 'not-delegated' | 'unreadable'> {
  let records: DelegationRecord[];
  try {
    // Resolve the rotated-file set the same way `rea audit specialists`
    // does. The earliest rotated filename is the `since` anchor:
    // `resolveAuditFileWalk` walks from it forward through every later
    // rotated segment, then the current `audit.jsonl`.
    const rotated = await listRotatedAuditFiles(path.join(reaRoot, REA_DIR));
    const sinceAnchor = rotated.length > 0 ? rotated[0] : undefined;
    const loaded = await loadDelegationRecords(reaRoot, sessionId, sinceAnchor);
    records = loaded.records;
  } catch {
    return 'unreadable';
  }
  if (records.length === 0) return 'not-delegated';
  const roster = discoverRoster(reaRoot);
  for (const rec of records) {
    // Round-27 P3: stream scoping — with per-worktree counters, a
    // delegation observed in a SIBLING worktree must not satisfy this
    // stream's predicate. Records without local_root (pre-0.54.0)
    // match every stream (transition posture).
    if (
      streamRoot !== undefined &&
      rec.local_root !== undefined &&
      path.resolve(rec.local_root) !== path.resolve(streamRoot)
    ) {
      continue;
    }
    if (
      countsAsRealDelegation({
        delegationTool: rec.delegation_tool,
        subagentType: rec.subagent_type,
        roster,
        exempt: exemptSubagents,
      })
    ) {
      return 'delegated';
    }
  }
  return 'not-delegated';
}

async function sessionHasRealDelegation(
  reaRoot: string,
  sessionId: string,
  exemptSubagents: readonly string[],
  sleep: (ms: number) => Promise<void> = realSleep,
  streamRoot?: string,
): Promise<boolean> {
  // 0.40.0 charter item 1 — poll-and-backoff before declaring
  // "no delegation in this session".
  //
  // The producer (`delegation-capture.sh`) calls `rea hook
  // delegation-signal --detach &` to fire-and-forget the audit append.
  // For sub-50ms PreToolUse latency this is the right call, but it
  // opens a narrow race: a write-class call (Bash/Edit/Write/…)
  // landing in the same tick as an Agent/Skill dispatch can run this
  // predicate BEFORE the audit append commits to disk. Pre-fix, the
  // function then returned `false`, the caller fired the advisory,
  // wrote the `.fired` sentinel, and silenced every future nudge in
  // the session — even though delegation DID happen.
  //
  // Each retry runs a full audit scan. The first scan is immediate
  // (no upfront delay); subsequent scans wait per
  // `DELEGATION_POLL_BACKOFF_MS`. Worst-case total: 50+150+300 = 500ms
  // for the four-scan path. We exit early as soon as a delegation is
  // observed OR the chain becomes unreadable (preserving the pre-fix
  // "audit log unreadable → suppress the advisory" posture so a
  // missing chain never produces a false-positive nudge).
  let outcome = await scanForRealDelegationOnce(reaRoot, sessionId, exemptSubagents, streamRoot);
  if (outcome === 'delegated') return true;
  if (outcome === 'unreadable') return true;
  for (const waitMs of DELEGATION_POLL_BACKOFF_MS) {
    await sleep(waitMs);
    outcome = await scanForRealDelegationOnce(reaRoot, sessionId, exemptSubagents, streamRoot);
    if (outcome === 'delegated') return true;
    if (outcome === 'unreadable') return true;
  }
  return false;
}

/**
 * Read stdin synchronously to EOF. The hook shim feeds a small JSON
 * blob; a bounded read is fine. Returns '' on any error or when stdin
 * is a TTY (no harness payload).
 */
function readStdinSync(): string {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Core logic, exported for direct unit testing without spawning a
 * process. Returns the action taken so tests can assert without
 * capturing stderr.
 */
export interface DelegationAdvisoryResult {
  /** `'disabled'` when policy is off; `'halt'` under HALT; otherwise `'ran'`. */
  outcome: 'disabled' | 'halt' | 'ran' | 'no-payload';
  /** The HALT reason (whichever root held the file) when outcome is 'halt'. */
  haltReason?: string;
  /** Post-increment counter value (only meaningful when `outcome === 'ran'`). */
  count?: number;
  /** `true` when the advisory was printed this invocation. */
  fired?: boolean;
  /**
   * The `sessionStateKey()`-derived filesystem basename used for the
   * `.count` / `.fired` state files (`<readable-prefix>-<hash>`, or the
   * literal `unknown` for an untagged session). Collision-free across
   * distinct raw session ids. Field name kept as `sessionId` for
   * backward-compatible result-shape; it is a state key, not the raw id.
   */
  sessionId?: string;
}

export async function computeDelegationAdvisory(
  options: HookDelegationAdvisoryOptions,
): Promise<DelegationAdvisoryResult> {
  // 0.54.0 worktree state (review round-1 P2): stdin is read FIRST so
  // the payload's `cwd` feeds root resolution — otherwise a Claude
  // worktree session resolves CLAUDE_PROJECT_DIR (the primary checkout)
  // and every stream shares one advisory counter, letting activity in
  // one stream trigger or suppress the nudge in another. Session state
  // + policy key off the LOCAL root; the audit scan ("did this session
  // delegate") reads the COMMON root, where delegation-capture writes
  // the shared chain; the kill switch probes BOTH roots.
  // Round-29 P2: probe HALT via the env ladder BEFORE touching stdin —
  // readStdinSync blocks until EOF, and a caller that never closes the
  // pipe would hang this hook past an active freeze. The payload-aware
  // dual-root probe below still runs after parsing (it can see a
  // worktree-local legacy HALT the env ladder cannot).
  {
    const pre = resolveHookRoots(undefined, options.reaRoot);
    const preHit = [
      path.join(pre.localRoot, '.rea', 'HALT'),
      path.join(pre.commonRoot, '.rea', 'HALT'),
    ].find((f) => fs.existsSync(f));
    if (preHit !== undefined) {
      let haltReason = 'Reason unknown';
      try {
        const contents = fs.readFileSync(preHit, 'utf8').slice(0, 1024).trim();
        if (contents.length > 0) haltReason = contents;
      } catch {
        /* keep the placeholder */
      }
      return { outcome: 'halt', haltReason };
    }
  }
  const stdinRawEarly = options.stdinOverride ?? readStdinSync();
  let payloadCwdEarly = '';
  try {
    const peeked = JSON.parse(stdinRawEarly) as { cwd?: unknown };
    if (peeked !== null && typeof peeked === 'object' && typeof peeked.cwd === 'string') {
      payloadCwdEarly = peeked.cwd;
    }
  } catch {
    // Malformed stdin is handled below (observational no-payload path);
    // root resolution just falls down the ladder.
  }
  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(
    payloadCwdEarly.length > 0 ? payloadCwdEarly : undefined,
    options.reaRoot,
  );

  // HALT check — uniform with the rest of the hook tree. The advisory
  // hook is observational, but refusing to run while frozen keeps the
  // kill-switch contract simple: every hook exits 2 under HALT.
  const haltFileHit = [
    path.join(reaRoot, '.rea', 'HALT'),
    path.join(commonRoot, '.rea', 'HALT'),
  ].find((f) => fs.existsSync(f));
  if (haltFileHit !== undefined) {
    // Round-14 P3: carry the ACTUAL reason (and which file held it) so
    // the banner does not degrade to "Reason unknown" when the freeze
    // is repo-wide and lives at the common root.
    let haltReason = 'Reason unknown';
    try {
      const contents = fs.readFileSync(haltFileHit, 'utf8').slice(0, 1024).trim();
      if (contents.length > 0) haltReason = contents;
    } catch {
      /* keep the placeholder */
    }
    return { outcome: 'halt', haltReason };
  }

  const policy =
    options.policyOverride ?? resolveAdvisoryPolicy(reaRoot);
  if (!policy.enabled) {
    return { outcome: 'disabled' };
  }

  const stdinRaw = stdinRawEarly;
  if (stdinRaw.length === 0) {
    // No payload — nothing to count. Exit clean.
    return { outcome: 'no-payload' };
  }
  let payload: DelegationAdvisoryStdinPayload;
  try {
    payload = JSON.parse(stdinRaw) as DelegationAdvisoryStdinPayload;
  } catch {
    // Malformed payload — observational hook, swallow and exit clean.
    return { outcome: 'no-payload' };
  }

  // Two forms of the session id, deliberately kept distinct:
  //
  //   - `auditSessionId` — the value to match against the audit log's
  //     `session_id_observed` field. This MUST be byte-identical to what
  //     `delegation-capture.sh` → `runHookDelegationSignal` recorded:
  //     the untrusted `session_id` verbatim when it is a non-empty
  //     string, and the literal `'unknown'` when it is missing / empty /
  //     non-string. Mirroring that exact fallback is load-bearing —
  //     using a bare `''` here would never match the `'unknown'` records
  //     the capture hook writes for untagged sessions, so EVERY untagged
  //     session that had actually delegated would still get a
  //     false-positive nudge once its counter crossed the threshold.
  //     (See `runHookDelegationSignal` in `hook.ts` for the canonical
  //     fallback this kept in sync with — the policy-schema-style "kept
  //     in sync by hand" contract.)
  //   - `stateKey` — the `sessionStateKey()`-derived filesystem basename
  //     (`<readable-prefix>-<sha256-hash>`). Used ONLY to build paths
  //     under `.rea/.delegation-advisory/`. NEVER used for audit
  //     matching, and — unlike a bare sanitized id — collision-free, so
  //     two sessions whose ids only differ in characters sanitization
  //     would flatten (`a/b` vs `a:b`) still get distinct state files.
  const auditSessionId =
    typeof payload.session_id === 'string' && payload.session_id.length > 0
      ? payload.session_id
      : 'unknown';
  const stateKey = sessionStateKey(payload.session_id);

  // State directory. Best-effort mkdir — a failure here means we can't
  // keep a counter, so we exit clean (the nudge is lost, tool dispatch
  // is not).
  const stateDir = path.join(reaRoot, '.rea', '.delegation-advisory');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {
    return { outcome: 'ran', count: 0, fired: false, sessionId: stateKey };
  }
  const counterPath = path.join(stateDir, `${stateKey}.count`);
  const firedPath = path.join(stateDir, `${stateKey}.fired`);

  // Increment the counter for this write-class tool call.
  const next = readCounter(counterPath) + 1;
  writeCounter(counterPath, next);

  // Below threshold → nothing more to do. This is the hot path: no
  // audit scan, no roster discovery.
  if (next < policy.threshold) {
    return { outcome: 'ran', count: next, fired: false, sessionId: stateKey };
  }

  // Already fired this session → never fire twice.
  if (fs.existsSync(firedPath)) {
    return { outcome: 'ran', count: next, fired: false, sessionId: stateKey };
  }

  // At/past threshold and not yet fired — run the (rare) audit scan to
  // decide whether the session has actually delegated. Pass the
  // audit-form session id: audit records store the untrusted value
  // verbatim (or `'unknown'` for untagged sessions), so the `stateKey`
  // filesystem form would never match (see the comment at the
  // `auditSessionId` / `stateKey` split above).
  const delegated = await sessionHasRealDelegation(
    commonRoot,
    auditSessionId,
    policy.exemptSubagents,
    options.sleepOverride,
    reaRoot,
  );
  if (delegated) {
    // Session DID delegate to a real specialist — no nudge warranted.
    // We deliberately do NOT write the `.fired` sentinel here: if the
    // session later stops delegating and keeps piling on write-class
    // calls, a future invocation should still be able to nudge. (The
    // counter keeps climbing; the predicate is re-evaluated each time
    // past the threshold.)
    return { outcome: 'ran', count: next, fired: false, sessionId: stateKey };
  }

  // Fire the advisory. Write the sentinel FIRST so a crash between the
  // print and the sentinel-write doesn't cause a double-fire on the
  // next call — at-most-once is the contract, and a missed nudge is
  // better than a repeated one.
  try {
    fs.writeFileSync(firedPath, `${new Date().toISOString()}\n`, 'utf8');
  } catch {
    // Can't write the sentinel — fire anyway, but accept the small
    // risk of a second fire. Still better than never nudging.
  }
  process.stderr.write(advisoryMessage(next, policy.threshold));
  return { outcome: 'ran', count: next, fired: true, sessionId: stateKey };
}

/**
 * Commander entrypoint. Reads the hook payload, runs the advisory
 * logic, exits.
 *
 * Exit-code contract:
 *   0 — always, EXCEPT HALT. Disabled, no-payload, below-threshold,
 *       already-fired, just-fired — all exit 0. The advisory is a
 *       nudge, never a gate.
 *   2 — HALT active (kill-switch contract uniform with the hook tree).
 */
export async function runHookDelegationAdvisory(
  options: HookDelegationAdvisoryOptions = {},
): Promise<void> {
  const reaRoot =
    options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  const result = await computeDelegationAdvisory(options);
  if (result.outcome === 'halt') {
    // Surface the HALT reason — carried from whichever root held the
    // file (round-14 P3: a repo-wide freeze lives at the common root).
    let reason = result.haltReason ?? 'Reason unknown';
    if (result.haltReason === undefined) {
      try {
        const content = fs.readFileSync(path.join(reaRoot, '.rea', 'HALT'), 'utf8');
        reason = content.slice(0, 1024).trim() || reason;
      } catch {
        /* leave default */
      }
    }
    process.stderr.write(
      `REA HALT: ${reason}\nAll agent operations suspended. Run: rea unfreeze\n`,
    );
    process.exit(2);
  }
  process.exit(0);
}
