---
'@bookedsolid/rea': minor
---

feat(0.34.0): Node-binary hook playbook — 3 tier-2 medium-complexity ports

Continues the 0.32.0 Phase 1 / 0.33.0 Phase 2-A playbook with the
tier-2 batch: hooks with enforcer logic (catalog evaluation,
policy-driven mode toggles, multi-segment bypass detection). These
are the highest-stakes ports per hook — the bypass corpora pinned
across 0.13–0.27 demand byte-for-byte refusal-class preservation.

## Hooks ported

| Hook | Pre-0.34.0 LOC | Mode | Notes |
|------|----------------|------|-------|
| `dangerous-bash-interceptor.sh` | 414 | PreToolUse Bash | 17 HIGH (H1-H17) + 1 MEDIUM (M1) rule catalog |
| `local-review-gate.sh` | 460 | PreToolUse Bash | CTO directive 2026-05-05 local-first enforcement |
| `secret-scanner.sh` | 230 | PreToolUse Write/Edit/MultiEdit/NotebookEdit | 12 HIGH + 5 MEDIUM credential patterns |

For each: archived pre-0.34.0 bash body under
`__tests__/hooks/parity/baselines/<name>.sh.pre-0.34.0`, added
`src/hooks/<name>/index.ts` (pure async `runX(opts):
Promise<{ exitCode, stderr, ... }>`), wired `rea hook <name>`
subcommand, replaced `hooks/<name>.sh` with the round-8 shim shape
(HALT → relevance pre-gate → CLI resolution → realpath sandbox →
version probe → forward stdin), and staged the dogfood `.claude/`
mirror as `templates/<name>.dogfood-staged.sh`.

## Phase 0 primitive extensions

Five new helpers in `_lib/segments.ts`:

- `anySegmentRawMatches(cmd, regex)` — env-prefix-preserving raw-form
  match. Required by `dangerous-bash` H10 (`HUSKY=0 git`), H15
  (`REA_BYPASS=`), H16 (alias/function defs) where the env-prefix
  IS the signal — the prefix-stripper would have eaten it.
- `anySegmentContains(cmd, regex)` — segment-scoped contains (not
  head-anchored). Used by H6 (psql `DROP TABLE`) and M1 (npm install
  `--force`) for in-segment content patterns.
- `forEachSegment(cmd, callback)` — per-segment callback iteration.
  Used by H1 (per-push-segment force-push detection) so one segment
  can use `--force-with-lease` (safe) while another segment is
  flagged.
- `quoteMaskedCmd(cmd)` — mirror of `quote_masked_cmd` in the bash
  helper. Replaces in-quote `|`/`;`/`&` with multi-byte sentinels so
  H12 (`curl|sh` pipe-RCE) can grep the whole command without
  quoted-mention false positives.
- `unwrapNestedShells(cmd)` — emit `cmd` + every inner payload of a
  recognized nested-shell wrapper (`bash -c '…'` / `zsh -c '…'`
  etc.), depth-bounded at 8. Used by H12 so `bash -c "curl … | sh"`
  is scanned for pipe-RCE.
- `findAllSegmentsStartingWith(cmd, regex)` /
  `findAllSegmentsRawMatches(cmd, regex)` — return EVERY matching
  segment (not just the first). Required by `local-review-gate`'s
  round-25 P1-B multi-push laundering defense (every trigger
  segment must independently authorize bypass).

## Fail-closed posture

All three ports are BLOCKING-tier. Early-exit branches (CLI missing,
node missing, sandbox failed, version skew) fail closed AFTER the
relevance pre-gate passes — same posture as the 0.33.0 blocking
ports. Mode-off short-circuit in `local-review-gate` runs BEFORE
any CLI work, mirroring the 0.32.0 round-6 P2 fix for
`security-disclosure-gate`.

### dangerous-bash-interceptor refusal classes (preserved verbatim)

- H1: `git push --force` (long-form, short-form, combined-flag,
  refspec-prefix `+branch`), `--force-with-lease` allowed
- H2: `git rebase` advisory (MEDIUM, skipped on `--abort|--continue`)
- H3: `git checkout -- .` (working-tree discard)
- H4: `git restore .` (both `--staged` and bare)
- H5: `git clean -f` (allowed on `-n` / `--dry-run`)
- H6: `psql`/`pgcli` DROP TABLE/DATABASE/SCHEMA
- H7: `kill -9 $(…)` with subshell expansion
- H8: `killall -9 <name>`
- H9: `git commit --no-verify`
- H10: `HUSKY=0 git commit|push|tag`
- H11: `rm -rf` against broad targets (`/`, `~/`, `./*`, `.`,
  `src`, `dist`, `build`, `node_modules`) — split-flag, long-flag,
  combined-flag variants
- H12: `curl|wget … | (sudo )?(bash|sh|zsh|fish)` pipe-RCE
  (including nested-shell wrappers)
- H13: `git push --no-verify`
- H14: `git -c core.hooksPath=…`
- H15: `REA_BYPASS=…`
- H16: alias/function defs embedding bypass strings
- H17: `context_protection.delegate_to_subagent` — block commands
  that must run in a subagent
- M1: `npm install --force` (advisory)

### local-review-gate enforcement (preserved verbatim)

