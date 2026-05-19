# shellcheck shell=bash
# hooks/_lib/bootstrap-allowlist.sh — bootstrap allowlist for the
# Bash-tier protected-paths / blocked-paths gate shims.
# Introduced 0.49.0.
#
# # Problem this solves
#
# `rea init` writes `.claude/hooks/blocked-paths-bash-gate.sh` and
# `.claude/hooks/protected-paths-bash-gate.sh` that depend on the
# `@bookedsolid/rea` CLI being resolvable from `node_modules/`. Until
# 0.49.0, `rea init` did NOT add the dep to the consumer's
# `package.json` — so any fresh clone + `pnpm install` produced a
# brick state where the shims refused 100% of Bash calls (including
# the `pnpm add -D @bookedsolid/rea` that would recover).
#
# This helper provides a NARROW allowlist: when the CLI is missing,
# AND `package.json` declares `@bookedsolid/rea` (dependencies or
# devDependencies), AND the Bash payload is a single recognised PM
# install / add invocation, pass through. Everything else still
# refuses.
#
# # Security stance
#
# - Allowlist runs ONLY when the CLI is unreachable (CLI-missing
#   branch). The CLI-present path is unaffected.
# - Allowlist is ALWAYS-ON by default (no env-var toggle ever
#   participates in the decision). Operators can disable via policy
#   (`policy.bootstrap_allowlist.enabled: false`).
# - Precondition: `<project>/package.json` parseable as JSON object and
#   declares `@bookedsolid/rea` under `dependencies` OR
#   `devDependencies` (exact-key match, string value). NOT
#   `optionalDependencies`, NOT `peerDependencies`, NOT
#   `pnpm.overrides`.
# - Multi-segment payloads refuse INSIDE this helper. The caller
#   passes the RAW extracted Bash command; the helper sources
#   `cmd-segments.sh`, runs `_rea_split_segments` on the trimmed
#   payload, and short-circuits to `refuse` when the result has more
#   than one segment. This keeps the segmentation contract centralised
#   in the allowlist (the gate shims do not need to re-split, and any
#   future caller that forgets to pre-split is still safe).
# - Quoted argv forms (`pnpm "install"`, `'pnpm' install`) refuse-
#   fallthrough — quoted tokens are a defense feature, not a bug.
# - argv[0] basename match is exact-string, no slashes. Path-form
#   commands (`./pnpm install`, `/usr/local/bin/pnpm install`) refuse.
# - Audit event `rea.bash.bootstrap_allow` is emitted on every match
#   so operators can post-hoc verify what the allowlist let through.
#
# # Return convention
#
# `bootstrap_allowlist_check <command>`:
#   - exits 0 on stdout `"allow"`  — gate should pass the payload
#   - exits 0 on stdout `"refuse"` — gate should follow its existing
#                                    CLI-missing refusal path (banner +
#                                    exit 2 for blocking, exit 0 for
#                                    advisory)
#
# We deliberately use stdout-with-uniform-exit-0 rather than exit
# codes 0/1/2 so caller code can distinguish allowlist outcomes from
# any subshell process-control errors that bash would also surface as
# non-zero exits.
#
# # Bash 3.2 compatibility
#
# This helper targets macOS bash 3.2. Avoid: `mapfile`, `${var,,}`,
# `[[ =~ ]]`. OK: `case`, `read -ra`, `[[ ]]` for string compare
# without regex.

set -uo pipefail

# Source the segment splitter so the caller can reuse it on the same
# input. The caller MUST have already verified single-segment shape
# before calling us; we don't re-split here, but we DO defend against
# accidental misuse below.
_BOOTSTRAP_ALLOWLIST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=cmd-segments.sh
. "$_BOOTSTRAP_ALLOWLIST_DIR/cmd-segments.sh"

# Hash a string with whichever SHA-256 tool exists. Echoes 64 hex
# chars to stdout on success, empty on failure.
_bootstrap_sha256() {
  local input="$1"
  local hash=""
  if command -v shasum >/dev/null 2>&1; then
    hash=$(printf '%s' "$input" | shasum -a 256 2>/dev/null | awk '{print $1}')
  elif command -v sha256sum >/dev/null 2>&1; then
    hash=$(printf '%s' "$input" | sha256sum 2>/dev/null | awk '{print $1}')
  fi
  printf '%s' "$hash"
}

# Hash a FILE with whichever SHA-256 tool exists. Echoes 64 hex chars.
_bootstrap_sha256_file() {
  local file="$1"
  local hash=""
  if [ ! -f "$file" ]; then
    printf ''
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    hash=$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}')
  elif command -v sha256sum >/dev/null 2>&1; then
    hash=$(sha256sum "$file" 2>/dev/null | awk '{print $1}')
  fi
  printf '%s' "$hash"
}

