---
'@bookedsolid/rea': minor
---

G9 — Injection tier escalation: clean / suspicious / likely_injection.

**Behavior change on upgrade for external profiles — read this before upgrading if you depend on the 0.2.x deny-on-any-match behavior.**

The injection middleware (`src/gateway/middleware/injection.ts`) was a single-threshold binary: any known phrase match in a tool result denied the call. That was too blunt — a single literal match at write tier is noise-prone, while multi-literal + base64-decoded matches at any tier are near-certain attacks that should deny regardless of context. G9 introduces a three-level classifier and a policy knob governing the middle bucket.

### Classification rules

Every PostToolUse scan now returns one of three verdicts (recorded in `ctx.metadata.injection` and exported to the audit log):

- `clean` — no match → allow, no log.
- `suspicious` — exactly ONE distinct literal pattern at write/destructive tier, with no base64-decoded match → warn (stderr + audit metadata). Whether this denies is governed by the new `policy.injection.suspicious_blocks_writes` flag.
- `likely_injection` — any of: ≥2 distinct literal patterns, any base64-decoded match, any match at read tier, or an unknown tier (fail-closed) → **always deny, regardless of the flag**.

### The narrow relaxation (the reason for the loud callout)

**In 0.2.x, a single literal match at any tier denied.** In 0.3.0, for profiles that do NOT pin the new flag (`open-source`, `client-engagement`, `minimal`, `lit-wc`, and any hand-authored policy that omits the `injection:` block), a single literal match at write/destructive tier is classified `suspicious` → warn-only by default. This means the call is ALLOWED through. The warning is written to stderr and the audit record still captures `verdict: suspicious` with the matched phrase, but the tool result is NOT blocked.

The `bst-internal` and `bst-internal-no-codex` profiles pin `suspicious_blocks_writes: true`, preserving the 0.2.x strict-deny posture. This repo's own `.rea/policy.yaml` continues to inherit that strict posture by profile.

**Why ship narrower:** silent tightening on upgrade is a worse footgun than the narrower default. External consumers who want the strict 0.2.x behavior can opt in explicitly:

```yaml
injection:
  suspicious_blocks_writes: true
```

`likely_injection` remains an unconditional deny. The attacker cases that matter most (multi-pattern coordinated injection, base64-obfuscated payloads) still deny in every profile.

### Policy flag

New optional top-level policy block:

```yaml
injection:
  suspicious_blocks_writes: true    # default: false
```

- `false` (schema default): `suspicious` → warn-only, tool result allowed through. Audit record carries `verdict: suspicious`.
- `true`: `suspicious` → deny at write/destructive tier (matches 0.2.x deny-on-literal semantics for writes). Audit record carries `verdict: suspicious` plus `status: denied`.
- `likely_injection` denies in either case.

The loader defaults are `false`; the `bst-internal*` profiles pin `true`.

### Audit metadata

On any non-clean verdict the middleware writes `ctx.metadata.injection`, which the audit middleware exports verbatim into the per-call record:

```json
{
  "verdict": "likely_injection",
  "matched_patterns": ["disregard your", "ignore previous instructions"],
  "base64_decoded": false
}
```

`matched_patterns` is a sorted list of distinct phrase strings from the built-in phrase list. NO input payload text is ever written to metadata (guard against leaking the attack content through audit trail redaction bypass).

### Legacy `injection_detection: warn` interaction

Operators who pinned 0.2.x `injection_detection: warn` continue to get warn-only for `suspicious`. However, under G9, `likely_injection` (multi-literal or base64-decoded) will now DENY even when `injection_detection: warn` is set. This is a narrow tightening for operators who explicitly pinned warn mode — the classifier's whole value is distinguishing high-confidence attacks from ambiguous single-hits, and high-confidence attacks deserve a deny. If you need the full-allow-through behavior for all matches (not recommended), disable the middleware by removing it from your gateway configuration.

### Stderr format change

The warning line format changed from `[rea] INJECTION-GUARD: ...` to `[rea] INJECTION-GUARD (<verdict>): ...`. Log consumers grepping for the old exact prefix should update their filters.

### Pattern list unchanged

This PR does NOT modify the built-in `INJECTION_PHRASES` list. Extending or reshaping the pattern set is explicit future work (a per-pattern "deny-tag" extension point is stubbed with a TODO in `classifyInjection`).

### New public exports

From `src/gateway/middleware/injection.ts`:

- `classifyInjection(scan, tier) → InjectionClassification` — pure classifier
- `scanStringForInjection(s, result, safe)` / `scanValueForInjection(v, result, safe)` — structured scanners
- `decodeBase64Strings(input: unknown) → string[]` — pure base64 probe
- `INJECTION_METADATA_KEY` — `'injection'`, the ctx.metadata key for the verdict record
- `InjectionClassifierMetadata`, `InjectionScanResult`, `InjectionClassification` — types

Back-compat: `scanForInjection(string, safe) → string[]` is retained as a wrapper so `scripts/lint-safe-regex.mjs` and any external consumer that imported it continue to work.
