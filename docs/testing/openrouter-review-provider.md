# Test Plan — OpenRouter OSS Review Provider (`gpt-oss-120b`)

> Owner: QA. Status: **plan (pre-implementation)** — derived from the locked
> spec's CLI contract, not from code that exists yet.
> Spec: `bst-cto-kb/Projects/rea/Planning/OpenRouter OSS Review Provider — gpt-oss-120b Spec.md` (r2, 2026-06-08), target **rea 0.50.x**.
> Contract sources read for this plan: `src/cli/review.ts`, `src/cli/preflight.ts`,
> `src/audit/local-review-event.ts`, `src/hooks/push-gate/findings.ts`,
> `src/hooks/push-gate/report.ts`, `src/policy/types.ts`, `src/policy/loader.ts`.

This document is the **acceptance contract** the builder's vitest suites are
reviewed against. It does not contain executable tests — those are authored by
the builder (co-located `src/cli/review.openrouter.test.ts` etc.) and must map
1:1 onto the matrix below. The cross-repo harness
(`scripts/openrouter-cross-repo-smoke.sh`) is the black-box companion that
proves the binary works when invoked from another project.

---

## 0. Hard constraints (from the gate) — read before writing any test

1. **No network in the required suite.** `OPENROUTER_API_KEY` is NOT in CI or
   the dev shell. Every required test injects a **mocked HTTP transport** via a
   deps seam (mirrors the existing `RunReviewDeps.executeCodexReview` seam) or a
   stubbed `fetch`. A test that performs a real outbound request is a defect.
2. **Live smoke is separate and opt-in.** Any test that needs the real key is
   tagged `skipIf(!process.env.OPENROUTER_API_KEY)` and lives in a `*.live.test.ts`
   file that is **excluded from the required gate** (`pnpm test`). It never runs
   in CI.
3. **`package.json` is a blocked path — no new test dependencies.** Use vitest +
   native `fetch` (or `globalThis.fetch`) mocking only (`vi.fn()` /
   `vi.stubGlobal('fetch', …)`). No `nock`, `msw`, `undici` mock-agent, etc.
4. **Determinism.** No real time, no real network, no `setTimeout`-to-wait. Inject
   clocks/sleeps through a seam; assert on captured calls, not on elapsed wall time.
5. **Import from source, never `dist/`.** Unit/integration tests import the TS
   source. Only the cross-repo harness invokes `dist/cli/index.js` (it is a
   packaging/black-box test by design).
6. **Clean up in `afterEach`.** Restore globals (`vi.unstubAllGlobals()`),
   restore mocks (`vi.restoreAllMocks()`), and remove any temp dirs created for
   audit-log / last-review.json assertions.

### The required deps seam (the builder must expose this)

The spec's `ReviewProvider` / `ReviewOutcome` contract (§ Architecture/design)
gives the seam. For the OpenRouter path to be testable with no key, the provider
must accept an **injectable transport** — not call `fetch` from module scope.
The plan assumes the builder threads one of:

- `RunReviewDeps.executeOpenRouterReview?` — the existing test-seam pattern,
  extended for the second provider (preferred; matches `executeCodexReview?`), and/or
- an `OpenRouterTransport` interface `{ post(url, body, headers): Promise<Response-like> }`
  passed into `executeOpenRouterReview(baseDir, options, { transport, env, now })`.

A test cannot satisfy this plan if the only way to exercise the path is a real
`fetch`. **If the implementation lands without an injectable transport, that is
itself a blocking test-plan finding** — flag it back to the builder.

---

## 1. Acceptance Criteria → Test matrix

Each spec acceptance criterion (§ "Acceptance criteria") maps to one or more
tests. `[U]` = unit (mocked transport, required gate). `[I]` = integration
(in-process `runReview`, real temp git repo + audit log, mocked transport,
required gate). `[X]` = cross-repo harness (binary, `scripts/`). `[L]` = live
smoke (key-gated, NOT in required gate). `[G]` = golden-record regression.

