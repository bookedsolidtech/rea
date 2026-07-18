---
name: to-spec
description: "Compress an aligned discussion into ONE durable spec document — the single destination that replaces scattered config, memory, and head-of-session re-briefing. A fresh context window resumes from this file alone. For policy-gated or HITL work, the spine HALTS here and waits for human ratification before any implement."
argument-hint: "[ticket id or context path]"
allowed-tools:
  - Read
  - Write
  - Bash(rea tasks:*)
  - Bash(git status:*)
---

# to-spec — Compress Alignment Into One Durable Spec

`to-spec` is the *spec* stage of the spine. It takes the shared understanding produced by `grill` or `wayfinder` and compresses it into **one durable destination document** — the single source a fresh context window reads to know exactly what to build and why.

This is the multi-session bridge. Under a metered turn/time budget, long work must survive session boundaries. The spec is the artifact that lets it: instead of re-briefing the agent at the head of every session, or scattering intent across config files, memory notes, and chat history, there is **one file**.

## What the spec replaces

- Scattered config (`book.yaml`, ad-hoc settings) → the locked decisions live in the spec.
- Memory notes about work-in-flight → the spec is the work-in-flight record; memory returns to durable *facts*.
- Head-of-session re-briefing → the fresh window reads the spec and is caught up.

## What goes in

A good spec is complete enough that a clean context could implement from it without re-interviewing the operator. Include:

- **Goal & rationale** — the outcome and why it matters.
- **Scope** — in and, explicitly, out.
- **Locked decisions** — every fork `grill`/`wayfinder` resolved, with its rationale. This is the heart of the spec; it is what prevents re-litigation.
- **Constraints & standards** — house rules, budgets, gated paths, the standards axis a later `code-review` will check against.
- **Done-definition & evidence** — how completion is judged, and what verification artifacts will prove it.
- **Open items** — anything deliberately deferred, so the reader knows it was a choice, not an omission.

Keep it **one document**. If it wants to become many, the work wants slicing — that is `to-tickets`, not more specs.

## Where it lives

Write the spec as a durable, in-repo, committed file (a spec path under the repo's docs/spec convention). Then bind it to the tracker so the gates can see it. The tracker is **`.rea/tasks.jsonl`**, via the `rea tasks` CLI:

```bash
rea tasks add --subject "<goal>" --requires-spec --spec docs/specs/<name>.md
```

The `--spec` reference is what the spec gate reads: a non-trivial task must point at a spec file that exists and is committed before implement-phase commits proceed. `to-spec` produces exactly that artifact.

## The governance halt (non-negotiable)

For **policy-gated, HITL, or governance work** — anything a rea gate covers, or legal/policy instruments, or work on live surfaces — **the spine stops here.** `to-spec` produces the spec and then **waits for explicit human ratification.** It does not auto-advance to `to-tickets` or `implement`. State this to the operator plainly: the spec is ready for review; nothing will be sliced or built until a human ratifies it.

This is deliberate. The spec is the safe stopping point where a human reviews *intent* before any irreversible action. Skipping it on gated work defeats the reason the gate exists.

## Handoff

- **Normal work, spec written** → `to-tickets` (slice the spec into context-window-sized units).
- **Gated work** → stop; surface the spec for ratification; do not proceed.

## Boundaries (skills orchestrate, hooks gate)

`to-spec` writes a document and a tracker entry. It never modifies policy, HALT, hooks, or any gate, and it never advances gated work past the ratification point on its own authority. If a gate or HALT is active, the spec is still safe to write — it parks the work as an artifact awaiting a verdict, which is exactly the point.
