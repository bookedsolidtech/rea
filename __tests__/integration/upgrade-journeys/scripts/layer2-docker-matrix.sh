#!/usr/bin/env bash
# Layer-2 upgrade-journey matrix — DESIGN STUB (not wired into CI).
#
# Layer 1 (`../journeys.test.ts`) runs the scaffolder functions in-process
# against fixtures. Layer 2 exercises the REAL globally-installed CLI across a
# published-version boundary in a clean container — the only layer that catches
# npm global-install topology, shim PATH resolution, fresh-clone brick states,
# and CDN/registry propagation flakes.
#
# Intended as a NIGHTLY / opt-in job (never gating a hotfix). This file is a
# stub: it documents the matrix and exits non-zero so nobody mistakes it for a
# wired, passing job. See ../README.md § "Layer 2".
#
# Planned usage (once implemented):
#   layer2-docker-matrix.sh <from_version> <to_version> [fixture...]
#
# Planned behavior, per (N, N+1) pair, inside `node:22-bookworm-slim`:
#   1. npm i -g @bookedsolid/rea@N
#   2. rea init <fixture>            → assert doctor-clean at N
#   3. npm i -g @bookedsolid/rea@N+1 → the upgrade boundary (also the
#                                      CDN-propagation verify point)
#   4. rea upgrade                   → assert END-STATE INVARIANTS:
#        - global-tier-dep-free-trusted: rea dep STILL absent
#        - pinned-0.N: managed-caret bumped, no brick
#        - committed-hooks fresh clone: a CLI resolves (gates don't brick)
set -euo pipefail

echo "layer2-docker-matrix.sh is a DESIGN STUB — not yet implemented." >&2
echo "See __tests__/integration/upgrade-journeys/README.md § 'Layer 2'." >&2
exit 2
