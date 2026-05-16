#!/bin/bash
# hooks/_lib/policy-reader.sh — unified 4-tier policy reader for shims.
# Introduced 0.37.0.
#
# Source via:
#   source "$(dirname "$0")/_lib/policy-reader.sh"
#
# # Problem this solves
#
# Across releases 0.34.0 / 0.35.0 the shims acquired ad-hoc per-shim
# YAML parsers (awk programs) used ONLY when the rea CLI is
# unreachable (fresh / unbuilt install, sandbox failure, etc). Each
# parser was block-form-only. The canonical TS loader in
# src/policy/loader.ts accepts BOTH block-form AND flow-form YAML
# (e.g. `local_review: { mode: off }` or `blocked_paths: [.env, ...]`).
# Silent split-brain: a consumer with a flow-form policy + missing CLI
# silently skipped the gate.
#
# # Ladder
#
# This helper consolidates the per-shim parsers into a 4-tier
# graceful-degradation ladder:
#
#   Tier 1 — `rea hook policy-get` (canonical, validated TS loader).
#            Handles BOTH block AND flow form identically. Source of
#            truth. Tried first when the caller has populated
#            `REA_ARGV` (the same 2-tier sandboxed CLI resolution
#            shims already do up top).
#
#   Tier 2 — python3 with stdlib + PyYAML. Falls back when the CLI is
#            unreachable. Handles BOTH block AND flow form.
#            Mirrors the pattern proven in `.husky/prepare-commit-msg`
#            (0.30.0 attribution augmenter).
#
#   Tier 3 — awk block-form parser. Last-resort, no-dep fallback.
#            Block-form ONLY (the same limitation as the pre-0.37.0
#            per-shim parsers). Used when both Tier 1 and Tier 2 are
#            unavailable.
#
#   Tier 4 — fail. Function returns 1; stdout is empty. The shim
#            decides how to handle (blocking-tier hooks fail closed;
#            advisory-tier hooks fall open).
#
# # Caller usage
#
# Callers set `REA_ARGV` to the resolved rea CLI invocation (empty
# array when the CLI was unreachable / failed sandbox). The helper
# uses that array to invoke Tier 1; when empty it skips Tier 1.
#
# Scalar read:
#   value=$(policy_reader_get "review.local_review.mode")
#   # stdout: the scalar value (empty when unset)
#   # exit:   0 = ok (even when empty), 1 = unreadable (all tiers failed)
#
# Subtree read (one call → all leaves cached for jq):
#   policy_reader_get_subtree_json "review.local_review"
#   # stdout: JSON of the subtree (e.g. `{"mode":"off","refuse_at":"both"}`)
#   #         or `null` when path unset.
#   # exit:   0 = ok, 1 = unreadable.
#
# List read:
#   while IFS= read -r entry; do ...; done < <(policy_reader_get_list "blocked_paths")
#   # stdout: one entry per line (empty list → no lines)
#   # exit:   0 = ok, 1 = unreadable.
#
# # Force-tier mode (testing)
#
#   POLICY_READER_FORCE_TIER=cli      # only Tier 1
#   POLICY_READER_FORCE_TIER=python3  # only Tier 2
#   POLICY_READER_FORCE_TIER=awk      # only Tier 3
#   POLICY_READER_FORCE_TIER=none     # skip all tiers; force exit 1
#
# # Cache
#
# The first Tier-1 / Tier-2 call resolves the policy file ONCE as JSON
# (the entire document), caches it in `_REA_POLICY_FULL_JSON`, and all
# subsequent calls read leaves from the cache via jq. This mirrors the
# 0.34.0 `_lrg_subtree_json` pattern but extends it to the whole
# document — so a hook that reads 5 keys pays ONE node-spawn cost.
# Tier 3 (awk) is parsed per-call (no JSON intermediate; block-form
# only).
#
# Cache key invalidation is by hook invocation: each `source` of this
# file resets the cache (shells DO re-source on each hook fire because
# Claude Code spawns a fresh bash per event).

# Do NOT set `-e` — sourced library, propagates to callers. See
# hooks/_lib/halt-check.sh for rationale.
set -uo pipefail

# Resolve the project root (REA_ROOT) and policy file path. Mirrors
# the logic in `policy-read.sh::policy_path`.
_pr_policy_path() {
  local root="${REA_ROOT:-}"
  if [ -z "$root" ]; then
    if command -v rea_root >/dev/null 2>&1; then
      root=$(rea_root)
    else
      root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
    fi
  fi
  local policy="${root}/.rea/policy.yaml"
  if [ -f "$policy" ]; then
    printf '%s' "$policy"
  fi
}

