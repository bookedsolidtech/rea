---
'@bookedsolid/rea': minor
---

G7 — Proxy-poisoning defense via TOFU fingerprints.

The gateway now fingerprints every downstream server declared in
`.rea/registry.yaml` on first startup and persists the result to
`.rea/fingerprints.json` (versioned JSON, schema-validated). On every
subsequent `rea serve`, each server is reclassified as `unchanged`,
`first-seen`, or `drifted`:

- **Unchanged** — proceed silently.
- **First-seen** — LOUD stderr block announcing the new fingerprint,
  structured `tofu.first_seen` audit record, allow the connection. This
  is deliberately noisy so a poisoned registry at first install is
  visible in stderr, logs, and audit trail at the same time.
- **Drifted** — stderr block, `tofu.drift_blocked` audit record (status
  `denied`), and the server is DROPPED from the downstream pool. Other
  servers stay up; the gateway does not fail-close on drift of a single
  server. To accept a legitimate rotation for one boot, set
  `REA_ACCEPT_DRIFT=<name>` (comma-separated for multiple).

The fingerprint is **path-only**: `name`, `command`, `args`, sorted
`env` KEY SET, sorted `env_passthrough`, and `tier_overrides`. Env
VALUES are intentionally excluded so rotating a token (`GITHUB_TOKEN`
etc.) does not trip drift. We do NOT hash the binary at `config.command`
— that would be a slow-boot tax on every restart, legitimate MCP
upgrades would trip false-positive drift, and host-binary compromise is
a separate G-number, not G7. The G7 threat is YAML tampering, which the
canonicalized config hash covers.

A corrupt or schema-invalid `fingerprints.json` fails the gateway
closed: we never silently reset TOFU state, because that would downgrade
drift detection to first-seen acceptance. The operator can delete the
file deliberately to re-bootstrap. `rea doctor` grows a `fingerprint
store` row that surfaces first-seen / drifted counts without waiting for
`rea serve`.
