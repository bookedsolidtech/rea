---
'@bookedsolid/rea': minor
---

0.11.0 — replace cache-attestation push gate with a stateless Codex gate

The push-review gate that shipped through 0.10.x asked "has a qualifying
Codex receipt been recorded for this HEAD SHA?" and consulted
`.rea/review-cache.jsonl` + hash-chained audit records. That model required
agents to fabricate attestations (`rea cache set`, `rea audit record
codex-review --also-set-cache`) on every push, produced a 1,250-line bash
core plus a TypeScript port in flight, and was the root cause of defects
D/E/O/P and Helix bug 1.

This release replaces the entire stack with a stateless gate:

    git push
      → .husky/pre-push → rea hook push-gate
      → codex exec review --base <ref> --json
      → parse verdict from streamed findings
      → block on [P1] (blocking) or [P2] when concerns_blocks=true
      → write .rea/last-review.json + audit record
      → exit 0 / 1 (HALT) / 2 (blocked)

Codex is run fresh on every push. No cache. No SHA matching. No receipt
consultation. When the gate blocks, Claude reads stderr + the
machine-readable `.rea/last-review.json`, fixes, and retries — the auto-fix
loop IS the retry mechanism.

### BREAKING CHANGES

- **`rea cache` subcommand tree removed** (`check`, `set`, `clear`,
  `list`). The stateless gate needs no cache. Operators who previously
  scripted `rea cache set` for manual unblocks can delete those calls.
- **`rea audit record codex-review` removed.** The gate no longer
  consults audit records to decide pass/fail.
- **`policy.review.cache_max_age_seconds` removed.** `rea upgrade`
  strips it from `.rea/policy.yaml` with a timestamped `.bak-<ts>`
  backup.
- **`policy.review.allow_skip_in_ci` removed.** Same migration path. The
  gate now runs identically in CI, dev, and hook contexts — no CI
  special case.
- **`REA_SKIP_CODEX_REVIEW`, `REA_SKIP_PUSH_REVIEW` env vars no longer
  consulted.** Replaced by `REA_SKIP_PUSH_GATE=<reason>` (value-carrying,
  audited, HALT still wins) and `REA_ALLOW_CONCERNS=1` (per-push override
  of the concerns-block default).
- **Hook files deleted**: `hooks/push-review-gate.sh`,
  `hooks/push-review-gate-git.sh`, `hooks/commit-review-gate.sh`,
  `hooks/_lib/push-review-core.sh`. The husky `.husky/pre-push` now
  executes `rea hook push-gate` inline. `rea upgrade` migrates installed
  hooks (deletes the four dead files, refreshes the husky stub).
- **Audit `tool_name: codex.review*` and `push.review.skipped` no longer
  emitted by the gate.** The new events are `rea.push_gate.reviewed`,
  `rea.push_gate.halted`, `rea.push_gate.disabled`,
  `rea.push_gate.skipped`, `rea.push_gate.empty_diff`,
  `rea.push_gate.error`. The manual `/codex-review` slash command still
  emits `codex.review` audit records.

### New

- **`rea hook push-gate [--base <ref>]`** — the single CLI entry point
  husky calls. Resolves base ref via upstream → origin/HEAD → main/master
  → empty-tree, runs `codex exec review --json` against the diff, and
  maps the streamed P1/P2/P3 severity markers to a blocking/concerns/pass
  verdict.
- **`policy.review.concerns_blocks: boolean`** (default `true`) — when
  `true`, P2 findings block the push (override per-push with
  `REA_ALLOW_CONCERNS=1`).
- **`policy.review.timeout_ms: number`** (default 600_000) — hard cap on
  the `codex exec review` subprocess. Timeouts exit 2 with a clear error.
- **`.rea/last-review.json`** — atomic-write structured dump of the
  latest Codex run. Gitignored. Findings pass through the rea redact
  pattern set before hitting disk (no secret quoting from the diff
  leaks).

### Migration

`rea upgrade` handles the transition:
1. Writes `.rea/policy.yaml.bak-<ts>`.
2. Strips `cache_max_age_seconds` + `allow_skip_in_ci` from the
   `review:` block; adds `concerns_blocks: true` if absent.
3. Refreshes `.husky/pre-push` and `.git/hooks/pre-push` to the new
   stub body (both delegate to `rea hook push-gate`).
4. Deletes the four removed hook files from `.claude/hooks/`.

Codex CLI must be on `PATH`. When absent, the gate fails with a clear
error pointing at `npm i -g @openai/codex` (or set
`review.codex_required: false` to disable).
