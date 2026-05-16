---
'@bookedsolid/rea': minor
---

Unified shim policy-fallback (4-tier graceful-degradation reader).

A new shared helper `hooks/_lib/policy-reader.sh` consolidates the
ad-hoc per-shim YAML parsers that accreted across 0.34.0 / 0.35.0
into a single 4-tier ladder:

  1. `rea hook policy-get` (canonical TS loader — handles ALL forms)
  2. python3 with PyYAML (handles flow + block form; YAML-1.2 boolean
     semantics matching the TS loader, so `mode: off` stays the string
     `"off"` not Python's `False`)
  3. awk block-form (last-resort no-dep fallback)
  4. fail-closed (return non-zero; shim decides posture)

Closes the residual deferral arc from the marathon: pre-0.37.0 every
shim's CLI-missing fallback path was block-form-only, so a consumer
with flow-form policy (e.g. `blocked_paths: [.env, ...]` or
`local_review: { mode: off }`) plus an unbuilt/unreachable CLI
silently no-op'd the gate. The new helper's Tier 2 closes that
bypass wherever python3 + PyYAML are available (default on macOS
Homebrew + most Linux distros); Tier 3 preserves the pre-0.37.0
no-dep posture.

Migrated 6 shims to the unified reader:

- `local-review-gate.sh` (`_lrg_read_policy` now delegates)
- `attribution-advisory.sh` (`block_ai_attribution` read)
- `blocked-paths-bash-gate.sh` (`blocked_paths` list)
- `blocked-paths-enforcer.sh` (`blocked_paths` list)
- `protected-paths-bash-gate.sh` (`protected_writes` list)
- `settings-protection.sh` (`protected_writes` list)

The other 8 shipped hooks (`architecture-review-gate`,
`changeset-security-gate`, `dangerous-bash-interceptor`,
`delegation-advisory`, `delegation-capture`, `dependency-audit-gate`,
`env-file-protection`, `pr-issue-link-gate`, `secret-scanner`,
`security-disclosure-gate`) have no inline policy reads at the bash
layer — they forward all policy decisions to the CLI.

Coverage: 33 new tests (22 helper unit + 11 per-shim parity)
verifying each tier independently, the YAML 1.2 boolean handling,
key-shape validation, missing-policy graceful degradation, and the
specific flow-form bypass closures.
