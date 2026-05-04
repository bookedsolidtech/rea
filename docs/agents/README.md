# Agent Entry Point — `@bookedsolid/rea`

> **Audience.** AI agents (Claude Code, Codex, future LLMs) doing work
> inside the `@bookedsolid/rea` repository. If you are an operator
> upgrading a consumer project, read
> [`docs/migration/0.23.0.md`](../migration/0.23.0.md) instead.

This is your **single discoverable entry point**. Every other doc in
this repository cross-references back to here. If you can find this
file, you can find everything else.

## What this project is (one paragraph)

`@bookedsolid/rea` is the agentic governance layer for Claude Code
and Codex. It enforces an `.rea/policy.yaml`-defined policy through
three independent mechanisms: a kill-switch (`HALT` file), a hook
layer (Write-tier and Bash-tier), and an MCP gateway with a
hash-chained audit log. The product is gating + auditing of agentic
tool calls; everything else (project management, task tracking,
secret rotation, CI replacement) is explicitly out of scope. See
[`README.md`](../../README.md) for the operator-facing description.

## Architecture in five layers

The defensive stack runs roughly in this order. Read the linked doc
when you're touching that layer.

| Layer | What it does | Source | Doc |
| ----- | ------------ | ------ | --- |
| 1. Policy | Loads `.rea/policy.yaml`, validates with zod, exposes typed `Policy` | `src/policy/loader.ts` | [`THREAT_MODEL.md` §5.3](../../THREAT_MODEL.md) |
| 2. Kill switch | Refuses any tool call when `.rea/HALT` exists | `src/gateway/middleware/kill-switch.ts` + every hook's `check_halt` | [`THREAT_MODEL.md` §5.7](../../THREAT_MODEL.md) |
| 3. Hooks (Write-tier) | 13 shell hooks fire on Claude Code's `PreToolUse` / `PostToolUse` events for `Write` / `Edit` / `MultiEdit` / `NotebookEdit` | `hooks/*.sh` (canonical) → `.claude/hooks/*.sh` (consumer install) | [`README.md` §Hooks shipped](../../README.md) |
| 4. Hooks (Bash-tier) | 2 hooks (`protected-paths-bash-gate`, `blocked-paths-bash-gate`) shim to a parser-backed scanner; remaining 5 use regex segmenter | `src/hooks/bash-scanner/` + `hooks/protected-paths-bash-gate.sh` + `hooks/blocked-paths-bash-gate.sh` | [`docs/architecture/bash-scanner.md`](../architecture/bash-scanner.md) + [`docs/agents/bash-scanner-extension.md`](./bash-scanner-extension.md) |
| 5. MCP gateway | `rea serve` proxies downstream MCP servers through middleware (audit, kill-switch, tier, policy, blocked-paths, rate-limit, circuit-breaker, injection, redact, result-size-cap) | `src/gateway/middleware/` | [`THREAT_MODEL.md` §3 + §5](../../THREAT_MODEL.md) |

## Where to find things — cheat sheet

When you need to find … look here.

| Need | File path | Notes |
| ---- | --------- | ----- |
| Active policy for the rea repo (dogfood) | `.rea/policy.yaml` | Read at session start to confirm autonomy level and `blocked_paths` |
| HALT state | `.rea/HALT` | If present, the harness is locked. **STOP** any work and surface to the user. |
| Audit log | `.rea/audit.jsonl` | Hash-chained, append-only. Every tool call appears. |
| Hook inventory and registration | `.claude/settings.json` | The matcher/event registration is what actually runs hooks |
| Hook canonical source | `hooks/*.sh` | What `rea init` copies into a consumer's `.claude/hooks/` |
| Slash commands | `commands/*.md` | `/rea`, `/review`, `/codex-review`, `/freeze`, `/halt-check` |
| Specialist agents (the team) | `agents/*.md` | What `rea init` copies into a consumer's `.claude/agents/` |
| Bash-scanner source | `src/hooks/bash-scanner/` | Parser, walker, dispatcher, verdicts |
| Bash-scanner tests (corpus) | `__tests__/hooks/bash-scanner/` | 8000+ tests across 19 classes |
| Bash-scanner exhaustiveness contract | `__tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts` | Class O — pins every Word-bearing AST position |
| Threat model | [`THREAT_MODEL.md`](../../THREAT_MODEL.md) | §8 covers the bash-tier scanner |
| Migration guide for consumers | [`docs/migration/0.23.0.md`](../migration/0.23.0.md) | Install troubleshooting, rollback path |
| Bash-scanner architecture | [`docs/architecture/bash-scanner.md`](../architecture/bash-scanner.md) | Parser choice, walker design, dispatcher recipe |
| How to add a detector | [`docs/agents/bash-scanner-extension.md`](./bash-scanner-extension.md) | Step-by-step recipe |
| Hook debugging | [`docs/agents/troubleshooting.md`](./troubleshooting.md) | Symptom → cause → fix |