| # | Acceptance criterion (spec) | Tests | Kind |
|---|---|---|---|
| AC-1 | `rea review --provider openrouter` writes a valid `rea.local_review` record that `rea preflight` accepts as coverage | T-INT-01, T-INT-02 | [I][X] |
| AC-2 | `.rea/last-review.json` is written with the same redacted `Finding` schema as the codex path | T-INT-03, T-RED-02 | [I][X] |
| AC-3 | Malformed/aborted model output → `verdict: error`, exit 2 — never a silent pass | T-DEG-01..05 | [U] |
| AC-4 | Secrets in the diff are redacted before any outbound call | T-RED-01 | [U] |
| AC-5 | Sensitive paths **refuse** the external lane (fail-closed) | T-PATH-01..06 | [U] |
| AC-6 | `provider: both` emits a parity report and writes the gpt-oss record under `rea.local_review.shadow` (NOT canonical) so codex stays authoritative | T-SHADOW-01..03, T-PARITY-01 | [I] |
| AC-7 | The codex path's audit records are **byte-identical** before/after the `runReview` refactor | T-GOLD-01, T-GOLD-02 | [G] |
| AC-8 | `rea doctor` reports openrouter availability + estimated monthly spend | T-DOC-01..03 | [U] |
| AC-9 | No change to preflight, push-gate enforcement, or exit-code semantics | T-GOLD-02, T-EXIT-01..04, existing preflight suite stays green | [U][I] |

Plus spec-derived criteria not in the bullet list but load-bearing:

| # | Criterion (spec §) | Tests | Kind |
|---|---|---|---|
| AC-10 | Well-formed `json_schema` response → `Finding[]` + verdict (§2 output adapter) | T-OK-01..04 | [U] |
| AC-11 | Policy zod-strict rejects unknown `review.providers.openrouter.*` fields; default `provider` resolves to `codex` (§3 config) | T-POL-01..05 | [U] |
| AC-12 | Degradation ladder: 429 → backoff → fallback → codex; malformed → repair-retry → codex (§6) | T-DEG-06..09 | [U] |
| AC-13 | `served_by` / serving-backend captured into the audit record (§2 API call) | T-INT-04 | [I] |
| AC-14 | Token-spend telemetry written to `.rea/metrics.jsonl` (§6) | T-TEL-01, T-DOC-03 | [U] |

---

## 2. Unit suite (mocked fetch) — required gate

> File suggestion: `src/cli/review.openrouter.test.ts` (adapter + degradation +
> redaction + path-guard), `src/policy/loader.openrouter.test.ts` (policy zod).

### 2.1 Happy path — well-formed `json_schema` → `Finding[]` + verdict — AC-10

- **T-OK-01** A well-formed JSON body
  `{"verdict":"blocking","findings":[{"severity":"P1","title":"…","body":"…","file":"a.ts","line":12}]}`
  → `ReviewOutcome.verdict === 'blocking'`, `findings.length === 1`, finding maps
  field-for-field onto the existing `Finding` shape (`severity|title|body|file?|line?`).
- **T-OK-02** `verdict:"concerns"` with only P2 findings → `verdict === 'concerns'`,
  `findingCount` correct.
- **T-OK-03** `verdict:"pass"` with `findings:[]` → `verdict === 'pass'`, exit 0.
- **T-OK-04** A finding with no `file`/`line` → those keys are **omitted**
  (not `null`/`undefined`) in the resulting `Finding`, matching how `report.ts`
  serializes (so `last-review.json` stays schema-identical to the codex path).
- **Assertion on the request, not just the response:** the outbound body sent to
  the transport carries `response_format.type === 'json_schema'` and the pinned
  `model` (`openai/gpt-oss-120b`), the `Authorization: Bearer …` header is built
  from `env.OPENROUTER_API_KEY` (read from injected `env`, never `process.env`
  in the test), and `base_url` is the policy value. Capture via the transport mock.

### 2.2 Malformed / non-JSON output → `verdict:'error'`, exit 2 — AC-3 (NEVER a silent pass)

This is the single most important behavioral guarantee. Every malformed-shape
class gets its own test, and **every one asserts `exit code === 2` AND that the
written audit record's `verdict === 'error'`** (so preflight will not count it).

- **T-DEG-01** Response body is not JSON at all (HTML error page, truncated
  stream) → `verdict:'error'`, exit 2, audit `metadata.kind` set (e.g. `parse-error`).
- **T-DEG-02** Valid JSON but missing the `verdict` field → `error`, exit 2.
- **T-DEG-03** Valid JSON, `verdict` present but not in
  `{pass,concerns,blocking}` (e.g. `"approve"`) → `error`, exit 2.
- **T-DEG-04** Valid JSON, `findings` present but an element violates the schema
  (`severity:"P4"`, or `severity` missing) → `error`, exit 2 (after the repair
  retry exhausts — see T-DEG-08).
