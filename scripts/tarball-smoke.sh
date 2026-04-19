#!/usr/bin/env bash
# tarball-smoke.sh — exercise the packed @bookedsolid/rea tarball end-to-end
# in an isolated tempdir. Catches packaging regressions (missing files from
# `files:`, broken exports map, shebang / chmod issues on `bin`, postinstall
# failures, dependency resolution drift) BEFORE the tarball reaches npm.
#
# Must be run from the repo root. Assumes `dist/` has already been built.
#
# Runs under CI on every PR and on every push to main; also recommended as a
# manual gate before hand-authorizing a Changesets release PR merge.
#
# ## Developer-run negative probe (optional, not in CI)
#
# To verify the tree-equality asserts actually fail loud on a missing shipped
# file, temporarily drop `commands/` or `.husky/` from `package.json#files[]`,
# run this script, and confirm it exits non-zero at the install-surface diff
# step. Revert the `files:` edit before committing. CI does not run this probe
# because it would mutate package.json.
#
# Exit codes:
#   0 — smoke passed
#   1 — preflight failure (missing dist, pack failed)
#   2 — smoke assertion failure (bin missing, init/doctor failed, exports broken)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d "dist" ]; then
  echo "[smoke] FAIL — dist/ not found. Run 'pnpm build' first." >&2
  exit 1
fi

PACK_DIR="$(mktemp -d -t rea-smoke-pack-XXXXXX)"
SMOKE_DIR="$(mktemp -d -t rea-smoke-install-XXXXXX)"
DIFF_TMP="$(mktemp -t rea-smoke-diff-XXXXXX)"
cleanup() { rm -rf -- "$PACK_DIR" "$SMOKE_DIR" 2>/dev/null || true; rm -f "$DIFF_TMP"; }
# EXIT alone misses Ctrl-C / TERM / HUP during local runs, leaving
# /tmp/rea-smoke-* tempdirs behind. Trap the interrupt signals too.
trap cleanup EXIT HUP INT TERM

echo "[smoke] pack → $PACK_DIR"
pnpm pack --pack-destination "$PACK_DIR" >/dev/null
TARBALL="$(ls "$PACK_DIR"/bookedsolid-rea-*.tgz | head -1)"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "[smoke] FAIL — pnpm pack produced no tarball in $PACK_DIR" >&2
  exit 1
fi
echo "[smoke] tarball: $(basename "$TARBALL") ($(wc -c < "$TARBALL" | awk '{printf "%.0f KB\n", $1/1024}'))"

echo "[smoke] install in $SMOKE_DIR"
cd "$SMOKE_DIR"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "$TARBALL"

# Drop the temp package.json + lockfile that `npm init -y` + `npm install`
# wrote. The tempdir must look like a fresh consumer project (no package.json)
# so `rea init` exercises the same code path a brand-new consumer hits.
rm -f package.json package-lock.json
git init -q

echo "[smoke] rea --version"
VERSION_OUT="$(./node_modules/.bin/rea --version)"
# Pass the repo-root package.json path via argv to avoid interpolating it
# into a JS string literal — paths with apostrophes, backslashes, or `${...}`
# expansions would otherwise break the require() call.
EXPECTED_VERSION="$(node -p "require(process.argv[1]).version" "$REPO_ROOT/package.json")"
if [ "$VERSION_OUT" != "$EXPECTED_VERSION" ]; then
  echo "[smoke] FAIL — rea --version returned '$VERSION_OUT', expected '$EXPECTED_VERSION'" >&2
  exit 2
fi
echo "[smoke]   → $VERSION_OUT"

echo "[smoke] rea --help"
./node_modules/.bin/rea --help >/dev/null

echo "[smoke] rea init --yes --profile open-source"
./node_modules/.bin/rea init --yes --profile open-source

# Verify the installed layout matches what init claims it wrote.
for expected in .rea/policy.yaml .rea/registry.yaml .claude/settings.json CLAUDE.md .rea/install-manifest.json; do
  if [ ! -f "$expected" ]; then
    echo "[smoke] FAIL — rea init did not create $expected" >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Install-surface tree-equality asserts.
#
# Prior versions counted `.claude/agents/*.md` and `.claude/hooks/*.sh` and
# never verified `.claude/commands/` or the shipped `.husky/pre-push`. A
# tarball that dropped either surface still passed. We now diff sorted file
# lists: any missing OR extra file fails loud and names the delta.
#
# Surfaces under test:
#   1. .claude/agents/         ↔ repo agents/*.md              (flat)
#   2. .claude/hooks/          ↔ repo hooks/**/*.sh            (flat + _lib/)
#   3. .claude/commands/       ↔ repo commands/*.md            (flat)
#   4. node_modules/.../.husky ↔ repo .husky/{commit-msg,pre-push}
#
# The `.husky/` check targets the package tree under node_modules because
# `rea init` only copies `.husky/*` into the consumer when `.husky/` already
# exists there. On a fresh consumer (this smoke's default), the hooks live as
# `.git/hooks/{commit-msg,pre-push}` via the fallback installers. What must
# ALWAYS be true is that the tarball itself ships the `.husky/` source of
# truth — without it, husky-using consumers get nothing.
# ---------------------------------------------------------------------------