# Cache the entire policy doc as JSON on first read. `_REA_POLICY_FULL_JSON`
# is "" until first read, then "null" or a JSON document body. The
# `_REA_POLICY_LOADED` flag distinguishes "not loaded" from "loaded
# and unreadable".
#
#   _REA_POLICY_LOADED=0  — not yet attempted
#   _REA_POLICY_LOADED=1  — attempted, succeeded (JSON in _REA_POLICY_FULL_JSON)
#   _REA_POLICY_LOADED=2  — attempted, failed all loadable tiers (Tier 3 awk
#                           still available for block-form leaf reads)
_REA_POLICY_FULL_JSON=""
_REA_POLICY_LOADED=0
_REA_POLICY_LOADED_TIER=""  # informational: "cli" | "python3" | "" (unset / awk fallback)

# Tier 1 — CLI. Reads the WHOLE document as JSON via the empty-key
# trick: `rea hook policy-get --json` doesn't accept an empty key
# (validation rejects it), so we request a known top-level key
# (`profile`) just to confirm reachability, then walk the document
# tier-by-tier via the helper. Actually, a cleaner approach is to use
# `--json` on the deepest key the caller actually asked for — but
# subtree mode wants different roots. So instead, we load the FULL
# document once via a tiny in-process node invocation that uses the
# already-resolved REA_ARGV CLI to parse policy.yaml.
#
# Implementation: ask the CLI for a known top-level key (`version`)
# with `--json` to verify reachability, but DON'T use that as the
# cache. Instead, when the CLI is reachable, ask it for ".raw" via a
# tiny node program that reads the policy file directly and emits
# YAML→JSON. Wait — that's a second binary. Simpler approach:
#
#   For CLI tier: invoke `rea hook policy-get <key> --json` per-call,
#   but cache the result keyed by the requested subtree/leaf. The
#   3×-spawn cost across leaves matters; we mitigate by encouraging
#   callers to use `policy_reader_get_subtree_json` and parse with jq.
#   This matches the existing local-review-gate.sh pattern.
#
# For Tier 2 (python3): load the ENTIRE document as JSON in one
# python invocation, cache forever. Any subsequent get is a jq query
# on the cached JSON — no second python spawn.
#
# Tier 3 awk does not produce JSON; it returns per-key scalars. The
# subtree mode cannot be served by Tier 3 — it returns exit 1 unless
# a tier above produced JSON.

