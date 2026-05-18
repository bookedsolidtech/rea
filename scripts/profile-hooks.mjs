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
 * 0.46.0 charter item 3 — per-hook payload variants.
 *
 * Pre-0.46.0 the harness used generic Bash/Write/Edit payloads for
 * EVERY shim. That undercounted latency for several gates:
 *
 *   - `attribution-advisory.sh`, `security-disclosure-gate.sh`,
 *     `env-file-protection.sh`, `dependency-audit-gate.sh`,
 *     `changeset-security-gate.sh`, `local-review-gate.sh` all have
 *     `shim_is_relevant` short-circuits that exit at the relevance
 *     pre-gate when the payload's substring marker isn't present.
 *     The generic `ls -la` Bash payload hit those short-circuits and
 *     the measured latency reflected the short-circuit path, not the
 *     real hot path the shim runs when a relevant command actually
 *     comes through.
 *   - `secret-scanner.sh` short-circuits on empty content; the generic
 *     write payload had content, so this one was already measuring
 *     the real path. Still — pinning a MATCH variant makes the
 *     contract explicit.
 *
 * The fix profiles every shim under TWO payloads:
 *
 *   - `match`     — crafted to PASS `shim_is_relevant` so the shim
 *                   runs its full hot path (sandbox check + version
 *                   probe + Node CLI forward + actual body work).
 *                   This is the latency the operator pays when a
 *                   relevant command lands.
 *   - `no_match`  — crafted to FAIL `shim_is_relevant` so the shim
 *                   short-circuits at the pre-gate. This is the
 *                   latency the operator pays on EVERY irrelevant
 *                   command — and since most commands are
 *                   irrelevant to most shims, this is the dominant
 *                   cumulative cost.
 *
 * Both are reported in the baseline. Shims without a relevance
 * short-circuit (the always-on tier: dangerous-bash-interceptor,
 * blocked-paths-*, settings-protection, delegation-capture,
 * delegation-advisory, architecture-review-gate, pr-issue-link-gate)
 * use the same payload for `match` and `no_match` — both variants
 * exercise the same path. The `no_match` field stays so the JSON
 * shape is uniform across shims, and the renderer flags
 * `same_as_match: true` for those rows.
 *
 * MATCH payloads are crafted to be RELEVANT but NOT REFUSED — they
 * pass the substring pre-gate but the full CLI body exits 0. The
 * goal is to measure latency, not to exercise the refusal path. Two
 * subtleties to keep in mind:
 *
 *   - `attribution-advisory`: `git commit` is relevant; we use
 *     `git commit -m "feat: noop"` which carries no AI attribution
 *     markers (`Co-Authored-By:` with an AI name, "Generated with
 *     [Tool]" footers) so the CLI exits 0 after the body work.
 *   - `dangerous-bash-interceptor`: every match-payload candidate
 *     (`git status`, `npm ls`, etc) carries refusal risk via the
 *     overlap with the CLI's bypass-corpus. We use `git status` —
 *     a known-safe in-the-clear command that does not refuse — and
 *     accept that the shim has no `shim_is_relevant` gate anyway
 *     (CLI-missing path uses `shim_cli_missing_relevant` which is
 *     a DIFFERENT branch and only fires when dist/cli is missing).
 *     Under the normal CLI-reachable steady state, both `match` and
 *     `no_match` payloads exercise the same full-CLI path here.
 *
 * Returns a `{ match: string, no_match: string }` object — both
 * fields are non-null JSON event strings.
 */
export function payloadVariantsForHook(name) {
  // Reusable generic events.
  const benignBashEvent = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'ls -la', description: 'list current directory' },
    hook_event_name: 'PreToolUse',
  });
  const benignWriteEvent = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/rea-profile-scratch.ts', content: 'export const x = 1;\n' },
    hook_event_name: 'PreToolUse',
  });
  const benignPostEditEvent = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/scratch.ts', old_string: 'a', new_string: 'b' },
    tool_response: { success: true },
    hook_event_name: 'PostToolUse',
  });
  const benignAgentEvent = JSON.stringify({
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'noop' },
    hook_event_name: 'PreToolUse',
  });

  switch (name) {
    case 'architecture-review-gate.sh':
      // PostToolUse on every Edit — no relevance pre-gate at the shim
      // tier; the CLI body decides. Both variants exercise the same
      // path.
      return { match: benignPostEditEvent, no_match: benignPostEditEvent };

    case 'attribution-advisory.sh':
      // Pre-gate: substring match for `git commit` OR `gh pr (create|edit)`.
      // MATCH: `git commit -m "feat: noop"` (no AI attribution markers
      // so the CLI body exits 0 after running its full check).
      // NO_MATCH: `git status` (no commit/pr-create substring).
      return {
        match: JSON.stringify({
          tool_name: 'Bash',
          tool_input: {
            command: 'git commit -m "feat: noop"',
            description: 'noop commit',
          },
          hook_event_name: 'PreToolUse',
        }),
        no_match: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'git status', description: 'check status' },
          hook_event_name: 'PreToolUse',
        }),
      };

    case 'blocked-paths-bash-gate.sh':
      // Shim has only `shim_cli_missing_relevant` (CLI-missing only).
      // Under normal CLI-reachable steady state, both variants run
      // the full CLI body. Same payload for both.
      return { match: benignBashEvent, no_match: benignBashEvent };

    case 'blocked-paths-enforcer.sh':
      // Same as above — CLI-missing-only relevance gate. Both variants
      // hit the full CLI body when CLI is reachable.
      return { match: benignWriteEvent, no_match: benignWriteEvent };

    case 'changeset-security-gate.sh':
      // Pre-gate: file_path / notebook_path contains `.changeset/`.
      // MATCH: a benign changeset frontmatter (no GHSA reference so
      // the CLI body's disclosure scan exits 0).
      // NO_MATCH: a Write to /tmp/foo.ts (no `.changeset/` substring).
      return {
        match: JSON.stringify({
          tool_name: 'Write',
          tool_input: {
            file_path: '/tmp/changeset-profile/.changeset/perf-noop.md',
            content: '---\n"@scope/pkg": patch\n---\n\nperf noop\n',
          },
          hook_event_name: 'PreToolUse',
        }),
        no_match: benignWriteEvent,
      };

    case 'dangerous-bash-interceptor.sh':
      // No `shim_is_relevant` — every Bash event goes through the
      // full CLI body. `git status` is the safest candidate: no rule
      // head H1-H17 + M1 fires on it. Both variants are the same.
      return { match: benignBashEvent, no_match: benignBashEvent };

    case 'delegation-advisory.sh': {
      // PostToolUse on Bash|Edit|Write|MultiEdit|NotebookEdit. No
      // relevance pre-gate; CLI body decides. Both same.
      const delegationAdvisoryEvent = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/scratch.ts', content: 'x' },
        tool_response: { success: true },
        hook_event_name: 'PostToolUse',
      });
      return { match: delegationAdvisoryEvent, no_match: delegationAdvisoryEvent };
    }

    case 'delegation-capture.sh':
      // PreToolUse on Agent|Skill matcher — every Agent/Skill event
      // goes through the CLI body. Both variants are the same.
      return { match: benignAgentEvent, no_match: benignAgentEvent };

    case 'dependency-audit-gate.sh':
      // Pre-gate: substring match for `(npm|pnpm|yarn) (install|i|add) `.
      // MATCH: `pnpm add ./local-pkg` — passes the segment-anchored
      // install matcher (full hot path through splitSegments + the
      // env-prefix strip + the per-segment scan), but the
      // package-name extractor in `src/hooks/dependency-audit-gate/
      // index.ts` skips `./` / `/` / `../` tokens as path installs.
      // After the scan, `packages.length === 0` → the hook returns
      // exit 0 WITHOUT a `npm view` network call. Codex round-1 P2
      // (0.46.0): the earlier `pnpm add lodash` payload triggered
      // the real registry probe and `runProfile()` exited 2 on any
      // offline / firewalled / npm-outage machine, making the harness
      // unusable without external network access. The path-install
      // variant keeps the hot path measured without the network
      // dependency.
      // NO_MATCH: `ls -la` (no install verb → segment matcher misses).
      return {
        match: JSON.stringify({
          tool_name: 'Bash',
          tool_input: {
            command: 'pnpm add ./local-pkg',
            description: 'install a local path package',
          },
          hook_event_name: 'PreToolUse',
        }),
        no_match: benignBashEvent,
      };

    case 'env-file-protection.sh':
      // Pre-gate: `.env` substring in tool_input.command.
      // MATCH: `cat .env.example` — relevant (`.env` substring) but
      // benign (`.env.example` is excluded by the CLI body's
      // co-occurrence + suffix logic).
      // NO_MATCH: `ls -la` (no `.env`).
      return {
        match: JSON.stringify({
          tool_name: 'Bash',
          tool_input: {
            command: 'cat .env.example',
            description: 'check example env',
          },
          hook_event_name: 'PreToolUse',
        }),
        no_match: benignBashEvent,
      };

    case 'local-review-gate.sh':
      // Pre-gate is policy-driven on `review.local_review.refuse_at`.
      // Default `refuse_at: push` triggers on `git push`. But the
      // body fails CLOSED when the policy is enforced — we'd refuse
      // the synthetic payload and exit non-zero, which breaks the
      // round-1 P2 #2 "every shim exits 0" contract.
      //
      // The safe match variant uses `REA_SKIP_LOCAL_REVIEW=1` env
      // inheritance — but the harness explicitly sets env via
      // `runOnce`, and we don't want to globally bypass the gate
      // (that would invalidate the no-match variant too).
      //
      // Settled approach: NO_MATCH uses `git status` (no `git push`
      // trigger → short-circuit at step 5 / 6). MATCH uses the
      // explicit early-bypass envelope to drive the forward path
      // without refusal — the shim's step 2b checks
      // REA_SKIP_LOCAL_REVIEW from the environment, NOT from the
      // payload, so we cannot drive it via JSON. Instead we use a
      // `git status` payload for BOTH variants and document that
      // local-review-gate is in the "no shim_is_relevant gate" tier:
      // the policy-driven scan still fires, but a non-`git push`
      // command exits before the heavy forward path. The body's
      // genuine hot path under a `git push` is impossible to
      // measure in a non-refusing way without ambient env bypass.
      //
      // Net: same payload for both variants. The baseline doc notes
      // this limitation explicitly.
      return { match: benignBashEvent, no_match: benignBashEvent };

    case 'pr-issue-link-gate.sh':
      // No `shim_is_relevant`. Advisory-tier; CLI body decides.
      // Both variants are the same (`same_as_match: true` in the
      // baseline) — the CLI body's `gh pr create` matcher fires only
      // on that exact prefix, but the shim-tier latency is identical
      // either way.
      return { match: benignBashEvent, no_match: benignBashEvent };

    case 'protected-paths-bash-gate.sh':
      // CLI-missing-only relevance gate. Under normal CLI-reachable
      // steady state both variants run the full CLI body.
      return { match: benignBashEvent, no_match: benignBashEvent };

    case 'secret-scanner.sh':
      // Pre-gate short-circuits on empty content or `.env.example` /
      // `.env.sample` suffix.
      // MATCH: a benign `.ts` Write with non-credential content — the
      // CLI body runs the full 17-pattern catalog and exits 0.
      // NO_MATCH: a Write to `/tmp/foo.env.example` — pre-gate
      // suffix short-circuit fires.
      return {
        match: benignWriteEvent,
        no_match: JSON.stringify({
          tool_name: 'Write',
          tool_input: {
            file_path: '/tmp/scratch.env.example',
            content: 'EXAMPLE_VAR=changeme\n',
          },
          hook_event_name: 'PreToolUse',
        }),
      };

    case 'security-disclosure-gate.sh':
      // Pre-gate: substring match for `gh issue create`.
      // MATCH: `gh issue create --title "feat: noop"` — relevant,
      // but no security keywords so the CLI body exits 0.
      // NO_MATCH: `gh issue list` (no `create`).
      return {
        match: JSON.stringify({
          tool_name: 'Bash',
          tool_input: {
            command: 'gh issue create --title "docs: noop"',
            description: 'create a docs issue',
          },
          hook_event_name: 'PreToolUse',
        }),
        no_match: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'gh issue list', description: 'list issues' },
          hook_event_name: 'PreToolUse',
        }),
      };

    case 'settings-protection.sh':
      // CLI-missing-only relevance gate. Under normal CLI-reachable
      // steady state both variants run the full CLI body.
      return { match: benignWriteEvent, no_match: benignWriteEvent };

    default:
      // Conservative fallback: a benign Bash payload for both.
      return { match: benignBashEvent, no_match: benignBashEvent };
  }
}

