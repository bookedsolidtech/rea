# Agent Behavioral Rules

## Non-Negotiable Rules

These rules are enforced by hooks and cannot be overridden by any agent instruction:

- **NEVER** use `--no-verify` to skip git hooks — hooks are safety gates, not obstacles
- **NEVER** use `--no-gpg-sign` or any flag that bypasses commit signing / DCO sign-off
- **NEVER** commit secrets, credentials, API keys, or tokens to any file
- **NEVER** force-push to `main` — branch protection will reject it, don't try
- **NEVER** push without all applicable quality gates passing (`pnpm lint && pnpm type-check && pnpm test && pnpm build`)
- **NEVER** install packages without verifying they exist in the npm registry first
- **NEVER** publish `@bookedsolid/rea` without Jake's explicit authorization — Changesets release workflow is the only path

## Attribution

Do NOT include AI attribution in commits, PR bodies, code comments, or any content. When `block_ai_attribution` is enabled in `.rea/policy.yaml`, the commit-msg hook REJECTS commits containing structural AI attribution (Co-Authored-By with AI names, "Generated with [Tool]" footers, etc.). The attribution-advisory hook also blocks `gh pr create/edit` and `git commit` commands with attribution. Remove all attribution markers before committing — the hooks will NOT silently fix them.

## DCO Sign-Off

Every commit MUST be signed off with `git commit -s`. The DCO status check on every PR verifies this, and unsigned commits will block the merge. This repo does not use a CLA — DCO is the contributor agreement.

## Verification Requirements

- Read files before editing them — understand existing code before modifying
- Verify package existence before installing: `npm view <package>` or check npmjs.com
- Confirm current state before claiming status — check git, files, build output
- Check tool availability before assuming it is installed

## Human-in-the-Loop Escalation

When you encounter an unexpected blocker, ambiguous requirement, or situation not covered by the current context:

1. **STOP** — do not invent a workaround or make assumptions
2. **Describe** the situation clearly: what you tried, what failed, what you need
3. **Wait** for explicit human instruction before proceeding

The cost of pausing is always lower than the cost of acting incorrectly — especially in a public repo where every commit is permanent and visible.

## Policy File

Read `.rea/policy.yaml` at the start of every session to confirm:

- The current `autonomy_level` (L0–L3) — your permitted operation scope
- `blocked_paths` — files you must never modify without explicit human action
- `max_autonomy_level` — ceiling set by the maintainer; never request escalation beyond it
- `block_ai_attribution` — enforced by hooks, always `true` in this repo

Current baseline: `autonomy_level: L1`, `max_autonomy_level: L2`, `promotion_requires_human_approval: true`.

## Audit Acknowledgment

This session may be subject to audit logging per `.rea/policy.yaml`. The middleware chain records every tool invocation to `.rea/audit.jsonl` (hash-chained, append-only). Behave as if every action is observed — because it is.

## Delegation

This project uses the "bring your own engineering team" model that rea itself ships. All non-trivial work flows through the orchestrator to specialist agents.

**CRITICAL: For any non-trivial task, delegate to the `rea-orchestrator` agent FIRST.**

The orchestrator (`subagent_type: "rea-orchestrator"`) is the primary routing layer:

- It reads `.rea/policy.yaml` and checks `.rea/HALT` before any work
- It selects the right specialist agents from `.claude/agents/` based on the task
- It enforces the engineering process (plan → build → adversarial review), coordinates multi-step work, and ensures quality gates
- It can launch multiple specialists in parallel for maximum throughput

**Fallback**: If the orchestrator is unavailable or the task is narrowly scoped to a single domain, route directly to a specialist from `.claude/agents/`:

- **Principals** (direction & readiness):
  - `principal-engineer` — cross-module structural decisions, "patch vs redesign" calls
  - `principal-product-engineer` — consumer signal → engineering priority, canary-vs-broad-rollout
  - `release-captain` — release readiness, breaking-change disclosure, rollback plan
- **Architects** (design):
  - `security-architect` — threat model, trust boundaries, defense-in-depth
  - `data-architect` — schema, migrations, data-flow boundaries (audit log, policy.yaml)
  - `platform-architect` — CI / build / packaging / publish pipeline
  - `devex-architect` — install topology, doctor diagnostics, error messages, idempotency
