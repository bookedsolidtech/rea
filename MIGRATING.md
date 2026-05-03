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

## Extension surface (added in 0.13.0)

`.husky/pre-push.d/*` and `.husky/commit-msg.d/*` are the
**upgrade-safe** place to layer your own gates. Files in those
directories must be executable; rea sources them in lex order AFTER
its own governance work succeeds. A non-zero exit from any fragment
fails the hook (matches husky's normal chaining).

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
