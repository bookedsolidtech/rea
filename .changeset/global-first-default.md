---
'@bookedsolid/rea': minor
---

Global-first is now THE model. `rea init` / `rea upgrade` no longer add a local
`@bookedsolid/rea` dependency by default, the upgrade flow is non-interactive
apply-all, and a new `rea migrate --to-global` command performs assisted removal
of an existing local pin.

**Part A — global-first pin default (inverted).** `rea init` and `rea upgrade`
no longer self-pin by default. A no-pin checkout is the normal healthy state —
the global rea CLI tier (`<home>/.rea/cli`, gated by
`<home>/.rea/trusted-projects`) governs, and the 0.52.0 version-skew handling
(fail-closed under enforce / warn under shadow when the resolved CLI is too old)
is the brick guard, not a `package.json` pin. Pass `--pin` to opt back in to a
hermetic local install (adds `@bookedsolid/rea` to `devDependencies`). Existing
pins are untouched (the managed-caret bump still applies for skew-safety).

**Part B — assisted removal.** New command `rea migrate --to-global` strips the
local `@bookedsolid/rea` dep from `dependencies`/`devDependencies` (byte-minimal,
key-order preserving; idempotent; dogfood-safe) and prints the `pnpm install` /
`npm install` follow-up to prune node_modules. `rea upgrade` offers to strip a
detected local dep interactively (`--interactive`) and merely recommends migration
in the default non-interactive flow (never silently mutates deps).

**Safety layer — "no pin is healthy ONLY when a global tier is usable."** A single
shared predicate (`resolveGlobalCliTier(...).tier === 'global'`) gates every
global-first surface so a repo can never silently end up with zero resolvable CLI:
`rea doctor` FAILS (not passes) on a dep-free repo when no usable global tier is
available (missing local pin AND no resolvable global CLI = a real brick), with
actionable recovery guidance; `rea migrate --to-global` REFUSES (exit non-zero,
package.json untouched) when stripping the dep would leave no global fallback;
and `rea init` / `rea upgrade` emit a loud, actionable stderr warning when they
skip the pin on a machine with no usable global tier (they still never
auto-fall-back to pinning — global-first is forced). A present local dep is a
non-fatal `warn` pointing at `rea migrate --to-global`; incompatible / non-semver
/ symlinked pins still hard-fail.

**Part C — upgrade UX inversion.** `rea upgrade` with no flags now runs to
completion with ZERO prompts on a clean managed install. All rea-managed changes
(new files, auto-updates, and removed-upstream deletions) apply non-interactively;
operator-modified managed files (drift) are REPORTED and preserved, never
clobbered, unless `--force` is passed. `--interactive` restores the pre-0.53.0
per-file keep/overwrite prompts (and the dep-strip offer). `--dry-run` is
unchanged.
