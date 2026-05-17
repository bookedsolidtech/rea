# Migrating to `@bookedsolid/rea` from a project with prior tooling

`rea` was originally written for greenfield projects. Real consumers
arrive with prior infrastructure already in place — commitlint,
lint-staged, gitleaks, act-CI, branch-policy linters, project-specific
gates wired into `.husky/`. This guide names the conflict patterns by
name and shows the supported migration path for each.

If you hit something this doc doesn't cover, file an issue at
https://github.com/bookedsolidtech/rea/issues with the offending hook
body and the prior tool name.

## Prerequisite — husky must be installed and `core.hooksPath` configured

The `.husky/{commit-msg,pre-push}.d/` extension surface is sourced from
the rea-managed bodies under `.husky/<hookname>`. Those bodies only fire
when git is configured to use husky. Confirm one of the following:

- Husky 9 (recommended): `pnpm dlx husky init` (or `npx husky init`)
  during onboarding. Husky 9 sets `core.hooksPath=.husky/_` automatically;
  rea's bodies live at `.husky/<hookname>` and husky's auto-generated
  stubs at `.husky/_/<hookname>` source them at hook-fire time. `rea
  doctor` (0.13.1+) follows the husky 9 stub indirection correctly.
- Husky 4-8 (legacy): `core.hooksPath=.husky` set, husky's
  `_/husky.sh` runner installed. Functional but unsupported by husky
  upstream — migrate to husky 9.
- Vanilla git (no husky): rea installs the fallback at
  `.git/hooks/pre-push`. **The fragment recipes below DO NOT run** in
  this configuration — `.git/hooks/pre-push` is not the same body as
  `.husky/pre-push`. Either install husky (recommended) or chain your
  per-tool commands directly into the fallback (you'll lose the
  upgrade-safe property — `rea upgrade` will refresh the fallback and
  drop your chain).

`pnpm rea doctor` reports the active hook path. If it shows
`.git/hooks/pre-push` (rea-managed at .../.git/hooks/pre-push), you
are on the vanilla-git path — install husky first.

## TL;DR

1. Confirm husky is installed (see prereq above).
2. Run `rea init` (fresh install) or `rea upgrade` (existing).
3. **Do not lose your existing chain.** rea now refuses to silently
   overwrite an executable `.husky/pre-push` or `.husky/commit-msg`
   that is not rea-managed; you'll see a `[fail]` from `rea doctor`
   pointing here.
4. Move each chained command from your existing hook body to a
   per-tool fragment under `.husky/pre-push.d/<NN>-<name>` or
   `.husky/commit-msg.d/<NN>-<name>` (executable, lex-ordered).
5. Re-run `rea init`. The fresh hook body delegates to
   `rea hook push-gate` and then runs your fragments AFTER the
   governance gate.
6. `rea doctor` should now report all checks green.

## What rea ships and what it doesn't

`rea init` / `rea upgrade` install:

- `.husky/pre-push` — package-managed; **do not edit**. Refreshed on every
  `rea upgrade`.
- `.husky/commit-msg` — package-managed; **do not edit**. Same.
- `.husky/prepare-commit-msg` — package-managed (added in 0.30.0).
  Drives the optional `attribution.co_author` augmenter; **do not edit**.
  No-op when `policy.attribution.co_author.enabled !== true`, so it is
  safe to ship under every profile (default disabled).
- `.git/hooks/pre-push` (fallback when `core.hooksPath` is unset).
- `.claude/hooks/*.sh` — protection + audit + advisory hooks.
- `.claude/agents/*.md`, `.claude/commands/*.md`.
- `.rea/policy.yaml`, `.rea/registry.yaml`.

`rea` does **not** install:

- `.husky/pre-commit` — completely yours. Out of scope for the rea
  push-gate. If you have one, keep it.
- `.husky/post-commit`, `post-merge`, `post-checkout`, etc. — yours.
- Any tool's binary (`commitlint`, `gitleaks`, `husky`, etc.) — yours.

The only files rea touches are explicitly enumerated above. Everything
else is the consumer's surface.

## Extension surface (added in 0.13.0; expanded in 0.32.0)