## The `.rea/policy.yaml` contract

The fields you will encounter most.

| Field | Type | Meaning | Read by |
| ----- | ---- | ------- | ------- |
| `version` | string | Policy schema version (currently `'1'`) | `src/policy/loader.ts` |
| `profile` | string | Layered profile name (`bst-internal`, `client-engagement`, `open-source`, `lit-wc`, `minimal`, ...) | `src/policy/loader.ts` |
| `autonomy_level` | `L0\|L1\|L2\|L3` | The agent's permitted scope. L0 = read-only, L3 = full autonomy. | every middleware |
| `max_autonomy_level` | `L0\|L1\|L2\|L3` | The ceiling — the agent cannot self-promote past this | gateway tier middleware |
| `promotion_requires_human_approval` | bool | Self-explanatory | tier middleware |
| `block_ai_attribution` | bool | When true, commit-msg and PR-body hooks reject Co-Authored-By with AI names | `attribution-advisory.sh` + `.husky/commit-msg` |
| `blocked_paths` | string[] | Files the agent cannot write under any circumstances. Always-blocked invariants are added even if missing here. | `blocked-paths-enforcer.sh` + `blocked-paths-bash-gate.sh` |
| `protected_writes` | string[] (opt) | If set, owns the protected-write list (kill-switch invariants always added back) | `settings-protection.sh` + `protected-paths-bash-gate.sh` |
| `protected_paths_relax` | string[] (opt) | Subtractive — narrows the protected list. Cannot remove kill-switch invariants. | same as above |
| `notification_channel` | string | Discord webhook URL for outbound notifications. Empty disables. | `notify_owners` flow |
| `review.codex_required` | bool | When true, `/codex-review` must produce a PASS audit entry before push | push-gate |
| `review.codex_model` | string | Codex model pin (default `gpt-5.4`) | push-gate |
| `review.codex_reasoning_effort` | `low\|medium\|high` | Codex reasoning effort (default `high`) | push-gate |
| `review.last_n_commits` | number (opt) | Narrow review to the last N commits (vs full diff against base) | push-gate |
| `review.auto_narrow_threshold` | number (opt, default 30) | Auto-narrow to last-N when commit count exceeds this | push-gate |
| `architecture_review.patterns` | string[] (opt) | Patterns the architecture-review-gate hook tracks. Empty = silent no-op. | `architecture-review-gate.sh` |

The full schema is in `src/policy/loader.ts` (`PolicySchema`). Every
field is validated; unknown fields are rejected.

## The `.claude/settings.json` contract

The hook registration table the harness reads. Each entry pairs an
event (`PreToolUse`, `PostToolUse`, `Stop`) and a tool matcher with a
hook script. **A hook that ships in `.claude/hooks/` but is not
registered here does NOT fire.**

Common patterns:

- `Write|Edit|MultiEdit|NotebookEdit` matcher — for write-tier hooks
  (secret-scanner, blocked-paths-enforcer, settings-protection,
  changeset-security-gate, architecture-review-gate, etc.)
- `Bash` matcher — for bash-tier hooks (dangerous-bash-interceptor,
  protected-paths-bash-gate, blocked-paths-bash-gate,
  dependency-audit-gate, etc.)
- Event-specific matchers like `attribution-advisory.sh` registered on
  `PreToolUse: Bash` for `git commit` / `gh pr` patterns.

If you change `hooks/<x>.sh`, run `pnpm tools/check-dogfood-drift.mjs`
to confirm `.claude/hooks/<x>.sh` (the dogfood install) is still in
sync. Drift causes `pnpm test:dogfood` failures.

## Common operations

### Run the quality gates

Six gates exist; CI runs them. Run them locally before push.

```bash
pnpm lint        # ESLint, zero warnings
pnpm type-check  # tsc --noEmit (strict)
pnpm test        # vitest run (~9000 tests)
pnpm build       # tsc -p tsconfig.build.json → dist/
pnpm test:dogfood        # check hooks/ ↔ .claude/hooks/ are in sync
pnpm test:bash-syntax    # bash -n on every shipped hook
```

