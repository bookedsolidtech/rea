---
'@bookedsolid/rea': patch
---

[security] Close two push/commit-gate bypasses.

**Defect B** — Remove `push_review: false` / `commit_review: false` grep
short-circuits from `hooks/_lib/push-review-core.sh` (section 5) and
`hooks/commit-review-gate.sh` (section 5). A single line in `.rea/policy.yaml`
could silently disable the entire push or commit gate with no audit trail.
The only supported whole-gate escape hatch for the push path is now the
env-var opt-in `REA_SKIP_PUSH_REVIEW=<reason>`, which requires an explicit
reason, a git identity, and writes a `push.review.skipped` audit record.

Pre-existing carve-outs that remain intentional, documented, and audited
where applicable (not closed by this hotfix): (1) `review.codex_required:
false` in policy disables only the protected-path Codex branch — a
per-profile no-Codex mode, covered by
`__tests__/hooks/push-review-gate-no-codex.test.ts`; (2) the env-var
waiver `REA_SKIP_CODEX_REVIEW=<reason>` short-circuits only the Codex
protected-path branch and writes an audited `codex.review.skipped` record
(see `hooks/_lib/push-review-core.sh` section 5c and #85); (3) `git commit
--amend` short-circuits the commit-review gate because amendment review is
out of scope for this iteration of the hook.

**Defect C** — Extend the protected-paths matcher in
`hooks/_lib/push-review-core.sh` to include `.rea/` and `.husky/`. Diffs
touching these trees now require a `/codex-review` audit entry before push,
matching the five pre-existing protected roots (`src/gateway/middleware/`,
`hooks/`, `.claude/hooks/`, `src/policy/`, `.github/workflows/`). The
error-message listing is updated in lockstep. The awk regex uses the
bracket-literal `[.]rea/` and `[.]husky/` forms so bare project folders
named `rea/` (e.g. `Projects/rea/Bug Reports/`) do not spuriously trigger
the gate.

New test suite `__tests__/hooks/push-review-gate-policy-bypass.test.ts`
covers: `push_review: false` no longer bypasses, `commit_review: false` no
longer bypasses, `.rea/` diff triggers Codex, `.husky/` diff triggers Codex,
`Projects/rea/` (no leading dot, nested) does not fire, and top-level
`rea/` (no leading dot, root) does not fire — the last case pins the
load-bearing `[.]` bracket literal against future regex drift. A parity
assertion block also pins byte-identity between `hooks/commit-review-gate.sh`
and its `.claude/hooks/` dogfood mirror (the push-core mirror parity is
already asserted in the adapter suite).

Also extends `scripts/tarball-smoke.sh`: the `[security]` changeset gate now
recognizes `__tests__/hooks/(*security*|*bypass*|*sanitize*|*injection*).test.ts`
and asserts the hook files those tests exercise ship in both the tarball and
the post-`rea init` install surface. A `[security]` hook-test file that
yields zero extractable hook refs fails the gate loudly (template-literal or
helper-indirection shapes are rejected). Granularity is per-test-file, not
per-`it()` block — mixing unrelated `it()` cases in one file dilutes the
proof and PR review is the mitigation.

Dogfood mirrors under `.claude/hooks/` synced. No runtime signature or
public-API change.
