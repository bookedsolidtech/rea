---
'@bookedsolid/rea': minor
---

feat(0.29.0): delegation-telemetry MVP — observe `Agent` / `Skill` dispatches

Adds a new PreToolUse hook (`hooks/delegation-capture.sh`) that fires on
matcher `Agent|Skill` and pipes a redacted, hashed delegation record into
the existing `.rea/audit.jsonl` hash chain via a new
`rea hook delegation-signal` CLI subcommand. A companion reader
(`rea audit specialists`) summarizes which subagents and skills the
current session is actually invoking.

The signal is **observational only** — never gates tool dispatch, never
fails the hook, never alters autonomy. Worst-case latency for the
PreToolUse hook stays in the tens-of-milliseconds range even under
audit-chain contention (the audit append runs in a backgrounded child
process with a 2s lock-acquisition fallback).

# Six new surfaces

1. **Event schema** — `src/audit/delegation-event.ts`. Defines
   `rea.delegation_signal` tool_name, `claude-code-hooks` server_name,
   strict-mode zod schema, `schema_version: 1` literal, and the
   `DelegationTool = 'Agent' | 'Skill'` union. Re-exported from
   `src/audit/append.ts`. The raw `description` / `prompt` is hashed
   with SHA-256; the agent / skill name is run through `redactSecrets`
   before landing in the chain.

2. **CLI subcommand** — `rea hook delegation-signal` (extends
   `src/cli/hook.ts`). Reads the Claude Code hook payload from stdin,
   extracts `tool_input.subagent_type` (Agent) or `tool_input.skill`
   (Skill), applies `redactSecrets` to the identifier fields with a
   250ms per-pattern timeout, hashes the description, and appends a
   `rea.delegation_signal` audit record. Always exits 0. Supports
   `--detach` (fire-and-forget for the hook shim) and
   `--lock-timeout-ms` (2s default; silent drop on timeout). Tier-mapped
   as Read in `src/config/tier-map.ts`.

3. **Hook body** — `hooks/delegation-capture.sh`. Minimal stub: HALT
   check, locate rea CLI (`node_modules/.bin/rea` → PATH), pipe stdin
   to `rea hook delegation-signal --detach &` with `disown`, exit 0.
   Silent drop when no rea binary is in scope (bootstrap state).

4. **Reader CLI** — `rea audit specialists` (new
   `src/cli/audit-specialists.ts`). Walks the current `.rea/audit.jsonl`,
   filters by `tool_name === 'rea.delegation_signal'`, groups by
   `subagent_type`, prints a table (default) or JSON (`--json`).
   Current-session filter via `$CLAUDE_SESSION_ID`; v1 omits `--since`
   and `--session=ID` by design.

5. **Settings template** — `defaultDesiredHooks()` in
   `src/cli/install/settings-merge.ts` now lists a new PreToolUse group
   with matcher `Agent|Skill` referencing
   `.claude/hooks/delegation-capture.sh`. `rea init` and `rea upgrade`
   merge it idempotently into consumer settings.

6. **Doctor smoke test** — `rea doctor` checks that the `Agent|Skill`
   matcher is registered AND that the hook file exists. The new
   `delegation-capture.sh` is added to `EXPECTED_HOOKS` (14 → 15).
   `rea doctor --smoke` runs a synthetic round-trip: emits a probe
   `rea.delegation_signal` record and verifies chain integrity. Hard
   fail on missing wiring — consumers who skip `rea upgrade` see the
   gap immediately.

# Matcher correction (mcp-protocol-specialist)

The matcher is **`Agent|Skill`**, NOT `Task|Skill`. In current Claude
Code the delegation tools are named `Agent` and `Skill`;
`TaskCreate`/`TaskList`/`TaskUpdate` are the unrelated todo-list tools
and MUST NOT match. The settings.json template, hook file, doctor
error messages, and all tests anchor on `Agent|Skill` throughout.

# Privacy invariant

The raw `tool_input.description` / `tool_input.prompt` text NEVER lands
on disk — only its SHA-256 hex digest. The agent / skill name is run
through `redactSecrets` (AWS / GitHub / Anthropic / OpenAI / Discord
/ Bearer / API-key / PEM patterns) and substituted with `[REDACTED]`
on any match; the firing pattern name appears in the record's
`redacted_fields` envelope.

# Backwards compatibility

Pre-0.29.0 audit chains are completely unaffected. Readers filter on
`tool_name === 'rea.delegation_signal'` AND
`metadata.schema_version === 1`, so older records pass through
silently. The new audit-record class slots into the existing
hash-chain; `rea audit verify` still verifies cleanly.

# Tests (105 new across 7 files)

- `__tests__/audit/delegation-event.test.ts` — zod strict-mode rejection
  of unknown fields, `schema_version` literal enforcement, SHA-256
  format guard, Agent/Skill union, re-export integrity.
- `__tests__/cli/hook-delegation-signal.test.ts` — Agent/Skill payload
  parsing, redaction of a planted synthetic AWS key, missing-prompt
  empty-hash, malformed-JSON exit-0-with-breadcrumb, `--detach`
  exit-fast contract, schema_version literal on every record.
- `__tests__/cli/audit-specialists.test.ts` — empty-audit handling,
  session-filter via option vs. env, table/JSON output, group
  sort order, files_scanned reporting.
- `__tests__/hooks/delegation-capture.test.ts` — exit 0 on
  Agent/Skill/Bash payloads (hook is matcher-agnostic; settings.json
  enforces matching), exit 2 on HALT, silent drop on missing rea binary.
- `__tests__/integration/delegation-concurrent-write.test.ts` —
  10 hook writes + 1 middleware write produce a linear chain;
  25 parallel delegation writes keep the chain linear; `rea audit
  verify` reports clean.
- `__tests__/cli/init-delegation-template.test.ts` — settings-merge
  adds the `Agent|Skill` group, NOT `Task|Skill`; idempotent re-runs
  produce byte-identical output; consumer-authored Agent|Skill hooks
  are preserved.
- `src/cli/doctor.test.ts` — delegation-capture registration check:
  fail on missing settings.json, missing matcher, missing command;
  pass on correct wiring. EXPECTED_HOOKS count updated 14 → 15.

# Deferred to 0.29.1 / 0.30.0

Per principal-engineer scope-cut (12 surfaces → 6), the following are
explicitly out of scope for 0.29.0:

- `delegation-advisory.sh` (threshold-cross hook) — 0.29.1
- `policy.delegation_advisory.*` schema — 0.29.1
- Live `.claude/agents/` roster discovery — 0.29.1
- Per-session grouping / `--since=DUR` flag — 0.29.1
- Schema migration safety `timestamp >= installed_at` — 0.30.0
