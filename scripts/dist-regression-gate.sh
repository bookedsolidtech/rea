#!/usr/bin/env bash
# dist-regression-gate.sh — class-level guard against "src/ changed, dist/ didn't"
#
# Generalizes BUG-013's trust-repair from a `[security]`-changeset-keyed gate
# (scripts/tarball-smoke.sh) to a gate that fires on ANY change set. Catches
# the 0.6.0 → 0.6.1 regression class: a release that ships dist/ byte-identical
# to the previous release despite src/ edits (i.e. dist/ was not rebuilt from
# the shipping commit).
#
# Bypass-resistant by construction:
#   - Does not depend on changeset labels. A changeset-free PR that touches
#     src/ without rebuilding dist/ still fails.
#   - Does not depend on the release.yml rebuild step. That step is
#     defense-in-depth at publish time; this gate fires on every PR and every
#     push:main, so the regression is caught BEFORE it reaches the release
#     branch.
#
# ## Algorithm
#
#   1. Read last-published version from `npm view @bookedsolid/rea version`.
#   2. Resolve the matching `v<version>` git tag. (Tag scheme verified across
#      v0.1.0 … v0.6.2.)
#   3. Diff `src/` between HEAD and the tag. If unchanged, exit 0 — nothing
#      to verify.
#   4. `npm pack @bookedsolid/rea@<version>` in a tempdir, hash the dist/
#      tree in the extracted tarball.
#   5. Hash the local `dist/` tree the same way (assumes `pnpm build` has
#      already run — CI enforces this, local runs need to pre-build).
#   6. If hashes are equal AND src/ changed → FAIL.
#
# ## Hash scheme
#
# `find dist -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256`
# matches release.yml's own hash recipe (lines 82, 130) so this gate and the
# post-publish verify step use the same digest. Per-file content sort, no
# mtime/permission bits — matches the logical-equality question we're asking.
#
# ## Exit codes
#
#   0 — pass, or skip (see "Skip surface" below)
#   1 — preflight failure: required tool missing from PATH, or dist/ directory
#       absent at script start (run `pnpm build` first)
#   2 — REGRESSION — src/ changed vs last release but dist/ hash identical
#
# ## Skip surface (exit 0 without running the full check)
#
# The gate degrades to a clean skip on infrastructure failures so a transient
# registry outage or a malformed prior release does not pin every PR and
# every push:main run into red. All skip branches log a specific reason:
#
#   - npm view found no published version → first-ever release, or registry
#     outage at lookup time
#   - matching git tag `v<version>` is not reachable and cannot be fetched
#     from origin
#   - src/ is byte-identical between HEAD and the tag → nothing to verify
#   - npm pack against the previous version fails → registry outage, auth
#     trouble, or the tarball was unpublished
#   - npm pack succeeds but produces no `.tgz` → malformed pack output
#     (rare; guarded separately from the pack-failure branch so the log
#     reason stays specific)
#   - the fetched tarball has no `package/dist/` → the baseline itself is
#     broken; holding the next PR hostage to a bad prior release hurts more
#     than it helps
#
# The release.yml rebuild-from-HEAD + post-publish tarball hash verification
# steps (see .github/workflows/release.yml lines 78-138) are the publish-time
# catching net that covers any case this gate skips. That layered defense is
# the point: this gate closes the common BUG-013 class on PR + push:main;
# the release workflow closes the rest at the moment it matters most.
#
# ## False-positive surface (known, documented)
#
# A whitespace-only edit in src/ that tsc compiles to byte-identical output
# WILL fail this gate. The failure message tells the committer to either:
#   (a) include a meaningful src change whose dist artifact differs, or
#   (b) `rm -rf dist && pnpm build && git add dist` to refresh timestamps
#       inside dist — except the gate hashes content, not mtime, so (b) alone
#       won't lift the failure.
#
# Adding an `[allow-noop-dist]` bypass marker was considered and rejected —
# it would re-open the BUG-013 attack surface for anyone who can open a PR.
# If you hit a legitimate noop-dist case, solve it by not committing the
# whitespace-only src change in isolation, or by combining it with a dist-
# affecting change in the same PR.
#
# ## Local usage
#
#   pnpm build && scripts/dist-regression-gate.sh
#
# ## CI wiring
#
# Runs as its own ci.yml job after build. See .github/workflows/ci.yml
# `dist-regression` job for wiring.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
cd "$REPO_ROOT"

log() { printf '[dist-regression] %s\n' "$*"; }
err() { printf '[dist-regression] %s\n' "$*" >&2; }

# Preflight — need npm, jq, git, shasum, tar.
for tool in npm jq git shasum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    err "FAIL — required tool not on PATH: $tool"
    exit 1
  fi
done

if [ ! -d "dist" ]; then
  err "FAIL — dist/ not found. Run 'pnpm build' first."
  exit 1
fi

# Resolve last published version from npm. Use --silent to suppress npm's
# own progress chatter; swallow stderr because we want a clean skip on a
# network error rather than a hard failure blocking every CI run.
PKG_NAME="$(jq -r '.name' package.json)"
PREV_VERSION="$(npm view "$PKG_NAME" version 2>/dev/null || true)"
if [ -z "$PREV_VERSION" ]; then
  log "skip — no previous published version found for $PKG_NAME (network issue or first release)"
  exit 0
