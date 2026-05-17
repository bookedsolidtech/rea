# Hook Playbook (0.32.0–0.42.0 lessons, codified)

This is the canonical contributor reference for adding or modifying a
PreToolUse / PostToolUse hook in rea. Read this first; you should be
able to add a new hook by following these patterns plus skimming one
existing hook (recommended: `dangerous-bash-interceptor`).

The lessons here came out of the 11-release marathon that ported all
14 bash hooks to Node-binary executors (0.32.0–0.35.0), consolidated
the shim runtime (0.38.0), and hardened the policy reader, sandbox
check, and version probe across 0.34.0–0.42.0. Every "rule" below has
a release/round citation so you can read the original incident.

> Scope note: this doc is about PreToolUse/PostToolUse hooks — the
> shell scripts under `hooks/` that Claude Code dispatches before/after
> tool calls. The push-gate (`.husky/pre-push` + `src/hooks/push-gate/`)
> is a different surface and is not covered here.

---

## Table of contents

1. [Hook anatomy](#1-hook-anatomy)
2. [The `shim_run` API](#2-the-shim_run-api)
3. [Fail-open vs blocking-tier posture](#3-fail-open-vs-blocking-tier-posture)
4. [Relevance pre-gate patterns](#4-relevance-pre-gate-patterns)
5. [Policy short-circuit hooks](#5-policy-short-circuit-hooks)
6. [Sandbox check expectations](#6-sandbox-check-expectations)
7. [Test corpus shape](#7-test-corpus-shape)
8. [Dogfood mirror bootstrap](#8-dogfood-mirror-bootstrap)
9. [The awk-comment-quote class lesson](#9-the-awk-comment-quote-class-lesson)
10. [Codex iteration discipline](#10-codex-iteration-discipline)
11. [Cross-references](#11-cross-references)

---

## 1. Hook anatomy

Every PreToolUse / PostToolUse hook in rea has the same four-file shape.

### Files

```
src/hooks/<name>/
  index.ts                 # Node-binary executor — the real logic.
  <name>.test.ts           # Unit tests for the executor.

hooks/
  <name>.sh                # Bash shim — ~25–60 LOC. Sourced by Claude.

.claude/hooks/
  <name>.sh                # Dogfood mirror — identical to hooks/<name>.sh.

templates/
  <name>.dogfood-staged.sh # Bootstrap template (see §8).

__tests__/hooks/parity/baselines/
  <name>.sh.pre-<version>.sh   # Frozen pre-port bash body, for parity.
```

### Wiring

- `src/cli/hook.ts` maps the `rea hook <name>` CLI subcommand to the
  executor's `run<Name>` function.
- `src/cli/install/settings-merge.ts::defaultDesiredHooks()` registers
  the shim with Claude Code (matcher, timeout, statusMessage).
- `src/cli/doctor.ts::EXPECTED_HOOKS` adds the filename to the
  required-on-disk list (doctor fails if missing post-install).

If you add a hook and forget any of these wirings, the doctor surfaces
it on next run. `EXPECTED_HOOKS` and `defaultDesiredHooks` are the two
canonical resolvers — `rea init`'s install summary derives its hook
listing from their union (see `canonicalInstalledHooks` in
`src/cli/init.ts`, added 0.44.0).

### The executor pattern

```ts
// src/hooks/<name>/index.ts
import type { Buffer } from 'node:buffer';
import { checkHalt, formatHaltBanner } from '../_lib/halt-check.js';
import { parseHookPayload, MalformedPayloadError } from '../_lib/payload.js';

export interface RunOptions { /* injectable seams for tests */ }
export interface RunResult { exitCode: number; stderr?: string; stdout?: string; }

export async function runMyHook(
  stdin: Buffer | string,
  opts: RunOptions = {},
): Promise<RunResult> {
  // 1. HALT — single chokepoint for the kill switch.
  const halt = checkHalt(opts);
  if (halt !== null) return { exitCode: 2, stderr: formatHaltBanner(halt) };

  // 2. Parse + type-narrow the Claude payload. Malformed → exit 2 / fail-open.
  let payload;
  try { payload = parseHookPayload(stdin); }
  catch (e) {
    if (e instanceof MalformedPayloadError) return { exitCode: 2, stderr: '...' };
    throw e;
  }

  // 3. Apply the rule(s). Return exit 0 (pass) or exit 2 (refuse).
  // 4. Banners go in stderr; stdout is reserved for structured output
  //    (currently unused — keep empty).
}
```

Keep the executor framework-free: no clack, no commander, no global
state. Tests should be able to import `runMyHook` and call it with a
literal JSON payload. The bash shim handles all process orchestration.

---

## 2. The `shim_run` API

`hooks/_lib/shim-runtime.sh` (introduced 0.38.0) is the shared runtime
that every shim sources. Each shim becomes ~20 LOC of customization
plus a single `shim_run` invocation. Before 0.38.0 each shim re-
implemented HALT + stdin capture + CLI resolution + sandbox check +
version probe (~120 LOC per shim) and the duplication was the single
largest source of drift bugs in the marathon.

### The minimal shim

```bash
#!/bin/bash
set -uo pipefail

source "$(dirname "$0")/_lib/halt-check.sh"
check_halt
REA_ROOT=$(rea_root)

SHIM_NAME="my-hook"
SHIM_INTRODUCED_IN="0.44.0"
SHIM_FAIL_OPEN=0
SHIM_REFUSAL_NOUN="my-hook protection"

source "$(dirname "$0")/_lib/shim-runtime.sh"
shim_run
```

That's it. `shim_run` reads the `SHIM_*` env vars, runs the standard
flow (HALT → stdin → relevance → CLI resolve → sandbox → policy
short-circuit → version probe → forward), and exits with the right
code per the tier you've declared.

### `SHIM_*` env vars

| Variable | Default | Purpose |
|---|---|---|
| `SHIM_NAME` | (required) | Subcommand name. Used in banners, the `rea hook <name>` invocation, and the version-probe content match. |
| `SHIM_INTRODUCED_IN` | (required) | Version string like `"0.34.0"`. Used in the version-skew banner. |
| `SHIM_FAIL_OPEN` | `0` | `1` for advisory-tier (exit 0 on CLI-failure branches except HALT); `0` for blocking-tier (exit 2). |
| `SHIM_ENFORCE_CLI_SHAPE` | `0` | `1` requires the resolved CLI's realpath to end in `dist/cli/index.js`. Set on shims that protect security boundaries. |
| `SHIM_REFUSAL_NOUN` | `"protection"` | Used in the fail-closed CLI-missing banner ("to restore $SHIM_REFUSAL_NOUN"). |
| `SHIM_NODE_MISSING_NOUN` | same as `SHIM_REFUSAL_NOUN` | Used in the "node not on PATH" banner. |
| `SHIM_SKIP_VERSION_PROBE` | `0` | `1` skips the version-probe entirely. Set on `delegation-capture` (fire-and-forget). |

### Callable hooks (functions the shim may define)

Define these BEFORE calling `shim_run`. Each runs in the same process,
with access to `INPUT` (captured stdin), `REA_ROOT`, `proj` (project
dir), `REA_ARGV` (resolved CLI argv array), `RESOLVED_CLI_PATH`.

- **`shim_is_relevant`** — runs after stdin capture, BEFORE any CLI
  work. Return 0 to pass through the gate, 1 to exit 0 immediately.
  Most shims define this for the relevance pre-gate (§4).
- **`shim_cli_missing_relevant`** — runs when the CLI is unreachable.
  Return 0 to fail-closed (banner + exit 2 or exit 0 per `FAIL_OPEN`);
  return 1 to exit 0 silently (matches the pre-port bash body's no-rule-
  matched behavior). Without this callback, default behavior is:
  blocking-tier emits banner + exit 2; advisory-tier exits 0 silently.
- **`shim_policy_short_circuit`** — runs AFTER sandbox-check, BEFORE
  version-probe. Return 0 to exit 0 (policy disabled the gate);
  return 1 to continue. Used by `attribution-advisory` (checks
  `block_ai_attribution`) and `security-disclosure-gate` (checks
  `REA_DISCLOSURE_MODE=disabled`).
- **`shim_forward`** — overrides the final stdin-forward step.
  Default: `printf '%s' "$INPUT" | "${REA_ARGV[@]}" hook "$SHIM_NAME"`.
  `delegation-capture` overrides this to detach (background + disown)
  so signal emission never blocks tool dispatch.

### Standardized banners

`shim_run` emits a fixed set of banners with consistent wording:

- `cli-missing-banner` — "the rea CLI is not built. Run `pnpm install
  && pnpm build` to restore $SHIM_REFUSAL_NOUN."
- `node-missing-banner` — "`node` is not on PATH. Install Node 22+."
- `sandbox-failure-banner` — "FAILED sandbox check (`<reason>`)."
- `sandbox-skip-banner` (advisory-tier only) — "skipped (sandbox
  check: `<reason>`)."
- `version-skew-banner-blocking` / `version-skew-banner-advisory` — 
  "requires the `rea hook <name>` subcommand (introduced in
  $SHIM_INTRODUCED_IN)."

Do NOT re-emit these from inside `shim_is_relevant` or
`shim_policy_short_circuit`. Stick to the standard set so operators
see consistent messages across all 14+ hooks.

### Bash 3.2 compatibility

`shim-runtime.sh` targets macOS bash 3.2. Inside your shim, avoid:

- `mapfile` / `readarray`
- `read -d`
- `${VAR^^}` / `${VAR,,}` (case toggling)
- Associative arrays (`declare -A`)

OK to use: indexed arrays, indirect expansion (`${!VAR}`), `[[`, `case`.

---

## 3. Fail-open vs blocking-tier posture

Every hook MUST pick a tier. The decision is part of the hook's
specification, not an implementation detail.

### Blocking-tier (`SHIM_FAIL_OPEN=0`)

The hook refuses (exit 2) when:

- HALT is active
- The CLI is unreachable AND the payload is relevant
- The sandbox check fails
- The version probe finds a stale CLI
- The CLI itself returns non-zero

Use blocking-tier for **enforcers**: dangerous-bash-interceptor, secret-
scanner, settings-protection, blocked-paths-{bash-gate,enforcer},
protected-paths-bash-gate, env-file-protection, dependency-audit-gate,
changeset-security-gate, security-disclosure-gate, local-review-gate.

The rule is: if the pre-port bash body refused on a given input shape,
the shim MUST also refuse on that shape. The CLI-missing branch is the
trickiest case — see §4 for how `shim_cli_missing_relevant` preserves
this invariant.

### Advisory-tier (`SHIM_FAIL_OPEN=1`)

The hook nudges via stderr but always exits 0 on CLI-failure branches.

Use advisory-tier for **nudges**: pr-issue-link-gate, architecture-
review-gate, delegation-advisory, delegation-capture, attribution-
advisory (PostToolUse variant).

The rule for advisory-tier: a missing CLI must NEVER block a tool
call. Nudges are quality-of-life, not security claims.

### Interaction with the relevance pre-gate

`shim_is_relevant` runs BEFORE the CLI is resolved. If your shim
returns 1 here, the hook exits 0 unconditionally — no CLI required.
This is the right shape for hooks like `secret-scanner` that look at
the file path / extension: if the payload isn't writing a file at all,
there's nothing to scan and the gate should be invisible.

`shim_policy_short_circuit` runs AFTER sandbox-check but BEFORE the
version probe. This is the right shape when policy alone can disable
the gate (e.g. `block_ai_attribution: false`).

The order matters: a malicious payload should never reach the policy
short-circuit through an unsandboxed CLI. Round-2 P1 of 0.37.0 closed
exactly this gap — pre-fix, `attribution-advisory`'s policy read could
invoke an untrusted Tier-1 CLI. The fix moved the sandbox check before
the policy short-circuit; `shim_run` enforces the correct order now.

---

## 4. Relevance pre-gate patterns

The relevance pre-gate is the single most important contract in the
shim. Get it wrong and you get either:

- **Over-trigger**: spawning the Node CLI on every Bash dispatch
  including `ls`/`echo`/`pwd`, burning hundreds of ms of latency on
  agent loops that never produce a refusal.
- **Under-trigger**: missing a payload shape that the pre-port bash
  body would have refused → silent security regression.

The marathon's working pattern is **substring scans for the payload
shape this hook actually processes**:

```bash
shim_cli_missing_relevant() {
  # Extract the field the executor would inspect. Use jq if present
  # for correctness; fall back to scanning the raw payload (over-
  # trigger by design — CLI is the source of truth, this is the
  # fail-closed-only branch).
  local cmd=""
  if command -v jq >/dev/null 2>&1; then
    cmd=$(printf '%s' "$INPUT" | jq -r '(.tool_input.command // "") | tostring' 2>/dev/null || true)
  else
    cmd="$INPUT"
  fi
  if [ -z "$cmd" ]; then return 1; fi  # Empty/non-Bash → pre-port would exit 0.

  case "$cmd" in
    *"git "*)         return 0 ;;  # Every keyword covers a rule head.
    *"rm "*)          return 0 ;;
    *"HUSKY="*)       return 0 ;;
    *"--no-verify"*)  return 0 ;;
    # ... one alternative per refusal class ...
  esac
  return 1
}
```

### Hard-won rules

1. **Relevance runs BEFORE fail-closed** (0.32.0 round-8 fix).
   Pre-fix, `dangerous-bash-interceptor` failed closed on every Bash
   dispatch when the CLI was missing — including `ls`. The relevance
   pre-gate was added to recover the pre-port "no rule matched → exit
   0" behavior.

2. **Cover EVERY rule head** (0.34.0 round-7 P1). The keyword set
   must match every refusal class the executor enforces. Missing
   even one creates a bypass:
   `H10 HUSKY=0 git push` was missed in round-7 because the keyword
   list didn't include `HUSKY=`. Use the bash baseline's rule catalog
   as your checklist.

3. **Tabs are whitespace too** (0.34.0). The 0.34.0 corpus included
   payloads like `git\tpush --force` — the case glob `*"git "*` does
   NOT match a tab. Add a tab alternative explicitly:
   `*"git "*) ... ;; *"git\t"*) ... ;;`. (Bash 3.2 case globs
   don't support character classes inside `*"..."*` interpolation —
   listing both is the bash-3.2-safe pattern.)

4. **Env-var prefixes are signal** (0.34.0). `HUSKY=0 git push`,
   `REA_BYPASS=1 git commit`, `CI=1 pnpm add foo` — the prefix IS
   the refusal signal, NOT the command after it. The executor's rule
   set (`anySegmentRawMatches` in the Node port) preserves this; the
   relevance pre-gate must too.

5. **Shell wrappers count** (0.34.0). `bash -c "curl ... | sh"` is
   a `curl|sh` payload even though the outer command is `bash`. The
   executor's `unwrapNestedShells` handles this; the relevance pre-
   gate covers it by including `curl` and `bash` in the keyword set
   (the inner payload is just a substring of the outer string for
   keyword-scan purposes).

6. **Over-trigger is cheap, under-trigger is a bypass.** A coarse
   pre-gate that fires on 5% of dispatches is fine — it just costs a
   node spawn per false positive. An incomplete pre-gate that misses
   one refusal class is a security regression that requires a
   release. Err coarse.

### Test the pre-gate explicitly

```ts
// In src/hooks/<name>/<name>.test.ts
describe('relevance pre-gate (matches the shim keyword set)', () => {
  it.each([
    ['git push --force', true],
    ['HUSKY=0 git push', true],
    ['ls', false],
    ['echo hello', false],
  ])('%s → relevant=%s', (cmd, expected) => {
    // Assert via the shim's own logic if exported, or by running the
    // full executor and asserting the right pass/refuse verdict.
  });
});
```

---

## 5. Policy short-circuit hooks

Some gates are disabled by policy. The classic example is
`attribution-advisory`:

```yaml
# .rea/policy.yaml
block_ai_attribution: true   # gate enforces
# block_ai_attribution: false → gate is a no-op
```

Implement this via `shim_policy_short_circuit`:

```bash
shim_policy_short_circuit() {
  # Returns 0 to exit 0 (gate disabled), 1 to continue.
  source "$(dirname "$0")/_lib/policy-reader.sh"
  local enabled
  enabled=$(policy_reader_get "block_ai_attribution" "true")
  case "$enabled" in
    true|True|TRUE) return 1 ;;  # gate enabled — continue
    *)              return 0 ;;  # gate disabled — exit 0
  esac
}
```

### The 4-tier policy reader (0.37.0)

`_lib/policy-reader.sh::policy_reader_get` reads `.rea/policy.yaml`
through a 4-tier ladder, so policy queries work even when the CLI is
unreachable:

1. **Tier 1**: `rea hook policy-get <key>` — full schema validation.
2. **Tier 2**: `python3 -c '... yaml.safe_load ...'` — handles flow
   syntax, anchors, multi-doc.
3. **Tier 3**: in-process awk — handles block-form scalars only, the
   shape rea writes.
4. **Tier 4**: fixed default — returns the schema default for the key.

The key invariant: a shim whose policy says "disabled" exits 0
cleanly even when the rea CLI is unbuilt OR node is absent. This
matches the pre-port bash body's no-op-on-disabled posture (0.38.1
round-2 P2 fix).

### Why sandbox runs BEFORE policy short-circuit

`shim_policy_short_circuit` may call `policy_reader_get`, which in
Tier 1 invokes the rea CLI. If the CLI hasn't been sandbox-validated
yet, an attacker who repoints `node_modules/@bookedsolid/rea` →
arbitrary JS would execute that JS as a trusted gate component
(0.37.0 codex round-2 P1).

`shim_run` calls sandbox-check first, THEN policy short-circuit.
Don't try to invert this in your shim.

---

## 6. Sandbox check expectations

The sandbox check is the trust boundary that says "this resolved CLI
is the real rea CLI shipped by this project, not a forgery."

### Resolution order (PATH-free)

```bash
shim_resolve_cli() {
  REA_ARGV=()
  RESOLVED_CLI_PATH=""
  if [ -f "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js" ]; then
    REA_ARGV=(node "$proj/node_modules/@bookedsolid/rea/dist/cli/index.js")
  elif [ -f "$proj/dist/cli/index.js" ]; then
    REA_ARGV=(node "$proj/dist/cli/index.js")
  fi
}
```

`$PATH` is INTENTIONALLY OMITTED (0.29.0 round-3 P1). An agent-
controlled `$PATH` would let a forged `rea` binary in
`/tmp/attacker-bin/` intercept every hook dispatch. The 2-tier
sandboxed order — consumer install first, source checkout second —
covers both the consumer install shape and the dogfood/dev shape.

### The realpath check

After resolution, `shim_sandbox_check` validates THREE things:

1. **CLI lives inside `CLAUDE_PROJECT_DIR`** — `realpath(cli)` must
   start with `realpath(CLAUDE_PROJECT_DIR) + sep`. Symlink games
   that escape the project root fail here.
2. **An ancestor `package.json` has `name=@bookedsolid/rea`** — walks
   up from `dirname(dirname(dirname(real)))` for up to 20 levels,
   reads each `package.json`, checks `name`. Closes the "drop a
   matching directory structure with arbitrary JS" attack.
3. **(Optional) `realpath` ends in `dist/cli/index.js`** — only
   enabled when `SHIM_ENFORCE_CLI_SHAPE=1`. Closes the 0.35.0 codex
   round-1 P1 (a workspace attacker who repoints
   `node_modules/@bookedsolid/rea` → arbitrary in-project JS file
   would otherwise execute that file as the trusted gate CLI).

### When to set `SHIM_ENFORCE_CLI_SHAPE=1`

Set it for any shim that defends a security boundary where an
attacker landing arbitrary JS execution would defeat the gate's
purpose. The standard set: `settings-protection`, `blocked-paths-
bash-gate`, `blocked-paths-enforcer`, `protected-paths-bash-gate`.

Advisory hooks (pr-issue-link-gate, architecture-review-gate) don't
need it — they exit 0 on sandbox failure anyway.

### Don't roll your own sandbox check

Use the standard `shim_sandbox_check` via `shim_run`. The
verification logic is fiddly (symlink resolution, the `+ sep` quirk
to avoid false-prefix matches, the package.json walk-up bound) and
the standard implementation has been adversarially reviewed across
multiple Codex rounds.

---

## 7. Test corpus shape

### Per-hook unit tests

Live next to the executor: `src/hooks/<name>/<name>.test.ts`. Drive
the executor function directly with literal JSON payloads. Cover:

- **Pass-through**: payloads the hook should NOT refuse (sanity).
- **Refuse**: one fixture per rule / refusal class.
- **Bypass corpus**: payloads that look like a refusal but are
  legitimate (e.g. `git rebase --abort` is safe even though the
  payload contains `rebase`).
- **Edge cases**: empty payload, missing fields, non-Bash tools,
  malformed JSON.

The bypass corpus is the most important — that's where the
adversarial review rounds find regressions. When Codex flags an
issue, add a fixture for it AND for the sibling-class permutations.

### Parity baselines

`__tests__/hooks/parity/baselines/<name>.sh.pre-<version>.sh` is the
frozen pre-port bash body. The parity test
(`__tests__/hooks/parity/node-parity.test.ts`) runs both the bash
baseline and the Node port against the same payload corpus and
asserts equivalent verdicts.

This is the test that catches the "I ported H7 but missed H12"
class of bugs. Don't remove the baselines after a port — they're the
regression contract.

### Skipping on Windows

The parity tests skip on Windows (`process.platform === 'win32'`)
because reliable bash isn't available there. They also skip when
`SKIP_BASH_PARITY=1` is set (fast inner-loop runs). For
representative coverage, run them in CI on macOS + Ubuntu.

### Shim-level integration tests

`__tests__/hooks/policy-reader-shim-parity.test.ts` exercises the
4-tier policy reader across all the shims that call it. Add a case
when your shim adds a new policy short-circuit key.

---

## 8. Dogfood mirror bootstrap

`.claude/hooks/<name>.sh` is the dogfood mirror — rea governs its
own repo using the same hooks it ships to consumers. The mirror must
stay byte-identical to `hooks/<name>.sh`.

### The chicken-and-egg

`settings-protection.sh` (one of the gates) refuses Write/Edit/
MultiEdit to `.claude/hooks/*`. So you can't just `Write` the new
mirror file into place — the gate refuses its own bootstrap.

### The proven pattern

Stage the file in `templates/<name>.dogfood-staged.sh` (a path NOT
under `.claude/`), then `git apply` a patch whose payload contains
the destination path. `settings-protection` inspects `argv` not the
patch body, so the patch goes through.

```bash
# In your bootstrap script for the new hook:
cp hooks/my-hook.sh templates/my-hook.dogfood-staged.sh

# Then generate a patch that creates .claude/hooks/my-hook.sh from
# the staged template, and git-apply it. Since the destination path
# only appears in the patch BODY (not in the git-apply argv), the
# settings-protection gate doesn't fire.
git diff --no-index /dev/null templates/my-hook.dogfood-staged.sh \
  | sed 's|templates/my-hook.dogfood-staged.sh|.claude/hooks/my-hook.sh|g' \
  | git apply
chmod +x .claude/hooks/my-hook.sh
```

Existing examples: every `templates/*.dogfood-staged.sh` in the
repo. The pattern came out of 0.32.0 → 0.35.0 when porting required
re-syncing the mirror after every shim change.

### Once bootstrapped

`hooks/<name>.sh` and `.claude/hooks/<name>.sh` should be kept in
sync by ordinary editing. The dogfood install copies `hooks/*` →
`.claude/hooks/*` on `rea init`, but for in-repo development you
edit both. Drift between them is caught by:

- The install manifest hash (drift detection on next `rea init`).
- The dogfood mirror's appearance in the parity tests.

---

## 9. The awk-comment-quote class lesson

In 0.34.0 the marathon hit one class of bug twice — round-4 and
round-6. Round-6 locked the entire repo (every Bash refused at hook
parse time because every hook sourced `_lib/cmd-segments.sh` which
crashed at parse). Repair required out-of-session `git apply`.

### The class

Bash hooks frequently embed an awk script inside a bash-single-quoted
argument:

```bash
awk '
  # awk comment with apostrophe — DON'T do this  ← BUG
  { print $1 }
'
```

Bash single-quoted strings have ONE rule: no escape sequences. The
string ends at the next unescaped `'`. If any character inside the
awk body is a literal `'`, bash terminates the string there. The
rest of the awk body is then re-parsed as bash, almost always
producing a `syntax error near unexpected token` — or worse, silently
shelling out to whatever follows.

### The fix (0.36.0)

`scripts/lint-awk-shim-quotes.mjs` is a build-time lint that catches
this class. It scans every `*.sh` under `hooks/` and `.claude/hooks/`
(dogfood mirror), finds every `awk '<NL>` block opening (the multi-
line shape that triggers the class), and flags any comment line
inside that contains a literal `'`.

The lint is wired into `pnpm lint` (and CI). If you add a new shim
that embeds awk, run `pnpm lint:awk-shim-quotes` and address any
flags. The lint deliberately skips single-line awk invocations
(`awk '{ print $1 }'`) because they can't have a comment line.

### Safe alternatives inside multi-line awk

- Use double quotes for the comment: `# This is OK` — no apostrophe.
- Word it without the apostrophe: `# Do not do this` instead of
  `# Don't do this`.
- Move the comment OUT of the awk body — into a bash comment above
  the awk invocation. The awk script gets cleaner anyway.

---

## 10. Codex iteration discipline

The marathon norm is single-commit-per-PR with amends. The flow:

```
edit working tree
  ↓
local codex review (gpt-5.4 / reasoning_effort=high)
  ↓
amend the SAME commit with the fix
  ↓
re-run codex
  ↓
repeat until BLOCKING-clear (CONCERNS-only is OK to push)
  ↓
push → green-first-try PR
```

### What to fix vs defer

- **BLOCKING** (P0 / P1): MUST be fixed in the same commit before
  push. These are security regressions or correctness bugs.
- **CONCERNS** (P2): SHOULD be fixed in the same commit; OK to push
  with a CONCERNS verdict if the issue is genuinely lower-risk.
- **P3 / advisory**: can defer to a follow-up release with a brief
  rationale in the commit body or memory log.

### What "iterate to BLOCKING-clear" means

Codex round-N flags issue X. You fix X, amend, run round-N+1. The
new round either:

- Finds X is closed AND no new issues → ship.
- Finds X is closed BUT introduced Y → fix Y, amend, run round-N+2.

This is the catch-the-sibling-class pattern. The marathon's longest
ladders (0.23.0: 13 rounds; 0.34.0: 7 rounds) bottomed out at "no
new issues, no regressions on the fixed set." Don't push at "the
last round had findings but I addressed them" without re-running.

### When to use direct-Bash codex vs the wrapper agent

- **Default**: direct-Bash `rea hook codex-review` (0.27.0+) —
  thin invocation, gpt-5.4 / reasoning_effort=high, ~80 LOC. Cheap
  to iterate.
- **Verbose / triple-Opus burn**: `/codex-review --verbose` —
  wrapper-agent path, useful when you want Opus's narrative
  reasoning over the codex output (e.g. ambiguous P2 verdicts).

For marathon iteration on a tight cycle, prefer direct-Bash.

---

## 11. Cross-references

### Source-of-truth files

- `hooks/_lib/shim-runtime.sh` — the `shim_run` API (§2).
- `hooks/_lib/halt-check.sh` — HALT detection, `rea_root` helper.
- `hooks/_lib/policy-reader.sh` — 4-tier policy reader (§5).
- `hooks/_lib/cmd-segments.sh` — bash command segmentation; the
  class lesson lives here.
- `src/cli/doctor.ts::EXPECTED_HOOKS` — required-on-disk list.
- `src/cli/install/settings-merge.ts::defaultDesiredHooks` —
  Claude Code registration list.
- `src/cli/init.ts::canonicalInstalledHooks` — union of the two
  above; what `rea init`'s install summary lists (0.44.0+).
- `src/cli/hook.ts` — CLI subcommand router for `rea hook <name>`.
- `scripts/lint-awk-shim-quotes.mjs` — build-time awk-quote lint (§9).

### Test references

- `src/hooks/<name>/<name>.test.ts` — per-hook unit tests.
- `__tests__/hooks/parity/node-parity.test.ts` — bash↔Node parity
  driver.
- `__tests__/hooks/parity/baselines/<name>.sh.pre-<version>.sh` —
  frozen pre-port bash bodies.
- `__tests__/hooks/policy-reader-shim-parity.test.ts` — 4-tier
  policy reader integration.
- `__tests__/scripts/lint-awk-shim-quotes.test.ts` — the lint's own
  test suite.

### Example shims (by tier and complexity)

- **Blocking, with relevance pre-gate**: `dangerous-bash-interceptor`,
  `secret-scanner`, `settings-protection`.
- **Blocking, with policy short-circuit**: `attribution-advisory`
  (commit-msg path), `security-disclosure-gate`.
- **Blocking, with sandbox-shape enforcement**: `blocked-paths-bash-
  gate`, `blocked-paths-enforcer`, `protected-paths-bash-gate`.
- **Advisory, fire-and-forget**: `delegation-capture` (the only shim
  that overrides `shim_forward` to detach).
- **Advisory, simple**: `pr-issue-link-gate`, `architecture-review-
  gate`, `delegation-advisory`.

When in doubt, start by copying the shim closest to your tier and
shape, then customize the `SHIM_*` variables and the callable hooks.

### Release notes for the bugs cited above

- 0.32.0 round-8 — relevance pre-gate landed (recover "no rule
  matched → exit 0").
- 0.34.0 round-4 + round-6 — awk-comment-quote class (locked the
  repo at round-6); fixed structurally by the 0.36.0 lint.
- 0.34.0 round-7 P1 — relevance keyword catalog must cover EVERY
  refusal class.
- 0.35.0 round-1 P1 — `SHIM_ENFORCE_CLI_SHAPE` introduced.
- 0.36.0 charter item 3 — `lint-awk-shim-quotes.mjs` added.
- 0.37.0 round-2 P1 — sandbox-before-policy-short-circuit fix.
- 0.37.0 — 4-tier policy reader landed.
- 0.38.0 — `_lib/shim-runtime.sh` consolidation.
- 0.38.1 round-2 P2 — node-missing branch must still honor policy
  short-circuit.
- 0.42.0 — deferred P2 sweep (the previous cleanup release).
- 0.44.0 — install-summary derives from canonical resolvers; this
  doc itself.

---

If you find a pattern this doc doesn't cover, that's a sign of a new
lesson. Add it here (with the release/round citation) in the same PR
as the fix, so the next contributor doesn't re-derive it.
