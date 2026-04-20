---
'@bookedsolid/rea': patch
---

[security] Helix team blocker clearance — BUG-011, BUG-012, BUG-013

Three coordinated fixes shipped together so the Helix team (primary rea
consumer) can merge their pending 0.6.0 upgrade PR.

**BUG-011 (HIGH, security) — `__rea__health` meta-tool payload sanitization.**
The meta-tool short-circuits the middleware chain (intentionally, so it stays
callable under HALT) and previously serialized `halt_reason` and every
`downstreams[].last_error` verbatim. Error strings from upstream MCPs could
contain secrets (API keys, tokens) or prompt-injection payloads, neither of
which was filtered because the redact + injection middleware does not run on
the short-circuited response. Net effect: a redact + injection-sanitizer bypass
callable precisely when HALT should be holding the line.

Fix: the health response now has `halt_reason: null` and every
`downstreams[].last_error: null` by default. Full diagnostic detail continues
to flow into `rea doctor` (which reads `pool.healthSnapshot()` pre-sanitize)
and into the meta-tool audit record — the entry written for
`__rea__health` now carries `metadata.halt_reason` and
`metadata.downstream_errors[]` alongside the existing counts. The audit log
is on local disk, hash-chained append-only, and not LLM-reachable, so it is
the correct sink for the trusted-operator diagnostic text. Operators who
need the upstream error text on the MCP wire itself can opt in via
`gateway.health.expose_diagnostics: true` in `.rea/policy.yaml`; opt-in mode
still runs the sanitizer (redact + injection-classify with a placeholder
replacement for suspected-injection strings). Diagnostic strings are bounded
at 4096 UTF-16 code units before redact/inject scanning runs (with a UTF-8-
safe truncate that drops trailing lone surrogates), so an adversarial
downstream cannot DoS the tool by throwing oversize errors.

Secondary: `meta.health.audit_failed` log elevated from `warn` to `error`, and
`summary.audit_fail_count` is exposed in the snapshot so operators can detect
an audit-sink failure without parsing stderr.

New regression suite `src/gateway/meta/health-sanitize.test.ts` asserts that no
combination of policy and HALT state can surface a synthetic secret or
injection payload on the MCP wire, and that the redact-timeout sentinel never
reaches the caller verbatim.

**BUG-012 (MEDIUM, trust boundary) — script-location anchor for cross-repo
guard.** The 0.6.1 cross-repo hook guard used
`REA_ROOT=${CLAUDE_PROJECT_DIR:-$(pwd)}`. `CLAUDE_PROJECT_DIR` is
caller-controlled, so any process that exported a foreign path could both
bypass the gate AND bypass HALT.

Fix: hooks now anchor `REA_ROOT` to the script's on-disk location via
`BASH_SOURCE[0]` + `pwd -P`, then walk up to 4 parent directories looking for
`.rea/policy.yaml` as the authoritative install marker. Fail-closed if no
marker is found within the ceiling. `CLAUDE_PROJECT_DIR` is now treated as an
advisory-only signal — if it is set and does not agree with the script-derived
root, an advisory warning is printed and the script-derived value wins. The
guard's cross-repo detection now compares the working directory's
git-common-dir against the anchor's, fails closed on probe failure or on mixed
git/non-git state, and falls back to path-prefix only when BOTH sides are
non-git (the documented 0.5.1 escape-hatch scenario).

Regression test in `__tests__/hooks/push-review-gate-cross-repo.test.ts` —
BUG-012: foreign `CLAUDE_PROJECT_DIR` does NOT bypass HALT.

**BUG-013 (HIGH, process) — release-pipeline dist/ verification.** 0.6.1 (tag)
shipped with a `dist/` tree byte-identical to 0.6.0 — confirmed by Helix via
`diff -qr`. Without a pipeline gate that rebuilds `dist/` from the shipping
commit and verifies the published tarball contents, no future security
changeset can be trusted.

This release ships the in-repo half of the fix: `scripts/tarball-smoke.sh`
now enforces a content-based security-claim gate. When any `.changeset/*.md`
contains the `[security]` marker, the smoke requires that at least one
`src/**/*(sanitize|security)*.test.ts` file exists AND that every named-import
symbol it pulls from a relative path is present in the compiled `dist/` tree.
The gate fails loudly (exit 2) if the marker is present but no testable
security symbols are extractable — which is exactly the signal the 0.6.0→0.6.1
regression would have produced, because the claimed fix would have to appear
as at least one new test-referenced export under `dist/`.

Pipeline-level rebuild-before-publish + post-publish tarball hash verification
steps are drafted in `.rea/drafts-0.6.2/release-yml-patch.md` for hand-apply to
`.github/workflows/release.yml` — CODEOWNERS blocks direct agent commits to
that path, so those steps ship in a follow-up patch authored by a human
maintainer. The tarball-smoke gate in this release is the bypass-resistant
content check; the workflow-level hash verification is the defense-in-depth
layer that will land alongside it.
