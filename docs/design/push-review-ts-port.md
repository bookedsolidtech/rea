# Design — `push-review-core.sh` TypeScript port (Defect G)

**Status:** DRAFT — design only, no implementation in this branch.
**Owner:** rea core
**Target:** `@bookedsolid/rea@0.11.0`
**Scope:** port `hooks/_lib/push-review-core.sh` (1250 LOC of bash + jq + awk) to TypeScript with a thin bash shim, ≥90% unit test coverage on the TS module, and zero regression in the existing 12-suite hook integration surface.

Closes defect G as defined in `Rea Bug Reports.md`. Also completes the deferred halves of defect N (fail-loud when no base configured + general `Target:` label fix) which cannot be expressed in the current bash implementation without breaking the cache-key contract.

---

## 1. Motivation

The bash core has absorbed six distinct logic-flaw classes across 0.9.0–0.10.1:

| Defect | Class | Root cause category |
|---|---|---|
| A | invocation | `node <shim>` on pnpm POSIX shim |
| B+C | grep short-circuit | policy-field bypass via substring match |
| J | control-flow nesting | mixed-push deletion guard nested inside fallback |
| K | output composition | `grep -c` "0\n0" duplicated-zero render |
| L | portable hashing | `shasum` missing on Alpine/distroless |
| M | jq typing | `--arg` vs `--argjson` numeric fields |
| N (partial) | resolution path | per-branch base resolution coupling to cache key |
| T/U | jq streaming | single corrupt line aborts the whole scan |

Each class is expressible in TypeScript as a single unit-testable function. Each class is expensive to reason about in bash because the shell environment itself carries implicit state: PATH lookup determines hash binary, word-splitting determines refspec shape, jq exit codes are observed through pipelines. The total attack surface is larger than it looks from the LOC count.

Additionally:

- The push-review-core shim is duplicated into `.claude/hooks/_lib/` for the dogfood install, and upstream-source consumers receive `hooks/_lib/`. Mirror-parity has already caused at least one defect (U was fixed in both files simultaneously; earlier defects required CHANGELOG entries documenting the mirror).
- Integration tests (13 suites in `__tests__/hooks/`) shell out to real git subprocesses. They are slow (dominated by git operations), hard to debug when they fail, and each one rebuilds the same fixture scaffolding.
- `rea doctor` and `rea cache set` already live in TypeScript. Keeping the gate in bash is the last major CLI responsibility outside the TS surface.

## 2. Non-goals for this port

- **No new feature.** The goal is byte-compatible semantics for every external contract (exit codes, stdout banner format, cache-key inputs, audit-record schemas). The only behavioral delta allowed is defect N's fail-loud/label-echo completion.
- **No changes to `settings.json` wiring.** The bash shim at `hooks/push-review-gate.sh` + `hooks/push-review-gate-git.sh` continues to be the Claude Code / native-git entry point. Only the internals change.
- **No changes to cache-key inputs** except as N requires. Every existing cache entry on a consumer's disk must remain valid across the 0.10.x → 0.11.0 upgrade. This is non-negotiable — breaking cache compatibility is what caused the 0.10.1 N-inline-attempt revert.
- **No changes to audit-record format** except as N requires. `codex.review`, `push.review.skipped`, `codex.review.skipped`, `push.review.cache.hit`, `push.review.cache.error`, and any other event emitted by the current core must continue emitting with the same `tool_name`, `event`, and `metadata` shapes.
- **No new bundled dependencies.** TypeScript stdlib + existing `src/audit/` + existing `src/cache/` + Node's `child_process` / `fs`. No new npm packages.

## 3. Module boundary

### 3.1 New TypeScript modules

Create a new `src/hooks/push-review/` subtree:

```
src/hooks/push-review/
├── index.ts          # public entry: runPushReviewGate(ctx)
├── args.ts           # parse stdin-refspecs + argv-refspecs (replaces pr_parse_prepush_stdin + pr_resolve_argv_refspecs)
├── base-resolve.ts   # new-branch base resolution (includes N completion)
├── cache.ts          # cache-key computation + cache lookup/record (wraps existing src/cache/)
├── codex-gate.ts     # codex.review receipt lookup (replaces the jq -R fromjson? scan from U)
├── diff.ts           # merge-base + diff-stat collection
├── banner.ts         # human-readable banner output (replaces inline `echo` + grep -c composition)
├── audit.ts          # audit-record emission (wraps existing src/audit/append.ts)
├── hash.ts           # portable sha256 over strings/files (replaces L's sha256sum→shasum→openssl fallback)
├── protected-paths.ts# protected-path detection from policy
├── metadata.ts       # os_identity/agent_identity/repo_identity emission (replaces M's argjson shape)
├── policy.ts         # loader + REA_SKIP_PUSH_REVIEW/REA_SKIP_CODEX_REVIEW evaluation
└── errors.ts         # typed error set (Blocked, Skipped, CacheHit, CacheError, ReviewRequired, ...)
```

