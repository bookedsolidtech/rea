---
'@bookedsolid/rea': minor
---

Add spend-governance policy axis and a billing→HALT reflex (E1 seed).

Introduced in response to a denial-of-wallet incident: an agent treated a
"spending cap exceeded" error as retryable and multiplied requests against a
metered paid API until the budget blew past its cap. rea had no concept of
spend anywhere — no schema field, no hook, no threat class.

This release lands the cheapest, highest-value slice:

- **New `spend_governance` policy block** (`enabled`, `billing_error_response`)
  — strict-validated, `billing_error_response` defaults to `halt`. Every
  shipped profile pins `enabled: true`; an absent block is a silent no-op
  (upgrade-safe).
- **New `billing-cap-halt.sh` PostToolUse Bash hook** — scans a just-run
  command's output for a billing-class signature (spending cap / prepayment
  credits depleted / payment required — deliberately DISTINCT from a
  retryable 429/rate-limit) and writes `.rea/HALT`, reusing the existing
  kill-switch every middleware and hook already respects. Modes: `halt`
  (default) writes HALT + banner; `warn` surfaces a banner only; `off`
  disables the reflex. The billing gate is fail-CLOSED when the CLI is
  missing but a billing signal is present, and fail-SAFE (never a
  false-positive freeze) on malformed input.
- **THREAT_MODEL.md §5.25** — new "Denial-of-wallet / runaway metered spend"
  threat class, stating honestly that rea governs request volume as a spend
  proxy, never vendor-settled dollars.

The shipped hook count moves from 14 to 15. Follow-on PRs add per-run request
ceilings, retry-discipline, the run-gate, and consumption limits.