- **Review tier**: `code-reviewer`, `codex-adversarial` — review / adversarial review
- **Domain review**: `security-engineer`, `accessibility-engineer`
- **Implementation**: `typescript-specialist`, `frontend-specialist`, `backend-engineer`
- **Hook / scanner specialists**:
  - `ast-parser-specialist` — shell grammars (mvdan-sh AST), parser-tier walker patterns
  - `shell-scripting-specialist` — POSIX + bash 3.2 hook bodies, awk portability, `_lib/cmd-segments.sh`
  - `adversarial-test-specialist` — bypass corpus, sibling-class sweep methodology
- **Protocol / observability**:
  - `mcp-protocol-specialist` — Model Context Protocol mechanics, SDK usage, MCP-tier matcher semantics
  - `observability-specialist` — audit-log shape, event vocabulary, SLSA provenance pipeline
- **Designer experience**: `figma-dx-specialist` — Figma's coding surfaces (plugins, Code Connect, Variables, DTCG export); primary consumer is create-helix-app
- **Quality + docs**: `qa-engineer`, `technical-writer`

**Do NOT** use generic Agent calls without specifying a `subagent_type`.

Exception: simple read-only questions and direct clarifications may be answered without delegation.

## The Plan / Build / Review Loop

The default engineering process for non-trivial changes:

1. **Plan** — Claude Opus drafts the approach; optionally `/codex-review` against the plan before code is written
2. **Build** — Claude Opus implements; specialists (typescript, frontend, etc.) invoked as needed via the orchestrator
3. **Adversarial review** — `/codex-review` runs against the diff; result recorded in the audit log; blocking issues must be addressed before merge

This is NOT optional for changes to `/src/gateway/middleware/`, `/hooks/`, `/src/policy/`, or anything under `.github/workflows/`. CODEOWNERS enforces human review on those paths as well.

## Commit Discipline & Per-Commit Review

Work lands as **logical, manageable, connected commits — never one `git add -A` lump.** A single giant uncommitted change ("review the whole feature at once") is the anti-pattern: it can't be reviewed well by any model or human, and it overflows the cheap review lane outright (a >~400KB diff exceeds `gpt-oss-120b`'s context window and is rejected before inference).

- **Split work into coherent units.** Each commit is a *connected* set of related changes — the change AND its test, the refactor AND its callers — sized to fit a focused review (a few hundred KB of diff at most). Stage deliberately with `git add <paths>`; do NOT `git add -A` across an entire feature.
- **Review at the commit boundary.** Run `rea review` per logical commit so errors are caught in manageable units. This is the routine floor — `gpt-oss-120b` is cheap enough (~$0.0003–0.003/commit) to run on every commit, and a focused commit-sized review catches more than one skim of a giant diff, *regardless of model*.
- **The deep, impartial whole-system audit is separate** — a clean-room codex pass run OUTSIDE rea (multi-agent, HITL, its own process). rea's codex lane is the per-commit parity *check* (proving gpt-oss is good enough), NOT that audit. Never conflate the two, and never let rea pretend to be the impartial deep audit.

---

# CLAUDE.md — @bookedsolid/rea

Project-level instructions for AI agents working in the rea repository.

## Project Identity

- **What**: `@bookedsolid/rea` — agentic governance layer for Claude Code. Policy enforcement, hook-based safety gates, audit logging, and Codex-integrated adversarial review.
- **Path**: `/Volumes/Development/booked/rea`
- **GitHub**: https://github.com/bookedsolidtech/rea (**public from day one**)
- **npm**: https://www.npmjs.com/package/@bookedsolid/rea
- **License**: MIT
- **Status**: `0.9.x` published to npm with provenance (see CHANGELOG.md for per-release notes)
- **This repo dogfoods itself** — rea's governance layer enforces rea's own commit, hook, and attribution rules. The install under `.rea/`, `.claude/`, and `.husky/` is the reference example of the `bst-internal` profile.

## Stack

