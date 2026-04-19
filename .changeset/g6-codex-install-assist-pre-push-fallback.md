---
'@bookedsolid/rea': minor
---

G6 — Codex install assist at init time, and pre-push hook fallback installer.

`rea init` now probes for the Codex CLI when the chosen policy sets
`review.codex_required: true`. If Codex is not responsive, init prints a
clear guidance block pointing at the Claude Code `/codex:setup` helper
instead of silently succeeding; `/codex-review` would otherwise fail later.
In no-Codex mode the probe is skipped entirely (no wasted 2s, no confusing
output).

`rea init` also installs a fallback `pre-push` hook in the active git
hooks directory when Husky is not the consumer's primary hook path. The
fallback is a thin `exec` into `.claude/hooks/push-review-gate.sh` so
there is still exactly one implementation of the push-review logic. The
installer detects `core.hooksPath` correctly, refuses to stomp foreign
hooks (no marker → leave alone), and is idempotent across re-runs.

`rea doctor` gains a "pre-push hook installed" check that requires an
executable pre-push at whichever path git is actually configured to fire
(`.git/hooks/pre-push` by default, or the configured `core.hooksPath`).
A `.husky/pre-push` alone — without `core.hooksPath=.husky` — no longer
satisfies the check, closing the 0.2.x dogfooding gap where protected-
path Codex audit enforcement could be silently bypassed.

Non-goals (explicitly out of scope for G6): the `push-review-gate.sh`
logic itself is unchanged, the protected-path regex is unchanged, and no
middleware was moved.
