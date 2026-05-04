# Hook Troubleshooting — for AI Agents

> **Audience.** AI agents debugging hook failures inside Claude Code.
> Operator-facing migration content lives in
> [`docs/migration/0.23.0.md`](../migration/0.23.0.md).

This is a symptom → cause → fix table for the most common hook
failures. The audit log at `.rea/audit.jsonl` is the source of truth
for what fired and why.

## How to read `.rea/audit.jsonl`

Every line is a JSON object. The schema (loose, since we never
break-change it):

```jsonc
{
  "ts": "2026-05-04T14:55:23.456Z",
  "event_id": "abc123…",
  "prev_hash": "<sha256 of previous line>",
  "hash": "<sha256 of this line>",
  "session_id": "<harness session id>",
  "tool_name": "Bash",
  "verdict": "block",     // or "allow", or "redacted"
  "hook": "protected-paths-bash-gate.sh",
  "tool_input": { ... },  // truncated/redacted
  "details": {
    "reason": "PROTECTED PATH (bash): …",
    "hit_pattern": ".rea/HALT",
    "detected_form": "redirect",
    // ... varies per hook
  }
}
```

To find the most recent block:

```bash
tail -n 200 .rea/audit.jsonl | jq -c 'select(.verdict == "block")' | tail -n 5
```

To find every fire of a specific hook:

```bash
grep -F '"hook":"protected-paths-bash-gate.sh"' .rea/audit.jsonl | tail -n 20 | jq -c '{ts, verdict, details}'
```

The hash chain means:

- `prev_hash` of line N must equal `hash` of line N-1.
- A break in the chain means tampering OR a malformed write. Run
  `rea audit verify` to check.

## Symptoms

### "PreToolUse:Bash hook error: rea CLI not found"

**Cause.** The Bash-tier shim couldn't resolve the rea CLI through
either of the 2 sandboxed paths:

1. `<CLAUDE_PROJECT_DIR>/node_modules/@bookedsolid/rea/dist/cli/index.js`
2. `<CLAUDE_PROJECT_DIR>/dist/cli/index.js`

(Round 4 + round 5 dropped the previous tiers — `rea` on PATH and
`node_modules/.bin/rea` symlink — because both are
workspace-attacker-controllable.)

**Fix.**

1. **Check `CLAUDE_PROJECT_DIR`.** `echo $CLAUDE_PROJECT_DIR`. It
   must point at the project root, not a parent or sibling.
2. **Verify the install.**
   ```bash
   ls -la "$CLAUDE_PROJECT_DIR/node_modules/@bookedsolid/rea/dist/cli/index.js"
   # Must be a real file, not a symlink to outside the project.
   ```
3. **If working in the rea repo itself** (dogfood), build the dist:
   ```bash
   pnpm build
   ls -la "$CLAUDE_PROJECT_DIR/dist/cli/index.js"
   ```
4. **If `node_modules/@bookedsolid/rea` is a symlink to outside**
   the project root (pnpm hoisted monorepo layout), reinstall with
   `--shamefully-hoist=false` for the rea package, or move the
   install inside the project.

The shim refuses on uncertainty rather than silently allowing — this
is intentional fail-closed posture.

### "PROTECTED PATH (bash): nested-shell payload is dynamic"

**Cause.** A `bash -c "$VAR"`, `bash -c "$(cmd)"`, or deeper-than-8
nested `bash -c` was scanned. The inner payload is computed at
runtime, so the scanner cannot statically resolve what file would be
written.

Round 8 also catches DQ-escape parity bypasses: shapes like
`bash -c "echo \"\$(rm .rea/HALT)\""` previously slipped through
because `unshellEscape` only collapsed `\"` and `\'`. The fix
expanded the replace class to all 5 bash DQ-significant escapes.

**Fix.** Inline the command instead of wrapping in `bash -c "..."`
with a `$`-expanded payload. If you genuinely need dynamic command
construction:

- **Resolve the dynamic part first.** Compute the literal value
  above the bash boundary, then pass it through.
- **If it's a literal**, drop the `bash -c` wrapper:
  ```sh
  bash -c "echo $VAR"   # ← scanner blocks (dynamic)
  echo "$VAR"           # ← scanner allows (no nested shell)
  ```

### "PROTECTED PATH (bash): unresolved shell expansion in target"

**Cause.** A redirect target like `> $VAR` or `> $(cmd)` —
dynamic, refuse on uncertainty.

**Fix.** Resolve the variable to a literal before the redirect.
Or, if the redirect is intentionally dynamic and the consumer
context is safe, route the work through a non-bash tool (Edit /
Write).

### "PROTECTED PATH (bash): xargs destination is fed via stdin"

**Cause.** `xargs CMD` reads its arguments from stdin; the scanner
can't see them at parse time.

**Fix.** Rewrite as a `for` loop with explicit destinations:

```sh
# Before:
find . -name '*.log' | xargs rm

# After:
for f in *.log; do rm -- "$f"; done
```

The `for` form has visible argv at parse time so the scanner can
analyze each iteration target.

### Scanner allows a command you expected to BLOCK

**Cause.** A real bypass slipped through.

**Fix.** **Do not work around it. Surface it immediately.**

1. **Capture the verbatim command** + the protected target it
   reached.
2. **Add a fixture** to `__tests__/hooks/bash-tier-corpus.test.ts`
   (or the appropriate `-roundN.test.ts`) so the bypass is pinned
   as a regression test forever.
3. **Trace** which detector should have fired. Look at
   `walker.ts::walkCallExpr` for the cmdName, or
   `extractStmtRedirects` for redirect-form writes.
