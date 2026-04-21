---
'@bookedsolid/rea': minor
---

Agent push-workflow unblock — self-consistent gate, public CLI, anchored path matcher, session hook-patching (Defects D + E + F + H + I)

- **D (rea#77): `rea audit record codex-review` public CLI.** New subcommand
  `rea audit record codex-review --head-sha <sha> --branch <b> --target <t>
  --verdict pass|concerns|blocking|error --finding-count <N> [--summary ...]
  [--session-id ...] [--also-set-cache]`. Thin wrapper around the public
  `appendAuditRecord()` helper with the canonical `tool_name: "codex.review"`
  and `server_name: "codex"` baked in. `--also-set-cache` updates
  `.rea/review-cache.jsonl` in the same invocation (sequential writes,
  not 2PC — but close enough that push-gate lookups cannot observe the
  audit-without-cache state except across a crash) via the
  Codex-verdict mapping (`pass|concerns →
  pass`, `blocking|error → fail`). `rea cache set` now also accepts the four
  canonical Codex verdicts at the CLI boundary. Kills the two-step race
  where the audit record landed but the cache stayed cold.

- **E (rea#78): REA's own CLI no longer denied by REA's own middleware.**
  Policy middleware now classifies `Bash` invocations whose command parses
  as `rea <sub>` by the subcommand's own tier (Read / Write / Destructive)
  instead of the generic Bash Write default. Result: an L1 agent can run
  `rea cache check`, `rea audit record codex-review`, and `rea cache set`
  — exactly the workflow the push-gate remediation text documents. Deny
  messages on `Bash` denials now include the command head (e.g.
  `Bash (rea freeze)` or `Bash ("npm install x...")`) and carry a
  `reason_code = 'tier_exceeds_autonomy'` metadata field.

- **F: cache-query error surfaces distinctly from cache-miss.** The
  `2>/dev/null || echo '{"hit":false}'` pattern in the push and commit
  review gates swallowed stderr AND the exit code, hiding broken `rea`
  installs for weeks (Defect A's node-on-shim bug was one). The gates now
  split stdout/stderr capture and emit a `CACHE CHECK FAILED (exit=N):
  <stderr>` banner on stderr when the CLI exits non-zero, while still
  falling through to `{hit:false}` so pushes are not wedged. Mirrored in
  `.claude/hooks/` and applied to both `push-review-core.sh` and
  `commit-review-gate.sh`.

- **H (rea#79): dot-anchored blocked-path matcher.** The default
  always-blocked list includes `.rea/`. Before the fix, segment-suffix
  matching caused `.rea/` to block writes to any folder named `rea`
  (including Obsidian-style `Projects/rea/Bug Reports`). The matcher now
  requires leading-dot segment equality for dot-prefixed patterns.
  Non-dot patterns keep segment-suffix semantics so operators who want
  to block ANY `rea/` folder can still opt in by dropping the dot.
  Shell enforcer (`blocked-paths-enforcer.sh`) already used prefix
  matching and did not need the change.

- **I: `REA_HOOK_PATCH_SESSION` env var for session-scoped hook patching.**
  Setting `REA_HOOK_PATCH_SESSION=<reason>` allows edits under the runtime
  hook directory `.claude/hooks/` for that shell session. Every allowed
  edit emits a `hooks.patch.session` audit record (routed through the REA
  hash-chained `appendAuditRecord`; if the chain cannot be extended the
  edit is refused) with operator-declared reason, file, pre-edit SHA,
  actor identity, pid, and ppid. Session boundary is the expiry — a new
  shell requires a fresh opt-in. `.rea/policy.yaml`, `.rea/HALT`, and
  settings JSONs remain blocked regardless. Paths containing `..`
  segments are rejected before any match runs, closing a traversal
  bypass (`.claude/hooks/../settings.json`) surfaced by an adversarial
  Codex pass pre-merge. The source-of-truth `hooks/` directory remains
  editable by default; operators who want to gate it can add it to
  `blocked_paths`. See new THREAT_MODEL §5.22.

- **Docs:** new README "Agent push workflow" section with copy-paste CLI
  + SDK examples; new `AGENTS.md` at repo root as canonical agent
  onboarding; THREAT_MODEL §5.22 covering the hook-patch session trust
  boundary.

No breaking changes. `rea cache set <sha> pass|fail` still works; the four
new Codex verdicts are additive. The `@bookedsolid/rea/audit` public export
surface is unchanged — the CLI is a new thin wrapper, not a new SDK entry
point.

[security]
