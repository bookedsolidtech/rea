---
'@bookedsolid/rea': patch
---

fix(doctor): skip git-hook checks when `.git/` is absent

`rea doctor` no longer hard-fails on the `pre-push hook installed` check and
no longer warns on the `commit-msg hook installed` check when the consumer's
project is not a git repository. Instead, a single informational line —
`[info] git hooks  (no '.git/' at baseDir — commit-msg / pre-push checks
skipped (not a git repo))` — replaces both checks, and `rea doctor` exits 0
when all other checks pass.

This matters for knowledge repos and other non-source-code projects that
consume rea governance (policy, blocked paths, injection detection) but have
no commits to gate. `rea init` already skipped commit-msg and pre-push
install gracefully in a non-git directory; the doctor is now symmetric.

Detection is done by a new exported helper `isGitRepo(baseDir)` that accepts
all three real-world git-repo shapes — `.git/` directory (vanilla),
`.git` file pointing at a valid gitdir (linked worktree / submodule), or
a `.git` symlink to either of the above — and crucially **rejects stale
gitlinks** whose target has been pruned. A submodule whose parent was moved
or a linked worktree whose main repo was deleted both leave `.git` as a
file with a `gitdir:` pointer to nowhere; `isGitRepo` returns false for
these so the escape hatch kicks in the way operators expect.

Security: removing `.git/` does not bypass governance. The governance
artifact is the pre-push hook git invokes on `git push`; a directory with
no `.git/` has no pushes to gate. `isGitRepo` is a UX predicate for
doctor, not a trust boundary.