# Load the full document JSON via Tier 1 or Tier 2. Sets the cache
# vars. Idempotent; subsequent calls are a fast-path return.
_pr_load_full_json() {
  if [ "$_REA_POLICY_LOADED" != "0" ]; then
    return 0
  fi
  local policy
  policy=$(_pr_policy_path)
  if [ -z "$policy" ]; then
    _REA_POLICY_LOADED=2
    return 0
  fi

  local force="${POLICY_READER_FORCE_TIER:-}"

  # ---- Tier 1: rea CLI ----
  # We use `rea hook policy-get` to read a SINGLE marker key with
  # `--json` to confirm reachability and shape. The CLI cannot emit
  # the whole document at once (no `--full` subcommand), but it CAN
  # emit any subtree as JSON. For the cache we read `--json` on the
  # ROOT-LIKE keys that callers actually use; per-call. So the Tier 1
  # path is "directly answer each policy_reader_get_* call via a fresh
  # CLI invocation" — see _pr_tier1_get below.
  #
  # We still record reachability HERE so later calls don't re-probe.
  if [ "$force" = "" ] || [ "$force" = "cli" ]; then
    if [ -n "${REA_ARGV+x}" ] && [ "${#REA_ARGV[@]}" -gt 0 ]; then
      # Probe with a known key. `version` is always present in a
      # validated policy. Use `--json` so we can tell parse-success
      # from key-missing (the value `null` would mean unset top-level
      # key, which would itself be a bug; we just need exit 0 + a
      # non-empty stdout).
      local probe
      probe=$("${REA_ARGV[@]}" hook policy-get version --json 2>/dev/null) || probe=""
      if [ -n "$probe" ]; then
        _REA_POLICY_LOADED=1
        _REA_POLICY_LOADED_TIER="cli"
        return 0
      fi
    fi
    if [ "$force" = "cli" ]; then
      _REA_POLICY_LOADED=2
      return 0
    fi
  fi

  # ---- Tier 2: python3 with PyYAML ----
  if [ "$force" = "" ] || [ "$force" = "python3" ]; then
    if command -v python3 >/dev/null 2>&1; then
      local json
      # The python program tries to import `yaml` (PyYAML). If absent,
      # it exits non-zero and we fall through to Tier 3. If present,
      # it loads the whole document and emits JSON on stdout.
      #
      # Codex round 2 P1 + round 3 P2 (2026-05-16): isolate the
      # interpreter from repo-local imports. Without protection,
      # Python prepends the project CWD to `sys.path[0]` when reading
      # the program from stdin (`-`), so a malicious repo that ships
      # `yaml.py` or `json.py` would have it imported BEFORE the
      # stdlib copy — turning every policy lookup into arbitrary code
      # execution.
      #
      # Layered defense:
      #   1. `env -u PYTHONPATH -u PYTHONHOME -u PYTHONSTARTUP` —
      #      explicitly remove the env vars an attacker could use to
      #      inject a search path or startup hook BEFORE we ever
      #      invoke python3. Round 3 P2: PYTHONSAFEPATH only blocks
      #      the script-directory and cwd prepend; absolute paths
      #      injected via PYTHONPATH survive. Unsetting closes that
      #      hole. PYTHONHOME and PYTHONSTARTUP are unset for the
      #      same family of reasons (alternate stdlib root, code-on-
      #      startup hook).
      #   2. PYTHONSAFEPATH=1 (env-var form of `-P`, Python 3.11+) —
      #      tells the interpreter NOT to prepend the script's
      #      directory / cwd to sys.path.
      #   3. Manual sys.path scrub at the top of the program (any
      #      Python version) — removes "", ".", and cwd entries that
      #      may have slipped through on older interpreters where
      #      PYTHONSAFEPATH is silently ignored (3.10 and earlier).
      #
      # We deliberately do NOT use `-I` ("isolated mode") here even
      # though it implies `-P` on 3.11+. `-I` also removes user
      # site-packages (`~/.local/lib/...`), which on many macOS /
      # Linux developer machines is where PyYAML lives. `-I` would
      # turn a working Tier 2 into a Tier 3 fall-through for the
      # majority of real installs. The env-scrub + PYTHONSAFEPATH +
      # sys.path scrub combination achieves the same security
      # guarantee without breaking the import path for PyYAML.
      json=$(env -u PYTHONPATH -u PYTHONHOME -u PYTHONSTARTUP \
        PYTHONSAFEPATH=1 python3 - "$policy" <<'PY' 2>/dev/null
# Tier 2 — load policy.yaml via PyYAML and emit JSON.
#
# IMPORTANT: the canonical TS loader uses the `yaml` npm package which
# defaults to YAML 1.2 semantics. YAML 1.2 dropped the
# `on`/`off`/`yes`/`no` boolean aliases that YAML 1.1 (PyYAML's
# default) still coerces. A consumer policy with
# `local_review: { mode: off }` should be the STRING `"off"` (matching
# the CLI), not Python's `False`.
#
# Use PyYAML's resolver in 1.2 mode by clearing the bool resolver
# aliases. This preserves `true`/`false` booleans while leaving
# `on`/`off`/`yes`/`no` as strings — exactly matching the TS loader.
import sys
import os

# Codex round 2 P1: defensive sys.path scrub for Python 3.4-3.10 where
# `-I` doesn't include `-P` semantics. Remove any entry that is empty
# (""), "." or the project CWD. These are the entries Python adds
# automatically when reading from stdin; on the target Python version
# (3.11+) `-I`/PYTHONSAFEPATH already removes them, but on older
# interpreters we must do it manually.
_cwd = os.getcwd()
_cwd_real = os.path.realpath(_cwd)
sys.path[:] = [
    p for p in sys.path
    if p not in ("", ".", _cwd, _cwd_real)
]

import json
try:
    import yaml
except Exception:
    sys.exit(2)

class _Yaml12Loader(yaml.SafeLoader):
    """SafeLoader with YAML-1.2-style booleans (only true/false)."""

# Replace the bool resolver with one that only matches `true|false`
# (case-insensitive). PyYAML's default also matches yes/no/on/off.
_Yaml12Loader.yaml_implicit_resolvers = {
    k: [(tag, regexp) for tag, regexp in v if tag != 'tag:yaml.org,2002:bool']
    for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
import re as _re
_bool_re = _re.compile(r'^(?:true|True|TRUE|false|False|FALSE)$')
_Yaml12Loader.add_implicit_resolver(
    'tag:yaml.org,2002:bool',
    _bool_re,
    list('tTfF'),
)

path = sys.argv[1]
try:
    with open(path, 'r', encoding='utf-8') as fh:
        doc = yaml.load(fh, Loader=_Yaml12Loader)
except Exception:
    sys.exit(3)
try:
    json.dump(doc, sys.stdout, ensure_ascii=False)
except Exception:
    sys.exit(4)
PY
)
      if [ -n "$json" ]; then
        _REA_POLICY_FULL_JSON="$json"
        _REA_POLICY_LOADED=1
        _REA_POLICY_LOADED_TIER="python3"
        return 0
      fi
    fi
    if [ "$force" = "python3" ]; then
      _REA_POLICY_LOADED=2
      return 0
    fi
  fi

  # ---- Tier 3: awk (block-form only) — cannot produce JSON, so the
  # subtree cache stays empty. Per-call awk reads in _pr_tier3_* still
  # work for scalar/list reads. ----
  _REA_POLICY_LOADED=2
  return 0
}

# Walk a dotted path through a JSON document and emit either the
# scalar value (no surrounding quotes) or, in --json mode, the JSON
# form of the leaf. Uses jq when available; falls back to a python3
# one-liner when jq is absent but python3 is on PATH.
#
# Codex round 2 P2 (2026-05-16): the pre-round-2 implementation
# returned exit 0 with empty stdout when jq was missing, silently
# dropping flow-form policy lookups on python3-but-no-jq systems
# (a normal shape — PyYAML is widely installed, jq is not). The
# Tier 3 awk fallback only handles block-form, so a consumer with
# `local_review: { mode: off }` and no jq would silently lose
# inline-form parsing. The python3 fallback below reads the same
# cached JSON the helper already produced, so no new YAML parsing
# happens — just JSON walking.
#
# Args: $1 = JSON doc, $2 = dotted key, $3 = "scalar"|"json"
# Stdout: the value (empty if missing); exit 0.
_pr_jq_walk() {
  local doc="$1"
  local key="$2"
  local mode="$3"
  # `POLICY_READER_DISABLE_JQ=1` forces the no-jq fallback path even
  # when jq is on PATH. Used by the test suite to exercise the python3
  # walker on CI runners where jq is universally installed (Apple
  # ships jq in /usr/bin).
  if [ "${POLICY_READER_DISABLE_JQ:-0}" != "1" ] && command -v jq >/dev/null 2>&1; then
    # Build a jq getpath query from the dotted key.
    # `policy_reader_get` validates the key shape upstream; here we just
    # split on `.` and pass as an array.
    local jq_path
    jq_path=$(printf '%s' "$key" | awk -F'.' '{
      out="["
      for (i=1; i<=NF; i++) {
        if (i>1) out=out","
        gsub(/"/, "\\\"", $i)
        out=out"\""$i"\""
      }
      out=out"]"
      print out
    }')
    if [ "$mode" = "json" ]; then
      printf '%s' "$doc" | jq -c --argjson p "$jq_path" 'getpath($p)' 2>/dev/null
    else
      # Scalar mode: emit primitives as their string form, objects/arrays
      # as empty (caller treats as unset).
      printf '%s' "$doc" | jq -r --argjson p "$jq_path" '
        getpath($p) as $v
        | if $v == null then empty
          elif ($v|type) == "string" or ($v|type) == "number" or ($v|type) == "boolean"
            then $v | tostring
          else empty
          end
      ' 2>/dev/null
    fi
    return 0
  fi
  # jq absent — use python3 to walk the cached JSON. The doc was
  # already produced by python3 (Tier 2 loader); we know python3 is
  # reachable. We guard with command -v anyway in case the environment
  # changed between calls.
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  # The key shape is already validated by the public entry points
  # (`policy_reader_get*`) to contain only `[A-Za-z0-9_.]`. We pass it
  # AND the JSON doc as argv (not embedded in the program text) so
  # neither can break out of the string literal. Two-redirect heredocs
  # don't compose reliably across bash versions, so use argv for the
  # JSON payload rather than stdin.
  #
  # Codex round 2 P1 + round 3 P2 hardening: env scrub +
  # PYTHONSAFEPATH=1 + sys.path scrub prevent repo-local `json.py` /
  # shadow stdlib modules from being imported, regardless of whether
  # they're injected via cwd, script-dir, or PYTHONPATH/PYTHONHOME.
  # See the Tier 2 loader above for the full rationale (and why `-I`
  # isolated mode is intentionally NOT used — it would additionally
  # drop user site-packages where PyYAML often lives).
  env -u PYTHONPATH -u PYTHONHOME -u PYTHONSTARTUP \
    PYTHONSAFEPATH=1 python3 -c '
import sys
import os
# Defensive sys.path scrub for Python 3.4-3.10 (-P semantics).
_cwd = os.getcwd()
_cwd_real = os.path.realpath(_cwd)
sys.path[:] = [
    p for p in sys.path
    if p not in ("", ".", _cwd, _cwd_real)
]
import json

# argv[1]: the JSON doc
# argv[2]: dotted key (validated to [A-Za-z0-9_.])
# argv[3]: "scalar" | "json"
try:
    doc = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
key = sys.argv[2]
mode = sys.argv[3]

segments = key.split(".")
cur = doc
for seg in segments:
    if isinstance(cur, dict) and seg in cur:
        cur = cur[seg]
    else:
        cur = None
        break

if mode == "json":
    if cur is None:
        sys.stdout.write("null")
    else:
        json.dump(cur, sys.stdout, ensure_ascii=False, separators=(",", ":"))
else:
    # Scalar mode — primitives only.
    if cur is None:
        sys.exit(0)
    if isinstance(cur, bool):
        sys.stdout.write("true" if cur else "false")
    elif isinstance(cur, (int, float, str)):
        sys.stdout.write(str(cur))
    # Object/array: empty stdout (caller treats as unset).
' "$doc" "$key" "$mode" 2>/dev/null
  return 0
}

# Tier 1 (per-call): invoke `rea hook policy-get KEY [--json]` directly.
# Used when _REA_POLICY_LOADED_TIER="cli" — Tier 2 cache is empty so we
# must shell out per leaf. Cached per-key in the helper's own kv store.
#
# We store the cache in two parallel arrays-of-keys/values (bash 3.2
# has no associative arrays). Capacity is small (handful of policy
# reads per hook) so linear scan is fine.
_REA_POLICY_KV_KEYS=()
_REA_POLICY_KV_VALS=()

_pr_kv_get() {
  local key="$1"
  local i=0
  local n="${#_REA_POLICY_KV_KEYS[@]}"
  while [ "$i" -lt "$n" ]; do
    if [ "${_REA_POLICY_KV_KEYS[$i]}" = "$key" ]; then
      printf '%s' "${_REA_POLICY_KV_VALS[$i]}"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

_pr_kv_set() {
  local key="$1"
  local val="$2"
  _REA_POLICY_KV_KEYS+=("$key")
  _REA_POLICY_KV_VALS+=("$val")
}

# Tier 1 per-call CLI read. Returns 0 + writes value (possibly empty)
# on success; returns 1 when the CLI fails or wasn't probe-good.
_pr_tier1_get() {
  local key="$1"
  local mode="$2"   # "scalar" | "json"
  if [ "$_REA_POLICY_LOADED_TIER" != "cli" ]; then
    return 1
  fi
  if [ "${#REA_ARGV[@]}" -eq 0 ]; then
    return 1
  fi
  local cache_key="$mode:$key"
  local cached
  if cached=$(_pr_kv_get "$cache_key"); then
    printf '%s' "$cached"
    return 0
  fi
  local out
  local rc
  if [ "$mode" = "json" ]; then
    out=$("${REA_ARGV[@]}" hook policy-get "$key" --json 2>/dev/null)
    rc=$?
  else
    out=$("${REA_ARGV[@]}" hook policy-get "$key" 2>/dev/null)
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    return 1
  fi
  # Cache empty results too (they mean "unset" — same as a non-empty
  # cached value).
  _pr_kv_set "$cache_key" "$out"
  printf '%s' "$out"
  return 0
}

# Tier 2 — read from the cached full-doc JSON. Uses jq when available;
# `_pr_jq_walk` transparently falls back to a python3 one-liner when
# jq is absent. Codex round 2 P2: pre-round-2 this function returned
# exit 1 when jq was missing, falling through to Tier 3 (awk) which
# only handles block-form — silently losing inline-form parsing on
# python3-but-no-jq systems.
_pr_tier2_get() {
  local key="$1"
  local mode="$2"
  if [ "$_REA_POLICY_LOADED_TIER" != "python3" ]; then
    return 1
  fi
  if [ -z "$_REA_POLICY_FULL_JSON" ] || [ "$_REA_POLICY_FULL_JSON" = "null" ]; then
    # Policy parsed to null (empty file) — every key is unset. Return
    # success with empty stdout for scalar; `null` for json.
    if [ "$mode" = "json" ]; then
      printf 'null'
    fi
    return 0
  fi
  _pr_jq_walk "$_REA_POLICY_FULL_JSON" "$key" "$mode"
  return 0
}

# Tier 3 — awk block-form scalar reader.
#
# Supports 1-, 2-, and 3-segment dotted keys. Inline-form mappings are
# silently missed (documented Tier 3 limitation; Tier 1 / Tier 2 cover
# the inline cases).
#
# Returns 0 + (possibly empty) stdout when the parse succeeds (even
# when key is unset). Returns 1 only when the policy file is missing
# or awk isn't available.
_pr_tier3_get_scalar() {
  local key="$1"
  local policy
  policy=$(_pr_policy_path)
  if [ -z "$policy" ] || ! command -v awk >/dev/null 2>&1; then
    return 1
  fi
  # Split the dotted key.
  local IFS_BACKUP="$IFS"
  IFS='.'
  # shellcheck disable=SC2086
  set -- $key
  IFS="$IFS_BACKUP"
  local n=$#
  case "$n" in
    1)
      _pr_tier3_top_scalar "$1" "$policy"
      ;;
    2)
      _pr_tier3_nested_scalar "$1" "$2" "" "$policy"
      ;;
    3)
      _pr_tier3_nested_scalar "$1" "$2" "$3" "$policy"
      ;;
    *)
      # >3 segments — not supported by Tier 3 (no real-world hook
      # reads deeper than 3). Caller should rely on Tier 1 / Tier 2.
      return 0
      ;;
  esac
  return 0
}

