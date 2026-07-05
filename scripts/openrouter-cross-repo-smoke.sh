#!/usr/bin/env bash
# openrouter-cross-repo-smoke.sh — validate the `openrouter` review provider by
# invoking the rea BINARY DIRECTLY from a DISPOSABLE throwaway consumer repo.
#
# This is the black-box companion to docs/testing/openrouter-review-provider.md.
# It proves the *shipped binary* (dist/cli/index.js) works when called from
# ANOTHER project — exactly the validation Jake asked for:
#
#     node <reaDir>/dist/cli/index.js review --provider openrouter --json
#
# It asserts the emitted JSON, the exit code, and the written
# `.rea/last-review.json` against the locked spec's CLI contract.
#
# ---------------------------------------------------------------------------
# Two modes
# ---------------------------------------------------------------------------
#
#   (a) MOCKED transport (DEFAULT) — runs with no REAL OPENROUTER_API_KEY.
#       The provider is pointed at a tiny LOCALHOST HTTP fixture responder via
#       review.providers.openrouter.base_url = http://127.0.0.1:<port> (the
#       NARROW loopback-http exception in the base_url validator). This drives
#       the REAL shipped defaultTransport (native fetch) end-to-end — path-guard
#       and redact-before-send run BEFORE the transport, so they are faithfully
#       exercised. A DUMMY key is exported so the key gate passes; the localhost
#       server ignores it.
#
#       SECURITY (codex round-2 FIX 2): there is intentionally NO
#       `REA_OPENROUTER_FIXTURE` env-var transport. A shipped env-var fixture
#       would let any environment with that var set mint a canonical
#       `rea.local_review` PASS from attacker-controlled local JSON — a trust
#       bypass. The provider exposes no such hook; this harness uses the
#       localhost HTTP server ONLY.
#
#       Mode (a) is the DEFAULT so this runs in CI and locally with no real key.
#
#   (b) LIVE — gated on OPENROUTER_API_KEY. Same flow against the real
#       endpoint. SKIPPED (exit 0 with a SKIP notice) when the key is absent.
#
# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
#
#   scripts/openrouter-cross-repo-smoke.sh            # mode (a), default
#   REA_SMOKE_MODE=mock  scripts/openrouter-cross-repo-smoke.sh   # force (a)
#   REA_SMOKE_MODE=live  scripts/openrouter-cross-repo-smoke.sh   # force (b)
#   REA_SMOKE_VERDICT=blocking scripts/...            # canned verdict (mock)
#
# Run from the rea repo root. Builds dist/ first (unless REA_SKIP_BUILD=1).
#
# Exit codes:
#   0  — all assertions passed (or live mode skipped: no key)
#   1  — an assertion failed
#   2  — setup/precondition failure (no node, build failed, no fixture hook)
set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the rea repo root (this script lives in <root>/scripts/).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REA_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REA_BIN="${REA_DIR}/dist/cli/index.js"

MODE="${REA_SMOKE_MODE:-}"
# Default mode: live iff a key is present AND not explicitly forced to mock.
if [ -z "${MODE}" ]; then
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then MODE="live"; else MODE="mock"; fi
fi
CANNED_VERDICT="${REA_SMOKE_VERDICT:-concerns}"

