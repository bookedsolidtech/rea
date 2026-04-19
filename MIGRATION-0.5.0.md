# Migration — 0.4.x → 0.5.0

Targeted migration guide for consumers of `@bookedsolid/rea`. Focused on the
paired push-review-gate fixes (BUG-008 + BUG-009) that land in 0.5.0.

## TL;DR

If you ran `rea init` on 0.3.x or 0.4.0 and wired `.husky/pre-push` to
`.claude/hooks/push-review-gate.sh`, your pre-push gate has been silently
no-oping. Upgrade to 0.5.0 and rerun `rea init` (or `rea upgrade`). The
escape hatch `REA_SKIP_PUSH_REVIEW=<reason>` is available if any gate blocks
you while upgrading.

## What was broken in 0.3.x/0.4.0

### BUG-008 — pre-push stdin contract mismatch

`hooks/push-review-gate.sh` was written to parse Claude-Code's
PreToolUse stdin — a JSON payload with `.tool_input.command`. When husky
invokes it as a pre-push hook, git passes a different stdin contract: one
line per refspec, shaped
`<local_ref> <local_sha> <remote_ref> <remote_sha>`.

The hook's `jq -r '.tool_input.command'` parse returned empty, the
`[[ -z "$CMD" ]]` early-return fired, and the script exited 0. **The gate
did nothing.** Every consumer who ran `rea init` on 0.3.x/0.4.0 and wired
husky's pre-push to the gate had silent bypass of protected-path review.

### BUG-009 — `rea cache` subcommand never shipped

`hooks/push-review-gate.sh:700` has called
`rea cache check <sha> --branch <b> --base <base>` since 0.3.x, and
line 727 prints
`rea cache set <sha> pass --branch <b> --base <base>` as the only
advertised way to satisfy the gate after a successful review.

The `cache` subcommand was never registered. `src/cli/index.ts` had no
`cache` command; `src/cli/` had no `cache.ts`. Consumers hit
`error: unknown command 'cache'`, the hook swallowed it to
`{"hit":false}`, and every protected-path push re-ran Codex review with
no way to durably record an approval.

Taken together:
- **Pre-BUG-008 fix (0.3.x/0.4.0 as-shipped)**: gate is a no-op.
- **Post-BUG-008 fix, pre-BUG-009 fix**: gate fires correctly on pre-push
  but deadlocks because `rea cache set` doesn't exist.

Neither state produces the intended behavior. The two fixes must land
together, and they do — in 0.5.0.

## What 0.5.0 changes

### 1. `push-review-gate.sh` self-detects the pre-push contract

When jq returns empty, the hook now sniffs the first non-blank stdin line.
If it matches the git pre-push refspec shape, the hook synthesizes
`CMD="git push <argv-remote>"` so the existing step-6 pre-push parser
takes over. Random stdin still exits 0, and the Claude-Code JSON path is
unchanged.

Regression tests live in
`__tests__/hooks/push-review-gate-prepush-stdin.test.ts`.

### 2. `rea cache` subcommand

Four new subcommands:

| Command | Purpose |
|---|---|
| `rea cache check <sha> --branch <b> --base <base>` | JSON lookup — `{hit,true,result,branch,base,recorded_at[,reason]}` on hit, `{hit:false}` on miss. Hook contract: stdout is JSON-only. |
| `rea cache set <sha> <pass\|fail> --branch <b> --base <base> [--reason <s>]` | Record a review outcome. Idempotent; last-write-wins on `(sha, branch, base)`. |
| `rea cache clear <sha>` | Remove every entry matching `<sha>`. Dev convenience. |
| `rea cache list [--branch <b>]` | Print entries in file order. |

Backed by a keyed JSONL store at `.rea/review-cache.jsonl` (gitignored
via the existing `.rea/` rule). Serialized via the same `proper-lockfile`
helper as the audit log. Not hash-chained — the audit log is the
integrity story; the cache is advisory.

New policy knob: `review.cache_max_age_seconds` (default 3600s). Entries
older than the TTL return `{"hit":false}` so a review stays fresh.

### 3. `REA_SKIP_PUSH_REVIEW` — whole-gate escape hatch

The existing `REA_SKIP_CODEX_REVIEW` bypasses only the Codex-audit branch.
0.5.0 adds `REA_SKIP_PUSH_REVIEW=<reason>`, which bypasses the *entire*
gate. It is the recovery path for consumers deadlocked on a broken rea
install (as BUG-009 would create if you upgraded to a BUG-008-only patch
without the `rea cache` subcommand).

Contract (matches `REA_SKIP_CODEX_REVIEW`):

- Value must be non-empty; empty string = unset.
- Value is recorded **verbatim** as the reason in the audit record. No
  default reason is supplied.
- Fails closed on missing `dist/audit/append.js` (rea unbuilt) or missing
  git identity. Refuses to bypass without a receipt.
- Writes an audit record with
  `tool_name: "push.review.skipped"`, `server_name: "rea.escape_hatch"`,
  `verdict: "skipped"`, plus branch/head_sha/reason/actor.

Critically, a skip record does **not** satisfy the Codex-review jq
predicate. Bypassing the whole gate does not retroactively count as a
review of the commits.

## Upgrade path

### Option A — fresh install or re-init

```sh
pnpm up @bookedsolid/rea@^0.5.0
rea init   # refreshes .claude/, .husky/, and the managed CLAUDE.md block
```

If you have customizations under `.claude/agents/` or `.claude/hooks/`,
use `rea upgrade --dry-run` first to see what would change.

### Option B — upgrade with drift preservation

```sh
pnpm up @bookedsolid/rea@^0.5.0
rea upgrade --dry-run    # preview
rea upgrade              # apply; keeps drifted files, prompts on conflicts
```

### If your upgrade gets blocked by the gate itself

When the gate blocks a push and you have an urgent reason to unblock
(e.g. rea itself is what you're trying to fix):

```sh
REA_SKIP_PUSH_REVIEW="0.5.0-upgrade-unblock" git push
```

This writes a `push.review.skipped` audit record. Do not make it a habit —
`rea doctor` will surface repeat skips in a future release, and the audit
log is permanent.

## Known gotcha — consumer `.husky/pre-push` scaffolded on 0.3.x

If your `.husky/pre-push` invokes `.claude/hooks/push-review-gate.sh` by
piping synthesized JSON (the 0.4.x workaround pattern), the gate now
works — BUG-008's self-detect is in `push-review-gate.sh` itself, so both
the JSON wrapper pattern and the raw-stdin pattern converge on the same
pre-push parser.

## What is NOT covered by this migration

- **OIDC trusted publisher** stays deferred past 0.5.0. Publishing remains
  on the existing `NODE_AUTH_TOKEN` + `--provenance` path.
- **`.husky/pre-push` scaffolded by `rea init`** currently implements the
  gate logic inline (HALT + protected-path + Codex audit) rather than
  delegating to `push-review-gate.sh`. Adding `REA_SKIP_PUSH_REVIEW`
  support to that scaffolded hook is tracked for a follow-up PR in the
  0.5.0 window. Until that lands, the escape hatch works via
  `.claude/hooks/push-review-gate.sh` only.
