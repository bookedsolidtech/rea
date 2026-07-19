# Upgrade-journey test harness

Fixture-based, end-to-end tests of what `rea init` / `rea upgrade` **DO to a
checkout that is already in a given prior-install shape**.

## Why this exists

A global-tier self-pin bug reached a consumer despite 50+ diff reviews. Diff
review and isolated unit tests cannot answer the load-bearing question —
_"what does `rea upgrade` do to a user already on an old install shape?"_ — because
the failure only appears when the real scaffolder runs against a real prior
state. This harness closes that systemic gap.

There are two layers. **Layer 1 is built here and runs in `pnpm test`.** Layer 2
is designed below and intentionally deferred.

## Layer 1 — in-process journeys (`journeys.test.ts`)

For each fixture representing a real prior-install shape, every journey:

1. **Copies the fixture into a fresh temp dir** — the fixture is never mutated
   (`materializePriorInstall` in `harness.ts`).
2. **Runs the actual scaffolder** — the exported `runInit` / `runUpgrade`
   functions, driven the same way `src/cli/init.test.ts` and
   `src/cli/upgrade.settings-migration.test.ts` drive them (temp dir as
   `process.cwd()`).
3. **Asserts END-STATE INVARIANTS** — present / absent / version / doctor
   status. Never brittle full-file snapshots.

### Fixtures & invariants

| Fixture | Journey | Invariants asserted | Status |
| --- | --- | --- | --- |
| `no-rea-at-all` | `rea init` | rea dep pinned to `^<current>`; critical hook present **and** registered in `settings.json`; spine skills at `.claude/skills/rea/`; manifest stamped `<current>`; **zero doctor `fail` rows** | green |
| `pinned-0.49` | `rea upgrade` | managed-caret dep bumped `^0.49.0` → `^<current>` (same major, no brick); hooks refreshed + registered; brick diagnostic does **not** fire | green |
| `already-current` | `rea upgrade` ×2 | second upgrade is idempotent — `package.json` byte-stable and manifest version unchanged | green |
| `committed-hooks` | `rea doctor` | brick diagnostic **fires** (`fail`) — dep absent + hooks a fresh clone would carry | green |
| `untracked-hooks` | `rea doctor` | brick diagnostic does **not** fire — gitignored `.claude/` can't reach a fresh clone (the false-positive the team hit) | **`it.skip` — TODO(devex-followup)** |
| `global-tier-dep-free-trusted` | `rea upgrade` (trusted) | dep **stays absent** (package.json byte-unchanged) AND hooks/spine refresh to current — the exact self-pin bug | green |
| `global-tier-dep-free-trusted` | `rea upgrade` (untrusted control) | the SAME dep-free checkout, untrusted, **does** get the dep pinned — proves the trusted-skip branch is load-bearing | green |

### The trusted seam

The 0.53.0 fix that closed the bug adds a trusted-global-tier gate keyed on
`<home>/.rea/trusted-projects` (via `resolveGlobalCliTier`), surfaced as a new
`skipped-global-tier-trusted` self-pin action. The trusted journey drives it
through the shipped **injectable predicate** `trustedGlobalTierProbe` on
`UpgradeOptions` — so the test asserts the trusted-checkout outcome without
constructing a real global-CLI install under a temp home.

`harness.ts` also exposes `markProjectTrusted(projRealpath, tempHome)` — the
temp-home trust-registry seam (`writeRegistry`) for driving the DOCTOR-side path
(`collectChecks(dir, …, { globalHome })` → `resolveGlobalCliTier`) against a real
registry without touching `~/.rea`.

**Still gated:** the `untracked-hooks` doctor journey is `it.skip`. The 0.53.0
fix made `rea upgrade`'s SELF-PIN trusted-aware, but did **not** teach doctor's
brick DIAGNOSTIC (`checkSelfPinDeclaredCheck`) about git-tracking — it remains
presence-based and still false-positives on a gitignored `.claude/`. When that
detector becomes git-aware (`git check-ignore`/`ls-files`), flip the one `it.skip`
to `it`; the body already asserts the corrected invariant. See the
`TODO(devex-followup)` comment in `journeys.test.ts`.

## Layer 2 — Docker clean-env matrix (designed, not built)

Layer 1 runs the scaffolder **functions** in-process against a fixture. It cannot
catch failures that only manifest in a real, globally-installed CLI on a clean
machine — npm global-install topology, shim PATH resolution, CDN/registry
propagation of a freshly published version, or a bricked fresh clone with no
local `node_modules`.

Layer 2 is a **nightly / opt-in CI job** (never gating a hotfix) that exercises
the true package across a version boundary in a bare container:

```
for (N, N+1) in adjacent published versions:
  docker run --rm node:22-bookworm-slim:
    npm i -g @bookedsolid/rea@N          # real global install, clean env
    rea init <fixture>                    # scaffold a prior-install shape
    assert: doctor-clean at version N
    npm i -g @bookedsolid/rea@N+1         # the upgrade boundary
    rea upgrade                           # the journey under test
    assert END-STATE INVARIANTS:
      - global-tier-dep-free-trusted: rea dep still absent
      - pinned-0.N: managed-caret bumped, no brick
      - committed-hooks fresh-clone: gates resolve a CLI (no brick)
```

Why Layer 2 also matters: it is the layer that would have caught the
**CDN-propagation verify flake** — `npm i -g @…@N+1` against a version not yet
fully propagated to all registry mirrors fails in exactly the clean-env way an
in-process Layer-1 run never sees.

**Scope discipline:** Layer 2 is a matrix design + a stub entrypoint
(`scripts/layer2-docker-matrix.sh`). This PR does **not** wire a Docker CI job —
that is a separate change (nightly workflow, published-version matrix, opt-in
label) so it never blocks the fast in-process gate.

## Running

```bash
REA_DELEGATED_RUN=1 npx vitest run __tests__/integration/upgrade-journeys/journeys.test.ts
```
