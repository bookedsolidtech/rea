---
'@bookedsolid/rea': patch
---

fix(doctor): commit-msg hook check resolves the active hooks dir (`core.hooksPath` → `git rev-parse --git-path hooks` → `.git/hooks`) instead of hardcoding `.git/hooks/commit-msg`. Repos wired through `core.hooksPath=.husky` — where git actually runs `.husky/commit-msg` and the attribution gate is fully active — no longer get a permanent false-negative `[warn] commit-msg hook installed (missing…)` on every `rea doctor` run. A hook left at the default `.git/hooks/` location while `core.hooksPath` points elsewhere is now correctly reported as missing (git never runs it).