`runPushReviewGate(ctx: PushReviewContext): Promise<PushReviewResult>` is the one exported surface. Every module is independently unit-testable.

### 3.2 Thin bash shims

Keep `hooks/push-review-gate.sh` and `hooks/push-review-gate-git.sh` as the registered entry points. They become ~30 lines each, delegating all logic to the TS module:

```bash
#!/usr/bin/env bash
# hooks/push-review-gate.sh — thin shim, bash-only responsibility is locating the rea CLI.
set -euo pipefail
REA_CLI="$(./.claude/hooks/_lib/rea-cli-locate.sh)"   # sha256 / PATH fallback logic stays in _lib
exec "$REA_CLI" hook push-review-gate "$@"
```

The native-git adapter (`hooks/push-review-gate-git.sh`) gets the same treatment. The `_lib/` directory shrinks to `rea-cli-locate.sh` + a small `push-review-shim.sh` for stdin wiring; the 1250-LOC `push-review-core.sh` is deleted (or kept as a stub that forwards to `rea hook push-review-gate` for operators with pinned hook paths — TBD during implementation).

### 3.3 New CLI subcommand

Add `rea hook push-review-gate` and `rea hook commit-review-gate` under `src/cli/hook.ts`. These are the sole callers of the new TS modules. The hook subcommand is NOT a user-facing surface — it's classified as `internal` tier (reaCommandTier) and the agent guidance is "never invoke directly; the registered hook shim invokes it."

### 3.4 Dogfood install parity

`.claude/hooks/_lib/push-review-core.sh` is deleted entirely from the dogfood install after the port. The shim at `.claude/hooks/push-review-gate.sh` mirrors `hooks/push-review-gate.sh`. This is a one-way change — consumers must run `rea upgrade` to pick up the new shim layout.

## 4. Shim contract (hook → CLI)

The bash shim receives stdin (for `Bash`-PreToolUse hooks: JSON with `tool_input.command` etc.; for native-git pre-push: `<local-ref> <local-sha> <remote-ref> <remote-sha>\n` repeated), the original argv, and the current environment.

The shim forwards everything to the TS CLI via a stable interface:

| Input channel | Shim responsibility | CLI receives |
|---|---|---|
| stdin | pass through unchanged | raw stdin on `process.stdin` |
| argv | pass through unchanged | `process.argv` after `rea hook push-review-gate` |
| env | pass through unchanged | `process.env` |
| cwd | pass through unchanged | `process.cwd()` |
| exit code | propagate unchanged | direct `process.exit(N)` |

The shim adds ONE thing: a `REA_HOOK_ADAPTER` env var set to `claude-code` or `native-git` so the TS CLI knows which stdin parser to dispatch. Everything else is identical.

**Stability guarantee:** the contract is `rea hook push-review-gate [refspec...]` + stdin + env + `REA_HOOK_ADAPTER`. This interface is part of the stable surface. Consumer hook installs that pin a specific hook shim get the shim-level contract; the CLI subcommand is the stable API.

## 5. Test strategy

### 5.1 Unit tests (new)

Each module gets a vitest unit suite in `src/hooks/push-review/*.test.ts`. Target ≥90% line coverage on each module. Specific scenario coverage per defect:

| Module | Defect classes covered by unit tests |
|---|---|
| `args.ts` | stdin refspec parsing (12 scenarios) — incl. mixed push (J), deletion, force-push, tag push, multi-refspec |
| `base-resolve.ts` | branch.<name>.base config hit (N), origin/HEAD fallback, fail-loud-no-base (N completion), upstream-tracking hit, multi-refspec state isolation (N) |
| `codex-gate.ts` | streaming-parse tolerance (U), emission_source predicate (P forgery rejection), legacy-record rejection |
| `hash.ts` | sha256sum / shasum / openssl fallback (L), hex-64 validation, WARN emission |
| `banner.ts` | LINE_COUNT/FILE_COUNT zero-case render (K), unicode filenames, empty-diff edge |
| `metadata.ts` | argjson numeric pid/ppid (M), empty uid string preservation |
| `policy.ts` | REA_SKIP_PUSH_REVIEW reason validation, REA_SKIP_CODEX_REVIEW scope |
| `cache.ts` | cache-key stability across 0.10.x → 0.11.0 for identical push inputs (fixture-based) |