/**
 * Per-hook stdin payload generator — BACKWARDS-COMPATIBLE wrapper.
 * Pre-0.46.0 callers used `payloadForHook(name)`. The harness now
 * profiles each shim under two variants (`match` + `no_match`); this
 * wrapper returns the `match` variant for legacy callers (e.g. the
 * existing regression test). Kept exported so external scripts / tests
 * that imported `payloadForHook` continue to work without churn.
 *
 * New callers should use `payloadVariantsForHook(name)` directly.
 */
export function payloadForHook(name) {
  return payloadVariantsForHook(name).match;
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
    // 0.48.0 charter — REA_SHIM_CACHE=0 forces the per-session shim
    // cache OFF for every profiled invocation. Without this, the
    // cache would warm on the warmup runs and steady-state numbers
    // would silently improve from one profile invocation to the next
    // — masking regressions in the underlying resolve / sandbox /
    // probe layers (concern #6 of the design memo). The
    // measurement-time baseline is the COLD path; the cache's
    // benefit is reported separately in
    // `docs/hook-perf-baseline.md`.
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, REA_SHIM_CACHE: '0' },
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
 * Run a measurement sweep for a single payload variant and return
 * the per-variant record. Helper for `profileHook` which runs both
 * `match` and `no_match` variants per shim (0.46.0 charter item 3).
 */
