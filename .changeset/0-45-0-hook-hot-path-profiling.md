---
'@bookedsolid/rea': minor
---

0.45.0 — hook hot-path profiling pass + 0.44.0 round-2 polish.

- New `pnpm perf:hooks` (`scripts/profile-hooks.mjs`) measures per-shim
  wall-clock latency under a synthetic non-blocking payload. Runs 10
  warm iterations + 2 discarded warmups per shim, reports
  median/p95/max, writes a baseline at `docs/hook-perf-baseline.json`
  sorted by p95 desc. Both `pnpm perf:hooks` and `pnpm test:perf`
  build dist first (codex round-2 P2 #2) so profiling never measures
  stale JS. New regression test at `__tests__/scripts/profile-hooks
  .test.ts` (run via `pnpm test:perf` — excluded from default
  `pnpm test` chain via REA_INCLUDE_PERF=1 gate so wall-clock
  sensitivity doesn't flake on shared CI runners, codex round-1
  P2 #1) asserts every shim exits 0 (codex round-1 P2 #2) and no
  shim exceeds its per-shim p95 ceiling (2000ms default, 4500ms
  for `local-review-gate.sh`). Baseline writes only on clean runs
  (codex round-2 P2 #3) — a failed run preserves the last-known-
  good baseline on disk. `docs/hook-perf-baseline.md` documents
  the methodology, findings, and a proposed sandbox/version-probe
  session cache (deferred — needs security-architect review of the
  trust boundary).
- `canonicalInstalledHooks()` now derives PRIMARILY from the packaged
  `hooks/` filesystem tree (the literal shipped artifact) via the new
  `canonicalHooksFromFilesystem()` helper, with `EXPECTED_HOOKS` +
  `defaultDesiredHooks()` layered on as defensive fallbacks. The new
  three-way cross-check test in `init.test.ts` asserts the FS list
  equals each source-code registry exactly — drift fails the test
  loudly with a precise discrepancy report. (0.44.0 round-2 P2 #1.)
- `isModeLessFilesystem()` broadens detection beyond the historical
  `0o000` shape — `0o777` (everything-exec, no info) and `0o644` /
  `0o666` (no exec bits anywhere on a `.sh` that should have them)
  now also trigger. Codex round-1 P1 + round-2 P2 #1 closure: the
  ambiguous `0o644` / `0o666` branch routes through a new
  `filesystemIgnoresModeBits()` active probe (write a temp file,
  chmod to `0o755` to bypass caller umask, stat back — if mode bits
  survived, the FS is real Unix and the install is genuinely broken;
  emit the original "zero executable .sh files" error instead of an
  advisory). Pre-round-1 the broadened detection silently masked
  chmod-stripped Unix installs; pre-round-2 the probe was filtered
  through caller umask and would falsely flag mode-less under e.g.
  `umask 0111`. (0.44.0 round-2 P2 #2.)