4. **Add the missing case** following
   [`docs/agents/bash-scanner-extension.md`](./bash-scanner-extension.md).
5. **Run** `pnpm vitest run __tests__/hooks/bash-scanner/` —
   ALL existing tests must still pass.
6. **Run `/codex-review`** before commit to catch related class
   bypasses you may have missed.

In the interim, before the fix lands:

- Add the path to `policy.protected_writes` AND ensure no
  `protected_paths_relax` is removing it.
- Set `.rea/HALT` to lock the harness while the bypass is
  investigated:
  ```bash
  echo "Bypass class under investigation - do not run agent" > .rea/HALT
  ```

### Scanner blocks a command you expected to ALLOW

**Cause.** Over-correction. Fail-closed posture means the scanner
prefers blocking on uncertainty.

**Fix.** Identify the detector that fired and decide whether the
block is correct.

1. **Read the audit entry.** `details.detected_form` names the
   detector.
2. **Check `details.hit_pattern`.** This is the protected pattern
   that matched, or a sentinel like `(dynamic target)` /
   `(nested-shell unresolvable)` / `(xargs unresolvable stdin)`.
3. **Decide:**
   - **The block is correct.** Rewrite the command (see the
     "nested-shell payload is dynamic" section above for typical
     rewrites).
   - **The block is a false positive.** Add a negative fixture
     to the corpus (Class O-neg, Class P-neg, etc.) and adjust
     the detector. Surface to the user before committing — false
     positives are a real product issue.

### Hook fires twice on the same input

**Cause.** Either:

- The hook is registered against multiple matchers (e.g.
  `Write|Edit` + `MultiEdit` separately). `.claude/settings.json`
  may have duplicate entries.
- A pre-tool and post-tool variant of the same hook are both
  registered. Some hooks have an advisory-only post-tool form.

**Fix.** Inspect `.claude/settings.json`:

```bash
jq '.hooks' .claude/settings.json
```

Each entry should have a unique (`event`, `matcher`, `command`)
tuple. Duplicates indicate a settings-merge bug — file an issue.

### Audit chain broken (`prev_hash` mismatch)

**Cause.** Either:

- A process other than `rea` wrote to `.rea/audit.jsonl` directly
  (manual `echo >>` for instance — never do this).
- A crash mid-write left a partial line.
- The file was rotated out from under the gateway (the rotator at
  `src/gateway/audit/rotator.ts` handles this with locking, but
  external rotation breaks the chain).

**Fix.**

1. Run `rea audit verify` to find the first broken line.
2. **DO NOT edit `.rea/audit.jsonl`.** It's append-only. Editing
   destroys the audit guarantee.
3. If the break is from a crash, the rotator will handle it on
   next gateway start — verify with another `rea audit verify`.
4. If the break is from external tampering, treat it as a security
   incident. Surface to `@himerus`.

### `rea doctor` reports "false-positive on husky 9 layout"

**Cause.** Pre-0.13.1 `rea doctor` flagged husky 9's auto-generated
stub at `.husky/_/pre-push` as a foreign hook. 0.13.1+ detects the
stub shape and follows one level of indirection.

**Fix.** Upgrade rea to 0.13.1 or later.

### Husky pre-push body clobbers fragments' argv

**Cause.** Pre-0.13.2 the `BODY_TEMPLATE` substituted the rea CLI
argv into the pre-push body, overwriting `$@`. Fragment scripts
under `.husky/pre-push.d/` saw the rea argv instead of git's.

**Fix.** Upgrade rea to 0.13.2 or later. The 0.13.2 fix wraps the
substitution in a subshell so `$@` is preserved for fragments.

### `pre-push` runs `git push` but `/codex-review` was never invoked

**Cause.** `policy.review.codex_required` is false (default in some
profiles), or the codex-auto-review CLI failed silently.

**Fix.**

1. Set `policy.review.codex_required: true` in `.rea/policy.yaml`
   if you want the gate enforced.
2. Verify codex CLI is on PATH: `command -v codex`. The push-gate
   probes the CLI through `rea doctor`.
3. Check `.rea/audit.jsonl` for `rea.push-gate` entries — the
   verdict is recorded with the input commit range.

### `rea init` resets policy fields you customized

**Cause.** Pre-0.21.1 `rea init` overwrote manually-edited policy
values (autonomy_level, max_autonomy_level, blocked_paths, ...).

**Fix.** Upgrade rea to 0.21.1+. The fix preserves manual edits
across re-runs of `rea init`.

## When the troubleshooting steps don't apply

If the symptom doesn't match any entry above:

1. **Capture the verbatim** error message and the surrounding 50
   lines of `.rea/audit.jsonl`.
2. **Identify the hook** that fired — the path is in stderr or in
   `.audit.jsonl`'s `hook` field.
3. **Read the hook source** at `hooks/<hook-name>.sh`. Every hook
   has a header docstring explaining its triggers and failure
   modes.
4. **Surface to the user** with that context. Do NOT bypass the
   hook with `--no-verify` or any flag — that defeats the whole
   project.

## Cross-references

- [`docs/agents/README.md`](./README.md) — agent entry point
- [`docs/agents/bash-scanner-extension.md`](./bash-scanner-extension.md) — extension recipe
- [`docs/architecture/bash-scanner.md`](../architecture/bash-scanner.md) — bash-scanner architecture
- [`docs/migration/0.23.0.md`](../migration/0.23.0.md) — operator
  migration troubleshooting
- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — security claims
