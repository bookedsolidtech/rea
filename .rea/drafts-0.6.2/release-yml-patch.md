# `.github/workflows/release.yml` — BUG-013 patch

**Status:** DRAFT — must be hand-applied by Jake. `.github/workflows/release.yml` is in `.rea/policy.yaml` `blocked_paths`, so the agent cannot edit it directly. Copy-paste the two step insertions below and commit alongside the 0.6.2 changeset.

## Context

BUG-013: rea 0.6.1 (tag) shipped with a `dist/` tree byte-identical to 0.6.0. Helix's security team verified via `diff -qr` between the two published tarballs. That means `dist/` was NOT rebuilt from the 0.6.1 shipping commit, and a future security changeset cannot be trusted unless the pipeline enforces rebuild + post-publish verification.

Three layers:
1. **Rebuild-before-publish** — delete `dist/`, rebuild, hash the tree to a file. Forces `dist/` to reflect the exact commit being tagged.
2. **Post-publish tarball verify** — after `changesets/action` publishes, `npm pack` the published version, re-hash the `dist/` inside, compare to the CI-built hash. Catches a scenario where the publish step somehow races with a stale `dist/`.
3. **Content-based security-claim gate** — already applied to `scripts/tarball-smoke.sh` (no `blocked_paths` constraint there). If any `.changeset/*.md` carries `[security]`, the shipped `dist/` must include compiled `*sanitize*.test.js` or `*security*.test.js` under `dist/`. Narrow, bypass-resistant.

## Changes to apply

### 1. Insert rebuild step between "Tarball smoke (pre-publish)" and "Create release PR or publish"

After the existing:
```yaml
      - name: Tarball smoke (pre-publish)
        run: scripts/tarball-smoke.sh
```

Insert:
```yaml
      # BUG-013: deterministic rebuild immediately before publish. 0.6.1 shipped
      # with dist/ byte-identical to 0.6.0 because CI never enforced a fresh
      # build from the shipping commit. This step removes dist/, rebuilds, and
      # records a SHA-256 digest of the full dist/ tree to .rea-dist-hash so
      # the post-publish verify step can compare against what we built here.
      - name: Rebuild dist/ from HEAD before publish
        run: |
          rm -rf dist
          pnpm build
          find dist -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 > .rea-dist-hash
          echo "[release] CI-built dist/ hash:"
          cat .rea-dist-hash
```

### 2. Insert post-publish verification after "Create release PR or publish"

After the existing `changesets/action` block (including its `env:` block ending at `NPM_CONFIG_PROVENANCE: "true"`), insert:

```yaml
      # BUG-013: post-publish verification — re-pack the published version
      # from npm and assert the dist/ tree hash matches what we built above.
      # A mismatch means the published tarball does not contain the dist/
      # that passed the pre-publish tarball-smoke gate. Fails the run so the
      # npm tag does not become authoritative for a tarball we did not vet.
      - name: Verify published tarball dist/ matches CI-built dist/
        if: steps.changesets.outputs.published == 'true'
        run: |
          VERSION="$(jq -r '.version' package.json)"
          echo "[release] verifying @bookedsolid/rea@$VERSION"
          WORK="$(mktemp -d -t rea-verify-XXXXXX)"
          cd "$WORK"
          # npm pack <name>@<version> fetches the registry tarball by spec.
          npm pack "@bookedsolid/rea@$VERSION" --silent > /dev/null
          TARBALL="$(ls bookedsolid-rea-*.tgz | head -1)"
          if [ -z "$TARBALL" ]; then
            echo "::error::npm pack produced no tarball for @bookedsolid/rea@$VERSION"
            exit 1
          fi
          mkdir -p extract
          tar -xzf "$TARBALL" -C extract
          PUBLISHED_HASH="$(cd extract/package && find dist -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')"
          LOCAL_HASH="$(awk '{print $1}' "$GITHUB_WORKSPACE/.rea-dist-hash")"
          echo "[release] published dist/ hash: $PUBLISHED_HASH"
          echo "[release] CI-built  dist/ hash: $LOCAL_HASH"
          if [ "$PUBLISHED_HASH" != "$LOCAL_HASH" ]; then
            echo "::error::published tarball dist/ hash ($PUBLISHED_HASH) != CI-built dist/ hash ($LOCAL_HASH)"
            exit 1
          fi
          echo "[release] dist/ hash verified — published tarball contains the rebuilt dist/"
```

## Verification after apply

1. On the PR that applies these steps, run:
   ```bash
   gh pr checks <pr-number>
   ```
   The "Release" workflow does not fire on PRs (only on `push: main`), so direct CI won't verify. Check syntax with `actionlint .github/workflows/release.yml`.

2. On the first "chore: release" PR after merge — tail the release workflow run:
   ```
   - "[release] CI-built dist/ hash: <sha256>"
   - "[release] dist/ hash verified — published tarball contains the rebuilt dist/"
   ```
   If either is missing, the patch did not apply cleanly.

3. Post-publish Helix verification (what they asked for):
   ```bash
   npm pack @bookedsolid/rea@0.6.2
   tar -xzf bookedsolid-rea-0.6.2.tgz
   grep -l sanitizeHealthSnapshot package/dist/gateway/meta/health.js  # must match
   ```
