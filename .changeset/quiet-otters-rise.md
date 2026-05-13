---
'@bookedsolid/rea': patch
---

fix(0.28.2): close `/./` Write-tier bypass + npm CDN retry + orchestrator self-review

Bundle release: security hotfix for the Write-tier `/./` bypass class,
release-pipeline hardening for npm CDN propagation lag, and a brief
amendment to the orchestrator self-review brief. Bundled with the
defect-V finding-text gap from 0.28.1 (already staged).

## A — `/./` Write-tier bypass closure (security hotfix class)

`hooks/settings-protection.sh` and `hooks/blocked-paths-enforcer.sh` both
have explicit `..`-traversal guards (`*/../*`) but no `*/./* ` companion.
`normalize_path` deliberately does NOT collapse interior `/./` segments —
collapsing them would corrupt `..` reasoning — which leaves a parallel
bypass class: a path like `.husky/./pre-push` resolves on disk to
`.husky/pre-push` but the literal/prefix matchers compare against the
un-collapsed string and miss.

Conservative closure: treat any interior `/./` segment exactly like `..`.
Both gates refuse with a dedicated `interior dot-segment rejected` error.

Corpus pairs shell-scripting-specialist + adversarial-test-specialist
discipline (23 new test cases total):

- `foo/./CODEOWNERS` — canonical attack shape
- `foo/././CODEOWNERS` — repeated interior segments
- `foo/.//CODEOWNERS` — interior dot + extra slash
- `foo/%2E/CODEOWNERS` — URL-encoded interior dot
- `foo/.%2FCODEOWNERS` — URL-encoded interior dot-slash
- `.claude/./settings.json` — hard-protected target via interior dot
- `.rea/./policy.yaml` — refused even with `REA_HOOK_PATCH_SESSION` set
- `.husky/pre-push.d/./fragment` — extension surface still refused at the
  guard tier (runs before the §5b allow-list)

Leading `./foo` (canonical relative path) and filenames containing `.`
(`foo.bar.test.ts`) remain allowed — the guard only fires on INTERIOR
segments delimited by slashes on both sides. Codex round 1 P2-1 closure
also pins benign percent-encoded leading-`./` shapes (`%2E%2Fsrc/foo.ts`,
`.%2Fsrc/foo.ts`) as allowed — the raw-form encoded guard from the first
draft was over-broad; the normalized-form `*/./* ` check is sufficient
because `normalize_path` URL-decodes BEFORE the dot-segment check.

The Bash-tier scanner (`src/hooks/bash-scanner/protected-scan.ts`,
`blocked-scan.ts`) already handles `/./` correctly via `collapseDotDot`
which strips both `.` and `..` segments. No change needed there. The
vulnerability was limited to the Write-tier shell hooks.

## B — Orchestrator self-review brief amendment

`agents/rea-orchestrator.md` gains a "Self-review when the orchestrator
implements directly" section. Pins the discipline orchestrator must
apply when subagent dispatch is unavailable (no Task tool in the
harness), the task is narrowly scoped, or codex rounds are being used
as the de facto specialist tier. Five rules: name the specialists
being channeled, codex round between surfaces (not just at the end),
explicit threat-model framing for security-tier changes, single-commit-
per-PR discipline, ruthless deferral. Brief amendment with no
behavioral change to the agent's contract; the full orchestrator
redesign with delegation-telemetry waits for 0.29.0.

## E — npm CDN propagation retry in `dist-regression-gate.sh`

The release-verify step in five marathon releases (0.9.0, 0.12.0,
0.13.0, 0.28.0, 0.28.1) all flaked on "npm CDN lag" — `npm view`
returns the version metadata but `npm pack` against the same version
404s because the tarball blob has not propagated to all CDN edges. The
CI release workflow already has a 12×10s retry (`release.yml` phase 2);
this script runs locally and in PR CI where it previously failed at
the first 404.

Initial attempt + 3 retries with sleeps 2s / 8s / 30s. Total worst-case
wait = 40s, all on the failure path. Covers the empirically observed
propagation window while bounding local-/ PR-side blocking time to
under a minute on a genuine outage. Degrade-to-skip on persistent
failure (matches the pre-existing behavior for a registry outage).

Codex round 1 P2-2 closure: the retry loop uses a bash arithmetic
for-loop (`for ((attempt=1; attempt<=N; attempt++))`) instead of
`$(seq 1 N)` so the script does not gain an undeclared dependency on
`seq` (not in the preflight tool list; would exit 127 under `set -e`
on minimal images).

## Deferred to 0.29.0 (delegation telemetry — proper minor scope)

The `rea audit specialists` telemetry foundation drafted for this
cycle was reverted before commit. Codex rounds 4 + 5 surfaced a P1
that the gateway audit middleware never observes Task/Skill tool calls
(those are Claude Code harness-internal tools, not proxied through
`rea serve`), so a CLI that reports "zero specialists" against a
session that actually delegated heavily would make the real problem
look like a tool bug.

0.29.0 will ship the integration-layer design that addresses this
properly: gateway-capture integration for Task/Skill (custom audit
hook, harness-audit reconciliation, or upstream schema negotiation),
the `delegation-advisory` hook, the `rea.delegation_signal` audit
event, the `rea audit specialists` CLI re-implemented against working
audit data, and `policy.delegation_advisory.{enabled, threshold,
exempt_subagents}`.

## Validation

- 4 quality gates green locally (lint, type-check, test, build).
- New corpus tests: 13 in `blocked-paths-enforcer.test.ts` (11 dot-
  segment + 2 encoded-leading-allowed regressions), 10 in
  `settings-protection-patch-session.test.ts`. All 23 new tests pass.
- Codex local review at gpt-5.4/high before push.
