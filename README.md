# REA

**Agentic governance layer for Claude Code — policy enforcement, hook-based safety gates, audit logging, and a stateless pre-push Codex review gate.**

[![npm version](https://img.shields.io/npm/v/%40bookedsolid%2Frea?color=cb3837&label=npm)](https://www.npmjs.com/package/@bookedsolid/rea)
[![CI](https://github.com/bookedsolidtech/rea/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bookedsolidtech/rea/actions/workflows/ci.yml)
[![npm provenance](https://img.shields.io/badge/npm%20provenance-attested-blue?logo=npm)](https://docs.npmjs.com/generating-provenance-statements)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![DCO](https://img.shields.io/badge/DCO-required-green)](https://developercertificate.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

> Status: `0.11.0` — published to npm with SLSA v1 provenance. See
> [CHANGELOG.md](./CHANGELOG.md) for the per-release history.

REA is a single npm package that gates and audits agentic tool calls made by
Claude Code — shell commands, filesystem writes, and MCP tool invocations —
against an operator-defined policy file. It ships an MCP middleware gateway,
a set of hook scripts, a pre-push Codex review gate, a hash-chained audit
log, and a hard kill-switch. Every layer fails closed.

**What changed in 0.11.0.** Through 0.10.x the push-review gate asked "has a
qualifying Codex receipt been recorded for this HEAD SHA?" and consulted a
`.rea/review-cache.jsonl` + audit-record lookup to decide. Agents spent a
meaningful fraction of every push cycle fabricating attestations with `rea
cache set` and `rea audit record codex-review --also-set-cache`, and the
bash core around the gate grew to ~1,250 lines. 0.11.0 deletes that stack
and replaces it with a single subcommand — `rea hook push-gate` — that
**runs Codex on every push**, parses the verdict from the streamed review
output, writes the findings to `.rea/last-review.json`, and blocks exit
code `2` on `[P1]` or (by default) `[P2]` findings. Readers landing on
0.9/0.10-era docs should treat the "record-and-cache" flow as gone — see
the [migration section](#migration-from-010x) below.

---

## Table of contents

- [Quickstart](#quickstart)
- [What REA is](#what-rea-is)
- [What REA is NOT](#what-rea-is-not)
- [The pre-push Codex gate](#the-pre-push-codex-gate)
- [MCP gateway](#mcp-gateway)
- [Policy file](#policy-file)
- [Hooks shipped](#hooks-shipped)
- [Slash commands](#slash-commands)
- [Curated agents](#curated-agents)
- [CLI reference](#cli-reference)
- [Migration from 0.10.x](#migration-from-010x)
- [Contributor quality gates](#contributor-quality-gates)
- [Threat model and security](#threat-model-and-security)
- [Non-goals](#non-goals)
- [License and contributing](#license-and-contributing)

---

## Quickstart

```bash
npx @bookedsolid/rea init
```

The `init` wizard detects your project, writes `.rea/policy.yaml`, copies
curated hooks and slash commands into `.claude/`, wires `.mcp.json` to run
`rea serve` as a governance gateway, installs `.husky/commit-msg` and
`.husky/pre-push` hooks, and appends a managed fragment to `CLAUDE.md`. Run
it non-interactively with `-y`:

```bash
npx @bookedsolid/rea init -y --profile bst-internal
```

Node 22+ and pnpm 9.12+ are required. The package is published with npm
provenance (SLSA v1) from the `main` branch via GitHub Actions OIDC.

**Your first push.** After a feature commit, `git push` will:

1. `.husky/pre-push` checks `.rea/HALT` and delegates to `rea hook push-gate`.
2. `rea hook push-gate` loads `.rea/policy.yaml`, resolves a base ref, and
   shells out to `codex exec review --base <ref> --json --ephemeral`.
3. Codex streams JSONL events back; the gate parses `[P1]`/`[P2]`/`[P3]`
   findings out of the `agent_message` text.
4. A severity-sorted summary is printed to stderr; full findings with file
   and line detail are written atomically to `.rea/last-review.json`.
5. An audit record (`rea.push_gate.reviewed`) is appended to
   `.rea/audit.jsonl`.
6. Exit code is `0` (pass), `1` (HALT), or `2` (blocked by verdict or
   Codex error).

On a blocking verdict the push fails; the in-session Claude agent reads the
stderr summary and the `.rea/last-review.json` payload, fixes the issues,
commits, and pushes again. No cache, no receipt to fabricate.

Verify the install:

```bash
rea doctor
```

Freeze everything if something unexpected happens:

```bash
rea freeze --reason "incident triage; investigate unexpected .env write"
# later
rea unfreeze
```

---

## What REA is

REA is a governance layer for Claude Code. It ships four things.

### 1. A policy runtime

`.rea/policy.yaml`, validated by a strict zod schema — unknown fields are
**rejected**, not ignored. The policy defines:

- `autonomy_level` (L0–L3) and a hard `max_autonomy_level` ceiling
- `blocked_paths` (globs; `.rea/` is always blocked regardless)
- `block_ai_attribution` — enforced by the commit-msg hook
- `review.codex_required` — whether the pre-push gate runs Codex at all
- `review.concerns_blocks` — whether `[P2]` verdicts halt the push
- `review.timeout_ms` — hard cap on the Codex subprocess
- Redaction patterns, injection tuning, audit rotation, and MCP gateway knobs

Policy is re-read on every middleware invocation and every hook run. Editing
`.rea/policy.yaml` takes effect on the next tool call — no restart, no
cache invalidation.

### 2. A kill switch

`.rea/HALT` is a single file. If it exists, every governed tool call is
denied — the MCP gateway middleware returns an error, the bash hooks `exit
1`, and the pre-push gate returns exit `1` with the reason printed to
stderr. Use `rea freeze --reason "..."` to create it and `rea unfreeze` to
remove it. Both operations write audit records. The middleware never
clears HALT on its own.

HALT is checked before policy in every flow. A corrupted `.rea/policy.yaml`
does not prevent the kill-switch from firing.

### 3. A hook layer

Eleven shell scripts ship in `hooks/` and are copied into `.claude/hooks/`
by `rea init`. All eleven are wired into the default `.claude/settings.json`
and fire on Claude Code's `PreToolUse` / `PostToolUse` events (secret
scanning, dangerous-command interception, blocked-path enforcement,
settings protection, attribution rejection, env-file protection,
disclosure-policy routing, dependency audit, changeset security,
PR-issue-link advisory, architecture advisory). Each hook uses
`set -euo pipefail` (or `set -uo pipefail` for stdin-JSON consumers) and
runs a HALT check near the top. See [Hooks shipped](#hooks-shipped) for
the full inventory.

The hook layer runs independently of the MCP gateway — bypassing one does
not disable the other. That redundancy is intentional.

### 4. An MCP gateway

`rea serve` is an MCP stdio server that proxies downstream MCP servers
declared in `.rea/registry.yaml` through a middleware chain. Every tool
call — native rea tools or proxied downstream tools — is classified,
policy-checked, redacted, audited, and size-capped before it executes. See
[MCP gateway](#mcp-gateway) for the chain ordering and supervisor
behavior.

**Plus** a stateless pre-push Codex review gate (new in 0.11.0) that fires
via `.husky/pre-push` on every `git push` and is covered in the next
section.

REA does one thing: gate and audit agentic tool calls against
operator-defined policy. That is the whole product.

---

## What REA is NOT

These are non-goals. PRs adding any of these will be closed with a pointer
to build a separate package that composes with REA.

- **Not a project manager.** No task CRUD, no GitHub issue sync, no board
  scaffolding.
- **Not an Obsidian integration.** No vault journaling, no note creation,
  no pre/post-compact hooks.
- **Not an account manager.** No `rea account` tree, no Keychain, no OAuth,
  no multi-tenant token vault. Env vars only.
- **Not a Discord bot.** A Discord webhook URL in `policy.yaml` is the
  entire surface area — one outbound POST, opt-in, no MCP tools.
- **Not a daemon supervisor.** `rea serve` is started by Claude Code via
  `.mcp.json`. Claude Code owns the lifecycle. There is no `rea start`,
  no `rea stop`, no systemd unit.
- **Not a hosted service.** No REA Cloud, no SaaS tier, no multi-tenant
  workload isolation.
- **Not a 70-agent roster.** Ten curated agents ship in the package.
  Profiles layer additional specialists.
- **Not a full policy engine.** No OPA/Rego, no CEL, no attribute-based
  access control. A YAML file with a small, fixed schema is the entire
  policy language.
- **Not a CI replacement.** REA gates agent behavior at author time. CI
  still runs lint, typecheck, tests, and build on every PR.
- **Not a secret manager.** REA detects secrets in writes and redacts them
  in audit records; it does not store, rotate, or provision them.

The non-goals are the product.

---

## The pre-push Codex gate

The 0.11.0 gate is stateless. Every `git push` runs Codex on the diff, and
the gate's decision is a function of the review output — not of a cached
receipt or an audit record from a prior run.

### Flow

```
$ git push
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ .husky/pre-push                                         │
│   1. Check .rea/HALT — exit 1 if present                │
│   2. Locate rea binary (node_modules, dist, PATH, npx)  │
│   3. exec rea hook push-gate "$@"                       │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ rea hook push-gate                                      │
│   1. HALT check (again, defense-in-depth)               │
│   2. Load .rea/policy.yaml (zod-validated)              │
│   3. codex_required=false → status:disabled, exit 0     │
│   4. REA_SKIP_PUSH_GATE / REA_SKIP_CODEX_REVIEW=<reason>│
│      → skipped, exit 0 (audit records skip_var)         │
│   5. Parse pre-push stdin refspecs                      │
│   6. Resolve base ref (--base → --last-n-commits N      │
│      → policy.review.last_n_commits → refspec →         │
│      upstream → origin/HEAD → main/master → empty-tree) │
│   7. Empty-diff check → status:empty-diff, exit 0       │
│   8. codex exec review --base <ref> --json --ephemeral  │
│   9. Parse [P1]/[P2]/[P3] findings                      │
│  10. Infer verdict: P1 → blocking; else P2 → concerns;  │
│      else pass                                          │
│  11. Atomic write .rea/last-review.json (redacted)      │
│  12. Render stderr banner                               │
│  13. Append audit record rea.push_gate.reviewed         │
│  14. Exit 0 (pass/disabled/skipped/empty-diff) |        │
│       1 (HALT) | 2 (blocked, timeout, or error)         │
└─────────────────────────────────────────────────────────┘
```

### Verdicts and exit codes

| Verdict | Default behavior | Exit code | Notes |
| --- | --- | --- | --- |
| `pass` | Push proceeds | `0` | No `[P1]` or `[P2]` findings in the review |
| `concerns` | Push blocks (default) | `2` | `[P2]` findings present; override with `REA_ALLOW_CONCERNS=1` or `review.concerns_blocks: false` |
| `blocking` | Push blocks always | `2` | `[P1]` findings present; no override |
| HALT | Push blocks | `1` | `.rea/HALT` is active; run `rea unfreeze` |
| `disabled` | Push proceeds | `0` | `review.codex_required: false` in policy |
| `skipped` | Push proceeds | `0` | `REA_SKIP_PUSH_GATE=<reason>` or `REA_SKIP_CODEX_REVIEW=<reason>` set; audited |
| `empty-diff` | Push proceeds | `0` | No file changes between base and head |
| `error` | Push blocks | `2` | Codex not installed, timeout, subprocess error, malformed policy, head-sha resolution failure |

### The auto-fix loop

Previous gate: pre-run Codex manually, record an attestation with `rea
audit record codex-review --also-set-cache`, push, and hope the
attestation's SHA matches the tip. Agents working at speed ended up
fabricating attestations or running Codex out-of-band and recording the
verdict without anyone actually reading the output. Friction was paid on
every push.

New gate: the gate **is** the review. Codex runs on the same diff the push
is about to send, so the verdict is causally tied to the push. When the
gate blocks:

1. The stderr banner prints the verdict, base ref, head SHA, finding
   count, duration, and up to 20 severity-sorted findings with file:line
   pointers. Because the pre-push hook's stderr reaches Claude as the
   tool output of `Bash(git push)`, the banner is the primary fast-path
   signal for the in-session agent.
2. `.rea/last-review.json` is written atomically with the full findings,
   each carrying `severity`, `title`, `body`, and optional `file`/`line`.
   This file is the source of truth for the auto-fix loop — the stderr
   banner is capped at 20 findings; the JSON is not.
3. Claude reads both, applies fixes, commits (with `-s` and no AI
   attribution), and pushes again. The gate runs Codex fresh on the new
   diff. Repeat until `pass`.

See [CHANGELOG 0.11.0](./CHANGELOG.md) for the longer rationale on why
the cache-attestation design was removed.

### `.rea/last-review.json` schema

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-04-22T18:04:01.123Z",
  "verdict": "blocking",                 // "pass" | "concerns" | "blocking"
  "base_ref": "origin/main",
  "head_sha": "c5ec101…",
  "finding_count": 3,
  "findings": [
    {
      "severity": "P1",                  // "P1" | "P2" | "P3"
      "title": "missing input validation on /auth/callback",
      "file": "src/routes/auth.ts",      // optional
      "line": 42,                        // optional
      "body": "The callback accepts raw state without…"
    }
    // …
  ],
  "review_text": "[P1] missing input validation…\n[P2] …",
  "event_count": 37,
  "duration_seconds": 12.4
}
```

The file is:

- **Atomic.** Written to `.rea/last-review.json.tmp.<pid>-<rand>`, fsynced,
  then `rename(2)`d. Partial writes never surface to readers.
- **Redacted.** Both `findings[].title`/`body` and `review_text` are run
  through the same `SECRET_PATTERNS` list the redact middleware uses. If
  Codex quotes a credential out of the diff it never hits disk in cleartext.
- **Overwritten every push.** There is no rolling history on disk; the
  audit log is the rolling history.
- **Gitignored.** The default `rea init` install adds `/.rea/last-review.json`
  to `.gitignore`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `REA_SKIP_PUSH_GATE=<reason>` | Value-carrying waiver. When set to a non-empty string, the gate short-circuits to `status:skipped` (exit 0) and appends `rea.push_gate.skipped` with the reason and `skip_var: REA_SKIP_PUSH_GATE` as metadata. HALT **always** wins over this — a frozen install still blocks. Use sparingly; every use is audited. |
| `REA_SKIP_CODEX_REVIEW=<reason>` | Equivalent alias for `REA_SKIP_PUSH_GATE`, added in 0.12.0. Same exit behavior; audit metadata records `skip_var: REA_SKIP_CODEX_REVIEW` so operators can grep their audit log to see which variant agents used. When both env vars are set, `REA_SKIP_PUSH_GATE` wins. |
| `REA_ALLOW_CONCERNS=1` | One-push override for `concerns` verdict. Accepts `1`, `true`, or `yes` (case-insensitive). Does **not** override `blocking`. The audit record is stamped `concerns_override: true` so reviewers can see the override was used. |

### Policy knobs

```yaml
# .rea/policy.yaml
review:
  codex_required: true        # default true — run Codex on every push
  concerns_blocks: true       # default true — [P2] halts the push
  timeout_ms: 1800000         # default 1800000 (30 minutes; raised from
                              #   600000 in 0.12.0 — see CHANGELOG)
  last_n_commits: 10          # OPTIONAL — narrow review to the last N commits
                              #   (diff vs HEAD~N). Defaults unset.
```

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `review.codex_required` | boolean | `true` | Master on/off. `false` short-circuits the gate to `status:disabled`, still audited. `-no-codex` profiles set this to `false`. |
| `review.concerns_blocks` | boolean | `true` | When `true`, `[P2]` verdicts return exit 2. Flip to `false` for a looser posture where only `[P1]` halts the push. |
| `review.timeout_ms` | number | `1800000` | Hard cap on the `codex exec review` subprocess in milliseconds. Exceeding it kills the subprocess and returns exit 2 with a `timeout` kind. Positive integer; zero/negative is rejected at load. **Raised from 600000 (10 min) to 1800000 (30 min) in 0.12.0** after operator data showed realistic feature-branch reviews routinely exceeded 10 minutes; pin `timeout_ms: 600000` explicitly to retain the old default. |
| `review.last_n_commits` | number | unset | When set, the gate diffs against `HEAD~N` instead of running the upstream → origin/HEAD → main/master ladder. Useful when a feature branch has accumulated many commits and the full base diff overwhelms the reviewer. Positive integer. CLI `--last-n-commits N` overrides this; `--base <ref>` overrides both. When `HEAD~N` is unreachable the resolver clamps based on whether the repo is a shallow clone: **(full clone, branch shorter than N)** clamps to the empty-tree sentinel so the root commit's changes are included (reviewing all `K+1` commits on the branch); **(shallow clone)** clamps to `HEAD~K` SHA — the deepest locally resolvable ancestor — so the review does not balloon to every tracked file (older history exists on the remote but isn't fetched). A stderr warning surfaces the requested-vs-clamped numbers in both cases. Audit metadata records `base_source: 'last-n-commits'`, `last_n_commits: <count actually reviewed>`, and `last_n_commits_requested: N` (only present when clamped). |

### Codex CLI dependency

The gate shells out to `codex`. **`codex` is a hard prerequisite** when
`policy.review.codex_required: true` (the default for every profile other
than the `-no-codex` variants). As of 0.12.0 `rea doctor` runs a
`codex CLI on PATH` check that **fails** when codex is required by policy
but the binary is not on `PATH` — surfacing the prereq during install
rather than at first push:

```
[fail] codex CLI on PATH
       codex not found on PATH. policy.review.codex_required: true requires
       the codex binary. Install: https://github.com/openai/codex
       (e.g. `npm i -g @openai/codex`). To disable the push-gate instead,
       set policy.review.codex_required: false in .rea/policy.yaml.
```

If a push is attempted without codex on PATH, the gate also returns exit 2
with the same install hint:

```
codex CLI not found on PATH. Install with `npm i -g @openai/codex`,
or set `review.codex_required: false` in .rea/policy.yaml to disable
the push-gate.
```

Operators who do not have Codex available can either:

- Run `rea init --profile bst-internal-no-codex` (or `open-source-no-codex`),
  which sets `review.codex_required: false` on install.
- Flip `review.codex_required: false` in an existing policy file.

### Standalone usage

`rea hook push-gate` is invoked by `.husky/pre-push`, but it is also a
first-class CLI. Run it manually to test a review without pushing:

```bash
# Review the working tree against the resolved base (@{upstream}, else
# origin/HEAD, else main/master, else empty-tree).
rea hook push-gate

# Review against an explicit base.
rea hook push-gate --base origin/main
rea hook push-gate --base refs/remotes/upstream/main

# Narrow the review to the last N commits (diff vs HEAD~N). Loses to
# --base when both are set; mirrors policy.review.last_n_commits.
rea hook push-gate --last-n-commits 10
```

Exit codes match the pre-push contract. The JSON payload is written to
`.rea/last-review.json` regardless of invocation context.

### What happens to a protected ref?

The gate has no concept of protected vs. unprotected branches; it reviews
whatever diff git is about to push. Protect-main is enforced by GitHub
branch protection (required status checks, required reviews, no direct
pushes to `main`), not by the gate. The gate's job is to surface blocking
issues before the push reaches the remote.

---

## MCP gateway

`rea serve` is an MCP stdio server. Claude Code starts it via `.mcp.json`
at the start of a session; it runs for the life of that session. The
server proxies downstream MCP servers declared in `.rea/registry.yaml`
through a fixed middleware chain.

### Middleware chain

Every native rea tool call AND every proxied downstream call flows through
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
│ injection (args)   — prompt-injection in args     │
│ redact (args)      — secrets in arguments         │
│                                                   │
│ ==== EXECUTE ====                                 │
│                                                   │
│ result-size-cap    — bounded response             │
│ redact (result)    — secrets in result            │
│ injection (result) — prompt-injection in result   │
│ audit.exit         — hash-chained record close    │
└───────────────────────────────────────────────────┘
    │
    ▼
result
```

`.rea/` is hardcoded as an always-blocked path. It cannot be unblocked from
policy. Policy is re-read on every invocation — any edit to `policy.yaml`
takes effect on the next tool call.

### `__rea__health` meta-tool

The gateway advertises a single built-in tool, `__rea__health`, in every
`listTools` response. Calling it returns gateway version, uptime, HALT
state, policy summary, and per-downstream health. The handler
**short-circuits the middleware chain** — it is callable under HALT and at
any autonomy level — because it is the tool an operator reaches for when
everything else is frozen. Every invocation still writes an audit record.

The wire response is sanitized by default: `halt_reason` and
`downstreams[].last_error` surface as `null`. Full detail lives in the
audit record. Operators who genuinely need error strings on the MCP wire
can opt in via `policy.gateway.health.expose_diagnostics: true`; the
short-circuit still runs the full redact + injection-classify sanitizer
pass before emitting.

### Audit log

`.rea/audit.jsonl` is a hash-chained, append-only JSONL file. Each record
is a single line with:

- `seq` — monotonic integer
- `ts` — ISO-8601 UTC
- `session_id` — generated at `rea serve` boot
- `server_name`, `tool_name`, `tier` (`read` | `write` | `destructive`)
- `status` (`allowed` | `denied` | `error`)
- `metadata` — tool-specific structured fields (argument digest, target,
  deny reason, verdict)
- `prev_hash` — SHA-256 of the previous record; tampering is detectable by
  `rea audit verify`

Records are redacted on write (secrets swapped for `[REDACTED:*]`,
injection payloads swapped for `INJECTION_REDACTED_PLACEHOLDER`), never
LLM-reachable. Rotation is policy-driven (`policy.audit.rotation.max_bytes`
and/or `max_age_days`); rotation preserves the hash chain by seeding the
new file with a rotation marker record.

### TOFU drift detection

Downstream MCP servers are fingerprinted on first sight and stored in
`.rea/fingerprints.json`. On every `rea serve` boot, each server's canonical
shape (command path, env-key set, vault list) is hashed and compared
against the stored fingerprint:

- `first-seen` — new server; fingerprint recorded.
- `unchanged` — match; proceed.
- `drifted` — mismatch; fail-close. The operator uses `rea tofu list` to
  inspect and `rea tofu accept <name> --reason "..."` to rebase.

The drift-accept operation appends a `tofu.drift_accepted_by_cli` audit
record with the reason. The next boot classifies the server as
`unchanged`.

### Downstream environment safety

`rea serve` does **not** forward `process.env` wholesale. Each downstream
child gets:

1. A fixed allowlist of neutral OS vars (`PATH`, `HOME`, `TZ`,
   `NODE_OPTIONS`, …).
2. Names opted into via `registry.yaml#servers[].env_passthrough` — the
   schema refuses secret-looking names (`*_TOKEN`, `*_KEY`, `*_SECRET`, …),
   so secrets must be named explicitly.
3. Values from the registry's `env:` mapping, which may contain `${VAR}`
   placeholders resolved against the host environment. A `${VAR}` whose
   host variable is unset is treated as fatal — the downstream is marked
   unhealthy rather than handed an unresolved placeholder.

### Live state

`.rea/serve.state.json` is the on-disk live snapshot. It is written once
at boot and again on every circuit transition or supervisor event,
debounced through a 250 ms trailing timer and flushed atomically via
temp-file + rename. `rea status` reads this file to render a
per-downstream table; a new `rea serve` whose predecessor crashed can
detect the abandoned file and take over ownership rather than stalling.

### Optional Prometheus metrics

`rea serve` can expose a loopback-only Prometheus endpoint when
`REA_METRICS_PORT` is set:

```bash
REA_METRICS_PORT=9464 rea serve
curl http://127.0.0.1:9464/metrics
```

Metrics: per-downstream call and error counters, in-flight gauge,
audit-lines-appended counter, circuit-breaker state gauge, and a
seconds-since-last-HALT-check gauge. The listener binds to `127.0.0.1`
only, serves only `GET /metrics`, and never binds by default. No TLS;
scrape through SSH or a reverse proxy for cross-host access.

---

## Policy file

`.rea/policy.yaml` fields. The schema is zod-strict — unknown fields are
rejected at parse time, not ignored.

### Required fields

| Field | Type | Purpose |
| --- | --- | --- |
| `version` | `"1"` | Schema version; only `"1"` accepted in the current major |
| `profile` | string | Profile name (see below) |
| `installed_by` | string | Stamped by `rea init` — identifies the installing version |
| `installed_at` | ISO-8601 | Stamped by `rea init` — install timestamp |
| `autonomy_level` | `L0` \| `L1` \| `L2` \| `L3` | Current autonomy. `L0` = read-only; `L3` = full tool access |
| `max_autonomy_level` | `L0` \| `L1` \| `L2` \| `L3` | Hard ceiling. `autonomy_level` cannot exceed this |
| `promotion_requires_human_approval` | boolean | Require operator confirmation to raise autonomy |
| `block_ai_attribution` | boolean | Enforce no-AI-attribution in commits and PR bodies |
| `blocked_paths` | string[] | Glob patterns. `.rea/` is always blocked regardless |
| `notification_channel` | string | Optional Discord webhook URL; empty string = disabled |

### Optional blocks

```yaml
injection_detection: block        # "block" | "warn" — legacy 0.2.x knob
injection:
  suspicious_blocks_writes: true  # suspicious verdict on write/destructive tier denies
context_protection:
  delegate_to_subagent:
    - pnpm run build
    - pnpm run test
  max_bash_output_lines: 100
review:
  codex_required: true
  concerns_blocks: true
  timeout_ms: 1800000
  # last_n_commits: 10            # optional — narrow review to HEAD~N
redact:
  match_timeout_ms: 100
  patterns:
    - name: custom-api-key
      regex: 'acme_[A-Za-z0-9]{32}'
      flags: 'g'
audit:
  rotation:
    max_bytes: 52428800           # 50 MiB
    max_age_days: 30
gateway:
  health:
    expose_diagnostics: false
```

User-supplied `redact.patterns[]` are validated via `safe-regex` at load —
any pattern flagged unsafe fails the load with a specific error naming
the offender.

### Autonomy levels

| Level | Effect |
| --- | --- |
| `L0` | Read-only — every write/destructive tier call denies |
| `L1` | Default. Reads allowed; writes allowed; destructive tier denied |
| `L2` | Writes and destructive tier allowed |
| `L3` | No autonomy gate — only hook-layer and policy-layer checks remain |

`autonomy_level > max_autonomy_level` is rejected at parse time.
`promotion_requires_human_approval: false` requires the CLI flag
`--i-understand-the-risks` on any operation that raises autonomy.

### Profiles

Seven profiles ship in `profiles/`. The profile name is recorded in
`policy.yaml#profile` and governs which agents `rea init` copies and what
defaults apply.

| Profile | Intended use | Codex default |
| --- | --- | --- |
| `minimal` | Smallest possible install — curated 10 + opinionated minimal hooks | `true` |
| `client-engagement` | Consulting engagement where the repo is client-owned | `true` |
| `bst-internal` | Booked Solid internal projects; conservative posture | `true` |
| `bst-internal-no-codex` | Same as above; no Codex CLI available | `false` |
| `lit-wc` | Lit web-component library projects | `true` |
| `open-source` | OSS library / CLI projects; liberal but audited | `true` |
| `open-source-no-codex` | Same; no Codex CLI available | `false` |

The `-no-codex` variants default `review.codex_required: false` on
install so teams without a Codex bench get a first-class opt-out. Flip
`--codex` / `--no-codex` on the `rea init` command line to override.

---

## Hooks shipped

Eleven hooks ship in `hooks/` and are copied into `.claude/hooks/` by
`rea init`. All eleven are wired by default in the shipped
`.claude/settings.json`.

| Hook | Event | Purpose | Default |
| --- | --- | --- | --- |
| `dangerous-bash-interceptor.sh` | `PreToolUse: Bash` | Block categories of destructive shell commands (`rm -rf`, `git reset --hard`, `--no-verify`, …) | Registered |
| `env-file-protection.sh` | `PreToolUse: Bash` | Block reads of `.env*` files | Registered |
| `dependency-audit-gate.sh` | `PreToolUse: Bash` | Verify packages exist on the registry before install | Registered |
| `security-disclosure-gate.sh` | `PreToolUse: Bash` | Route security-keyword `gh issue create` to private disclosure | Registered |
| `pr-issue-link-gate.sh` | `PreToolUse: Bash` | Advisory warn when `gh pr create` has no linked issue | Registered |
| `attribution-advisory.sh` | `PreToolUse: Bash` | Block commits/PRs containing AI attribution markers | Registered |
| `secret-scanner.sh` | `PreToolUse: Write\|Edit` | Scan file writes for credential patterns | Registered |
| `settings-protection.sh` | `PreToolUse: Write\|Edit` | Block agent writes to `.claude/settings.json`, hook dirs, policy | Registered |
| `blocked-paths-enforcer.sh` | `PreToolUse: Write\|Edit` | Enforce `blocked_paths` from policy | Registered |
| `changeset-security-gate.sh` | `PreToolUse: Write\|Edit` | Guard changesets against GHSA leaks and malformed frontmatter | Registered |
| `architecture-review-gate.sh` | `PostToolUse: Write\|Edit` | Flag edits crossing architectural boundaries (advisory) | Registered |

The 0.10.x review-gate scripts (`push-review-gate.sh`,
`push-review-gate-git.sh`, `commit-review-gate.sh`) and the 1,250-line
shared bash core (`hooks/_lib/push-review-core.sh`) were removed in
0.11.0. The `hooks/_lib/` directory now contains only the three shared
helpers — `common.sh`, `halt-check.sh`, `policy-read.sh` — used by the
remaining hooks.

Every hook uses `set -euo pipefail` (or `set -uo pipefail` for stdin-JSON
consumers) and performs a HALT check near the top. Both the hook layer
and the MCP gateway middleware fail closed; bypassing one does not
disable the other.

---

## Slash commands

Five commands ship in `commands/` and are copied into `.claude/commands/`
by `rea init`.

| Command | Purpose |
| --- | --- |
| `/rea` | Session status — autonomy level, HALT state, recent audit entries, next action |
| `/review` | Invoke the `code-reviewer` agent on current changes |
| `/codex-review` | Invoke the `codex-adversarial` agent via the Codex plugin |
| `/freeze` | Prompt for a reason and write `.rea/HALT` |
| `/halt-check` | Smoke test — verify every hook and middleware respects HALT |

---

## Curated agents

Ten specialist agents ship in `agents/` and are copied into `.claude/agents/`
by `rea init`. Profiles layer additional specialists on top for specific
project shapes.

| Agent | When to use |
| --- | --- |
| `rea-orchestrator` | **First stop for any non-trivial task.** Reads policy, checks HALT, routes to the right specialist(s), coordinates multi-step work, enforces the plan/build/review loop. |
| `code-reviewer` | Structured review of a working-tree diff; surfaces correctness, clarity, and consistency issues without adversarial framing. |
| `codex-adversarial` | Adversarial review via the Codex plugin (`/codex:adversarial-review`). Independent model perspective; produces an audit entry with verdict. |
| `security-engineer` | Security-sensitive implementation and review — auth flows, secret handling, injection surfaces. |
| `accessibility-engineer` | WCAG review, ARIA semantics, keyboard navigation, screen-reader fact-checking. |
| `typescript-specialist` | Strict-mode TypeScript correctness, generics, narrowing, inference edge cases. |
| `frontend-specialist` | UI component work, framework idioms (React, Lit, Astro), CSS architecture. |
| `backend-engineer` | API design, database schema, background jobs, MCP server implementation. |
| `qa-engineer` | Test strategy, fixture design, regression reproducers, flake triage. |
| `technical-writer` | User-facing documentation, API references, migration guides, changelog narratives. |

The `rea-orchestrator` is the single entry point for non-trivial tasks.
The CLAUDE.md fragment installed by `rea init` instructs the host agent
to route there first; delegation contracts are defined in each agent's
markdown file.

---

## CLI reference

```
rea <command> [options]
```

Run `rea <command> --help` for full per-command options.

### `rea init`

Interactive wizard — write `.rea/policy.yaml`, install `.claude/`, the
commit-msg hook, and a CLAUDE.md fragment.

```bash
rea init
rea init -y --profile bst-internal       # non-interactive
rea init --from-reagent                  # migrate from .reagent/
rea init --profile open-source-no-codex  # disable Codex by default
rea init --force                         # overwrite existing artifacts
```

### `rea upgrade`

Sync `.claude/`, `.husky/`, and managed fragments with this rea version.
Prompts on drift; silently refreshes unmodified files.

```bash
rea upgrade --dry-run   # show what would change; write nothing
rea upgrade             # interactive
rea upgrade -y          # non-interactive, keep drifted files
rea upgrade --force     # non-interactive, overwrite drift
```

### `rea serve`

Start the MCP gateway. Invoked by Claude Code via `.mcp.json`; not a
daemon. Stdio transport only.

```bash
rea serve
REA_METRICS_PORT=9464 rea serve
REA_LOG_LEVEL=debug rea serve
```

### `rea freeze` / `rea unfreeze`

Write or remove `.rea/HALT`. Every call writes an audit record.

```bash
rea freeze --reason "incident triage"
rea unfreeze
rea unfreeze -y   # skip confirmation
```

### `rea check`

On-disk status — autonomy, HALT, profile, recent audit entries. No live
process probe.

### `rea status`

Running-process view — reads `.rea/serve.pid` + `.rea/serve.state.json`
to render per-downstream health.

```bash
rea status
rea status --json   # pipe to jq
```

### `rea doctor`

Validate the install — policy parses, `.rea/` layout, hooks, Codex plugin
presence, TOFU fingerprint store.

```bash
rea doctor
rea doctor --metrics   # also print 7-day Codex telemetry summary
rea doctor --drift     # report drift vs. install manifest (read-only)
```

In non-git directories the commit-msg and pre-push checks are skipped
cleanly. Audit hash-chain integrity is verified by `rea audit verify`,
not by `rea doctor`.

### `rea audit rotate` / `rea audit verify`

```bash
rea audit rotate                      # force rotation now
rea audit verify                      # re-hash the chain; exit 1 on first tamper
rea audit verify --since <file>       # walk forward from a rotated file
```

### `rea tofu list` / `rea tofu accept`

```bash
rea tofu list
rea tofu list --json
rea tofu accept my-mcp-server --reason "added vault path /Volumes/Work"
```

### `rea hook push-gate`

Pre-push Codex review gate. Normally invoked by `.husky/pre-push`; run
manually to test.

```bash
rea hook push-gate
rea hook push-gate --base origin/main
```

---

## Migration from 0.10.x

`rea upgrade` handles the policy and on-disk pieces. You run it once:

```bash
rea upgrade
```

It performs:

1. **Backup** — writes `.rea/policy.yaml.bak-<timestamp>` before any edit.
2. **Strip removed fields** — removes `review.cache_max_age_seconds` and
   `review.allow_skip_in_ci` from the policy file. Both were cache-gate
   concepts with no meaning under the stateless gate.
3. **Add defaults** — inserts `review.concerns_blocks: true` if absent.
4. **Prune settings.json** — removes hook registrations for the removed
   scripts (`push-review-gate`, `commit-review-gate`) from
   `.claude/settings.json`, leaving the other registrations intact.
5. **Refresh `.claude/hooks/`** — deletes the removed scripts with a
   change-log entry.
6. **Rewrite `.husky/pre-push`** iff it carries a rea marker. A
   foreign `.husky/pre-push` (no marker) is left untouched and a loud
   warning is printed.
7. **Refresh `.git/hooks/pre-push`** fallback with the new 15-line stub
   (when `core.hooksPath` is unset and git is using the default hooks
   directory).

### What the new `.husky/pre-push` looks like

Fifteen lines of POSIX `sh`. HALT check, locate the rea binary, `exec rea
hook push-gate "$@"`. That is the entire body — all real work lives in
the TypeScript gate composer at `src/hooks/push-gate/index.ts`.

### Rollback

If the stateless gate's behavior is blocking a specific workflow you
cannot yet address:

```bash
npm install -g @bookedsolid/rea@0.10.3
# restore policy from the backup rea upgrade wrote
cp .rea/policy.yaml.bak-<ts> .rea/policy.yaml
# re-run the 0.10.3 install to put the old hooks back
rea init --force
```

The 0.10.3 cache-attestation gate remains on npm and continues to work.
Rollback is a supported path — the `rea upgrade` backup is specifically
there to make it a one-liner.

### What you will not need to do anymore

- `rea cache check` / `rea cache set` / `rea cache list` / `rea cache clear`
  — all removed. The stateless gate consults no cache.
- `rea audit record codex-review --also-set-cache` — removed. The gate
  writes its own audit records from the actual Codex run.
- Setting `REA_SKIP_PUSH_REVIEW` — removed. Use either
  `REA_SKIP_PUSH_GATE=<reason>` or `REA_SKIP_CODEX_REVIEW=<reason>`
  (both value-carrying and always audited; identical effect, distinct
  `skip_var` in audit metadata) or flip `review.codex_required: false`
  in policy. `REA_SKIP_CODEX_REVIEW` was reinstated in 0.12.0 as an
  audited alias for `REA_SKIP_PUSH_GATE` — it had been documented in the
  gateway-tier reviewers but not in the push-gate, leaving agents
  setting the documented variant blocked.

---

## Contributor quality gates

Before push, run the four checks locally. CI runs them as required status
checks on every PR to `main`:

```bash
pnpm lint        # ESLint 10 — zero warnings
pnpm type-check  # tsc --noEmit (strict)
pnpm test        # vitest run
pnpm build       # tsc -p tsconfig.build.json
```

Additionally, every PR needs:

- **DCO sign-off** on all commits (`git commit -s`). The DCO bot rejects
  unsigned commits.
- **Changeset** entry (`pnpm changeset`) unless the change is purely
  non-publishable (CI, docs, meta). CI flags missing changesets.
- **Secret scan** clean. Gitleaks runs in CI and via the
  `secret-scanner.sh` hook.
- **No AI attribution** anywhere — commit messages, PR bodies, code
  comments, changeset content. The commit-msg hook and
  `attribution-advisory.sh` reject structural attribution.

Security-sensitive paths (`src/gateway/middleware/**`, `src/policy/**`,
`src/hooks/**`, `hooks/**`, `.github/workflows/**`) require explicit
maintainer review and a threat-model update in the same PR.

Releases flow through Changesets: a "Version Packages" PR is auto-opened
when a changeset lands on `main`. Merging it triggers `npm publish
--provenance` via OIDC from `.github/workflows/release.yml`. Do not
manually `npm publish`.

---

## Threat model and security

- [SECURITY.md](./SECURITY.md) — disclosure policy, supported versions,
  GHSA coordination. 72-hour acknowledgment target, 90-day window. Do
  not report vulnerabilities via public GitHub issues.
- [THREAT_MODEL.md](./THREAT_MODEL.md) — attack surface, mitigations,
  residual risks. The contract rea holds itself to.

Short version: the MCP gateway and the hook layer run independently.
Both fail closed. `.rea/` is always blocked. The audit log is
hash-chained. Policy is re-read on every invocation. npm publish uses
OIDC provenance, not long-lived tokens. The pre-push gate runs Codex
on every push and treats Codex responses as untrusted input — findings
flow through the same redact pattern set used by the middleware before
anything hits disk.

---

## Non-goals

See [What REA is NOT](#what-rea-is-not) above. Every "but what if we
just added X" belongs in a separate package that composes with REA. The
non-goals are the product.

---

## License and contributing

[MIT](./LICENSE). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full
contributor guide and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for
the Contributor Covenant.

- DCO sign-off required (`git commit -s`) — no CLA.
- Conventional commits, TypeScript strict, ESLint zero-warnings,
  Prettier, vitest.
- Changeset on every publishable change; merge the auto-generated
  Version Packages PR to release.
- Security-sensitive paths gated by CODEOWNERS; human review required.

This repo dogfoods itself. rea's governance layer enforces rea's own
commit, hook, and attribution rules. The install under `.rea/`,
`.claude/`, and `.husky/` is the reference example of the
`bst-internal` profile.
