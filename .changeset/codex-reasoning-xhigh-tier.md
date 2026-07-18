---
'@bookedsolid/rea': minor
---

feat(policy): support the `xhigh` codex reasoning tier

`policy.review.codex_reasoning_effort` validated against
`low | medium | high`, so operators whose codex CLI supports `xhigh`
(codex-cli 0.142.x+) could not express that preference through policy —
the zod loader rejected it. The enum and every type union
(`ReviewPolicy`, `ResolvedReviewPolicy`, `CodexRunOptions`,
`VerdictCacheEntry`, the iron-gate defaults) now include `xhigh`; the
runner already forwards the value verbatim as
`-c model_reasoning_effort="<value>"`, so it reaches codex unchanged.
Defaults are unchanged (`high`). Closes the second half of the
stale-codex-config report (the `gpt-5.4` flagship pin was already fixed
by the 0.52.0 model ladder, default `gpt-5.5`).