# Read whether the allowlist is policy-disabled.
# Returns 0 (enabled, default) or 1 (disabled).
#
# Conflict-resolution: the architect locked "drop the grep tier" —
# jq → node only. Node is guaranteed available via `engines.node:
# ">=22"`. If neither tool parses the policy, refuse to ALLOW (default
# = enabled, but a malformed policy reads as "unknown" and we keep the
# allowlist on, otherwise an attacker who corrupts the policy could
# strip the bootstrap recovery path).
_bootstrap_allowlist_policy_enabled() {
  local policy_file="${1:-}"
  if [ -z "$policy_file" ] || [ ! -f "$policy_file" ]; then
    # No policy file → schema default = enabled.
    return 0
  fi
  local val=""
  # Tier 1: jq. Best signal — handles YAML poorly but operators
  # whose policy.yaml is JSON-shaped get a clean read. We do not
  # actually expect this to fire since policy.yaml is YAML; this is
  # defense-in-depth.
  if command -v jq >/dev/null 2>&1; then
    val=$(jq -r 'try .bootstrap_allowlist.enabled // empty' "$policy_file" 2>/dev/null || true)
    case "$val" in
      true|false) ;;
      *) val="" ;;
    esac
  fi
  # Tier 2: node with a tightened inline parser.
  #
  # R7-P2 (codex round 7): the parser must mirror the TS reader's
  # YAML semantics. The TS reader uses `yaml.parse()` then validates
  # with zod `z.boolean()`, so the ONLY accepted bool tokens are
  # `true`/`True`/`TRUE` and `false`/`False`/`FALSE` (the `yaml` v2
  # package recognises these as booleans; everything else —
  # `no`, `off`, `"false"`, etc. — parses as a STRING and then
  # fails zod validation with a clear error at CLI load time).
  # Pre-fix this parser only recognised lowercase `true|false`, so
  # a policy with `enabled: False` parsed as "enabled" in bash but
  # as "disabled" in TS — silent drift.
  #
  # NOTE: we cannot `require("yaml")` here because the whole reason
  # this code path runs is the CLI is missing — `node_modules/yaml`
  # may not yet exist. We rely on stdlib only.
  #
  # Recognised block forms (top-level OR indented):
  #     bootstrap_allowlist:
  #       enabled: <true|True|TRUE|false|False|FALSE>
  # Recognised flow form:
  #     bootstrap_allowlist: { enabled: <bool> }
  #
  # Anything we cannot confidently parse keeps the schema default
  # (enabled = true) — a malformed policy MUST NOT silently strip
  # the bootstrap recovery path.
  if [ -z "$val" ] && command -v node >/dev/null 2>&1; then
    val=$(node -e '
      const fs = require("fs");
      // Normalize a YAML scalar bool token to canonical `true`/`false`.
      // Returns null if the token is not a recognised YAML boolean
      // (mirrors the strict `z.boolean()` validation in the TS reader).
      function normBool(s) {
        if (typeof s !== "string") return null;
        const t = s.trim();
        if (t === "true" || t === "True" || t === "TRUE") return "true";
        if (t === "false" || t === "False" || t === "FALSE") return "false";
        return null;
      }
      try {
        const raw = fs.readFileSync(process.argv[1], "utf8");
        const lines = raw.split(/\r?\n/);
        // Find the `bootstrap_allowlist:` key. The TS reader honors
        // top-level placement; we also accept (defensively) the same
        // key at a single indentation level deeper, since the `yaml`
        // package would accept it inside the document root regardless
        // of leading whitespace.
        let i = -1;
        let inlineFlow = "";
        let baseIndent = 0;
        for (let k = 0; k < lines.length; k++) {
          const m = /^(\s*)bootstrap_allowlist:\s*(.*)$/.exec(lines[k]);
          if (m) {
            i = k;
            baseIndent = (m[1] || "").length;
            inlineFlow = (m[2] || "").trim();
            break;
          }
        }
        if (i === -1) { process.exit(0); }
        // Flow form on the same line: `bootstrap_allowlist: { enabled: <bool> }`
        if (inlineFlow.length > 0) {
          const flw = inlineFlow.match(/^\{\s*enabled:\s*([A-Za-z]+)\s*\}\s*$/);
          if (flw) {
            const b = normBool(flw[1]);
            if (b !== null) { process.stdout.write(b); process.exit(0); }
          }
          process.exit(0);
        }
        // Block form: walk subsequent lines until indentation drops
        // back to baseIndent or below (which terminates the block).
        for (let k = i + 1; k < lines.length; k++) {
          const line = lines[k];
          // Blank or comment lines do not terminate the block.
          if (/^\s*(#|$)/.test(line)) continue;
          // Indentation must be strictly deeper than the parent key.
          const indMatch = /^(\s*)\S/.exec(line);
          const ind = indMatch ? indMatch[1].length : 0;
          if (ind <= baseIndent) break;
          // Match `enabled: <token>` — accept lowercase, capitalized,
          // and uppercase boolean tokens via normBool. Reject quoted
          // forms (the regex requires a bare identifier).
          const m = /^\s+enabled:\s*([A-Za-z]+)\b/.exec(line);
          if (m) {
            const b = normBool(m[1]);
            if (b !== null) { process.stdout.write(b); process.exit(0); }
          }
        }
      } catch (e) { process.exit(0); }
    ' -- "$policy_file" 2>/dev/null || true)
    case "$val" in
      true|false) ;;
      *) val="" ;;
    esac
  fi
  if [ "$val" = "false" ]; then
    return 1
  fi
  # Default = enabled (true OR unparseable). A malformed policy MUST
  # NOT strip the bootstrap recovery path — see security comment above.
  return 0
}

