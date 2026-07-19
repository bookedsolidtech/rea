---
'@bookedsolid/rea': minor
---

Budget enforcement — make the turn-budget real (Artifact Gates spec §5). Adds an
optional `spend_governance.turn_budget` policy block (`warn_turns`, `halt_turns`,
`response: warn|halt|off`) and folds a per-session turn counter into the
`billing-cap-halt` PostToolUse path. Crossing `warn_turns` emits an audited
`rea.spend.turn_budget_warn` (once); crossing `halt_turns` fires `response` once
(`halt` writes `.rea/HALT`, audits `rea.spend.turn_budget_halt`). The counter is
per-session and LOCAL; audit lands on the repo-wide common root. Absent block =
feature off (no behavior change for existing policies). Overnight-safe: never an
interactive prompt.
