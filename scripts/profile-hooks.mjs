#!/usr/bin/env node
// 0.45.0 charter item 1 — Hook hot-path profiling harness.
//
// # What this measures
//
// Every Bash / Edit / Write / MultiEdit / NotebookEdit tool call in
// Claude Code fires one or more `.claude/hooks/*.sh` shims. 14 shims
// are registered by default. Cumulative latency matters: 14 × 50ms is
// 700ms added to every tool call, which the operator FEELS. This
// harness measures per-shim wall-clock latency under a synthetic
// payload and writes a baseline so regressions are visible.
//
// # Methodology
//
// For each shim:
//   1. Build a representative stdin JSON payload (Claude Code shape)
//      tuned to be "irrelevant" — i.e. the shim runs through its
//      full HALT → stdin-capture → resolve → sandbox → policy
//      short-circuit / version-probe path but does NOT trigger a
//      block. This is the steady-state hot path.
//   2. Warm up: 2 invocations (discarded). The first invocation has
//      cold filesystem caches + Node startup costs that don't
//      reflect steady-state.
//   3. Measure: 10 invocations. Capture wall-clock + child cputime.
//   4. Compute median / p95 / max from the 10 samples.
//
// The shim is invoked via `bash <hook-path>` with stdin piped in, the
// same way Claude Code invokes them. Environment is preserved so the
// real-world resolution path runs (node_modules / dist / PATH).
//
// # Output
//
// Writes `docs/hook-perf-baseline.json` sorted by p95 descending.
// Shape:
//
//   {
//     "version": "0.45.0",
//     "measured_at": "2026-05-17T...",
//     "platform": "darwin",
//     "node_version": "v22.x.x",
//     "iterations": 10,
//     "warmup": 2,
//     "hooks": [
//       {
//         "name": "local-review-gate.sh",
//         "median_ms": 123.4,
//         "p95_ms": 145.6,
//         "max_ms": 158.9,
//         "samples_ms": [...],
//         "exit_codes": [0,0,0,0,0,0,0,0,0,0]
//       },
//       ...
//     ]
//   }
//
// # Threshold
//
// The harness DOES NOT enforce thresholds itself — it's a measurement
// tool. The regression test at `__tests__/scripts/profile-hooks.test.ts`
// asserts a permissive ceiling so absolute regressions get caught.
// Tighten the ceiling over time as the baseline stabilizes.
//
// # Wiring
//
// `pnpm perf:hooks` runs this script. Not part of the default
// `pnpm test` chain — it's heavy (160+ subprocess spawns) and timing
// is sensitive to system load. CI calls it explicitly when the perf
// guard is active.

import { spawnSync } from 'node:child_process';
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const BASELINE_PATH = path.join(DOCS_DIR, 'hook-perf-baseline.json');

// Permissive default per-shim p95 ceilings. The regression test in
// `__tests__/scripts/profile-hooks.test.ts` enforces these. Start
// loose to avoid CI flakes from cold caches / shared runners; tighten
// in future releases as the baseline stabilizes.
//
// `local-review-gate.sh` is a documented outlier — it does its own
// early sandbox check (round-5 P1) + subtree policy reads + a git
// stash-create on the forward path. ~1800ms is its current healthy
// p95 on the rea repo; the ceiling sits 2x above for CI headroom.
// See `docs/hook-perf-baseline.md` for the breakdown.
const DEFAULT_P95_CEILING_MS = 2000;
const PER_SHIM_P95_CEILING_MS = {
  'local-review-gate.sh': 4500,
};

/**
 * Resolve the p95 ceiling for a given shim. Falls back to the default
 * when no per-shim entry exists.
 */
export function ceilingForShim(name) {
  return PER_SHIM_P95_CEILING_MS[name] ?? DEFAULT_P95_CEILING_MS;
}

const DEFAULT_ITERATIONS = 10;
const DEFAULT_WARMUP = 2;

/**
 * Per-hook stdin payload generator. Each shim sees a Claude Code
 * PreToolUse/PostToolUse event JSON; the shape varies slightly per
 * hook (Bash vs Edit vs Write). We use intentionally innocuous
 * payloads so the shim runs through its full hot path without
 * blocking — that's the realistic latency we want to measure.
 *
 * Returns the JSON string to pipe into the shim's stdin.
 */
