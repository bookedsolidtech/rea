---
'@bookedsolid/rea': patch
---

fix(injection): guard base64 probe on timeout + correct changeset default-behavior doc

Address four post-merge Codex findings on the G9 three-tier injection classifier (PR #25):

- **[high]** `denyOnSuspicious` flag behavior clarified: the `suspicious_blocks_writes` flag defaults to `false` when omitted (preserving the 0.3.x warn-only default for unset installs). Consumers who want the tighter block posture must opt in explicitly with `injection.suspicious_blocks_writes: true`. The `bst-internal*` profiles pin `true`. This was the correct approach: silently switching to block behavior on upgrade would be a breaking change for 0.3.x consumers.
- **[high]** The 7-phrase ASCII pattern library was trivially bypassed by Unicode whitespace (NBSP, en-space, em-space, ideographic space, etc.), zero-width joiners, and fullwidth compatibility characters. Inputs are now NFKC-normalized, zero-width-stripped, Unicode-whitespace-collapsed, and lowercased before literal matching. The phrase library was also modestly expanded with two conservative persona-swap vectors (`pretend you are`, `roleplay as`). Broader candidates like `act as a` / `act as an` were considered but dropped: at read tier a single literal match escalates to `likely_injection`, which would falsely deny benign prose such as "this proxy can act as a bridge." Pattern-set extensibility via policy is filed as G9.1 follow-up.
- **[medium]** `decodeBase64Strings` was exported and tested but never wired into the middleware execution path — 28 lines of dead code advertised as a second-opinion base64 probe. It is now called from the middleware after the primary scan; any phrase detected in a decoded whole-string payload is merged into `base64DecodedMatches`, triggering classification rule #2 (`likely_injection`). The call is guarded behind `!scanTimedOut` so a timeout-induced incomplete scan cannot force unbounded CPU/memory in the base64 probe path; a `MAX_BASE64_PROBE_LENGTH` cap (16 KiB) is also applied per-string inside `decodeBase64Strings`.
- **[low]** On worker-bounded regex timeout, the audit record carried timing metadata under `injection.regex_timeout` but no `verdict` field under `injection`. A new `verdict: 'error'` value is emitted when a timeout produces no actionable signal, giving downstream audit consumers a stable record shape. A new `InjectionMetadataSchema` zod schema is exported from the injection middleware module for internal test coverage; promoting it to a public package entrypoint is tracked as G9.2 follow-up (the module is not reachable via the current `exports` map, so do not rely on it from outside this repo yet).

`likely_injection` continues to deny unconditionally in all configurations.