# Verify package.json precondition.
# Args: $1 = path to package.json
# Echoes "<declared-range>" on stdout when matched (truncated to 16
# chars for the audit field). Empty on stdout when not matched.
# Returns 0 always — caller checks stdout.
_bootstrap_check_package_json() {
  local pj="$1"
  # R20-P2 (codex round 20): refuse when `package.json` is itself a
  # symbolic link. Pre-fix `[ -f ]` follows symlinks, so a CLI-
  # missing checkout whose `package.json` points outside the project
  # tree would still trust the symlink target's declaration of
  # `@bookedsolid/rea`. The package manager would then mutate that
  # OUT-OF-TREE target on the next `pnpm add` / `npm install`,
  # silently rewriting a file the operator did not intend the gate
  # to cover. Mirrors the R10-P2 symlink refusal added to
  # `selfPinRea` / `checkUpgradeBlockingPin` / `checkSelfPinDeclaredSync`
  # — every surface that READS package.json on the bootstrap path
  # must apply the same lstat-based guard. POSIX `[ -L ]` tests
  # whether the path itself is a symlink without dereferencing it
  # (bash 3.2 safe; supported on macOS / Linux / Alpine / Busybox).
  if [ -L "$pj" ]; then
    printf 'rea bootstrap allowlist refusing: %s is a symlink.\n' "$pj" >&2
    printf 'Trusting it would let the package manager mutate a target outside the project tree.\n' >&2
    return 0
  fi
  if [ ! -f "$pj" ]; then
    return 0
  fi
  # Tier 1: jq.
  #
  # P2-2 (codex round 1): the previous expression used `//` to fall
  # through from `dependencies` to `devDependencies`, but jq's `//`
  # treats BOTH `null` AND `false` as "default triggers". A hostile
  # `package.json` with `{ "dependencies": { "@bookedsolid/rea": false } }`
  # would fall through to `devDependencies` lookup — inconsistent with
  # the node tier (which type-guards `typeof x === "string"`) and a
  # latent forge surface if npm ever relaxes its current rejection of
  # non-string version values. `select(type=="string")` makes both
  # tiers type-equivalent: only string values qualify, every other
  # JSON shape (false / null / number / array / object) refuses.
  local val=""
  if command -v jq >/dev/null 2>&1; then
    val=$(jq -r '
      (.dependencies["@bookedsolid/rea"] // .devDependencies["@bookedsolid/rea"])
      | select(type == "string")
      // empty
    ' "$pj" 2>/dev/null || true)
  fi
  # Tier 2: node (guaranteed via engines.node).
  #
  # P2-1 (codex round 1): strip a leading UTF-8 BOM (EF BB BF) before
  # JSON.parse. Some Windows-authored package.json manifests start with
  # a BOM; JSON.parse rejects it (the spec is unambiguous). Pre-fix, a
  # BOM-prefixed manifest declaring @bookedsolid/rea would be treated
  # as missing here, refusing the install command that the dogfood
  # `selfPinRea` write path tolerates fine — asymmetric handling.
  # Mirrors the strip applied in src/cli/install/self-pin.ts (P2-3).
  if [ -z "$val" ] && command -v node >/dev/null 2>&1; then
    val=$(node -e '
      try {
        const fs = require("fs");
        let raw = fs.readFileSync(process.argv[1], "utf8");
        if (raw.charCodeAt(0) === 0xFEFF) { raw = raw.slice(1); }
        const pkg = JSON.parse(raw);
        if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) process.exit(0);
        const lookIn = function (key) {
          const v = pkg[key];
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const x = v["@bookedsolid/rea"];
            if (typeof x === "string") return x;
          }
          return null;
        };
        const deps = lookIn("dependencies");
        if (deps !== null) { process.stdout.write(deps); process.exit(0); }
        const dev = lookIn("devDependencies");
        if (dev !== null) { process.stdout.write(dev); process.exit(0); }
      } catch (e) { /* fall through to empty */ }
    ' -- "$pj" 2>/dev/null || true)
  fi
  # Defense-in-depth: refuse semver values longer than 256 chars
  # (cap the audit field size and prevent a packed/forged JSON
  # blob from blowing up the audit line).
  if [ "${#val}" -gt 256 ]; then
    val=""
  fi
  # Truncate to 16 chars for audit shape.
  if [ -n "$val" ]; then
    printf '%s' "${val:0:16}"
  fi
}


# Emit audit event `rea.bash.bootstrap_allow`. Two-tier:
# Tier 1: `rea hook audit-emit` when CLI is reachable (rare in our
#         caller — the whole point is CLI-missing — but `dist/cli/`
#         could exist without `node_modules/@bookedsolid/rea/`).
# Tier 2: hand-write the JSONL with PINNED key order so the canonical
#         TS audit reader accepts it.
#
# Args:
#   $1 = shim name (e.g. "blocked-paths-bash-gate")
#   $2 = pm token (e.g. "pnpm")
#   $3 = argv shape (e.g. "install")
#   $4 = argv-segments sha256
#   $5 = package.json sha256
#   $6 = package.json declares-rea ("true" or "false")
#   $7 = declared version range (truncated to 16 chars)
#   $8 = policy enabled ("true" or "false")
#   $9 = CLAUDE_PROJECT_DIR
_bootstrap_emit_audit() {
  local shim="$1"
  local pm="$2"
  local argv_shape="$3"
  local argv_sha="$4"
  local pj_sha="$5"
  local declares_rea="$6"
  local declared_range="$7"
  local policy_enabled="$8"
  local proj="$9"
  local audit_file="$proj/.rea/audit.jsonl"
  local timestamp
  timestamp=$(node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || true)
  if [ -z "$timestamp" ]; then
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || true)
  fi
  if [ -z "$timestamp" ]; then
    # Truly stripped container — emit a sentinel so the record is
    # still well-formed.
    timestamp="1970-01-01T00:00:00.000Z"
  fi

  # P2-2 (codex round 1): cross-process mutex around the
  # read-tail → compute-hash → append sequence. Two concurrently-allowed
  # bootstrap commands (e.g. `pnpm install` started twice from racing
  # editor instances, or `corepack prepare` + `pnpm install` in the
  # same hook fire) would otherwise read the same `prev_hash` tail
  # value and append two records with the same chain pointer —
  # forking the audit chain and breaking `rea audit verify`.
  #
  # mkdir is the canonical portable mutex on POSIX: creation is
  # atomic w.r.t. concurrent processes, fails fast if the dir exists,
  # and works on macOS/Linux/Alpine/Busybox without external tools.
  # The TS canonical writer (src/audit/append.ts) uses
  # `proper-lockfile` on `.rea/`; we cannot reach for that here
  # because the whole reason this helper runs is the CLI being
  # unbuilt — proper-lockfile lives in node_modules. The two
  # mechanisms are conservative w.r.t. each other: a TS writer
  # holding the proper-lockfile lock does not block our mkdir, but
  # the practical concern is OUR concurrent self-races (two bash
  # helper invocations against the same .rea/), and mkdir serialises
  # those cleanly. The race window where the TS writer and the bash
  # helper interleave is vanishingly small in practice (the bash
  # helper only runs when the CLI is unreachable; if the CLI is
  # unreachable the TS writer cannot run anyway).
  #
  # Lock-acquire policy: retry up to 50x at 50ms (≈2.5s window)
  # when sub-second sleep is available, otherwise 5x at 1s
  # (5s window). The `pnpm install` / `npm ci` commands the
  # allowlist guards take seconds-to-minutes; a multi-second lock
  # window is invisible to operators. On lock-acquire failure we
  # refuse rather than silently bypassing — every allow MUST be
  # auditable.
  local lockdir="$proj/.rea/.audit.lock"
  local lock_max_iter=50
  local lock_sleep="0.05"
  if ! sleep 0.01 2>/dev/null; then
    lock_max_iter=5
    lock_sleep="1"
  fi
  local lock_acquired=0
  local lock_i=0
  # Ensure .rea/ exists so mkdir(.audit.lock) has a parent. The
  # bash helper is the only writer in the bootstrap state, so this
  # is safe to do BEFORE locking — we only race on the audit-file
  # tail, not on .rea/ creation.
  mkdir -p "$proj/.rea" 2>/dev/null || true
  # Stale-lock recovery: a process killed mid-write (SIGKILL, OOM,
  # operator ^C through the wrong window) leaves the lockdir
  # hanging. Anything older than 1 minute is unambiguously stale —
  # the locked region holds for ~100ms typical, ~5s pathological.
  # `find -mmin` is non-POSIX but supported by macOS find, GNU find
  # (Linux), and Busybox find (Alpine). Failure to detect staleness
  # is acceptable: we still fall back to the existing CLI-missing
  # refusal path after the acquire window times out.
  if [ -d "$lockdir" ]; then
    if find "$lockdir" -maxdepth 0 -mmin +1 -type d 2>/dev/null | grep -q .; then
      rmdir "$lockdir" 2>/dev/null || true
    fi
  fi
  while [ "$lock_i" -lt "$lock_max_iter" ]; do
    if mkdir "$lockdir" 2>/dev/null; then
      lock_acquired=1
      break
    fi
    sleep "$lock_sleep" 2>/dev/null || true
    lock_i=$((lock_i + 1))
  done
  if [ "$lock_acquired" -eq 0 ]; then
    # Lock starvation — refuse rather than fork the chain.
    return 1
  fi

  # Build the metadata sub-object via node so JSON escaping is
  # bulletproof — Bash's printf does not escape control characters
  # the way JSON requires.
  local record=""
  record=$(node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const path = require("path");
    const args = process.argv.slice(1);
    const auditFile = args[0];
    const timestamp = args[1];
    const shim = args[2];
    const pm = args[3];
    const argvShape = args[4];
    const argvSha = args[5];
    const pjSha = args[6];
    const declaresRea = args[7] === "true";
    const declaredRange = args[8];
    const policyEnabled = args[9] === "true";
    // Read prev_hash from the last line of the existing audit file.
    //
    // R4-P1 (codex round 4): tail-validation must distinguish three
    // states:
    //
    //   1. File absent OR zero bytes → GENESIS (prev_hash = all-zeros)
    //   2. Last line parses as JSON with a valid 64-hex `hash` field
    //      → NORMAL (prev_hash = that hash)
    //   3. File exists with bytes but the last non-empty line is
    //      partial / not-JSON / missing the hash field / wrong
    //      hash shape → CORRUPTION
    //
    // Pre-fix, case (3) silently fell back to genesis — the next
    // bootstrap allow appended a record whose prev_hash pointed at
    // the genesis sentinel instead of the real tail, permanently
    // forking the chain. The "every allow is auditable" invariant
    // requires us to refuse rather than fork. On corruption we
    // emit empty stdout + a stderr explainer; the bash caller
    // already refuses when stdout is empty (see "if [ -z \"$record\" ]"
    // a few lines down).
    const HEX64 = /^[0-9a-f]{64}$/;
    const GENESIS = "0000000000000000000000000000000000000000000000000000000000000000";
    let prevHash = null;
    let exists = false;
    try {
      const st = fs.statSync(auditFile);
      exists = st.isFile();
    } catch (e) { /* ENOENT or perms → treat as not-present */ }
    if (!exists) {
      prevHash = GENESIS;
    } else {
      let raw = "";
      try { raw = fs.readFileSync(auditFile, "utf8"); }
      catch (e) {
        // File present but unreadable. Distinguish-able from
        // genesis: refuse.
        process.stderr.write("rea: bootstrap-allowlist refused — audit file " + auditFile + " is unreadable.\n");
        process.exit(0);
      }
      if (raw.length === 0) {
        prevHash = GENESIS;
      } else {
        // Find the LAST non-empty line. If the file does not end
        // with "\n", the trailing partial line is a crash-mid-write
        // signal — that is corruption.
        const endsWithNewline = raw.endsWith("\n");
        const lines = raw.split("\n");
        // After split, a trailing newline produces a final "" entry.
        // A missing trailing newline leaves the partial tail as the
        // final entry — and we refuse on that.
        if (!endsWithNewline) {
          process.stderr.write("rea: bootstrap-allowlist refused — audit tail at " + auditFile + " is missing a trailing newline (partial write detected). Repair the chain before retrying.\n");
          process.exit(0);
        }
        // Strip the trailing empty entry and find the last non-blank line.
        while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        if (lines.length === 0) {
          // File contained only newlines — refuse, this is corruption.
          process.stderr.write("rea: bootstrap-allowlist refused — audit file " + auditFile + " contains only whitespace.\n");
          process.exit(0);
        }
        const lastLine = lines[lines.length - 1];
        let lastObj = null;
        try { lastObj = JSON.parse(lastLine); }
        catch (e) {
          process.stderr.write("rea: bootstrap-allowlist refused — audit tail at " + auditFile + " line " + lines.length + " is not valid JSON.\n");
          process.exit(0);
        }
        if (lastObj === null || typeof lastObj !== "object" || Array.isArray(lastObj)) {
          process.stderr.write("rea: bootstrap-allowlist refused — audit tail at " + auditFile + " line " + lines.length + " is not a JSON object.\n");
          process.exit(0);
        }
        if (typeof lastObj.hash !== "string" || !HEX64.test(lastObj.hash)) {
          process.stderr.write("rea: bootstrap-allowlist refused — audit tail at " + auditFile + " line " + lines.length + " is missing a valid 64-hex `hash` field.\n");
          process.exit(0);
        }
        prevHash = lastObj.hash;
      }
    }
    if (prevHash === null) {
      // Defensive — should be unreachable; every branch above either
      // sets prevHash or exits.
      process.exit(0);
    }
    // PINNED key order — matches the canonical AuditRecord shape.
    const recordBase = {
      timestamp: timestamp,
      session_id: "bash-tier",
      tool_name: "rea.bash.bootstrap_allow",
      server_name: "rea",
      tier: "write",
      status: "allowed",
      autonomy_level: "unknown",
      duration_ms: 0,
      prev_hash: prevHash,
      emission_source: "rea-cli",
      metadata: {
        shim: shim,
        pm: pm,
        argv_shape: argvShape,
        argv_segments_sha256: argvSha,
        package_json_sha256: pjSha,
        package_json_declares_rea: declaresRea,
        declared_version_range: declaredRange,
        cli_resolution: "missing",
        policy_enabled: policyEnabled,
      },
    };
    const canonical = JSON.stringify(recordBase);
    const hash = crypto.createHash("sha256").update(canonical).digest("hex");
    const record = Object.assign({}, recordBase, { hash: hash });
    process.stdout.write(JSON.stringify(record));
  ' -- "$audit_file" "$timestamp" "$shim" "$pm" "$argv_shape" "$argv_sha" "$pj_sha" "$declares_rea" "$declared_range" "$policy_enabled" || true)
  # R4-P1 (codex round 4): keep stderr UN-redirected on the
  # record-build call. The corruption-refusal branch writes a
  # human-readable explainer to stderr, and operators investigating
  # a refused bootstrap allow need to see WHY the chain refused.
  # Any other node-side failure (OOM, missing crypto module, etc.)
  # is also legitimately operator-actionable — silencing those
  # was hiding signal, not noise.

  if [ -z "$record" ]; then
    # Audit-emit unavailable — security-architect mandate: every
    # bootstrap_allow MUST be auditable. Refuse rather than allow
    # silently. The caller treats stderr-only-refuse as a fallthrough
    # to the existing CLI-missing path (banner + exit 2).
    rmdir "$lockdir" 2>/dev/null || true
    return 1
  fi

  # Append + fsync via a single node call.
  node -e '
    const fs = require("fs");
    const path = require("path");
    const auditFile = process.argv[1];
    const line = process.argv[2] + "\n";
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      const fd = fs.openSync(auditFile, "a");
      fs.writeSync(fd, line);
      try { fs.fsyncSync(fd); } catch (e) {}
      fs.closeSync(fd);
    } catch (e) {
      process.exit(1);
    }
  ' -- "$audit_file" "$record" 2>/dev/null
  local append_rc=$?
  rmdir "$lockdir" 2>/dev/null || true
  return $append_rc
}

