#!/bin/bash
# hooks/_lib/shim-cache.sh — per-session shim cache helper.
# Introduced 0.48.0.
#
# Source via:
#   source "$(dirname "$0")/_lib/shim-cache.sh"
#
# # What this is
#
# An OPTIMIZATION layer over `shim_run`'s sandbox check + version
# probe (steps 5-8 of shim-runtime.sh). When the same shim fires
# repeatedly in the same Claude Code session against the same CLI on
# the same project, the answers to "is the CLI inside the sandbox"
# and "does it implement this subcommand" do not change. The cache
# records those answers keyed on every input the sandbox check
# would otherwise re-verify, so subsequent fires can skip straight
# to the forward step.
#
# # What this is NOT
#
# A SECURITY boundary. Every cache-miss path falls through to the
# existing uncached hot path in `shim_run`. Every cache operation is
# fail-safe — corruption / parse failure / stat failure / hash
# failure all degrade to a clean miss, NEVER fail-closed. A cached
# entry that goes stale produces a different key (one of:
# mtime/size/realpath/euid changed), so the wrong CLI cannot be
# executed from a poisoned entry.
#
# See `docs/shim-session-cache-design.md` for the full security
# contract (key construction, threat enumeration, invalidation
# triggers).
#
# # Cache key fields (NUL-joined, sha256-hashed, first 32 hex chars)
#
#   schema_version       — "v1"
#   session_token        — see shim_cache_session_token
#   project_root_realpath — realpath(CLAUDE_PROJECT_DIR)
#   cli_realpath         — realpath(resolved CLI)
#   cli_mtime            — `stat` mtime (ns precision; see "Portability"
#                          below for why both platforms can do ns)
#   cli_size_bytes       — `stat` size — defeats `touch -r` mtime-preserving
#                          swap
#   euid                 — `id -u` — refuses cross-user cache reuse
#   enforce_cli_shape    — SHIM_ENFORCE_CLI_SHAPE value
#   shim_name            — SHIM_NAME (0.48.0 codex round-1 P1: the
#                          version probe is `rea hook $SHIM_NAME --help`,
#                          so the cache must be hook-scoped to prevent
#                          a cache-warm shim letting a sibling skip its
#                          OWN version-skew check)
#   pkg_mtime / pkg_size — `stat` of the ancestor package.json the
#                          sandbox check found (codex round-3 P2: a
#                          same-session edit or rename of that
#                          package.json invalidates the entry)
#   dist_mtime           — `stat` mtime of dist/cli/ (codex round-3 P1:
#                          a same-session rebuild that adds or removes
#                          ANY file in dist/cli/ invalidates the entry;
#                          this is the dominant signal for the rea-dev
#                          workflow where `pnpm build` rewrites many
#                          siblings of index.js)
#   node_realpath        — realpath(resolved `node` binary) (codex
#                          round-4 P1: a same-session `nvm use` or PATH
#                          prepend that swaps the interpreter invalidates
#                          the entry, since the warm hit otherwise skips
#                          the node-availability check + version probe)
#   node_mtime           — `stat` mtime of the node binary (defense for
#                          a swap that re-resolves to the SAME realpath
#                          but with a different binary, e.g. an in-place
#                          rebuild of node itself; rare but cheap)
#
# # Storage
#
#   $TMPDIR/rea-shim-cache.<euid>/<key>.json
#
# Per-user directory created mode 0700 (umask 077). Per-entry file
# written mode 0600 via atomic `mv` from `.tmp.$$`. Entries refuse
# to be read when:
#
#   - directory mode is wider than 0700 OR owned by another user
#   - file mode is wider than 0600 OR owned by another user
#   - JSON parse fails OR required field missing
#   - `cli_mtime` / `cli_size_bytes` from disk differ from the
#     entry (caller already includes those in the key, but we double-
#     check post-load to defend against a key-collision attacker)
#   - `cached_at_unix + ttl_seconds < now` — TTL hard ceiling 3600s
#
# # Portability — mtime precision
#
# 0.48.0 codex round-2 P2: nanosecond precision used uniformly on both
# platforms. macOS `stat -f %Fm` produces fractional seconds (e.g.
# `1779052861.082677123`); GNU coreutils `stat -c %.Y` produces the
# same string shape. Both round to the underlying filesystem's
# resolution (APFS / ext4 both store ns mtime today). The design memo
# concern #1 was conditional ("if you can't on one platform, downgrade
# both") — since both platforms CAN, we use ns and close the
# same-second-same-size rebuild collision class.
#
# `cli_size_bytes` remains in the key as defense-in-depth against
# nanosecond-truncating filesystems (some FAT/NTFS mounts) — there
# the second-precision mtime would still discriminate at the cost of
# the same-second-same-size hole, which is an extreme corner case for
# a dev tool.
#
# # Portability — sha256
#
# `shasum -a 256` ships with macOS and most Linux distros (perl
# bundle). `sha256sum` ships with GNU coreutils on Linux. We try both;
# if neither is present the cache returns a clean miss (NEVER fails
# closed).
#
# # Disable switch
#
# `REA_SHIM_CACHE=0` in env disables both reads and writes (this is
# what `pnpm perf:hooks` sets so steady-state numbers do not silently
# improve and mask regressions in the underlying resolve/probe layers).
# `policy.shim_cache.enabled: false` is a forward-compatibility hook
# (schema landed in 0.48.0; honored at the bash layer below).
#
# # Public API
#
#   shim_cache_disabled                  — returns 0 if cache OFF, 1 if ON
#   shim_cache_session_token             — prints session token to stdout
#                                          (empty + exit 1 means "cache
#                                          disabled, no token derivable")
#   shim_cache_key                       — args:
#                                            schema_version session_token
#                                            project_realpath cli_realpath
#                                            cli_mtime cli_size euid
#                                            enforce_cli_shape shim_name
#                                          (9 args; the helper accepts
#                                          variadic but the caller in
#                                          shim-runtime always passes 9)
#                                          prints the 32-char hex key
#                                          (exit 1 on hash failure → caller
#                                          treats as clean miss)
#   shim_cache_read   <key>              — prints the cached JSON line on hit;
#                                          exit 0 on hit, 1 on miss/error
#   shim_cache_write  <key> <json>       — atomic write; exit 0 on success,
#                                          1 on error (callers ignore the
#                                          return value — cache write
#                                          failure NEVER blocks the gate)
#
# All operations are wrapped to fail-safe. A `set -e` inside the cache
# block is forbidden — use explicit `|| true` per step.

