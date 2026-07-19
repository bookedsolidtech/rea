---
'@bookedsolid/rea': minor
---

Spine distribution (Artifact Gates spec §4) — `rea init`/`rea upgrade` now ship the
process-spine skills automatically. The `spine/` payload installs to the rea-owned
`.claude/skills/rea/` subdir (never the shared `.claude/skills/` root, so it can
never collide with a user's own skills) via a single canonical DirMapping, so it version-pins,
drift-detects, and refuses-on-local-mod through the SAME machinery as
commands/agents (no new mechanism): `rea init` records SHAs, `rea upgrade`
reconciles/refreshes, `rea doctor --drift` reports spine drift. Re-running init is
byte-identical. `rea doctor` gains two advisory checks: spine-installed (with the
release version pin) and a token-economy budget lint (owner D5 — warns at >15
user-invoked skills or >1,000 description tokens across `.claude/skills/`,
`.claude/skills/rea/`, and `.claude/commands/`, flags the quarterly prune; never
fails the exit code).
