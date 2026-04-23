# REA

**Agentic governance layer for Claude Code — policy enforcement, hook-based safety gates, audit logging, and Codex-integrated adversarial review.**

[![npm version](https://img.shields.io/npm/v/%40bookedsolid%2Frea?color=cb3837&label=npm)](https://www.npmjs.com/package/@bookedsolid/rea)
[![CI](https://github.com/bookedsolidtech/rea/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bookedsolidtech/rea/actions/workflows/ci.yml)
[![npm provenance](https://img.shields.io/badge/npm%20provenance-attested-blue?logo=npm)](https://docs.npmjs.com/generating-provenance-statements)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![DCO](https://img.shields.io/badge/DCO-required-green)](https://developercertificate.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![SafeSkill 20/100](https://img.shields.io/badge/SafeSkill-20%2F100_Blocked-red)](https://safeskill.dev/scan/bookedsolidtech-rea)

> Status: `0.9.x` — published to npm with provenance. See
> [CHANGELOG.md](./CHANGELOG.md) for the per-release history.

---

## Installation

```bash
npx @bookedsolid/rea init
```

The `init` command is an interactive wizard. It detects your project, writes
`.rea/policy.yaml`, copies hooks and slash commands into `.claude/`, wires
`.mcp.json` to run `rea serve` as a governance gateway, installs a
`.husky/commit-msg` hook, and appends a managed fragment to `CLAUDE.md`.

Node 22+ and pnpm 9+ required.

## What REA is

REA is a governance layer for Claude Code. It is a single npm package that
ships four things:

1. A **hook layer** — 14 shell scripts total. 12 are registered in the
   shipped `.claude/settings.json` and fire on Claude Code's `PreToolUse`
   / `PostToolUse` events (secret scanning, dangerous-command
   interception, blocked-path protection, settings protection,
   attribution rejection, env-file protection, disclosure-policy
   routing, dependency audit, changeset security, architecture advisory,
   PR-issue-link advisory, and the Claude-Code push-review adapter).
   One more shipped hook, `commit-review-gate.sh`, is a Claude
   `PreToolUse: Bash` hook that matches `git commit` — it is shipped
   ready-to-wire but intentionally NOT registered in the default
   `.claude/settings.json`, so operators who want commit-time review can
   opt in by adding a rule. The final script,
   `push-review-gate-git.sh`, is a thin native-git adapter that sources
   `hooks/_lib/push-review-core.sh` (the same shared core used by the
   Claude-Code push-review adapter), so a fix to the push-review logic
   lands in one place. It ships for consumers who manually configure
   a wrapper-based `.husky/pre-push` (and as scaffolding for a future
   installer revision). The default `rea init` installer emits a
   standalone inline `.husky/pre-push` body instead of wiring the
   adapter — see the Hooks section for details.
2. A **gateway layer** — an MCP server (`rea serve`) that proxies downstream
   MCP servers through a middleware chain. Every tool call — native or
   proxied — is classified, policy-checked, redacted, audited, and
   size-capped before it executes. The gateway also supervises downstream
   child processes: unexpected deaths are detected eagerly, the circuit
   breaker never reuses a zombie client, and a `SESSION_BLOCKER` audit
   event fires when a downstream crosses the per-session failure threshold.
3. A **policy runtime** — `.rea/policy.yaml` with a strict zod-validated
   schema. Defines autonomy level, a hard ceiling (`max_autonomy_level`),
   blocked paths, attribution rules, context protection, redaction and
   injection tuning, review/cache knobs, and an optional Discord
   notification webhook.
4. A **kill switch** — `.rea/HALT` is a single file. If it exists, every
   tool call is denied at the middleware and hook layers. Use
   `rea freeze --reason "..."` to create it and `rea unfreeze --reason "..."`
   to remove it.

REA is one tool that does one thing: gate and audit agentic tool calls
against operator-defined policy. That is the whole product.

## What REA is NOT

These are non-goals. PRs adding any of these will be closed with a pointer
to build a separate package that composes with REA.

- **Not a project manager.** No task CRUD, no GitHub issue sync, no board
  scaffolding. No `task_create`, `task_update`, `repo_scaffold`.
- **Not an Obsidian integration.** No vault journaling, no note creation,
  no precompact summaries, no pre/post-compact Obsidian hooks.
- **Not an account manager.** No `rea account add/list/env/rotate/remove`.
  No Keychain, no OAuth, no multi-tenant token vault. Env vars only.
- **Not a Discord bot.** No Discord MCP tools. A Discord webhook URL in
  `policy.yaml` is the maximum surface area — one outbound POST, opt-in.
- **Not a daemon supervisor.** `rea serve` is started by Claude Code via
  `.mcp.json`. Claude Code owns the lifecycle. There is no `rea start`,
  no `rea stop`, no systemd unit. A short-lived `.rea/serve.pid`
  breadcrumb is written at startup so `rea status` can detect a live
  gateway — it is removed on graceful shutdown and never used for
  locking or lifecycle management. A per-session `.rea/serve.state.json`
  snapshot accompanies it for live per-downstream introspection.
- **Not a hosted service.** There is no REA Cloud, no SaaS tier, no
  multi-token workstreams, no workload isolation platform.
- **Not a 70-agent roster.** 10 curated agents ship in the package. Four
  profiles layer additional specialists on top. No kitchen sink.

The non-goals are the product. Every "but what if we just added X" belongs
in a separate package.

## Quick start

### 1. Write a policy

`.rea/policy.yaml`:

```yaml
version: "1"
profile: "bst-internal"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
blocked_paths:
  - ".env"
  - ".env.*"
  - "secrets/**"
block_ai_attribution: true
context_protection:
  delegate_to_subagent:
    - "pnpm run preflight"
    - "pnpm run test"
    - "pnpm run build"
  max_bash_output_lines: 100
notification_channel: "" # optional Discord webhook
```

`autonomy_level` can be raised up to `max_autonomy_level` and no further.
The loader rejects the file at parse time if `autonomy_level` exceeds the
ceiling. The ceiling is set by the human operator and never by an agent.

### 2. Freeze when you need to stop everything

```bash
rea freeze --reason "incident triage; investigate unexpected .env write"
```

`rea freeze` writes `.rea/HALT`. Every subsequent tool call is denied
until an operator runs:

```bash
rea unfreeze --reason "false alarm — resolved"
```

Both calls produce audit entries. The middleware never clears HALT on
its own.

### 3. Verify the install

```bash
rea doctor
```

`rea doctor` checks `.rea/` directory presence, policy parse, registry
parse, curated-agent presence, hook coverage, `.claude/settings.json`
wiring, commit-msg / pre-push git hooks, Codex CLI + agent availability
(when `codex_required: true`), and the TOFU fingerprint store. It
returns a pass/fail summary with specific remediation hints. In non-git
directories (knowledge repos, docs-only projects) the commit-msg and
pre-push checks are skipped cleanly — REA governs policy and injection
detection there, not pushes. Audit hash-chain integrity is verified by
a separate command — `rea check` (on-disk tail) or the full replay
verifier — not by `rea doctor`.

### 4. Watch the running gateway

```bash
rea status              # human-readable summary
rea status --json       # JSON — pipe to jq
```

`rea status` is the live-process view. It reads the pidfile written by
`rea serve`, verifies the pid is alive, and surfaces the session id,
policy summary (profile, autonomy, HALT state), audit stats (lines,
last timestamp, whether the tail record's hash looks well-formed), and
— as of 0.9.0 — a **per-downstream live block** sourced from
`.rea/serve.state.json`. Each downstream entry includes:

| Field                       | Type                                 | Meaning                                                         |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `name`                      | string                               | Registry server name                                            |
| `connected`                 | boolean                              | MCP client currently holds an open stdio transport              |
| `healthy`                   | boolean                              | Gateway considers the server safe to route calls to             |
| `circuit_state`             | `closed` \| `open` \| `half-open`    | Current breaker position                                        |
| `retry_at`                  | ISO timestamp \| `null`              | Next allowed half-open probe, when `open`                       |
| `last_error`                | string \| `null`                     | Bounded, redacted diagnostic from the most recent failure       |
| `tools_count`               | integer \| `null`                    | Tool count from the last successful `tools/list`                |
| `open_transitions`          | integer                              | Cumulative circuit-open events in this session                  |
| `session_blocker_emitted`   | boolean                              | Whether `SESSION_BLOCKER` has fired for this server yet         |

`.rea/serve.state.json` is the authoritative live source — it is written
atomically (temp+rename) on every circuit transition and supervisor
event, debounced through a 250 ms trailing timer so a flap storm can't
spam disk. State files written by a pre-0.9.0 gateway degrade gracefully:
`downstreams` surfaces as `null` with a hint to upgrade.

Use `rea check` when you want the pure on-disk view (policy + HALT +
tail audit) without probing for a live process.

### 5. Optional Prometheus `/metrics` endpoint

`rea serve` can expose a loopback-only Prometheus endpoint when the
`REA_METRICS_PORT` environment variable is set:

```bash
REA_METRICS_PORT=9464 rea serve
# in another shell
curl http://127.0.0.1:9464/metrics
```

Metrics exposed: per-downstream call and error counters, in-flight
gauge, audit-lines-appended counter, circuit-breaker state gauge, and a
seconds-since-last-HALT-check gauge. The listener binds to `127.0.0.1`
only, serves only `GET /metrics` (everything else is a fixed-body 404),
and never binds by default — "no silent listeners" is a design rule.
There is no TLS; scrape through SSH/a reverse proxy if you need
cross-host access.

Set `REA_LOG_LEVEL=debug` for verbose gateway logs; the default is
`info`. Records are JSON lines on a non-TTY stderr and pretty-printed
on an interactive terminal.

### 6. Ask the gateway how it's doing — `__rea__health`

The gateway advertises a single built-in tool, `__rea__health`, in
every `listTools` response regardless of downstream state. Calling it
returns a snapshot of gateway version, uptime, HALT state, policy
summary, and per-downstream health. The handler **short-circuits the
middleware chain** — it is callable under HALT and at any autonomy
level — because it is the tool an operator reaches for when everything
else is frozen. Every invocation still writes an audit record.

The wire response is **sanitized by default**: `halt_reason` and
`downstreams[].last_error` surface as `null`. Full diagnostic detail
lives in the audit record's metadata (`halt_reason`,
`downstream_errors[]`) — local disk, hash-chained, not
LLM-reachable — which is the right sink for trusted-operator text.

Operators who genuinely need error strings on the MCP wire can opt in:

```yaml
# .rea/policy.yaml
gateway:
  health:
    expose_diagnostics: true
```

Opt-in mode still runs the full sanitizer pass: `redactSecrets` replaces
known secret patterns with `[REDACTED:*]`, `classifyInjection` replaces
any non-`clean` diagnostic string (verdicts `suspicious` or
`likely_injection`) with the exported `INJECTION_REDACTED_PLACEHOLDER`
token — the literal string `<redacted: suspected injection>` — and
oversize values are bounded before scanning so an adversarial downstream
can't DoS the tool with a multi-megabyte error.

## Architecture

### Middleware chain

Every native MCP tool call AND every proxied downstream call flows through
one chain. The order matters — each layer fails closed.

```
tool call
    │
    ▼
┌───────────────────────────────────────────────────┐
│ audit.enter        — hash-chained record start    │
│ kill-switch        — deny if .rea/HALT exists     │
│ tier               — read/write/destructive class │
│ policy             — autonomy gate (L0–L3)        │
│ blocked-paths      — .rea/ + operator paths       │
│ rate-limit         — token bucket per server      │
│ circuit-breaker    — trip on downstream failure   │
│ redact (args)      — secrets in arguments         │
│                                                   │
│ ==== EXECUTE ====                                 │
│                                                   │
│ result-size-cap    — bounded response             │
│ redact (result)    — secrets in result            │
│ injection          — prompt-injection in result   │
│ audit.exit         — hash-chained record close    │
└───────────────────────────────────────────────────┘
    │
    ▼
result
```

`.rea/` is hardcoded as an always-blocked path. It cannot be unblocked
from policy. Policy is re-read on every invocation — any edit to
`policy.yaml` takes effect on the next tool call.

The `__rea__health` meta-tool is the one documented exception: it
short-circuits the chain (see §6 above) and writes an audit record from
the short-circuit handler itself.

### Gateway supervisor

Downstream MCP servers run as child processes over stdio. The
`DownstreamConnection` wrapper wires the SDK `StdioClientTransport`'s
`onclose` + `onerror` callbacks, so an unexpected child death — OS
OOM-kill, unhandled exception in the child, stdio pipe error outside a
caller-initiated close — is detected **eagerly**: the client and
transport are nulled before the next `callTool` tries to use them. The
following call forces a genuine reconnect rather than invoking through a
stale handle.

"Not connected" errors from the SDK (the in-flight fallback) are
promoted to the same respawn path with the same eager invalidation.
A 30-second flapping guard refuses a second reconnect that lands too
quickly after the previous one — the child is clearly unhealthy and the
circuit breaker is a better place to handle it.

`SessionBlockerTracker` subscribes to circuit-breaker
`onStateChange` events and counts circuit-open transitions per
`(session_id, server_name)`. Once the threshold (default: 3) is
crossed, exactly one `SESSION_BLOCKER` audit record is appended and a
LOUD structured log line is emitted — subsequent opens do not re-fire
until recovery (a transition to `closed`) re-arms the emit. A new
session (new `rea serve` process) drops every counter and starts fresh.

### Live state

`.rea/serve.state.json` is the on-disk live snapshot. It is written
once at boot and again on every circuit transition or supervisor event,
debounced through a 250 ms trailing timer and flushed atomically via
temp-file + rename. The snapshot carries a `session_id` (boot-time
ownership key) and `owner_pid`; a newly-started `rea serve` whose
predecessor crashed without cleanup can detect the abandoned file and
take over ownership rather than stalling forever. `rea status` is a
read-only consumer of this file.

### Downstream environment safety

`rea serve` does **not** forward `process.env` wholesale to downstream
children. Each child gets:

1. A fixed allowlist of neutral OS vars (`PATH`, `HOME`, `TZ`,
   `NODE_OPTIONS`, …).
2. Any names opted into via `registry.yaml#servers[].env_passthrough` —
   the schema refuses secret-looking names (`*_TOKEN`, `*_KEY`,
   `*_SECRET`, …), so secrets must be named explicitly.
3. Values from the registry's `env:` mapping, which may contain
   `${VAR}` placeholders resolved against the host environment
   (0.3.0). Secret-looking values are redacted in logs by default.
   A `${VAR}` whose host variable is unset is treated as fatal — the
   downstream is marked unhealthy rather than handed an unresolved
   placeholder.

### Hook layer

Hooks are shell scripts. 14 ship in the package; 12 are wired into
the default `.claude/settings.json` and run at Claude Code
tool-invocation time, independently of the gateway. The remaining
two (`commit-review-gate.sh` and `push-review-gate-git.sh`) ship
ready-to-wire but are not registered by default — see "What REA is"
above and the inventory table at the end of this section for the full
picture. Both layers (hooks and the gateway middleware) fail closed.
Bypassing one does not disable the other.

Every hook uses `set -euo pipefail` (or `set -uo pipefail` for the
ones that process stdin JSON) and performs a HALT check near the top.
The review-gate hooks (`push-review-gate.sh`, `push-review-gate-git.sh`,
`commit-review-gate.sh`) additionally anchor `REA_ROOT` to their own
on-disk location (BUG-012 fix, 0.6.2) — for those hooks,
`CLAUDE_PROJECT_DIR` is accepted only as an advisory signal because it
is caller-controlled. The remaining hooks (e.g. `secret-scanner.sh`,
`settings-protection.sh`, `blocked-paths-enforcer.sh`,
`dangerous-bash-interceptor.sh`) still derive `REA_ROOT` from
`${CLAUDE_PROJECT_DIR:-$(pwd)}`; extending the script-anchor idiom to
those hooks is tracked as an open hardening item. Cross-repo
invocations (running a review-gate hook from a consumer project that
is not the rea install) short-circuit cleanly using
`git --git-common-dir` comparison (0.6.1).

The two push-review adapters that ship in `hooks/` share a single
implementation core at `hooks/_lib/push-review-core.sh` (0.7.0 BUG-008
cleanup) so a fix lands in one place: `push-review-gate.sh` consumes
Claude-Code PreToolUse JSON and is what `rea init` copies to
`.claude/hooks/`; `push-review-gate-git.sh` consumes git's native
`.husky/pre-push` refspec lines and is shipped for consumers who wire
a wrapper-based `.husky/pre-push` that execs it directly. The default
`rea init` installer does NOT currently emit that wrapper — it writes
a standalone inline gate body as `.husky/pre-push` (source of truth:
`src/cli/install/pre-push.ts`). The native-git adapter and the
inline installer currently implement the same protected-path logic
separately; unifying the husky installer on the adapter is tracked as
follow-up hardening. `commit-review-gate.sh` is a standalone Claude
`PreToolUse: Bash` hook that matches `git commit`; it does not source
the push-review core.

### Slash commands

Five commands ship in the package and are copied into `.claude/commands/`
during `rea init`.

### Agent roster

Ten curated agents ship in the package: `rea-orchestrator`, `code-reviewer`,
`codex-adversarial`, `security-engineer`, `accessibility-engineer`,
`typescript-specialist`, `frontend-specialist`, `backend-engineer`,
`qa-engineer`, `technical-writer`. Profiles
(`client-engagement`, `bst-internal`, `bst-internal-no-codex`,
`lit-wc`, `open-source`, `open-source-no-codex`, `minimal`) layer
additional specialists on top. The `-no-codex` variants match their
parents but default `review.codex_required: false` so teams without a
Codex CLI on the bench get a first-class opt-out rather than relying on
`REA_SKIP_CODEX_REVIEW`.

The orchestrator is the single entry point for non-trivial tasks. The
CLAUDE.md template installed by `rea init` instructs the host agent:
_"For any non-trivial task, delegate to the `rea-orchestrator` agent
FIRST."_

## The Plan / Build / Review loop

Codex is a first-class part of REA. It is not a bolt-on. The BST
engineering process bakes adversarial review into the default flow, and
REA ships it out of the box.

| Phase | Primary model | Codex role | Governance |
| --- | --- | --- | --- |
| Plan | Claude Opus | — | Full middleware chain |
| Pre-implementation review | — | `/codex:review` — review the PLAN before code | Audited |
| Build | Claude Opus | — | Full middleware chain |
| Adversarial review | — | `/codex:adversarial-review` on the diff (independent perspective) | Audited, redacted, kill-switched |
| Pre-merge gate | — | `/codex:adversarial-review` re-run; recorded in audit.jsonl | Required status check (recommended) |

Three things make this work:

1. The **`codex-adversarial` agent** in the curated roster wraps
   `/codex:adversarial-review`. The orchestrator delegates to it after
   any non-trivial change.
2. The **`/codex-review` slash command** is one of the five shipped
   commands. It produces an audit entry including the request summary,
   response summary, and pass/fail signal.
3. The **`push-review-gate.sh` hook** blocks (exit 2) every protected-path
   push that does not carry a matching `codex.review` audit entry for the
   pushed `head_sha` with a `verdict` of `pass` or `concerns`. The only
   other way through the protected-path branch is an active Codex-only
   waiver (`REA_SKIP_CODEX_REVIEW=<reason>`, 0.8.0 narrowing). For
   **non-protected-path** pushes the gate runs a separate review-cache
   lookup — this is where the cache predicate and pushed-ref key
   hardening live. The cache-hit predicate requires
   `.hit == true and .result == "pass"` (0.8.0 hardening — a cached
   `fail` verdict no longer satisfies the gate), and the cache key is
   derived from the **pushed source ref** (from pre-push stdin) rather
   than the checkout branch, so `git push origin hotfix:main` from a
   `feature` checkout correctly looks up the `hotfix` cache entry.

### Codex-only waiver semantics (0.8.0)

Through 0.7.0, `REA_SKIP_CODEX_REVIEW=<reason>` short-circuited the
**entire** push-review gate — operators reached for it to silence a
transient Codex outage and accidentally bypassed HALT, the cross-repo
guard, and the general push-review gate. 0.8.0 narrows it to what the
name implies: the waiver satisfies **only** the protected-path Codex
audit requirement. HALT, cross-repo guard, ref-resolution failures, and
push-review-cache misses still block. The skip audit record is still
named `codex.review.skipped` and still fails the `codex.review` jq
predicate — skipping a review is not a review.

For the previous whole-gate bypass, use `REA_SKIP_PUSH_REVIEW=<reason>`
(unchanged, 0.5.0). It writes `push.review.skipped` with an
`os_identity` sub-object (uid, whoami, hostname, pid, ppid, tty, ci)
so auditors can distinguish a real operator from a forged git-config
actor, and refuses on CI runners unless the policy opts in via
`review.allow_skip_in_ci: true`.

Codex responses are treated as untrusted input. They flow through the
`redact` and `injection` middleware on return — same treatment as any
other downstream tool result. Codex never receives `.rea/policy.yaml`
content in its prompts; Codex reviews diffs, not policy.

If Codex is not installed, `rea doctor` warns with a one-line install
hint. REA does not require Codex to function — the `bst-internal-no-codex`
and `open-source-no-codex` profiles disable the requirement entirely,
and `ClaudeSelfReviewer` is the in-process fallback (tagged
`degraded: true` in the audit record so self-review is visible and
countable).

## Agent push workflow — satisfying the push-review gate

When `git push` is blocked by `push-review-gate.sh` the gate prints
remediation steps. This section is the canonical one-command flow the
steps reduce to. Agents should copy-paste this verbatim; humans should
expect agents to.

### 1. Run the adversarial review

```bash
# From an interactive Claude Code session:
/codex-review
```

This invokes the `codex-adversarial` agent, which records a
`codex.review` audit entry with `verdict: pass | concerns | blocking |
error` and a `finding_count`. The push gate looks up that entry by
`head_sha + verdict ∈ {pass, concerns}`.

### 2. Record-and-cache in one CLI call

If you already have a review verdict (from `/codex-review`, or from a
manual Codex run, or from an offline review) emit the audit record AND
update the push-review cache with a single command:

```bash
rea audit record codex-review \
  --head-sha "$(git rev-parse HEAD)" \
  --branch   "$(git rev-parse --abbrev-ref HEAD)" \
  --target   main \
  --verdict  pass \
  --finding-count 0 \
  --summary  "no findings" \
  --also-set-cache
```

`--also-set-cache` writes both `.rea/audit.jsonl` and
`.rea/review-cache.jsonl` in the same invocation (two sequential
appends, not a two-phase commit — but close enough in practice that the
push-gate lookup cannot see the audit record without the cache entry
unless a crash lands between them). Without it, the audit record lands
but the cache stays cold — and the next `git push` pays for a re-review
even though the audit trail already shows the review happened.
`--also-set-cache` is what the gate's remediation text should be reduced
to.

Verdict mapping for the cache leg:

| `--verdict`  | Cache `result` | Cache `reason` |
| ------------ | -------------- | -------------- |
| `pass`       | `pass`         | — (omitted) |
| `concerns`   | `pass`         | `codex:concerns` |
| `blocking`   | `fail`         | `codex:blocking` |
| `error`      | `fail`         | `codex:error` |

### 3. Push

```bash
git push
```

The gate hits the cache, sees `{"hit":true,"result":"pass"}`, and exits
0 on the first attempt. No `!`-bash escapes, no manual audit writing,
no separate `rea cache set` invocation.

### SDK alternative

When embedding the flow in a TypeScript tool instead of shelling out,
import the public audit helper:

```ts
import {
  appendAuditRecord,
  CODEX_REVIEW_SERVER_NAME,
  CODEX_REVIEW_TOOL_NAME,
  InvocationStatus,
  Tier,
} from '@bookedsolid/rea/audit';

await appendAuditRecord(process.cwd(), {
  tool_name: CODEX_REVIEW_TOOL_NAME,
  server_name: CODEX_REVIEW_SERVER_NAME,
  tier: Tier.Read,
  status: InvocationStatus.Allowed,
  metadata: {
    head_sha: headSha,
    target: 'main',
    finding_count: 0,
    verdict: 'pass',
  },
});
```

The CLI wraps exactly this — use the CLI unless the host is already a
TypeScript process that wants to avoid the subprocess roundtrip.

### Agent autonomy self-consistency

At autonomy `L1`, `rea cache check`, `rea audit record codex-review`,
`rea doctor`, and `rea status` are classified **Read tier** — they
cannot be denied by REA's own middleware. `rea cache set` is Write
tier and is still allowed at L1. `rea freeze` is Destructive tier and
is denied at L1 (deny-reason includes the subcommand, e.g.
`Bash (rea freeze)`, not just `Bash`).

## Hooks

Fourteen hooks. Each does one thing.

| Hook | Event | One-line purpose |
| --- | --- | --- |
| `dangerous-bash-interceptor` | PreToolUse: Bash | Block categories of destructive shell commands |
| `env-file-protection` | PreToolUse: Bash | Block reads of `.env*` files |
| `dependency-audit-gate` | PreToolUse: Bash | Verify packages exist on the registry before install |
| `commit-review-gate` | PreToolUse: Bash | Intercept `git commit`; require review on non-trivial diffs |
| `push-review-gate` | PreToolUse: Bash | Intercept `git push` (Claude-Code-JSON adapter); protected-path + Codex audit |
| `push-review-gate-git` | `.husky/pre-push` | Native git adapter around the same core |
| `attribution-advisory` | PreToolUse: Bash | Block commits / PRs containing AI attribution markers |
| `pr-issue-link-gate` | PreToolUse: Bash | Advisory warn when `gh pr create` has no linked issue |
| `security-disclosure-gate` | PreToolUse: Bash | Route security-keyword `gh issue create` to private disclosure |
| `secret-scanner` | PreToolUse: Write\|Edit | Scan file writes for credential patterns |
| `settings-protection` | PreToolUse: Write\|Edit | Block agent writes to `.claude/settings.json`, hook dirs, policy |
| `blocked-paths-enforcer` | PreToolUse: Write\|Edit | Enforce `blocked_paths` from policy |
| `changeset-security-gate` | PreToolUse: Write\|Edit | Guard changesets against GHSA leaks and malformed frontmatter |
| `architecture-review-gate` | PostToolUse: Write\|Edit | Flag edits crossing architectural boundaries (advisory) |

## Slash commands

| Command | Purpose |
| --- | --- |
| `/rea` | Session status — autonomy level, HALT state, last audit entries, next action |
| `/review` | Invoke the `code-reviewer` agent on current changes |
| `/codex-review` | Invoke the `codex-adversarial` agent → `/codex:adversarial-review` |
| `/freeze` | Prompt for a reason and write `.rea/HALT` |
| `/halt-check` | Verify every middleware and hook respects HALT |

## Policy file reference

`.rea/policy.yaml` fields. The schema is zod-strict — unknown fields are
rejected, not ignored.

| Field | Type | Purpose |
| --- | --- | --- |
| `version` | string, `"1"` | Schema version; only `"1"` accepted in the current major |
| `profile` | string | Profile name from `profiles/` (e.g. `bst-internal`) |
| `autonomy_level` | `L0`\|`L1`\|`L2`\|`L3` | Current autonomy. `L0` = read-only; `L3` = full tool access |
| `max_autonomy_level` | `L0`\|`L1`\|`L2`\|`L3` | Hard ceiling. `autonomy_level` cannot exceed this |
| `promotion_requires_human_approval` | boolean | Require operator confirmation to raise autonomy. Default `true` |
| `blocked_paths` | string[] | Glob patterns. `.rea/` is always blocked regardless of this list |
| `block_ai_attribution` | boolean | Enforce no-AI-attribution in commits and PR bodies |
| `context_protection.delegate_to_subagent` | string[] | Commands that must run in a subagent context to preserve the parent's context window |
| `context_protection.max_bash_output_lines` | number | Truncate long bash output at this line count |
| `notification_channel` | string | Optional Discord webhook URL. Empty string = no notifications |
| `review.codex_required` | boolean | When `false`, protected-path pushes don't require a Codex audit (first-class no-Codex mode). Default `true` |
| `review.cache_max_age_seconds` | number | TTL for entries in `.rea/review-cache.jsonl`. Default 3600 |
| `review.allow_skip_in_ci` | boolean | When `true`, `REA_SKIP_PUSH_REVIEW` is accepted on CI runners. Default `false` |
| `injection.suspicious_blocks_writes` | boolean | `bst-internal` posture — `suspicious` verdict on a write/destructive tool denies instead of warning. Default `false` |
| `redact.patterns[]` | string[] | User-supplied secret patterns; vetted via `safe-regex` at load |
| `redact.match_timeout_ms` | number | Per-call regex budget. Default 100 |
| `gateway.health.expose_diagnostics` | boolean | When `true`, `__rea__health` emits redacted+classified diagnostic strings on the wire. Default `false` (null) |

`autonomy_level > max_autonomy_level` is rejected at parse time. Setting
`promotion_requires_human_approval: false` requires the CLI flag
`--i-understand-the-risks`.

## Migration from `@bookedsolid/reagent`

```bash
npx @bookedsolid/rea init --from-reagent
```

`--from-reagent`:

- Reads `.reagent/policy.yaml` and translates field-for-field into
  `.rea/policy.yaml`. Field names are identical, so the translation is a
  rename.
- Moves `.reagent/audit.jsonl` to `.rea/audit.jsonl` and verifies the
  hash chain.
- Un-wires dropped hooks (Obsidian, PM-layer, account) from
  `.claude/settings.json`.
- Replaces `reagent` slash commands and agents with the REA equivalents.
- Leaves `.reagent/` in place; you delete it manually after verifying
  `rea doctor` passes and a dogfood run completes.

See [MIGRATION-0.5.0.md](./MIGRATION-0.5.0.md) for the BUG-008 / BUG-009
/ BUG-010 coordinated fix window. Between 0.5.0 and 0.9.0, the breaking
semantic change worth calling out is 0.8.0's narrowing of
`REA_SKIP_CODEX_REVIEW` to a Codex-only waiver — see the CHANGELOG
entry for the migration steps.

## Security

- [SECURITY.md](./SECURITY.md) — disclosure policy, supported versions,
  and scope. Do not report vulnerabilities via public GitHub issues.
- [THREAT_MODEL.md](./THREAT_MODEL.md) — attack surface, mitigations,
  residual risks. This is the contract REA holds itself to.

Short version: gateway and hook layers operate independently. Both fail
closed. `.rea/` is always blocked. Audit is hash-chained. Policy is
re-read on every invocation. npm publish uses OIDC provenance, not
long-lived tokens.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Short version:

- DCO sign-off required on every commit (`git commit -s`). CI rejects
  unsigned commits.
- No AI attribution in commit messages, PR bodies, or code. The
  commit-msg hook enforces this.
- Conventional commits, TypeScript strict, ESLint zero-warnings,
  Prettier, vitest.
- Security-sensitive paths (`src/gateway/middleware/**`, `src/policy/**`,
  `hooks/**`, `.github/workflows/**`) require explicit maintainer
  review and a threat-model update in the same PR.

## License

[MIT](./LICENSE)
