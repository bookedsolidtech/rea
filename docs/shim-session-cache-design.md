# Per-session shim cache — security contract (0.48.0)

Security architect verdict. Implementer: backend-engineer. Cache is an
**optimization, not a security boundary** — every cache-miss path must
fall through to the existing full hot path in `hooks/_lib/shim-runtime.sh`.

## Trust model

The cache participates in the gate trust boundary only by short-circuiting
the sandbox + version-probe layers. Therefore the *cache key itself* is
the trust artifact — if a cache read returns a poisoned entry, the gate
runs against the wrong CLI. Construction must encode every property the
sandbox check would otherwise re-verify.

## 1. Cache key construction

SHA-256 of a NUL-joined ordered tuple, hex-encoded, first 32 chars used
as the on-disk filename:

```
cache_key = sha256(
  schema_version       \0  # "v1"
  session_token        \0  # see §3
  project_root_realpath\0  # realpath of CLAUDE_PROJECT_DIR (NOT raw)
  cli_realpath         \0  # post-symlink-resolution CLI path
  cli_mtime_ns         \0  # stat -f %Fm or %.Y, full precision
  cli_size_bytes       \0  # stat -f %z — defeats mtime-preserving swap
  euid                 \0  # `id -u` — refuse cross-user reuse
  enforce_cli_shape    \0  # SHIM_ENFORCE_CLI_SHAPE value
)
```

`project_root_realpath` and `cli_realpath` MUST be the realpath-resolved
forms; using the raw paths re-opens the symlink-swap class the
sandbox check closes. `cli_size_bytes` defends against an attacker who
touches mtime back after swapping the file (rare but cheap to include).

## 2. Cache storage location

`$TMPDIR/rea-shim-cache.<euid>/<cache_key>.json`

- Per-user directory created with mode `0700`; refuse to read if mode is
  wider (group/other-readable means another local user could have planted
  the entry). Refuse if owner != euid.
- Each entry file written with mode `0600` via `umask 077` + atomic
  `mv` from a `.tmp.$$` sibling. Refuse to read if mode is wider or
  owner mismatches.
- One file per key (no shared JSON blob → no parallel-write race; last
  writer wins on identical content, which is by definition the same).
- `$TMPDIR/rea-shim-cache.<euid>/` lives in tmpfs on Linux/macOS — wiped
  on reboot. We do not persist across sessions on purpose.

`.rea/.shim-cache/` rejected: project-scoped persistence outlives sessions
and lands in the dogfood repo's working tree where another agent or hook
could mutate it. `$$` rejected: shim is a new process each fire.

## 3. Session token derivation

Walk the process tree from `$PPID` upward, stopping at the first ancestor
whose argv0 basename matches `claude` or `claude-code` (or whose
`/proc/<pid>/comm` matches on Linux). Use that ancestor's PID + its
start-time (`ps -o lstart=`) hashed together. Falls back to
`tty_name + login_shell_pid + boot_id` if no Claude ancestor is found
(running under a different harness — cache still works, scoped to the tty).

PPID alone is rejected: shims can be re-parented (e.g. by a shell wrapper).
Including start-time defeats PID reuse across a reboot or long-lived
session.

## 4. Cache entry shape

```json
{
  "schema_version": "v1",
  "cli_path": "...",
  "cli_realpath": "...",
  "cli_version": "0.48.0",
  "cli_mtime_ns": "...",
  "cli_size_bytes": "...",
  "sandbox_ok": true,
  "sandbox_reason": "ancestor-package-json",
  "shape_ok": true,
  "cached_at_unix": 1731000000,
  "ttl_seconds": 3600
}
```

Any unknown field → ignore entry (forward-compatible). Missing required
field → ignore entry. Schema version bump → all v(n-1) entries become
unreadable cache-misses (no migration).

## 5. Invalidation triggers (cache MUST be rebuilt)

- `cli_mtime_ns` or `cli_size_bytes` from `stat` differs from entry
  (consumer ran `pnpm install`)
- `cli_realpath` resolves differently (symlink repointed)
- `cached_at_unix + ttl_seconds < now` — **TTL = 3600s** (1h). Bounds
  staleness for long-running sessions without forcing per-fire rebuild.
- `schema_version != "v1"`
- Entry file owner != euid OR mode wider than `0600`
- JSON parse failure or any required field missing
- `REA_SHIM_CACHE=0` set in env

All invalidation paths take the **full uncached hot path** and overwrite
the entry. Never fail-closed on cache error.

## 6. Fail-safe path

Every cache operation wrapped so any error (ENOENT, EACCES, parse, stat
failure, hash failure) silently falls through to existing `shim_run`
behavior. The cache layer adds zero new exit-2 branches. A `set -e`
inside the cache block is forbidden — use explicit `|| true` per step.

## 7. Threat enumeration

| # | Attack | Defense |
|---|--------|---------|
| 1 | Symlink swap of cached CLI between cache-write and cache-read | `cli_realpath` recomputed at every read and compared to entry; any drift → miss |
| 2 | Two concurrent projects sharing `$TMPDIR` | `project_root_realpath` in key + per-user `0700` dir; cross-project read produces different key |
| 3 | Cache file race on parallel hook fires | One file per key; identical inputs produce identical content; atomic `mv` from `.tmp.$$` ensures no partial reads |
| 4 | Cross-user TOCTOU (other local user plants entry) | `0700` dir + `0600` file + owner check refuse foreign-owned reads |
| 5 | mtime-preserving binary swap (attacker `touch -r`s after replacing CLI) | `cli_size_bytes` in key; size change forces miss even with preserved mtime |
| 6 | Cached `sandbox_ok=true` after consumer moves project | `project_root_realpath` in key; CLAUDE_PROJECT_DIR drift → different key |
| 7 | Schema rollback (older shim reads newer entry) | `schema_version` in key; cross-version reads miss cleanly |
| 8 | Stale cache during a 0.x → 0.y upgrade mid-session | `cli_version` field + `cli_mtime_ns` + `cli_size_bytes` — three independent invalidators |

## 8. Disable switch

`REA_SHIM_CACHE=0` disables both reads and writes. Document in
`README.md` (troubleshooting) and in `hooks/_lib/shim-runtime.sh`
header. Also disabled when `REA_SHIM_CACHE` is unset AND
`policy.shim_cache.enabled` is `false` (additive future hook — out of
scope for 0.48.0, mention only as a forward-compatibility note).

## Sign-off conditions

- `THREAT_MODEL.md` gains a section "§N Per-session shim cache" naming
  attack classes 1–8 and the defense each relies on
- `hook-perf-baseline.md` documents the cache as a *measurement
  confound* — perf baseline runs MUST set `REA_SHIM_CACHE=0` so the
  steady-state hot-path number does not silently improve and mask
  regressions in the underlying resolve/probe layers
- Codex adversarial pass targets §7 specifically: each attack a
  separate fixture