# Match the package-spec argument of a `pm add` invocation against the
# bare-only shape for `@bookedsolid/rea`.
#
# R6-P2 (codex round 6): version-pinned forms are REFUSED.
#
# Accepted:   @bookedsolid/rea   (bare — install whatever the consumer's
#                                 existing self-pin admits)
# Rejected:   @bookedsolid/rea@<anything>   (incl. dist-tags `@latest`,
#                                            `@next`, exact versions
#                                            `@0.48.0`, ranges, etc.)
#             every other spec (different package, malformed scope).
#
# Rationale: the bootstrap allowlist's stated job is to recover a
# CLI-missing repo. Version selection is `rea init` (caret pin at
# install time) and `rea upgrade` (managed-caret bump via the TS path,
# under audit) territory — NOT the Bash-tier bootstrap path. Allowing
# `@bookedsolid/rea@<ver>` here let a Bash-only session retarget the
# trusted gate binary mid-bootstrap by pinning to an older or
# attacker-controlled version, defeating the new `package.json` blocked-
# path protection in bst-internal*. Stripping the version branch closes
# that retarget surface entirely. See THREAT_MODEL.md §5.23.
#
# Returns 0 if matched (bare spec), 1 otherwise.
_bootstrap_match_rea_spec() {
  [ "$1" = '@bookedsolid/rea' ]
}