export function payloadForHook(name) {
  // PreToolUse Bash event (Bash-tier hooks): a simple `ls` payload —
  // not destructive, not policy-relevant, not a git push. The shim
  // should run to completion without refusal.
  const bashEvent = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'ls -la', description: 'list current directory' },
    hook_event_name: 'PreToolUse',
  });

  // PreToolUse Write event (Write-tier hooks): writing a benign .ts
  // file with no secrets, no protected-path target.
  const writeEvent = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/rea-profile-scratch.ts', content: 'export const x = 1;\n' },
    hook_event_name: 'PreToolUse',
  });

  // PostToolUse Edit event (architecture-review-gate fires PostToolUse).
  const postEditEvent = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/scratch.ts', old_string: 'a', new_string: 'b' },
    tool_response: { success: true },
    hook_event_name: 'PostToolUse',
  });

  // PreToolUse Agent event (delegation-capture matches Agent|Skill).
  const agentEvent = JSON.stringify({
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'noop' },
    hook_event_name: 'PreToolUse',
  });

  switch (name) {
    case 'architecture-review-gate.sh':
      return postEditEvent;
    case 'attribution-advisory.sh':
      // Triggers on Bash `git commit` / `gh pr create`. We use a
      // non-attribution payload so it runs through and exits clean.
      return JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git status', description: 'check status' },
        hook_event_name: 'PreToolUse',
      });
    case 'blocked-paths-bash-gate.sh':
      return bashEvent;
    case 'blocked-paths-enforcer.sh':
      return writeEvent;
    case 'changeset-security-gate.sh':
      return writeEvent;
    case 'dangerous-bash-interceptor.sh':
      return bashEvent;
    case 'delegation-advisory.sh':
      // Fires PostToolUse on Bash|Edit|Write|MultiEdit|NotebookEdit.
      return JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/scratch.ts', content: 'x' },
        tool_response: { success: true },
        hook_event_name: 'PostToolUse',
      });
    case 'delegation-capture.sh':
      return agentEvent;
    case 'dependency-audit-gate.sh':
      // Fires on Bash. Payload is benign — not an install command.
      return bashEvent;
    case 'env-file-protection.sh':
      return bashEvent;
    case 'local-review-gate.sh':
      // Fires on Bash. Use a non-push command so the gate runs through
      // its policy-read path without triggering the actual
      // local-review refusal.
      return bashEvent;
    case 'pr-issue-link-gate.sh':
      // Fires on `gh pr create`. Benign Bash payload.
      return bashEvent;
    case 'protected-paths-bash-gate.sh':
      return bashEvent;
    case 'secret-scanner.sh':
      return writeEvent;
    case 'security-disclosure-gate.sh':
      return bashEvent;
    case 'settings-protection.sh':
      return writeEvent;
    default:
      return bashEvent;
  }
}

/**
 * List the shims to profile — every `.sh` directly under `hooks/`,
 * excluding `_lib/`.
 */
