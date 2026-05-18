# Hook hot-path performance baseline

Introduced in 0.45.0 (charter item 1). Run `pnpm perf:hooks` to refresh
`hook-perf-baseline.json` in this directory. The associated regression
test lives at `__tests__/scripts/profile-hooks.test.ts` and is run via
`pnpm test:perf` — it is intentionally NOT in the default `pnpm test`
chain (codex round-1 P2 #1: wall-clock ceilings are sensitive to system
load and would flake on shared CI runners).

## What this measures

Every Bash / Edit / Write / MultiEdit / NotebookEdit tool call in
Claude Code fires one or more `.claude/hooks/*.sh` shims. 16 shims
ship with rea by default. Cumulative latency matters: 8 shims fire on
every Bash event, and even ~500ms each adds up to 4s of latency the
operator feels on every command.

The harness at `scripts/profile-hooks.mjs` measures per-shim
wall-clock latency under a synthetic, **non-blocking** payload. That
captures the steady-state hot path — the cost the operator pays on
every harmless command, not the cost on the rare destructive command
the gate is actually built to refuse.

## Methodology

- 10 measured iterations + 2 discarded warmups per shim **per variant**
- **Two payload variants per shim** (0.46.0 charter item 3):
  - **MATCH** — payload crafted to PASS `shim_is_relevant` so the
    shim runs its FULL hot path (sandbox check + version probe +
    Node CLI forward + actual body work). The latency the operator
    pays when a relevant command lands.
  - **NO_MATCH** — payload crafted to FAIL `shim_is_relevant` so
    the shim short-circuits at the pre-gate. The latency the
    operator pays on every irrelevant command — which is the
    cumulative cost dominant on most sessions, since most commands
    are irrelevant to most shims.
- Shims without a `shim_is_relevant` pre-gate (always-on tier:
  `dangerous-bash-interceptor`, `blocked-paths-*`, `settings-protection`,
  `delegation-capture`, `delegation-advisory`, `architecture-review-gate`,
  `pr-issue-link-gate`, `local-review-gate`) use the same payload for
  both variants and the JSON record carries `same_as_match: true`.
  These shims have only `shim_cli_missing_relevant` (a different
  branch fired only when dist/cli is missing), so under normal
  CLI-reachable steady state both variants exercise the same path.
- Payload tuned per shim to traverse the full HALT → stdin → resolve →
  sandbox → policy short-circuit / version-probe / forward path without
  triggering a refusal
- Reports median, p95, max for the MATCH variant at the top level
  (backwards compatible with pre-0.46.0 baseline JSON shape) and a
  nested `no_match: { median_ms, p95_ms, max_ms, samples_ms,
  exit_codes, error }` for the short-circuit variant (`null` when
  `same_as_match: true`)
