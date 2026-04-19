---
'@bookedsolid/rea': patch
---

fix(injection): restore 0.2.x block-default and close trivial bypasses (G9 post-merge)

Address four post-merge Codex findings on the G9 three-tier injection classifier (PR #25):

- **[high]** `denyOnSuspicious` defaulted to `false` when `action: 'block'` and the flag was unset — silently loosening 0.2.x `injection_detection: block` behavior for non-bst consumers on upgrade. The middleware now defaults to `true` in that case (0.2.x parity). The zod schema no longer applies a default for `suspicious_blocks_writes`, so absence is distinguishable from an explicit `false`. Consumers who want the looser warn-only posture must opt out explicitly with `injection.suspicious_blocks_writes: false`. `bst-internal*` profiles continue to pin `true`.
- **[high]** The 7-phrase ASCII pattern library was trivially bypassed by Unicode whitespace (NBSP, en-space, em-space, ideographic space, etc.), zero-width joiners, and fullwidth compatibility characters. Inputs are now NFKC-normalized, zero-width-stripped, Unicode-whitespace-collapsed, and lowercased before literal matching. The phrase library was also modestly expanded with two conservative persona-swap vectors (`pretend you are`, `roleplay as`). Broader candidates like `act as a` / `act as an` were considered but dropped: at read tier a single literal match escalates to `likely_injection`, which would falsely deny benign prose such as "this proxy can act as a bridge." Pattern-set extensibility via policy is filed as G9.1 follow-up.
- **[medium]** `decodeBase64Strings` was exported and tested but never wired into the middleware execution path — 28 lines of dead code advertised as a second-opinion base64 probe. It is now called from the middleware after the primary scan; any phrase detected in a decoded whole-string payload is merged into `base64DecodedMatches`, triggering classification rule #2 (`likely_injection`).
- **[low]** On worker-bounded regex timeout, the audit record carried timing metadata under `injection.regex_timeout` but no `verdict` field under `injection`. A new `verdict: 'error'` value is emitted when a timeout produces no actionable signal, giving downstream audit consumers a stable record shape. A new `InjectionMetadataSchema` zod schema is exported from the injection middleware module for internal test coverage; promoting it to a public package entrypoint is tracked as G9.2 follow-up (the module is not reachable via the current `exports` map, so do not rely on it from outside this repo yet).

**Behavior change:** Non-bst consumers with `injection_detection: block` will now block on `suspicious` classifications by default, restoring 0.2.x parity. This is a narrow tightening for consumers who upgraded to 0.3.0 without adding the new `injection:` block. To restore the 0.3.0 looser behavior, opt out explicitly:

```yaml
injection:
  suspicious_blocks_writes: false
```

`likely_injection` continues to deny unconditionally in all configurations.