# Classify the argv array (already split) against the per-PM allowed
# shape lists. Echoes the shape token (e.g. "install" / "ci" /
# "add-rea") on stdout when matched, OR empty stdout on no match.
# Always returns 0.
#
# argv[0] is the PM name (basename-exact-matched by the caller).
_bootstrap_classify_pnpm() {
  # $@ = full argv (including pnpm)
  local argv0="${1:-}"
  shift || true
  case "${argv0}" in
    pnpm) ;;
    *) return 0 ;;
  esac
  # Shapes we accept (post-pnpm). R6-P2: bare `@bookedsolid/rea` only;
  # version-pinned `@bookedsolid/rea@<ver>` is refused.
  #   install
  #   i
  #   install --frozen-lockfile
  #   install --no-frozen-lockfile
  #   i --frozen-lockfile
  #   i --no-frozen-lockfile
  #   add -D @bookedsolid/rea
  #   add --save-dev @bookedsolid/rea
  local first="${1:-}"
  case "$first" in
    install|i)
      shift
      if [ "$#" -eq 0 ]; then
        printf 'install'
        return 0
      fi
      if [ "$#" -eq 1 ]; then
        case "$1" in
          '--frozen-lockfile'|'--no-frozen-lockfile')
            printf 'install-locked'
            return 0
            ;;
        esac
      fi
      return 0
      ;;
    add)
      shift
      # Expect: -D|--save-dev <pkg-spec>
      if [ "$#" -ne 2 ]; then
        return 0
      fi
      case "$1" in
        '-D'|'--save-dev') ;;
        *) return 0 ;;
      esac
      if _bootstrap_match_rea_spec "$2"; then
        printf 'add-rea'
        return 0
      fi
      return 0
      ;;
  esac
  return 0
}

