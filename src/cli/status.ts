/**
 * `rea status` — running-process introspection for `rea serve` (G5).
 *
 * `rea check` is the ON-DISK view: policy, HALT, recent audit entries. It
 * works when no gateway is running.
 *
 * `rea status` is the LIVE view: is a gateway running for this cwd? What is
 * its session id? What does the audit chain look like right now? Is HALT
 * active?
 *
 * Detection strategy for "is serve running":
 *   1. Read `.rea/serve.pid`.
 *   2. If the pidfile exists, `kill(pid, 0)` to check liveness.
 *   3. If kill throws ESRCH or EPERM, the pid is stale — treat as not-running
 *      and surface that nuance in the output.
 *
 * Output modes:
 *   - Default: human-pretty, matching the spacing used by `rea check`.
 *   - `--json`: canonical JSON object, composable with jq and future tooling.
 *
 * This command is read-only. It does NOT clean up stale pidfiles (the serve
 * process is the only writer). It does NOT run the full audit verifier —
 * `rea audit verify` is the authoritative check and is expensive on large
 * chains; here we just report line count, last timestamp, and a cheap "last
 * record's stored hash is non-empty" heuristic as an integrity smoke signal.
 */

import fs from 'node:fs';
import { loadPolicy } from '../policy/loader.js';
import {
  AUDIT_FILE,
  HALT_FILE,
  POLICY_FILE,
  REA_DIR,
  SERVE_PID_FILE,
  SERVE_STATE_FILE,
  err,
  exitWithMissingPolicy,
  log,
  reaPath,
} from './utils.js';

/**
 * Tail window size for the audit summary. 64 KiB is more than enough to
 * hold the last audit record (typical record ≪ 1 KiB) but small enough
 * that reading it never spikes memory even on a multi-hundred-MB chain.
 */
const AUDIT_TAIL_WINDOW_BYTES = 64 * 1024;

/**
 * Strip every ASCII control code (C0 plus DEL) from a string. Defense
 * against ANSI/OSC escape injection when a disk-controlled field reaches
 * the operator's terminal via `console.log` in pretty mode.
 *
 * This is strict: every byte in 0x00-0x1F plus 0x7F is replaced with `?`.
 * That drops CR/LF/TAB inside fields, which is fine — the fields this
 * helper guards (halt_reason, session_id, started_at, last_timestamp,
 * profile) are short identifiers or trimmed reasons, not multi-line
 * narratives. Preserving TAB/LF would reopen the ESC+... attack surface
 * because ANSI sequences begin with ESC (0x1B).
 *
 * SECURITY: Only pretty-print paths call this — JSON mode must not, since
 * JSON.stringify already escapes control chars safely (`\u0000`), and a
 * double-pass would corrupt legitimate audit values for downstream jq
 * consumers.
 *
 * Exported so unit tests can assert the exact sanitization behavior.
 */
export function sanitizeForTerminal(value: string): string {
  return value.replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/g, '?');
}

/**
 * Null-safe wrapper for {@link sanitizeForTerminal} so call sites don't
 * need a ternary at every disk-sourced field.
 */
function safePretty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return sanitizeForTerminal(value);
}

export interface StatusOptions {
  json?: boolean | undefined;
}

/**
 * Per-downstream live state surfaced in both JSON and pretty outputs
 * (0.9.0, BUG-005). Mirrors `LiveDownstreamState` in
 * `src/gateway/live-state.ts`; duplicated here to keep the CLI surface
 * independent of gateway internals (the CLI can be built without the
 * gateway module in a trimmed install).
 */
export interface LiveDownstreamSnapshot {
  name: string;
  connected: boolean;
  healthy: boolean;
  circuit_state: 'closed' | 'open' | 'half-open';
  retry_at: string | null;
  last_error: string | null;
  tools_count: number | null;
  open_transitions: number;
  session_blocker_emitted: boolean;
}

interface ServeLiveness {
  running: boolean;
  pid: number | null;
  /** When pidfile exists but the process isn't responsive. */
  stale: boolean;
  /** From `.rea/serve.state.json`, when present. */
  session_id: string | null;
  started_at: string | null;
  metrics_port: number | null;
  /**
   * 0.9.0 — per-downstream live block, or `null` when the state file was
   * written by an older gateway version that did not include it. A
   * zero-length array means "gateway is running with no downstreams
   * configured", which is a distinct signal from "unknown".
   */
  downstreams: LiveDownstreamSnapshot[] | null;
}

interface AuditStats {
  present: boolean;
  lines: number;
  last_timestamp: string | null;
  /** Cheap chain smoke: last record has a 64-char hex hash. NOT a full verify. */
  tail_hash_looks_valid: boolean;
}

