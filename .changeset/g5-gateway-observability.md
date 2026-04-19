---
'@bookedsolid/rea': minor
---

feat(gateway): G5 — gateway observability. Adds three user-visible surfaces:

- `rea status` — new CLI command that reports live-process state for a
  running `rea serve` (pid, session id, metrics endpoint URL), the policy
  summary (profile, autonomy, blocked-paths count, codex_required, HALT), and
  audit log stats (lines, last timestamp, tail-hash smoke). Supports `--json`
  for composing with `jq` and future tooling. `rea check` remains the
  authoritative on-disk snapshot — `rea status` is the running-process view.
- Structured JSON-lines gateway logger at `src/gateway/log.ts`. Honors
  `REA_LOG_LEVEL` (info default; debug/warn/error supported). Pretty-prints
  when stderr is a TTY, emits JSON lines on non-TTY sinks. No new deps —
  ~200-line no-dep implementation. `rea serve` wires the logger into
  connection open/close/reconnect events and circuit-breaker state transitions.
  `[rea-serve]` prefix preserved in pretty mode so existing grep-based smoke
  tests (helix) continue to match.
- Optional loopback `/metrics` HTTP endpoint. Opt-in via `REA_METRICS_PORT`
  — no silent listeners. Binds `127.0.0.1` only, serves Prometheus text
  exposition, exposes per-downstream call/error/in-flight counters, audit
  lines appended, circuit-breaker state gauge, and a seconds-since-last-HALT
  gauge. Rejects non-GET methods with 405 and non-`/metrics` paths with 404
  (no request-path reflection in response bodies). `node:http` only — no
  express/fastify.

`rea serve` now writes a short-lived breadcrumb pidfile at `.rea/serve.pid`
and session state at `.rea/serve.state.json` for `rea status` introspection.
Both files are removed on graceful shutdown (SIGTERM/SIGINT). The README
non-goal "no pid file" is narrowed to clarify that this is a read-only
breadcrumb, not a supervisor lock — there is still no `rea start`/`rea stop`.
