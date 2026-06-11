---
'@bookedsolid/rea': minor
---

OpenRouter review provider (gpt-oss-120b cheap lane) + commit-aware review granularity.

- `policy.review.provider: codex | openrouter | both` — `both` runs OpenRouter as a non-blocking shadow of the authoritative Codex verdict and records parity data to `.rea/review-parity.json`
- `policy.review.review_granularity: auto | per-commit | whole` — `auto` reviews the whole net diff when it fits the model context and escalates to Codex when it does not (never silently per-commit); `per-commit` is an explicit opt-in reviewing each commit on its own patch
- External-send path guard: governance surfaces (`.claude/`, `.husky/`, `.rea/`, `package.json`), `blocked_paths`, and evidentiary patterns are refused to the external lane and fall back to Codex, with an informational `rea.local_review.refused_external` audit record (rule name only — never raw paths or diff content)
- Outbound chokepoint: redaction (built-in + `policy.redact.patterns`) → `data_collection: deny` → optional `backend_pin` allowlist with fail-closed `served_by` verification; audit records carry `data_policy_requested` vs `data_policy_enforced` (requested ≠ verified, stated honestly)
- `rea config set-key|get-key|unset-key|list` manage provider API keys in `~/.config/rea/credentials` (0600); OpenRouter key resolves env-first
- `rea doctor` validates provider configuration; new audit events `rea.local_review.shadow` and `rea.local_review.refused_external` never cover HEAD for preflight
- Removes the legacy unused `src/gateway/reviewers/` surface
- Shipped CLAUDE.md fragment now mandates logical, manageable, connected commits and per-commit review as the routine floor