# Top-level scalar (e.g. `block_ai_attribution`).
_pr_tier3_top_scalar() {
  local key="$1"
  local policy="$2"
  awk -v k="$key" '
    BEGIN { pat_obj = "^" k ":[[:space:]]*$"; pat_val = "^" k ":[[:space:]]+" }
    /^[[:space:]]*#/ { next }
    match($0, pat_val) {
      val = $0
      sub(pat_val, "", val)
      sub(/[[:space:]]+#.*$/, "", val)
      gsub(/^["'\'']|["'\'']$/, "", val)
      printf "%s", val
      exit 0
    }
  ' "$policy"
}

# Nested scalar — same shape as policy-read.sh::_rea_awk_nested_scalar,
# extended to handle a 2-segment query (child only, no grandchild).
# When grandchild is empty, the inner key is matched directly under
# the top-level parent.
_pr_tier3_nested_scalar() {
  local parent="$1"
  local child="$2"
  local grandchild="$3"
  local policy="$4"
  awk -v parent="$parent" -v child="$child" -v grandchild="$grandchild" '
    function indent_of(line,    n, c) {
      n = 0
      while (n < length(line)) {
        c = substr(line, n + 1, 1)
        if (c == " " || c == "\t") n++
        else break
      }
      return n
    }
    BEGIN { in_parent = 0; parent_indent = -1; in_child = 0; child_indent = -1 }
    /^[[:space:]]*#/ { next }
    {
      ind = indent_of($0)
      stripped = $0
      sub(/^[[:space:]]+/, "", stripped)
      if (!in_parent && stripped ~ ("^" parent ":[[:space:]]*$") && ind == 0) {
        in_parent = 1
        parent_indent = 0
        next
      }
      if (in_parent && ind <= parent_indent && stripped != "") {
        in_parent = 0
        in_child = 0
      }
      # Grandchild mode: descend one more level.
      if (grandchild != "") {
        if (in_parent && !in_child && stripped ~ ("^" child ":[[:space:]]*$") && ind > parent_indent) {
          in_child = 1
          child_indent = ind
          next
        }
        if (in_child && ind <= child_indent && stripped != "") {
          in_child = 0
        }
        if (in_child && match(stripped, ("^" grandchild ":[[:space:]]+"))) {
          val = stripped
          sub(("^" grandchild ":[[:space:]]+"), "", val)
          sub(/[[:space:]]+#.*$/, "", val)
          gsub(/^["'\'']|["'\'']$/, "", val)
          printf "%s", val
          exit 0
        }
      } else {
        # 2-segment: child is the leaf.
        if (in_parent && match(stripped, ("^" child ":[[:space:]]+"))) {
          val = stripped
          sub(("^" child ":[[:space:]]+"), "", val)
          sub(/[[:space:]]+#.*$/, "", val)
          gsub(/^["'\'']|["'\'']$/, "", val)
          printf "%s", val
          exit 0
        }
      }
    }
  ' "$policy"
}

# Tier 3 list reader — block-form sequence under a top-level key.
# Used for `blocked_paths`, `protected_writes`, etc. Inline-form arrays
# would be missed; the caller should rely on Tier 1 or Tier 2 for those.
_pr_tier3_get_list() {
  local key="$1"
  local policy
  policy=$(_pr_policy_path)
  if [ -z "$policy" ] || ! command -v awk >/dev/null 2>&1; then
    return 1
  fi
  # Only top-level lists are supported by Tier 3 (the existing
  # per-shim awk parsers were also top-level-only). Reject dotted keys.
  case "$key" in
    *.*) return 0 ;;
  esac
  awk -v key="$key" '
    /^[^[:space:]]/ { in_block=0 }
    $0 ~ ("^" key ":[[:space:]]*$") { in_block=1; next }
    in_block && /^[[:space:]]*-[[:space:]]/ {
      val = $0
      sub(/^[[:space:]]*-[[:space:]]*/, "", val)
      sub(/[[:space:]]+#.*$/, "", val)
      gsub(/^["'\'']|["'\'']$/, "", val)
      print val
    }
  ' "$policy"
  return 0
}

# Public: read a scalar policy value at a dotted key.
# Stdout: the value (empty when unset). Exit: 0 = ok, 1 = unreadable.
policy_reader_get() {
  local key="$1"
  # Validate key shape (POSIX identifiers separated by dots).
  case "$key" in
    "" | *[!A-Za-z0-9_.]* )
      return 1 ;;
  esac
  case "$key" in
    .* | *. | *..* )
      return 1 ;;
  esac

  local force="${POLICY_READER_FORCE_TIER:-}"
  if [ "$force" = "none" ]; then
    return 1
  fi

  _pr_load_full_json

  # Tier 1 if reachable.
  if [ "$force" = "" ] || [ "$force" = "cli" ]; then
    local v
    if v=$(_pr_tier1_get "$key" "scalar"); then
      printf '%s' "$v"
      return 0
    fi
    if [ "$force" = "cli" ]; then
      return 1
    fi
  fi

  # Tier 2 if cached.
  if [ "$force" = "" ] || [ "$force" = "python3" ]; then
    local v
    if v=$(_pr_tier2_get "$key" "scalar"); then
      printf '%s' "$v"
      return 0
    fi
    if [ "$force" = "python3" ]; then
      return 1
    fi
  fi

  # Tier 3 awk (block-form only).
  if [ "$force" = "" ] || [ "$force" = "awk" ]; then
    if _pr_tier3_get_scalar "$key"; then
      return 0
    fi
  fi

  # All tiers failed.
  return 1
}

# Public: read a subtree as JSON. Useful when a hook needs multiple
# leaves under the same parent — fetches all at once via the cached
# Tier 2 JSON, or via a single Tier 1 `--json` call when only the CLI
# is available. Tier 3 cannot serve subtree reads (returns 1).
#
# Stdout: JSON form of the subtree (`null` if unset).
# Exit: 0 = ok, 1 = unreadable.
policy_reader_get_subtree_json() {
  local key="$1"
  case "$key" in
    "" | *[!A-Za-z0-9_.]* )
      return 1 ;;
  esac
  case "$key" in
    .* | *. | *..* )
      return 1 ;;
  esac

  local force="${POLICY_READER_FORCE_TIER:-}"
  if [ "$force" = "none" ]; then
    return 1
  fi

  _pr_load_full_json

  if [ "$force" = "" ] || [ "$force" = "cli" ]; then
    local v
    if v=$(_pr_tier1_get "$key" "json"); then
      # Tier 1 CLI returns `null` for unset; both are valid.
      [ -z "$v" ] && v="null"
      printf '%s' "$v"
      return 0
    fi
    if [ "$force" = "cli" ]; then
      return 1
    fi
  fi

  if [ "$force" = "" ] || [ "$force" = "python3" ]; then
    local v
    if v=$(_pr_tier2_get "$key" "json"); then
      [ -z "$v" ] && v="null"
      printf '%s' "$v"
      return 0
    fi
    if [ "$force" = "python3" ]; then
      return 1
    fi
  fi

  # Tier 3 cannot serve subtree JSON.
  return 1
}