- **T-DEG-05** Empty `choices` / no message content → `error`, exit 2.
- **Negative guard (anti-false-pass):** a test that feeds a malformed body and
  asserts the run does **NOT** exit 0 and does **NOT** write a `verdict:'pass'`
  audit record. This is the "test that fails if the feature silently passes when
  broken" guard the QA charter requires.

### 2.3 HTTP-status degradation — AC-12 (429 → backoff → fallback → codex)

The clock/sleep is injected; assert on call ordering, not elapsed time.

- **T-DEG-06** First call returns HTTP 429 → provider retries with backoff
  (assert the injected sleep was called with increasing delays) → on persistent
  429, the degradation ladder falls back to the OpenRouter fallback backend, then
  to codex. Assert the final outcome is produced by the **codex** path and the
  audit record reflects the escalation (e.g. `metadata.degraded_from:'openrouter'`
  or the codex `provider` value — whatever the builder records; the test pins it).
- **T-DEG-07** 500 / 503 transport error → same ladder (transport failure is
  the sibling of 429). Never hangs: assert the call count is bounded.

### 2.4 Schema-violating output → repair-retry → codex — AC-12

- **T-DEG-08** First response schema-violating, **one repair retry** issued
  (assert exactly one extra transport call with a repair-prompt), retry returns
  well-formed → success on the retried result (no escalation).
- **T-DEG-09** First response schema-violating, repair retry **also**
  schema-violating → escalate to codex (assert codex path invoked) OR, if codex
  is unavailable, `verdict:'error'` exit 2. The test pins the spec's
  "one repair retry → Codex escalation" ladder; never a silent pass.

### 2.5 Redact-before-send — AC-4

- **T-RED-01** Inject a diff containing a planted secret (use the existing
  default secret patterns — e.g. an `AKIA…`-shaped AWS key, a
  `Bearer sk-…`-shaped token). Run `executeOpenRouterReview` with the transport
  mock capturing the outbound body. **Assert the planted secret string does NOT
  appear anywhere in the captured request body** (it was redacted by
  `compileDefaultSecretPatterns` + `redactSecrets` before send). This proves
  redact-before-send on the **input** (the spec extends the existing
  output-redaction to the outbound diff).
- **T-RED-02** A finding `body` returned by the model that quotes a secret →
  `last-review.json` on disk has it redacted (reuses the `report.ts` writer
  guarantee; assert by reading the temp `.rea/last-review.json`). Covers AC-2's
  "same redacted Finding schema."

### 2.6 Path-guard (PRIMARY control, fail-closed) — AC-5

The spec makes the path guard the primary control and **fail-closed on
uncertainty**, with a hard rule that **strawn-legal never routes to an external
OSS lane**.

- **T-PATH-01** Diff touches `strawn-legal/contract.md` → OpenRouter is
  **refused**; the run routes to codex (or local fallback per policy), and **no
  outbound OpenRouter request is made** (assert transport call count === 0).
- **T-PATH-02** Diff touches `**/*.secret.*` (e.g. `config.secret.json`) → refused, no send.
- **T-PATH-03** Diff touches a `blocked_paths` policy entry → refused, no send.
- **T-PATH-04** Each sensitive glob from the policy `path_overrides` list is
  swept in a table-driven test (one assertion per glob) — every sensitive glob
  refuses the external lane.
- **T-PATH-05 (fail-closed-on-uncertain)** A path the classifier cannot
  confidently classify (e.g. a path that errors during classification, or an
  ambiguous symlinked path) → **refuses** the external lane (fail-closed), no send.
- **T-PATH-06 (strawn-legal never external — hard invariant)** A dedicated test
  that asserts, independent of any policy override, a `strawn-legal/**` path can
  **never** produce an outbound OpenRouter request, even when policy is
  misconfigured to point that glob at `openrouter`. The hard rule wins over
  config. (If the implementation lets policy override this, that is a blocking
  security finding.)

> All six assert `transport.mock.calls.length === 0` for the OpenRouter
> transport — the strongest possible "data did not leave the machine" assertion
> in a no-network test.

### 2.7 Policy zod-strict — AC-11

> File: `src/policy/loader.openrouter.test.ts`.

- **T-POL-01** A policy with `review.provider: openrouter` parses; the loaded
  `policy.review.provider === 'openrouter'`.
- **T-POL-02** A policy with **no** `review.provider` → the effective provider
  resolves to `codex` (default-provider-is-codex; assert via the resolver the
  builder exposes, or via `runReview` selecting the codex impl).