### 5.2 Integration tests (ported, not rewritten)

The 13 existing hook integration suites in `__tests__/hooks/` stay, but are ported to invoke `node dist/cli/index.js hook push-review-gate` instead of `bash hooks/_lib/push-review-core.sh`. This confirms end-to-end parity against real git subprocesses. Specific suites that exercise the behavioral surface:

- `push-review-gate-cli-invocation.test.ts` — correct CLI resolution on pnpm/npm
- `push-review-gate-cross-repo.test.ts` — `--git-common-dir` guard (0.6.1 fix)
- `push-review-gate-escape-hatch.test.ts` — `REA_SKIP_PUSH_REVIEW`
- `push-review-gate-git-adapter.test.ts` — native-git `.husky/pre-push` stdin shape
- `push-review-gate-no-codex.test.ts` — `review.codex_required: false` profile carve-out
- `push-review-gate-policy-bypass.test.ts` — policy-field bypass prevention (B+C regression guard)
- `push-review-gate-portability-security.test.ts` — J/K/L/M regression guard
- `push-review-gate-prepush-stdin.test.ts` — stdin shape contract
- `push-review-gate-skip-push-review.test.ts` — metadata shape
- `push-review-gate-cache-error-surfaces.test.ts` — F's CACHE CHECK FAILED banner
- `push-review-fromjson-tolerance.test.ts` — U regression guard (already covers the new code once re-pointed)
- `husky-e2e.test.ts` — end-to-end `.husky/pre-push` invocation

Each ported suite is a 1-line change (the `bash` invocation becomes `node dist/cli/index.js hook`). Suite runtime should drop because the TS module avoids fork/exec per sub-operation.

### 5.3 New integration tests (required)

- **N completion suites** (three new):
  1. `push-review-gate-base-resolve-config.test.ts` — `git config branch.<name>.base` hit + `Target:` label echo.
  2. `push-review-gate-base-resolve-fail-loud.test.ts` — fail-loud when no base is resolvable (new-branch, no upstream, no config, `origin/HEAD` unset).
  3. `push-review-gate-base-resolve-multi-refspec.test.ts` — state isolation across `git push --all`.
- **Cache-key compatibility suite** — `push-review-gate-cache-key-compat.test.ts`. Fixture: a cache entry written by the 0.10.1 bash implementation against a known diff. The 0.11.0 TS implementation must produce the identical cache key for the identical diff input. If the key diverges, the port has broken every consumer's disk cache and must be corrected before merge.
- **Defect P shell-level integration** — `push-review-gate-forgery-rejection.test.ts`. A hand-written `codex.review` record with `emission_source: "other"` next to a legitimate `rea-cli` record; the gate must accept only the legitimate record.

## 6. Migration plan

### 6.1 Branch sequence

1. **This branch (`feat/push-review-ts-port`)** — design doc only (this file). No code. Push, no PR yet. Jake reviews the design, approves module boundary + test strategy.
2. **`feat/push-review-ts-port-phase-1`** — unit-testable modules: `args.ts`, `base-resolve.ts`, `hash.ts`, `metadata.ts`, `banner.ts`, `protected-paths.ts`, `policy.ts`. Each lands with its unit tests. No shim changes yet — bash core continues to run in production. Merge to main with `0.10.2` pre-release changeset (`patch`, not published, just the accumulated diff).
3. **`feat/push-review-ts-port-phase-2`** — integration modules: `cache.ts`, `codex-gate.ts`, `diff.ts`, `audit.ts`. Compose `runPushReviewGate()` in `index.ts`. Unit tests for composition. No shim changes yet.
4. **`feat/push-review-ts-port-phase-3`** — add `rea hook push-review-gate` / `rea hook commit-review-gate` CLI subcommands. Port the 13 integration tests to the new CLI path. Bash core still runs in production.
5. **`feat/push-review-ts-port-phase-4`** — cut over the shims at `hooks/push-review-gate.sh` + `.claude/hooks/push-review-gate.sh` (and native-git variants) to call the new CLI. Delete `hooks/_lib/push-review-core.sh` and `.claude/hooks/_lib/push-review-core.sh`. Land N completion (fail-loud + label-echo). This is the 0.11.0 release.

