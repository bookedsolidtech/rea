---
'@bookedsolid/rea': minor
---

feat(dash): `rea dash` — global, read-only project dashboard

A GLOBAL morning view that discovers and aggregates every rea-aware
project on the machine and renders a needs-you-first pane — strictly
read-only over task artifacts (it reads and renders, never mutates task
state or orchestrates).

- **Registry** (`~/.rea/registry.json`): `rea init` / `rea upgrade`
  self-register the project (best-effort — a registry failure never
  fails the command). Reconcile-on-read stats each registered path and
  surfaces `present` / `missing` / `deregistered` — a vanished checkout
  is flagged, never silently dropped.
- **`rea dash`** (no arg): aggregates every present, visible project's
  `.rea/tasks.jsonl` into groups — awaiting/blocked, review queue,
  in-flight, health flags (legacy `.reagent/` dir, stale spine
  version), idle. `rea dash .` is per-repo. `--json` for automation,
  `--rescan [roots]` for the opt-in deep filesystem sweep, `--prune`
  to drop missing entries.
- **Visibility**: a project with `dashboard_visible: false` (registry
  or `.rea/policy.yaml`) is health-checked but its task titles are
  withheld — shown as "N items, hidden"; `--all` overrides for local
  present projects.

Non-load-bearing: no gate, hook, or spine step depends on `rea dash`.