- TypeScript (strict) — see `tsconfig.json` and `tsconfig.build.json`
- Node 22+ (enforced by `engines.node`)
- pnpm 9.12 (enforced by `packageManager`)
- Build: `tsc -p tsconfig.build.json` → `dist/`
- Tests: vitest (`pnpm test`)
- Lint: ESLint 10 (`pnpm lint`)
- Format: Prettier 3 (`pnpm format`)
- Release: Changesets with npm provenance via GitHub Actions OIDC
- CLI framework: commander + @clack/prompts
- Schema validation: zod (strict mode — unknown fields are rejected, not ignored)
- MCP: `@modelcontextprotocol/sdk`

## Repository Layout

- `src/` — TypeScript source
  - `src/cli/` — CLI entry and commands (`rea init`, `rea serve`, `rea freeze`, `rea doctor`)
  - `src/gateway/middleware/` — middleware chain (audit, kill-switch, tier, policy, blocked-paths, rate-limit, circuit-breaker, injection, redact, result-size-cap)
  - `src/gateway/` — supervisor, live-state publisher, SESSION_BLOCKER tracker, `__rea__health` meta-tool
  - `src/policy/` — policy loader, zod schema, types
- `hooks/` — shipped shell hooks (source of truth — `rea init` copies from here)
- `agents/` — curated 23-agent roster (source of truth — `rea init` copies from here)
- `commands/` — 5 slash commands (source of truth — `rea init` copies from here)
- `profiles/` — layerable profile YAMLs (client-engagement, bst-internal, bst-internal-no-codex, lit-wc, open-source, open-source-no-codex). The `-no-codex` variants match their parents but cause `rea init` to default `review.codex_required: false`.
- `.claude/` — **this repo's own install** (dogfood): real copies of agents, commands, hooks, plus settings.json
- `.rea/` — **this repo's own policy**: `policy.yaml`, `registry.yaml`, audit log (gitignored), HALT (gitignored)

## Quality Gates (required before push)

Branch protection on `main` requires all 7 status checks to pass. Run them locally first:

```bash
pnpm lint        # ESLint — zero warnings
pnpm type-check  # tsc --noEmit (strict)
pnpm test        # vitest run
pnpm build       # tsc -p tsconfig.build.json
```

Additionally, every PR needs:

- **DCO sign-off** on all commits (`git commit -s`)
- **Changeset** entry (`pnpm changeset`) unless the change is purely non-publishable (CI, docs, meta). CI will flag missing changesets.
- **Secret scan** clean (gitleaks runs in CI and in the secret-scanner hook)

## Public Repo Discipline

This repo is **public from the first commit**. Extra rules apply because everything is permanent and visible:

- **No debugging commits** with real tokens, customer data, or private URLs — even if promptly reverted, they remain in history
- **No force-push to shared branches** — a squashed merge from a PR is the only way code lands in `main`
- **Issues and PRs are public** — do not paste private architecture diagrams, API keys, or customer names; redact before posting
- **Security reports** go through GitHub Security Advisories (see `SECURITY.md`), not public issues

## Hook & Command Reference

Hooks at `.claude/hooks/` (copied from `hooks/` by `rea init`). 15 ship in the package and ALL 15 are registered in the default `.claude/settings.json`. (Pre-0.26.0 the count was 11 ship / 11 registered; the 0.21.0 → 0.22.0 → 0.26.0 cycle added 3 new gates: `protected-paths-bash-gate.sh`, `blocked-paths-bash-gate.sh`, `local-review-gate.sh`; 0.51.0 added `billing-cap-halt.sh` — the spend-governance billing→HALT reflex.) The 0.10.x review-gate scripts (`push-review-gate.sh`, `push-review-gate-git.sh`, `commit-review-gate.sh`) and the bash push-review core were removed in 0.11.0; the push-gate is now a stateless `codex exec review` invocation wired through `.husky/pre-push` (not Claude Code hooks).

