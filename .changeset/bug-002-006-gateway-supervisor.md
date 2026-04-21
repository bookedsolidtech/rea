---
'@bookedsolid/rea': minor
---

Gateway supervisor, SESSION_BLOCKER events, and per-downstream `rea status`
(BUG-002..006, T2.4 from 0.6.2 deferred).

Before this release, a downstream MCP child that crashed left the gateway's
circuit breaker flapping open → half-open → open against the zombie client.
The half-open probe reused the dead handle, received `Not connected`, and
re-opened the circuit without ever respawning the child. Operators had no
live view of which downstream had wedged: `rea status` only surfaced
session-wide fields, and `__rea__health` was only reachable over the MCP
transport that had (often) already broken.

Changes:

- **Supervisor / respawn** — `DownstreamConnection` now wires `onclose` and
  `onerror` on the MCP SDK transport. Unexpected closes null the client and
  transport eagerly so the next `callTool` forces a genuine reconnect
  rather than calling into a stale handle. `Not connected` errors are
  promoted to the respawn path with the same eager invalidation. Intentional
  `close()` is gated so it does not double-count as an unexpected death.
- **SESSION_BLOCKER event** — new `SessionBlockerTracker` subscribes to
  circuit-breaker `onStateChange` events, counts circuit-open transitions
  per (session_id, server_name), and emits a single LOUD `SESSION_BLOCKER`
  log record plus audit entry when the threshold (default: 3) is crossed.
  Recovery resets the counter and re-arms the emit; a new session drops
  every counter. Further opens within an armed window do NOT re-fire.
- **Live `rea status`** — the gateway now publishes `serve.state.json`
  with a `downstreams` block on every circuit-breaker transition and
  supervisor event, coalesced through a 250 ms debounce and written
  atomically via temp+rename. `rea status` (both pretty and `--json`)
  surfaces per-downstream `circuit_state`, `retry_at`, `connected`,
  `healthy`, `last_error`, `tools_count`, `open_transitions`, and
  `session_blocker_emitted`. Legacy state files without a `downstreams`
  key degrade to a null field and a hint to upgrade the gateway.

No API removals. New gateway options (`liveStateFilePath`,
`liveStateSessionId`, `liveStateStartedAt`, `liveStateMetricsPort`,
`liveStateLastErrorRedactor`) and new `GatewayHandle` fields
(`livePublisher`, `sessionBlocker`) are additive and optional.
`liveStateLastErrorRedactor` scrubs downstream error strings before they
land in `serve.state.json`; `rea serve` wires it automatically to the
same `buildRegexRedactor` the gateway logger uses.
