---
name: implement
description: "Execute ONE ticket at a time in a clean context, built against the spec, then close it with recorded evidence via rea tasks (evidence BEFORE complete). Clears context between tickets to stay in the smart zone. If a rea gate, drift-check, or HALT fires, PARKS the work as an artifact awaiting a verdict — never bypasses, never prompts mid-run."
argument-hint: "<ticket id>"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Agent
---

# implement — Build One Ticket, Clean Context, Verified Close

`implement` is the *build* stage of the spine. It executes **one ticket at a time**, in a clean context, against the spec — and closes the ticket only with recorded evidence. It is the workhorse; the discipline that makes it work is *smallness and freshness*.

## One ticket, one clean context

- Pick a **single unblocked ticket** from the tracker (`rea tasks list`). If it is blocked, resolve or pick a different one — do not build ahead of dependencies.
- Load the **spec** the ticket references (`--spec` path) and the ticket's own done-definition. Build to the spec, not to memory of the conversation.
- **Clear context between tickets.** Do not carry one ticket's working set into the next. Each ticket starts fresh so every unit runs in the smart zone where the model is sharp. The spec + ticket are the durable artifacts that make a cold start possible.

Mark the ticket in-flight as you go:

```bash
rea tasks start T-0004
rea tasks activate T-0004
```

## The degrade case

If you arrived here directly from `grill`'s degrade branch — a single smart-zone task with no spec — just do the work and verify it. The ceremony is proportional to the work; a trivial fix does not need a spec to point at. Everything below about evidence-before-close still applies.

## Verify, then close — evidence before complete

A ticket is not done because the code was written. It is done when there is **evidence it works.** The tracker enforces this: `rea tasks complete` **refuses** unless the ticket carries non-blank evidence. So the close sequence is always two steps, in order:

```bash
# 1. Record the verification artifact(s) FIRST
rea tasks evidence T-0004 --add artifacts/T-0004/test-output.txt
rea tasks evidence T-0004 --add artifacts/T-0004/verify-transcript.md

# 2. Only then close
rea tasks complete T-0004
```

Evidence is a real artifact: test output, a verify-run transcript, a render or screenshot directory, a migration diff. Not a claim — a file. Produce it, record its path with `rea tasks evidence`, and only then `rea tasks complete`. Never invent a path; the file must exist.

## Gates and HALT — PARK, never bypass (non-negotiable)

Skills orchestrate; hooks gate. `implement` drives work up to the gates and **stops at them.** It must never route the agent around a rea hook, a gate, the drift-check, or HALT.

When a gate refuses, a drift-check fails, or HALT is active:

1. **Do not retry with a bypass.** No `--no-verify`, no disabling a hook, no editing policy, no working in a way designed to slip past the check. Those are prohibited and hook-enforced regardless.
2. **Park the work as an artifact.** Leave the ticket on the tracker with its current state and any evidence gathered; record what the gate said. The work now awaits a verdict or ratification.
3. **Do not prompt a human mid-run.** This is overnight-safe by design: unattended agents surface only *true blockers* into the review queue, they do not fire an interactive prompt that would stall an overnight run. Park it and move to the next unblocked ticket, or stop cleanly if none remain.

A gate that stops you is the system working, not an obstacle. The parked artifact is the handoff to human review.

## Handoff

When a ticket closes with evidence, the implementation is ready for `code-review` — a fresh-eyes pass against the spec. Then move to the next unblocked ticket in its own clean context.

## Boundaries

`implement` writes code and evidence and drives `rea tasks`. It does not modify `.rea/policy.yaml`, HALT, hooks, or gate configuration under any circumstance. Enforcement is the hooks' job; `implement`'s job is to build the ticket and prove it works — or park it when a gate says wait.