_bootstrap_classify_npm() {
  local argv0="${1:-}"
  shift || true
  case "${argv0}" in
    npm) ;;
    *) return 0 ;;
  esac
  local first="${1:-}"
  case "$first" in
    install|i)
      shift
      if [ "$#" -eq 0 ]; then
        printf 'install'
        return 0
      fi
      # npm install -D @bookedsolid/rea
      # npm install --save-dev @bookedsolid/rea
      # R6-P2: version-pinned forms refuse.
      if [ "$#" -eq 2 ]; then
        case "$1" in
          '-D'|'--save-dev') ;;
          *) return 0 ;;
        esac
        if _bootstrap_match_rea_spec "$2"; then
          printf 'add-rea'
          return 0
        fi
      fi
      return 0
      ;;
    ci)
      shift
      if [ "$#" -eq 0 ]; then
        printf 'ci'
        return 0
      fi
      return 0
      ;;
  esac
  return 0
}

_bootstrap_classify_yarn() {
  local argv0="${1:-}"
  shift || true
  case "${argv0}" in
    yarn) ;;
    *) return 0 ;;
  esac
  local first="${1:-}"
  if [ -z "$first" ]; then
    # Bare `yarn` (yarn classic install).
    printf 'install'
    return 0
  fi
  case "$first" in
    install)
      shift
      if [ "$#" -eq 0 ]; then
        printf 'install'
        return 0
      fi
      return 0
      ;;
    add)
      shift
      # yarn add -D @bookedsolid/rea
      # yarn add --dev @bookedsolid/rea
      # R6-P2: version-pinned forms refuse.
      if [ "$#" -eq 2 ]; then
        case "$1" in
          '-D'|'--dev') ;;
          *) return 0 ;;
        esac
        if _bootstrap_match_rea_spec "$2"; then
          printf 'add-rea'
          return 0
        fi
      fi
      return 0
      ;;
  esac
  return 0
}