note() { printf '\033[1;34m[smoke]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
skip() { printf '\033[1;33m[skip]\033[0m %s\n' "$*" >&2; exit 0; }

command -v node >/dev/null 2>&1 || { echo "node not found on PATH" >&2; exit 2; }
command -v git  >/dev/null 2>&1 || { echo "git not found on PATH"  >&2; exit 2; }

# ---------------------------------------------------------------------------
# Build dist/ unless told to skip (CI builds once and sets REA_SKIP_BUILD=1).
# ---------------------------------------------------------------------------
if [ "${REA_SKIP_BUILD:-0}" != "1" ]; then
  note "building dist/ (set REA_SKIP_BUILD=1 to reuse an existing build)"
  ( cd "${REA_DIR}" && pnpm build >/dev/null ) || { echo "build failed" >&2; exit 2; }
fi
[ -f "${REA_BIN}" ] || { echo "missing binary: ${REA_BIN} (build did not produce it)" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Throwaway state: disposable consumer repo, a fixture-responder server, and a
# canned-response file. Cleaned up on ANY exit.
# ---------------------------------------------------------------------------
WORK_DIR="$(mktemp -d -t rea-or-smoke-XXXXXX)"
FIXTURE_JSON="${WORK_DIR}/canned-response.json"
SERVER_PIDFILE="${WORK_DIR}/server.pid"
SERVER_PORTFILE="${WORK_DIR}/server.port"

cleanup() {
  if [ -f "${SERVER_PIDFILE}" ]; then
    kill "$(cat "${SERVER_PIDFILE}")" 2>/dev/null || true
  fi
  rm -rf -- "${WORK_DIR}" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

CONSUMER_REPO="${WORK_DIR}/consumer-project"
mkdir -p "${CONSUMER_REPO}"

# ---------------------------------------------------------------------------
# 1. Build a disposable git repo with a SAMPLE DIFF (an uncommitted working-tree
#    change — `rea review` reviews the working tree before commit).
# ---------------------------------------------------------------------------
note "creating disposable consumer repo at ${CONSUMER_REPO}"
git -C "${CONSUMER_REPO}" init -q
git -C "${CONSUMER_REPO}" config user.email "smoke@example.test"
git -C "${CONSUMER_REPO}" config user.name "Smoke Test"
git -C "${CONSUMER_REPO}" config commit.gpgsign false

# A committed baseline so HEAD exists and there is a base to diff against.
cat > "${CONSUMER_REPO}/app.ts" <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
EOF
git -C "${CONSUMER_REPO}" add app.ts
git -C "${CONSUMER_REPO}" commit -qm "baseline"

# The SAMPLE DIFF: an uncommitted change the review will see.
cat >> "${CONSUMER_REPO}/app.ts" <<'EOF'

export function divide(a: number, b: number): number {
  // intentional: no zero-guard — a reviewer should flag this
  return a / b;
}
EOF

# ---------------------------------------------------------------------------
# 2. Write a .rea/policy.yaml that selects the openrouter provider. In mock
#    mode we also pin base_url at the localhost responder (transport #2).
# ---------------------------------------------------------------------------
mkdir -p "${CONSUMER_REPO}/.rea"

# Canned OpenRouter chat/completions response. The `content` is a JSON string
# matching the provider's response_format json_schema contract: a verdict plus
# findings. CANNED_VERDICT drives the exit-code assertion below.
case "${CANNED_VERDICT}" in
  pass)     SEV='[]' ;;
  concerns) SEV='[{"severity":"P2","title":"divide has no zero-guard","body":"divide(a,b) returns a/b with no guard for b===0","file":"app.ts","line":4}]' ;;
  blocking) SEV='[{"severity":"P1","title":"divide has no zero-guard","body":"divide(a,b) returns a/b with no guard for b===0","file":"app.ts","line":4}]' ;;
  malformed) SEV='__MALFORMED__' ;;
  *) fail "unknown REA_SMOKE_VERDICT=${CANNED_VERDICT} (pass|concerns|blocking|malformed)" ;;
esac

if [ "${CANNED_VERDICT}" = "malformed" ]; then
  # An intentionally non-JSON message body — exercises the AC-3 error path:
  # must yield verdict:error / exit 2, NEVER a silent pass.
  CONTENT='this is not json at all <<<'
else
  CONTENT="{\"verdict\":\"${CANNED_VERDICT}\",\"findings\":${SEV}}"
fi

# Build the canned upstream response. We embed `content` as a JSON-escaped
# string via node (passed through the environment) so quoting is correct
# regardless of payload.
SMOKE_CONTENT="${CONTENT}" FIXTURE_OUT="${FIXTURE_JSON}" node -e '
  const fs = require("fs");
  const content = process.env.SMOKE_CONTENT;
  const body = {
    id: "smoke-fixture",
    model: "openai/gpt-oss-120b",
    provider: "smoke-served-by",        // serving backend → audit served_by
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 1200, completion_tokens: 200, total_tokens: 1400 }
  };
  fs.writeFileSync(process.env.FIXTURE_OUT, JSON.stringify(body, null, 2));
'

