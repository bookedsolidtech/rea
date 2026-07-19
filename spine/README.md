# The Process Spine

The **spine** is a small set of house-native skills that give agent work a disciplined,
repeatable shape: **align → spec → slice → implement → review.** It ships as a payload
inside every rea-consuming repo, alongside the governance layer.

Its whole job is to kill four failure modes: building the wrong thing (misalignment),
re-explaining context every session (verbosity), shipping work that does not function
(no feedback loop), and design decay over time. The spine turns a vague sentence into a
durable spec, sized tickets, verified builds, and a fresh-eyes review — with artifacts at
every boundary so a clean context window can always resume.

## The six skills

| Stage | Skill | What it does |
|---|---|---|
| align | **grill** | Interview the operator until goal, scope, constraints, and done-definition are shared; record decisions durably. |
| align (fuzzy) | **wayfinder** | For large/uncertain work: chart a map of decision-tickets vs implementation-tickets, fan out research, run throwaway prototypes, schedule tickets mid-session. |
| spec | **to-spec** | Compress the aligned discussion into ONE durable spec document. |
| slice | **to-tickets** | Cut the spec into context-window-sized tickets with blocking dependencies. |
| implement | **implement** | Build ONE ticket at a time in a clean context, against the spec; close with recorded evidence. |
| review | **code-review** | Fresh-eyes review against the spec and house standards. Prose-aware. |

The flow, end to end:

```
grill  OR  wayfinder      ← ALIGN: interview until shared understanding, recorded as artifacts
   → to-spec              ← compress into one durable destination doc  (gated work HALTS here for ratification)
      → to-tickets        ← slice into smart-zone units with blocking deps
         → implement      ← build one ticket, clean context, evidence-before-close
            → code-review ← fresh sub-agent checks work vs SPEC and vs STANDARDS
               → human review
```

## Degrade to "just do it"

The spine is not ceremony for its own sake. Over-processing a trivial change is the
fastest way to make a team abandon process — so the spine **degrades**:

- A **single smart-zone task** (a one-line fix, a rename) skips straight to `implement`.
  `grill` says so itself and does not manufacture an interview.
- `wayfinder` degrades to a single `grill` when the work turns out small.

Match the ceremony to the work. Big, fuzzy, expensive-if-wrong work earns the full spine;
trivial work does not.

## Skills orchestrate, hooks gate

This is the non-negotiable boundary. The spine **orchestrates** work — it decides what to
do next and in what order. rea's **hooks enforce** — HALT, the artifact gates, the
drift-check, blocked paths, attribution. **No skill may route an agent around a hook.**

When a skill hits a gate — a gate refuses, a drift-check fails, HALT is active — it
**parks the work as an artifact awaiting a verdict or ratification.** It never bypasses a
gate, and it never fires an interactive prompt mid-run. The spine is **overnight-safe**:
unattended agents work, park true blockers into the review queue, and surface those —
nothing ships without the gate it was waiting on.

Two consequences worth stating plainly:

- **Governance / HITL work stops at the spec.** For policy-gated work, the spine halts at
  `to-spec` and waits for explicit human ratification — it does not auto-implement.
- **A `pass` from `code-review` never launders past an authoritative gate.** The review is
  a diagnosis for the queue, not an autonomous merge.

## The tracker

The spine's shared state — tickets, dependencies, evidence — lives in **`.rea/tasks.jsonl`**,
managed only through the **`rea tasks`** CLI (`add`, `start`, `activate`, `evidence`,
`complete`, `list`, `show`). Never hand-edit the store, and never use the legacy `.reagent/`
path — that naming is dead.

Closing a ticket requires **evidence before complete**: record a real verification artifact
with `rea tasks evidence <id> --add <path>`, *then* `rea tasks complete <id>`. The CLI
**refuses** to complete a ticket with no evidence — the verification invariant is enforced at
the tool, not left to the model's judgment.
