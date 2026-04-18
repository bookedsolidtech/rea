---
'@bookedsolid/rea': minor
---

G1 — Audit durability + rotation.

Every append to `.rea/audit.jsonl` now takes a `proper-lockfile` lock on `.rea/`
before the read-last-record → compute-hash → append → fsync sequence. The lock
covers both write paths: the gateway audit middleware and the public
`@bookedsolid/rea/audit` helper. Stale locks are reclaimed after 10s
(`proper-lockfile` default), and lock-acquisition failure in the gateway path
falls back to the pre-0.3.0 behavior (stderr warn, tool call proceeds) — an
audit outage must not take down the gateway.

Size- and age-based rotation lands behind a new optional policy block:

```yaml
audit:
  rotation:
    max_bytes: 52428800     # 50 MiB (default when the block is present)
    max_age_days: 30        # default when the block is present
```

Back-compat is preserved: if an install has no `audit.rotation` block, rotation
is a no-op and behavior is identical to 0.2.x. Defaults only apply once the
operator has opted in by declaring the block.

Rotation renames the current file to `audit-YYYYMMDD-HHMMSS.jsonl` and seeds
the fresh `audit.jsonl` with a single rotation marker record
(`tool_name: "audit.rotation"`) whose `prev_hash` is the SHA-256 of the last
record in the rotated file. This marker is the chain bridge — an operator
verifying the chain with `rea audit verify --since <rotated>` walks rotated
→ marker → current without a break.

Two new CLI subcommands:

- `rea audit rotate` — force-rotate now. Empty files are a deliberate no-op.
- `rea audit verify [--since <rotated-file>]` — re-hash the chain; exits 0 on
  clean, 1 naming the first tampered record. `--since` walks forward through
  all rotated predecessors in timestamp order.

Partial-write recovery: a crash that leaves a trailing line without a newline
is detected on the next read (`readLastRecord`), the partial tail is
truncated, and appends resume cleanly.

Tests (31 new, 278 total):

- Tamper detection — flip a byte in a rotated file, verify exits 1 and
  stderr names the offending record index.
- Crash recovery — partial-line tail is truncated; next append chains on
  the recovered head.
- Cross-process concurrency — two Node processes appending 50 records each
  produce a linear 100-record chain with no duplicate `prev_hash` values.
- Rotation boundary — size trigger rotates with operator-supplied
  `max_bytes: 1024`; fresh file starts with a rotation marker whose
  `prev_hash` equals the rotated file's tail hash.
- Empty-rotation — `rea audit rotate` on an empty/missing audit log is a
  no-op (no rotated file created).
- Happy-path verify — 20 clean appends → `rea audit verify` exits 0.
- Schema — `audit.rotation.{max_bytes, max_age_days}` round-trips; unknown
  fields are rejected under strict mode; non-positive thresholds rejected.

Dependencies: `proper-lockfile@^4.1.2` added to `dependencies` (NOT
devDependencies — this is a runtime import). `@types/proper-lockfile@^4.1.4`
added to `devDependencies`.