BASE_URL_LINE=""
if [ "${MODE}" = "mock" ]; then
  # MOCK MODE — localhost fixture HTTP server ONLY (codex round-2 FIX 2).
  #
  # There is intentionally NO `REA_OPENROUTER_FIXTURE` env-var transport: a
  # shipped env-var fixture would let any environment with that var set mint a
  # canonical `rea.local_review` PASS from attacker-controlled JSON. The
  # provider exposes NO such hook. Instead we stand up a localhost HTTP server
  # and point `review.providers.openrouter.base_url` at `http://127.0.0.1:<port>`
  # via the NARROW loopback-http exception in the base_url validator (loopback
  # only — 127.0.0.0/8 + ::1 + localhost; never a public host). This drives the
  # REAL shipped `defaultTransport` (native fetch) end-to-end with no real key
  # and no shipped backdoor.
  #
  # A DUMMY key is supplied below so the provider's key gate passes; the
  # localhost server ignores the Authorization header.
  export FIXTURE_PATH="${FIXTURE_JSON}"
  export PORTFILE="${SERVER_PORTFILE}"
  note "mock transport: starting localhost fixture HTTP responder (no env-var fixture)"
  node -e '
    const http = require("http");
    const fs = require("fs");
    const body = fs.readFileSync(process.env.FIXTURE_PATH, "utf8");
    const srv = http.createServer((req, res) => {
      // Respond to any POST .../chat/completions with the canned body.
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        // round-18: Connection: close so the rea client does not keep the
        // socket alive (no lingering keep-alive against this one-shot responder).
        res.writeHead(200, { "content-type": "application/json", "connection": "close" });
        res.end(body);
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      fs.writeFileSync(process.env.PORTFILE, String(srv.address().port));
    });
  ' >/dev/null 2>&1 &
  echo $! > "${SERVER_PIDFILE}"

  # Wait (bounded, no fixed sleep) for the port file to appear.
  tries=0
  while [ ! -s "${SERVER_PORTFILE}" ] && [ "${tries}" -lt 100 ]; do
    tries=$((tries + 1))
    # Busy-wait via a short node delay (foreground sleep is blocked in some envs).
    node -e 'setTimeout(()=>process.exit(0), 50)' >/dev/null 2>&1 || true
  done
  [ -s "${SERVER_PORTFILE}" ] || fail "fixture responder did not bind a port"
  PORT="$(cat "${SERVER_PORTFILE}")"
  ok "fixture responder listening on 127.0.0.1:${PORT}"
  BASE_URL_LINE="      base_url: \"http://127.0.0.1:${PORT}/api/v1\""
  # Dummy key: satisfies the provider's key gate; the localhost server ignores
  # it. This is NOT a trust bypass — the verdict still comes from a real HTTP
  # round-trip through the real transport, not from a local file the provider
  # reads directly.
  export OPENROUTER_API_KEY="smoke-dummy-key-not-a-real-credential"
else
  note "LIVE mode — using real OPENROUTER_API_KEY against api.openrouter.ai"
  [ -n "${OPENROUTER_API_KEY:-}" ] || skip "live mode requested but OPENROUTER_API_KEY is unset"
fi

# A COMPLETE, schema-valid policy. With codex round-2 FIX 3 an EXISTING but
# malformed/invalid `.rea/policy.yaml` now fails closed (refuses the external
# lane and falls back to codex) — so the smoke must write a fully-valid policy
# for the openrouter lane to actually run. All required top-level fields are
# present.
cat > "${CONSUMER_REPO}/.rea/policy.yaml" <<EOF
version: "0.50.0"
profile: open-source-no-codex
installed_by: smoke
installed_at: "2026-06-08T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
protected_paths_relax: []
notification_channel: ""
review:
  provider: openrouter
  local_review:
    mode: enforced
  providers:
    openrouter:
      model: "openai/gpt-oss-120b"
${BASE_URL_LINE}
      data_policy: deny-training
      timeout_ms: 120000
      path_overrides:
        - paths: ["strawn-legal/**", "**/*.secret.*"]
          provider: codex
EOF

# ---------------------------------------------------------------------------
# 3. Invoke the rea BINARY DIRECTLY from the consumer repo. We `cd` into the
#    throwaway repo so process.cwd() (which runReview/preflight use as baseDir)
#    is the consumer project — exactly how a real consumer would call it.
#
#    For the `malformed` verdict we must faithfully exercise AC-3
#    (malformed openrouter output → verdict:error / exit 2, NEVER a silent
#    pass). With codex INSTALLED, a malformed openrouter response correctly
#    falls back to codex (the designed degradation) — which would mask the
#    error path. So for the malformed case ONLY we invoke with codex removed
#    from PATH (a dir-pruned PATH), so the openrouter→malformed→no-fallback
#    path surfaces as the error the contract guarantees.
# ---------------------------------------------------------------------------
INVOKE_PATH="${PATH}"
if [ "${CANNED_VERDICT}" = "malformed" ]; then
  # Shadow `codex` with a stub that fails its `--version` probe so the codex
  # fallback is genuinely UNAVAILABLE (without removing `node`/`git` from PATH,
  # which often live in the same nvm bin dir as codex). Prepending the stub dir
  # makes `codex --version` exit non-zero → the provider treats codex as
  # not-installed → the openrouter→malformed→no-fallback error path fires (AC-3).
  STUB_DIR="${WORK_DIR}/stubbin"
  mkdir -p "${STUB_DIR}"
  printf '#!/bin/sh\nexit 127\n' > "${STUB_DIR}/codex"
  chmod +x "${STUB_DIR}/codex"
  INVOKE_PATH="${STUB_DIR}:${PATH}"
  note "malformed case: shadowing codex with a failing stub to exercise AC-3 error path"
