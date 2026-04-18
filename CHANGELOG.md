# @bookedsolid/rea

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