- **T-POL-03** `review.provider: bogus` → policy load **fails** (zod enum,
  matching the `.strict()` + enum convention already used for
  `local_review.mode` / `refuse_at`).
- **T-POL-04** A **well-formed** `review.providers.openrouter` block
  (`model`, `base_url`, `data_policy`, `backend_pin`, `timeout_ms`,
  `path_overrides`) parses and round-trips.
- **T-POL-05 (zod-strict rejects unknown field)** `review.providers.openrouter.bogus_field: true`
  → policy load **fails** with an error naming the offending key. This mirrors
  every other `.strict()` block in the loader; the builder MUST keep the new
  sub-schema strict. A test that passes when the unknown field is silently
  dropped is a defect.

> **Verified contract detail (2026-06-08, against current `dist/`):** the
> existing `ReviewPolicySchema` is already `.strict()`, so today an unknown
> `review.provider` field is **rejected** by `loadPolicyAsync`. The builder's
> job is therefore to *add* `provider` (enum) and `providers.openrouter`
> (strict sub-object) to the schema so valid configs parse, while keeping
> `.strict()` so a typo'd sub-field still fails. **Caveat for the integration
> tests:** `rea preflight`'s `tryLoadPolicy` and `rea review`'s
> `resolveLocalReviewMode` both **catch the load error and fall back to
> protective defaults** (`mode: 'enforced'`, `policy: undefined`) rather than
> hard-failing. So a malformed-policy test that runs through the *CLI* observes
> "protective default" behavior, not a thrown error — the thrown-error
> assertion (T-POL-03/05) must call `loadPolicyAsync` **directly**, not through
> the CLI. Both behaviors are correct and both should be pinned.

---

## 3. Integration suite (in-process `runReview`) — required gate

> Real temp git repo (created in `beforeEach`, removed in `afterEach`), real
> `.rea/audit.jsonl` written, mocked OpenRouter transport injected through deps.
> These exercise the **full downstream wiring** (audit append → last-review.json
> → exit code) that the spec promises is provider-agnostic.

### 3.1 Canonical record + preflight coverage — AC-1

- **T-INT-01** `runReview({provider:'openrouter'})` with a mocked `pass` outcome
  →  a `rea.local_review` audit record is appended with `provider:'openrouter'`,
  `verdict:'pass'`, a populated `content_token`, `model:'openai/gpt-oss-120b'`,
  and `reasoning_effort` set from the request (the spec notes gpt-oss reasoning
  effort stays meaningful). Exit 0.
- **T-INT-02 (the real coverage proof)** After T-INT-01 writes the record, call
  `computePreflight(baseDir, {})` against the **same** working tree → outcome
  `status:'clean'`, `match_kind:'content_token'`. This proves the openrouter
  record satisfies preflight coverage with **zero preflight changes** (AC-1 +
  AC-9). A blocking-verdict variant asserts `status:'refuse'` with
  `last_blocking_verdict:'blocking'`.

### 3.2 last-review.json — AC-2

- **T-INT-03** A `concerns` outcome with findings → `.rea/last-review.json`
  exists, parses, `schema_version === 1`, `findings` array matches the
  `Finding` shape, `verdict === 'concerns'`. Byte-compatible with the codex
  path's `writeLastReview` (same writer; assert the openrouter path calls it,
  not a second inline serializer).

### 3.3 served_by / serving backend — AC-13

- **T-INT-04** The mocked OpenRouter response carries a serving-provider field
  (OpenRouter returns the backend it routed to). Assert the audit record records
  it (`provider_version` overload or a dedicated `served_by` field — the test
  pins whichever the data-architect chose). Forensics requirement from §2.

### 3.4 Exit-code semantics unchanged — AC-9

- **T-EXIT-01** `pass` → exit 0. **T-EXIT-02** `concerns` + default
  `strictFailOn:'blocking'` → exit 0. **T-EXIT-03** `concerns` +
  `strictFailOn:'concerns'` → exit 1. **T-EXIT-04** `blocking` → exit 2,
  `error` → exit 2. These mirror the codex-path exit-code tests exactly — the
  spec guarantees identical mapping regardless of provider.

> Exit-code assertions use the existing `process.exit` interception pattern
> (spy/throw on `process.exit`) the codex CLI tests already use.

---

## 4. `provider: both` — shadow + parity — AC-6

> File: `src/cli/review.both.test.ts`.

