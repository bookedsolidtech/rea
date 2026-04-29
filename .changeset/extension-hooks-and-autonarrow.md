---
'@bookedsolid/rea': minor
---

0.13.0 — extension-hook chaining + push-gate auto-narrow

Two fixes addressing recommendations #1 and #3 from the REA v0.11.0 helixir-
migration bug report. Both are workflow-unblocking — the gate stops fighting
operators on long-running branches, and consumers can layer their own per-
commit / per-push checks without forking the rea hook bodies.

**H. Extension-hook chaining via `.husky/{commit-msg,pre-push}.d/*`.**
Drop executable scripts into either directory and rea will run them after
its own governance work, in lexical order, with the same positional args.
Useful for layering commitlint, conventional-commits linters, branch-policy
checks, or any other per-commit / per-push work without losing rea
coverage.

- Sourced AFTER rea's body — HALT, attribution blocking, and Codex review
  run first; fragments only fire when rea succeeds. A non-zero exit from
  rea short-circuits before any fragment runs.
- Lexical order — `10-foo` runs before `20-bar`. Standard convention is to
  prefix with a two-digit ordering number.
- Executable bit gates execution — non-executable files are silently
  skipped (`rea doctor` warns on this case so operators don't lose a hook
  to a missing `chmod +x`).
- Non-zero exit fails the hook — the next fragment does not run, the
  push / commit is blocked. Matches husky's normal hook chaining
  semantics.
- Missing directory is a no-op — backward compatible with consumers who
  never opt into fragments.

Marker bumps for the husky pre-push and fallback hooks: `v3 -> v4`.
Pre-0.13 commit-msg hooks shipped without a marker line; the new install
adds `# rea:commit-msg v1` on line 2 and the upgrade path recognizes the
unmarked-but-rea-shaped legacy body. `rea upgrade` recognizes v3 markers
as legacy and refreshes 0.12.x installs in place; v2 + v1 legacy
detection still applies for consumers stepping multiple versions at once.
`rea doctor` adds an `extension hook fragments` info-level probe that
lists every fragment it sees and warns on non-executable files.

**J. Auto-narrow on large divergence.**
When the resolved diff base is more than `policy.review.auto_narrow_threshold`
commits behind HEAD AND the base was resolved from the active refspec's
`remoteSha` (i.e. the previously-pushed tip of THIS branch — commits already
Codex-reviewed in a prior push) AND no explicit narrowing was set, the gate
scopes the review down to the last 10 commits and emits a stderr warning
explaining the auto-narrow plus how to override. Default threshold is 30;
explicit `0` disables auto-narrow entirely.

Suppression rules — any of these prevents auto-narrow from firing:

- `--last-n-commits N` flag (operator picked an exact window)
- `--base <ref>` flag (operator picked an exact base)
- `policy.review.last_n_commits` set (persistent narrow window)
- Base was resolved via upstream / origin-head / origin-main ladder
  (initial push, no upstream, fallback to trunk)

The last suppression rule is a hard safety constraint: auto-narrow MUST
NOT fire on initial pushes. Earlier commits on the branch may never have
been Codex-reviewed; skipping past them on an `origin/main`-shaped base
would silently bypass the advertised pre-push review for a
hook/policy/security change made early in the branch (codex-review
0.13.0 [P1]).

The probe runs `git rev-list --count base..HEAD` after base resolution; on a
null result (range unresolvable) auto-narrow does not fire — better to
review more than to trip a half-baked auto-narrow on a degenerate ref.
Every reviewed audit event includes `auto_narrowed: true|undefined` +
`original_commit_count: <N>|undefined` so operators can grep their audit
log for narrowed reviews.

Background: long-running branches with many commits since the last push
routinely produced non-deterministic Codex verdicts and 30-minute timeouts
— the "thrashing" pattern from the helixir-migration session. The 0.12.0
`last_n_commits` knob fixed it for operators who knew to set it; J makes
the protective default automatic for follow-up pushes without compromising
first-push coverage.

No schema breaking changes. No public-API breaking changes. Existing
0.12.x installs upgrade cleanly via `rea upgrade` (which refreshes the
husky/fallback hook bodies via the v3-legacy marker path).
