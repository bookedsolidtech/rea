---
'@bookedsolid/rea': patch
---

Close four 0.48.0 shim-cache deferrals: skip cache write when `SHIM_SKIP_VERSION_PROBE=1` so cache state never reflects a probe that never ran; extend the `shim_cache_disabled` awk parser to handle multi-line flow-form `shim_cache: { \n enabled: false \n }`; teach the same parser to skip pure-comment lines so top-level YAML comments inside the `shim_cache:` block no longer prematurely close it; move `shim_sandbox_check` ahead of cache prep so the dist-tree hash walk never traverses a symlinked-out CLI target before sandbox refuses.
