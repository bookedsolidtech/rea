---
'@bookedsolid/rea': minor
---

0.32.0 — Node-binary hook playbook (Phase 0 + Phase 1 + Phase 3).

Three structural pieces land together.

**Phase 0 — shared hook primitives.** New `src/hooks/_lib/` carries
the three primitives every Node-binary hook needs:

  - `halt-check.ts` — `checkHalt(reaRoot)` returns a discriminated
    `HaltState` and `formatHaltBanner(reason)` renders the canonical
    operator-facing banner. Fail-CLOSED on read errors (the pre-0.32.0
    inline copies in `src/cli/hook.ts` fell through to allow on EIO;
    the kill switch shouldn't be defeatable by a permissions glitch).
    The two existing call sites (`runHookScanBash`,
    `runHookCodexReview`) migrate to the shared primitive.
  - `payload.ts` — `parseHookPayload` consumes the `INPUT=$(cat) | jq
    -r '.tool_input.command // ""'` shape every bash hook repeats, with
    fail-closed throws on malformed JSON or wrong-type
    `tool_input.command`. `readStdinWithTimeout` reads stdin with a
    soft 1 MiB cap and a 5s timeout.
  - `segments.ts` — quote-aware split-on-shell-separator with
    `anySegmentStartsWith` (head-anchored, post-prefix-strip) and
    `anySegmentMatches` (raw-text scan). Subset of the bash
    `cmd-segments.sh` API that the Phase 1 pilots actually exercise.

**Phase 1 — three pilot hook ports.** The bash bodies move into
`src/hooks/<name>/index.ts`; the shipped `hooks/<name>.sh` becomes a
15-line shim that forwards stdin to the rea CLI:

  - `pr-issue-link-gate` (pilot 1, 64 LOC bash → ~190 LOC TS). 12
    unit tests covering HALT, non-Bash, gh-pr-create with/without
    closing ref, malformed JSON fail-closed.
  - `attribution-advisory` (pilot 3, 162 LOC bash → ~240 LOC TS). 17
    unit tests covering the 5 attribution-marker classes, helix-020
    G4.B GitHub-per-user-noreply allow, helix-020 G4.A head-anchored
    relevance, policy-disabled / missing-policy no-ops.
  - `security-disclosure-gate` (pilot 2, 339 LOC bash → ~390 LOC TS).
    21 unit tests covering both disclosure modes, body-file
    resolution (space/equals/short/quoted-with-spaces forms),
    `..`-traversal refusal, 64 KiB read cap, first-match-wins, stdin
    form skip.

  Each pilot ships:
    - Pre-0.32.0 baseline preserved at
      `__tests__/hooks/parity/baselines/<name>.sh.pre-0.32.0`.
    - 4 new `rea hook <name>` CLI subcommands (only `policy-get` and
      `scan-bash` / `codex-review` shipped pre-0.32.0).
    - 11 bash↔node parity tests under
      `__tests__/hooks/parity/node-parity.test.ts` proving the
      consumer sees the same outcome from the new shim vs. the
      pre-0.32.0 bash body for canonical inputs.

**Phase 3 — `.husky/prepare-commit-msg.d/*` extension surface.** The
augmenter body at `templates/prepare-commit-msg.husky.sh` adds a
`run_extension_chain` function that sources every executable file
under `.husky/prepare-commit-msg.d/` in lex order, with non-zero
exits logged-and-continued (the hook is additive — broken consumer
fragments can't take down `git commit`). The chain runs on every
augmenter-skip exit path (`enabled: false`, missing identity,
idempotency hit, skip_merge match, missing policy, REA_SKIP_
ATTRIBUTION, missing CLI+python3) so consumer fragments fire
regardless of whether rea's own augmenter activated. HALT and
missing-message-file paths still skip the chain (frozen-system /
nothing-to-act-on).

`hooks/settings-protection.sh` §5b carves out
`.husky/prepare-commit-msg.d/*` alongside the existing
`.husky/commit-msg.d/*` and `.husky/pre-push.d/*` allow-list,
including the symlink-refusal and intermediate-symlink-resolution
defense-in-depth that 0.13.2 brought to the other two lanes.

`MIGRATING.md` updates Path A of the "existing prepare-commit-msg"
conflict pattern to recommend `.husky/prepare-commit-msg.d/*`
fragments (the previous text said the surface was "on the 0.31.0
roadmap" — it landed in 0.32.0).

**Class G — package byte-fidelity test.** New
`__tests__/integration/package-byte-fidelity.test.ts` runs `pnpm
pack` against the repo, extracts the tarball, and asserts every
`hooks/*.sh` and `templates/*.sh` is byte-identical to its canonical
source AND every `EXPECTED_HOOKS` entry from `src/cli/doctor.ts` ships
in the tarball AND every hook referenced in `.claude/settings.json`
has a matching shipped file. Gated behind `SKIP_PACK_TESTS=1` so the
inner-loop `pnpm test` stays fast; CI runs without the env var.
Catches an entire class of bugs (`package.json#files` misconfig
omitting a directory) that pre-0.32.0 only surfaced via reactive bug
reports (helix-024 verification correction, 0.13.3 MIGRATING.md
packaging follow-up).

Test count: 13,788 passing (+392 across the new Phase 0 primitives,
the three pilots, the parity harness, and the prepare-commit-msg.d
fragment tests).

No runtime behavior change for existing consumers — the bash shims
preserve the byte-for-byte semantics of the pre-0.32.0 hooks, and the
prepare-commit-msg.d/ surface is purely additive (missing dir is a
no-op).
