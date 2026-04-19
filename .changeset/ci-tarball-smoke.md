---
'@bookedsolid/rea': patch
---

ci: tarball smoke workflow (packaging regression gate)

Adds `scripts/tarball-smoke.sh`, invoked on every PR and every push to `main` via a new `Tarball smoke` CI job, and re-invoked in the release workflow immediately before `changeset:publish`. The script packs the repo with `pnpm pack`, installs the resulting tarball in an isolated tempdir, and asserts:

- `rea --version` matches `package.json` version
- `rea --help` prints the full command tree
- `rea init --yes --profile open-source` creates the expected layout
- `rea doctor` returns OK on the freshly installed artifacts
- At least 10 agents and 13 hooks shipped in the tarball
- Every public ESM export (`.`, `./policy`, `./middleware`, `./audit`) resolves

This catches packaging regressions — missing files from the `files:` allow-list, broken `exports` map, shebang / chmod issues on `bin/rea`, postinstall failures, dependency-resolution drift — before the tarball reaches npm. No runtime behavior change.

Branch protection on `main` should be updated to include `Tarball smoke` as a required check alongside the existing seven.