interface PolicySummary {
  profile: string;
  autonomy_level: string;
  blocked_paths_count: number;
  codex_required: boolean;
  halt_active: boolean;
  halt_reason: string | null;
}

interface StatusPayload {
  base_dir: string;
  serve: ServeLiveness;
  policy: PolicySummary;
  audit: AuditStats;
}

/** Returns true if the OS confirms a live process at `pid`. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 tests existence without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to another user — for our
    // purposes (was-it-started-on-this-machine), that still counts as alive.
    // ESRCH means no such process.
    if (code === 'EPERM') return true;
    return false;
  }
}

function readPidfile(baseDir: string): number | null {
  const p = reaPath(baseDir, SERVE_PID_FILE);
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

interface ServeStateOnDisk {
  session_id?: unknown;
  started_at?: unknown;
  metrics_port?: unknown;
  downstreams?: unknown;
}

/**
 * Parse a single downstream entry from `serve.state.json`. Every field is
 * validated — an unexpected type yields a null for that field rather than
 * poisoning the whole entry, because the state file is touched on a hot
 * path and we would rather surface a half-useful snapshot than a
 * "corrupt, try again" error to the operator.
 *
 * Returns `null` when the entry's `name` is missing or not a string, since
 * a downstream with no name is unusable for display.
 */
function parseDownstreamEntry(raw: unknown): LiveDownstreamSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0) return null;
  const circuit =
    r.circuit_state === 'open' || r.circuit_state === 'half-open' || r.circuit_state === 'closed'
      ? (r.circuit_state as 'closed' | 'open' | 'half-open')
      : 'closed';
  return {
    name: r.name,
    connected: typeof r.connected === 'boolean' ? r.connected : false,
    healthy: typeof r.healthy === 'boolean' ? r.healthy : false,
    circuit_state: circuit,
    retry_at: typeof r.retry_at === 'string' ? r.retry_at : null,
    last_error: typeof r.last_error === 'string' ? r.last_error : null,
    tools_count:
      typeof r.tools_count === 'number' && Number.isInteger(r.tools_count) ? r.tools_count : null,
    open_transitions:
      typeof r.open_transitions === 'number' && Number.isInteger(r.open_transitions)
        ? r.open_transitions
        : 0,
    session_blocker_emitted:
      typeof r.session_blocker_emitted === 'boolean' ? r.session_blocker_emitted : false,
  };
}

function readServeState(baseDir: string): {
  session_id: string | null;
  started_at: string | null;
  metrics_port: number | null;
  downstreams: LiveDownstreamSnapshot[] | null;
} {
  const p = reaPath(baseDir, SERVE_STATE_FILE);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as ServeStateOnDisk;
    let downstreams: LiveDownstreamSnapshot[] | null = null;
    if (Array.isArray(parsed.downstreams)) {
      downstreams = [];
      for (const entry of parsed.downstreams) {
        const ds = parseDownstreamEntry(entry);
        if (ds !== null) downstreams.push(ds);
      }
    }
    return {
      session_id: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      started_at: typeof parsed.started_at === 'string' ? parsed.started_at : null,
      metrics_port:
        typeof parsed.metrics_port === 'number' && Number.isInteger(parsed.metrics_port)
          ? parsed.metrics_port
          : null,
      downstreams,
    };
  } catch {
    return { session_id: null, started_at: null, metrics_port: null, downstreams: null };
  }
}

function probeServe(baseDir: string): ServeLiveness {
  const pid = readPidfile(baseDir);
  if (pid === null) {
    // No pidfile — serve isn't running (at least not via `rea serve`).
    return {
      running: false,
      pid: null,
      stale: false,
      session_id: null,
      started_at: null,
      metrics_port: null,
      downstreams: null,
    };
  }
  const alive = isProcessAlive(pid);
  const state = readServeState(baseDir);
  return {
    running: alive,
    pid,
    stale: !alive,
    session_id: state.session_id,
    started_at: state.started_at,
    metrics_port: state.metrics_port,
    downstreams: state.downstreams,
  };
}

/**
 * Count newline bytes in the file via a streaming read. O(file-size) in
 * wall-clock but O(chunk-size) in memory — production chains can reach
 * hundreds of MB; we must never hold the full file in a Buffer.
 */
function countLinesStreaming(filePath: string): number {
  let count = 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) count++;
      }
    }
  } catch {
    // Partial result is still useful; return whatever we counted.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignored */
      }
    }
  }
  return count;
}

/**
 * Read up to `windowBytes` from the end of the file. Uses `pread` via a
 * positioned `readSync` so we never materialize more than the window into
 * memory, regardless of file size. The window is intentionally generous
 * (default 64 KiB) vs. a typical ~200-byte audit record so the tail line
 * is always fully represented.
 */
