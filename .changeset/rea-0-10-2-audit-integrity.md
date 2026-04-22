---
'@bookedsolid/rea': patch
---

Governance recovery + audit integrity + base-branch resolution + audit-chain corruption-tolerance (Defects S + P + N + T + U)

This patch ships five fixes on one branch. S, P, and N were the 0.10.1 scope
that never shipped standalone — the release was superseded by 0.10.2 after T
and U surfaced on the same working tree. All five fixes are independent but
ship together because the push-gate and audit-helper surfaces they touch
overlap enough that landing T and U as a follow-up patch would have required
a second Codex pass over code already under review.

## Defect S — TOFU drift recovery CLI (HIGH — governance recovery path)

Before this patch, the only documented recovery path for a TOFU drift fail-close
was `REA_ACCEPT_DRIFT=<name> rea serve` — a startup env var. When the gateway is
spawned indirectly (Claude Code via `.mcp.json`, a systemd unit, any wrapper that
owns the spawn), the operator has no env-injection surface. A legitimate
registry edit therefore silently removed the drifted server from
`__rea__health.downstreams` and `tools/list`, with the only manual workaround
being to hand-edit `.rea/fingerprints.json`.

New CLI surface:

- **`rea tofu list [--json]`** — prints every server declared in
  `.rea/registry.yaml` with its current-vs-stored fingerprint verdict
  (`first-seen` | `unchanged` | `drifted`) and short fingerprints.
- **`rea tofu accept <name> [--reason <text>]`** — recomputes the current
  canonical fingerprint for `<name>` and writes it to `.rea/fingerprints.json`.
  Emits a `tofu.drift_accepted_by_cli` (or `tofu.first_seen_accepted_by_cli`)
  audit record with BOTH the stored and current fingerprints plus the optional
  reason, so the accept decision is on the hash chain.

The drift banner printed by `src/registry/tofu-gate.ts` now names the new CLI
path first and demotes `REA_ACCEPT_DRIFT` to a one-shot bypass. `rea doctor`'s
drift warning replaces the env-var pointer with `rea tofu list` /
`rea tofu accept <name>`.

## Defect P — `codex.review` audit record forgery surface (CRITICAL — integrity)

Before this patch, any caller with filesystem access to `node_modules` could
write a valid, hash-chained `codex.review` entry claiming any `reviewer` and any
`verdict` for any `head_sha` by importing `node_modules/@bookedsolid/rea/dist/audit/append.js`
and calling `appendAuditRecord()` directly with `tool_name: 'codex.review'`.
Downstream auditors — and the push-review cache gate — could not distinguish
"real Codex CLI ran and passed" from "agent wrote an emit-audit script claiming
Codex passed." The governance promise of `codex.review` was a convention, not an
enforced contract.

New mechanism: `AuditRecord` gains a required `emission_source` field
(`"rea-cli"` | `"codex-cli"` | `"other"`) that is part of the hashed record
body.

- The public `appendAuditRecord()` helper stamps every record with
  `emission_source: "other"`. The field is NOT part of the public
  `AppendAuditInput` shape — external consumers cannot self-assert `"rea-cli"`.
- New `appendCodexReviewAuditRecord()` helper is the ONLY write path that stamps
  `"rea-cli"` for `codex.review` records. `tool_name` and `server_name` are
  fixed inside the helper and excluded from the input type, so callers cannot
  route a generic record through the codex-certification path. Exclusively
  reachable through the `rea audit record codex-review` CLI (classified as a
  Write-tier Bash invocation by `reaCommandTier`, defect E).
- The push-review cache gate's jq predicate now requires
  `.emission_source == "rea-cli" or .emission_source == "codex-cli"` for
  `codex.review` lookups. Records emitted through the generic helper (tagged
  `"other"`) or legacy pre-0.10.2 records (field missing) are rejected.

**Upgrade effect:** The first push on each branch after upgrading to 0.10.2 will
require a fresh `rea audit record codex-review` invocation, because legacy
`codex.review` audit records predate `emission_source`. Subsequent pushes hit
the cache as normal.

**CI impact:** Non-interactive pipelines that invoke the pre-push gate
(e.g. `rea push`, husky pre-push in CI runners) will see one failed push per
branch after upgrade. Bridge with `REA_SKIP_CODEX_REVIEW=<reason>` as the narrow
one-push waiver, or pre-stamp the branch tip with
`rea audit record codex-review --head-sha <sha> --branch <b> --target <t>
--verdict pass --finding-count 0 --also-set-cache` before upgrading. Consumers
who proxied Codex through a gateway-registered MCP and relied on middleware-
written records to satisfy the gate should note that those legacy records also
predate `emission_source` and are rejected until re-emitted.

