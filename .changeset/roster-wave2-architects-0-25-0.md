---
'@bookedsolid/rea': minor
---

Roster expansion Wave 2 — 3 Architects (CTO eval recommendation).

Adds 3 new architect agents to the default rea kit, propagated to consumer
.claude/agents/ via the existing rea init/upgrade mirror:

- data-architect — schema, migrations, data-flow boundaries (audit log, policy.yaml)
- platform-architect — CI / build / packaging / publish pipeline integrity
- devex-architect — consumer install experience, doctor diagnostics, error messages

Also updates agents/rea-orchestrator.md routing brief to include the three
new agents in the Architects tier (count 14 → 17). Smoke test extended
with Wave 2 regression pin.

Wave 1 (3 Principals + security-architect) shipped in 0.24.0.
Wave 3 (5 Specialists) targets 0.26.0.