fi
note "invoking: node ${REA_BIN} review --provider openrouter --json --with-findings"
set +e
OUT="$(cd "${CONSUMER_REPO}" && PATH="${INVOKE_PATH}" node "${REA_BIN}" review --provider openrouter --json --with-findings 2>"${WORK_DIR}/stderr.txt")"
EXIT=$?
set -e
note "exit=${EXIT}"
note "stdout: ${OUT}"
[ -s "${WORK_DIR}/stderr.txt" ] && note "stderr: $(cat "${WORK_DIR}/stderr.txt")"

# ---------------------------------------------------------------------------
# 4. Assertions — JSON shape, exit code, and last-review.json.
# ---------------------------------------------------------------------------

# Expected exit code from the canned verdict (contract: pass/concerns=0 under
# default strictFailOn=blocking; blocking=2; malformed → error → 2).
case "${CANNED_VERDICT}" in
  pass|concerns) EXPECT_EXIT=0 ;;
  blocking)      EXPECT_EXIT=2 ;;
  malformed)     EXPECT_EXIT=2 ;;
esac
[ "${EXIT}" = "${EXPECT_EXIT}" ] || fail "exit code ${EXIT} != expected ${EXPECT_EXIT} for verdict=${CANNED_VERDICT}"
ok "exit code ${EXIT} matches contract for verdict=${CANNED_VERDICT}"

# The stdout must be a single JSON line. Validate with node and assert fields.
EXPECT_STATUS="${CANNED_VERDICT}"
[ "${CANNED_VERDICT}" = "malformed" ] && EXPECT_STATUS="error"

OUT="${OUT}" EXPECT_STATUS="${EXPECT_STATUS}" node -e '
  const out = process.env.OUT.trim();
  let j;
  try { j = JSON.parse(out.split("\n").filter(Boolean).pop()); }
  catch (e) { console.error("stdout is not valid JSON: " + e.message); process.exit(1); }
  const want = process.env.EXPECT_STATUS;
  if (j.status !== want) { console.error(`status=${j.status} != ${want}`); process.exit(1); }
  if (want !== "error") {
    if (j.provider !== "openrouter") { console.error(`provider=${j.provider} != openrouter`); process.exit(1); }
    if (typeof j.finding_count !== "number") { console.error("finding_count missing/not number"); process.exit(1); }
    if (typeof j.exit_code !== "number") { console.error("exit_code missing/not number"); process.exit(1); }
  }
  console.error("[smoke] JSON payload assertions passed");
' || fail "stdout JSON assertions failed"
ok "stdout JSON payload matches contract (status=${EXPECT_STATUS})"

# last-review.json: written for pass/concerns/blocking (NOT for error — there
# are no findings to serialize on the error path, per review.ts).
LRJ="${CONSUMER_REPO}/.rea/last-review.json"
if [ "${CANNED_VERDICT}" = "malformed" ]; then
  ok "error path: last-review.json correctly NOT asserted (no findings to write)"
else
  [ -f "${LRJ}" ] || fail "expected ${LRJ} to be written"
  LRJ="${LRJ}" EXPECT_VERDICT="${CANNED_VERDICT}" node -e '
    const fs = require("fs");
    const p = process.env.LRJ;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (j.schema_version !== 1) { console.error("schema_version != 1"); process.exit(1); }
    if (j.verdict !== process.env.EXPECT_VERDICT) { console.error(`verdict=${j.verdict}`); process.exit(1); }
    if (!Array.isArray(j.findings)) { console.error("findings not an array"); process.exit(1); }
    for (const f of j.findings) {
      if (!["P1","P2","P3"].includes(f.severity)) { console.error("bad severity"); process.exit(1); }
      if (typeof f.title !== "string" || typeof f.body !== "string") { console.error("bad finding shape"); process.exit(1); }
    }
    console.error("[smoke] last-review.json assertions passed");
  ' || fail "last-review.json assertions failed"
  ok "last-review.json schema + verdict match contract"
fi

# Coverage proof: a fresh `rea preflight --json` from the same repo should now
# accept the openrouter review as covering HEAD (status clean) for pass/concerns.
if [ "${CANNED_VERDICT}" = "pass" ] || [ "${CANNED_VERDICT}" = "concerns" ]; then
  set +e
  PF="$(cd "${CONSUMER_REPO}" && node "${REA_BIN}" preflight --json 2>/dev/null)"
  PF_EXIT=$?
  set -e
  PF="${PF}" node -e '
    const j = JSON.parse(process.env.PF.trim().split("\n").filter(Boolean).pop());
    if (j.status !== "clean") { console.error(`preflight status=${j.status} (expected clean)`); process.exit(1); }
    console.error("[smoke] preflight accepts the openrouter review as coverage");
  ' || fail "preflight did NOT accept the openrouter review as coverage (AC-1 regression)"
  ok "preflight accepts openrouter review as coverage (exit ${PF_EXIT})"
fi

ok "ALL cross-repo openrouter smoke assertions passed (mode=${MODE}, verdict=${CANNED_VERDICT})"
exit 0