# -----------------------------------------------------------------------------
# Internal: portable nanosecond-precision mtime + size. Echoes
# "<mtime_with_fractional_seconds> <size_bytes>" on success; empty
# string on failure. 0.48.0 codex round-2 P2: uses ns precision on
# both platforms (was second-only before) to close the
# same-second-same-size rebuild collision class. macOS `%Fm` and GNU
# `%.Y` both produce the `1779052861.082677123` shape — string-equal
# across platforms for the same physical mtime.
# -----------------------------------------------------------------------------
_shim_cache_stat_mtime_size() {
  local file="$1"
  local out=""
  if [ "$(uname -s 2>/dev/null || echo)" = "Darwin" ]; then
    out=$(stat -f "%Fm %z" "$file" 2>/dev/null || true)
  else
    out=$(stat -c "%.Y %s" "$file" 2>/dev/null || true)
  fi
  printf '%s' "$out"
}

# -----------------------------------------------------------------------------
# Internal: sha256 of NUL-joined args. Echoes the first 32 hex chars on
# success; empty string + non-zero exit on failure.
# -----------------------------------------------------------------------------
_shim_cache_sha256_hex() {
  # Build the NUL-joined payload on stdin so we never argv-leak content.
  local first=1
  local arg
  {
    for arg in "$@"; do
      if [ "$first" -eq 1 ]; then
        first=0
      else
        printf '\0'
      fi
      printf '%s' "$arg"
    done
  } | _shim_cache_sha256_pipe
}

