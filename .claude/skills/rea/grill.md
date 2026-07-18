---
name: grill
description: "ALIGN before building. Interview the operator until goal, scope, constraints, and done-definition are shared, then record the decisions durably as a CONTEXT/ADR artifact. Degrades: a single smart-zone task skips straight to implement — no ceremony on trivial work. First step of the spine."
argument-hint: "<what you want to build>"
allowed-tools:
  - Read
  - Write
  - Bash(rea tasks:*)
  - Bash(git status:*)
  - Bash(git log:*)
---

# grill — Align Before Building

`grill` is the alignment front-end of the process spine. It exists to kill the most expensive failure mode: an agent that builds the wrong thing because the goal was never pinned down. You interview the operator until there is genuine shared understanding of the work, then you write the decisions down where a fresh context window can resume from them.

The spine is: **align → spec → slice → implement → review.** `grill` is *align*. It produces durable understanding, not code.

## The degrade rule (read this first)

Over-ceremony on trivial work is the documented process-killer. Before interviewing, judge the size of the work:

- **Single smart-zone task** — a one-line fix, a rename, a well-specified change that fits one clean context and has no open decisions → **skip the interview. Say so plainly and go straight to `implement`.** Do not manufacture questions. Do not open a spec.
- **Fuzzy or large work** — open decisions, unclear scope, spans multiple context windows, or research needed → this is `wayfinder` territory, not a single grill. Hand off to `wayfinder`.
- **Everything in between** — a known-shaped task with a few real unknowns → run the grill below.

If you are unsure whether the work is trivial, ask one framing question and let the answer decide.

## What alignment means

You are done grilling when all four of these are shared and written down:

1. **Goal** — the outcome in the operator's terms, and *why* it matters. Not the implementation.
2. **Scope** — what is explicitly in, and what is explicitly out. Naming the out-of-scope is as important as the in.
3. **Constraints** — house rules, standards, budgets, deadlines, gated paths, non-negotiables.
4. **Done-definition** — how you will both know it is finished, and what evidence will prove it (this becomes the verification artifact later).

## The interview

- Ask **one decision at a time.** Resolve real forks — not to demonstrate thoroughness, but because each unresolved fork is a place the build can go wrong.
- Surface hidden assumptions. When the operator says something ambiguous, reflect it back concretely and confirm.
- Prefer **concrete examples** over abstract preference questions ("should it look like X or Y?" beats "what style do you want?").
- Stop when the four items above are settled. Alignment is a state, not a word count. Do not keep asking once you have shared understanding.

## Recording the decisions

Alignment that is not written down evaporates at the next context boundary. Record the resolved decisions as a durable artifact:

- Write a **CONTEXT** or **ADR-style** note capturing goal, scope, constraints, done-definition, and every fork you resolved (decision + the rationale). This is the raw material `to-spec` compresses.
- Register the work on the tracker so the spine has a spine-of-record. The tracker is **`.rea/tasks.jsonl`**, managed only through the `rea tasks` CLI:

  ```bash
  rea tasks add --subject "<goal in one line>" --requires-spec
  ```

  Use `--requires-spec` when the work is non-trivial — it signals that the spec gate applies before implement-phase commits.

## Handoff

When alignment is reached, the next step depends on the work:

- **Normal work** → `to-spec` (compress this discussion into one durable spec document).
- **Policy-gated / HITL / governance work** → still `to-spec`, but the spine **halts at the spec** and waits for human ratification. Do not auto-advance to `to-tickets` or `implement` on gated work. State this to the operator.
- **Trivial work** (the degrade case) → `implement` directly, no spec.

## Boundaries (skills orchestrate, hooks gate)

`grill` never touches enforcement. It does not modify `.rea/policy.yaml`, HALT, hooks, or any gate. If a rea gate or HALT is active, `grill` still runs — alignment and recording are always safe — but it never instructs the agent around a gate. Enforcement is the hooks' job; `grill`'s job is shared understanding.
