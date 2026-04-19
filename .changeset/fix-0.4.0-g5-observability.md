---
'@bookedsolid/rea': patch
---

fix(gateway): G5 observability — post-merge Codex blocker sweep. Eight
BLOCKING findings from adversarial review of the G5 feature (merged as
PR #22) are resolved ahead of 0.4.0:

- **metrics bind allowlist (security).** `startMetricsServer` now validates
  the `host` option against a strict loopback allowlist (`127.0.0.1`,
  `::1`). Anything else — `localhost`, `0.0.0.0`, `::`, any LAN IP — throws
  a `TypeError` BEFORE a socket is opened. Closes the path where a caller
  could accidentally expose the unauthenticated `/metrics` endpoint to
  the network. A test-only `__TEST_HOST_OVERRIDE` symbol preserves the
  hostname-resolution test path; the symbol is unreachable from YAML,
  JSON, or CLI deserialization.
- **pid/state breadcrumb race.** `rea serve` now writes `.rea/serve.pid`
  and `.rea/serve.state.json` atomically (stage-to-temp + `rename(2)`)
  and cleans them up only when the file still carries this process's pid
  (pidfile) or session id (state). Two overlapping `rea serve`
  invocations in the same `baseDir` no longer clobber each other's
  breadcrumbs on the first instance's shutdown.
- **ANSI/OSC escape injection in `rea status` pretty mode.** Every
  disk-sourced string field (`profile`, `autonomy_level`, `halt_reason`,
  `session_id`, `started_at`, `last_timestamp`) is scrubbed through a
  new `sanitizeForTerminal` helper before reaching the operator's
  terminal. C0 control bytes (0x00-0x1F) and DEL (0x7F) are replaced
  with `?` — the ESC byte that initiates CSI/OSC sequences and the BEL
  byte that terminates OSC 8 hyperlinks are both scrubbed. JSON mode
  output is untouched (JSON.stringify already escapes safely).
- **observability counter wiring.** `createAuditMiddleware` and
  `createKillSwitchMiddleware` now accept an optional `MetricsRegistry`.
  The audit middleware increments `rea_audit_lines_appended_total` on
  every successful fsynced append; the kill-switch middleware refreshes
  `rea_seconds_since_last_halt_check` on every invocation (previously
  the gauge only reflected the startup-time mark). `rea serve` wires
  the same registry into both. Counter failures never crash the chain.
- **log-field redaction.** The gateway logger now accepts an optional
  `redactField` hook applied to every string-valued field before
  serialization. `rea serve` installs a redactor compiled from the
  same `SECRET_PATTERNS` the redact middleware uses, so downstream
  error messages that carry env var names, argv fragments, or file
  paths with credential material reach stderr already scrubbed. A
  redactor that throws falls back to `[redactor-error]` per field —
  the record itself is never dropped.
- **bounded-memory audit tail.** `rea status` no longer reads the
  whole `audit.jsonl` into a buffer to count lines or find the last
  record. Line count uses a streaming 64-KiB-chunk scan; the last
  record is sourced from a positioned 64-KiB tail-window read. On
  multi-hundred-MB chains the memory footprint is bounded to the
  window size plus the scan buffer.
- **bounded metrics `close()`.** `startMetricsServer` tracks every
  live socket and guarantees `close()` resolves within 2 s even when
  a Prometheus scraper is holding a keep-alive connection open. On
  deadline the server calls `closeIdleConnections()` (Node 18.2+)
  and destroys any surviving tracked sockets. The timer is `unref`'d
  so it never holds the process open.
- **pretty-mode cyclic-safe serialization.** Pretty-mode logger extras
  that contain a cyclic reference no longer drop the entire record.
  A safe-stringify wrapper substitutes a stable `[unserializable]`
  placeholder so the operator still sees the event, level, and
  message.
