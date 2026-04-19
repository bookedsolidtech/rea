---
'@bookedsolid/rea': patch
---

ci: close tarball-smoke coverage gaps (post-merge)

Address four post-merge Codex findings on the tarball-smoke gate:

- **[high]** Gate counted `.claude/agents/` + `.claude/hooks/` only — now tree-equality asserts against `.claude/commands/`, recursive `hooks/**` (walks `hooks/_lib/`), and the shipped `.husky/{commit-msg,pre-push}` so a tarball missing those surfaces fails loud with a unified-diff delta. `.git/hooks/{commit-msg,pre-push}` are also asserted as the real enforcement surface on a fresh consumer.
- **[medium]** Fresh-consumer `npm init -y` temp files were not actually cleaned before `git init` — comment now matches behavior (`rm -f package.json package-lock.json`).
- **[low]** Version probe interpolated repo path into a JS string literal — now passes the path via argv so repo-roots with apostrophes, backslashes, or `${...}`-style expansions do not break the require() call.
- **[low]** Cleanup trap bound to `EXIT` only — now catches `HUP`/`INT`/`TERM` so Ctrl-C during a local run does not leave `/tmp/rea-smoke-*` tempdirs behind.