- Sorted by MATCH p95 descending
- Run on the rea repo itself (the operator's dogfood)
- **Every shim must exit 0 under BOTH synthetic payloads** (codex
  round-1 P2 #2 + 0.46.0 charter item 3). A non-zero exit means the
  payload hit an error path, not the hot path, and the latency number
  is meaningless — the profiler refuses to write the baseline and the
  regression test fails. To add a new shim, tune its entries in
  `payloadVariantsForHook()` until every iteration of both variants
  exits 0.

## Per-session shim cache and the baseline (0.48.0+)

The `hooks/_lib/shim-cache.sh` helper (0.48.0) records the answers to
the sandbox check + version probe under a per-user, per-session,
per-CLI key. On a HIT, `shim-runtime.sh` skips both steps 5 and 8 and
goes straight to the forward step. Steady-state same-session same-CLI
fires therefore pay roughly the cache-key + cache-read latency
(~5-10ms) instead of the full sandbox + probe cost (~80-150ms on
macOS, varies on Linux).

The baseline harness sets **`REA_SHIM_CACHE=0` in the environment of
every profiled invocation** (see `scripts/profile-hooks.mjs` `runOnce`)
for one reason: a warmed cache would silently improve the steady-state
numbers from one `pnpm perf:hooks` run to the next, **masking
regressions in the underlying resolve / sandbox / probe layers** the
baseline exists to catch. The baseline measures the COLD path. The
cache's benefit is a separate concern.

To observe the cache effect manually (NOT for baseline regression
purposes):

```bash
# Cold-path baseline (what the regression test enforces).
REA_SHIM_CACHE=0 pnpm perf:hooks --iterations=10 --warmup=2

# Warm-path observation (informational, not enforced).
REA_SHIM_CACHE=1 pnpm perf:hooks --iterations=10 --warmup=2
# The first ~2-3 iterations populate the cache; subsequent iterations
# of the same shim hit the cache and drop ~80-150ms each.
```

Per design memo concern #6, **never let the baseline run with the
cache enabled.** A green baseline under a warmed cache could be
hiding a 100ms regression in `shim_resolve_cli` or
`shim_sandbox_check` that would land on the operator the moment
their session token rotates or their TMPDIR clears.

## Why two variants matter

Pre-0.46.0 the harness used generic Bash/Write payloads for every
shim. That was fine for the always-on tier (dangerous-bash,
blocked-paths-*, etc) which have no relevance pre-gate — but for
shims like `attribution-advisory`, `security-disclosure-gate`,
`env-file-protection`, `dependency-audit-gate`,
`changeset-security-gate`, and `secret-scanner`, the generic payload
HIT the short-circuit and the measured latency was the irrelevant-call
cost (~15-55ms) instead of the real hot-path cost (~500-800ms when a
relevant command lands).

Operators reading the pre-0.46.0 baseline could reasonably conclude
those shims were already cheap — when in fact they were cheap only
under the synthetic payload's irrelevant shape. The 0.46.0 baseline
fixes the attribution by reporting both costs separately, so:

- The MATCH row shows what the operator pays when running `git commit`
  / `gh issue create` / `pnpm add foo` / etc.
- The NO_MATCH row shows what the operator pays on `ls`, `cat`,
  `git status` — the irrelevant-call short-circuit cost that fires
  on most commands.

The ceiling enforcement (regression test + harness exit-2) applies
to BOTH variants under the same threshold, so a regression in the
pre-gate path itself (e.g. an inadvertent Node spawn before
`shim_is_relevant` fires) gets caught by the no_match column.

## Findings

The 0.45.0 baseline below reflected the SHORT-CIRCUIT path for the
six shims with a `shim_is_relevant` pre-gate. Under the 0.46.0
methodology those shims now report a separate MATCH (hot-path) and
NO_MATCH (short-circuit) measurement. Refresh
`hook-perf-baseline.json` via `pnpm perf:hooks` after the 0.46.0
landing to see the now-accurate hot-path numbers for the
relevance-gated shims; the always-on tier numbers stay representative
of both variants.

### 0.45.0 baseline (pre-fix — relevance-gated shims undercounted)

| Shim | p95 (ms) | Median (ms) | Ceiling (ms) | Notes |
|---|--:|--:|--:|---|
| `local-review-gate.sh` | ~2300 | ~1800 | 4500 | Hot — does subtree-cache policy reads + early sandbox check (round-5 P1) + git stash-create on forward |
| `protected-paths-bash-gate.sh` | ~770 | ~580 | 2000 | Standard blocking shim — sandbox + version-probe + forward |
| `settings-protection.sh` | ~710 | ~500 | 2000 | Standard blocking shim |
| `blocked-paths-bash-gate.sh` | ~650 | ~565 | 2000 | Standard blocking shim |
| `architecture-review-gate.sh` | ~630 | ~490 | 2000 | PostToolUse advisory |
| `blocked-paths-enforcer.sh` | ~610 | ~550 | 2000 | Standard blocking shim |
| `dangerous-bash-interceptor.sh` | ~560 | ~475 | 2000 | Standard blocking shim |
| `secret-scanner.sh` | ~550 | ~480 | 2000 | Standard blocking shim |
| `pr-issue-link-gate.sh` | ~485 | ~465 | 2000 | Advisory tier |
| `delegation-advisory.sh` | ~350 | ~260 | 2000 | Advisory tier |
| `delegation-capture.sh` | ~100 | ~70 | 2000 | `SHIM_SKIP_VERSION_PROBE=1` (one of two Node spawns skipped) |
| `dependency-audit-gate.sh` | ~55 | ~30 | 2000 | **UNDERCOUNT** — short-circuit only; hot-path will be ~600ms under MATCH payload |
| `env-file-protection.sh` | ~25 | ~20 | 2000 | **UNDERCOUNT** — short-circuit only |
| `changeset-security-gate.sh` | ~22 | ~18 | 2000 | **UNDERCOUNT** — short-circuit only |
| `attribution-advisory.sh` | ~15 | ~15 | 2000 | **UNDERCOUNT** — short-circuit only; hot-path will be ~600ms under MATCH payload |
| `security-disclosure-gate.sh` | ~15 | ~14 | 2000 | **UNDERCOUNT** — short-circuit only |

### 0.46.0 expected pattern (after MATCH payloads added)

The relevance-gated shims should land at two distinct latencies:

- **NO_MATCH** (irrelevant-command short-circuit): ~15-55ms as
  pre-0.46.0 baseline. This is what fires on `ls`, `git status`,
  `cat foo.ts`, etc — the dominant cumulative cost across a
  session because most commands are irrelevant to most shims.
- **MATCH** (relevant-command hot path): ~500-800ms — same
  cost-shape as the always-on blocking shims (sandbox check +
  version probe + Node CLI forward). This is what fires on `git
  commit`, `gh issue create`, `pnpm add foo`, writes to
  `.changeset/`, etc.

Concretely we expect the MATCH columns to fall in:

| Shim | Expected MATCH p95 (ms) | Expected NO_MATCH p95 (ms) | Reason for split |
|---|--:|--:|---|
| `attribution-advisory.sh` | ~500-800 | ~15 | Pre-gate substring match (`git commit` / `gh pr create`) |
| `security-disclosure-gate.sh` | ~500-800 | ~15 | Pre-gate substring match (`gh issue create`) |
| `dependency-audit-gate.sh` | ~500-800 | ~30 | Pre-gate substring match (`pnpm add` / `npm i`) |
| `env-file-protection.sh` | ~500-800 | ~20 | Pre-gate substring match (`.env`) |
| `changeset-security-gate.sh` | ~500-800 | ~18 | Pre-gate file_path match (`.changeset/`) |
| `secret-scanner.sh` | ~500-800 | ~25 | Pre-gate suffix short-circuit (`.env.example` / empty content) |

Any shim whose **MATCH** p95 exceeds the per-shim ceiling needs the
hot path investigated (or the ceiling raised with a documented
reason); any shim whose **NO_MATCH** p95 exceeds the ceiling means
the pre-gate path itself regressed (probable cause: an inadvertent
Node spawn before `shim_is_relevant` runs).

(See `hook-perf-baseline.json` for the exact per-machine numbers — they vary by hardware and system load.)

The ceiling column is the per-shim regression threshold enforced by
`__tests__/scripts/profile-hooks.test.ts`. Default is 2000ms;
`local-review-gate.sh` gets a 4500ms exemption (~2x its current
healthy p95) because of the architectural reasons documented in the
root-cause section below.

## Root cause

The blocking shims that pay ~500ms per invocation all share the same
cost shape:

1. **Sandbox check** — `shim_sandbox_check` spawns a fresh `node -e
   '<script>'` to realpath-validate the resolved CLI and walk for the
   ancestor `package.json` with `name=@bookedsolid/rea`. ~150ms on a
   warm system (Node startup + module-loader).
2. **Version probe** — `shim_run` invokes `"${REA_ARGV[@]}" hook
   "$SHIM_NAME" --help` to verify the subcommand exists in the resolved
   CLI. ~250ms on a warm system (Node startup + commander setup +
   help-text rendering).
3. **Forward** — `shim_default_forward` pipes stdin into `rea hook
   <name>` and lets the actual subcommand do its work. ~100ms +
   subcommand cost.

Two Node-process spawns per shim is the dominant cost. The shims that
short-circuit early (env-file-protection, attribution-advisory,
security-disclosure-gate) skip both and pay ~15ms total.

`local-review-gate.sh` is the outlier at ~1800ms because it
*additionally* spawns Node a third time for the early sandbox check
(round-5 P1 fix), and its actual subcommand does a git stash create +
diff to compute the working-tree fingerprint.

## Proposed optimization (deferred — needs security review)

A session-scoped cache for the sandbox check + version-probe would cut
the steady-state hot path from ~500ms to ~100ms per blocking shim —
the same shape as the 0.34.0 round-4 subtree-cache fix that
local-review-gate uses for policy reads.

**Cache key** must include:

- The resolved CLI realpath (`RESOLVED_CLI_PATH`)
- The `stat.mtime` of the resolved CLI file (so a `pnpm build` /
  `npm install` invalidates the cache automatically)
- The shim name (so version-probe results don't cross-contaminate
  between subcommands)
- The `SHIM_ENFORCE_CLI_SHAPE` value (the sandbox check varies by it)

**Storage** at `$TMPDIR/rea-shim-cache-<sessionid>/...` with `0700`
permissions on the directory and `0600` on each marker. TTL ~5 minutes
or invalidated by an mtime change on the CLI.

**Trust boundary**: this cache is security-load-bearing. The marker
files must be unforgeable from outside the session, and the cache key
must capture every input that affects the sandbox decision. A naive
implementation (e.g. caching by path only) would let an attacker swap
the CLI between shim invocations within the TTL window.

This is **not** implemented in 0.45.0. It needs explicit
security-architect review and a hardened bypass-corpus before shipping
in a future release. Filed for the 0.46.0+ backlog.

## Current ceilings

The regression test at `__tests__/scripts/profile-hooks.test.ts`
enforces a per-shim p95 ceiling. Defaults:

- **All shims**: 2000ms (loose enough to absorb CI noise on shared
  runners; tight enough to catch absolute regressions like a new
  Node-spawn in the hot path).
- **`local-review-gate.sh`**: 4500ms (~2x its current healthy p95).
  Exempt because of the three-Node-spawn architecture documented
  above. If the deferred sandbox+probe session-cache lands, this
  ceiling can drop to ~1500ms.

Tighten as the baseline stabilizes across releases. Per-shim
exemptions live in `PER_SHIM_P95_CEILING_MS` in
`scripts/profile-hooks.mjs`.