function readTailBytes(filePath: string, windowBytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return '';
    const toRead = Math.min(windowBytes, stat.size);
    const buf = Buffer.alloc(toRead);
    const start = stat.size - toRead;
    fs.readSync(fd, buf, 0, toRead, start);
    return buf.toString('utf8');
  } catch {
    return '';
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
 * Quickly compute audit stats without running the full verifier. Memory
 * posture:
 *   - Line count is computed with a streaming newline scan (64 KiB chunk
 *     buffer, regardless of total file size).
 *   - `last_timestamp` + `tail_hash_looks_valid` come from a 64-KiB tail
 *     window read via `readSync` at a positive offset — we never
 *     materialize the full file.
 *
 * Missing / corrupt / empty files degrade to "present: false" or
 * "lines: 0".
 */
function summarizeAudit(baseDir: string): AuditStats {
  const p = reaPath(baseDir, AUDIT_FILE);
  if (!fs.existsSync(p)) {
    return { present: false, lines: 0, last_timestamp: null, tail_hash_looks_valid: false };
  }

  // Streaming line count — O(file-size) CPU, O(chunk) memory.
  // NOTE: countLinesStreaming and readTailBytes open the file independently.
  // A concurrent append between the two opens can produce a `lines` count
  // that is one higher than the tail record implies. This is a display-only
  // function; the inconsistency is cosmetic and intentionally accepted.
  const lineCount = countLinesStreaming(p);

  // Tail-window scan for the last JSON record. If the last window isn't
  // large enough to contain a full record (extremely rare: record >64 KiB),
  // we degrade gracefully — the JSON parse just fails and we emit null.
  const tailWindow = readTailBytes(p, AUDIT_TAIL_WINDOW_BYTES);
  if (tailWindow.length === 0) {
    return {
      present: true,
      lines: lineCount,
      last_timestamp: null,
      tail_hash_looks_valid: false,
    };
  }

  // Find the last complete line. The first line in the window may be a
  // partial record (we sliced mid-line); ignore it by finding the last
  // newline-terminated segment.
  const windowLines = tailWindow.split('\n').filter((line) => line.length > 0);
  const tail = windowLines[windowLines.length - 1];

  let last_timestamp: string | null = null;
  let tail_hash_looks_valid = false;
  if (tail !== undefined) {
    try {
      const rec = JSON.parse(tail) as { timestamp?: unknown; hash?: unknown };
      if (typeof rec.timestamp === 'string') last_timestamp = rec.timestamp;
      if (typeof rec.hash === 'string' && /^[0-9a-f]{64}$/i.test(rec.hash)) {
        tail_hash_looks_valid = true;
      }
    } catch {
      // Broken last line — leave both as default.
    }
  }
  return { present: true, lines: lineCount, last_timestamp, tail_hash_looks_valid };
}

/**
 * Build the canonical payload. Separate from print paths so the JSON and
 * pretty outputs stay in lockstep.
 */
export function computeStatusPayload(baseDir: string): StatusPayload {
  const policyPath = reaPath(baseDir, POLICY_FILE);
  if (!fs.existsSync(policyPath)) {
    exitWithMissingPolicy(policyPath);
  }

  const policy = loadPolicy(baseDir);
  const haltPath = reaPath(baseDir, HALT_FILE);
  const haltActive = fs.existsSync(haltPath);
  let haltReason: string | null = null;
  if (haltActive) {
    try {
      haltReason = fs.readFileSync(haltPath, 'utf8').trim();
    } catch {
      haltReason = null;
    }
  }

  return {
    base_dir: baseDir,
    serve: probeServe(baseDir),
    policy: {
      profile: policy.profile,
      autonomy_level: policy.autonomy_level,
      blocked_paths_count: policy.blocked_paths.length,
      codex_required: policy.review?.codex_required !== false,
      halt_active: haltActive,
      halt_reason: haltReason,
    },
    audit: summarizeAudit(baseDir),
  };
}

function printPretty(payload: StatusPayload): void {
  // Every terminal-bound string field flows through `safePretty` or
  // `sanitizeForTerminal` to prevent ANSI/OSC escape injection. This
  // includes `base_dir`: although it originates from `process.cwd()`, the
  // filesystem path is operator-controlled and a maliciously named directory
  // can embed ESC/OSC bytes that inject terminal sequences when printed.
  const p = payload.policy;
  const s = payload.serve;
  const a = payload.audit;

  const baseDir = sanitizeForTerminal(payload.base_dir);
  const profile = sanitizeForTerminal(p.profile);
  const autonomy = sanitizeForTerminal(p.autonomy_level);
  const haltReason = safePretty(p.halt_reason);

  const sessionId = safePretty(s.session_id);
  const startedAt = safePretty(s.started_at);

  const lastTimestamp = safePretty(a.last_timestamp);

  console.log('');
  log(`Status — ${baseDir}`);
  console.log('');
  console.log('  Policy');
  console.log(`    Profile:            ${profile}`);
  console.log(`    Autonomy:           ${autonomy}`);
  console.log(`    Blocked paths:      ${p.blocked_paths_count} entries`);
  console.log(`    Codex required:     ${p.codex_required ? 'yes' : 'no'}`);
  if (p.halt_active) {
    console.log(`    HALT:               ACTIVE`);
    if (haltReason !== null) {
      console.log(`                        ${haltReason}`);
    }
  } else {
    console.log(`    HALT:               inactive`);
  }
  console.log('');

  console.log('  rea serve');
  if (!s.running) {
    if (s.pid !== null && s.stale) {
      console.log(`    Running:            no (stale pidfile — pid ${s.pid})`);
    } else {
      console.log(`    Running:            no`);
    }
  } else {
    console.log(`    Running:            yes (pid ${s.pid ?? '?'})`);
    if (sessionId !== null) {
      console.log(`    Session id:         ${sessionId}`);
    }
    if (startedAt !== null) {
      console.log(`    Started at:         ${startedAt}`);
    }
    if (s.metrics_port !== null) {
      console.log(`    Metrics endpoint:   http://127.0.0.1:${s.metrics_port}/metrics`);
    } else {
      console.log(`    Metrics endpoint:   disabled (set REA_METRICS_PORT to enable)`);
    }
  }
  console.log('');

  // 0.9.0 — per-downstream block. Only shown when the serve process is
  // believed to be running AND the state file carried the new array. An
  // older gateway version that predates the publisher leaves `downstreams`
  // null; we print an explanatory hint instead of rendering an empty
  // table that looks like "zero downstreams".
  if (s.running) {
    console.log('  Downstreams');
    if (s.downstreams === null) {
      console.log(`    (state file has no downstream block — upgrade gateway to ≥0.9.0)`);
    } else if (s.downstreams.length === 0) {
      console.log(`    (no downstream servers declared in .rea/registry.yaml)`);
    } else {
      for (const d of s.downstreams) {
        const name = sanitizeForTerminal(d.name);
        const lastErr = safePretty(d.last_error);
        const retryAt = safePretty(d.retry_at);
        const healthToken = d.healthy ? (d.connected ? 'healthy' : 'connecting') : 'UNHEALTHY';
        const circuit = d.circuit_state.toUpperCase();
        console.log(`    ${name}`);
        console.log(`      Health:           ${healthToken}`);
        console.log(`      Circuit:          ${circuit}`);
        if (retryAt !== null && d.circuit_state === 'open') {
          console.log(`      Retry at:         ${retryAt}`);
        }
        if (d.tools_count !== null) {
          console.log(`      Tools advertised: ${d.tools_count}`);
        }
        if (d.open_transitions > 0) {
          const blockerSuffix = d.session_blocker_emitted ? ' (SESSION_BLOCKER fired)' : '';
          console.log(`      Open transitions: ${d.open_transitions}${blockerSuffix}`);
        }
        if (lastErr !== null) {
          console.log(`      Last error:       ${lastErr}`);
        }
      }
    }
    console.log('');
  }

  console.log('  Audit log');
  if (!a.present) {
    console.log(`    State:              not yet written`);
  } else if (a.lines === 0) {
    console.log(`    State:              empty`);
  } else {
    console.log(`    Lines:              ${a.lines}`);
    if (lastTimestamp !== null) {
      console.log(`    Last record at:     ${lastTimestamp}`);
    }
    console.log(
      `    Tail hash:          ${a.tail_hash_looks_valid ? 'looks valid' : 'unexpected shape — run `rea audit verify`'}`,
    );
  }
  console.log('');
}

function printJson(payload: StatusPayload): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

export function runStatus(options: StatusOptions = {}): void {
  const baseDir = process.cwd();

  let payload: StatusPayload;
  try {
    payload = computeStatusPayload(baseDir);
  } catch (e) {
    // `exitWithMissingPolicy` already handles the missing-policy path; any
    // other loadPolicy error reaches here.
    err(`Failed to build status: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (options.json === true) {
    printJson(payload);
  } else {
    printPretty(payload);
  }
}

// Exported so tests can construct the expected directory without duplicating
// the path segment.
export const INTERNAL = { REA_DIR };
