---
'@bookedsolid/rea': minor
---

Roster expansion Wave 1 — 3 Principals + 1 Architect (CTO eval recommendation).

Adds 4 new specialist agents to the default rea kit, propagated to consumer
.claude/agents/ via the existing `rea init`/`rea upgrade` mirror:

- principal-engineer — cross-module structural decisions, architectural pivots
- principal-product-engineer — consumer signal → engineering priority
- release-captain — release readiness, breaking-change disclosure, rollback
- security-architect — threat model, trust boundaries, defense-in-depth

Also updates agents/rea-orchestrator.md routing brief to include the four
new agents. New smoke test in __tests__/agents/ verifies frontmatter parses
on every agent file and orchestrator routing references every file.

Wave 2 (4 architects) targets 0.25.0; Wave 3 (5 specialists) targets 0.26.0
per the CTO eval rollout plan.