`.husky/pre-push.d/*`, `.husky/commit-msg.d/*`, and (as of 0.32.0)
`.husky/prepare-commit-msg.d/*` are the **upgrade-safe** place to
layer your own gates. Files in those directories must be executable;
rea sources them in lex order AFTER its own governance work succeeds.
A non-zero exit from any fragment fails the hook (matches husky's
normal chaining) — EXCEPT for the `prepare-commit-msg.d/*` lane,
which logs and continues so a broken fragment can't take down `git
commit`.

- Fragment receives positional args from git (`<remote-name> <remote-url>`
  for pre-push, `<commit-msg-file>` for commit-msg).
- Missing directory is a no-op (no fragments = no chained checks).
- Non-executable files are silently skipped (drop a `README` if you
  want context next to the fragments — it won't run).
- Fragments run with the current shell's `set -eu`; an unset variable
  or a non-zero exit anywhere in the fragment short-circuits.

`rea doctor` reports detected fragments at `[info]` level so you can
confirm the chain.

## Conflict pattern: commitlint

You probably have something like this in `.husky/commit-msg`:

```sh
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"   # husky 4-8
npx --no-install commitlint --edit "$1"
```

Or, with husky 9, your own command interleaved with `husky 9`'s body.

**rea 0.11.0+ overwrites `.husky/commit-msg` on `rea upgrade --force`.**
Your commitlint invocation will be lost.

### Migration

Move commitlint to a fragment:

```bash
mkdir -p .husky/commit-msg.d
cat > .husky/commit-msg.d/01-commitlint <<'EOF'
#!/bin/sh
exec npx --no-install commitlint --edit "$1"
EOF
chmod +x .husky/commit-msg.d/01-commitlint
```

Re-run `rea upgrade`. The package-managed `.husky/commit-msg` body now
runs first (HALT check, AI-attribution block when policy enables it),
then runs your fragment.

## Conflict pattern: existing prepare-commit-msg (rea 0.30.0+)

You probably have a hook that templates the message, adds a Jira
ticket prefix, or inserts a branch name:

```sh
#!/bin/sh
# .husky/prepare-commit-msg — user-authored
COMMIT_MSG_FILE=$1
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "[$BRANCH] $(cat "$COMMIT_MSG_FILE")" > "$COMMIT_MSG_FILE"
```

**rea 0.30.0+ refuses to overwrite a foreign `.husky/prepare-commit-msg`.**
On `rea init` you'll see a `[fail]` from `rea doctor`:

```
[fail] prepare-commit-msg hook (attribution augmenter)
       (attribution.co_author.enabled: true but the prepare-commit-msg
        hook is foreign (no rea marker) — remove the existing hook
        and re-run `rea init`, or set enabled: false.)
