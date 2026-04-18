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

- `code-reviewer`, `codex-adversarial` — review / adversarial review
- `security-engineer`, `accessibility-engineer` — domain-specific review
- `typescript-specialist`, `frontend-specialist`, `backend-engineer` — implementation
- `qa-engineer`, `technical-writer` — testing and documentation

**Do NOT** use generic Agent calls without specifying a `subagent_type`.

Exception: simple read-only questions and direct clarifications may be answered without delegation.

## The Plan / Build / Review Loop

The default engineering process for non-trivial changes:

1. **Plan** — Claude Opus drafts the approach; optionally `/codex-review` against the plan before code is written
2. **Build** — Claude Opus implements; specialists (typescript, frontend, etc.) invoked as needed via the orchestrator
3. **Adversarial review** — `/codex-review` runs against the diff; result recorded in the audit log; blocking issues must be addressed before merge

This is NOT optional for changes to `/src/gateway/middleware/`, `/hooks/`, `/src/policy/`, or anything under `.github/workflows/`. CODEOWNERS enforces human review on those paths as well.

---

# CLAUDE.md — @bookedsolid/rea

Project-level instructions for AI agents working in the rea repository.

## Project Identity

- **What**: `@bookedsolid/rea` — agentic governance layer for Claude Code. Policy enforcement, hook-based safety gates, audit logging, and Codex-integrated adversarial review.
- **Path**: `/Volumes/Development/booked/rea`
- **GitHub**: https://github.com/bookedsolidtech/rea (**public from day one**)
- **npm**: https://www.npmjs.com/package/@bookedsolid/rea
- **License**: MIT
- **Status**: `0.1.0` published 2026-04-18 with npm provenance
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
  - `src/gateway/middleware/` — 12-layer middleware chain (audit, kill-switch, tier, policy, blocked-paths, rate-limit, circuit-breaker, redact, injection, result-size-cap)
  - `src/policy/` — policy loader, zod schema, types
- `hooks/` — shipped shell hooks (source of truth — `rea init` copies from here)
- `agents/` — curated 10-agent roster (source of truth — `rea init` copies from here)
- `commands/` — 5 slash commands (source of truth — `rea init` copies from here)
- `profiles/` — layerable profile YAMLs (client-engagement, bst-internal, lit-wc, open-source)
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

Hooks at `.claude/hooks/` (copied from `hooks/`, pinned by `.claude/settings.json`):

- `dangerous-bash-interceptor.sh` — blocks destructive commands (`rm -rf`, `git reset --hard`, `--no-verify`, etc.)
- `env-file-protection.sh` — blocks reads of `.env*`
- `dependency-audit-gate.sh` — verifies packages exist before install
- `security-disclosure-gate.sh` — checks disclosure policy compliance
- `pr-issue-link-gate.sh` — requires issue reference on PR creation
- `attribution-advisory.sh` — blocks AI attribution in commits/PRs
- `secret-scanner.sh` — scans writes/edits for credentials
- `settings-protection.sh` — guards `.claude/settings.json` edits
- `blocked-paths-enforcer.sh` — enforces `blocked_paths` from policy
- `changeset-security-gate.sh` — checks changesets for secret leakage
- `architecture-review-gate.sh` — post-write architectural impact check
- `commit-review-gate.sh`, `push-review-gate.sh` — pre-commit/pre-push review gates

Slash commands at `.claude/commands/`:

- `/rea` — session status: autonomy level, HALT status, recent audit entries
- `/review` — invoke `code-reviewer` on current changes
- `/codex-review` — invoke `codex-adversarial` via Codex plugin
- `/freeze` — write `.rea/HALT` with a reason
- `/halt-check` — verify middleware + hooks respect HALT

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
