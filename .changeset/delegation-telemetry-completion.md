---
'@bookedsolid/rea': minor
---

feat(0.31.0): delegation-telemetry completion — the nudge, roster discovery, audit-specialists flags

0.29.0 shipped the delegation-telemetry *observability* layer (the
`Agent|Skill` PreToolUse capture hook + `rea audit specialists`
reader) — it could *see* delegation patterns but said nothing about
them. 0.31.0 closes the loop with the *nudge* plus four supporting
surfaces.

**1. `delegation-advisory.sh` PostToolUse hook + `rea hook
delegation-advisory` CLI.** A new PostToolUse hook on matcher
`Bash|Edit|Write|MultiEdit|NotebookEdit` maintains a per-session
write-class tool-call counter. The first time a session crosses
`policy.delegation_advisory.threshold` (default 25) while having
recorded zero *real* delegation signals, it prints a one-time stderr
advisory. Advisory only — the hook ALWAYS exits 0 except under HALT
(exit 2). It never blocks a tool call. State lives under
`.rea/.delegation-advisory/<state-key>.{count,fired}`; the state key
is a collision-free `<readable-prefix>-<hash>` derived from the
untrusted session id before it touches a filesystem path. Below the
threshold the CLI just bumps an integer — no audit scan, no roster
discovery.

**2. `policy.delegation_advisory` schema.** New optional policy block:
`enabled` (default `false`), `threshold` (positive integer, default
`25`), `exempt_subagents` (default: the 5 built-in Claude Code helper
agents). Strict-mode — a typo fails policy load. The `bst-internal*`
profiles pin `enabled: true` (BST's delegation discipline is
load-bearing); every external profile (`open-source*`, `minimal`,
`client-engagement`, `lit-wc`) ships `enabled: false` — "you should
delegate more" is an opinion not every team shares, so OSS consumers
opt in per-repo.

**3. `rea audit specialists --since / --session`.** The 0.29.0 reader
was current-`audit.jsonl`-only with env-derived session scoping. v2
adds `--since <rotated-file>` (walk the named rotated file + every
later one + the current chain, mirroring `rea audit verify --since`)
and `--session <id>` (explicit session filter; `--session all`
disables filtering; wins over `$CLAUDE_SESSION_ID`).

**4. Live `.claude/agents/` roster discovery.** The nudge's "did this
session delegate to a *real* specialist" predicate discovers the
curated roster from disk (`.claude/agents/*.md`) at read time rather
than keying off the deliberately-frozen `EXPECTED_AGENTS` constant. A
session that delegated only to `general-purpose` / `Explore` / `Plan`
has not routed work to a specialist; a `Skill` invocation always
counts.

**5. `rea doctor --smoke` drives the real shell hook.** The
delegation round-trip smoke check now invokes the actual
`.claude/hooks/delegation-capture.sh` shell hook (resolving +
sandbox-checking the CLI, exercising the `& disown` backgrounding)
and polls for the probe record — not just the CLI underneath. It
degrades to `warn` when a prerequisite is missing (no installed hook;
no sandboxed CLI in scope).

**6. Doctor wiring.** `checkDelegationHookRegistered` promoted
`warn → fail` (the long-promised 0.29.0 ratchet — the `Agent|Skill`
matcher has been in the desired-hooks set for multiple minors). New
`checkDelegationAdvisoryHookRegistered` (advisory `warn` for 0.31.0 —
same upgrade-lag posture 0.29.0 used). `defaultDesiredHooks()` gains
the PostToolUse `Bash|Edit|Write|MultiEdit|NotebookEdit` group.

`EXPECTED_HOOKS` stays at **15** — `delegation-advisory.sh` ships in
the package this release but is **deliberately NOT added** to
`EXPECTED_HOOKS`. Adding it would make `checkHooksInstalled`
hard-`fail` on every pre-0.31.0 consumer install (and this repo's own
dogfood) the instant the rea binary is upgraded but before `rea
upgrade` lays down the new hook file — a green-doctor-goes-red
regression caused purely by upgrade lag. This mirrors the staged
rollout `delegation-capture.sh` itself used in 0.29.0: the
file-presence entry joins `EXPECTED_HOOKS` in the same future minor
that promotes `checkDelegationAdvisoryHookRegistered` from `warn` to
`fail`, once consumers have had upgrade-lag time. Until then a missing
`delegation-advisory.sh` surfaces only through that `warn`-tier
registration check — proportionate, since the hook is advisory at
runtime and never blocks a tool call.

New tests across the delegation-advisory hook + CLI, the policy
schema, the roster module, the audit-specialists flags, and the
doctor round-trip + advisory-registration checks. Includes adversarial
review hardening across three rounds:

- The "did this session delegate" predicate queries the audit log with
  the **audit-form** session id, not the filesystem state key: a real
  id containing `/` or `:` would never match its own delegation
  records, and — matching `runHookDelegationSignal`'s exact fallback —
  an untagged session resolves to the literal `'unknown'` so
  zero-session-id sessions that DID delegate are not falsely nudged.
- The predicate walks **rotated audit segments**, not just the current
  `audit.jsonl` — a delegation recorded before an audit rotation must
  still suppress the nudge.
- `listRotatedAuditFiles` sorts the `-N` intra-second collision suffix
  **numerically** (a lexical sort of the whole basename misorders
  two-digit suffixes — `...-10.jsonl` before `...-2.jsonl` — which
  would make `resolveAuditFileWalk` slice from the wrong index and drop
  later segments in repos that rotate >9 times in one second).
- The per-session state key is **collision-free**. The filesystem
  basename for `.rea/.delegation-advisory/<key>.{count,fired}` is
  `<readable-prefix>-<sha256-of-raw-id>` — a bare sanitized id is lossy
  (`a/b` and `a:b` both flatten to `a_b`), so without the hash suffix
  two distinct sessions would share `count`/`fired` files and one could
  inherit the other's counter or suppress the other's advisory.
- `checkDelegationAdvisoryHookRegistered` **verifies the hook file
  exists AND is executable** (still `warn`-tier): because
  `delegation-advisory.sh` is deliberately out of `EXPECTED_HOOKS` for
  0.31.0, this check is the only doctor signal for the new hook, so a
  settings.json registration pointing at a missing or non-`+x` script
  must not report `pass` — it owns the presence + `0o111` parity that
  `checkHooksInstalled` does for every other shipped hook.
