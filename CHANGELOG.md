# @bookedsolid/rea

## 0.9.4

### Patch Changes

- 2cf00f1: [security] [portability] Close four hook defects surfaced by CodeRabbit review on HELiX PR #1506 (rea#61, #62, #63, #64):
  - **J (CRITICAL security bypass, rea#61)** — mixed-push deletion guard in `push-review-core.sh` was nested inside the `[[ -z SOURCE_SHA || -z MERGE_BASE ]]` fallback. A mixed push such as `git push origin safe:safe :main` set `SOURCE_SHA` from the safe refspec and set only `HAS_DELETE=1` from the delete refspec — the nested deletion block never evaluated and the deletion passed the gate unchecked. The `HAS_DELETE` check is now hoisted above the fallback so any deletion in any refspec blocks the entire push.
  - **K (MEDIUM user-facing render, rea#62)** — `LINE_COUNT` and `FILE_COUNT` in the `PUSH REVIEW GATE` banner used `grep -c ... 2>/dev/null || echo "0"`. When grep exited non-zero on a no-match it still printed its own `0` to stdout, and the `|| echo "0"` branch appended another, yielding `0\n0` interpolated into the banner. Replaced with `|| true` + `${VAR:-0}` default.
  - **L (HIGH silent cache disarm, rea#63)** — `PUSH_SHA` was computed via `shasum -a 256 | cut -d' ' -f1 2>/dev/null || echo ""`. On Alpine, distroless, and most minimal Linux CI images `shasum` is not installed (only `sha256sum` is), so the pipeline failed and `|| echo ""` produced an empty `PUSH_SHA`. Combined with the silent cache-miss fallback (separate Defect F, scheduled 0.10.0), every push from such runners burned a full fresh codex review invisibly. Replaced with a portable `sha256sum → shasum → openssl` chain, hex-64 validation, and a visible WARN when no hasher is found. The openssl branch uses `awk '{print $NF}'` without `-r` to stay compatible with OpenSSL 1.1.x (Debian 11, Ubuntu 20.04, RHEL 8, Amazon Linux 2).
  - **M (MEDIUM schema drift, rea#64)** — `SKIP_METADATA` used `jq --arg os_pid` / `--arg os_ppid`, which always produces string-typed fields. Downstream auditors querying `.metadata.os_identity.pid == 1234` (numeric) silently got zero matches. Switched to `--argjson` for `os_pid` / `os_ppid` (both come from bash internals `$$` / `$PPID`, guaranteed non-empty numeric). `os_uid` stays on `--arg` because `id -u 2>/dev/null || echo ""` can legitimately return empty.

  Regression coverage: new `__tests__/hooks/push-review-gate-portability-security.test.ts` exercises all four defects (9 cases). Existing `push-review-gate-skip-push-review.test.ts` assertions for pid/ppid type flipped from `string` to `number` per M.

## 0.9.3

### Patch Changes

- c3817e3: [security] Close two push/commit-gate bypasses.

  **Defect B** — Remove `push_review: false` / `commit_review: false` grep
  short-circuits from `hooks/_lib/push-review-core.sh` (section 5) and
  `hooks/commit-review-gate.sh` (section 5). A single line in `.rea/policy.yaml`
  could silently disable the entire push or commit gate with no audit trail.
  The only supported whole-gate escape hatch for the push path is now the
  env-var opt-in `REA_SKIP_PUSH_REVIEW=<reason>`, which requires an explicit
  reason, a git identity, and writes a `push.review.skipped` audit record.

  Pre-existing carve-outs that remain intentional, documented, and audited
  where applicable (not closed by this hotfix): (1) `review.codex_required:
false` in policy disables only the protected-path Codex branch — a
  per-profile no-Codex mode, covered by
  `__tests__/hooks/push-review-gate-no-codex.test.ts`; (2) the env-var
  waiver `REA_SKIP_CODEX_REVIEW=<reason>` short-circuits only the Codex
  protected-path branch and writes an audited `codex.review.skipped` record
  (see `hooks/_lib/push-review-core.sh` section 5c and #85); (3) `git commit
--amend` short-circuits the commit-review gate because amendment review is
  out of scope for this iteration of the hook.

  **Defect C** — Extend the protected-paths matcher in
  `hooks/_lib/push-review-core.sh` to include `.rea/` and `.husky/`. Diffs
  touching these trees now require a `/codex-review` audit entry before push,
  matching the five pre-existing protected roots (`src/gateway/middleware/`,
  `hooks/`, `.claude/hooks/`, `src/policy/`, `.github/workflows/`). The
  error-message listing is updated in lockstep. The awk regex uses the
  bracket-literal `[.]rea/` and `[.]husky/` forms so bare project folders
  named `rea/` (e.g. `Projects/rea/Bug Reports/`) do not spuriously trigger
  the gate.

  New test suite `__tests__/hooks/push-review-gate-policy-bypass.test.ts`
  covers: `push_review: false` no longer bypasses, `commit_review: false` no
  longer bypasses, `.rea/` diff triggers Codex, `.husky/` diff triggers Codex,
  `Projects/rea/` (no leading dot, nested) does not fire, and top-level
  `rea/` (no leading dot, root) does not fire — the last case pins the
  load-bearing `[.]` bracket literal against future regex drift. A parity
  assertion block also pins byte-identity between `hooks/commit-review-gate.sh`
  and its `.claude/hooks/` dogfood mirror (the push-core mirror parity is
  already asserted in the adapter suite).

  Also extends `scripts/tarball-smoke.sh`: the `[security]` changeset gate now
  recognizes `__tests__/hooks/(*security*|*bypass*|*sanitize*|*injection*).test.ts`
  and asserts the hook files those tests exercise ship in both the tarball and
  the post-`rea init` install surface. A `[security]` hook-test file that
  yields zero extractable hook refs fails the gate loudly (template-literal or
  helper-indirection shapes are rejected). Granularity is per-test-file, not
  per-`it()` block — mixing unrelated `it()` cases in one file dilutes the
  proof and PR review is the mitigation.

  Dogfood mirrors under `.claude/hooks/` synced. No runtime signature or
  public-API change.

## 0.9.2

### Patch Changes

- 758f978: fix(hooks): execute `node_modules/.bin/rea` directly instead of via `node`

  The push-review-gate and commit-review-gate hooks previously resolved the rea
  CLI with `node "${REA_ROOT}/node_modules/.bin/rea"`. That path is NOT a plain
  JavaScript file — pnpm writes a POSIX shell-script shim there, and npm writes
  a symlink whose target carries its own `#!/usr/bin/env node` shebang. Running
  `node` on the shim parsed shell syntax as JavaScript and threw `SyntaxError`.
  The caller's `|| echo '{"hit":false}'` fallback silently masked the error,
  turning every push-review cache lookup into a miss — so a previously-approved
  push always re-tripped the review-required gate and every push was blocked.

  Two changes to the CLI-resolution ladder in `hooks/_lib/push-review-core.sh`
  and `hooks/commit-review-gate.sh` (and their dogfood copies under
  `.claude/hooks/`):
  - `-f` → `-x`: require the shim to be executable before attempting to use it.
  - Drop the `node` prefix on the shim branch. The shim handles `exec node` itself.

  The dogfood fallback (`dist/cli/index.js`) keeps the `node` prefix because that
  entry point IS a real JavaScript module.

  Regression test added at `__tests__/hooks/push-review-gate-cli-invocation.test.ts`
  covering three cases: pnpm-style shim, dogfood fallback, and a non-executable
  shim that must fall through to the dist branch.

## 0.9.1

### Patch Changes

- a61371f: docs: cumulative 0.3.0 → 0.9.0 catchup

  Documentation-only release. The README, threat model, security policy,
  contributor guide, project instructions, and the 0.5.0 migration note
  had drifted behind the codebase across the 0.3.0 → 0.9.0 window. No
  runtime changes.
  - **README.md**: full refresh. Live badges (npm, CI, provenance).
    Version status updated to 0.9.x. `rea status` section now documents
    the per-downstream live block (`name`, `circuit_state`,
    `retry_at`, `connected`, `healthy`, `last_error`,
    `tools_count`, `open_transitions`, `session_blocker_emitted`) and
    names `.rea/serve.state.json` as the live source. New sections
    describe the `__rea__health` meta-tool with default-safe payload
    and the `gateway.health.expose_diagnostics` opt-in, the 0.9.0
    gateway supervisor + SESSION_BLOCKER tracker, the 0.6.1 cross-repo
    guard via `git --git-common-dir`, the 0.6.2 script-anchor fallback
    (BUG-012, scoped to the review-gate hooks — the remaining hooks
    still derive `REA_ROOT` from `${CLAUDE_PROJECT_DIR:-$(pwd)}` and
    that caveat is now called out explicitly), the 0.7.0 shared
    push-review core + native git adapter, 0.8.0 Codex-only waiver
    semantics with cache-gate hardening, 0.3.0 `${VAR}` env
    interpolation with redact-by-default, and the 0.3.0 G9 three-tier
    injection classifier (verdicts `clean` / `suspicious` /
    `likely_injection`) with the strict flag. Middleware-chain diagram
    corrected to place `injection` below the EXECUTE bar (it is a
    post-execute middleware that scans `ctx.result`, not arguments).
    Hook inventory corrected: 14 scripts total ship, 12 registered in
    the default `.claude/settings.json`; the remaining two
    (`commit-review-gate.sh` as a `PreToolUse: Bash` hook matching
    `git commit`, and `push-review-gate-git.sh` as a native-git adapter
    sourcing `hooks/_lib/push-review-core.sh` for consumers who wire a
    wrapper-based `.husky/pre-push`) are shipped ready-to-wire but
    intentionally not registered by default. `rea init`'s default
    installer still emits a standalone inline `.husky/pre-push` body
    (`src/cli/install/pre-push.ts`) rather than a wrapper around the
    adapter; shared-core unification for the husky path is tracked as
    follow-up hardening. Protected-path push-review-gate behavior
    described correctly as hard-block (exit 2) rather than
    advisory-warn, with the Codex waiver documented as the only way
    through the protected-path branch without a fresh `codex.review`
    audit entry; the review cache is a separate later check scoped to
    non-protected-path pushes. `rea doctor` description rewritten to
    list actual checks (`.rea/` dir, policy, registry, agents, hooks,
    `.claude/settings.json`, commit-msg, pre-push, Codex, fingerprint
    store); removed false `.mcp.json` and audit-hash-chain claims.
    Policy reference table adds review/injection/gateway/redact knobs.
  - **THREAT_MODEL.md**: header bumped to 0.9.x / 2026-04-21.
    §5.8 rewritten to describe current Codex-only waiver semantics;
    cache-gate hardening scoped correctly to the general (non-protected-
    path) gate rather than the protected-path branch. §6 residual-risks
    table marks shipped items, promotes surviving risks, and restores
    "Catalog drift by downstream not detected on reconnect" as an ACTIVE
    residual risk (the G7 TOFU fingerprint pins registry CONFIG, not
    the `tools/list` response, so catalog drift falls through). New
    sections §5.14 (supervisor trust boundary), §5.15 (SESSION_BLOCKER
    audit semantics), §5.16 (`serve.state.json` atomic writer +
    lock-guarded owner_pid handoff), §5.17 (BUG-011 health payload
    sanitization — the opt-in sanitizer collapses any non-`clean`
    diagnostic to the exported `<redacted: suspected injection>`
    placeholder, full diagnostic still flows into the meta-tool audit
    record sourced pre-sanitize from `pool.healthSnapshot()` inside
    `server.ts`), §5.18 (BUG-012 script-anchor trust boundary —
    `CLAUDE_PROJECT_DIR` is advisory-only for the review-gate hooks
    only), §5.19 (BUG-013 tarball-smoke security-claim gate +
    dist-regression; §5.19 husky-e2e description corrected to reflect
    that the shipped `.husky/pre-push` is the inline body emitted by
    `src/cli/install/pre-push.ts`, with one case swapping in a
    wrapper around `push-review-gate-git.sh` as shape-guard for the
    future installer path), §5.20 (G7 TOFU — REWRITTEN to describe the
    path-only registry-config fingerprint that ships in
    `src/registry/fingerprint.ts`: hashes `name` + `command` + `args`
    - env KEY SET + `env_passthrough` + `tier_overrides`, explicitly
      NOT tool-surface and NOT binary), §5.21 (G9 three-tier injection
      classifier — verdicts are `clean` / `suspicious` /
      `likely_injection`). §7 defense-in-depth summary updated to match
      the corrected hook-inventory framing. Source file refs corrected
      to actual paths (`src/gateway/server.ts`,
      `src/gateway/downstream.test.ts`).
  - **SECURITY.md**: supported-versions matrix updated to 0.9.x active /
    0.8.x critical-fixes-only / older superseded. Hook count and
    registration nuance aligned with the README. `set -euo pipefail`
    claim tightened to cover the `set -uo pipefail` variant used by
    stdin-JSON hooks. Adds pointer to §5.18 for the script-anchor
    trust model.
  - **CLAUDE.md**: managed block reflects current policy state (4
    blocked_paths, not 8). Project status updated to 0.9.x. Hook
    reference now lists the Claude-Code + native-git push adapters
    separately, describes the shared `_lib/push-review-core.sh`, and
    calls out that the default `rea init` husky installer still emits
    an inline pre-push body rather than a wrapper.
  - **MIGRATION-0.5.0.md**: forward-pointer added at the top flagging
    the 0.8.0 `REA_SKIP_CODEX_REVIEW` narrowing as the one breaking
    semantic between 0.5.0 and 0.9.0.
  - **src/cli/status.ts**: top-of-file docblock updated to describe the
    0.9.0 per-downstream live block and the terminal-escape sanitizer on
    disk-sourced fields.
  - **.rea/policy.yaml**: removes `THREAT_MODEL.md`, `SECURITY.md`,
    `CODEOWNERS`, and `.rea/policy.yaml` from the dogfood install's
    `blocked_paths`. Per-file post-change enforcement:
    - `.rea/policy.yaml` — still locally gated by
      `settings-protection.sh` (hardcoded). No change in local
      enforcement.
    - `SECURITY.md`, `THREAT_MODEL.md`, `CODEOWNERS` — local hook gate
      removed. Enforcement is now CODEOWNERS + DCO + branch protection
      at the GitHub layer only. Intentional — these are maintainer-
      authored reference docs and the prior double-gate created a
      chicken-and-egg problem when `THREAT_MODEL.md` itself needed an
      update.

    Always-blocked invariants (`.env`, `.env.*`, `.rea/HALT`,
    `.github/workflows/release.yml`) remain in place.

## 0.9.0

### Minor Changes

- e43d96e: Gateway supervisor, SESSION_BLOCKER events, and per-downstream `rea status`
  (BUG-002..006, T2.4 from 0.6.2 deferred).

  Before this release, a downstream MCP child that crashed left the gateway's
  circuit breaker flapping open → half-open → open against the zombie client.
  The half-open probe reused the dead handle, received `Not connected`, and
  re-opened the circuit without ever respawning the child. Operators had no
  live view of which downstream had wedged: `rea status` only surfaced
  session-wide fields, and `__rea__health` was only reachable over the MCP
  transport that had (often) already broken.

  Changes:
  - **Supervisor / respawn** — `DownstreamConnection` now wires `onclose` and
    `onerror` on the MCP SDK transport. Unexpected closes null the client and
    transport eagerly so the next `callTool` forces a genuine reconnect
    rather than calling into a stale handle. `Not connected` errors are
    promoted to the respawn path with the same eager invalidation. Intentional
    `close()` is gated so it does not double-count as an unexpected death.
  - **SESSION_BLOCKER event** — new `SessionBlockerTracker` subscribes to
    circuit-breaker `onStateChange` events, counts circuit-open transitions
    per (session_id, server_name), and emits a single LOUD `SESSION_BLOCKER`
    log record plus audit entry when the threshold (default: 3) is crossed.
    Recovery resets the counter and re-arms the emit; a new session drops
    every counter. Further opens within an armed window do NOT re-fire.
  - **Live `rea status`** — the gateway now publishes `serve.state.json`
    with a `downstreams` block on every circuit-breaker transition and
    supervisor event, coalesced through a 250 ms debounce and written
    atomically via temp+rename. `rea status` (both pretty and `--json`)
    surfaces per-downstream `circuit_state`, `retry_at`, `connected`,
    `healthy`, `last_error`, `tools_count`, `open_transitions`, and
    `session_blocker_emitted`. Legacy state files without a `downstreams`
    key degrade to a null field and a hint to upgrade the gateway.

  No API removals. New gateway options (`liveStateFilePath`,
  `liveStateSessionId`, `liveStateStartedAt`, `liveStateMetricsPort`,
  `liveStateLastErrorRedactor`) and new `GatewayHandle` fields
  (`livePublisher`, `sessionBlocker`) are additive and optional.
  `liveStateLastErrorRedactor` scrubs downstream error strings before they
  land in `serve.state.json`; `rea serve` wires it automatically to the
  same `buildRegexRedactor` the gateway logger uses.

## 0.8.0

### Minor Changes

- 5433023: Narrow `REA_SKIP_CODEX_REVIEW` from a whole-gate bypass to a Codex-only waiver (#85).

  Through 0.7.0, setting `REA_SKIP_CODEX_REVIEW=<reason>` short-circuited the entire push-review gate after writing the skip audit record — equivalent in scope to `REA_SKIP_PUSH_REVIEW`. Operators reached for it to silence a transient Codex unavailability and accidentally bypassed every other check (HALT, cross-repo guard, ref-resolution, push-review cache).

  Starting in 0.8.0, the waiver only satisfies the protected-path Codex-audit requirement (section 7). Every other gate this hook runs still runs:
  - **HALT** (`.rea/HALT`) — still blocks.
  - **Cross-repo guard** — still blocks.
  - **Ref-resolution failures** (missing remote object, unresolvable source ref) — still block, but the skip audit record is written first so the operator's commitment is durable.
  - **Push-review cache** — a miss still falls through to the general "Review required" block in section 9.

  (Blocked-paths enforcement runs on a separate Edit/Write-tier hook, not this push hook — it was never scoped by `REA_SKIP_CODEX_REVIEW` and is unaffected by this change.)

  **Migration.** For the previous whole-gate bypass semantic, use `REA_SKIP_PUSH_REVIEW=<reason>` (unchanged). For a protected-path push where Codex is genuinely unavailable, `REA_SKIP_CODEX_REVIEW=<reason>` combined with a valid push-review cache entry (from `rea cache set <sha> pass ...`) is the new minimum for exit 0.

  **Audit.** The skip audit record is still named `codex.review.skipped` and still fails the `codex.review` jq predicate. Banner text changed from `CODEX REVIEW SKIPPED` to `CODEX REVIEW WAIVER active` to reflect the narrower scope.

  **Cache gate hardening (same release).** Two composition bugs that became load-bearing under the new waiver semantic were fixed at the same time:
  - The cache-hit predicate now requires `.hit == true and .result == "pass"`. Previously `.hit == true` alone was sufficient, which meant a cached `fail` verdict would silently satisfy the gate. Under the 0.7.0 semantic the waiver short-circuited to exit 0 on its own, so the cache lookup was not load-bearing for waiver users; under 0.8.0 the cache is the only path to exit 0 for waiver users, making the permissive predicate a real exposure.
  - The cache key is now derived from the PUSHED source ref (from pre-push stdin), not from the checkout branch. `git push origin hotfix:main` from a `feature` checkout now looks up a cache entry keyed on `hotfix`, not `feature`.

  Closes the "Codex waiver accidentally bypasses HALT" class of operator footguns. The old semantic was shipped as a workaround in 0.3.x before the general gate composed cleanly; 0.8.0 is the cleanup pass.

## 0.7.0

### Minor Changes

- 5ffece8: 0.7.0 — BUG-008 cleanup, BUG-013/014 defense-in-depth, release-pipeline hardening, CI regression guards
  - **BUG-008 cleanup — shared push-review core + native git adapter.** The
    700-line `push-review-gate.sh` and `commit-review-gate.sh` hooks shared
    no implementation. Two bugs in the same body of logic meant two fixes
    in two places. 0.7.0 extracts the common logic into
    `hooks/_lib/push-review-core.sh` (sourced by thin adapters) and ships
    a new `hooks/push-review-gate-git.sh` that consumers wire into
    `.husky/pre-push` directly. The adapter consumes git's native pre-push
    stdin (`<ref> <sha> <ref> <sha>` per line) without needing the
    BUG-008 sniff in the generic adapter. Existing consumers of
    `push-review-gate.sh` are unaffected — the sniff still works. Full
    parity test matrix verifies the two adapters produce identical
    exit codes + load-bearing stderr across every core branch.
  - **BUG-014 (structural defense-in-depth):** `DownstreamConnection.lastError`
    is now bounded at write, not at read. 0.6.2 applied
    `boundedDiagnosticString` at the getter — every assignment site was
    trusted to eventually flow through the read path. 0.7.0 moves the
    bound into a `set #lastErrorMessage` setter on a true ES-private
    backing field, so the invariant is structural: every write produces
    a bounded stored value regardless of how many assignment sites exist
    or where they live. The setter also rejects non-string inputs with
    `TypeError` instead of silently corrupting the field. Public API is
    unchanged (`get lastError(): string | null`).
  - **Release-pipeline hardening (BUG-013 follow-through):**
    `.github/workflows/release.yml` now (a) rebuilds `dist/` from the
    shipping HEAD immediately before `changesets/action` and records a
    SHA-256 tree hash to `$RUNNER_TEMP/rea-dist-hash`, and (b)
    post-publish, re-packs the just-published tarball from npm and fails
    the release if the published tarball's `dist/` tree hash doesn't
    match the CI-built hash. The hash file lives in CI scratch space so
    it cannot be accidentally committed by `changesets/action`'s
    `git add .`.
  - **Class-level dist/ regression gate (generalizes BUG-013):** new
    `scripts/dist-regression-gate.sh` + `dist-regression` CI job fire on
    every PR and every push:main. If `src/` has changed vs the last
    published tag but the rebuilt `dist/` tree hashes identically to the
    published tarball, CI fails. The 0.6.0 → 0.6.1 "src changed, dist
    didn't" regression class is now caught BEFORE the release branch,
    not only at publish time. Skip surface designed so registry outages
    and malformed prior releases don't pin CI into red.
  - **Husky e2e regression guard:** new
    `__tests__/hooks/husky-e2e.test.ts` invokes a REAL `git push` against
    a bare remote via `core.hooksPath=.husky`, with the SHIPPED
    `.husky/pre-push` in place. The eight-test matrix validates the full
    plumbing (protected-path block, clean pass, HALT, waiver,
    `review.codex_required: false`, counterfactual noop hook,
    native-adapter wrapper shape, `.claude/hooks/` PROTECTED_RE
    alternative) — the kind of BUG-008 silent-exit-0 regression that
    slipped past synthesized-stdin unit tests through 0.4.0 would now
    fail loudly.
  - **push-review-gate ordering (0.7.0 follow-up to BUG-009):**
    `REA_SKIP_CODEX_REVIEW` now resolves before ref-resolution, so the
    bypass works on stale checkouts where the remote ref has gone
    missing (previously a bogus remote SHA would crash the gate before
    the skip could fire). The skip still honors policy: if
    `review.codex_required: false`, the env var is a no-op (unchanged
    G11.4 semantic). Skip audit metadata is now parsed from the pre-push
    stdin contract (`<local_ref> <local_sha> <remote_ref> <remote_sha>`)
    rather than guessed from `git rev-parse HEAD`, so
    `git push origin hotfix:main` from a `feature` checkout now
    correctly records the `hotfix` SHA in the skip receipt.
    `files_changed` in skip records is `null` (authoritative push window
    is unavailable pre-ref-resolution); a new `metadata_source` field
    tags the record as `prepush-stdin` or `local-fallback`.
  - **Master-default fork support (C1):** new-branch push (remote SHA =
    zero) now probes `origin/HEAD` → `origin/main` → `origin/master` via
    `git rev-parse --verify` before falling back. Earlier versions
    hard-coded `origin/main` as the merge-base anchor, which fails-closed
    noisy on master-default forks. `.husky/pre-push` and
    `hooks/_lib/push-review-core.sh` share the same probe order.
  - **Fail-closed on empty merge-base (`.husky/pre-push`):** a genuine
    merge-base resolution failure between two known SHAs (e.g. unrelated
    histories, transient git failure) now blocks the push with a
    diagnostic instead of silently continuing. The bootstrap scenario —
    first push to an empty remote with no remote-tracking ref — is
    distinguished from the failure path and skipped cleanly, since there
    is no baseline to diff against.
  - **Zero-SHA regression coverage (C2):** three new tests in
    `push-review-gate-git-adapter.test.ts` exercise the new-branch
    zero-SHA path (`refs/heads/feature <sha> refs/heads/feature 0000...`)
    across all probe permutations — `origin/HEAD` set, `origin/HEAD`
    absent with `origin/main` present, and `origin/HEAD` + `origin/main`
    both absent with `origin/master` present (C1 fallback).
  - **Bare-remote tempdir cleanup (C3):** three push-review-gate test
    suites (`no-codex`, `escape-hatch`, `skip-push-review`) now track
    both the scratch repo and its bare remote in the cleanup list. Prior
    versions only cleaned the scratch repo; the bare remote leaked across
    CI runs. A `track(repo)` helper centralizes the pattern.
  - **THREAT_MODEL §5.2a:** documents `CLAUDE_PROJECT_DIR` as
    advisory-only — the script-anchor idiom owns the trust decision,
    the env var is kept only for diagnostic signal.

## 0.6.2

### Patch Changes

- e4702da: [security] Helix team blocker clearance — BUG-011, BUG-012, BUG-013

  Three coordinated fixes shipped together so the Helix team (primary rea
  consumer) can merge their pending 0.6.0 upgrade PR.

  **BUG-011 (HIGH, security) — `__rea__health` meta-tool payload sanitization.**
  The meta-tool short-circuits the middleware chain (intentionally, so it stays
  callable under HALT) and previously serialized `halt_reason` and every
  `downstreams[].last_error` verbatim. Error strings from upstream MCPs could
  contain secrets (API keys, tokens) or prompt-injection payloads, neither of
  which was filtered because the redact + injection middleware does not run on
  the short-circuited response. Net effect: a redact + injection-sanitizer bypass
  callable precisely when HALT should be holding the line.

  Fix: the health response now has `halt_reason: null` and every
  `downstreams[].last_error: null` by default. Full diagnostic detail continues
  to flow into `rea doctor` (which reads `pool.healthSnapshot()` pre-sanitize)
  and into the meta-tool audit record — the entry written for
  `__rea__health` now carries `metadata.halt_reason` and
  `metadata.downstream_errors[]` alongside the existing counts. The audit log
  is on local disk, hash-chained append-only, and not LLM-reachable, so it is
  the correct sink for the trusted-operator diagnostic text. Operators who
  need the upstream error text on the MCP wire itself can opt in via
  `gateway.health.expose_diagnostics: true` in `.rea/policy.yaml`; opt-in mode
  still runs the sanitizer (redact + injection-classify with a placeholder
  replacement for suspected-injection strings). Diagnostic strings are bounded
  at 4096 UTF-16 code units before redact/inject scanning runs (with a UTF-8-
  safe truncate that drops trailing lone surrogates), so an adversarial
  downstream cannot DoS the tool by throwing oversize errors.

  Secondary: `meta.health.audit_failed` log elevated from `warn` to `error`, and
  `summary.audit_fail_count` is exposed in the snapshot so operators can detect
  an audit-sink failure without parsing stderr.

  New regression suite `src/gateway/meta/health-sanitize.test.ts` asserts that no
  combination of policy and HALT state can surface a synthetic secret or
  injection payload on the MCP wire, and that the redact-timeout sentinel never
  reaches the caller verbatim.

  **BUG-012 (MEDIUM, trust boundary) — script-location anchor for cross-repo
  guard.** The 0.6.1 cross-repo hook guard used
  `REA_ROOT=${CLAUDE_PROJECT_DIR:-$(pwd)}`. `CLAUDE_PROJECT_DIR` is
  caller-controlled, so any process that exported a foreign path could both
  bypass the gate AND bypass HALT.

  Fix: hooks now anchor `REA_ROOT` to the script's on-disk location via
  `BASH_SOURCE[0]` + `pwd -P`, then walk up to 4 parent directories looking for
  `.rea/policy.yaml` as the authoritative install marker. Fail-closed if no
  marker is found within the ceiling. `CLAUDE_PROJECT_DIR` is now treated as an
  advisory-only signal — if it is set and does not agree with the script-derived
  root, an advisory warning is printed and the script-derived value wins. The
  guard's cross-repo detection now compares the working directory's
  git-common-dir against the anchor's, fails closed on probe failure or on mixed
  git/non-git state, and falls back to path-prefix only when BOTH sides are
  non-git (the documented 0.5.1 escape-hatch scenario).

  Regression test in `__tests__/hooks/push-review-gate-cross-repo.test.ts` —
  BUG-012: foreign `CLAUDE_PROJECT_DIR` does NOT bypass HALT.

  **BUG-013 (HIGH, process) — release-pipeline dist/ verification.** 0.6.1 (tag)
  shipped with a `dist/` tree byte-identical to 0.6.0 — confirmed by Helix via
  `diff -qr`. Without a pipeline gate that rebuilds `dist/` from the shipping
  commit and verifies the published tarball contents, no future security
  changeset can be trusted.

  This release ships the in-repo half of the fix: `scripts/tarball-smoke.sh`
  now enforces a content-based security-claim gate. When any `.changeset/*.md`
  contains the `[security]` marker, the smoke requires that at least one
  `src/**/*(sanitize|security)*.test.ts` file exists AND that every named-import
  symbol it pulls from a relative path is present in the compiled `dist/` tree.
  The gate fails loudly (exit 2) if the marker is present but no testable
  security symbols are extractable — which is exactly the signal the 0.6.0→0.6.1
  regression would have produced, because the claimed fix would have to appear
  as at least one new test-referenced export under `dist/`.

  Pipeline-level rebuild-before-publish + post-publish tarball hash verification
  steps are drafted in `.rea/drafts-0.6.2/release-yml-patch.md` for hand-apply to
  `.github/workflows/release.yml` — CODEOWNERS blocks direct agent commits to
  that path, so those steps ship in a follow-up patch authored by a human
  maintainer. The tarball-smoke gate in this release is the bypass-resistant
  content check; the workflow-level hash verification is the defense-in-depth
  layer that will land alongside it.

## 0.6.1

### Patch Changes

- b32402c: fix(hooks): push/commit gates exit 0 when cwd is outside CLAUDE_PROJECT_DIR

  When `CLAUDE_PROJECT_DIR` points to the rea repo but the current working
  directory is a different repository (e.g. a Claude Code session rooted in rea
  upgrading a consumer project's `@bookedsolid/rea` dependency), the
  `push-review-gate.sh` and `commit-review-gate.sh` PreToolUse hooks now
  short-circuit with exit 0 so the foreign repo's `git push` / `git commit`
  proceeds unblocked.

  Pre-fix behavior: ref-resolution inside `resolve_argv_refspecs` ran
  `git rev-parse` inside `REA_ROOT` for refs that only existed in the consumer
  repo, hard-failing with `PUSH BLOCKED: could not resolve source ref`. That
  failure happened BEFORE the `REA_SKIP_PUSH_REVIEW` / `REA_SKIP_CODEX_REVIEW`
  escape hatches could be checked, leaving consumers with no documented way to
  unblock cross-repo work. Discovered during the 0.6.0 consumer upgrade wave.

  The guard uses `pwd -P` to compare real (symlink-resolved) paths; pushes from
  within rea itself or any of its subdirectories behave exactly as before.

## 0.6.0

### Minor Changes

- ccda930: feat(gateway): always expose `__rea__health` meta-tool for self-diagnostic

  The gateway now advertises a single gateway-internal tool, `__rea__health`,
  that is always present in `tools/list` regardless of downstream state. Calling
  it returns a structured snapshot of the gateway version, uptime, HALT state,
  policy summary, and per-downstream connection/health/tool-count — so an LLM
  session that sees an empty or suspicious catalog can ask the gateway _why_
  instead of guessing.

  The short-circuit handler bypasses the middleware chain (including the
  kill-switch) so the tool remains callable while HALT is active — this is the
  tool operators reach for when everything else is frozen. Every invocation
  still writes an audit record via `appendAuditRecord` so calls remain
  accountable.

  Downstream connections now track their most recent `lastError` message and
  expose an `isConnected` getter; the pool aggregates these via a new
  `healthSnapshot()` method. Stale successful `tools/list` counts are cached
  per-server so the health response can include counts even when a listing
  pass fails.

### Patch Changes

- ccda930: fix(doctor): skip git-hook checks when `.git/` is absent

  `rea doctor` no longer hard-fails on the `pre-push hook installed` check and
  no longer warns on the `commit-msg hook installed` check when the consumer's
  project is not a git repository. Instead, a single informational line —
  `[info] git hooks  (no '.git/' at baseDir — commit-msg / pre-push checks
skipped (not a git repo))` — replaces both checks, and `rea doctor` exits 0
  when all other checks pass.

  This matters for knowledge repos and other non-source-code projects that
  consume rea governance (policy, blocked paths, injection detection) but have
  no commits to gate. `rea init` already skipped commit-msg and pre-push
  install gracefully in a non-git directory; the doctor is now symmetric.

  Detection is done by a new exported helper `isGitRepo(baseDir)` that accepts
  all three real-world git-repo shapes — `.git/` directory (vanilla),
  `.git` file pointing at a valid gitdir (linked worktree / submodule), or
  a `.git` symlink to either of the above — and crucially **rejects stale
  gitlinks** whose target has been pruned. A submodule whose parent was moved
  or a linked worktree whose main repo was deleted both leave `.git` as a
  file with a `gitdir:` pointer to nowhere; `isGitRepo` returns false for
  these so the escape hatch kicks in the way operators expect.

  Security: removing `.git/` does not bypass governance. The governance
  artifact is the pre-push hook git invokes on `git push`; a directory with
  no `.git/` has no pushes to gate. `isGitRepo` is a UX predicate for
  doctor, not a trust boundary.

## 0.5.0

### Minor Changes

- edf6849: **fix(push-gate): BUG-008 pre-push stdin self-detect + BUG-009 `rea cache` subcommand + BUG-010 `.gitignore` scaffolding**

  The 0.3.x/0.4.0 push-review-gate silently became a no-op whenever a
  consumer wired it into `.husky/pre-push`. Git sends the pre-push
  stdin contract (`<ref> <sha> <ref> <sha>` lines), the gate expected
  Claude-Code JSON (`.tool_input.command`), the jq parse produced an
  empty `CMD`, and the `[[ -z "$CMD" ]]` early return fired. No review
  ran. Every pre-push invocation returned 0.

  This release ships the paired fix:
  - **BUG-008 self-detect** (`hooks/push-review-gate.sh`). When jq
    returns an empty command, the hook now sniffs the first non-blank
    stdin line for the git pre-push refspec shape. On match, it
    synthesizes `CMD="git push <argv-remote>"` so the existing step-6
    pre-push parser handles refspecs natively.
  - **BUG-009 `rea cache` subcommand**. `hooks/push-review-gate.sh:700`
    has called `rea cache check` since 0.3.x — but the subcommand was
    never shipped. Consumers hit `error: unknown command 'cache'`, the
    hook swallowed it to `{"hit":false}`, and every protected-path
    push re-ran Codex review. With BUG-008 fixed, the gate now actually
    fires on pre-push, so without the cache subcommand every protected
    push would deadlock. Ships together.

    New subcommands (`rea cache check|set|clear|list`) back a keyed
    JSONL store at `.rea/review-cache.jsonl`. Idempotent last-write-wins
    on `(sha, branch, base)`. TTL via `review.cache_max_age_seconds`
    (default 3600s).

  - **`REA_SKIP_PUSH_REVIEW` whole-gate escape hatch**
    (`.claude/hooks/push-review-gate.sh` only — the husky-side skip is
    deferred to a follow-up PR in the 0.5.0 window). Existing
    `REA_SKIP_CODEX_REVIEW` bypasses only the Codex-audit branch.
    `REA_SKIP_PUSH_REVIEW=<reason>` bypasses the entire gate — the
    recovery path for consumers deadlocked on a broken rea install
    (as BUG-009 created). Fail-closed: requires a built rea + git
    identity. Writes `tool_name: "push.review.skipped"` audit record.
    A skip does NOT satisfy the Codex-review jq predicate. The HALT
    check runs before the skip branch — `.rea/HALT` cannot be
    bypassed.
  - **BUG-010 `.gitignore` scaffolding** (`src/cli/install/gitignore.ts`,
    wired into `rea init` and `rea upgrade`). 0.3.x/0.4.0 `rea init`
    never added `.gitignore` entries for runtime artifacts (`rea serve`
    writes `.rea/fingerprints.json`, G1 rotates `audit-*.jsonl`, the
    new BUG-009 cache writes `review-cache.jsonl`). Every consumer
    saw these show up as untracked files. The scaffolder:
    - Writes a `# === rea managed ===`-bracketed block with every
      runtime artifact path in stable canonical order.
    - On existing `.gitignore`: appends the block after a blank-line
      separator (preserves all operator content).
    - On existing block: backfills missing entries in place
      (preserves operator additions inside the block).
    - `rea upgrade` runs the same scaffold, closing the gap for
      every consumer who installed before 0.5.0.
    - Refuses to write through a `.gitignore` symlink
      (supply-chain guard); warns and no-ops instead.
    - Match on block markers is anchored (full-line) — a substring
      match in a comment will not be reclassified as rea-managed.
  - **Codex F2 hardening** (0.5.0 PR1 adversarial review):
    - `review.allow_skip_in_ci` policy knob. `REA_SKIP_PUSH_REVIEW`
      refuses with exit 2 when `CI` is set unless the policy
      explicitly opts in. Closes the ambient-env-var bypass surface
      on shared build agents.
    - Skip audit records now carry an `os_identity` sub-object
      (uid, whoami, hostname, pid, ppid, ppid_cmd, tty, ci) so
      auditors can distinguish a real operator from a forged
      git-config actor.
  - **Codex F3 skew guard** (`src/cache/review-cache.ts`). A
    `recorded_at` more than 60s in the future of `nowMs` is treated
    as an expired miss. Prevents a tampered or severely-skewed clock
    from extending an approval indefinitely.
  - **Codex F4 atomic `clear`** (`src/cache/review-cache.ts`).
    Rewrites via temp-file + `fs.rename` (POSIX atomic within the
    directory) so unlocked readers (`lookup`, `list`) never observe a
    torn intermediate state during concurrent clears.

  Test coverage:
  - `src/cache/review-cache.test.ts` — 23 tests (round-trip, TTL,
    last-write-wins, clear, list, 20 concurrent writes, malformed
    lines, F3 future-skew guard, F4 atomic-clear concurrency)
  - `src/cli/cache.test.ts` — 11 tests (stdout contract, policy TTL,
    round-trip)
  - `__tests__/hooks/push-review-gate-prepush-stdin.test.ts` — 5 tests
    (BUG-008 self-detect, regression guards, `push_review: false` honor)
  - `__tests__/hooks/push-review-gate-skip-push-review.test.ts` — 12
    tests (fail-closed, audit record shape, skip != codex-review,
    pre-push stdin path, F1 HALT-first regression, F2 CI-refusal +
    CI-allowed + OS-identity capture)
  - `src/cli/install/gitignore.test.ts` — 13 tests (fresh-repo creation,
    append to existing, no-op on full block, backfill in-place,
    substring-spoof rejection, symlink refusal, no-trailing-newline
    input, shuffled entries, canonical list invariants)
  - `src/cli/init.test.ts` — 3 new BUG-010 regression tests (scaffold
    every artifact, idempotent re-init, preserves operator content)
  - `src/cli/upgrade.gitignore.test.ts` — 3 tests (backfill on older
    install, no-op when complete, dry-run does not touch)

## 0.4.0

### Minor Changes

- a27fc06: Registry `env:` values now support `${VAR}` interpolation.

  Registry entries can now reference process env vars via `${VAR}` syntax in the explicit `env:` map. Enables token-bearing MCPs (discord-ops, github, etc.) to route through rea-gateway without committing literal tokens to `registry.yaml` and without widening the restrictive `env_passthrough` allowlist. Missing vars fail the affected server at startup (fail-closed); the rest of the gateway still comes up. `env_passthrough` behavior is unchanged.

  ### Grammar (deliberately minimal)
  - Only `${VAR}` — curly-brace form in env **values**. Keys are never interpolated.
  - No bare `$VAR` (ambiguous with shell semantics).
  - No default syntax (`${VAR:-fallback}`) — kept out of the 0.3.0 surface.
  - No command substitution (`$(cmd)`) — never.
  - No recursive expansion. If `${FOO}` resolves to a string that itself contains `${BAR}`, the inner text is treated as a literal. This is intentional: a hostile env var's _contents_ cannot trigger further lookups.
  - Var names follow POSIX identifier rules: `^[A-Za-z_][A-Za-z0-9_]*$`. Empty `${}` or illegal identifier chars are rejected at load time with a clear error.

  ### Fail-closed on missing vars

  If any `${VAR}` referenced by an enabled server is unset at spawn time:
  - The affected server is marked unhealthy and skipped by the pool's tool list.
  - One stderr line per missing var is emitted with server + var context.
  - Every other server with resolved env still starts normally.
  - The gateway as a whole does not crash.

  ### Example

  ```yaml
  # .rea/registry.yaml
  version: '1'
  servers:
    - name: discord-ops
      command: npx
      args: ['-y', 'discord-ops@latest']
      env:
        BOOKED_DISCORD_BOT_TOKEN: '${BOOKED_DISCORD_BOT_TOKEN}'
        CLARITY_DISCORD_BOT_TOKEN: '${CLARITY_DISCORD_BOT_TOKEN}'
      enabled: true
  ```

  Export the tokens in the same shell that runs `rea serve`:

  ```bash
  export BOOKED_DISCORD_BOT_TOKEN="…"
  export CLARITY_DISCORD_BOT_TOKEN="…"
  rea serve
  ```

  ### Redact-by-default contract

  The template in `registry.yaml` is auditable (it commits); the runtime value is not. Env values resolve only inside `buildChildEnv` and pass straight to the child transport — they never flow into `ctx.metadata` or audit records. A new `secretKeys` signal identifies env entries that are secret-bearing (either because the key name matches `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` or because a `${VAR}` reference in the value does), so any future telemetry path can make the right call without re-deriving the heuristic.

  ### Compatibility
  - `env_passthrough` semantics unchanged — still refuses secret-looking names at load time. The sanctioned path for secrets is now `env: { NAME: '${ENV_VAR}' }`.
  - Existing registries without interpolation continue to work unchanged.
  - No new dependencies.

- 6e84930: feat(gateway): G5 — gateway observability. Adds three user-visible surfaces:
  - `rea status` — new CLI command that reports live-process state for a
    running `rea serve` (pid, session id, metrics endpoint URL), the policy
    summary (profile, autonomy, blocked-paths count, codex_required, HALT), and
    audit log stats (lines, last timestamp, tail-hash smoke). Supports `--json`
    for composing with `jq` and future tooling. `rea check` remains the
    authoritative on-disk snapshot — `rea status` is the running-process view.
  - Structured JSON-lines gateway logger at `src/gateway/log.ts`. Honors
    `REA_LOG_LEVEL` (info default; debug/warn/error supported). Pretty-prints
    when stderr is a TTY, emits JSON lines on non-TTY sinks. No new deps —
    ~200-line no-dep implementation. `rea serve` wires the logger into
    connection open/close/reconnect events and circuit-breaker state transitions.
    `[rea-serve]` prefix preserved in pretty mode so existing grep-based smoke
    tests (helix) continue to match.
  - Optional loopback `/metrics` HTTP endpoint. Opt-in via `REA_METRICS_PORT`
    — no silent listeners. Binds `127.0.0.1` only, serves Prometheus text
    exposition, exposes per-downstream call/error/in-flight counters, audit
    lines appended, circuit-breaker state gauge, and a seconds-since-last-HALT
    gauge. Rejects non-GET methods with 405 and non-`/metrics` paths with 404
    (no request-path reflection in response bodies). `node:http` only — no
    express/fastify.

  `rea serve` now writes a short-lived breadcrumb pidfile at `.rea/serve.pid`
  and session state at `.rea/serve.state.json` for `rea status` introspection.
  Both files are removed on graceful shutdown (SIGTERM/SIGINT). The README
  non-goal "no pid file" is narrowed to clarify that this is a read-only
  breadcrumb, not a supervisor lock — there is still no `rea start`/`rea stop`.

- 862440d: G6 — Codex install assist at init time, and pre-push hook fallback installer.

  `rea init` now probes for the Codex CLI when the chosen policy sets
  `review.codex_required: true`. If Codex is not responsive, init prints a
  clear guidance block pointing at the Claude Code `/codex:setup` helper
  instead of silently succeeding; `/codex-review` would otherwise fail later.
  In no-Codex mode the probe is skipped entirely (no wasted 2s, no confusing
  output).

  `rea init` also installs a fallback `pre-push` hook in the active git
  hooks directory when Husky is not the consumer's primary hook path. The
  fallback is a thin `exec` into `.claude/hooks/push-review-gate.sh` so
  there is still exactly one implementation of the push-review logic. The
  installer detects `core.hooksPath` correctly, refuses to stomp foreign
  hooks (no marker → leave alone), and is idempotent across re-runs.

  `rea doctor` gains a "pre-push hook installed" check that requires an
  executable pre-push at whichever path git is actually configured to fire
  (`.git/hooks/pre-push` by default, or the configured `core.hooksPath`).
  A `.husky/pre-push` alone — without `core.hooksPath=.husky` — no longer
  satisfies the check, closing the 0.2.x dogfooding gap where protected-
  path Codex audit enforcement could be silently bypassed.

  Non-goals (explicitly out of scope for G6): the `push-review-gate.sh`
  logic itself is unchanged, the protected-path regex is unchanged, and no
  middleware was moved.

- 795a8bc: G7 — Proxy-poisoning defense via TOFU fingerprints.

  The gateway now fingerprints every downstream server declared in
  `.rea/registry.yaml` on first startup and persists the result to
  `.rea/fingerprints.json` (versioned JSON, schema-validated). On every
  subsequent `rea serve`, each server is reclassified as `unchanged`,
  `first-seen`, or `drifted`:
  - **Unchanged** — proceed silently.
  - **First-seen** — LOUD stderr block announcing the new fingerprint,
    structured `tofu.first_seen` audit record, allow the connection. This
    is deliberately noisy so a poisoned registry at first install is
    visible in stderr, logs, and audit trail at the same time.
  - **Drifted** — stderr block, `tofu.drift_blocked` audit record (status
    `denied`), and the server is DROPPED from the downstream pool. Other
    servers stay up; the gateway does not fail-close on drift of a single
    server. To accept a legitimate rotation for one boot, set
    `REA_ACCEPT_DRIFT=<name>` (comma-separated for multiple).

  The fingerprint is **path-only**: `name`, `command`, `args`, sorted
  `env` KEY SET, sorted `env_passthrough`, and `tier_overrides`. Env
  VALUES are intentionally excluded so rotating a token (`GITHUB_TOKEN`
  etc.) does not trip drift. We do NOT hash the binary at `config.command`
  — that would be a slow-boot tax on every restart, legitimate MCP
  upgrades would trip false-positive drift, and host-binary compromise is
  a separate G-number, not G7. The G7 threat is YAML tampering, which the
  canonicalized config hash covers.

  A corrupt or schema-invalid `fingerprints.json` fails the gateway
  closed: we never silently reset TOFU state, because that would downgrade
  drift detection to first-seen acceptance. The operator can delete the
  file deliberately to re-bootstrap. `rea doctor` grows a `fingerprint
store` row that surfaces first-seen / drifted counts without waiting for
  `rea serve`.

- fa66785: G9 — Injection tier escalation: clean / suspicious / likely_injection.

  **Behavior change on upgrade for external profiles — read this before upgrading if you depend on the 0.2.x deny-on-any-match behavior.**

  The injection middleware (`src/gateway/middleware/injection.ts`) was a single-threshold binary: any known phrase match in a tool result denied the call. That was too blunt — a single literal match at write tier is noise-prone, while multi-literal + base64-decoded matches at any tier are near-certain attacks that should deny regardless of context. G9 introduces a three-level classifier and a policy knob governing the middle bucket.

  ### Classification rules

  Every PostToolUse scan now returns one of three verdicts (recorded in `ctx.metadata.injection` and exported to the audit log):
  - `clean` — no match → allow, no log.
  - `suspicious` — exactly ONE distinct literal pattern at write/destructive tier, with no base64-decoded match → warn (stderr + audit metadata). Whether this denies is governed by the new `policy.injection.suspicious_blocks_writes` flag.
  - `likely_injection` — any of: ≥2 distinct literal patterns, any base64-decoded match, any match at read tier, or an unknown tier (fail-closed) → **always deny, regardless of the flag**.

  ### The narrow relaxation (the reason for the loud callout)

  **In 0.2.x, a single literal match at any tier denied.** In 0.3.0, for profiles that do NOT pin the new flag (`open-source`, `client-engagement`, `minimal`, `lit-wc`, and any hand-authored policy that omits the `injection:` block), a single literal match at write/destructive tier is classified `suspicious` → warn-only by default. This means the call is ALLOWED through. The warning is written to stderr and the audit record still captures `verdict: suspicious` with the matched phrase, but the tool result is NOT blocked.

  The `bst-internal` and `bst-internal-no-codex` profiles pin `suspicious_blocks_writes: true`, preserving the 0.2.x strict-deny posture. This repo's own `.rea/policy.yaml` continues to inherit that strict posture by profile.

  **Why ship narrower:** silent tightening on upgrade is a worse footgun than the narrower default. External consumers who want the strict 0.2.x behavior can opt in explicitly:

  ```yaml
  injection:
    suspicious_blocks_writes: true
  ```

  `likely_injection` remains an unconditional deny. The attacker cases that matter most (multi-pattern coordinated injection, base64-obfuscated payloads) still deny in every profile.

  ### Policy flag

  New optional top-level policy block:

  ```yaml
  injection:
    suspicious_blocks_writes: true # default: false
  ```

  - `false` (schema default): `suspicious` → warn-only, tool result allowed through. Audit record carries `verdict: suspicious`.
  - `true`: `suspicious` → deny at write/destructive tier (matches 0.2.x deny-on-literal semantics for writes). Audit record carries `verdict: suspicious` plus `status: denied`.
  - `likely_injection` denies in either case.

  The loader defaults are `false`; the `bst-internal*` profiles pin `true`.

  ### Audit metadata

  On any non-clean verdict the middleware writes `ctx.metadata.injection`, which the audit middleware exports verbatim into the per-call record:

  ```json
  {
    "verdict": "likely_injection",
    "matched_patterns": ["disregard your", "ignore previous instructions"],
    "base64_decoded": false
  }
  ```

  `matched_patterns` is a sorted list of distinct phrase strings from the built-in phrase list. NO input payload text is ever written to metadata (guard against leaking the attack content through audit trail redaction bypass).

  ### Legacy `injection_detection: warn` interaction

  Operators who pinned 0.2.x `injection_detection: warn` continue to get warn-only for `suspicious`. However, under G9, `likely_injection` (multi-literal or base64-decoded) will now DENY even when `injection_detection: warn` is set. This is a narrow tightening for operators who explicitly pinned warn mode — the classifier's whole value is distinguishing high-confidence attacks from ambiguous single-hits, and high-confidence attacks deserve a deny. If you need the full-allow-through behavior for all matches (not recommended), disable the middleware by removing it from your gateway configuration.

  ### Stderr format change

  The warning line format changed from `[rea] INJECTION-GUARD: ...` to `[rea] INJECTION-GUARD (<verdict>): ...`. Log consumers grepping for the old exact prefix should update their filters.

  ### Pattern list unchanged

  This PR does NOT modify the built-in `INJECTION_PHRASES` list. Extending or reshaping the pattern set is explicit future work (a per-pattern "deny-tag" extension point is stubbed with a TODO in `classifyInjection`).

  ### New public exports

  From `src/gateway/middleware/injection.ts`:
  - `classifyInjection(scan, tier) → InjectionClassification` — pure classifier
  - `scanStringForInjection(s, result, safe)` / `scanValueForInjection(v, result, safe)` — structured scanners
  - `decodeBase64Strings(input: unknown) → string[]` — pure base64 probe
  - `INJECTION_METADATA_KEY` — `'injection'`, the ctx.metadata key for the verdict record
  - `InjectionClassifierMetadata`, `InjectionScanResult`, `InjectionClassification` — types

  Back-compat: `scanForInjection(string, safe) → string[]` is retained as a wrapper so `scripts/lint-safe-regex.mjs` and any external consumer that imported it continue to work.

### Patch Changes

- 6a2f00c: ci: tarball smoke workflow (packaging regression gate)

  Adds `scripts/tarball-smoke.sh`, invoked on every PR and every push to `main` via a new `Tarball smoke` CI job, and re-invoked in the release workflow immediately before `changeset:publish`. The script packs the repo with `pnpm pack`, installs the resulting tarball in an isolated tempdir, and asserts:
  - `rea --version` matches `package.json` version
  - `rea --help` prints the full command tree
  - `rea init --yes --profile open-source` creates the expected layout
  - `rea doctor` returns OK on the freshly installed artifacts
  - At least 10 agents and 13 hooks shipped in the tarball
  - Every public ESM export (`.`, `./policy`, `./middleware`, `./audit`) resolves

  This catches packaging regressions — missing files from the `files:` allow-list, broken `exports` map, shebang / chmod issues on `bin/rea`, postinstall failures, dependency-resolution drift — before the tarball reaches npm. No runtime behavior change.

  Branch protection on `main` should be updated to include `Tarball smoke` as a required check alongside the existing seven.

- 52e655d: fix(gateway/blocked-paths): restore absolute-path matching and close content-key + URL-escape bypasses

  Address three post-merge Codex findings on BUG-001:
  - **[critical]** Absolute `blocked_paths` entries (e.g. `/etc/passwd`) no longer matched after the content-substring narrowing — restored.
  - **[high]** `CONTENT_KEYS` blanket skip on `name/value/label/tag/tags/title` let `{name: ".env"}` bypass — now only skipped when value is not path-shaped.
  - **[high]** Malformed `%XX` URL-escape silently disabled decode, enabling `.rea/` trust-root bypass via `%2Erea%2F` — now fails closed on malformed escapes.

- 1e1f247: fix(gateway): G5 observability — post-merge Codex blocker sweep. Eight
  BLOCKING findings from adversarial review of the G5 feature (merged as
  PR #22) are resolved ahead of 0.4.0:
  - **metrics bind allowlist (security).** `startMetricsServer` now validates
    the `host` option against a strict loopback allowlist (`127.0.0.1`,
    `::1`). Anything else — `localhost`, `0.0.0.0`, `::`, any LAN IP — throws
    a `TypeError` BEFORE a socket is opened. Closes the path where a caller
    could accidentally expose the unauthenticated `/metrics` endpoint to
    the network. A test-only `__TEST_HOST_OVERRIDE` symbol preserves the
    hostname-resolution test path; the symbol is unreachable from YAML,
    JSON, or CLI deserialization.
  - **pid/state breadcrumb race.** `rea serve` now writes `.rea/serve.pid`
    and `.rea/serve.state.json` atomically (stage-to-temp + `rename(2)`)
    and cleans them up only when the file still carries this process's pid
    (pidfile) or session id (state). Two overlapping `rea serve`
    invocations in the same `baseDir` no longer clobber each other's
    breadcrumbs on the first instance's shutdown.
  - **ANSI/OSC escape injection in `rea status` pretty mode.** Every
    disk-sourced string field (`profile`, `autonomy_level`, `halt_reason`,
    `session_id`, `started_at`, `last_timestamp`) is scrubbed through a
    new `sanitizeForTerminal` helper before reaching the operator's
    terminal. C0 control bytes (0x00-0x1F) and DEL (0x7F) are replaced
    with `?` — the ESC byte that initiates CSI/OSC sequences and the BEL
    byte that terminates OSC 8 hyperlinks are both scrubbed. JSON mode
    output is untouched (JSON.stringify already escapes safely).
  - **observability counter wiring.** `createAuditMiddleware` and
    `createKillSwitchMiddleware` now accept an optional `MetricsRegistry`.
    The audit middleware increments `rea_audit_lines_appended_total` on
    every successful fsynced append; the kill-switch middleware refreshes
    `rea_seconds_since_last_halt_check` on every invocation (previously
    the gauge only reflected the startup-time mark). `rea serve` wires
    the same registry into both. Counter failures never crash the chain.
  - **log-field redaction.** The gateway logger now accepts an optional
    `redactField` hook applied to every string-valued field before
    serialization. `rea serve` installs a redactor compiled from the
    same `SECRET_PATTERNS` the redact middleware uses, so downstream
    error messages that carry env var names, argv fragments, or file
    paths with credential material reach stderr already scrubbed. A
    redactor that throws falls back to `[redactor-error]` per field —
    the record itself is never dropped.
  - **bounded-memory audit tail.** `rea status` no longer reads the
    whole `audit.jsonl` into a buffer to count lines or find the last
    record. Line count uses a streaming 64-KiB-chunk scan; the last
    record is sourced from a positioned 64-KiB tail-window read. On
    multi-hundred-MB chains the memory footprint is bounded to the
    window size plus the scan buffer.
  - **bounded metrics `close()`.** `startMetricsServer` tracks every
    live socket and guarantees `close()` resolves within 2 s even when
    a Prometheus scraper is holding a keep-alive connection open. On
    deadline the server calls `closeIdleConnections()` (Node 18.2+)
    and destroys any surviving tracked sockets. The timer is `unref`'d
    so it never holds the process open.
  - **pretty-mode cyclic-safe serialization.** Pretty-mode logger extras
    that contain a cyclic reference no longer drop the entire record.
    A safe-stringify wrapper substitutes a stable `[unserializable]`
    placeholder so the operator still sees the event, level, and
    message.

- b6a69ff: fix(cli): harden pre-push fallback installer (G6 post-merge hardening)

  Close four classification/write-path issues in the G6 pre-push fallback installer: existence-only skip bypass (doctor pass on foreign hooks), classify/write TOCTOU, substring `FALLBACK_MARKER` collision, and deterministic tmp-filename collisions.

- 795a8bc: docs(registry/tofu): tighten rename-bypass defense scope

  Clarify in `classifyServers` that the set-difference heuristic catches **rename-with-removal** (attacker removes old trusted entry at the same moment the tampered new entry appears), not rename-with-placeholder (attacker leaves old entry in place as a decoy, adds tampered new entry under a new name).

  Rename-with-placeholder lands as `first-seen` with a LOUD stderr banner — the documented, intentional TOFU contract for new entries. No code change; the docstring previously oversold the defense's scope.

- a5cca2a: fix(injection): guard base64 probe on timeout + correct changeset default-behavior doc

  Address four post-merge Codex findings on the G9 three-tier injection classifier (PR #25):
  - **[high]** `denyOnSuspicious` flag behavior clarified: the `suspicious_blocks_writes` flag defaults to `false` when omitted (preserving the 0.3.x warn-only default for unset installs). Consumers who want the tighter block posture must opt in explicitly with `injection.suspicious_blocks_writes: true`. The `bst-internal*` profiles pin `true`. This was the correct approach: silently switching to block behavior on upgrade would be a breaking change for 0.3.x consumers.
  - **[high]** The 7-phrase ASCII pattern library was trivially bypassed by Unicode whitespace (NBSP, en-space, em-space, ideographic space, etc.), zero-width joiners, and fullwidth compatibility characters. Inputs are now NFKC-normalized, zero-width-stripped, Unicode-whitespace-collapsed, and lowercased before literal matching. The phrase library was also modestly expanded with two conservative persona-swap vectors (`pretend you are`, `roleplay as`). Broader candidates like `act as a` / `act as an` were considered but dropped: at read tier a single literal match escalates to `likely_injection`, which would falsely deny benign prose such as "this proxy can act as a bridge." Pattern-set extensibility via policy is filed as G9.1 follow-up.
  - **[medium]** `decodeBase64Strings` was exported and tested but never wired into the middleware execution path — 28 lines of dead code advertised as a second-opinion base64 probe. It is now called from the middleware after the primary scan; any phrase detected in a decoded whole-string payload is merged into `base64DecodedMatches`, triggering classification rule #2 (`likely_injection`). The call is guarded behind `!scanTimedOut` so a timeout-induced incomplete scan cannot force unbounded CPU/memory in the base64 probe path; a `MAX_BASE64_PROBE_LENGTH` cap (16 KiB) is also applied per-string inside `decodeBase64Strings`.
  - **[low]** On worker-bounded regex timeout, the audit record carried timing metadata under `injection.regex_timeout` but no `verdict` field under `injection`. A new `verdict: 'error'` value is emitted when a timeout produces no actionable signal, giving downstream audit consumers a stable record shape. A new `InjectionMetadataSchema` zod schema is exported from the injection middleware module for internal test coverage; promoting it to a public package entrypoint is tracked as G9.2 follow-up (the module is not reachable via the current `exports` map, so do not rely on it from outside this repo yet).

  `likely_injection` continues to deny unconditionally in all configurations.

- 4f4d19d: ci: close tarball-smoke coverage gaps (post-merge)

  Address four post-merge Codex findings on the tarball-smoke gate:
  - **[high]** Gate counted `.claude/agents/` + `.claude/hooks/` only — now tree-equality asserts against `.claude/commands/`, recursive `hooks/**` (walks `hooks/_lib/`), and the shipped `.husky/{commit-msg,pre-push}` so a tarball missing those surfaces fails loud with a unified-diff delta. `.git/hooks/{commit-msg,pre-push}` are also asserted as the real enforcement surface on a fresh consumer.
  - **[medium]** Fresh-consumer `npm init -y` temp files were not actually cleaned before `git init` — comment now matches behavior (`rm -f package.json package-lock.json`).
  - **[low]** Version probe interpolated repo path into a JS string literal — now passes the path via argv so repo-roots with apostrophes, backslashes, or `${...}`-style expansions do not break the require() call.
  - **[low]** Cleanup trap bound to `EXIT` only — now catches `HUP`/`INT`/`TERM` so Ctrl-C during a local run does not leave `/tmp/rea-smoke-*` tempdirs behind.

- c0b8a2b: fix(gateway/blocked-paths): eliminate content-substring false positives (BUG-001)

  The blocked-paths middleware previously substring-matched policy patterns against every string value in the argument tree, including free-form `content` and `body` fields. A secondary fallback stripped the leading `.` from patterns like `.env`, which caused the naked substring `env` to match inside any string containing "environment" — breaking legitimate note creation on Helix (`obsidian__create-note` with 14 KB of prose that mentioned GitHub Environments and `.env` files in passing).

  The matcher is now key-aware and path-segment aware:
  - Arguments with a known path-like leaf key (`path`, `file_path`, `filename`, `folder`, `dir`, `src`, `dst`, `target`, …) are always scanned.
  - Arguments with a content-like leaf key (`content`, `body`, `text`, `message`, `description`, `summary`, `title`, `query`, `prompt`, `comment`, …) are never scanned, regardless of how the value looks.
  - Arguments with any other key are scanned only when the value looks like a filesystem path (contains a separator, starts with `~`, is a dotfile, or matches a Windows drive prefix).
  - Pattern matching is strictly path-segment aware; `*` and `?` are single-segment globs (they do not cross `/`), and all other regex metacharacters in a pattern are escaped. Trailing `/` on a pattern means "this directory and everything under it".
  - `.rea/` is still unconditionally enforced regardless of policy.

  The policy file format is unchanged. Existing installs that list both `.env` and `.env.*` in `blocked_paths` continue to block every `.env` variant. If a policy previously relied on accidental substring matching (e.g., listing only `.env` and expecting `.env.local` to be blocked), add `.env.*` explicitly — this is how the `bst-internal` profile already works.

- c4c4cc8: fix(cli): correct `rea serve` help description — the serve command is no longer a stub. Also refresh `.rea/install-manifest.json` to reflect the post-G10/G1 content hashes for `.claude/hooks/push-review-gate.sh` and `.husky/pre-push`.

## 0.3.0

### Minor Changes

- 6c1b53c: G1 — Audit durability + rotation.

  Every append to `.rea/audit.jsonl` now takes a `proper-lockfile` lock on `.rea/`
  before the read-last-record → compute-hash → append → fsync sequence. The lock
  covers both write paths: the gateway audit middleware and the public
  `@bookedsolid/rea/audit` helper. Stale locks are reclaimed after 10s
  (`proper-lockfile` default), and lock-acquisition failure in the gateway path
  falls back to the pre-0.3.0 behavior (stderr warn, tool call proceeds) — an
  audit outage must not take down the gateway.

  Size- and age-based rotation lands behind a new optional policy block:

  ```yaml
  audit:
    rotation:
      max_bytes: 52428800 # 50 MiB (default when the block is present)
      max_age_days: 30 # default when the block is present
  ```

  Back-compat is preserved: if an install has no `audit.rotation` block, rotation
  is a no-op and behavior is identical to 0.2.x. Defaults only apply once the
  operator has opted in by declaring the block.

  Rotation renames the current file to `audit-YYYYMMDD-HHMMSS.jsonl` and seeds
  the fresh `audit.jsonl` with a single rotation marker record
  (`tool_name: "audit.rotation"`) whose `prev_hash` is the SHA-256 of the last
  record in the rotated file. This marker is the chain bridge — an operator
  verifying the chain with `rea audit verify --since <rotated>` walks rotated
  → marker → current without a break.

  Two new CLI subcommands:
  - `rea audit rotate` — force-rotate now. Empty files are a deliberate no-op.
  - `rea audit verify [--since <rotated-file>]` — re-hash the chain; exits 0 on
    clean, 1 naming the first tampered record. `--since` walks forward through
    all rotated predecessors in timestamp order.

  Partial-write recovery: a crash that leaves a trailing line without a newline
  is detected on the next read (`readLastRecord`), the partial tail is
  truncated, and appends resume cleanly.

  Tests (31 new, 278 total):
  - Tamper detection — flip a byte in a rotated file, verify exits 1 and
    stderr names the offending record index.
  - Crash recovery — partial-line tail is truncated; next append chains on
    the recovered head.
  - Cross-process concurrency — two Node processes appending 50 records each
    produce a linear 100-record chain with no duplicate `prev_hash` values.
  - Rotation boundary — size trigger rotates with operator-supplied
    `max_bytes: 1024`; fresh file starts with a rotation marker whose
    `prev_hash` equals the rotated file's tail hash.
  - Empty-rotation — `rea audit rotate` on an empty/missing audit log is a
    no-op (no rotated file created).
  - Happy-path verify — 20 clean appends → `rea audit verify` exits 0.
  - Schema — `audit.rotation.{max_bytes, max_age_days}` round-trips; unknown
    fields are rejected under strict mode; non-positive thresholds rejected.

  Dependencies: `proper-lockfile@^4.1.2` added to `dependencies` (NOT
  devDependencies — this is a runtime import). `@types/proper-lockfile@^4.1.4`
  added to `devDependencies`.

### Patch Changes

- f6193c5: Refresh `THREAT_MODEL.md` to 0.2.x.

  Reflects the 0.2.0 MVP that shipped: gateway middleware chain, G3 ReDoS
  worker-thread timeout, G4 HALT single-syscall atomicity, G11.1–G11.5
  Codex resilience (escape hatch, pluggable reviewer, availability probe,
  first-class no-Codex mode, reviewer telemetry), and G12 install manifest
  - upgrade command + drift detection. Adds three new attack-surface
    sections — §5.11 downstream subprocess environment inheritance,
    §5.12 regex denial-of-service, §5.13 installer path trust — and updates
    the residual-risk table with 0.3.0 tracking pointers.

  Doc-only; no runtime change.

## 0.2.1

### Patch Changes

- 6f38d99: Move `safe-regex` from devDependencies to dependencies.

  `src/policy/loader.ts` imports `safe-regex` at runtime (the G3 ReDoS
  load-time validation on user-supplied redact patterns), but the dep was
  declared devOnly in 0.2.0. The published 0.2.0 tarball is unusable in
  consumer projects — `node dist/cli/index.js` fails with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'safe-regex'`. This patch
  restores a working install.

## 0.2.0

### Minor Changes

- 320c090: 0.2.0 MVP — gateway end-to-end, install completeness, Codex governance.

  ## Track 1 — Gateway MVP (`rea serve`)

  `rea serve` is now a real MCP gateway. It loads `.rea/policy.yaml` and
  `.rea/registry.yaml`, spawns downstream MCP servers over stdio, and proxies
  every tool call through the full 10-layer middleware chain (audit,
  kill-switch, tier, policy, blocked-paths, rate-limit, circuit-breaker,
  injection, redact, result-size-cap). A gateway with zero downstream servers
  boots cleanly and advertises an empty catalog — first-run does not crash.

  New modules:
  - `src/registry/{types,loader}.ts` — zod-validated registry with TTL + mtime cache
  - `src/gateway/{downstream,downstream-pool,server,session}.ts` — upstream Server, per-server Client connections, `<serverName>__<toolName>` prefix routing, one-shot reconnect semantics
  - `src/cli/serve.ts` — rewritten from stub; SIGTERM / SIGINT graceful drain
  - Smoke tests via `InMemoryTransport` covering zero-server mode, HALT denial, and tier classification

  ## Track 2 — `rea init` completeness

  `rea init` now actually installs rea into a consumer project:
  - `src/cli/install/copy.ts` — copies `hooks/**`, `commands/**`, `agents/**` into `.claude/`, chmods hooks `0o755`, conflict policy (`--force` overwrites, `--yes` skips existing, interactive prompt otherwise)
  - `src/cli/install/settings-merge.ts` — atomic merge into `.claude/settings.json`; never silently overwrites consumer hooks; warns only when chaining onto pre-existing matchers
  - `src/cli/install/commit-msg.ts` — belt-and-suspenders install of `.git/hooks/commit-msg` (and `.husky/commit-msg` when husky is present); respects `core.hooksPath`
  - `src/cli/install/claude-md.ts` — managed fragment inside `CLAUDE.md` delimited by `<!-- rea:managed:start v=1 -->` / `<!-- rea:managed:end -->`; content outside the markers is never touched
  - `src/cli/install/reagent.ts` — field-for-field translator with copy / drop / ignore lists; drop-list fields refuse translation without `--accept-dropped-fields` to prevent silent security downgrades; autonomy clamped to profile ceiling
  - `src/policy/profiles.ts` + `profiles/*.yaml` — layered merge `hardDefaults ← profile ← reagentTranslation ← wizardAnswers`; ships seven profiles (`minimal`, `bst-internal`, `bst-internal-no-codex`, `open-source`, `open-source-no-codex`, `client-engagement`, `lit-wc`)
  - New flags on `rea init`: `--force`, `--accept-dropped-fields`, `--codex`, `--no-codex`
  - `rea doctor` expanded to 9 checks (agents count, hook executability, settings matchers, commit-msg hook, codex agent + command, registry parse); when `review.codex_required: false`, the Codex-specific checks collapse to a single informational line

  ## Track 3 — Codex governance
  - `src/gateway/middleware/audit-types.ts` + `audit.ts` — optional `metadata` field on audit records, emitted when `ctx.metadata` carries caller-supplied keys (the internal `autonomy_level` key is kept private to the audit bookkeeping)
  - `src/audit/append.ts` — public helper exported as `@bookedsolid/rea/audit`; reads tail for `prev_hash`, computes SHA-256, appends atomically with fsync; usable by the `codex-adversarial` agent and by consumers emitting their own events (`helix.plan`, `helix.apply`)
  - `src/audit/codex-event.ts` — single source of truth for the `codex.review` event shape shared between the TS helper and `hooks/push-review-gate.sh`
  - `hooks/push-review-gate.sh` — on diffs that touch `src/gateway/middleware/`, `hooks/`, `src/policy/`, or `.github/workflows/`, the push is blocked unless `.rea/audit.jsonl` contains a `codex.review` entry for the current HEAD
  - `agents/codex-adversarial.md` — documents the structured audit-append step

  ## Codex dependency resilience (G11.1 pulled from 0.3.0)
  - `hooks/push-review-gate.sh` gained an audited escape hatch: setting
    `REA_SKIP_CODEX_REVIEW` to a non-empty reason bypasses the Codex
    audit-record requirement and writes a `codex.review.skipped` entry to
    `.rea/audit.jsonl` (head_sha, reason verbatim, actor from `git config`,
    verdict, files_changed). Event name is deliberately distinct from
    `codex.review` so future pushes on the same HEAD cannot consume a skip
    record to satisfy the Codex-review requirement.
  - Fail-closed on missing `dist/audit/append.js`, missing git identity, and
    any audit-append error. Never-silent: a banner prints to stderr on every
    use. 8 behavioral tests cover the contract.

  ## Pluggable reviewer (G11.2)
  - `src/gateway/reviewers/{types,codex,claude-self,select}.ts` — single
    `AdversarialReviewer` interface with two concrete implementations and a
    selector that reads both `REA_REVIEWER` and `.rea/registry.yaml`
    reviewer pin. `ClaudeSelfReviewer` is the fallback when Codex is
    unreachable.
  - `src/policy/types.ts` + `loader.ts` — adds `review.codex_required?`
    with strict-mode validation, so a typo fails loudly at load time
    instead of silently defaulting.

  ## Codex availability probe (G11.3)
  - `src/gateway/observability/codex-probe.ts` — `CodexProbe` class that
    polls `codex --version` (2s timeout) and a best-effort catalog
    subcommand (5s timeout) and exposes a typed `CodexProbeState`. The
    probe is decoupled from reviewer selection — it reports state only,
    it never gates a review. Polling runs on a `setInterval` that is
    `.unref()`'d so the probe never keeps the event loop alive.
  - `getState()` never throws; `probe()` is safe to call concurrently
    (overlapping callers share a single in-flight exec); `onStateChange`
    fires only on real transitions.
  - The probe treats an unrecognized `catalog --json` subcommand as a
    degraded-skip, not as a hard failure. Documented assumption: we are
    blocking on whether the CLI responds at all, not on whether OpenAI
    ships that exact subcommand.
  - `src/cli/serve.ts` runs an initial probe on startup when
    `policy.review.codex_required` is not explicitly `false`. A failed
    probe emits a single stderr warn — startup NEVER fail-closes on a
    Codex miss — and then the periodic poll takes over. `stop()` runs on
    SIGTERM / SIGINT alongside the gateway drain.
  - `src/cli/doctor.ts` runs a one-shot probe (when Codex is required)
    and adds `codex.cli_responsive` (pass/warn) and `codex.last_probe_at`
    (info) rows to the doctor output. Probe failure surfaces as a warn,
    never a hard fail — consistent with the existing Codex-optional
    checks.

  ## Reviewer telemetry (G11.5)
  - `src/gateway/observability/codex-telemetry.ts` — append-only
    observational metrics at `<baseDir>/.rea/metrics.jsonl`. Each row
    captures `invocation_type`, estimated input/output tokens
    (chars / 4), `duration_ms`, `exit_code`, and `rate_limited` (detected
    from stderr via a case-insensitive regex covering 429, "rate limit",
    "usage limit", "exceeded quota").
  - **Never stores payloads.** The `input_text` and `output_text` fields
    on the call-site input are consumed once for token estimation and
    discarded. A unit test asserts marker strings never appear in the
    file. This is non-negotiable per the brief — telemetry is numbers,
    not content.
  - Fail-soft writes: any I/O error surfaces as a single stderr warning
    and resolves without throwing. Telemetry must never interfere with
    the reviewed operation.
  - `summarizeTelemetry(baseDir, windowDays = 7)` buckets records by
    local-tz day, most-recent first, and returns a fixed shape
    (`invocations_per_day`, `total_estimated_tokens`,
    `rate_limited_count`, `avg_latency_ms`). Missing file → all-zero
    summary with no throw.
  - `ClaudeSelfReviewer.review()` is now instrumented via an internal
    `emitTelemetry` helper that contains both sync throws and async
    rejections from a misbehaving injected telemetry fn. The success,
    API-error, and unparseable-output paths each write exactly one row;
    the "no API key" short-circuit is deliberately NOT instrumented
    (there's no SDK call to measure).
  - `CodexReviewer.review()` intentionally remains uninstrumented — it
    throws today (the real path goes through the `codex-adversarial`
    agent); a TODO comment references the 0.3.0 work where Codex runs
    from TS.
  - `rea doctor --metrics` prints a compact 7-day summary after the
    existing checks. The flag never contributes to the exit code — it is
    purely observational.

  ## First-class no-Codex config (G11.4)
  - `hooks/push-review-gate.sh` now honors `review.codex_required: false`
    and skips the protected-path Codex audit-record requirement in that
    mode. `REA_SKIP_CODEX_REVIEW` becomes a no-op under no-codex (skipping
    a review that isn't required is not meaningful, and no skip record
    is emitted).
  - `src/scripts/read-policy-field.ts` — tiny standalone helper that
    exposes a single scalar policy field to shell hooks without importing
    the full CLI surface. Exit codes distinguish field-missing (1) from
    policy-malformed (2); the push gate fails closed on any helper error
    (treat as `codex_required: true`).
  - `src/cli/doctor.ts` — the two Codex-specific checks are replaced by a
    single `info` line when `codex_required: false`. The curated-agents
    roster still expects `codex-adversarial.md` so flipping the flag back
    does not require a re-install. New `info` status kind for purely
    advisory lines that never contribute to the doctor exit code.
  - `rea init` — new `--codex` / `--no-codex` flags. The written
    `.rea/policy.yaml` always emits an explicit `review.codex_required`
    value. Wizard prompts with the flag or profile-derived default; `--yes`
    honors the flag directly. When the resolved value is false, a durable
    notice prints pointing at the exact knob to flip.
  - `profiles/bst-internal-no-codex.yaml` and
    `profiles/open-source-no-codex.yaml` — new variants whose name causes
    the init flow to default `codex_required: false`. Leading comment on
    each documents when to pick the variant and how to re-enable Codex.
  - 18 new tests across
    `__tests__/hooks/push-review-gate-no-codex.test.ts`,
    `src/cli/doctor.test.ts`, and `src/cli/init.test.ts` exercise the
    no-codex path, profile-name defaults, fail-closed on malformed policy,
    and policy-round-trip via the strict loader.

  ## HALT atomicity (G4)
  - `src/gateway/middleware/kill-switch.ts` — rewritten to issue exactly ONE
    syscall per invocation on `.rea/HALT` (`fs.open(path, O_RDONLY)`). The
    previous `stat` → `lstat` → `open` sequence had a TOCTOU window between
    the check and the read; the new implementation has none.
  - **Semantic guarantee:** HALT is evaluated exactly once per invocation, at
    chain entry. A call that passes that check runs to completion; a call that
    fails it is denied. Creating `.rea/HALT` mid-flight does **not** cancel
    in-flight invocations — it blocks _subsequent_ invocations only. This
    matches standard kill-switch semantics (SIGTERM after acceptance: the
    process continues).
  - **Fail-closed on unknown state:** `ENOENT` → proceed; any other errno
    (`EACCES`, `EPERM`, `EISDIR` on some platforms, `EIO`, …) → deny.
  - **Observability:** decision recorded on `ctx.metadata.halt_decision`
    (`absent` / `present` / `unknown`) and `ctx.metadata.halt_at_invocation`
    (ISO-8601 timestamp when HALT was present, else `null`). The audit
    middleware already forwards arbitrary `ctx.metadata` keys into the
    hash-chained record, so `halt_decision` appears on every audit row.
  - Six new tests in `src/gateway/middleware/kill-switch.test.ts` cover:
    mid-flight HALT creation, mid-flight HALT removal, per-invocation decision
    isolation, ENOENT regression, non-`ENOENT` errno fail-closed, and a
    10-invocation concurrency matrix across a HALT toggle.

  ## ReDoS safety (G3)

  Every regex that the middleware chain runs on untrusted MCP payloads is
  now bounded by a per-call wall-clock timeout. Defense-in-depth: static
  lint at build time, load-time safe-regex validation on user-supplied
  patterns, and a runtime timeout that hard-kills a catastrophic
  backtracker before it can hang the gateway.
  - `src/gateway/redact-safe/match-timeout.ts` — `wrapRegex(pattern, opts)`
    returns a synchronous `SafeRegex` with `.test`, `.replace`, and
    `.matchAll` ops. Each call spawns a short-lived worker thread, blocks
    the parent on `Atomics.wait` over a SharedArrayBuffer, and drains the
    reply via `receiveMessageOnPort` after the worker notifies. On timeout
    the parent `terminate()`s the worker — a hard kill that stops a
    catastrophic `(a+)+$`-style pattern cold. Default timeout is 100ms.
  - `src/gateway/middleware/redact.ts` — all 12 `SECRET_PATTERNS` now flow
    through `SafeRegex`. New `createRedactMiddleware({ matchTimeoutMs?,
userPatterns? })` factory. On timeout the offending value is replaced
    with the sentinel `[REDACTED: pattern timeout]` — the scanner never
    lets an un-scanned string escape. Timeouts are recorded on
    `ctx.metadata[redact.regex_timeout]` as
    `{event, pattern_source, pattern_id, input_bytes, timeout_ms}` — the
    input text is NEVER written, only its byte length.
  - `src/gateway/middleware/injection.ts` — both injection regex constants
    (`INJECTION_BASE64_PATTERN`, `INJECTION_BASE64_SHAPE`) now flow through
    `SafeRegex`. Same audit-metadata contract under the key
    `injection.regex_timeout`.
  - `src/policy/loader.ts` — new `redact.match_timeout_ms?: number` (default 100) and `redact.patterns?: {name, regex, flags?}[]` policy fields. Every
    user-supplied pattern is passed through `safe-regex` at load time; a
    flagged pattern rejects the entire policy load with an error naming the
    offender. Schema stays strict — typos fail loudly.
  - `src/gateway/server.ts` — compiles user patterns via `wrapRegex` at
    gateway-create time and passes the configured timeout to both
    `createRedactMiddleware` and `createInjectionMiddleware`.
  - `scripts/lint-safe-regex.mjs` + `pnpm lint:regex` — static ReDoS check
    on every built-in pattern. Chained into `pnpm lint` BEFORE eslint so a
    bad regex short-circuits the pipeline. The existing "Private Key" PEM
    armor pattern was tightened to a bounded form that safe-regex accepts.
  - 24 new tests across `src/gateway/redact-safe/match-timeout.test.ts`
    (wrapRegex behavior: benign, catastrophic, replace-unchanged-on-timeout,
    onTimeout fire-once, default budget), `src/gateway/middleware/redact.test.ts`
    (middleware integration: sentinel substitution, metadata shape, no input
    leakage, invocation continues, nested-object preservation), and
    `src/policy/loader.test.ts` (schema round-trip, safe-regex rejection,
    compile-failure rejection, strict-mode field rejection).

  ## Upgrade path + drift detection (G12)

  Closes the central dogfood gap: consumer projects (including rea itself) had
  no way to pull in updates to shipped artifacts — `hooks/`, `commands/`,
  `agents/`, `.husky/`, the rea-owned subset of `.claude/settings.json`, and
  the managed CLAUDE.md fragment — without a manual re-install that risked
  trampling local edits.
  - `src/cli/install/manifest-schema.ts` — strict zod schema for
    `.rea/install-manifest.json`. Records SHA-256 of every shipped file plus
    two synthetic entries: `.claude/settings.json#rea:desired` (hash of the
    rea-owned hooks subset, NOT the full file — consumer-added hooks stay
    invisible) and `CLAUDE.md#rea:managed:v1` (hash of the managed fragment
    only). `bootstrap: true` flags manifests seeded on pre-G12 installs.
  - `src/cli/install/canonical.ts` — single source of truth for "what ships
    in this rea version". Walks `hooks/`, `agents/`, `commands/`, `.husky/`
    under the package root and emits sorted, POSIX-normalized destination
    paths. Adding a new hook under `.husky/` automatically joins the upgrade
    surface.
  - `src/cli/install/{sha,manifest-io}.ts` — SHA-256 helpers (buffer +
    streaming file), atomic read/write for the manifest with the same
    tmp+rename EEXIST/EPERM retry used by settings-merge.
  - `src/cli/upgrade.ts` + `rea upgrade` command — classifies each file as
    `new` / `unmodified` / `drifted` / `removed-upstream`. Unmodified files
    auto-update silently (the consumer never changed them). Drifted files
    prompt `keep | overwrite | diff` interactively; `--yes` defaults to keep
    (safe), `--force` defaults to overwrite. Removed-upstream files prompt
    delete/skip. Writes a fresh manifest with `upgraded_at` at the end.
    Bootstrap mode records on-disk SHAs as the baseline when no manifest
    exists — the NEXT upgrade then compares against canonical normally.
  - `rea init` now writes the manifest as its last step, recording SHAs of
    the files actually on disk (not canonical — so a skipped copy still has
    an accurate baseline).
  - `rea doctor --drift` — read-only drift report. Row statuses:
    `unmodified | drifted-from-canonical | drifted-from-manifest | missing | untracked | removed-upstream`.
    Never contributes to the doctor exit code; `rea upgrade` is the action
    path.
  - `scripts/postinstall.mjs` + `"postinstall"` script — prints a one-line
    stderr nudge pointing at `rea upgrade` when the installed rea version
    disagrees with the manifest version. Silent when `CI=true`, silent when
    no manifest exists, silent when versions match, silent when running
    inside the rea repo itself. Never fails the install — every code path
    returns 0.
  - Dogfood caveat: `settings-protection.sh` still blocks Write|Edit on
    `.husky/*`, `.claude/hooks/*`, `.claude/settings.json`, `.rea/policy.yaml`,
    and `.rea/HALT`. `rea upgrade` writes via direct `fs` calls rather than
    Claude Code tool invocations, so it must be run from a terminal outside
    a Claude Code session. This is intentional: upgrade is an
    authorized-human action by design.

  ## Packaging
  - `.husky/` added to `package.json#files[]` so consumer installs pick up the commit-msg source
  - `scripts/` added to `package.json#files[]` for the postinstall script
  - `"postinstall": "node scripts/postinstall.mjs"` registered
  - `./audit` export added to `package.json#exports`
  - `safe-regex@^2.1.1` + `@types/safe-regex@^1.1.6` added as dev dependencies for G3.

  ## Explicitly deferred to the full 0.2.0 cycle

  Audit-chain tamper / crash-recovery tests, 20-file integration matrix, npm
  trusted publisher (OIDC-only), Streamable-HTTP transport, auxiliary-model
  routing, threat-model refresh.

### Patch Changes

- 82a4ff7: Add CLAUDE.md to the rea repo root so Claude Code has project-level behavioral rules, policy references, delegation patterns, and non-negotiable safety gates in the dogfood install. Ships as part of the repo, not the npm package.
- 1e69005: Dogfood install uses conventional `.claude/` paths — real copies of agents, commands, and hooks instead of symlinks and source-dir references. This only affects the rea repo's own install; published package contents are unchanged.

## 0.1.0

### Minor Changes

- 66b09a0: Initial preview release of REA (Reactive Execution Agent). Governance layer for Claude Code with autonomy policy, middleware chain, HALT kill-switch, 11 Claude Code hooks, 5 slash commands, 10-agent curated roster, and first-class Codex plugin integration for adversarial code review.

  **Non-goals**: no PM layer, no Obsidian integration, no account management, no daemon supervisor, no hosted service. REA replaces `@bookedsolid/reagent`.