Splitting into phases lets each land under the existing L1/L2 autonomy with meaningful Codex review scope per phase. The final phase-4 diff is small (shim swap + delete + N completion) because phases 1–3 have already built the replacement modules and coverage.

### 6.2 Per-phase changeset kind

- Phase 1, 2, 3 → `patch` (internal refactor, no external behavior change). Accumulate as `0.10.2`, `0.10.3`, `0.10.4`.
- Phase 4 → `minor` (0.11.0). This is where the shim swap happens and N completion lands. Justifies the minor bump because the shim delete is observable to operators with pinned hook paths.

### 6.3 Rollback plan

Each phase is independently rollback-able:

- Phases 1–3: the new modules are unused by the running system. A full revert is a clean `git revert`.
- Phase 4: the shim swap is a single commit. Rollback = revert that commit, restoring the bash core (kept in git history even after deletion). Consumers hitting a bug in the TS core can re-install a pinned 0.10.x via `rea upgrade --version 0.10.x` as an operator escape hatch.

## 7. Defect N completion (landed in phase 4)

The fail-loud-no-base and general `Target:` label halves of N deferred from 0.10.1 are expressible in TS without the cache-key contract conflict because:

- The cache-key input is `merge_base_sha + head_sha + sorted_filelist + sorted_linecount`. In the bash implementation these are computed after the target ref is resolved, so changing the resolution source changes the key. In the TS implementation, the cache key is computed from the anchor commit SHA (`merge_base_sha`) directly — the resolution path that produced that SHA is an implementation detail outside the key.
- Fail-loud becomes a typed error class (`NoBaseResolvableError`) in `errors.ts`. The CLI catches it at the top level and prints a dedicated banner: "PUSH BLOCKED: cannot resolve base branch for <source>; run `git branch --set-upstream-to=origin/<target>` or `git config branch.<source>.base <ref>`". Exit 2. No silent fallback to `origin/HEAD`.
- `Target:` label echoes the resolved ref (not the refspec destination), so a feature branch targeting `dev` via `branch.<source>.base` prints `Target: origin/dev` instead of `Target: <source-branch>`.

These three changes are implementable in phase-4's `base-resolve.ts` + `banner.ts` + `cli/hook.ts` glue. The unit tests for `base-resolve.ts` in phase 1 already cover the cases; phase 4 just turns on the fail-loud path and fixes the label.

## 8. Cache-key compatibility (the 0.10.1-revert constraint)

The failed inline-N attempt during 0.10.1 silently invalidated consumer cache entries for bare pushes. The specific failure was: the bash resolver switched to using the refspec-target ref in the cache-key input, which differed from the merge-base-anchor ref the previous version had used. A consumer with a legitimate `pass` entry cached for commit X against base Y suddenly produced key K' instead of K, missed the cache, and re-ran a full Codex review they didn't need.

The TS port pins cache-key input to `merge_base_sha` (the resolved anchor commit SHA, not the ref name). This is already true in the current bash implementation but implicit; the TS port makes it explicit via `cache.ts`'s `computeCacheKey(input: CacheKeyInput)` signature, and the `push-review-gate-cache-key-compat.test.ts` fixture proves byte-exact key parity against 0.10.1 for representative inputs.

Key parity proof:

1. Generate fixture from 0.10.1 bash core: run `push-review-core.sh` in a scratch repo with a known diff, capture the emitted `cache_result` JSON that contains the cache key.
2. Feed the same inputs to `runPushReviewGate()` in TS. Assert the cache key is byte-identical.
3. Repeat for 6 scenarios: bare push, multi-refspec, force-push, deletion, new-branch, cross-repo.

If any scenario diverges, the port is wrong and the commit is rejected in review.

## 9. Security posture

The port does not change the gate's security model. Specifically:

- **Defect P's forgery rejection** (emission_source predicate) is enforced in `codex-gate.ts`. The predicate is identical to the bash jq filter. Unit test: a forged record with `emission_source: "other"` fails the predicate regardless of other fields.
- **Defect J's mixed-push deletion guard** (top-of-function `HAS_DELETE` check) is enforced in `args.ts` before any other refspec logic. Unit test: a mixed push `safe:safe :main` parses as HAS_DELETE=true and blocks.
- **Defect L's portable hashing** is enforced in `hash.ts` via `crypto.createHash('sha256')` (Node stdlib, no external binary dependency). The bash fallback chain is gone — no attack surface around which hasher is on PATH.
- **Defect U's malformed-line tolerance** is enforced in `codex-gate.ts` via line-by-line parse with `JSON.parse` wrapped in try/catch (equivalent to `jq -R 'fromjson?'`). Unit test: a corrupt line sandwiched between two valid records does not hide the valid records.
- **Path-traversal rejection** (from defect I / 0.10.0) in any hook-input path remains enforced via `src/path-safety.ts` (existing module).

New surface introduced by the port:

- **Node process startup cost** — the shim forks `node dist/cli/index.js` per push. Rough budget: 150–250 ms cold start + ~80 ms steady-state. Equivalent to the bash core's fork/exec cost (`jq` + `sha256sum` + `awk` + `git` each fork once). Net wash; no material change to push latency.
- **Node stdlib surface** — `child_process.spawn` for `git` subprocess, `fs.promises` for audit + cache, `crypto` for sha256. All first-party Node APIs, no npm dependency. Every `spawn` call passes args as an array (never a shell string) to avoid argument-injection CVEs.

## 10. Rollout plan

### 10.1 Pre-merge gates

- Phase-1 through phase-3: each PR must have Codex review + green CI + ≥90% line coverage on the touched `src/hooks/push-review/*` files. Existing integration suites must pass in parallel (bash core still running).
- Phase-4 (cutover): Codex review + green CI + the `push-review-gate-cache-key-compat.test.ts` suite must pass + the three new N-completion suites must pass + all 13 ported integration suites must pass against the new CLI path.

### 10.2 Dogfood

Merge each phase to `main`, publish the patch release (0.10.2, 0.10.3, 0.10.4 for phases 1–3), and let the rea repo itself dogfood via `rea upgrade` on the next session start. Phase 4's 0.11.0 release gets a deliberate 24-hour dogfood window on the rea repo before announcing to consumers.

### 10.3 Consumer migration

`rea upgrade` picks up the 0.11.0 package automatically. The shim at `.claude/hooks/push-review-gate.sh` in consumer repos is installed from the package's bundled hooks, so the swap happens at upgrade time. Operators with pinned hook paths (custom `.husky/pre-push` bodies that invoke `push-review-core.sh` directly) get a deprecation notice in `rea doctor`: "detected pinned path to `hooks/_lib/push-review-core.sh`; this file is removed in 0.11.0. Update to invoke `rea hook push-review-gate` instead."

### 10.4 Support window

0.10.x branch receives critical-only fixes for 60 days after 0.11.0 ships. Non-critical defects land only on 0.11.x.

## 11. Open questions (to resolve before phase 1 implementation)

1. Should the shim stub at `hooks/_lib/push-review-core.sh` forward-compat to `rea hook push-review-gate`, or be removed cleanly in 0.11.0? (Trade-off: forward-compat preserves pinned-path installs; clean remove is honest about the contract.)
2. Does `rea hook commit-review-gate` get ported in the same rollout, or is that a separate G2? (The commit gate is 330 LOC, same class of risk, same test surface.)
3. Phase 4's 0.11.0 cut — does the minor bump also bundle the T self-check widen (audit.ts middleware + rotator.ts)? Both are deferred 0.10.1 followups; bundling makes 0.11.0 the "finish 0.10.1 plus the G port" release.
4. Cache-key compat fixtures — recorded now at 0.10.1 or recomputed at each phase boundary? (Record once at 0.10.1 is simpler but risks regression in phases 1–3 going unnoticed until phase 4.)

These are answered before phase 1 starts implementation.

## 12. Appendix — the 1250-LOC measurement

Line counts as of `main` at 0.10.1:

- `hooks/_lib/push-review-core.sh` — 1250 LOC
- `hooks/commit-review-gate.sh` — 330 LOC
- `hooks/push-review-gate.sh` — 92 LOC (shim, already thin)
- `hooks/push-review-gate-git.sh` — 94 LOC (shim, already thin)

jq invocations in push-review-core.sh: 13. awk invocations: 7. sha256/shasum references: 13.

The TS port is targeting ~600 LOC across `src/hooks/push-review/*.ts` plus ~800 LOC of vitest unit tests. Net code-to-test ratio improves from ~bash 1.0:0.3 (estimated) to TS 1.0:1.3. That ratio is the primary justification for the work.
