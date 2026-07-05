---
'@bookedsolid/rea': patch
---

fix(global-cli): harden two degraded-path gaps in the 0.50.0 opt-in global-CLI tier. (1) `shim_global_tier_vetoed` now fails closed on a `runtime` block that is a valid YAML object but carries keys outside `RuntimePolicySchema` (e.g. `{ allow_global_cli: true, typo: 1 }`) — `policy-get` only parses YAML, so without this an unknown-key block the strict loader rejects would still enable the global CLI. (2) `rea trust` / `rea untrust` now enforce the A5.3b safe-file contract (regular file, owner, `0600`, `nlink===1`, no symlink) on `~/.rea/trusted-projects` BEFORE reading it, matching the shim and `trust --list`, so a FIFO/device/symlink planted at that path can't block or be read through by the mutating commands.
