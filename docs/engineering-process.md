# Engineering process (0.26.0+)

The rea engineering process codifies the working-tree → fix → review →
squash → push (green) → PR cycle. CTO directive 2026-05-05 makes this
the **default** for all rea work — OSS, enterprise, internal, consumer.

## The loop

```
    edit working tree
         |
         v
   +-> rea review  <-+ blocking
   |     |           | findings?
   |     v           |
   |   pass / only-P3
   |     |           ^
   |     v           |
   |   commit (squashed) — DCO-signed
   |     |
   |     v
   |   git push
   |     |
   |     v   refused?
   +-- husky pre-push runs
          (rea preflight --strict, then push-gate)
          |
          v
        green-first-try PR
```

## Why this order

The push-gate (`.husky/pre-push` → `codex exec review`) is the LAST
defense, not the FIRST. By the time it runs:

- The diff is committed.
- Fixing findings means amending or stacking fix-commits.
- The reviewer (human or agent) sees a chain of "fix codex finding"
  commits in the PR.

Local-first review reverses the loop: codex sees the diff in the
working tree. Findings get fixed in-place. The result that lands in
the PR is a single squashed commit with no review-cycle noise.

The pattern is dogfooded by `bookedsolidtech/rea` itself across
0.23.1, 0.24.0, 0.25.0 — all green-first-try, no PR-comment
iteration. 0.26.0 codifies it for everyone.

## The three enforcement layers

`rea preflight` is the workhorse all three layers call. Each layer
has a different audience:

| Layer | Catches | Audience |
| ----- | ------- | -------- |
| `local-review-gate.sh` (Bash-tier PreToolUse hook) | Agent's `git push` / `git commit` from Claude Code's Bash tool | AI agents |
| `.husky/pre-push` | `git push` from terminal, CI, scripts | Humans + CI |
| `rea preflight` (direct CLI) | Manual status check | Operators |

The Bash-tier hook is the **forceful** layer for agents — Claude
Code's PreToolUse hooks fire BEFORE the command runs. An agent that
tries `git push` is stopped HERE, before husky even sees the push.

## When the push-gate still fires

The push-gate (codex on push) is the BACKUP layer. It runs AFTER
preflight when preflight passes. Defense-in-depth: a forged audit
entry, a clock-skew slip, or a freshly-installed override that hasn't
been re-reviewed all get caught by the push-gate's fresh codex run.

Disable the push-gate via `policy.review.codex_required: false` —
that's separate from the local-review off-switch
(`policy.review.local_review.mode: off`). Different concerns, different
knobs.

## Audit log surface

- `rea.local_review` — the canonical entry. `rea preflight` accepts
  this as covering HEAD when sha + age + verdict all check out.
- `rea.local_review.skipped_override` — emitted by `rea preflight`
  when `REA_SKIP_LOCAL_REVIEW` was set; reason recorded verbatim.
- `rea.local_review.skipped_unavailable` — emitted by `rea review`
  when codex is missing AND `mode: off`; the no-op is forensically
  visible.
- `rea.preflight.review_skipped` — emitted by `rea preflight` when
  `--no-review-check` was passed; commit-hygiene check still runs.
- `codex.review` — pre-0.26.0 audit entries from the legacy gateway
  path. `rea preflight` accepts these too for back-compat.

## Codex review invocation pattern (0.27.0+)

Use `rea hook codex-review` (the bundled CLI) or invoke `codex exec
review --json --ephemeral` directly. The `codex-adversarial` agent and
`/codex-review` slash command default to the thin-shim pattern. Do
NOT use the verbose wrapper unless you specifically need
Claude-paraphrased findings (e.g., teaching context for someone
unfamiliar with codex JSON shape).

The CLI handles iron-gate model defaults (`gpt-5.4` + `high`
reasoning), raw-JSONL tee to `$TMPDIR/rea-codex-<sha>-<nonce>.json`,
audit-entry writing (`codex.review` shape), and verdict-to-exit-code
mapping (0 pass / 1 concerns / 2 blocking). The stderr line is a
breadcrumb pointing to the raw JSON; the raw JSON is the review.

Token cost note: each wrapper-agent codex round = 3 Opus turns; the
direct-Bash pattern = 1 Opus turn. Marathon mode prefers direct.

For the local-first gate-friendly flow, use `rea review` — it writes
`rea.local_review` (the entry the gate consults) and produces
human-readable output. `rea hook codex-review` writes `codex.review`
(the legacy gateway shape) and is designed for thin-shim agent
invocation. Both run codex with the same iron-gate defaults; choose
based on which audit entry the downstream gate is looking for.

## Provider seam (deferred)

`rea.local_review` records carry a `provider:` field. Today the only
writer is `rea review` with `provider: 'codex'`. Future writers
(Claude-subagent reviewer, Pi, Gemma) will write the SAME shape with
their own provider name; `rea preflight` accepts any. There is NO
registry, NO factory, NO swap mechanism — the audit-record shape IS
the seam.

The full provider abstraction (`ReviewProvider` interface + registry
+ factory) is deferred to 0.27.0+.
