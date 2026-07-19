---
name: to-tickets
description: "Slice a ratified spec into context-window-sized tickets — one smart-zone each — with blocking dependencies, recorded on the .rea/tasks.jsonl tracker via the rea tasks CLI. Each ticket is a unit a fresh context can implement and verify on its own. The durable frontier the spine resumes from."
argument-hint: "<spec path or ticket id>"
allowed-tools:
  - Read
  - Bash(rea tasks:*)
  - Bash(git status:*)
---

# to-tickets — Slice the Spec Into Smart-Zone Units

`to-tickets` is the *slice* stage of the spine. It takes a spec and cuts it into **tickets sized to one smart zone each** — units small enough that a fresh context window can hold the whole thing, build it, and verify it without attention degrading.

The unit of work is not "the feature" and not "the file." It is "as much as one clean context can do well." Below that ceiling the model is sharp; above it, quality decays. Every ticket is drawn to fit under it.

## What makes a good ticket

- **One smart-zone.** A ticket a fresh window can pick up cold, hold entirely in context, and finish. If it is too big to hold, it is too big to be one ticket — split it.
- **One concern.** A ticket plus its verification, not three unrelated changes bundled for convenience.
- **Independently verifiable.** The ticket carries its own done-definition, drawn from the spec, so `implement` knows what evidence closes it.
- **Ordered by dependency, not by wishful parallelism.** If ticket B needs a decision or artifact from ticket A, encode the edge.

## Recording on the tracker

The tracker is **`.rea/tasks.jsonl`**, managed only through the `rea tasks` CLI. Never hand-edit the store; never use the legacy `.reagent/` path. Create each ticket:

```bash
rea tasks add --subject "<one smart-zone unit>" --spec docs/specs/<name>.md --requires-spec
```

Encode blocking dependencies so the frontier is ordered:

```bash
rea tasks add --subject "<dependent unit>" --spec docs/specs/<name>.md --blocked-by T-0004 T-0007
```

- `--spec` binds every ticket back to the durable spec, so the spec gate and any resuming context can find the source of truth.
- `--requires-spec` marks non-trivial tickets so the spec gate applies to their implement-phase commits.
- `--blocked-by` records the dependency edges. Use `rea tasks list` to read the frontier and see what is unblocked and ready.

## Precondition

Only slice a spec that is **ready to build.** For policy-gated / HITL / governance work, that means the spec has been **ratified by a human** (see `to-spec`). Do not slice, and do not create implementation tickets, for gated work that has not been ratified — slicing is the first step past the ratification halt, and it must not happen automatically.

## Handoff

Once the tickets exist and their dependencies are encoded, hand off to `implement`, which executes them **one at a time**, each in a clean context, closing each with recorded evidence.

## Boundaries (skills orchestrate, hooks gate)

`to-tickets` reads a spec and writes tracker entries through `rea tasks`. It never modifies policy, HALT, hooks, or any gate. It creates the units the gates later read; it does not enforce anything itself. If a gate or HALT is active, the tickets still park safely on the tracker as artifacts awaiting their turn.
