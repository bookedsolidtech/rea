# REA

**Agentic governance layer for Claude Code — policy enforcement, hook-based safety gates, audit logging, and Codex-integrated adversarial review.**

[![npm version](https://img.shields.io/badge/npm-pending-lightgrey)](https://www.npmjs.com/package/@bookedsolid/rea)
[![CI](https://img.shields.io/badge/ci-pending-lightgrey)](https://github.com/bookedsolidtech/rea/actions)
[![provenance](https://img.shields.io/badge/npm%20provenance-pending-lightgrey)](https://docs.npmjs.com/generating-provenance-statements)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![DCO](https://img.shields.io/badge/DCO-required-green)](https://developercertificate.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![SafeSkill 20/100](https://img.shields.io/badge/SafeSkill-20%2F100_Blocked-red)](https://safeskill.dev/scan/bookedsolidtech-rea)

> Status: 0.0.x, pre-release. Badges are placeholders until the first publish.

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

1. A **hook layer** — 11 shell scripts wired into Claude Code's `PreToolUse`
   and `PostToolUse` events. Hooks enforce secret scanning, dangerous-command
   interception, blocked-path protection, settings protection, attribution
   rejection, and commit/push review gates.
2. A **gateway layer** — an MCP server (`rea serve`) that proxies downstream
   MCP servers through a middleware chain. Every tool call — native or
   proxied — is classified, policy-checked, redacted, audited, and
   size-capped before it executes.
3. A **policy runtime** — `.rea/policy.yaml` with strict zod-validated
   schema. Defines autonomy level, a hard ceiling (`max_autonomy_level`),
   blocked paths, attribution rules, context protection, and optional
   Discord notification webhook.
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
  locking or lifecycle management.
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

`rea doctor` checks hook coverage, policy parse, husky commit-msg hook
install, `.mcp.json` gateway wiring, Codex plugin availability, and the
integrity of the audit hash chain. It returns a pass/fail summary with
specific remediation hints.

### 4. Watch the running gateway

```bash
rea status              # human-readable summary
rea status --json       # JSON — pipe to jq
```

`rea status` is the live-process view. It reads the pidfile written by
`rea serve`, verifies the pid is alive, and surfaces the session id,
policy summary (profile, autonomy, HALT state), and audit stats (lines,
last timestamp, whether the tail record's hash looks well-formed). Use
`rea check` when you want the pure on-disk view without probing for a
live process.

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
│ injection          — prompt-injection heuristics  │
│                                                   │
│ ==== EXECUTE ====                                 │
│                                                   │
│ redact (result)    — secrets in result            │
│ result-size-cap    — bounded response             │
│ audit.exit         — hash-chained record close    │
└───────────────────────────────────────────────────┘
    │
    ▼
result
```

`.rea/` is hardcoded as an always-blocked path. It cannot be unblocked
from policy. Policy is re-read on every invocation — any edit to
`policy.yaml` takes effect on the next tool call.

### Hook layer

Hooks are shell scripts wired into `.claude/settings.json`. They run at
Claude Code tool-invocation time, independently of the gateway. Both
layers fail closed. Bypassing one does not disable the other.

Every hook sources `hooks/_lib/halt-check.sh` and `hooks/_lib/policy-read.sh`
at the top of the script. Every hook uses `set -euo pipefail`.

### Slash commands

Five commands ship in the package and are copied into `.claude/commands/`
during `rea init`.

### Agent roster

Ten curated agents ship in the package: `rea-orchestrator`, `code-reviewer`,
`codex-adversarial`, `security-engineer`, `accessibility-engineer`,
`typescript-specialist`, `frontend-specialist`, `backend-engineer`,
`qa-engineer`, `technical-writer`. Four profiles
(`client-engagement`, `bst-internal`, `lit-wc`, `open-source`) layer
additional specialists on top.

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
3. The **`push-review-gate.sh` hook** checks for a recent `/codex-review`
   audit entry on the current branch and warns (does not block) if none
   is present.

Codex responses are treated as untrusted input. They flow through the
`redact` and `injection` middleware on return — same treatment as any
other downstream tool result. Codex never receives `.rea/policy.yaml`
content in its prompts; Codex reviews diffs, not policy.

If Codex is not installed, `rea doctor` warns with a one-line install
hint. REA does not require Codex to function, but the default workflow
assumes it.

## Hooks

Eleven hooks, down from reagent's 26. Each does one thing.

| Hook | Event | One-line purpose |
| --- | --- | --- |
| `dangerous-bash-interceptor` | PreToolUse: Bash | Block categories of destructive shell commands |
| `env-file-protection` | PreToolUse: Bash | Block reads of `.env*` files |
| `dependency-audit-gate` | PreToolUse: Bash | Run `npm audit`; block on high/critical |
| `commit-review-gate` | PreToolUse: Bash | Intercept `git commit`; require review on non-trivial diffs |
| `push-review-gate` | PreToolUse: Bash | Intercept `git push`; warn if no recent `/codex-review` |
| `attribution-advisory` | PreToolUse: Bash | Block commits containing AI attribution markers |
| `secret-scanner` | PreToolUse: Write\|Edit | Scan file writes for credential patterns |
| `settings-protection` | PreToolUse: Write\|Edit | Block agent writes to `.claude/settings.json` |
| `blocked-paths-enforcer` | PreToolUse: Write\|Edit | Enforce `blocked_paths` from policy |
| `changeset-security-gate` | PreToolUse: Write\|Edit | Require changeset entry on security-relevant changes |
| `architecture-review-gate` | PostToolUse: Write\|Edit | Flag edits crossing architectural boundaries |

A twelfth hook, `security-disclosure-gate`, intercepts `gh issue create`
commands containing security-sensitive keywords and redirects to private
disclosure. It is installed as part of the Bash PreToolUse set.

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
| `version` | string, `"1"` | Schema version; only `"1"` accepted in 0.1.x |
| `profile` | string | Profile name from `profiles/` (e.g. `bst-internal`) |
| `autonomy_level` | `L0`\|`L1`\|`L2`\|`L3` | Current autonomy. `L0` = read-only; `L3` = full tool access |
| `max_autonomy_level` | `L0`\|`L1`\|`L2`\|`L3` | Hard ceiling. `autonomy_level` cannot exceed this |
| `promotion_requires_human_approval` | boolean | Require operator confirmation to raise autonomy. Default `true` |
| `blocked_paths` | string[] | Glob patterns. `.rea/` is always blocked regardless of this list |
| `block_ai_attribution` | boolean | Enforce no-AI-attribution in commits and PR bodies |
| `context_protection.delegate_to_subagent` | string[] | Commands that must run in a subagent context to preserve the parent's context window |
| `context_protection.max_bash_output_lines` | number | Truncate long bash output at this line count |
| `notification_channel` | string | Optional Discord webhook URL. Empty string = no notifications |

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

Reagent will be deprecated via `npm deprecate` within seven days of
REA 0.1.0. The deprecation notice points users here.

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
