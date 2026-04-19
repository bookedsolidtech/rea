---
'@bookedsolid/rea': patch
---

docs(registry/tofu): tighten rename-bypass defense scope

Clarify in `classifyServers` that the set-difference heuristic catches **rename-with-removal** (attacker removes old trusted entry at the same moment the tampered new entry appears), not rename-with-placeholder (attacker leaves old entry in place as a decoy, adds tampered new entry under a new name).

Rename-with-placeholder lands as `first-seen` with a LOUD stderr banner — the documented, intentional TOFU contract for new entries. No code change; the docstring previously oversold the defense's scope.
