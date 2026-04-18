---
"@bookedsolid/rea": patch
---

Dogfood install uses conventional `.claude/` paths — real copies of agents, commands, and hooks instead of symlinks and source-dir references. This only affects the rea repo's own install; published package contents are unchanged.
