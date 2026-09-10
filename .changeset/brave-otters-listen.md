---
'@bookedsolid/rea': patch
---

Close three success-shaped failure signals: `turn.failed` reviews, the swallowed `rea install --version` flag, and a stale local pin that no check warned about.

All three are the same defect class — an operation that reports success while doing nothing, or a failure that presents as a pass.

**`turn.failed` now gates the review, independent of the exit code.** A dead model rung ends with a *success-shaped* frame: an `item.completed`/`agent_message` carrying the prose "Review was interrupted. Please re-run /review and wait for it to complete.", then `turn.failed`. That prose makes `reviewText` non-empty, so the 0.52.0 silent-pass guard (`reviewText.length === 0 && errorMessages.length > 0`) never fired. On an exit-0 variant of that stream the runner returned a review with zero findings — verdict `pass`. A rubber stamp, one layer above the one 0.52.0 removed. `parseCodexJsonl` now reports `turnFailed`, and a failed turn never yields a review whatever the exit code says. Classification uses the `turn.failed` message plus top-level `error` events; `item.completed`/`item.type: "error"` frames are collected for **diagnostics only**, deliberately excluded from classification because the observed frame leads with a transport note ("Falling back from WebSockets to HTTPS transport") and a bare transport note would otherwise fail the all-messages-agree test and stick the gate closed on a hiccup.

**`rea install --global --version <semver>` was a silent no-op.** The program registers `-v, --version` via `program.version()`, and commander resolves that flag even in subcommand position — so the command printed the *running* rea version, exited 0, and never entered the install action. Verified with a bogus value: `--version 9.9.9` printed `0.54.0`. The per-user CLI tier could sit indefinitely behind while every invocation looked healthy. The option is now `--pkg-version <semver>`.

**`rea doctor` now warns when a declared local range cannot resolve the governing version.** The self-pin compat check skips when no local CLI is installed (R19-P2, to avoid false-fails on fresh clones), which left a trap: a repo declaring a stale range with no install resolves the global tier and looks healthy, but the next install drops that stale version into `node_modules` — which the pre-push gate prefers over the global tier — silently downgrading the gate. Caret on a `0.x` version pins the minor, so `^0.53.0` does not admit `0.54.0`; the ranges look close enough to pass a human skim. Reported as a warn, never a fail, so the fresh-clone posture R19-P2 protects is unchanged.

Also fixed: the pre-commit hook's "NO CLI" tests passed the real `PATH` and `HOME` into a scenario that requires neither to resolve a CLI. On any machine with a global `rea` installed, those tests stopped exercising the fail-closed assertion they exist to guard, and passed in CI only because CI has no global install.
