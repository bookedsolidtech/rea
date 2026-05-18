---
'@bookedsolid/rea': minor
---

Per-session shim cache (`hooks/_lib/shim-cache.sh`) skips sandbox check + version probe on same-session same-CLI fires; cuts steady-state shim latency from ~80-150ms to ~5-10ms per call. Disable via `REA_SHIM_CACHE=0` or `policy.shim_cache.enabled: false`. Fail-safe — every cache error falls through to the existing uncached hot path; cache is an optimization, not a security boundary.
