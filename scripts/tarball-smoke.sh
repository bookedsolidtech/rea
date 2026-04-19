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
trap 'rm -r "$PACK_DIR" "$SMOKE_DIR" 2>/dev/null || true' EXIT

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

# Clean up the temp package.json that npm init created so it doesn't confuse
# `rea init` downstream — `rea init` doesn't care, but we want the tempdir to
# look like a fresh consumer project.
git init -q

echo "[smoke] rea --version"
VERSION_OUT="$(./node_modules/.bin/rea --version)"
EXPECTED_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
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

# Count agents and hooks — a missing file in the shipped tarball would show up
# here (init copies every file from the tarball's agents/ and hooks/ dirs).
AGENT_COUNT="$(find .claude/agents -maxdepth 1 -name '*.md' | wc -l | awk '{print $1}')"
HOOK_COUNT="$(find .claude/hooks -maxdepth 1 -name '*.sh' | wc -l | awk '{print $1}')"
if [ "$AGENT_COUNT" -lt 10 ]; then
  echo "[smoke] FAIL — expected at least 10 agents, got $AGENT_COUNT" >&2
  exit 2
fi
if [ "$HOOK_COUNT" -lt 13 ]; then
  echo "[smoke] FAIL — expected at least 13 hooks, got $HOOK_COUNT" >&2
  exit 2
fi
echo "[smoke]   → $AGENT_COUNT agents, $HOOK_COUNT hooks"

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
