---
'@bookedsolid/rea': patch
---

fix(hooks): push/commit gates exit 0 when cwd is outside CLAUDE_PROJECT_DIR

When `CLAUDE_PROJECT_DIR` points to the rea repo but the current working
directory is a different repository (e.g. a Claude Code session rooted in rea
upgrading a consumer project's `@bookedsolid/rea` dependency), the
`push-review-gate.sh` and `commit-review-gate.sh` PreToolUse hooks now
short-circuit with exit 0 so the foreign repo's `git push` / `git commit`
proceeds unblocked.

Pre-fix behavior: ref-resolution inside `resolve_argv_refspecs` ran
`git rev-parse` inside `REA_ROOT` for refs that only existed in the consumer
repo, hard-failing with `PUSH BLOCKED: could not resolve source ref`. That
failure happened BEFORE the `REA_SKIP_PUSH_REVIEW` / `REA_SKIP_CODEX_REVIEW`
escape hatches could be checked, leaving consumers with no documented way to
unblock cross-repo work. Discovered during the 0.6.0 consumer upgrade wave.

The guard uses `pwd -P` to compare real (symlink-resolved) paths; pushes from
within rea itself or any of its subdirectories behave exactly as before.
