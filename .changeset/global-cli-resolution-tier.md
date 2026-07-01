---
"@bookedsolid/rea": minor
---

Add an opt-in **global rea CLI resolution tier** so rea's hooks can govern a
checkout without adding `@bookedsolid/rea` to that checkout's shared
`package.json`. This is a MODEL CHANGE — a new resolution tier — not a fix.

It is **OFF by default**. In-project resolution always wins, and an un-blessed
checkout is byte-identical to a rea build without the feature. `rea init` and
`rea upgrade` behavior is UNCHANGED — they never touch `~/.rea/` and never write
the new policy key.

What is new:

- `rea install --global [--version <semver>] [--trust [path]] [--force]` — a
  real per-user `npm install --prefix ~/.rea/cli @bookedsolid/rea`, out of any
  project. Refuses to install inside a git checkout.
- `rea trust [path]` / `rea untrust [path]` / `rea trust --list` — manage the
  per-user global-CLI allow-list `~/.rea/trusted-projects`. These and
  `install --global` are human actions: they refuse to mutate the trust root
  under a governed agent session (`CLAUDE_PROJECT_DIR` set). The root is derived
  from the password database, never `$HOME` / `$XDG_*`. POSIX-only in v1.
- `runtime.allow_global_cli?: boolean` policy key — an in-project **veto** over
  the tier. The registry can only ever ENABLE enforcement; a checkout's own
  policy can only further-RESTRICT it. Enforcement is always the in-project
  `.rea/policy.yaml` — the global tier supplies a CLI binary, never a policy.
- `rea doctor` gains a global-CLI section that names the resolved realpath and
  reports the active tier (in-project / global-trusted / untrusted-warn /
  policy-veto).

Operational notes for consumers:

- The shim per-session cache schema bumps `v1` → `v2` (one-time cold cache on
  the first fire after upgrade; no action required).
- A new per-user artifact `~/.rea/trusted-projects` (mode `0600`) is created
  only if you opt in via `rea install --global` / `rea trust`. It is distinct
  from the per-project `.rea/registry.yaml` MCP TOFU store.

See THREAT_MODEL.md §5.24 for the trust model, MIGRATING.md "Governing a shared
repo without touching shared files" for the workflow, and
`docs/shim-session-cache-design.md` "v2 — global-tier trust scoping" for the
cache schema change.