### 4.1 Shadow record is informational, NOT coverage — the correctness requirement

- **T-SHADOW-01** `runReview({provider:'both'})` writes the **codex** outcome
  under the canonical `rea.local_review` tool name AND the gpt-oss outcome under
  `rea.local_review.shadow` (a NEW informational tool name the builder must add
  alongside the existing `skipped_*` siblings in `local-review-event.ts`).
- **T-SHADOW-02 (the load-bearing regression)** Construct an audit log that
  contains **only** a `rea.local_review.shadow` record with `verdict:'pass'`
  whose `content_token` matches the working tree, then run
  `computePreflight(...)`. **Assert `status:'refuse'`** — the shadow record does
  NOT cover HEAD. (Today `findRecentLocalReview` only matches
  `LOCAL_REVIEW_TOOL_NAME` / `CODEX_REVIEW_TOOL_NAME`; this test pins that the
  shadow tool name is never added to that accept-list. If a future edit adds it,
  this test fails — which is the point.)
- **T-SHADOW-03** In `provider:'both'`, when codex is **authoritative blocking**
  but gpt-oss shadow says `pass`, preflight refuses (codex wins). Proves the
  shadow `pass` cannot launder a codex `blocking`.

### 4.2 Parity report — AC-6

- **T-PARITY-01** The side-by-side parity artifact is emitted with the spec's
  fields: verdict agreement, finding-set overlap, P1/P2 catch parity,
  false-positive delta, **malformed-output rate**, latency, cost. Assert the
  artifact shape (keys present, types correct) from a fixture pair of
  outcomes — this is a structural test, not a quality-threshold test (the
  three-number parity *pass/fail* is a human judgment over a week of real runs,
  not a deterministic unit assertion — see § Coverage gaps).

---

## 5. Byte-identical codex golden record — AC-7 (the refactor safety net)

The `runReview` refactor lifts four hardcoded `PROVIDER_CODEX` sites, the codex
availability probe, error classification, and the install message into the
provider abstraction. The codex path's observable output **must not move a byte**.

- **T-GOLD-01 (capture before refactor)** A golden fixture is captured from the
  **current** codex path BEFORE the refactor lands: run `runReview({})` (codex,
  default provider) with the `executeCodexReview` deps-seam returning a **fixed**
  `ReviewOutcome` (deterministic findings/verdict/model/reasoning/duration), a
  fixed clock, and a temp repo at a fixed HEAD. Snapshot:
  - the exact `rea.local_review` audit record JSON (`tool_name`, `server_name`,
    `tier`, `status`, every `metadata` key incl. key **ordering** as serialized),
  - the exact `--json` stdout payload,
  - the exact `.rea/last-review.json` bytes,
  - the exit code.
  Commit this golden as a fixture file (e.g.
  `src/cli/__fixtures__/codex-golden-record.json`).
- **T-GOLD-02 (stays green after refactor)** The same scenario re-run through the
  refactored `runReview` (codex selected) produces a **byte-identical** record,
  stdout payload, and last-review.json. Any diff fails. This is the regression
  wall around AC-7 and AC-9.

> Determinism inputs to pin in both runs: `executeCodexReview` deps-seam (fixed
> outcome), injected `now`, `model`/`reasoning_effort` defaults
> (`IRON_GATE_DEFAULT_MODEL` / `IRON_GATE_DEFAULT_REASONING`), and the
> `provider_version` from the codex probe (stub the probe to a fixed version so
> the snapshot is stable across machines).

---

## 6. `doctor` — availability + spend — AC-8 / AC-14

> File: `src/cli/doctor.openrouter.test.ts`. `CheckResult` shape is
> `{ label, status: 'pass'|'fail'|'warn'|'info', detail? }`.

- **T-DOC-01 (presence only — NEVER the value)** With `env.OPENROUTER_API_KEY`
  set to a sentinel, the doctor openrouter availability check returns
  `status:'pass'` and a detail that **does not contain the key value**. Assert
  the rendered detail string does NOT include the sentinel. (Key-leak guard.)
- **T-DOC-02** With no key set → `status:'warn'` (or `'info'`) and a remediation
  detail that says the key is absent — and still does not echo any value.
- **T-DOC-03 (spend summary)** With a seeded `.rea/metrics.jsonl` (a few
  token-cost rows), the doctor spend summary reports per-day review count +
  estimated monthly spend per provider, computed from the metrics file (not the
  network). Assert the numbers derive from the fixture.