_shim_cache_sha256_pipe() {
  local out=""
  if command -v shasum >/dev/null 2>&1; then
    out=$(shasum -a 256 2>/dev/null | awk '{print $1}' || true)
  elif command -v sha256sum >/dev/null 2>&1; then
    out=$(sha256sum 2>/dev/null | awk '{print $1}' || true)
  fi
  if [ -z "$out" ]; then
    return 1
  fi
  # First 32 hex chars (128 bits) — plenty for cache-key uniqueness.
  printf '%s' "${out:0:32}"
}

# -----------------------------------------------------------------------------
# Disable switch. Returns 0 if cache OFF, 1 if cache ON.
# Cache is OFF when:
#   - REA_SHIM_CACHE=0 in env, OR
#   - policy.shim_cache.enabled is explicitly "false" (best-effort read
#     via grep — the cache short-circuits BEFORE the policy reader is
#     available, so we use a lightweight pattern. The policy schema in
#     src/policy/loader.ts validates the field at CLI load time; this
#     read only fires before that).
# -----------------------------------------------------------------------------
shim_cache_disabled() {
  if [ "${REA_SHIM_CACHE:-1}" = "0" ]; then
    return 0
  fi
  # Best-effort policy read. The cache layer runs in the shim's
  # pre-CLI section, so the canonical 4-tier policy reader may not yet
  # have been sourced. We do a narrow inline grep — the goal is forward-
  # compat: a consumer who wants to disable the cache via policy (not
  # env) gets the right behavior. A parse failure or missing key
  # silently leaves the cache enabled (cache being on is the safer
  # default — at worst it adds latency, never refuses).
  local policy_path="${REA_ROOT:-}/.rea/policy.yaml"
  if [ -f "$policy_path" ]; then
    # 0.48.0 codex round-1 P2: handle BOTH block-form AND flow-form
    # YAML. The TypeScript loader accepts both shapes (zod schema is
    # form-agnostic); the bash helper must match. Forms accepted:
    #
    #   shim_cache:
    #     enabled: false               <-- block-form
    #
    #   shim_cache: { enabled: false } <-- flow-form
    #   shim_cache: {enabled: false}   <-- flow-form, no spaces
    #
    # awk pattern keeps the apostrophe rule from 0.34.0 lockout in mind:
    # no single quotes inside awk single-quoted body (use \047 if needed).
    local result=""
    # 0.48.0 codex round-2 P2: tolerate inline YAML comments. Both
    # forms can end with `  # ...`-style trailing comments — `enabled:
    # false # temporary` is valid YAML and the TS loader accepts it.
    # The trailing-content trailer matches any whitespace + optional
    # `#` + rest-of-line. The block-form section opener is also
    # comment-tolerant.
    #
    # 0.48.0 codex round-4 P2: YAML accepts mixed-case booleans like
    # `False`, `FALSE`. The TS loader (yaml.parse → zod boolean)
    # accepts those spellings. To match we lowercase each line via
    # `tolower()` before pattern matching. The `false` literal in the
    # regex matches the canonical lowercase form after normalization.
    # 0.48.0 codex round-9 P3: tolerate leading indentation on the
    # `shim_cache:` opener. The TS loader accepts a policy.yaml
    # reformatted as `  shim_cache:\n    enabled: false` (uncommon
    # but valid YAML). Pre-fix the bash matcher pinned column 0.
    # We strip leading whitespace from the line for matching
    # purposes; for the block-form sub-block scan we ALSO track the
    # opener indent depth so we do not mistake a deeper-indented
    # sibling block enabled: false for ours. The block-form-end
    # heuristic is now first non-empty line at or below the opener
    # indent level.
    #
    # 0.48.1 R10 P3: pure-comment lines (matching ^[[:space:]]*#) MUST
    # NOT close the block. Pre-fix a top-level comment like
    # shim_cache:\n# note\n  enabled: false closed the block on the
    # comment line (non-empty, indent 0 <= opener_indent 0) and the
    # subsequent enabled: false was treated as a top-level key with
    # no parent block, so the disable was silently ignored.
    #
    # 0.48.1 multi-line flow-form: shim_cache: {\n  enabled: false\n}
    # is valid YAML the TS loader accepts. We add a flow-block state
    # that opens on shim_cache: { (with the { unmatched on the same
    # line), accumulates body until }, and matches enabled: false in
    # the assembled buffer. The single-line flow-form rule above
    # still wins for shim_cache: { enabled: false } on one line.
    result=$(awk '
      {
        lc = tolower($0)
        # Compute indentation depth of current line (number of
        # leading whitespace characters before any non-ws).
        indent_of_line = match(lc, /[^[:space:]]/) - 1
        if (indent_of_line < 0) indent_of_line = 0
      }
      # Pure-comment line: skip without affecting state. Must come
      # before BOTH the flow-block accumulator AND the block-end
      # heuristic so a comment inside either context is transparent.
      lc ~ /^[[:space:]]*#/ {
        next
      }
      # 0.48.1 round-2 P2: removed the narrow single-line flow regex
      # that matched shim_cache: { enabled: false } with [^}]* — it
      # had no concept of quoted scalars or trailing comments and
      # mis-fired on shim_cache: { note: "enabled: false", enabled:
      # true }. The single-line case now flows through the brace-
      # depth path below (which strips quotes + trailing comments
      # per line); the only behavior change is that the inline form
      # gets the same sanitization the multi-line form already does.
      # Flow-form multi-line opener: shim_cache: { with the first {
      # unmatched on the same line. Start accumulating until the
      # matching close brace.
      #
      # 0.48.1 round-1 P2-B: track BRACE DEPTH across the buffer
      # instead of closing on the first }. Valid YAML such as
      # shim_cache: { meta: { foo: bar }, enabled: false } has
      # nested {} pairs; a quoted scalar like note: "}" embeds a
      # brace inside a string. We strip "..." and *...* (single-quote
      # placeholder is \047 to keep this awk single-quoted body
      # apostrophe-clean) before counting so quoted braces do not
      # affect depth. Approximate but matches every shape the TS
      # loader accepts; on a malformed policy the worst case is
      # cache-stays-on (the safe default).
      in_flow == 0 && lc ~ /^[[:space:]]*shim_cache:[[:space:]]*\{/ {
        # Build a sanitized line: strip quoted scalars first so
        # quoted braces / quoted comments / quoted enabled: false
        # tokens cannot pollute brace-depth or value detection;
        # then strip trailing #-comments so they cannot either.
        # 0.48.1 round-2 P2 fix.
        line_stripped = lc
        gsub(/"[^"]*"/, "", line_stripped)
        gsub(/\047[^\047]*\047/, "", line_stripped)
        gsub(/[[:space:]]*#.*$/, "", line_stripped)
        opens = gsub(/\{/, "{", line_stripped)
        closes = gsub(/\}/, "}", line_stripped)
        flow_depth = opens - closes
        if (flow_depth <= 0) {
          # Already balanced on this line — single-line flow form,
          # potentially with nested braces (e.g. { meta: { foo: bar
          # }, enabled: false }). The narrow single-line rule above
          # cannot match nested-brace shapes (its [^}]* fails on the
          # inner closing brace), so we check the SANITIZED line
          # (quotes + comments stripped) here. Anchoring on a token
          # boundary defends against accidental substring noise
          # like enabled-false-something.
          if (line_stripped ~ /enabled[[:space:]]*:[[:space:]]*false([^[:alnum:]_]|$)/) {
            print "off"; exit
          }
          next
        }
        in_flow = 1
        flow_buf = line_stripped
        next
      }
      # Flow-form continuation: accumulate sanitized + maintain depth.
      in_flow == 1 {
        line_stripped = lc
        gsub(/"[^"]*"/, "", line_stripped)
        gsub(/\047[^\047]*\047/, "", line_stripped)
        gsub(/[[:space:]]*#.*$/, "", line_stripped)
        flow_buf = flow_buf " " line_stripped
        opens = gsub(/\{/, "{", line_stripped)
        closes = gsub(/\}/, "}", line_stripped)
        flow_depth += opens - closes
        if (flow_depth <= 0) {
          in_flow = 0
          if (flow_buf ~ /enabled[[:space:]]*:[[:space:]]*false([^[:alnum:]_]|$)/) {
            print "off"; exit
          }
        }
        next
      }
      # Block-form opener: leading whitespace allowed.
      lc ~ /^[[:space:]]*shim_cache:[[:space:]]*(#.*)?$/ {
        in_block = 1
        opener_indent = indent_of_line
        next
      }
      # End the block when we see a non-empty line at or below the
      # opener indent (a sibling YAML key at the same level). Comment
      # lines were already filtered above so they cannot close the block.
      in_block && lc !~ /^[[:space:]]*$/ && indent_of_line <= opener_indent {
        in_block = 0
      }
      in_block && lc ~ /^[[:space:]]+enabled:[[:space:]]*false([[:space:]]+(#.*)?)?[[:space:]]*$/ {
        print "off"; exit
      }
    ' "$policy_path" 2>/dev/null || true)
    if [ "$result" = "off" ]; then
      return 0
    fi
  fi
  return 1
}

# -----------------------------------------------------------------------------
# Session token derivation. See design §3.
#
#   1. Walk PPID ancestry up to N hops looking for an ancestor whose
#      command name matches "claude" or "claude-code". Use that PID +
#      start-time, sha256-hashed.
#   2. Fallback: tty_name + login_shell_pid + boot_id (or kernel
#      uptime on macOS where /proc/sys/kernel/random/boot_id is
#      absent).
#   3. Final fallback: empty + exit 1. NEVER use PPID alone.
#
# Echoes the token (32 hex chars) to stdout on success; empty + exit
# 1 means the caller should treat the cache as disabled for this
# invocation.
# -----------------------------------------------------------------------------
shim_cache_session_token() {
  local pid="$$"
  local ppid="${PPID:-0}"
  local cur="$ppid"
  local hops=0
  local max_hops=20
  local match_pid=""
  local match_start=""

  while [ "$cur" -gt 1 ] && [ "$hops" -lt "$max_hops" ]; do
    local comm=""
    # Linux: /proc/<pid>/comm has the basename (truncated to 15 chars).
    if [ -r "/proc/$cur/comm" ]; then
      comm=$(cat "/proc/$cur/comm" 2>/dev/null || true)
    else
      # macOS / BSD: ps -o comm=
      comm=$(ps -o comm= -p "$cur" 2>/dev/null | awk '{print $1}' || true)
      # ps may give "/usr/local/bin/claude" — basename it.
      comm=$(basename "$comm" 2>/dev/null || true)
    fi
    case "$comm" in
      claude|claude-code)
        # 0.48.0 codex round-1 P2: claude and claude-code are the only
        # ancestors we accept as authoritative session anchors. We
        # previously also matched `cli` / `node` here without setting
        # match_pid — confusing dead branch removed. Non-TTY launches
        # under `cli` or `node` parents reach the tty/login-shell/boot-id
        # fallback below; if THAT also fails (truly stripped container)
        # the final `cache disabled` path fires and the gate runs
        # uncached. The narrower match list keeps the session-token
        # contract strict — we don't want to accept ANY `node`
        # ancestor since that scope leaks across unrelated processes.
        match_pid="$cur"
        break
        ;;
    esac
    # Walk up.
    local next=""
    if [ -r "/proc/$cur/status" ]; then
      next=$(awk '/^PPid:/ {print $2; exit}' "/proc/$cur/status" 2>/dev/null || true)
    else
      next=$(ps -o ppid= -p "$cur" 2>/dev/null | awk '{print $1}' || true)
    fi
    if [ -z "$next" ] || [ "$next" = "$cur" ] || [ "$next" -le 1 ] 2>/dev/null; then
      break
    fi
    cur="$next"
    hops=$((hops + 1))
  done

  if [ -n "$match_pid" ]; then
    # Get process start time. Linux: /proc/<pid>/stat field 22 (jiffies
    # since boot). macOS: ps -o lstart= -p <pid>.
    if [ -r "/proc/$match_pid/stat" ]; then
      match_start=$(awk '{print $22}' "/proc/$match_pid/stat" 2>/dev/null || true)
    fi
    if [ -z "$match_start" ]; then
      match_start=$(ps -o lstart= -p "$match_pid" 2>/dev/null || true)
    fi
    if [ -n "$match_start" ]; then
      _shim_cache_sha256_hex "claude-ancestor" "$match_pid" "$match_start"
      return $?
    fi
  fi

  # Fallback: tty + login-shell-pid + boot identifier.
  local tty_name=""
  tty_name=$(tty 2>/dev/null || true)
  local login_pid=""
  # Walk PPID chain looking for a shell (basename match against typical
  # login shells). This is best-effort.
  cur="$ppid"
  hops=0
  while [ "$cur" -gt 1 ] && [ "$hops" -lt "$max_hops" ]; do
    local comm=""
    if [ -r "/proc/$cur/comm" ]; then
      comm=$(cat "/proc/$cur/comm" 2>/dev/null || true)
    else
      comm=$(ps -o comm= -p "$cur" 2>/dev/null | awk '{print $1}' || true)
      comm=$(basename "$comm" 2>/dev/null || true)
    fi
    case "$comm" in
      bash|zsh|fish|sh|dash|ksh|tcsh|csh|-bash|-zsh)
        login_pid="$cur"
        break
        ;;
    esac
    local next=""
    if [ -r "/proc/$cur/status" ]; then
      next=$(awk '/^PPid:/ {print $2; exit}' "/proc/$cur/status" 2>/dev/null || true)
    else
      next=$(ps -o ppid= -p "$cur" 2>/dev/null | awk '{print $1}' || true)
    fi
    if [ -z "$next" ] || [ "$next" = "$cur" ] || [ "$next" -le 1 ] 2>/dev/null; then
      break
    fi
    cur="$next"
    hops=$((hops + 1))
  done

  local boot_id=""
  if [ -r "/proc/sys/kernel/random/boot_id" ]; then
    boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)
  else
    # macOS / BSD: kern.boottime (seconds-since-epoch of the last boot).
    boot_id=$(sysctl -n kern.boottime 2>/dev/null | sed -E 's/[^0-9]//g' || true)
  fi

  if [ -n "$tty_name" ] && [ -n "$login_pid" ] && [ -n "$boot_id" ]; then
    _shim_cache_sha256_hex "tty-fallback" "$tty_name" "$login_pid" "$boot_id"
    return $?
  fi

  # 0.48.0 codex round-6 P1: intermediate fallback for non-interactive
  # subprocess launches (CI, vitest harness, editor-spawned subprocess)
  # where:
  #   - no claude/claude-code ancestor exists (running under a different
  #     harness or none at all)
  #   - no tty (stdin is piped)
  # without this, the tty fallback above fails and the function returns
  # 1 → cache disabled → cumulative latency the cache exists to fix.
  #
  # The token is composed of PPID's basename + PPID's start-time + the
  # boot identifier. This is NOT "use PPID alone" — the start-time
  # disambiguates PID reuse across reboots, and the boot-id confines
  # it to the current boot. A different parent process → different
  # token; a reboot → different token. The session is scoped to
  # "this specific parent invocation, on this boot". Slightly broader
  # than the tty-fallback (which scopes to "this tty session") but
  # narrower than "no cache at all". Requires lstart and a boot
  # identifier; if either is missing we fall through to the final
  # disabled state per design memo concern #2.
  local ppid_comm=""
  if [ -r "/proc/$ppid/comm" ]; then
    ppid_comm=$(cat "/proc/$ppid/comm" 2>/dev/null || true)
  else
    ppid_comm=$(ps -o comm= -p "$ppid" 2>/dev/null | awk '{print $1}' || true)
    ppid_comm=$(basename "$ppid_comm" 2>/dev/null || true)
  fi
  local ppid_start=""
  if [ -r "/proc/$ppid/stat" ]; then
    ppid_start=$(awk '{print $22}' "/proc/$ppid/stat" 2>/dev/null || true)
  fi
  if [ -z "$ppid_start" ]; then
    ppid_start=$(ps -o lstart= -p "$ppid" 2>/dev/null || true)
  fi
  if [ -n "$ppid_comm" ] && [ -n "$ppid_start" ] && [ -n "$boot_id" ]; then
    _shim_cache_sha256_hex "ppid-fallback" "$ppid_comm" "$ppid_start" "$boot_id"
    return $?
  fi

  # 0.48.0 codex round-8 P1: sandbox-safe fallback for environments
  # where /proc is absent AND ps + sysctl are denied (sandboxed
  # macOS runs, locked-down CI). In those environments the boot_id
  # path above fails and the function would previously return 1
  # → cache permanently disabled.
  #
  # This fallback derives the token from `(euid + REA_ROOT path)`
  # — which is broader than a process-scoped session but still
  # scoped to "this user's REA install". Cache poisoning is
  # prevented by the per-user 0700 directory + 0600 entry file
  # (another local user cannot plant entries in our cache dir).
  # Cross-install reuse is prevented by REA_ROOT being part of the
  # token AND by every cache key field below this layer encoding
  # project + CLI mtime + dist hash — a rebuild invalidates.
  #
  # This satisfies concern #2's intent: it never uses PPID alone.
  # The trade-off is a coarser "session" scope (broader than a
  # single Claude Code session) in exchange for the cache actually
  # functioning in sandboxed environments.
  local euid=""
  euid=$(id -u 2>/dev/null || true)
  if [ -n "$euid" ] && [ -n "${REA_ROOT:-}" ]; then
    _shim_cache_sha256_hex "user-project-fallback" "$euid" "$REA_ROOT"
    return $?
  fi

  # Final fallback per design §3 concern #2: cache disabled.
  # Truly hostile environment with no euid AND no REA_ROOT —
  # NEVER weaken the contract by accepting PPID alone.
  return 1
}

# -----------------------------------------------------------------------------
# Cache key derivation.
#
#   shim_cache_key SCHEMA SESSION_TOKEN PROJECT_REALPATH CLI_REALPATH \
#                  CLI_MTIME CLI_SIZE EUID ENFORCE_SHAPE SHIM_NAME \
#                  PKG_MTIME PKG_SIZE DIST_DIR_MTIME \
#                  NODE_REALPATH NODE_MTIME
#
# Echoes the 32-char hex key on success; empty + exit 1 on hash
# failure. 0.48.0 evolution:
#   - codex round-1 P1: SHIM_NAME added so the cache is hook-scoped
#     (the skipped probe `rea hook \$SHIM_NAME --help` is hook-specific)
#   - codex round-3 P1+P2: PKG_MTIME / PKG_SIZE / DIST_DIR_MTIME added
#     so an edit to the ancestor package.json (closes P2) or a rebuild
#     that touches the dist/cli/ directory (closes P1's same-session
#     rebuild gap) invalidates the entry.
#   - codex round-4 P1: NODE_REALPATH / NODE_MTIME added so a
#     same-session `nvm use` / `volta pin` / PATH-prepended wrapper
#     invalidates the entry (the warm hit would otherwise skip both
#     node-availability AND the version probe, forwarding through a
#     different interpreter).
# -----------------------------------------------------------------------------
shim_cache_key() {
  if [ "$#" -lt 14 ]; then
    return 1
  fi
  _shim_cache_sha256_hex "$@"
}

# -----------------------------------------------------------------------------
# Per-user cache directory. Echoes the path on success; empty + exit 1
# on failure. Creates the dir mode 0700 if missing; refuses to use it
# (clears the stage) if the existing mode is wider or owner is wrong.
# -----------------------------------------------------------------------------
_shim_cache_dir() {
  local euid=""
  euid=$(id -u 2>/dev/null || true)
  if [ -z "$euid" ]; then
    return 1
  fi
  local tmp="${TMPDIR:-/tmp}"
  # Strip trailing slash for predictable concatenation.
  tmp="${tmp%/}"
  local dir="$tmp/rea-shim-cache.$euid"
  if [ -d "$dir" ]; then
    # Owner + mode check.
    local owner=""
    local mode=""
    if [ "$(uname -s 2>/dev/null || echo)" = "Darwin" ]; then
      owner=$(stat -f "%u" "$dir" 2>/dev/null || true)
      mode=$(stat -f "%Mp%Lp" "$dir" 2>/dev/null || true)
    else
      owner=$(stat -c "%u" "$dir" 2>/dev/null || true)
      mode=$(stat -c "%a" "$dir" 2>/dev/null || true)
    fi
    if [ "$owner" != "$euid" ]; then
      # Foreign-owned dir — refuse, do not clobber.
      return 1
    fi
    # Mode comparison: GNU prints "700"; macOS %Mp%Lp prints "40700"
    # (file-type + perms). We accept either by checking the last 3
    # digits.
    local last3="${mode: -3}"
    if [ "$last3" != "700" ]; then
      return 1
    fi
  else
    # Create with 0700 via umask + mkdir.
    local old_umask
    old_umask=$(umask)
    umask 077
    mkdir -p "$dir" 2>/dev/null || { umask "$old_umask"; return 1; }
    umask "$old_umask"
    # Defensive chmod in case mkdir ignored the umask (some FS layers do).
    chmod 0700 "$dir" 2>/dev/null || true
  fi
  printf '%s' "$dir"
}

# -----------------------------------------------------------------------------
# Read a cache entry. Args: key. Echoes the JSON content on hit
# (single line); exit 0 on hit, 1 on miss/error.
# -----------------------------------------------------------------------------
shim_cache_read() {
  local key="$1"
  if [ -z "$key" ]; then
    return 1
  fi
  local dir=""
  dir=$(_shim_cache_dir) || return 1
  local file="$dir/$key.json"
  if [ ! -f "$file" ]; then
    return 1
  fi
  # Owner + mode check on the file.
  local euid=""
  euid=$(id -u 2>/dev/null || true)
  local owner=""
  local mode=""
  if [ "$(uname -s 2>/dev/null || echo)" = "Darwin" ]; then
    owner=$(stat -f "%u" "$file" 2>/dev/null || true)
    mode=$(stat -f "%Mp%Lp" "$file" 2>/dev/null || true)
  else
    owner=$(stat -c "%u" "$file" 2>/dev/null || true)
    mode=$(stat -c "%a" "$file" 2>/dev/null || true)
  fi
  if [ "$owner" != "$euid" ]; then
    return 1
  fi
  local last3="${mode: -3}"
  if [ "$last3" != "600" ]; then
    return 1
  fi
  local content=""
  content=$(cat "$file" 2>/dev/null || true)
  if [ -z "$content" ]; then
    return 1
  fi
  printf '%s' "$content"
  return 0
}

# -----------------------------------------------------------------------------
# Write a cache entry atomically. Args: key, json_content. Returns 0 on
# success, 1 on any error. Callers IGNORE the return value — cache
# write failure NEVER blocks the gate.
# -----------------------------------------------------------------------------
shim_cache_write() {
  local key="$1"
  local content="$2"
  if [ -z "$key" ] || [ -z "$content" ]; then
    return 1
  fi
  local dir=""
  dir=$(_shim_cache_dir) || return 1
  local final="$dir/$key.json"
  local tmp="$dir/$key.tmp.$$"
  local old_umask
  old_umask=$(umask)
  umask 077
  # Write to tmp, then atomic rename.
  printf '%s\n' "$content" > "$tmp" 2>/dev/null || {
    umask "$old_umask"
    rm -f "$tmp" 2>/dev/null || true
    return 1
  }
  chmod 0600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$final" 2>/dev/null || {
    umask "$old_umask"
    rm -f "$tmp" 2>/dev/null || true
    return 1
  }
  umask "$old_umask"
  return 0
}

# -----------------------------------------------------------------------------
# Export portable stat helper for shim-runtime callers.
# -----------------------------------------------------------------------------
shim_cache_mtime_size() {
  _shim_cache_stat_mtime_size "$1"
}
