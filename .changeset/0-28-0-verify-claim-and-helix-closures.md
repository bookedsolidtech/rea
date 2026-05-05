---
'@bookedsolid/rea': minor
---

`rea verify-claim` CLI plus five surgical helix-closure items.

**Centerpiece — `rea verify-claim <claim-id>`:** replays a recorded
security-claim PoC battery against the rea CLI under test. Each claim at
`data/claims/<id>.json` lists 1..N PoCs (`scan-bash` inputs or
`shellcheck` targets) with expected verdicts. Five seed claims ship:
helix-022 (bash-tier bypass classes), helix-023 (round-13 closure
ladder), helix-024 (kill-switch bypasses, 9 PoCs), helix-028 (multiline
awk + ANSI-C), helix-031 (shellcheck SC1078). Use `--installed` to verify
against the consumer-pinned `node_modules/@bookedsolid/rea`. Exit 0
matched, 1 mismatch, 2 unknown id.

**helix-025 F1:** gateway tri-state for `last_error`. New
`connection_state: 'never' | 'ok' | 'errored'` field on
`DownstreamHealth` and `LiveDownstreamState` (mirrored in `rea status`).
Distinguishes "never attempted" from "tried and failed" even when no
error string is renderable.

**helix-027:** version-probe per shim. `protected-paths-bash-gate.sh`
and `blocked-paths-bash-gate.sh` now run `rea hook scan-bash --help`
before forwarding stdin. If the resolved CLI is older than 0.23.0 the
shim refuses with an actionable message ("run `pnpm install`") instead
of locking out every Bash tool with no diagnostic.

**helix-029:** path-scoped finding filter for the push-gate. New
`policy.review.exclude_paths` (gitignore-style globs) and a derived
`auto_exclude_managed` default (true when `exclude_paths` is set; pulls
paths from `.rea/install-manifest.json`). Findings whose `file` matches
any glob are filtered before verdict computation; the audit shape stays
unchanged with a `filtered_findings_count` counter added to
`rea.push_gate.reviewed` metadata.

**0.26.0 round-29 P3 advisories:** preflight `resolveCommitCountBase`
now falls through to `origin/develop` and emits a stderr advisory
(suggesting `git remote set-head origin -a`) when `origin/HEAD` is
unset on a develop-branch repo. The "no recent local-review audit
entry covers HEAD" message becomes "your last local review was
blocking — address findings or override" when a path-matching audit
entry exists with `verdict: blocking`.

**Round-18 P2 (deferred from 0.23.0):** FuncDecl-then-call closure in
`src/hooks/bash-scanner/walker.ts`. Two-phase post-pass collects every
FuncDecl's body writes and re-emits them at every CallExpr that names
the function. Closes `bash -lc 'f() { echo x > .rea/HALT; }; f`.