function measureVariant(hookPath, payload, iterations, warmup) {
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
  const nonZero = exitCodes.filter((c) => c !== 0);
  const error =
    nonZero.length > 0
      ? `${nonZero.length}/${exitCodes.length} samples exited non-zero ` +
        `(codes: ${exitCodes.join(',')}). Synthetic payload likely hit an ` +
        `error path; latency is NOT representative of the hot path. ` +
        `Tune the payload in payloadVariantsForHook() so this shim exits 0.`
      : null;
  return {
    median_ms: round(median),
    p95_ms: round(p95),
    max_ms: round(max),
    samples_ms: samples.map(round),
    exit_codes: exitCodes,
    error,
  };
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
 *
 * 0.46.0 charter item 3: every shim is profiled TWICE — once with a
 * `match` payload (passes the shim_is_relevant pre-gate, exercises the
 * full hot path) and once with a `no_match` payload (fails the
 * pre-gate, exercises the short-circuit). Shims without a relevance
 * pre-gate run the same payload for both variants and `same_as_match`
 * is set to `true` so the renderer can collapse the row.
 *
 * The top-level record fields (`median_ms`, `p95_ms`, `max_ms`,
 * `samples_ms`, `exit_codes`, `error`) reflect the MATCH variant —
 * that's the hot path the ceiling enforcement budgets, and keeping
 * those fields at the top level preserves the pre-0.46.0 baseline
 * JSON shape for any external consumer. The `no_match` variant lives
 * under `no_match: { median_ms, p95_ms, max_ms, samples_ms,
 * exit_codes, error }` (set to `null` when same_as_match is true,
 * since the numbers would be redundant).
 */
export function profileHook(name, opts = {}) {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const warmup = opts.warmup ?? DEFAULT_WARMUP;
  const hooksDir = opts.hooksDir ?? HOOKS_DIR;
  const hookPath = path.join(hooksDir, name);
  const variants = payloadVariantsForHook(name);
  const sameAsMatch = variants.match === variants.no_match;

  const matchMeas = measureVariant(hookPath, variants.match, iterations, warmup);
  const noMatchMeas = sameAsMatch
    ? null
    : measureVariant(hookPath, variants.no_match, iterations, warmup);

  return {
    name,
    // MATCH variant — the hot path. Top-level fields preserve
    // backwards compatibility with the pre-0.46.0 record shape.
    ...matchMeas,
    // 0.46.0 — per-variant breakout. `no_match: null` means the shim
    // has no shim_is_relevant pre-gate, so both variants would
    // measure the same path.
    same_as_match: sameAsMatch,
    no_match: noMatchMeas,
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

  // Human-readable summary on stderr (top 5 by MATCH p95).
  // 0.46.0 charter item 3: surface the relevance-MATCH p95 (hot path)
  // alongside the no-match p95 (short-circuit) so the operator sees
  // both at a glance. Shims without a relevance pre-gate render the
  // no_match column as `—`.
  process.stderr.write('\n[profile-hooks] p95 leaders (MATCH = hot path, NO_MATCH = short-circuit):\n');
  for (const r of report.hooks.slice(0, 5)) {
    const matchP95 = String(r.p95_ms).padStart(7);
    const noMatchP95 = r.no_match !== null ? `${String(r.no_match.p95_ms).padStart(7)}ms` : '      —';
    process.stderr.write(
      `  ${r.name.padEnd(32)}  ` +
        `match.p95=${matchP95}ms  ` +
        `no_match.p95=${noMatchP95}  ` +
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
  //
  // 0.46.0 charter item 3: check BOTH match and no_match variants.
  // Either error path means the synthetic payload is wrong.
  const errored = report.hooks.filter(
    (h) => h.error !== null || (h.no_match !== null && h.no_match.error !== null),
  );
  if (errored.length > 0) {
    process.stderr.write(
      `\n[profile-hooks] ${errored.length} shim(s) ran a non-zero error path:\n`,
    );
    for (const h of errored) {
      if (h.error !== null) {
        process.stderr.write(`  ${h.name} [match]: ${h.error}\n`);
      }
      if (h.no_match !== null && h.no_match.error !== null) {
        process.stderr.write(`  ${h.name} [no_match]: ${h.no_match.error}\n`);
      }
    }
    process.stderr.write(
      `[profile-hooks] NOT writing ${BASELINE_PATH} — last-known-good baseline preserved.\n`,
    );
    if (dryRun) process.stdout.write(json);
    process.exit(2);
  }

  // 0.46.0 charter item 3: enforce the ceiling on both variants. The
  // no_match short-circuit should be much faster than the match hot
  // path; if it exceeds the same ceiling that's a sign of regression
  // in the pre-gate path itself (e.g. an inadvertent CLI spawn before
  // shim_is_relevant fires).
  const overBudget = report.hooks.filter(
    (h) =>
      h.p95_ms > ceilingForShim(h.name) ||
      (h.no_match !== null && h.no_match.p95_ms > ceilingForShim(h.name)),
  );
  if (overBudget.length > 0) {
    process.stderr.write(
      `\n[profile-hooks] ${overBudget.length} shim(s) exceeded the p95 ceiling:\n`,
    );
    for (const h of overBudget) {
      if (h.p95_ms > ceilingForShim(h.name)) {
        process.stderr.write(
          `  ${h.name} [match]  p95=${h.p95_ms}ms (ceiling=${ceilingForShim(h.name)}ms)\n`,
        );
      }
      if (h.no_match !== null && h.no_match.p95_ms > ceilingForShim(h.name)) {
        process.stderr.write(
          `  ${h.name} [no_match]  p95=${h.no_match.p95_ms}ms (ceiling=${ceilingForShim(h.name)}ms)\n`,
        );
      }
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