- **T-TEL-01** `executeOpenRouterReview` appends a token/cost row to
  `.rea/metrics.jsonl` per call (input tokens, output tokens, est. cost, model,
  served_by). Assert the row shape from a mocked response that carries a `usage`
  block.

> The reachability **ping** in `isAvailable` (key-present + cheap network probe)
> is NOT exercised in the required gate (it would hit the network). The unit
> test stubs `isAvailable` / the transport; the real ping is a live-smoke
> concern (§8) and a `doctor`-against-real-key manual check (runbook).

---

## 7. Cross-repo smoke (binary, black-box) — `scripts/openrouter-cross-repo-smoke.sh`

The harness (Jake's explicit ask) is documented in § "Acceptance runbook" and
ships as `scripts/openrouter-cross-repo-smoke.sh`. It is **[X]** in the matrix:

- **T-X-01 (AC-1/AC-2 black-box)** Build `dist/`, create a disposable throwaway
  git repo with a sample diff, invoke
  `node <reaDir>/dist/cli/index.js review --provider openrouter --json` **from
  that repo**, and assert: exit code, the emitted JSON
  (`status`, `provider:'openrouter'`, `finding_count`, `exit_code`), and the
  written `.rea/last-review.json` (schema_version, findings shape, redaction).
- **Mode (a) default — mocked transport, NO key.** The harness points the
  provider at a tiny local fixture responder (or sets `REA_OPENROUTER_FIXTURE`
  the provider honors in test mode — see the contract note below). Runs in CI and
  locally with no key.
- **Mode (b) live — gated on `OPENROUTER_API_KEY`.** Same flow against the real
  endpoint; skipped (exit 0 with a SKIP notice) when the key is absent.

### Contract the builder must honor for mode (a) to exist

The harness needs a **no-key** way to drive the real binary's openrouter path.
The builder must provide ONE of (decide at implementation, document the choice):

1. **`REA_OPENROUTER_FIXTURE=<path-to-json>`** — an env var the openrouter
   provider honors ONLY in test/fixture mode: instead of calling the network it
   reads the canned response JSON from that path. Cheapest; no socket. **Preferred.**
2. **`base_url` override to a localhost fixture responder** — the harness starts
   a tiny Node http server that returns a canned `chat/completions` body, and the
   throwaway repo's `.rea/policy.yaml` sets
   `review.providers.openrouter.base_url: http://127.0.0.1:<port>/api/v1`. Works
   with zero provider test-hooks but needs a port and a process.

The harness implements **option 2 by default** (it requires no special provider
build-flag, so it validates the *real shipped binary* end-to-end), and **also
supports option 1** if `REA_OPENROUTER_FIXTURE` is honored by the provider —
falling back automatically. See the script's header for the exact toggle.

> If neither hook exists when the implementation lands, mode (a) cannot run the
> real openrouter dispatch without a key — that is a blocking testability finding
> to raise with the builder (the spec's redact/path-guard controls run *before*
> the transport, so a localhost base_url still exercises them faithfully).

---

## 8. Live smoke (key-gated, NOT in the required gate)

> File: `src/cli/review.openrouter.live.test.ts`, every test
> `it.skipIf(!process.env.OPENROUTER_API_KEY)(...)`. Excluded from `pnpm test`
> via the vitest config's required-suite glob; run explicitly by an operator.

- **T-LIVE-01** Real `executeOpenRouterReview` against a trivial diff → a
  well-formed structured response parses into `Finding[]` + verdict (proves the
  pinned backend honors `response_format` json_schema in the wild — the spec's
  load-bearing "malformed-output rate" risk).
- **T-LIVE-02** `rea doctor` availability ping returns reachable with a real key.
- **T-LIVE-03** Token/cost row written to `.rea/metrics.jsonl` from a real `usage`.

These are the only tests that may touch the network, and they never gate a merge.

---

## 9. Coverage gaps — called out honestly (no pretend coverage)

These are real and either non-deterministic, out-of-band, or impossible to
assert in a no-network/no-key required suite:

1. **The three-number parity *pass/fail* (P1/P2 catch parity, false-positive
   delta, malformed-output rate).** This is a **week-long empirical judgment over
   real rea work** (spec § 5/Rollout 5A), not a unit assertion. We test the
   parity-report *shape and math* (T-PARITY-01) and the malformed→error
   *mechanism* (T-DEG-*), but the *acceptance threshold* is a human/operator call
   recorded in the spec's "Remaining unknowns," not a green test.
2. **Real structured-output reliability of the pinned OpenRouter backend.** The
   single biggest spec risk ("structured-output is the real risk"). A mocked
   transport proves our *adapter* handles malformed output; it cannot prove how
   *often* the live backend emits it. Only T-LIVE-01 over volume answers that, and
   it is key-gated and not in the gate. **We test our resilience, not their
   reliability.**
3. **Backend-pin determinism (`provider.order/only`).** We assert the outbound
   body *carries* the pin (T-OK-01 request assertion). We cannot deterministically
   prove OpenRouter *honors* it without the live endpoint and repeated sampling.
4. **The reachability ping in `isAvailable`.** Network-dependent; stubbed in the
   gate, exercised only by T-LIVE-02 and the manual runbook.
5. **Real cost accuracy.** We test that est. cost is *computed from `usage`*
   (T-TEL-01) using the pinned price constants; we do not verify those constants
   match OpenRouter's live billing (the spec itself flags pricing as volatile and
   to re-check at implementation).
