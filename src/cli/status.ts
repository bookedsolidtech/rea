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

export interface StatusOptions {
  json?: boolean | undefined;
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
}

function readServeState(baseDir: string): {
  session_id: string | null;
  started_at: string | null;
  metrics_port: number | null;
} {
  const p = reaPath(baseDir, SERVE_STATE_FILE);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as ServeStateOnDisk;
    return {
      session_id: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      started_at: typeof parsed.started_at === 'string' ? parsed.started_at : null,
      metrics_port:
        typeof parsed.metrics_port === 'number' && Number.isInteger(parsed.metrics_port)
          ? parsed.metrics_port
          : null,
    };
  } catch {
    return { session_id: null, started_at: null, metrics_port: null };
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
  };
}

/**
 * Quickly compute audit stats without running the full verifier. We read the
 * file's last non-empty line and JSON-parse it; missing / corrupt / empty
 * files degrade to "present: false" or "lines: 0".
 */
function summarizeAudit(baseDir: string): AuditStats {
  const p = reaPath(baseDir, AUDIT_FILE);
  if (!fs.existsSync(p)) {
    return { present: false, lines: 0, last_timestamp: null, tail_hash_looks_valid: false };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return { present: true, lines: 0, last_timestamp: null, tail_hash_looks_valid: false };
  }
  if (raw.length === 0) {
    return { present: true, lines: 0, last_timestamp: null, tail_hash_looks_valid: false };
  }
  const lines = raw.split('\n').filter((line) => line.length > 0);
  const tail = lines[lines.length - 1];
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
  return { present: true, lines: lines.length, last_timestamp, tail_hash_looks_valid };
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
  console.log('');
  log(`Status — ${payload.base_dir}`);
  console.log('');
  console.log('  Policy');
  console.log(`    Profile:            ${payload.policy.profile}`);
  console.log(`    Autonomy:           ${payload.policy.autonomy_level}`);
  console.log(`    Blocked paths:      ${payload.policy.blocked_paths_count} entries`);
  console.log(`    Codex required:     ${payload.policy.codex_required ? 'yes' : 'no'}`);
  if (payload.policy.halt_active) {
    console.log(`    HALT:               ACTIVE`);
    if (payload.policy.halt_reason !== null) {
      console.log(`                        ${payload.policy.halt_reason}`);
    }
  } else {
    console.log(`    HALT:               inactive`);
  }
  console.log('');

  console.log('  rea serve');
  if (!payload.serve.running) {
    if (payload.serve.pid !== null && payload.serve.stale) {
      console.log(`    Running:            no (stale pidfile — pid ${payload.serve.pid})`);
    } else {
      console.log(`    Running:            no`);
    }
  } else {
    console.log(`    Running:            yes (pid ${payload.serve.pid ?? '?'})`);
    if (payload.serve.session_id !== null) {
      console.log(`    Session id:         ${payload.serve.session_id}`);
    }
    if (payload.serve.started_at !== null) {
      console.log(`    Started at:         ${payload.serve.started_at}`);
    }
    if (payload.serve.metrics_port !== null) {
      console.log(`    Metrics endpoint:   http://127.0.0.1:${payload.serve.metrics_port}/metrics`);
    } else {
      console.log(`    Metrics endpoint:   disabled (set REA_METRICS_PORT to enable)`);
    }
  }
  console.log('');

  console.log('  Audit log');
  if (!payload.audit.present) {
    console.log(`    State:              not yet written`);
  } else if (payload.audit.lines === 0) {
    console.log(`    State:              empty`);
  } else {
    console.log(`    Lines:              ${payload.audit.lines}`);
    if (payload.audit.last_timestamp !== null) {
      console.log(`    Last record at:     ${payload.audit.last_timestamp}`);
    }
    console.log(
      `    Tail hash:          ${payload.audit.tail_hash_looks_valid ? 'looks valid' : 'unexpected shape — run `rea audit verify`'}`,
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
