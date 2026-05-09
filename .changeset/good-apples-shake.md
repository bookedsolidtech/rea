---
'@bookedsolid/rea': patch
---

fix(review): close defect-V agent-blocking finding-text gap

`rea review` now exposes finding bodies through three documented surfaces so
agents can remediate non-pass verdicts locally instead of escalating every
blocking/concerns result. Pre-fix the CLI returned only `verdict` +
`finding_count` and never wrote `.rea/last-review.json` from the `rea
review` path (only the push-gate did), so consumers saw stale snapshots
from days-old push-gate runs while current runs left no readable trace of
the findings codex produced.

Three surface additions, all backward-compatible:

1. `.rea/last-review.json` is now written on every successful codex run
   (pass / concerns / blocking) via the canonical push-gate writer, with
   the same atomic-write + secret-redaction guarantees. Stale snapshots
   are eliminated — every run overwrites.

2. New `--with-findings` flag prints findings grouped by severity
   (P1 → P2 → P3) to stdout after the existing summary line. Default off
   preserves the existing single-line stdout for CI consumers.

3. `--json` output gains `last_review_path: ".rea/last-review.json"` so
   agent runners know where to read structured findings without parsing
   prose. With `--json --with-findings`, the JSON payload gains a
   `findings` array.

Skipped (codex unavailable + `mode: off`) and error (codex throws) paths
intentionally do NOT write last-review.json — there are no findings to
serialize.

Writer-failure handling (read-only `.rea/`, ENOSPC, race): findings are
re-redacted in-memory before stdout/JSON emission so secrets quoted by
codex never escape via the new surfaces. JSON emits
`last_review_path: null` plus `last_review_error: "write_failed"` when
the write didn't land, so consumers don't follow a stale or missing file
pointer.

Reported by Ava on HELiX `feat/helixui-icons` 2026-05-09. Defect V in the
upstream bug-report log.
