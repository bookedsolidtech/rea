---
'@bookedsolid/rea': minor
---

feat(gateway): always expose `__rea__health` meta-tool for self-diagnostic

The gateway now advertises a single gateway-internal tool, `__rea__health`,
that is always present in `tools/list` regardless of downstream state. Calling
it returns a structured snapshot of the gateway version, uptime, HALT state,
policy summary, and per-downstream connection/health/tool-count — so an LLM
session that sees an empty or suspicious catalog can ask the gateway *why*
instead of guessing.

The short-circuit handler bypasses the middleware chain (including the
kill-switch) so the tool remains callable while HALT is active — this is the
tool operators reach for when everything else is frozen. Every invocation
still writes an audit record via `appendAuditRecord` so calls remain
accountable.

Downstream connections now track their most recent `lastError` message and
expose an `isConnected` getter; the pool aggregates these via a new
`healthSnapshot()` method. Stale successful `tools/list` counts are cached
per-server so the health response can include counts even when a listing
pass fails.
