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

- 10 measured iterations + 2 discarded warmups per shim
- Payload tuned per shim to traverse the full HALT → stdin → resolve →
  sandbox → policy short-circuit / version-probe / forward path without
  triggering a refusal
- Reports median, p95, max
- Sorted by p95 descending
- Run on the rea repo itself (the operator's dogfood)
- **Every shim must exit 0 under its synthetic payload** (codex
  round-1 P2 #2). A non-zero exit means the payload hit an error
  path, not the hot path, and the latency number is meaningless —
  the profiler refuses to write the baseline and the regression test
  fails. To add a new shim, tune its entry in `payloadForHook()`
  until every iteration exits 0.

## Findings (0.45.0, macOS Darwin, Node 22+, rea repo dogfood)

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
| `dependency-audit-gate.sh` | ~55 | ~30 | 2000 | Short-circuits via `shim_is_relevant` keyword scan |
| `env-file-protection.sh` | ~25 | ~20 | 2000 | Short-circuits via `shim_is_relevant` |
| `changeset-security-gate.sh` | ~22 | ~18 | 2000 | Short-circuits via `shim_is_relevant` |
| `attribution-advisory.sh` | ~15 | ~15 | 2000 | Short-circuits via `shim_policy_short_circuit` |
| `security-disclosure-gate.sh` | ~15 | ~14 | 2000 | Short-circuits via `shim_policy_short_circuit` |

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
