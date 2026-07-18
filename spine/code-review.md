---
name: code-review
description: "Fresh-eyes review of an implementation against its SPEC and against house standards, in a clean context — the reviewer did not write the work. Two axes: spec-conformance and standards-conformance. Prose-aware (books and documents are first-class). Produces a diagnosis for the review queue; never auto-fixes past a gate."
argument-hint: "<ticket id or diff target>"
allowed-tools:
  - Read
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(rea tasks:*)
  - Agent
---

# code-review — Fresh Eyes, Against the Spec

`code-review` is the *review* stage of the spine. It checks an implementation with **fresh eyes in a clean context** — crucially, the reviewer is *not* the context that wrote the work. Models are bad at reviewing what they just produced ("I wrote it, so it's fine"); a clean-context reviewer comparing the diff to the original spec catches what the ticket missed.

## The two axes

Every review runs against **two axes**, both anchored in the spec, not in taste:

1. **Spec-conformance** — does the implementation do what the spec said? Right scope, locked decisions honored, done-definition met, nothing out-of-scope smuggled in? Load the ticket's `--spec` and read the diff against it.
2. **Standards-conformance** — does it obey the house rules? The standards axis is the constraints/standards section of the spec plus the repo's standing conventions (for code: type-safety, security, accessibility, performance; for prose: the house editorial rules).

Report findings on both axes. A finding names what, where, severity, and the spec or standard it violates.

## Prose-aware — books and documents are first-class

This review is not code-only. A manuscript *is* a spec; a chapter *is* a ticket. When the artifact is prose — a book chapter, a governance instrument, campaign copy — review it the same way:

- **Spec axis:** does the chapter match the outline, voice, audience, and structural decisions the spec locked?
- **Standards axis:** the house prose rules (copyright-page rules, page-background rules, writeability standard, signature-block rules, crisis-content rules — whatever the spec's standards section names).

The mechanics are identical; only the standards file differs.

## Diagnosis, not auto-fix

`code-review` **produces a diagnosis for review** — it does not regenerate or auto-fix past a gate. This honors the review-gate-before-regen law: the review is input to a human (or to a follow-up `implement` ticket), never an autonomous rewrite that slips a gate. Output structured findings and a verdict (pass / concerns / blocking). If findings warrant rework, they become the basis for a new ticket, not an in-place silent rewrite.

## Evidence and the tracker

A completed review is itself verification evidence. When the review is the artifact that proves a ticket is done, record it before closing — evidence before complete, always:

```bash
rea tasks evidence T-0004 --add artifacts/T-0004/review.md
rea tasks complete T-0004
```

`rea tasks complete` refuses without recorded evidence; the review transcript is a legitimate evidence artifact. Never close a ticket on an unrecorded review.

## Overnight-safe and gate-respecting

- Run unattended: produce the diagnosis, park it as an artifact in the **review queue**, and surface only *true blockers*. Do not fire an interactive prompt mid-run.
- Skills orchestrate; hooks gate. `code-review` never modifies policy, HALT, hooks, or any gate, and a `pass` verdict from this skill never launders past an authoritative gate — if a gate says wait, the work waits, review verdict notwithstanding.

## Handoff

- **Pass** → the ticket's work is ready to proceed to its next gate (e.g. the push/review gate) with the review recorded as evidence.
- **Concerns / blocking** → open a follow-up ticket via `to-tickets`/`rea tasks` describing the rework; `implement` picks it up in a fresh context. The loop closes cleanly without ever bypassing a gate.
