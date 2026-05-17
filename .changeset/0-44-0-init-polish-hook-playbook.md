---
'@bookedsolid/rea': minor
---

0.44.0 — `rea init` polish completion + hook playbook reference doc.

- `buildInstallSummary` now derives its hook listing from the
  canonical resolvers (`EXPECTED_HOOKS` + `defaultDesiredHooks`) via
  the new `canonicalInstalledHooks()` helper. Adding a hook to either
  source automatically reflects in the operator's pre-confirm screen
  — pre-fix the summary hard-coded the listing and could silently
  drift. (0.43.0 round-2 P2 closure.)
- `postInstallVerify` is now Windows/WSL-aware. On filesystems where
  Unix mode bits aren't reliable (native Windows, WSL crossings, SMB
  mounts), the exec-bit check is skipped with a one-liner advisory.
  In its place we now verify the FULL canonical hook set per-file —
  every entry in `canonicalInstalledHooks()` must be present + non-
  empty (0.44.0 codex round-1 P2 caught the loophole where the
  substitute invariant accepted "at least one survivor", which would
  have hidden a partial-copy failure that left one hook surviving).
  New `isModeLessFilesystem()` helper detects the FS class.
  (0.43.0 round-2 P3 closure.)
- New `docs/hook-playbook.md` — comprehensive contributor reference
  extracting the 0.32.0–0.42.0 marathon lessons (shim_run API,
  fail-open vs blocking tier, relevance pre-gate patterns, policy
  short-circuit, sandbox expectations, parity baselines, dogfood
  bootstrap, the awk-comment-quote class). Linked from
  CONTRIBUTING.md.