fi
log "last published: $PKG_NAME@$PREV_VERSION"

# Resolve the matching git tag. In CI, actions/checkout fetches tags only
# when fetch-depth: 0 (see ci.yml). Locally, the tag should exist. If the
# tag isn't reachable, fetch it from origin; if the fetch fails (offline,
# first-ever release), skip — this is the same safety valve as the
# "no previous published version" branch.
PREV_TAG="v$PREV_VERSION"
if ! git rev-parse --verify --quiet "$PREV_TAG" >/dev/null 2>&1; then
  # Try a shallow fetch of just that tag. Redirect stderr because a missing
  # tag on origin is expected behaviour for a brand-new package; we degrade
  # to "skip" rather than "fail".
  if ! git fetch --quiet --depth=1 origin "refs/tags/${PREV_TAG}:refs/tags/${PREV_TAG}" 2>/dev/null; then
    log "skip — tag $PREV_TAG not reachable (offline CI or tag pruned)"
    exit 0
  fi
fi
log "anchor tag: $PREV_TAG ($(git rev-parse --short "$PREV_TAG"))"

# Compare src/ trees. We use `git diff --name-only` so renames and mode-
# only changes count. If src/ is unchanged vs the tag, the dist/ gate has
# nothing to verify — a PR that touches only docs/hooks/CI should not fail
# this check.
SRC_CHANGED_COUNT="$(git diff --name-only "$PREV_TAG" HEAD -- src/ | wc -l | awk '{print $1}')"
if [ "$SRC_CHANGED_COUNT" -eq 0 ]; then
  log "skip — src/ unchanged since $PREV_TAG"
  exit 0
fi
log "src/ changes vs $PREV_TAG: $SRC_CHANGED_COUNT file(s)"

# Fetch the published tarball and compute its dist/ hash. Using `npm pack`
# against the published name is more stable than scraping the registry URL
# because npm handles auth + CDN redirects. --silent keeps the only stdout
# noise to the tarball filename.
WORK="$(mktemp -d -t rea-dist-regression-XXXXXX)"
trap 'rm -rf -- "$WORK"' EXIT HUP INT TERM

# Degrade-to-skip on infrastructure failures. `npm view` above already
# skips on network errors; `npm pack` and tarball-shape checks need to
# match, otherwise a registry outage or a broken prior release (e.g. if
# the shipping 0.6.1 tarball itself had been malformed rather than merely
# stale) would pin every PR run into red until the registry recovered or
# a new tarball was published. The release.yml rebuild+verify step
# remains the catching net at publish time, so skipping here does not
# re-open the BUG-013 attack surface for the merge-to-main path.
if ! ( cd "$WORK" && npm pack "${PKG_NAME}@${PREV_VERSION}" --silent >/dev/null 2>&1 ); then
  log "skip — npm pack ${PKG_NAME}@${PREV_VERSION} failed (network issue or registry outage)"
  exit 0
fi

TARBALL="$(find "$WORK" -maxdepth 1 -type f -name '*.tgz' | head -1)"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  log "skip — npm pack produced no tarball for ${PKG_NAME}@${PREV_VERSION} in $WORK"
  exit 0
fi

mkdir -p "$WORK/extract"
tar -xzf "$TARBALL" -C "$WORK/extract"

if [ ! -d "$WORK/extract/package/dist" ]; then
  log "skip — published tarball for $PREV_VERSION has no dist/ at package/dist (broken baseline)"
  exit 0
fi

hash_tree() {
  # $1 — directory holding `dist/`
  # Match the recipe from .github/workflows/release.yml:82,130 exactly so
  # this gate and the release-time verify step speak the same digest.
  ( cd "$1" && find dist -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}' )
}

PUBLISHED_HASH="$(hash_tree "$WORK/extract/package")"
CURRENT_HASH="$(hash_tree "$REPO_ROOT")"

log "published ($PREV_VERSION) dist/ hash: $PUBLISHED_HASH"
log "current             dist/ hash: $CURRENT_HASH"

if [ "$PUBLISHED_HASH" = "$CURRENT_HASH" ]; then
  err ""
  err "FAIL — REGRESSION: src/ has $SRC_CHANGED_COUNT file change(s) vs $PREV_TAG"
  err "       but current dist/ hash is byte-identical to the published tarball."
  err ""
  err "       This is the 0.6.0 → 0.6.1 regression class (BUG-013): dist/ was"
  err "       not rebuilt from HEAD. Running a fresh build should refresh the"
  err "       compiled output; if it does not, one or more src/ changes are"
  err "       whitespace-only and produce no dist/ delta — in that case,"
  err "       batch them with a change that DOES affect compiled output."
  err ""
  err "       To diagnose locally:"
  err "         rm -rf dist && pnpm build"
  err "         scripts/dist-regression-gate.sh"
  err ""
  exit 2
fi

log "PASS — dist/ differs from $PREV_TAG baseline, as expected."