# Public: read a top-level list of scalars (e.g. blocked_paths). Emits
# one entry per line on stdout. Supports flow-form arrays via Tier 1 /
# Tier 2; Tier 3 only handles block-form.
#
# Exit: 0 = ok (even when empty), 1 = unreadable.
policy_reader_get_list() {
  local key="$1"
  case "$key" in
    "" | *[!A-Za-z0-9_.]* )
      return 1 ;;
  esac
  case "$key" in
    .* | *. | *..* )
      return 1 ;;
  esac

  local force="${POLICY_READER_FORCE_TIER:-}"
  if [ "$force" = "none" ]; then
    return 1
  fi

  _pr_load_full_json

  # Tier 1 / Tier 2 via JSON + jq.
  local json=""
  local source_tier=""
  if [ "$force" = "" ] || [ "$force" = "cli" ]; then
    if [ "$_REA_POLICY_LOADED_TIER" = "cli" ]; then
      if json=$(_pr_tier1_get "$key" "json"); then
        source_tier="cli"
      fi
    fi
    if [ "$force" = "cli" ] && [ -z "$source_tier" ]; then
      return 1
    fi
  fi
  if [ -z "$source_tier" ] && { [ "$force" = "" ] || [ "$force" = "python3" ]; }; then
    if [ "$_REA_POLICY_LOADED_TIER" = "python3" ]; then
      if json=$(_pr_tier2_get "$key" "json"); then
        source_tier="python3"
      fi
    fi
    if [ "$force" = "python3" ] && [ -z "$source_tier" ]; then
      return 1
    fi
  fi
  if [ -n "$source_tier" ]; then
    # Emit each array element as a line. Non-array (null / scalar /
    # object) → empty output, exit 0.
    if [ -z "$json" ] || [ "$json" = "null" ]; then
      return 0
    fi
    # `POLICY_READER_DISABLE_JQ=1` forces the no-jq fallback path
    # even when jq is on PATH — see _pr_jq_walk for rationale.
    if [ "${POLICY_READER_DISABLE_JQ:-0}" != "1" ] && command -v jq >/dev/null 2>&1; then
      printf '%s' "$json" | jq -r '
        if type == "array" then
          .[] | tostring
        else
          empty
        end
      ' 2>/dev/null
      return 0
    fi
    # Codex round 2 P2 (2026-05-16): jq absent but Tier 1/2 produced
    # JSON — iterate via python3 rather than falling through to Tier 3
    # (which only handles block-form lists and would silently miss
    # flow-form `blocked_paths: [.env, ...]`). The JSON payload is
    # passed as argv so a malicious value cannot inject code; argv
    # length on every modern OS comfortably accommodates policy.yaml
    # contents (kilobytes, not megabytes).
    #
    # Codex round 2 P1 + round 3 P2 hardening: env scrub +
    # PYTHONSAFEPATH=1 + sys.path scrub — see _pr_jq_walk / Tier 2
    # loader for full rationale (and why `-I` isolated mode is
    # intentionally NOT used).
    if command -v python3 >/dev/null 2>&1; then
      env -u PYTHONPATH -u PYTHONHOME -u PYTHONSTARTUP \
        PYTHONSAFEPATH=1 python3 -c '