export function listShims(hooksDir = HOOKS_DIR) {
  return readdirSync(hooksDir)
    .filter((f) => f.endsWith('.sh'))
    .filter((f) => {
      try {
        return statSync(path.join(hooksDir, f)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Run a single shim invocation and return wall-clock ms + exit code.
 */
function runOnce(hookPath, payload) {
  const start = performance.now();
  const res = spawnSync('bash', [hookPath], {
    input: payload,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT },
  });
  const elapsed = performance.now() - start;
  // spawnSync returns res.status null on timeout/signal — surface
  // that as -1 so the caller can flag it.
  const status = res.status === null ? -1 : res.status;
  return { ms: elapsed, status };
}

/**
 * Compute percentile from a sorted ascending array of numbers.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Profile a single hook. Returns the measurement record.
 *
 * 0.45.0 codex round-1 P2 #2: every shim is expected to exit 0 under
 * its synthetic non-blocking payload — that's the steady-state hot
 * path we want to measure. A non-zero exit (refusal, malformed
 * payload, timeout, CLI-missing) means the shim ran an ERROR path
 * instead of the hot path, and the resulting latency number does NOT
 * represent steady-state. The record carries an `error` field
 * surfacing any non-zero exit, and `runProfile` propagates it to the
 * report so callers can fail loudly rather than silently shipping a
 * "healthy" baseline that timed nothing but error paths.
 */
export function profileHook(name, opts = {}) {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const warmup = opts.warmup ?? DEFAULT_WARMUP;
  const hooksDir = opts.hooksDir ?? HOOKS_DIR;
  const hookPath = path.join(hooksDir, name);
  const payload = payloadForHook(name);

  for (let i = 0; i < warmup; i += 1) {
    runOnce(hookPath, payload);
  }

  const samples = [];
  const exitCodes = [];
  for (let i = 0; i < iterations; i += 1) {
    const r = runOnce(hookPath, payload);
    samples.push(r.ms);
    exitCodes.push(r.status);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];

  // 0.45.0 codex round-1 P2 #2: surface non-zero exits. -1 marks a
  // timeout (runOnce normalizes spawnSync's null status). Any
  // non-zero value means the shim ran a refusal / error path, not
  // the steady-state hot path the measurement assumes.
  const nonZero = exitCodes.filter((c) => c !== 0);
  const error =
    nonZero.length > 0
      ? `${nonZero.length}/${exitCodes.length} samples exited non-zero ` +
        `(codes: ${exitCodes.join(',')}). Synthetic payload likely hit an ` +
        `error path; latency is NOT representative of the hot path. ` +
        `Tune the payload in payloadForHook() so this shim exits 0.`
      : null;

  return {
    name,
    median_ms: round(median),
    p95_ms: round(p95),
    max_ms: round(max),
    samples_ms: samples.map(round),
    exit_codes: exitCodes,
    error,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Run the full profile and return the report object.
 */
export function runProfile(opts = {}) {
  const hooksDir = opts.hooksDir ?? HOOKS_DIR;
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const warmup = opts.warmup ?? DEFAULT_WARMUP;
  const shims = (opts.shims ?? listShims(hooksDir)).filter((n) => {
    // Skip non-file entries defensively.
    try {
      return statSync(path.join(hooksDir, n)).isFile();
    } catch {
      return false;
    }
  });

  const records = [];
  for (const name of shims) {
    records.push(profileHook(name, { iterations, warmup, hooksDir }));
  }

  // Sort by p95 desc — slowest at the top makes the operator's eye
  // land on the leaders immediately.
  records.sort((a, b) => b.p95_ms - a.p95_ms);

  // Decorate each record with the resolved ceiling so the baseline JSON
  // documents the per-shim threshold inline (avoids drift between the
  // doc and the regression test).
  const decorated = records.map((r) => ({
    ...r,
    p95_ceiling_ms: ceilingForShim(r.name),
    over_budget: r.p95_ms > ceilingForShim(r.name),
  }));

  return {
    version: getPkgVersion(),
    measured_at: new Date().toISOString(),
    platform: process.platform,
    node_version: process.version,
    iterations,
    warmup,
    default_p95_ceiling_ms: DEFAULT_P95_CEILING_MS,
    per_shim_p95_ceiling_ms: PER_SHIM_P95_CEILING_MS,
    hooks: decorated,
  };
}

function getPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * CLI entry. Writes the report to disk.
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const iterArg = args.find((a) => a.startsWith('--iterations='));
  const warmArg = args.find((a) => a.startsWith('--warmup='));
  const iterations = iterArg ? parseInt(iterArg.split('=')[1], 10) : DEFAULT_ITERATIONS;
  const warmup = warmArg ? parseInt(warmArg.split('=')[1], 10) : DEFAULT_WARMUP;

  process.stderr.write(
    `[profile-hooks] profiling ${listShims().length} shims ` +
      `(${iterations} iterations + ${warmup} warmup each) — this takes ~30-60s\n`,
  );

  const report = runProfile({ iterations, warmup });

  if (!existsSync(DOCS_DIR)) {
    mkdirSync(DOCS_DIR, { recursive: true });
  }

  const json = JSON.stringify(report, null, 2) + '\n';

  // Human-readable summary on stderr (top 5 by p95).
  process.stderr.write('\n[profile-hooks] p95 leaders:\n');
  for (const r of report.hooks.slice(0, 5)) {
    process.stderr.write(
      `  ${r.name.padEnd(32)}  ` +
        `p95=${String(r.p95_ms).padStart(7)}ms  ` +
        `median=${String(r.median_ms).padStart(7)}ms  ` +
        `max=${String(r.max_ms).padStart(7)}ms\n`,
    );
  }

  // 0.45.0 codex round-1 P2 #2: fail loudly if any shim ran a
  // non-zero-exit error path — the latency number is meaningless in
  // that case and the baseline would silently ship lies.
  //
  // 0.45.0 codex round-2 P2 #3: this AND the over-budget check below
  // run BEFORE the baseline write — a failed measurement run must
  // NOT clobber the checked-in last-known-good baseline. The dry-run
  // branch still emits JSON for inspection regardless.
  const errored = report.hooks.filter((h) => h.error !== null);
  if (errored.length > 0) {
    process.stderr.write(
      `\n[profile-hooks] ${errored.length} shim(s) ran a non-zero error path:\n`,
    );
    for (const h of errored) {
      process.stderr.write(`  ${h.name}: ${h.error}\n`);
    }
    process.stderr.write(
      `[profile-hooks] NOT writing ${BASELINE_PATH} — last-known-good baseline preserved.\n`,
    );
    if (dryRun) process.stdout.write(json);
    process.exit(2);
  }

  const overBudget = report.hooks.filter((h) => h.p95_ms > ceilingForShim(h.name));
  if (overBudget.length > 0) {
    process.stderr.write(
      `\n[profile-hooks] ${overBudget.length} shim(s) exceeded the p95 ceiling:\n`,
    );
    for (const h of overBudget) {
      process.stderr.write(
        `  ${h.name}  p95=${h.p95_ms}ms (ceiling=${ceilingForShim(h.name)}ms)\n`,
      );
    }
    process.stderr.write(
      `[profile-hooks] NOT writing ${BASELINE_PATH} — last-known-good baseline preserved.\n`,
    );
    if (dryRun) process.stdout.write(json);
    process.exit(1);
  }

  // All checks passed — safe to persist the baseline.
  if (dryRun) {
    process.stdout.write(json);
  } else {
    writeFileSync(BASELINE_PATH, json);
    process.stderr.write(`[profile-hooks] wrote ${BASELINE_PATH}\n`);
  }
}

// Run main only when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`[profile-hooks] FAILED: ${e.message}\n`);
    process.exit(1);
  });
}

export {
  BASELINE_PATH,
  DEFAULT_P95_CEILING_MS,
  PER_SHIM_P95_CEILING_MS,
  DEFAULT_ITERATIONS,
  DEFAULT_WARMUP,
};
