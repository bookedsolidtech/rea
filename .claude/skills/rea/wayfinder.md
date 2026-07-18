---
name: wayfinder
description: "ALIGN for fuzzy or large work. Orchestrate over grilling sessions: chart a map of decision-tickets (resolved by a decision) vs implementation-tickets (resolved by code), fan out research sub-agents, run throwaway prototype tickets, and schedule new tickets mid-session. Degrades to a single grill when the work turns out small."
argument-hint: "<the fuzzy idea or large effort>"
allowed-tools:
  - Read
  - Write
  - Agent
  - Bash(rea tasks:*)
  - Bash(git status:*)
  - Bash(git log:*)
---

# wayfinder — Chart the Way Through Fuzzy Work

`wayfinder` is `grill` on steroids: the alignment front-end for work that is too big or too uncertain for a single interview. Where `grill` resolves a known-shaped task, `wayfinder` **orchestrates over many grilling sessions** to find the way through an idea whose shape is not yet known — a new book concept, a new campaign, a schema split, a migration that spans sessions.

It is still an *align* stage. It produces a resolved decision map and a set of crisp tickets that feed `to-spec`. It does not write production code (though it may write throwaway prototypes to answer a question).

## The degrade rule (read this first)

If, once you start charting, the work turns out to be small — one context window, few open decisions — **stop orchestrating and degrade to a single `grill`.** Do not build a map for a task that fits one interview. Wayfinder's whole value is proportional to uncertainty; spend it only where uncertainty is real.

## The map

Wayfinder's core artifact is a **map of tickets**. Two kinds, and the distinction is load-bearing:

- **Decision-tickets** — resolved by *making a decision*. "Which format?" "One edition or two?" "Which ref moves where?" These are the forks that block everything downstream. Resolve them with the operator (a focused grill each) or with research.
- **Implementation-tickets** — resolved by *writing code / producing the artifact*. These depend on decision-tickets being closed first.

Record both on the tracker — **`.rea/tasks.jsonl`** via the `rea tasks` CLI — so the frontier survives context boundaries:

```bash
rea tasks add --subject "DECISION: <the fork>"
rea tasks add --subject "IMPL: <the unit>" --requires-spec --blocked-by T-0001
```

Use `--blocked-by` to encode the dependency edges: an implementation-ticket is blocked by the decisions it waits on. Use `rea tasks list` to see the frontier at any time.

## Fanning out research

Decision-tickets often need evidence before they can be resolved. Research is cheap to parallelize — fan it out:

- Spawn **research sub-agents** (via `Agent`) to investigate open questions concurrently. Each returns findings; you fold them into the relevant decision-ticket.
- Keep research sub-agents scoped to *one question each* so their context stays in the smart zone and their answers stay crisp.

## Prototype tickets

Some decisions are best answered by *seeing*, not arguing. A **prototype ticket** produces a **throwaway A/B artifact** — two quick variants of a UI, a layout, a voice, a hook — solely to answer "what should this be?" Prototypes are explicitly disposable: they inform a decision and are then discarded, never merged. Mark them clearly so no one mistakes a prototype for the real build.

## Scheduling mid-session

When you spot work you cannot tackle right now — an adjacent decision, a follow-up, a risk to investigate later — **schedule it as a new ticket immediately** rather than holding it in context. `rea tasks add` it and move on. The tracker is your working memory; keep the live context in the smart zone.

## Convergence and handoff

You are done when every decision-ticket is resolved and the implementation-tickets form a coherent, dependency-ordered set. Then:

- **Normal work** → `to-spec` compresses the resolved map into one durable spec, then `to-tickets` finalizes the sliced units.
- **Policy-gated / HITL / governance work** → the spine **halts at the spec** for human ratification. Do not auto-advance into implement.

## Boundaries (skills orchestrate, hooks gate)

Wayfinder orchestrates; it never enforces. It does not modify policy, HALT, hooks, or gates, and it never routes an agent around one. Research and prototyping happen inside the same governance envelope as everything else — if a gate or HALT is active, wayfinder parks affected work as an artifact on the tracker and keeps charting what is safe, rather than prompting a human mid-run.
