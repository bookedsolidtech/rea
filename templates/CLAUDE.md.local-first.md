# Local-first delegation (0.26.0+)

> Section merged into consumer `CLAUDE.md` by `rea init`. Do not edit
> by hand here — re-run `rea init` / `rea upgrade` to refresh.

## The rule

Every change goes through this loop BEFORE commit:

1. **Edit** the working tree.
2. **`rea review`** — runs codex against the working tree, writes a
   `rea.local_review` audit entry recording the verdict.
3. **Address** any blocking findings in-tree, re-review until pass
   or only-P3.
4. **Commit** (one squashed commit ideally) and **push** — the husky
   pre-push hook calls `rea preflight --strict`, which checks the
   audit log for a recent matching entry. The push-gate is the
   BACKUP layer, not the primary review surface.

## Why

The push-gate (`.husky/pre-push` running `codex exec review`) catches
late: by the time it fires, the diff is already committed. Fixing
findings means amending or stacking fix-commits. The result on your
PR is a chain of "fix codex finding" commits the reviewer (human or
agent) has to wade through.

Local-first review reverses the loop: codex sees the diff while it's
still in the working tree. Findings get fixed in-place. The PR lands
green-first-try, single-squashed-commit.

This is the rule for ALL rea work — OSS + enterprise — per CTO
directive 2026-05-05.

## Commands

```bash
rea review              # run codex on working tree, write audit entry
rea preflight           # check status (exit 0/1/2)
rea preflight --strict  # treat warns as refusals (husky uses this)
```

## Escape hatches

- **Per-invocation override**: `REA_SKIP_LOCAL_REVIEW="<reason>" git push`
  — audit logs the reason. Use sparingly; the override is a release
  valve, not a sustained way to disable enforcement.
- **Team off-switch**: in `.rea/policy.yaml` set:

  ```yaml
  review:
    local_review:
      mode: off
  ```

  Use this when your team doesn't have codex/claude installed.
  Every enforcement layer becomes a silent no-op; the push-gate
  (governed separately by `review.codex_required`) is unaffected.

## What gets enforced

Three layers, all calling `rea preflight`:

1. **Bash-tier hook** (`.claude/hooks/local-review-gate.sh`) —
   refuses `git push` (and optionally `git commit`) from Claude
   Code's Bash tool BEFORE the command runs. This is the agent-
   specific forceful layer.
2. **Husky pre-push** (`.husky/pre-push`) — refuses `git push` at
   the terminal layer. Catches CI and human pushes too.
3. **Direct `rea preflight`** — operators run it manually to
   check status before commit.

## Debugging

```bash
rea preflight --json           # structured output
cat .rea/audit.jsonl | grep rea.local_review | tail -3
```

A `rea.local_review` entry covers HEAD when:
- `metadata.head_sha` matches `git rev-parse HEAD`
- `metadata.verdict` is not `error` or `blocking`
- `record.timestamp` is within `policy.review.local_review.max_age_seconds`
  of now (default 24h)

Pre-0.26.0 audit entries with `tool_name: codex.review` are also
accepted as covering HEAD — back-compat for upgrade.
