---
'@bookedsolid/rea': minor
---

0.46.0 — audit observability expansion + profiling fidelity fix.

- New `rea audit by-tool [--top=N] [--since=DUR] [--json]` (charter
  item 1). Higher-fidelity tool_name distribution than `rea audit
  summary` (which caps at 12 rows + `(other)`). `--top=N` (default 20,
  max 1000) controls the visible cut; the long-tail is summarized
  inline (`(other: N tools, M events, P.P%)`). Reuses
  `parseDurationSeconds` from `audit summary` for `--since` so the
  duration shape (`24h`, `7d`, `90m`) stays consistent across the
  reader trio. JSON shape is stable for dashboards: `{ schema_version,
  window: { seconds, start, end }, total_events, unique_tools, top,
  tools: [{ name, count, pct }], files_scanned }`. Same rotated-file
  walk discipline as `audit summary` (walks every segment; per-record
  filter inside).
- New `rea audit timeline [--bucket=HOUR|DAY|<DUR>] [--since=DUR]
  [--json]` (charter item 2). Time-bucketed event counts with inline
  histogram bars. `--bucket=HOUR` (default), `--bucket=DAY`, or compact
  duration form (`15m`, `30m`, `2h`, `1d`). Bucket boundaries align to
  the UTC epoch lattice so day/hour buckets fall on natural UTC
  boundaries and sub-hour buckets align to natural sub-hour boundaries.
  When `--since` is set, zero-count buckets across the window are
  emitted (silence is signal); without `--since`, only event-bearing
  buckets are emitted. Peak marker (`← peak`) highlights the busiest
  bucket. `MAX_BUCKETS=2000` guards against runaway combinations like
  `--bucket=1s --since=30d`. JSON shape: `{ schema_version, bucket:
  { raw, seconds }, window, buckets: [{ start, end, count }],
  total_events, peak_index, files_scanned }`.
- Profile-hooks per-hook payload matching (charter item 3, 0.45.0
  round-3 P2). Pre-fix `scripts/profile-hooks.mjs` used generic
  Bash/Write payloads for every shim, so the six shims with a
  `shim_is_relevant` pre-gate (`attribution-advisory`,
  `security-disclosure-gate`, `env-file-protection`,
  `dependency-audit-gate`, `changeset-security-gate`, `secret-scanner`)
  silently measured the short-circuit path instead of the real hot
  path — their baseline latency understated by 30-50x. Fix: new
  `payloadVariantsForHook(name)` returns `{ match, no_match }` per
  shim. MATCH payloads pass the relevance pre-gate (full hot path);
  NO_MATCH payloads fail it (short-circuit). Both variants are
  profiled per shim; the harness's exit-2 (non-zero exit-code check)
  and exit-1 (over-budget ceiling check) now apply to both. JSON
  baseline gains `same_as_match: boolean` + `no_match: { median_ms,
  p95_ms, max_ms, samples_ms, exit_codes, error } | null` per shim
  while keeping the pre-0.46.0 top-level fields populated from the
  MATCH variant (backwards compatible). `payloadForHook(name)` stays
  exported and returns the MATCH variant. `docs/hook-perf-baseline.md`
  updated with the two-variant methodology + the now-flagged
  undercount in the 0.45.0 baseline + an expected-pattern table for
  the relevance-gated shims.