_bootstrap_classify_corepack() {
  local argv0="${1:-}"
  shift || true
  case "${argv0}" in
    corepack) ;;
    *) return 0 ;;
  esac
  local first="${1:-}"
  case "$first" in
    enable)
      shift
      if [ "$#" -eq 0 ]; then
        printf 'corepack-enable'
        return 0
      fi
      # `corepack enable pnpm` (or yarn/npm)
      if [ "$#" -eq 1 ]; then
        case "$1" in
          pnpm|yarn|npm)
            printf 'corepack-enable-pm'
            return 0
            ;;
        esac
      fi
      return 0
      ;;
    prepare)
      shift
      # `corepack prepare pnpm@<ver> --activate`
      if [ "$#" -eq 2 ]; then
        case "$1" in
          pnpm@*|yarn@*|npm@*)
            local pmver="${1%%@*}"
            local ver="${1#*@}"
            # Ver charset same as rea-spec (semver-like).
            if [ -z "$ver" ] || [ "${#ver}" -gt 64 ]; then
              return 0
            fi
            local i=0
            while [ $i -lt ${#ver} ]; do
              local c="${ver:$i:1}"
              case "$c" in
                [A-Za-z0-9._~+\-]|'^') ;;
                *) return 0 ;;
              esac
              i=$((i + 1))
            done
            if [ "$2" = '--activate' ]; then
              # Avoid unused-var warning for pmver (purely documentary
              # at this point — already constrained by the case above).
              : "$pmver"
              printf 'corepack-prepare'
              return 0
            fi
            ;;
        esac
      fi
      return 0
      ;;
  esac
  return 0
}