import sys
import os
_cwd = os.getcwd()
_cwd_real = os.path.realpath(_cwd)
sys.path[:] = [
    p for p in sys.path
    if p not in ("", ".", _cwd, _cwd_real)
]
import json
try:
    doc = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
if isinstance(doc, list):
    for item in doc:
        if isinstance(item, bool):
            sys.stdout.write("true\n" if item else "false\n")
        elif isinstance(item, (int, float, str)):
            sys.stdout.write(str(item) + "\n")
        # Skip non-primitives — matches jq `.[] | tostring` posture
        # for object/array elements (they would render as JSON-string
        # repr under jq; the consumers only use primitive lists).
' "$json" 2>/dev/null
      return 0
    fi
    # Neither jq nor python3 reachable for list iteration. Fall through
    # to Tier 3 (block-form awk parser).
  fi

  # Tier 3 awk (block-form only).
  if [ "$force" = "" ] || [ "$force" = "awk" ]; then
    if _pr_tier3_get_list "$key"; then
      return 0
    fi
  fi

  return 1
}

# Public: which tier was used for the last load? Returns "cli",
# "python3", "awk", or "" (none reached). Useful for diagnostics and
# tests.
policy_reader_loaded_tier() {
  if [ "$_REA_POLICY_LOADED" = "0" ]; then
    _pr_load_full_json
  fi
  if [ -n "$_REA_POLICY_LOADED_TIER" ]; then
    printf '%s' "$_REA_POLICY_LOADED_TIER"
    return 0
  fi
  # If we reached the awk fallback the loader recorded
  # _REA_POLICY_LOADED=2 with no tier. We can't pre-validate awk
  # availability without trying it; report "awk" optimistically when
  # awk is on PATH and the policy file exists.
  local policy
  policy=$(_pr_policy_path)
  if [ -n "$policy" ] && command -v awk >/dev/null 2>&1; then
    printf 'awk'
    return 0
  fi
  return 1
}
