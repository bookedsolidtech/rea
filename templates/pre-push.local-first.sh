#!/usr/bin/env bash
# rea local-first pre-push template (0.26.0+).
#
# This is the SIMPLEST possible local-first pre-push body — pure
# delegation to `rea preflight --strict`. The real `.husky/pre-push`
# that `rea init`/`rea upgrade` writes is the canonical body in
# `src/cli/install/pre-push.ts::BODY_TEMPLATE`, which ALSO runs
# `rea preflight --strict` before the push-gate dispatch.
#
# Operators who want a minimal pre-push (no codex on push, just the
# local-review audit-log check) can replace their `.husky/pre-push`
# body with this one.
#
# Behavior:
#   - .rea/HALT present                     → exit 2 (kill-switch)
#   - policy.review.local_review.mode: off  → exit 0 (no-op)
#   - REA_SKIP_LOCAL_REVIEW=<reason> set    → exit 0 (audited)
#   - recent rea.local_review covers HEAD   → exit 0
#   - otherwise                             → exit 2 with helpful msg
#
# See docs/migration/0.26.0.md for the full enforcement story.
set -euo pipefail

# Resolve REA_ROOT — the consumer repo's root, used to locate a local
# rea binary. Git pre-push hooks cd into the repo root before invoking
# the hook, so `pwd` is the right answer here. We deliberately don't
# rely on `core.hooksPath` or `git rev-parse` so this template works
# under both vanilla git and husky 9 layouts.
REA_ROOT="$(pwd)"

# Round-27 F5 fix: inline the same rea-CLI resolution ladder used by
# the canonical BODY_TEMPLATE in src/cli/install/pre-push.ts. Pre-fix
# the body was `exec rea preflight --strict`, which assumed `rea` was
# on PATH. Git hooks run with the user's interactive PATH MINUS
# `node_modules/.bin` (npm doesn't extend PATH for hook subprocesses
# the way it does for `npm run` scripts), so devDependency-only
# installs got `rea: not found` on every push.
#
# Resolution order (matches BODY_TEMPLATE exactly):
#   1. ${REA_ROOT}/node_modules/.bin/rea  — local devDependency.
#   2. ${REA_ROOT}/dist/cli/index.js      — rea's own dogfood repo.
#   3. PATH-resolved rea                  — global install.
#   4. npx --no-install                    — last-resort npm cache hit.
if [ -x "${REA_ROOT}/node_modules/.bin/rea" ]; then
  exec "${REA_ROOT}/node_modules/.bin/rea" preflight --strict
elif [ -f "${REA_ROOT}/dist/cli/index.js" ] \
   && [ -f "${REA_ROOT}/package.json" ] \
   && grep -q '"name": *"@bookedsolid/rea"' "${REA_ROOT}/package.json" 2>/dev/null; then
  # rea's own repo (dogfood) — the package is not installed under
  # node_modules here because we ARE the package. Gate this branch on
  # `package.json` declaring `@bookedsolid/rea` so a consumer repo that
  # happens to ship its own `dist/cli/index.js` does not get this hook
  # executing the consumer's unrelated build.
  exec node "${REA_ROOT}/dist/cli/index.js" preflight --strict
elif command -v rea >/dev/null 2>&1; then
  exec rea preflight --strict
elif command -v npx >/dev/null 2>&1; then
  # Last resort: npx will resolve the package from npm or the cache.
  # Pass `--no-install` so a rare cache-cold machine surfaces a clear
  # error instead of silently downloading at push time.
  exec npx --no-install @bookedsolid/rea preflight --strict
else
  printf 'rea: cannot locate the rea CLI for preflight. Install locally (`pnpm add -D @bookedsolid/rea`) or set policy.review.local_review.mode=off.\n' >&2
  exit 2
fi