- `dangerous-bash-interceptor.sh` — blocks destructive commands (`rm -rf`, `git reset --hard`, `--no-verify`, etc.)
- `env-file-protection.sh` — blocks reads of `.env*`
- `dependency-audit-gate.sh` — verifies packages exist before install
- `security-disclosure-gate.sh` — routes security-keyword `gh issue create` to private disclosure
- `pr-issue-link-gate.sh` — advisory warn when `gh pr create` has no linked issue
- `attribution-advisory.sh` — blocks AI attribution in commits/PRs
- `protected-paths-bash-gate.sh` — Bash-tier parity with `settings-protection.sh` — refuses shell writes to `.claude/`/`.husky/`/policy paths (0.21.0+)
- `blocked-paths-bash-gate.sh` — Bash-tier parity with `blocked-paths-enforcer.sh` — refuses shell writes to `blocked_paths` policy entries (0.22.0+)
- `local-review-gate.sh` — refuses `git push` (and optionally `git commit`) until a recent `rea.local_review` audit entry covers HEAD (0.26.0+)
- `secret-scanner.sh` — scans writes/edits for credentials
- `settings-protection.sh` — guards `.claude/settings.json` and `.claude/hooks/*` edits
- `blocked-paths-enforcer.sh` — enforces `blocked_paths` from policy
- `changeset-security-gate.sh` — checks changesets for GHSA leaks and malformed frontmatter
- `architecture-review-gate.sh` — post-write architectural impact check
- `billing-cap-halt.sh` — PostToolUse Bash billing→HALT reflex (0.51.0, spend-governance E1 seed): scans a FAILED command's stderr for a provider-specific billing-class signature (spending cap / prepayment credits depleted / credit balance is too low / insufficient_quota — DISTINCT from a retryable 429; generic 402/"payment required" is a known gap until PR2's endpoint scoping) and acts per `spend_governance.billing_error_response` (seed default `warn` = banner only; `halt` = writes `.rea/HALT`; `off`)

Slash commands at `.claude/commands/`:

- `/rea` — session status: autonomy level, HALT status, recent audit entries
- `/review` — invoke `code-reviewer` on current changes
- `/codex-review` — invoke `codex-adversarial` via Codex plugin
- `/freeze` — write `.rea/HALT` with a reason
- `/halt-check` — verify middleware + hooks respect HALT

## Worktrees (multi-stream work)

Linked `git worktree` checkouts are first-class (0.54.0+): per-stream state (`last-review.json`, parity, metrics, session counters) lives in each worktree's `.rea/`; per-repository ENFORCEMENT state (`audit.jsonl`, `HALT`, the verdict cache, TOFU fingerprints) lives in the PRIMARY checkout's `.rea/`. A review of a sha in one worktree covers it everywhere; `rea freeze` freezes every stream; `rea doctor` reports the topology and flags orphaned pre-0.54.0 local state. See THREAT_MODEL §10.

## Workflow

- Work is LOCAL by default. Commit to a feature branch.
- Feature branch → PR → CI green → squash-merge to `main`. No direct commits to `main`.
- Every PR needs: DCO-signed commits, changeset (unless meta), passing CI, CODEOWNERS approval on sensitive paths.
- Release happens via the Changesets "Version Packages" PR — merging it triggers `npm publish --provenance`. Do not manually `npm publish`.

## Reference Docs

- `README.md` — install, usage, non-goals
- `SECURITY.md` — disclosure policy (72h ack, 90d window, GHSA coordination)
- `THREAT_MODEL.md` — assumptions about HALT, middleware ordering, policy evasion
- `CONTRIBUTING.md` — contributor guide + DCO
- `CODE_OF_CONDUCT.md` — Contributor Covenant
- `CHANGELOG.md` — Changesets-generated history

<!-- rea:managed:start v=1 -->

## REA Governance (managed — do not edit this block)

- **Policy**: `.rea/policy.yaml` — profile `bst-internal`
- **Autonomy**: `L1` (ceiling `L2`)
- **Blocked paths**: 5 entries — see the policy file
- **block_ai_attribution**: `true` (enforced by commit-msg hook)

Protected-path changes (`src/gateway/middleware/`, `hooks/`, `src/policy/`,
`.github/workflows/`) require a `/codex-review` audit entry before push.

### Commit Discipline & Per-Commit Review

Commit in **logical, connected, manageable units** — never `git add -A` a whole
feature. A giant diff reviews poorly (any model or human) and overflows the cheap
review lane. Stage deliberately with `git add <paths>`; each commit is one concern
plus its test, sized to a focused review. **Review at the commit boundary** — run
`rea review` per logical commit (the cheap routine floor). The deep, impartial
whole-system audit is a separate clean-room pass run OUTSIDE rea, not this lane.

Run `rea doctor` to verify the install. Run `rea check` to inspect state.

<!-- rea:managed:end -->