The `pnpm test` gate occasionally exits non-zero on a vitest worker
IPC timeout (known artifact when running the full suite under heavy
load). When you see this, re-run `pnpm vitest run` directly to
confirm 0 failures; that's the source of truth.

### Add a new bash utility detector

See [`docs/agents/bash-scanner-extension.md`](./bash-scanner-extension.md).
TL;DR:

1. Add the form tag in `src/hooks/bash-scanner/verdict.ts`
2. Add the dispatch case in `walker.ts::walkCallExpr`
3. Write the `detectFoo(stripped, out)` helper
4. Wire it into `recurseInnerArgv` if it should fire inside
   `find -exec` / `xargs` / nested shells
5. Add a fixture in the appropriate Class generator
6. Add a unit test in `walker.test.ts`

### Add a new hook

1. Write the hook at `hooks/<name>.sh`. Use `set -euo pipefail` (or
   `set -uo pipefail` for stdin-JSON consumers). Source
   `_lib/common.sh` for shared helpers (HALT check, jq guard, JSON
   output).
2. Mirror it to `.claude/hooks/<name>.sh` (dogfood install). The
   drift-check expects byte-identical content.
3. Register it in `.claude/settings.json` under the appropriate
   `hooks` event with a tool matcher.
4. Add a test in `__tests__/hooks/<name>.test.ts` that spawns the
   hook with a fake `tool_input` JSON and asserts the verdict.
5. Document the hook in `README.md` §Hooks shipped.

### Add a new specialist agent

1. Write the agent prompt at `agents/<name>.md` with frontmatter
   (`name`, `description`, optional `tools`).
2. Mirror to `.claude/agents/<name>.md`.
3. Add to the relevant profile YAML in `profiles/` if it should ship
   with that profile.
4. Reference the agent in `CLAUDE.md` if it's part of the default
   delegation routing.

### Run a Codex adversarial review

```bash
# From within Claude Code:
/codex-review
```

This invokes the `codex-adversarial` agent against the working tree.
The result is appended to `.rea/audit.jsonl`. The push-gate (when
enabled via `policy.review.codex_required`) requires a PASS audit
entry on the pushed range before allowing `git push`.

## Trust assumptions you must not break

These are non-negotiable — every agent in this repo inherits them.

1. **Read before write.** Use Read on a file before any Edit. The
   tool errors out otherwise; you also avoid stale-context edits.
2. **Verify package existence before install.** `npm view <pkg>` or
   check npmjs.com. The `dependency-audit-gate.sh` hook will block
   uninstalled packages.
3. **Never bypass hooks.** Do not pass `--no-verify`,
   `--no-gpg-sign`, or any flag that disables a check. The hooks ARE
   the safety gates; bypassing them defeats the project's purpose.
4. **Never commit secrets.** The secret-scanner hook scans every
   write. Even if it slipped through, `.rea/audit.jsonl` would
   record the attempt.
5. **Respect the autonomy level.** L0 = no writes; L1 = repo writes
   only with audit; L2 = repo writes + side-effects with audit;
   L3 = full autonomy. Never escalate without `promotion_requires_human_approval`.
6. **Honor HALT.** If `.rea/HALT` exists, every action stops. The
   gate fires in middleware AND in every hook.
7. **Public repo.** Every commit is permanent and visible. Do not
   commit private URLs, customer data, or speculative experiments.
8. **DCO sign-off.** Every commit needs `git commit -s`.

## When in doubt

1. **Read** the file in question — Read tool, not memory.
2. **Verify** by running the test or invoking the tool with a known
   input.
3. **Check** `.rea/audit.jsonl` for the most recent invocations of
   the affected hook/middleware.
4. **Ask** the user. The cost of a clarifying question is always
   lower than the cost of acting on a wrong assumption.

## Cross-references

- [`README.md`](../../README.md) — operator-facing description
- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — security claims and
  trust assumptions (§8 covers the bash-tier scanner)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — DCO, dev workflow,
  changesets
- [`SECURITY.md`](../../SECURITY.md) — vulnerability disclosure
- [`docs/architecture/bash-scanner.md`](../architecture/bash-scanner.md) — bash-scanner deep-dive
- [`docs/agents/bash-scanner-extension.md`](./bash-scanner-extension.md) — extension recipe
- [`docs/agents/troubleshooting.md`](./troubleshooting.md) — debug
  guide
- [`docs/migration/0.23.0.md`](../migration/0.23.0.md) — consumer
  migration
- [`CLAUDE.md`](../../CLAUDE.md) — top-level agent behavioral rules
- [`.rea/policy.yaml`](../../.rea/policy.yaml) — the dogfood policy