- Honors `policy.review.local_review.{mode, refuse_at,
  bypass_env_var}` via direct YAML read (tolerates partial policy
  files; not gated on strict-validator pass).
- `mode: off` → silent no-op before any other work.
- `refuse_at: push|commit|both` controls which git operations
  trigger preflight.
- Process-env bypass (operator-exported `REA_SKIP_LOCAL_REVIEW=`)
  covers all trigger segments uniformly.
- Inline bypass (per-segment `VAR=value git push`) — supports
  unquoted, double-quoted, single-quoted, and ANSI-C-quoted (`$'…'`)
  value shapes. Empty values MUST refuse.
- Multi-trigger commands require EVERY trigger segment to
  independently authorize bypass (round-25 P1-B laundering defense).
- Leading env-var prefixes before the bypass var are accepted
  (round-30 F1 sibling sweep) — e.g.
  `GIT_TRACE=1 REA_SKIP_LOCAL_REVIEW="reason" git push`.
- Comment-tail bypass shapes do NOT authorize (round-27 F1 anchor).
- Preflight refuse → "BASH BLOCKED: <op> — local-first review
  required" banner naming the configured bypass var.
- Preflight is invoked in-process via `computePreflight`; no
  subprocess spawn (the bash hook shelled out, the Node port runs
  the workhorse directly).

### secret-scanner pattern catalog (preserved verbatim)

12 HIGH (blocking): AWS Access Key ID, AWS Secret Access Key
(case-insensitive prefix), private-key armor (RSA/EC/OPENSSH/PGP),
Anthropic API key (sk-ant-api03-…), Anthropic OAuth token
(sk-ant-oat01-…), GitHub classic PAT (`gh[puors]_…`), GitHub
fine-grained PAT (`github_pat_…`), Stripe live secret/restricted
key, Stripe webhook signing secret, generic secret assignment
(double-quoted and single-quoted forms), Supabase service-role JWT.

5 MEDIUM (advisory): `.env` credential assignment (ANTHROPIC /
SUPABASE / DATABASE / STRIPE), Stripe test API key (real
credentials in test envs), Stripe live publishable key, hardcoded
DB connection string with embedded password, Supabase anon-key JWT.

awk-style line filter preserved: strips shell-comment lines (`#`),
`process.env.VAR` RHS-of-assignment lines (two regex variants —
terminator and trailing-non-letter shapes), and `os.environ[`
lines.

Placeholder filter preserved: `<…>`, `your_api_key` / `your_secret`
/ `your_key_here`, `placeholder`, `changeme`, `insert.*here`,
`(test|fake|mock|demo|example)_(key|token|secret|credential|api)`,
`test_<word>_key`, and 8+ repeated-char dummy strings.

MultiEdit handled: `parseWriteHookPayload` joins every
`edits[i].new_string` with `\n` before scanning — same as the
bash hook's `extract_write_content` in `_lib/payload-read.sh`.

File suffix exclusions preserved: `*.env.example` /
`*.env.sample` pass through silently. Test files are NOT
excluded — real credentials in fixtures must still be caught;
the placeholder filter handles legitimate dummy keys.

## Test coverage

- 71 new unit tests for `dangerous-bash-interceptor` covering
  every H1-H17 + M1 rule (fires-on cases + does-not-fire-on
  benign lookalikes from the historical bypass corpus)
- 30 new unit tests for `local-review-gate` covering mode
  short-circuit, refuse_at knob, process-env bypass, inline
  bypass (all four value shapes), multi-trigger laundering,
  leading-env-prefix, comment-tail safety, empty-value refusal,
  preflight allow/refuse/throw
- 48 new unit tests for `secret-scanner` covering every pattern
  category, awk line filter parity, placeholder filter,
  MultiEdit fragment joining, file suffix exclusion, HIGH-blocks
  / MEDIUM-advisory split, snippet truncation, per-pattern cap
- 17 new tests for the five `segments.ts` extensions
- 16 new bash↔node parity tests (`__tests__/hooks/parity/
  node-parity.test.ts`) across all three hooks
- Existing `__tests__/hooks/bash-tier-corpus.test.ts`
  (dangerous-bash-interceptor section) continues to pass against
  the new shim — 283 corpus cases / 0 regressions
- Existing `__tests__/hooks/secret-scanner.test.ts` continues to
  pass against the new shim — 16 / 16
- Obsolete `__tests__/hooks/local-review-gate.test.ts` (906 LOC of
  bash-shim tests that exercised the inline policy/bypass logic
  the port moved into the Node binary) removed; coverage replaced
  by the in-process unit suite

Net: ~182 new tests; one obsolete legacy file removed.

## Codex rounds

1 local codex round at gpt-5.4 / high reasoning.

## Out of scope for 0.34.0

- `.claude/hooks/*` dogfood mirror is canonical-content-staged
  under `templates/<name>.dogfood-staged.sh`; the three
  `.claude/hooks/*.sh` files must be patched in by Jake via
  `git apply` (their existing bodies are still the pre-0.34.0
  bash bodies).
- `EXPECTED_HOOKS` already lists all three (no doctor change).
- `.claude/settings.json` registrations already point at the shim
  paths (no settings change).
- 0.35.0 will port the remaining paired scanner-backed batch:
  `settings-protection`, `blocked-paths-enforcer`,
  `blocked-paths-bash-gate`, `protected-paths-bash-gate`.
