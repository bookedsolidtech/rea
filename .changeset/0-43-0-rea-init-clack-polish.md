---
'@bookedsolid/rea': minor
---

`rea init` clack flow polish + round-7 P3 — consumer-facing first-impression refresh.

**`rea init` interactive flow polish (UX pass):**

- Re-run banner — top-of-wizard `note` distinguishes "Re-running init"
  from "Fresh install" so operators see upfront whether their existing
  policy edits are being preserved.
- Prompt copy refresh — every prompt label and hint rewritten for
  first-time consumers (e.g. autonomy levels now read "L0 — read-only",
  "L1 — supervised writes" with one-line guidance instead of bare
  policy-jargon labels). Codex prompt names the model (GPT-5.4) and the
  setup path (`/codex:setup`).
- Install summary — before any file write, a bordered `note` lists every
  artifact about to be created (`.rea/policy.yaml`, `.claude/hooks/`,
  `.husky/commit-msg`, etc.) plus the resolved profile / autonomy /
  codex toggle. Followed by a final `confirm` gate; cancelling here
  leaves zero files on disk. `--yes` / `--force` bypass the gate (CI
  paths must never block on stdin).
- Spinner — interactive file-write phase is wrapped in clack's
  `spinner` so operators on slow disks see progress instead of
  staring at a frozen prompt.
- Error envelope — install failures now surface via the spinner's
  error state followed by a `<what failed>: <why> → <suggested fix>`
  message rather than a raw stack trace.
- Post-install verification — synchronous in-process sanity check
  after writes complete (policy parses, `.claude/hooks/` populated and
  executable, `settings.json` and `install-manifest.json` present).
  Modelled on the 0.29.0/0.31.0 `checkDelegationRoundTrip` synthetic
  round-trip pattern; if anything looks off, surfaces a warn block
  and points the operator at `rea doctor` for the deep dive.
- Structured `outro` — replaces the trailing `console.log('Next
  steps:')` with a bordered note ending in `rea install complete.` /
  `rea refresh complete.`. Includes docs URL. CI path (non-interactive)
  keeps the plain log output (clack borders don't render in CI logs).

**Round-7 P3 from 0.42.0:**

`checkPolicyReaderTierSummary`'s `flow-form-lists-degraded` warn branch
no longer always says "neither jq nor python3 is on PATH" for the
broken-shim case. The diagnostic now mirrors the round-6 P3 fix already
applied to `checkPolicyReaderTier3`: distinguishes "python3 absent"
from "python3 present but execution probe fails (broken pyenv/asdf
shim, sandboxed interpreter, permission-denied binary)", surfaces the
resolved python3 path verbatim so the operator can locate and repair
the shim, and suggests the right remediation (repair vs install) for
each shape.

The bash hook ladder, audit shape, and CLI surfaces are unchanged.
This is a UX pass plus a diagnostic mirror — no behavioral changes,
no new policy keys, no new flags.