6. **Push-gate parity.** Out of scope by spec decision — the push-gate stays on
   codex (CODEOWNERS-protected, the escalation backstop). No openrouter tests
   touch `src/hooks/push-gate/`. The existing push-gate suite must stay green
   (proves "no change to push-gate enforcement," AC-9), but that is a *negative*
   guarantee, not new coverage.

---

## 10. Definition of done (test side)

- All `[U]`, `[I]`, `[G]`, `[X]`(mode a) tests green in `pnpm test` + the
  cross-repo harness in CI, with **no `OPENROUTER_API_KEY` present**.
- The codex golden record (T-GOLD-01/02) is captured from the pre-refactor path
  and stays byte-identical after.
- Every malformed-input test asserts `exit 2` + `verdict:'error'` and the
  explicit anti-false-pass negative guard exists.
- Every path-guard test asserts `transport calls === 0` for sensitive paths,
  and the strawn-legal-never-external invariant has a dedicated test that wins
  over policy.
- Policy zod-strict rejects an unknown `review.providers.openrouter.*` field.
- No new dependency in `package.json`; no test imports from `dist/` (except the
  harness, by design); every test cleans up in `afterEach`.
- Live smoke exists, is key-gated, and is excluded from the required gate.

---

## 11. Acceptance runbook — "Jake validates it works"

Copy-pasteable. Two parts: **(A) this repo** and **(B) from another project**.
Mode (a) — mocked transport — needs **no `OPENROUTER_API_KEY`** and is the
default everywhere.

### A. In this repo (rea)

```bash
cd /Volumes/Development/booked/rea

# 1. Required gate — unit + integration + golden + policy, NO key needed.
pnpm test

# 2. The cross-repo smoke, mocked transport (default; no key). Builds dist/,
#    spins a throwaway consumer repo, invokes the binary from it, asserts
#    JSON + exit code + last-review.json + preflight coverage.
scripts/openrouter-cross-repo-smoke.sh

# 3. Exercise each canned verdict (drives the exit-code + last-review assertions):
REA_SMOKE_VERDICT=pass      scripts/openrouter-cross-repo-smoke.sh   # exit 0, last-review pass
REA_SMOKE_VERDICT=concerns  scripts/openrouter-cross-repo-smoke.sh   # exit 0, last-review concerns
REA_SMOKE_VERDICT=blocking  scripts/openrouter-cross-repo-smoke.sh   # exit 2, last-review blocking
REA_SMOKE_VERDICT=malformed scripts/openrouter-cross-repo-smoke.sh   # exit 2, verdict:error, NO last-review (the AC-3 guarantee)
```

**Expected:** `pnpm test` green with `OPENROUTER_API_KEY` unset. Each smoke run
ends with `[ ok ] ALL cross-repo openrouter smoke assertions passed`. The
`malformed` run proves a bad model response yields exit 2 / `status:"error"`
and never a silent pass.

### B. From another project (the explicit ask — binary called directly)

This is the same flow the harness automates, done by hand so you can see it
work from a foreign repo. Replace `<reaDir>` with `/Volumes/Development/booked/rea`.