# Entrypoint.
# Args:
#   $1 = shim name (used in audit event)
#   $2 = the extracted single-segment Bash command
#   $3 = path to package.json (canonical: $CLAUDE_PROJECT_DIR/package.json)
#   $4 = path to policy.yaml (canonical: $CLAUDE_PROJECT_DIR/.rea/policy.yaml)
#   $5 = $proj (realpath-resolved project dir for the audit log)
#
# Echoes "allow" or "refuse" on stdout. Always exits 0.
bootstrap_allowlist_check() {
  # ast-parser-specialist required: declare local IFS so a hostile
  # caller cannot reshape word-splitting via IFS leakage.
  local IFS=$' \t\n'

  local shim="$1"
  local cmd="$2"
  local pj="$3"
  local policy_file="$4"
  local proj="$5"

  # Policy precondition: enabled?
  if ! _bootstrap_allowlist_policy_enabled "$policy_file"; then
    printf 'refuse'
    return 0
  fi

  # Precondition: package.json declares @bookedsolid/rea?
  local declared_range=""
  declared_range=$(_bootstrap_check_package_json "$pj")
  if [ -z "$declared_range" ]; then
    printf 'refuse'
    return 0
  fi

  # Trim leading/trailing whitespace from the command.
  local trimmed="$cmd"
  trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [ -z "$trimmed" ]; then
    printf 'refuse'
    return 0
  fi

  # Defense: refuse multi-segment payloads. The shim helper passes us
  # the extracted command; the caller is responsible for routing
  # multi-segment commands away from the allowlist, but if it didn't,
  # we hard-refuse here. _rea_split_segments outputs one segment per
  # line; we count via a single subprocess.
  local seg_count=0
  while IFS= read -r _seg; do
    if [ -n "$_seg" ]; then
      seg_count=$((seg_count + 1))
    fi
  done < <(_rea_split_segments "$trimmed")
  if [ "$seg_count" -gt 1 ]; then
    printf 'refuse'
    return 0
  fi

  # Split argv via `read -ra`. Quoted forms refuse-fallthrough — a
  # quoted argv token does not match the bare-string allowlist
  # patterns, which is intentional: an attacker laundering through
  # quotes is the kind of payload we want to refuse.
  local -a ARGV
  read -ra ARGV <<<"$trimmed"
  if [ "${#ARGV[@]}" -eq 0 ]; then
    printf 'refuse'
    return 0
  fi

  local argv0="${ARGV[0]}"
  # Reject path-form argv[0] (anything containing a slash).
  case "$argv0" in
    */*) printf 'refuse'; return 0 ;;
  esac
  # Reject anything containing characters outside [A-Za-z0-9._-].
  case "$argv0" in
    *[!A-Za-z0-9._-]*) printf 'refuse'; return 0 ;;
  esac

  local pm=""
  local shape=""
  case "$argv0" in
    pnpm)    pm="pnpm";     shape=$(_bootstrap_classify_pnpm "${ARGV[@]}") ;;
    npm)     pm="npm";      shape=$(_bootstrap_classify_npm "${ARGV[@]}") ;;
    yarn)    pm="yarn";     shape=$(_bootstrap_classify_yarn "${ARGV[@]}") ;;
    corepack)pm="corepack"; shape=$(_bootstrap_classify_corepack "${ARGV[@]}") ;;
    *)
      printf 'refuse'
      return 0
      ;;
  esac

  if [ -z "$shape" ]; then
    printf 'refuse'
    return 0
  fi

  # Build audit fields.
  # Hash the argv segments (space-joined for a stable canonical form).
  local argv_canonical=""
  argv_canonical=$(printf '%s' "${ARGV[*]}")
  local argv_sha=""
  argv_sha=$(_bootstrap_sha256 "$argv_canonical")
  local pj_sha=""
  pj_sha=$(_bootstrap_sha256_file "$pj")
  if [ -z "$argv_sha" ] || [ -z "$pj_sha" ]; then
    # R7-P1 (codex round 7): hasher unavailable — every allow MUST
    # be auditable, so we refuse-HARD. The `refuse-hard` stdout token
    # tells the shim caller to refuse via banner regardless of the
    # substring-scan verdict; collapsing this into the plain `refuse`
    # token would let the shim fall through to "no-substring →
    # silent allow" and break the auditability invariant.
    printf 'refuse-hard'
    return 0
  fi

  # Emit audit. R7-P1: emit-failure is also refuse-hard for the same
  # auditability reason.
  if ! _bootstrap_emit_audit "$shim" "$pm" "$shape" "$argv_sha" \
        "$pj_sha" "true" "$declared_range" "true" "$proj"; then
    printf 'refuse-hard'
    return 0
  fi

  printf 'allow'
  return 0
}

# P1-2 (codex round 2) / R5-P1 (codex round 5) / R7-P1 (codex round 7):
# shim-side helper. Consults the allowlist for a CLI-missing Bash
# payload when argv[0] is a recognized PM (pnpm/npm/yarn/corepack),
# keeping the shim integration small enough to stay under its
# ≤120-LOC budget.
#
# # Return-code contract
#
# The allowlist OPENS gates, it does NOT CLOSE them — EXCEPT for the
# audit-integrity gate, which is fail-CLOSED. The shim's substring
# scan stays determinative for refusal in the ordinary case; the
# allowlist provides the audit trail when it permits an otherwise-
# suspicious (substring-matched) command. But when audit emission
# itself fails (`.rea/audit.jsonl` corrupted, hasher unavailable,
# disk full, etc.), every PM payload — substring-matched or not —
# must refuse, because allowing without an audit trail breaks the
# "every bootstrap allow is auditable" invariant.
#
# Return codes:
#   - EXIT 0: PM payload, allowlist allows (audit event emitted by
#     the helper itself). Caller should `exit 0` IMMEDIATELY — the
#     auditable-allow path, valid whether or not the substring scan
#     matched.
#   - EXIT 1: refuse-FALLTHROUGH. argv[0] not a PM, OR shape didn't
#     match, OR precondition failed (no rea declaration). Caller
#     decides what to do based on its own substring-scan result:
#       * substring matched → caller emits CLI-missing banner.
#       * no substring match → caller preserves the documented
#         "no-policy / no-match => allow" posture (silent allow,
#         no audit).
#   - EXIT 2: refuse-HARD. Audit-integrity failure (R7-P1 / codex
#     round 7). Caller MUST refuse via banner regardless of the
#     substring-scan verdict — silently allowing would violate the
#     auditability invariant and let a corrupted audit chain go
#     unenforced. The helper has already printed an operator-
#     actionable explainer to stderr (e.g. "audit tail at <path>
#     line <N> is not valid JSON").
#
# Args:
#   $1 = shim name (passed verbatim to bootstrap_allowlist_check)
#   $2 = the extracted Bash command string
#   $3 = REA_ROOT (resolved by the shim's halt-check.sh sourcing)
_bootstrap_shim_pm_route() {
  # R3-P1 (codex round 3): pin a local IFS so a hostile parent
  # environment that exported `IFS=X` cannot reshape the `read -ra`
  # below. Matches the same defense `bootstrap_allowlist_check`
  # applies (see line ~736).
  local IFS=$' \t\n'

  local shim_name="$1"
  local cmd="$2"
  local rea_root="$3"

  # Extract argv0 basename via `read -ra` (R3-P1: tab-separator and
  # leading-whitespace shapes get parsed identically to what the
  # allowlist itself does).
  local -a _PM_ARGV
  read -ra _PM_ARGV <<<"$cmd"
  if [ "${#_PM_ARGV[@]}" -eq 0 ]; then
    return 1
  fi
  local argv0="${_PM_ARGV[0]}"
  argv0="${argv0##*/}"
  case "$argv0" in
    pnpm|npm|yarn|corepack) ;;
    *) return 1 ;;
  esac

  # Resolve project root with realpath. CLAUDE_PROJECT_DIR wins when
  # available; fall back to REA_ROOT. ast-parser-specialist locked
  # the cd-pwd-P idiom for realpath resolution on bash 3.2.
  local proj_root="$rea_root"
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    if proj_root=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd -P 2>/dev/null); then
      :
    else
      proj_root="$rea_root"
    fi
  fi

  local policy_file="$rea_root/.rea/policy.yaml"
  if [ ! -f "$policy_file" ]; then
    policy_file="$proj_root/.rea/policy.yaml"
  fi
  local pj="$proj_root/package.json"

  local verdict
  verdict=$(bootstrap_allowlist_check "$shim_name" "$cmd" "$pj" "$policy_file" "$proj_root")
  case "$verdict" in
    allow) return 0 ;;
    # R7-P1: audit-integrity failure — propagate refuse-hard to the
    # shim caller so it refuses via banner regardless of substring
    # scan. `bootstrap_allowlist_check` already printed the explainer
    # to stderr (preserved through the un-suppressed pipe in
    # `_bootstrap_emit_audit`).
    refuse-hard) return 2 ;;
    *) return 1 ;;
  esac
}