Regression tests at `src/audit/emission-source.test.ts`: public helper stamps
`"other"` even for `tool_name: "codex.review"`, dedicated helper stamps
`"rea-cli"` and forces canonical tool/server names, `emission_source` is part of
the computed hash (flipping the field breaks the chain).

## Defect N — base-branch resolution consults `branch.<name>.base` (MEDIUM, partial)

Before this patch, `hooks/_lib/push-review-core.sh`'s new-branch base resolution
fell through to `origin/HEAD` when the local branch had no upstream set yet,
without consulting operator-configured per-branch base tracking. A feature
branch targeting `dev` in a main-as-production repo was therefore reviewed
against `origin/main` silently, producing a diff that spanned every commit
between `main` and the feature — often thousands of lines for a handful of real
changes.

This patch adds a per-branch git-config consultation:
`git config branch.<source>.base <ref>` is now read BEFORE the `origin/HEAD`
fallback. When set, the gate diffs against the configured ref (preferring the
remote-tracking form for server-authoritative anchoring) and echoes it as the
`Target:` label. Without a config entry, behavior is unchanged. `configured_base`
is reset to empty at the top of every refspec-loop iteration so multi-refspec
pushes (e.g. `git push --all`) cannot leak state from an earlier iteration's
config lookup (Codex 0.10.1 finding #1).

**Scope note:** This is the opt-in half of N. The fail-loud-when-no-base and
general-label-fix halves remain deferred to defect G's TypeScript port of
`push-review-core.sh`, where the merge-base-anchor / refspec-target separation
can be properly expressed without breaking the existing cache-key contract (an
inline bash attempt was reverted during this patch after it silently invalidated
consumer cache entries for bare pushes).

## Defect T — audit writer serialization self-check (MEDIUM — integrity)

Before this patch, `appendAuditRecord()` called
`fs.appendFile(auditFile, JSON.stringify(record) + '\n')` unconditionally. If a
future regression introduced a non-JSON-safe field into `AuditRecord` (BigInt,
circular reference, undefined in array position, hostile `metadata` value that
survives TypeScript typing but breaks JSON round-trip), the writer would
produce an unparseable line on disk and only surface the failure at
`rea audit verify` time — or, worse, when push-review-core.sh's jq scan
silently failed to find a legitimate `codex.review` record past the corruption
(which is precisely defect U).

This patch adds a pre-append `JSON.parse` self-check. The helper now verifies
the serialized line round-trips before it touches `.rea/audit.jsonl`; a throw
aborts the append without writing and the on-disk chain tail is unchanged.
The diagnostic names the offending `tool_name`/`server_name` so the caller can
localize the regression. This is defense-in-depth against a class of bug that
would otherwise corrupt the hash chain at write time.

The self-check is scoped to the public `appendAuditRecord()` /
`appendCodexReviewAuditRecord()` entry points (both flow through
`doAppend()`). The gateway middleware write at
`src/gateway/middleware/audit.ts` and rotation-marker emission at
`src/gateway/audit/rotator.ts` still use raw `JSON.stringify()` +
`appendFile()` / `writeFile()` without a self-check. Widening T to cover
those paths requires a shared serialization helper and is tracked as a
followup — this patch closes the two entry points that every external
consumer (Helix, Codex CLI, ad-hoc CLI scripts) actually reaches.

Separately, `rea audit verify` now collects every unparseable line across
every file in the walk instead of aborting at the first one. Each failure is
reported as `audit.jsonl:LINE[:COL]  <parser message>`, and chain verification
continues over the parseable subset — a genuine hash tamper on a surviving
record still surfaces alongside the parse failures. The exit code is 1 if
there is any parse failure OR any chain failure; a fully clean file still
reports "Audit chain verified". Empty lines mid-file are a distinct parse
failure class (not silently skipped). Operators bisecting a corrupt audit
file now see every affected line number in one pass.

Tamper diagnostics include BOTH the parseable-subset record index (for
audit-tooling consumers that walk `records[]`) AND the 1-based original-file
line number (for operator workflows that `sed -n Np` or editor:LINE into the
offending record). The two diverge whenever a malformed line precedes the
tamper — the file line is the authoritative jump target.

Regression tests at `src/audit/append.test.ts` (self-check intercept) and
`__tests__/cli/audit-verify-mixed-malformed.test.ts` (five scenarios covering
mixed-corruption, tamper-alongside-parse-failure, tamper-AFTER-malformed-line
with divergent subset/file indices, clean-file success, and mid-file empty
lines).

## Defect U — push-review-core.sh audit scan tolerates malformed lines (HIGH — availability)

Before this patch, `hooks/_lib/push-review-core.sh` used
`jq -e --arg sha "$sha" '<predicate>' "$_audit"` to test whether a
`codex.review` receipt existed for the push's head SHA. jq interprets the
file as a single JSON stream; a single malformed line anywhere in
`.rea/audit.jsonl` (one stray backslash-u-non-hex sequence, one truncated
write) makes jq exit with status 2 BEFORE the `select` ever runs against any
record. Every legitimate codex.review receipt past the corruption becomes
unreachable. The failure is total: every subsequent push that requires a
cache hit is silently blocked until the corrupt line is hand-edited out of
the audit file. One stray byte locks the gate closed.

This patch rewrites the scan as
`jq -R --arg sha "$sha" 'fromjson? | select(<predicate>)' "$_audit" 2>/dev/null | grep -q .`.
`-R` takes each line as a raw string; `fromjson?` is the error-suppressing
parser — malformed lines yield empty output instead of failing the pipeline.
The `select` filter runs against every successfully parsed record. The
predicate (tool_name, head_sha, verdict, emission_source) is unchanged, so
defect P's forgery-rejection guarantee still holds line-by-line.

Mirrored in both `hooks/_lib/push-review-core.sh` (upstream source) and
`.claude/hooks/_lib/push-review-core.sh` (this repo's dogfood install). The
two other jq scans in the file — `cache_result` inspection at approximately
lines 432 and 612, and the cache hit/pass predicate at approximately line
1107 — operate on single-value `printf`'d JSON strings, not on audit.jsonl,
and are left as `jq -e`.

Regression test at `__tests__/hooks/push-review-fromjson-tolerance.test.ts`
drives the exact new pipeline against a scratch audit.jsonl with a malformed
line sandwiched between two valid `codex.review` records with distinct
head_sha values. Both records are findable. The forgery-rejection case
(a hand-written line with `emission_source: "other"` on the far side of a
malformed line) is also covered — tolerance for malformed lines must not
weaken the predicate into "anything passes".

## Followups (not in this patch)

- **G** (push-review-core.sh TS port) — 1154 LOC of shell + jq + awk with 10
  integration test suites that shell out in real git subprocesses. Requires a
  clean-room TS implementation with ≥90% unit coverage and a thin bash shim.
  Tracked separately for 0.11.0.
- **Widen T to gateway middleware + rotation markers** — both paths
  (`src/gateway/middleware/audit.ts` line ~148 and `src/gateway/audit/rotator.ts`
  line ~253) still write raw `JSON.stringify(record)+'\n'` without the
  self-check. No known exploit today (TypeScript input types rule out non-JSON
  field shapes, and proxied MCP metadata is already redacted), but a shared
  serialization helper would make the T guarantee universal. Tracked for a
  future pass.
- Shell-level integration test for defect P's gate predicate (forged record
  with `emission_source: "other"` fails the cache gate). The existing test
  suite passes end-to-end post-patch; a dedicated P integration fixture can be
  added as part of the G rewrite.
- Codex 0.10.1 finding #2: proxied-MCP records through the gateway middleware
  stamp `"rea-cli"` (technically correct — rea is the writer), which means an
  MCP server named `codex` exposing a tool named `review` could produce
  gate-satisfying records via the middleware path if a future middleware also
  populated `metadata.head_sha`/`metadata.verdict`. Today no such middleware
  exists and `ctx.metadata` is `{}` by default, so the residual surface is
  narrow. Track for a future pass: either add a distinct `"rea-gateway"`
  discriminator, or narrow the jq predicate to require a CLI-only metadata
  shape.
- Codex 0.10.1 finding #3: `rea tofu accept` writes the fingerprint before
  appending the audit record. If audit append fails, the on-disk fingerprint
  is updated but unaudited, and a re-run short-circuits on the `stored ===
  current` guard. Track for a future pass — reverse the order (audit first,
  then fingerprint) or explicitly document the recovery procedure in the
  error message.