```

### Migration

Two paths, depending on whether you intend to use the rea augmenter.

**Path A — you want the augmenter (Co-Authored-By trailer)**

Move your branch-prefix logic into a `.husky/prepare-commit-msg.d/*`
fragment. As of **0.32.0** rea's prepare-commit-msg body sources every
executable file in `.husky/prepare-commit-msg.d/` in lexical order
AFTER its own attribution augmenter runs (mirrors the
`commit-msg.d/*` and `pre-push.d/*` extension surfaces from 0.13.0).
Each fragment receives the same `$1` (commit-message file path) and
`$2` (commit source) git delivered to the hook:

```bash
mkdir -p .husky/prepare-commit-msg.d
cat > .husky/prepare-commit-msg.d/00-branch-prefix <<'EOF'
#!/bin/sh
# Runs AFTER rea's Co-Authored-By augmenter. $1 = commit-msg file.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
case $(head -1 "$1") in
  "[$BRANCH]"*) ;;  # already prefixed
  *) printf '[%s] %s' "$BRANCH" "$(cat "$1")" > "$1" ;;
esac
EOF
chmod +x .husky/prepare-commit-msg.d/00-branch-prefix
```

A non-zero exit from a fragment does NOT fail the commit (the augmenter
hook is purely additive; the blocking gate is `commit-msg`). Broken
fragments log to stderr and the hook continues.

Then remove the old `.husky/prepare-commit-msg`:

```bash
rm .husky/prepare-commit-msg .git/hooks/prepare-commit-msg
```

Re-run `rea init`. rea's prepare-commit-msg now installs cleanly.

**Path B — you do NOT want the augmenter**

Leave your existing hook in place. Set the augmenter off explicitly:

```yaml
# .rea/policy.yaml
attribution:
  co_author:
    enabled: false
```

`rea doctor` reports `[warn]` (not fail) for the foreign hook —
your commits keep going through your existing logic.

## Conflict pattern: lint-staged on pre-push

You probably have:

```sh
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"
npx --no-install lint-staged
```

### Migration

```bash
mkdir -p .husky/pre-push.d
cat > .husky/pre-push.d/02-lint-staged <<'EOF'
#!/bin/sh
exec npx --no-install lint-staged
EOF
chmod +x .husky/pre-push.d/02-lint-staged
```

## Conflict pattern: gitleaks (pre-commit)

`rea` does NOT install a pre-commit hook. Your existing
`.husky/pre-commit` keeps working unchanged. Just confirm:

- Shebang is `#!/usr/bin/env bash` (not `#!/bin/sh`) if the body uses
  `set -o pipefail`. On Linux where `/bin/sh = dash`, `pipefail`
  aborts immediately.
- gitleaks invocation includes `--redact` so detected secrets don't
  hit terminal scrollback.
- gitleaks binary is vendored or installed via postinstall (e.g.
  `gitleaks-secret-scanner` npm wrapper) so fresh clones work without
  manual install.

If you want gitleaks to run on push instead of commit, add a fragment:

```bash
cat > .husky/pre-push.d/03-gitleaks <<'EOF'
#!/bin/sh
exec gitleaks detect --redact --no-banner
EOF
chmod +x .husky/pre-push.d/03-gitleaks
```

## Conflict pattern: act-CI matrix

If you have a project-specific CI gate like `./scripts/act-ci.sh`
chained into `.husky/pre-push` (e.g. BST), it gets clobbered by
`rea upgrade --force`.

### Migration

```bash
cat > .husky/pre-push.d/00-act-ci <<'EOF'
#!/bin/sh
exec ./scripts/act-ci.sh
EOF
chmod +x .husky/pre-push.d/00-act-ci
```

The `00-` prefix puts act-CI first in lex order so it runs before any
later fragments. Adjust ordering as needed.

## Conflict pattern: branch-policy linter

A common pattern that reads `$1` (remote name) and `$2` (remote URL)
to allow/deny pushes to specific remotes:

```sh
#!/bin/sh
remote="$1"
url="$2"
if [ "$remote" = "origin" ] && echo "$url" | grep -q "production"; then
  echo "Direct push to production blocked. PR via main." >&2
  exit 1
fi
```

This requires the standard pre-push argv. **rea 0.13.2+ preserves
git's argv unchanged** for fragments — earlier versions (0.13.0 /
0.13.1) had a known bug where `set --` mutation in the rea dispatch
clobbered `$@`. Upgrade to `^0.13.2` if branch-policy linters are part
of your chain.

### Migration

Drop the body into a fragment as-is:

```bash
cat > .husky/pre-push.d/05-branch-policy <<'EOF'
#!/bin/sh
remote="$1"
url="$2"
if [ "$remote" = "origin" ] && echo "$url" | grep -q "production"; then
  echo "Direct push to production blocked. PR via main." >&2
  exit 1
fi
EOF
chmod +x .husky/pre-push.d/05-branch-policy
```

## Conflict pattern: pre-existing rea-CLI invocation

Some consumers had `exec rea hook push-gate "$@"` chained inline in a
foreign hook body. `rea doctor` recognizes this pattern and reports
the hook as `external (delegates to rea hook push-gate)` — `pass`,
not `fail`. No migration required, but you cannot benefit from the
extension-fragment chain unless you let rea own the hook body.

If you want both — rea ownership AND your other commands — migrate the
other commands to fragments.

## Conflict pattern: husky 9 layout (`core.hooksPath=.husky/_`)

This is the default husky 9 install. rea 0.13.1+ supports it
correctly: doctor follows the husky 9 stub indirection from
`.husky/_/<hookname>` through `.husky/_/h` to the canonical
`.husky/<hookname>`. No migration required.

If you're on rea 0.13.0 and seeing `[fail] pre-push hook` despite a
correctly-installed `.husky/pre-push`, upgrade to `^0.13.1`.

## What `rea doctor` will tell you

After migration, run `pnpm rea doctor`. The relevant lines:

- `[ok] pre-push hook installed` — rea-managed body active, fragments
  (if any) detected
- `[fail] pre-push hook installed` with **"Detected prior tooling: X,
  Y, Z"** — your existing hook still chains tooling that should be in
  fragments. Move each named tool to a `.d/` fragment, then re-run
  `rea init`.
- `[info] extension-hook fragments detected: N pre-push.d, M
  commit-msg.d` — your fragment chain is active

## Codex model knobs (added in 0.14.0)

The push-gate now pins the flagship codex model and `high` reasoning
effort by default. Pre-0.14.0 it used codex's built-in default, which
is the special-purpose `codex-auto-review` model at `medium`
reasoning — a meaningfully weaker reviewer than the flagship.
Same-code-different-verdict thrashing on long-running branches was
substantially driven by the lower-reasoning default.

**Defaults (0.14.0+):**

```yaml
review:
  codex_model: gpt-5.4              # was codex-auto-review (codex's own default)
  codex_reasoning_effort: high      # was medium (codex's own default)
```

You don't need to set these — `gpt-5.4` + `high` are baked in at the
package level. The policy keys exist for cost-bounded environments
that want to opt into a weaker model:

```yaml
review:
  codex_model: codex-auto-review    # opts back into the prior default
  codex_reasoning_effort: medium
```

The model name is passed through to codex's TOML config layer
(`-c model="…"`); codex itself validates it. An unknown model name
surfaces as a clear runtime error at first push, not a silent
fallback. Codex's current catalog (as of 2026-05-03):

- `gpt-5.4` — flagship, reasoning-capable (recommended for review)
- `gpt-5.4-mini` — smaller, faster, cheaper, less reasoning depth
- `gpt-5.3-codex` — prior generation, code-specialized
- `gpt-5.3-codex-spark` — even faster prior gen
- `gpt-5.2` — older, generally avoid for security-relevant review
- `codex-auto-review` — special-purpose, lower reasoning ceiling

Reasoning effort is `low | medium | high`. `high` spends more compute
per finding and produces more consistent verdicts — fewer
same-code-different-verdict round-trips. Trade-off is push-gate
latency.

## Node-binary hook scanner (added in 0.32.0)

Pre-0.32.0 every `.claude/hooks/*.sh` carried the full gate body in
bash. Adversarial review consistently caught bash-only edge cases that
were structurally unfixable in shell — multi-line awk encodings,
ANSI-C escapes, deep nested-shell decoding. 0.32.0 pivoted the entire
hook surface to a Node-binary scanner: hooks became thin shims (~20-80
LOC each) that delegate the actual gate work to `rea hook <name>` —
which runs the canonical scanner inside `dist/cli/index.js`.

**Consumer impact:**

- Run `pnpm install` (or `npm install`) after upgrading to 0.32.0+ so
  `dist/cli/index.js` is built and the shims have something to call.
- `.claude/hooks/*.sh` files on disk are noticeably smaller after
  `rea upgrade`; this is the canonical post-0.32.0 shape, not a
  truncation. `rea doctor` will tell you if a shim is the wrong
  vintage.
- The audit trail is unchanged: hooks still emit `rea.bash_scan`-class
  records to `.rea/audit.jsonl` with the same field shape.
- Performance is materially better — single Node startup per scan
  instead of an awk/sed pipeline per pattern.

If `rea doctor` reports `policy-reader Tier 1 (rea CLI)` as `warn:
dist not found`, you skipped the build step. Run `pnpm install`.

## Graceful-degradation policy reader (added in 0.37.0)

The shimmed hooks need to read `.rea/policy.yaml` from a bash context
that may or may not have python3, jq, or rea's CLI on PATH. 0.37.0
formalized a 4-tier reader ladder:

1. **Tier 1** — `rea hook policy-get` (requires `dist/cli/index.js`)
2. **Tier 2** — `python3 + stdlib yaml` (PyYAML) — handles flow-form
3. **Tier 3** — POSIX `awk` block-form parser (the always-available floor)
4. **Fail-closed** — every tier unreachable: shim refuses the action

Tier 1 → 2 → 3 fallthrough is silent at hook-runtime; that's
intentional (graceful degradation), but means an unreachable Tier 1 +
unreachable Tier 2 can silently downgrade flow-form policy lookups to
block-form-only. `rea doctor` (0.39.0+) surfaces all three tier
reachabilities so you can spot the gap.

**Consumer impact:**

- If you use FLOW-form YAML for any policy block (e.g.
  `blocked_paths: [.env, ".env.*"]`), make sure either the rea CLI
  dist is present OR `python3 + PyYAML` is installed. With ONLY awk
  reachable, flow-form lookups silently no-op on every shim
  fallthrough path and your declared policy isn't enforced.
- Install PyYAML on CI runners: `pip3 install pyyaml`. On consumer
  developer machines, it's almost always already present (macOS ships
  it; major Linux distros bundle it with python3).
- For list-valued policy keys (`blocked_paths`, `protected_writes`),
  the loader iterates the resulting JSON via jq OR python3. Have at
  least one on PATH or `rea doctor` (0.42.0+) will report `fail` on
  the `policy-reader Tier 3 (awk)` row with a list-walker-specific
  remediation message.

## Shim runtime extraction (added in 0.38.0)

Cosmetic-only refactor: every `.claude/hooks/*.sh` shim now sources
`hooks/_lib/shim-runtime.sh` for shared boilerplate (env loading,
tier classification, audit-event emission). **No consumer action
required** — the change is byte-equivalent at the gate surface. New
shims you author can adopt the same runtime by sourcing the shared
helper; documented in the shim authoring guide.

## Doctor health surfaces for the policy reader (added in 0.39.0)

`rea doctor` gained explicit reachability checks for the 4-tier
ladder, the dist invokability probe, and a sandbox-containment check
on the resolved `dist/cli/index.js` path. Output lines you'll see:

- `policy-reader Tier 1 (rea CLI)` — pass/warn based on dist
  presence + actual invocation
- `policy-reader Tier 2 (python3 + PyYAML)` — pass/warn based on
  python3 + import yaml succeeding
- `policy-reader Tier 3 (awk)` — pass when awk present; warn or
  fail conditional on whether other tiers cover the gap (0.40.0
  refined the verdict logic; 0.42.0 hardened the list-walker
  predicate)
- `policy-reader effective floor` — summary verdict across all three
- `policy-reader jq (JSON accelerator)` — info-level, calls out
  Tier 1/2 perf when jq is absent

**Consumer action:** run `rea doctor` after each upgrade. The lines
above accurately reflect what your shims will do at runtime — a
`warn` is not a hard failure but signals a posture worth knowing
about (e.g. flow-form policy silently no-ops). A `fail` on any tier
row IS a hard failure that the doctor exits non-zero on.

## Upgrade preview + audit summary (added in 0.41.0)

Two new consumer-facing commands rolled out:

### `rea upgrade --check`

Dry-run preview of what `rea upgrade` would write, file-by-file, with
unified diffs. JSON output via `--json`. Always exits 0 — this is a
preview, not a gate. Use it before any non-trivial rea upgrade to
sanity-check the diff:

```bash
rea upgrade --check                       # human-readable table + diffs
rea upgrade --check --json                # machine-readable for CI
rea upgrade --check --no-diff             # counts + paths only
```

0.42.0 added the same settings-schema validation that `rea upgrade`
itself runs — if the merged settings would fail schema parse (typo'd
hook event, malformed hook command, …), the preview surfaces the
`WOULD REFUSE` message rather than promising a write the real
upgrade would refuse. The `settings_validation` field in the JSON
output carries the structured outcome.

### `rea audit summary`

High-level rollup of the audit log: counts by `tool_name`, `tier`,
`status`, `session`, the time window covered, and a sample-verified
chain-integrity check. `--since <duration>` (e.g. `24h`, `7d`, `2w`)
narrows to a recent window:

```bash
rea audit summary                         # all time
rea audit summary --since 24h             # last 24 hours
rea audit summary --since 7d --json       # last week, JSON
```

0.42.0 hardened the rotated-file walk: pre-0.42.0 `--since` pruned
rotated audit segments by filename stamp, which is wall-clock at the
rotation INSTANT — not the earliest record contained. A rotated file
from N days ago can contain records from N+M days ago when the
rotation cycle was long, so pruning by filename silently dropped
in-window records. Post-0.42.0 the walker reads every rotated file
under `--since` and lets the per-record timestamp filter drop the
out-of-window entries. Correctness over micro-optimization;
`rea audit summary` performance is unchanged in practice.

## Audit observability completion (added in 0.47.0)

0.46.0 shipped `rea audit by-tool` and `rea audit timeline`. 0.47.0
rounds out the observability surface with two timeline ergonomics fixes
and a new refusal-debugging reader:

### `rea audit timeline` — helpful MAX_BUCKETS errors + auto-clamp

Pre-0.47.0, `rea audit timeline --bucket=15m --since=21d` (= 2016
buckets, just past the 2000-bucket ceiling) rejected with a generic
"use a larger --bucket or narrower --since" message. The 0.47.0 error
now carries concrete remediation:

```text
rea audit timeline: --bucket=15m × --since=21d = 2016 buckets exceeds
MAX_BUCKETS=2000. Try --bucket=1h (504 buckets) or --since=20d 20h
(1999 buckets).
```

For the related "I omitted `--since` and the audit log spans a year"
case, the timeline now AUTO-CLAMPS to the widest window that fits at
the requested cadence rather than throwing. The clamp is surfaced
inline in human output:

```text
rea audit timeline (clamped to ~1999h of newest activity, hourly)
────────────────────────────────────────
note: --since not specified; auto-clamped to newest 2000 buckets
      (~1999h span at --bucket=1h). Pass --since=DUR to anchor at
      now, or rerun with a WIDER --bucket (current 1h) to fit the
      full log.
…
```

JSON consumers see the clamp as a new `clamped_since` field — `null`
in the common case, a duration string (e.g. `"1999h"`) when the
clamp fired. The field is informational, not reproducible: `--since`
always anchors at `now`, so a clamp anchored at an older record
cannot be round-tripped through `--since=<clamped_since>`. Use the
field to detect that clamping occurred and to size the rendered
window in dashboards. For a fully reproducible view, pass `--since`
or `--bucket` explicitly. Schema version is unchanged (still v1) —
the field is purely additive. `window.start/end/seconds` is also
nulled out on sparse-log clamps where the kept buckets don't form a
contiguous time lattice, so `total_events / window.seconds` never
derives a misleading rate.

### `rea audit top-blocks` — debugging "why was that refused?"

A new subcommand surfaces the most recent refusal events (any record
whose `status` is `denied` or `error`) from the audit log:

```bash
rea audit top-blocks                          # last 20 refusals, all time
rea audit top-blocks --since=24h              # last 24h
rea audit top-blocks --since=7d --limit=50    # last week, top 50
rea audit top-blocks --json                   # dashboard shape
```

Each row carries the short hash (first 8 chars), full timestamp, tool
name, and the refusal reason (sourced from the record's `error` field;
truncated to ~80 chars in human output, full text in JSON). Sorted
newest-first so the most recent refusals are at the top.

Use this when an agent reports "the hook blocked my push" or "the
write was refused" and you need the exact reason without grepping
`.rea/audit.jsonl` by hand.

JSON shape (stable, v1):

```json
{
  "schema_version": 1,
  "since": "24h",
  "limit": 20,
  "window": { "seconds": 86400, "start": "...", "end": "..." },
  "total_matched": 4,
  "events": [
    { "hash": "...", "timestamp": "...", "tool": "Bash",
      "status": "denied", "reason": "...", "session_id": "..." }
  ],
  "files_scanned": ["/abs/path/.rea/audit.jsonl"]
}
```

`total_matched` is the pre-limit count, so dashboards can show
"20 of 47 refusals in window". Walk scope mirrors the sibling audit
readers — current `.rea/audit.jsonl` PLUS every rotated segment.

## Policy knobs worth setting

For consumers with a long-running migration branch (>30 commits since
last push), the push-gate auto-narrows the codex review window unless
you opt out. Pin explicit values to avoid surprises:

```yaml
# .rea/policy.yaml
review:
  codex_required: true
  timeout_ms: 1800000              # 30 min — explicit pin
  auto_narrow_threshold: 30        # 0 to disable auto-narrow
  last_n_commits: 10               # explicit scope window
  codex_model: gpt-5.4             # 0.14.0+ default; iron-gate
  codex_reasoning_effort: high     # 0.14.0+ default; iron-gate
```

## Bypass when you genuinely need to

```bash
# Audited skip: codex flips on a known-ambivalent file
REA_SKIP_CODEX_REVIEW="cemPath-ambivalence" git push

# Whole-gate skip: codex CLI itself is broken
REA_SKIP_PUSH_GATE="codex-cli-crash-pinging-team" git push

# Concerns-only override (P2 findings) without skipping the gate
REA_ALLOW_CONCERNS=1 git push
```

Every bypass is audit-logged with the reason in `.rea/audit.jsonl`.
Reasons should be specific — "skip" is not a reason; the file or
verdict that triggered it is.

## When to file an issue vs handle in-tree

- **rea hook ate my chain on `rea upgrade`** → file an issue, that's
  rea's fault. Workaround: migrate to `.d/` fragments.
- **rea doctor false-positives on my legitimate setup** → file an
  issue.
- **codex flips verdicts on the same code** → upstream of rea (codex
  CLI itself). Use `REA_SKIP_CODEX_REVIEW` with a specific reason and
  document the ambivalence.
- **My pre-commit hook breaks on push** → not rea (rea ships no
  pre-commit). Fix in your repo.