```bash
# 0. One-time: build the binary in the rea repo.
( cd /Volumes/Development/booked/rea && pnpm build )

# 1. Make a throwaway consumer repo with a sample diff.
TMP="$(mktemp -d)"; cd "$TMP"
git init -q && git config user.email t@t.test && git config user.name t && git config commit.gpgsign false
printf 'export const add=(a,b)=>a+b;\n' > app.ts && git add app.ts && git commit -qm baseline
printf 'export const divide=(a,b)=>a/b; // no zero guard\n' >> app.ts   # the sample diff

# 2. Select the openrouter provider, pointed at a local fixture responder
#    (mocked transport — NO key). Start a one-liner responder first:
node -e 'const h=require("http");const b=JSON.stringify({choices:[{message:{content:JSON.stringify({verdict:"concerns",findings:[{severity:"P2",title:"no zero-guard",body:"divide has no b===0 guard",file:"app.ts",line:2}]})}}],usage:{prompt_tokens:900,completion_tokens:120}});const s=h.createServer((q,r)=>{q.on("data",()=>{});q.on("end",()=>{r.writeHead(200,{"content-type":"application/json"});r.end(b)})});s.listen(0,"127.0.0.1",()=>console.log(s.address().port))' &
PORT=...   # paste the port the line above printed
mkdir -p .rea
cat > .rea/policy.yaml <<YAML
review:
  provider: openrouter
  local_review: { mode: enforced }
  providers:
    openrouter:
      model: "openai/gpt-oss-120b"
      base_url: "http://127.0.0.1:${PORT}/api/v1"
      data_policy: deny-training
YAML

# 3. Invoke the rea BINARY DIRECTLY from this foreign repo:
node /Volumes/Development/booked/rea/dist/cli/index.js review --provider openrouter --json --with-findings
echo "exit: $?"

# 4. Confirm working results:
cat .rea/last-review.json          # schema_version:1, verdict:"concerns", findings[]
node /Volumes/Development/booked/rea/dist/cli/index.js preflight --json   # status:"clean" — the review covers HEAD
```

**Expected outputs:**

- Step 3 stdout: one JSON line —
  `{"status":"concerns","finding_count":1,"provider":"openrouter",...,"exit_code":0,"findings":[...]}`,
  exit `0`.
- Step 4 `.rea/last-review.json`: `{"schema_version":1,"verdict":"concerns","findings":[{"severity":"P2",...}], ...}`.
- Step 4 `preflight --json`: `{"status":"clean",...}` — proving the openrouter
  review record satisfies preflight coverage with no preflight changes (AC-1).

### C. Live validation (optional — real key, NOT a gate)

```bash
# Set the key once, the turnkey way (masked prompt → ~/.config/rea/credentials, 0600):
rea config set-key openrouter
#   or per-project / CI (env wins over the stored key; never commit it):
#   export OPENROUTER_API_KEY="sk-or-..."
rea config list                           # confirm: "openrouter  set via config file …last4"

REA_SMOKE_MODE=live scripts/openrouter-cross-repo-smoke.sh   # hits the real endpoint
pnpm test -- review.openrouter.live       # the key-gated live suite (skips if no key)
node /Volumes/Development/booked/rea/dist/cli/index.js doctor   # openrouter: available + est. monthly spend
```

**Expected:** the live smoke produces a real structured verdict and passes the
same JSON/last-review assertions; `rea doctor` reports openrouter **available**,
its key **source** (`env` / `config file`), and a spend summary, and **never
prints the key value**.

> **Key resolution is env-FIRST, then the managed file.** `rea config set-key
> openrouter` stores the key at `${XDG_CONFIG_HOME:-~/.config}/rea/credentials`
> (dir `0700`, file `0600`). An exported `OPENROUTER_API_KEY` always overrides
> the stored key, so a project or CI run can use a per-invocation key without
> touching the global default. A symlinked / world-readable / foreign-owned
> credentials file is REFUSED (treated as no key) and the refusal is surfaced by
> `rea doctor` / `rea config list` — it never silently feeds the review lane.

### Quick failure-triage

| Symptom | Likely cause |
|---|---|
| Smoke fails at "missing binary" | `pnpm build` failed — run it directly and read the error. |
| Smoke fails at "preflight did NOT accept … as coverage" | the openrouter audit record isn't being written under `rea.local_review`, or `content_token` mismatch — AC-1 regression. |
| `malformed` run exits 0 | **AC-3 violation** — a bad model response silently passed. Blocking. |
| Any sensitive-path test made an outbound call | **AC-5 violation** — path-guard not fail-closed. Blocking security finding. |
| `doctor` output contains the key string | **AC-8 violation** — key leak. Blocking. |