assert_tree_equal() {
  # $1 — label for error messages
  # $2 — file listing of the source tree (one relative path per line)
  # $3 — file listing of the installed tree (one relative path per line)
  local label="$1" src="$2" dst="$3"
  if [ -z "$src" ] || [ -z "$dst" ]; then
    printf '[smoke] FAIL — empty file listing for %s\n' "$label" >&2
    exit 2
  fi
  if ! diff -u <(printf '%s\n' "$src" | sort -u) <(printf '%s\n' "$dst" | sort -u) > "$DIFF_TMP" 2>&1; then
    echo "[smoke] FAIL — $label differs between source tree and installed tree:" >&2
    cat "$DIFF_TMP" >&2
    exit 2
  fi
}

# 1. agents — flat listing of *.md
AGENTS_SRC="$(cd "$REPO_ROOT/agents" && find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||')"
AGENTS_DST="$(cd "$SMOKE_DIR/.claude/agents" && find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||')"
assert_tree_equal ".claude/agents tree" "$AGENTS_SRC" "$AGENTS_DST"

# 2. hooks — recursive listing of *.sh (walks hooks/_lib/ too)
HOOKS_SRC="$(cd "$REPO_ROOT/hooks" && find . -type f -name '*.sh' | sed 's|^\./||')"
HOOKS_DST="$(cd "$SMOKE_DIR/.claude/hooks" && find . -type f -name '*.sh' | sed 's|^\./||')"
assert_tree_equal ".claude/hooks tree" "$HOOKS_SRC" "$HOOKS_DST"

# 3. commands — flat listing of *.md
COMMANDS_SRC="$(cd "$REPO_ROOT/commands" && find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||')"
COMMANDS_DST="$(cd "$SMOKE_DIR/.claude/commands" && find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||')"
assert_tree_equal ".claude/commands tree" "$COMMANDS_SRC" "$COMMANDS_DST"

# 4. husky — explicit pre-push + commit-msg existence inside the package
#    tree under node_modules. `rea init` does not copy these into a fresh
#    consumer's root, so we check the shipped copy directly. If either file
#    is missing from the tarball, husky-using consumers silently get zero
#    enforcement on their next `pnpm install`.
#
#    Executable-bit check is intentionally NOT asserted here: npm's tarball
#    format strips the group/other execute bits from non-`bin:` files on
#    install, so the shipped file lives at mode 0644. What matters is that
#    the installers in commit-msg.ts and pre-push.ts use these as templates
#    and chmod the destination (.git/hooks/... or .husky/...) themselves.
HUSKY_PKG_DIR="$SMOKE_DIR/node_modules/@bookedsolid/rea/.husky"
for husky_file in commit-msg pre-push; do
  path="$HUSKY_PKG_DIR/$husky_file"
  if [ ! -f "$path" ]; then
    echo "[smoke] FAIL — tarball missing .husky/$husky_file (expected at $path)" >&2
    exit 2
  fi
done

# On a fresh consumer (no pre-existing .husky/), rea installs the fallback
# pre-push + commit-msg into .git/hooks/. Assert that path landed too — it is
# the enforcement surface for this smoke's simulated consumer.
for git_hook in commit-msg pre-push; do
  path="$SMOKE_DIR/.git/hooks/$git_hook"
  if [ ! -f "$path" ]; then
    echo "[smoke] FAIL — .git/hooks/$git_hook missing after rea init" >&2
    exit 2
  fi
  if [ ! -x "$path" ]; then
    echo "[smoke] FAIL — .git/hooks/$git_hook is not executable" >&2
    exit 2
  fi
done

AGENT_COUNT="$(printf '%s\n' "$AGENTS_DST" | grep -c . || true)"
HOOK_COUNT="$(printf '%s\n' "$HOOKS_DST" | grep -c . || true)"
COMMAND_COUNT="$(printf '%s\n' "$COMMANDS_DST" | grep -c . || true)"
echo "[smoke]   → $AGENT_COUNT agents, $HOOK_COUNT hooks, $COMMAND_COUNT commands, .husky/{commit-msg,pre-push} shipped, .git/hooks/{commit-msg,pre-push} installed"

echo "[smoke] rea doctor"
./node_modules/.bin/rea doctor

# Verify every declared public export resolves. If the exports map points at a
# file that didn't ship in `files:`, this is where we catch it.
echo "[smoke] resolve exports"
node --input-type=module -e "
import('@bookedsolid/rea').then(m => { if (typeof m !== 'object') { console.error('bad root export'); process.exit(2); } });
import('@bookedsolid/rea/policy').then(m => { if (!m) { console.error('bad /policy export'); process.exit(2); } });
import('@bookedsolid/rea/middleware').then(m => { if (!m) { console.error('bad /middleware export'); process.exit(2); } });
import('@bookedsolid/rea/audit').then(m => {
  if (typeof m.appendAuditRecord !== 'function') { console.error('audit.appendAuditRecord not a function'); process.exit(2); }
});
"
echo "[smoke]   → root, /policy, /middleware, /audit all resolve"

echo "[smoke] PASS"
