---
'@bookedsolid/rea': minor
---

0.47.0 — audit observability completion. Three items round out the
observability surface 0.46.0 opened:

- **`rea audit timeline` — helpful MAX_BUCKETS errors (0.46.0 round-2 P2
  #1).** The 2000-bucket overflow guard previously rejected with a
  generic "use a larger --bucket or narrower --since" line. The 0.47.0
  error now computes concrete remediation inline:
  `--bucket=15m × --since=21d = 2016 buckets exceeds MAX_BUCKETS=2000.
  Try --bucket=1h (504 buckets) or --since=20d 20h (1999 buckets).`
  Substring contract pinned for dashboard consumers (`bucket=` /
  `since=` / `Try`).
- **`rea audit timeline` — auto-clamp on long-history repos (0.46.0
  round-2 P2 #2).** When `--since` is OMITTED and the audit log spans
  more than MAX_BUCKETS at the requested cadence, the timeline
  auto-clamps to the widest window that fits rather than throwing.
  Surfaced inline via a `note: --since not specified; auto-clamped to
  …` line in human output and a new additive `clamped_since` field
  (`null` in the common case) in JSON. Schema version unchanged — the
  new field is purely additive.
- **New `rea audit top-blocks [--since=DUR] [--limit=N] [--json]`
  (charter item 3).** Surface the most recent refusal events from the
  audit log (any record whose status is `denied` or `error`) — the
  "why was that refused?" debugging lens. Each row carries the short
  hash, full timestamp, tool name, and refusal reason (sourced from
  the record's `error` field, truncated to ~80 chars in human output,
  full text preserved in JSON). Newest-first sort with stable hash
  tiebreaker. `--limit=N` (default 20, max 1000) via the same strict
  integer parser as `audit by-tool` so `Number.parseInt` can't
  silently truncate `1.5` to `1`. Walk scope mirrors the sibling
  readers — current `audit.jsonl` plus every rotated segment, with the
  same fail-loud read-error stance. JSON shape stable for dashboards:
  `{ schema_version, since, limit, window, total_matched, events,
  files_scanned }` where `total_matched` is the pre-limit count so
  dashboards can show "20 of 47 refusals in window". Non-standard
  status values surface in the report rather than being silently
  dropped (forward-compat for future enum extensions).
