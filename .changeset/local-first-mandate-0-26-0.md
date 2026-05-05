---
'@bookedsolid/rea': minor
---

Local-first delegation enforcement (CTO directive 2026-05-05, applies to ALL rea work — OSS + enterprise).

Forceful enforcement at three layers:

- Bash-tier PreToolUse hook (`local-review-gate.sh`): refuses `git push`/`git commit` from Claude Code's Bash tool when no recent local-review audit entry matches HEAD.
- Husky pre-push: bumped to v5 markers; runs `rea preflight --strict` BEFORE the push-gate dispatch. Refuses `git push` at the terminal layer (humans + CI).
- New `rea preflight` CLI: the workhorse all enforcement layers call.

New CLIs:

- `rea review`: runs codex review on the working tree, writes the canonical `rea.local_review` audit entry that `rea preflight` consults.
- `rea preflight`: checks audit log + commit count; exit 0/1/2.

Per-team off-switch via `policy.review.local_review.mode: 'enforced' | 'off'` (default `enforced`). Teams without codex/claude installed set `mode: off` to disable enforcement cleanly.

Per-invocation override via `REA_SKIP_LOCAL_REVIEW=<reason>` env-var (logged to audit).

Light provider seam: `rea.local_review` audit-record shape includes a `provider:` field so future reviewers (Claude-subagent, Pi, Gemma, etc.) write the same shape. NO registry, NO swap mechanism — that's 0.27.0+ territory.

Migration: existing consumers default to `mode: enforced` after upgrade. Teams without codex must set `mode: off` in their `policy.yaml` BEFORE upgrading or `git push` will refuse with a helpful message naming the off-switch. See `docs/migration/0.26.0.md`.

### Known limitations / 0.27.0 follow-ups

- Repositories whose default branch is `develop` (or any non-`main`/`master`) but whose `origin/HEAD` symbolic-ref is unset silently disable preflight's commit-count safety check (the auto-narrow trigger relies on `origin/HEAD` to resolve the upstream tip). Workaround for affected repos: `git remote set-head origin -a`. `rea doctor` will surface this as an advisory in 0.27.0.
- When the most recent local-review entry for HEAD's content-token has verdict `blocking`, `rea preflight` currently prints "no recent local-review audit entry covers HEAD" rather than "your last review was blocking — address findings or override." Cosmetic copy improvement, no security impact; tracked for 0.27.0.
