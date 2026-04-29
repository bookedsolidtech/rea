---
'@bookedsolid/rea': minor
---

0.12.0 — helixir migration unblocker

Five fixes addressing pain points surfaced during the helixir team's
migration session 2026-04-26 (43 push attempts, ultimately uninstalled).

A. **Fix `exec $REA_BIN` word-splitting in pre-push BODY_TEMPLATE.** The
0.11.x stub relied on unquoted shell variable expansion to expand the
multi-token rea-CLI invocation forms (`node /path/to/cli.js`,
`npx --no-install @bookedsolid/rea`). When the repo path contained
whitespace (`/Users/jane/My Projects/repo`), the unquoted `$REA_BIN`
underwent word-splitting and the `exec` argv was wrong, producing
"command not found" or running the wrong path entirely. The body now
uses positional-args dispatch via `case`-arm `set --` and a final
`exec "$@"`, preserving spaces verbatim. Marker bumps `v2 -> v3` for
both the fallback and husky hooks; `rea upgrade` recognizes v2 markers
as legacy and refreshes 0.11.x installs in place.

B. **`REA_SKIP_CODEX_REVIEW=<reason>` is now a real audit-logged skip
env var.** Pre-0.12.0 only `REA_SKIP_PUSH_GATE` worked at the push-gate
tier; `REA_SKIP_CODEX_REVIEW` was honored at the gateway-tier reviewers
but silently ignored on `git push`. Both env vars are now equivalent at
the gate. Audit metadata records `skip_var: REA_SKIP_PUSH_GATE` vs
`REA_SKIP_CODEX_REVIEW` so operators can grep their audit log for the
variant. When both are set, `REA_SKIP_PUSH_GATE` wins.

C. **`rea doctor` fails when `policy.review.codex_required: true` and
the `codex` binary is not on PATH.** The codex CLI was a hard prereq
but the install path never surfaced it — fresh contributors learned at
first push. A new `codex CLI on PATH` check fails fast with an
actionable detail (install hint + `codex_required: false` opt-out).
The probe walks `process.env.PATH` directly (with `PATHEXT` on
Windows) rather than shelling out to a helper, so it works in
sanitized POSIX environments where `/bin` is omitted from PATH.
Skipped when codex is not required.

D. **`--last-n-commits N` flag and `policy.review.last_n_commits` key.**
On feature branches with many commits relative to base, the full
`origin/main` diff was too large for codex to review deterministically
(the helixir branch was 50+ commits ahead and saw codex flip verdicts
across rounds). The new option resolves the diff base to `HEAD~N` via
`git rev-parse`. Precedence: `--base <ref>` > `--last-n-commits N` >
`policy.review.last_n_commits` > refspec-aware base resolution >
upstream ladder. When `HEAD~N` is unreachable the resolver clamps
based on whether the repo is a shallow clone: on a FULL clone with a
branch shorter than N, clamps to the empty-tree sentinel so the root
commit is included (reviewing all K+1 commits); on a SHALLOW clone,
clamps to the deepest locally resolvable ancestor SHA so the review
does not balloon to every tracked file (older history exists on the
remote but isn't fetched). A stderr warning surfaces requested-vs-
clamped numbers in both cases. Audit metadata records
`base_source: 'last-n-commits'`, `last_n_commits: <count actually
reviewed>`, and `last_n_commits_requested: N` (only present when
clamped).

E. **Default `review.timeout_ms` raised from 600000 (10 min) to
1800000 (30 min).** 10 minutes was too tight for realistic
feature-branch reviews and was the most-commonly-cited cause of
recurring timeout exits during the helixir session. Operators with
explicit `timeout_ms:` pinned in their `.rea/policy.yaml` are unaffected;
new installs and unset-key consumers get the more forgiving default.

No schema breaking changes. No public-API breaking changes. Existing
0.11.x installs upgrade cleanly via `rea upgrade` (which refreshes the
husky/fallback hook bodies via the v2-legacy marker path).
