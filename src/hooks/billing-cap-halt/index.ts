/**
 * `rea hook billing-cap-halt` — PostToolUse Bash billing→HALT reflex.
 *
 * 0.51.0 — first control on the spend-governance axis (E1 seed slice).
 * Introduced in response to INCIDENT-2026-07-04 (denial-of-wallet on a
 * metered TTS lane): an agent ran uncommitted scripts against a paid API
 * with retry/racing loops, treated a "spending cap exceeded" error as
 * retryable, and blew past the budget cap. rea had NO concept of money
 * anywhere. See `THREAT_MODEL.md §5.25`.
 *
 * # What it does
 *
 * Fires on every Bash PostToolUse. Scans the command's ERROR output for a
 * BILLING-CLASS signature — a TERMINAL, non-retryable spend error (e.g.
 * "spending cap", "prepayment credits are depleted"). On a match it
 * writes `.rea/HALT` (the existing kill-switch that every middleware +
 * hook already respects), turning the field-proven client-side reflex
 * (`BILLING_RE ⇒ process.exit`, no retry) into a governance-layer
 * primitive: stop everything, no retry, zero exceptions.
 *
 * # What it scans — and what it does NOT (codex 0.51.0 round-1/4/7)
 *
 * A billing error is ERROR output from a FAILED metered call — an
 * unhandled SDK/CLI failure surfaces on stderr WITH a non-zero exit. So
 * the gate scans the `stderr` channel ONLY, and ONLY when the command
 * actually FAILED. It NEVER scans the command text, and NEVER scans stdout
 * (not even on failure). Without those restrictions, benign work on a hook
 * that ships enabled on every profile and fires on every Bash call would
 * freeze the session:
 *   - `cat THREAT_MODEL.md` / `rg "spending cap" .` print the watched
 *     phrases to stdout (round-1 P1/P2);
 *   - `grep -R "spending cap" docs missing_dir` exits non-zero yet prints
 *     real doc matches to stdout, with only "No such file" on stderr
 *     (round-4 P1) — a stdout-on-failure scan froze on it;
 *   - a SUCCESSFUL helper/test that logs an example provider response or a
 *     business-domain error to stderr (round-7 P1) — gating on a non-zero
 *     exit makes that a no-op.
 * The phrase set is further restricted to PROVIDER-SPECIFIC billing walls
 * (round-7 P2 — see BILLING_RE) since there is no metered-endpoint scoping
 * yet. Conservatism against false-positive freezes is the governing
 * constraint (a self-inflicted freeze is its own harm). The residual — a
 * billing error printed ONLY to a failed command's stdout — is an accepted
 * gap; PR2's metered-endpoint registry restores full-output scanning once a
 * KNOWN metered host is in play.
 *
 * Billing-class is DELIBERATELY DISTINCT from a mere rate-limit. A `429`
 * / "rate limit" / "usage limit" / "exceeded quota" is retryable
 * (`RATE_LIMIT_REGEX` in `src/gateway/observability/codex-telemetry.ts`
 * already detects those, observe-only). "spending cap exceeded" /
 * "prepayment credits depleted" / "credit balance is too low" /
 * "insufficient_quota" is a wall — retrying it just burns more money. ONLY
 * the billing-class set writes HALT.
 *
 * KNOWN GAP (deliberate, until PR2): generic/ambiguous spend-exhaustion
 * signals — HTTP 402 / "payment required", "insufficient funds|balance",
 * and bare "billing … limit exceeded" — are NOT matched, because they also
 * occur in ordinary payments/subscription app errors and this hook has no
 * metered-endpoint scoping to disambiguate (see BILLING_RE). A provider
 * that reports exhausted spend ONLY as a 402 is therefore not caught here
 * yet; PR2's endpoint registry restores those forms scoped to a known
 * metered host, where the 402 is unambiguously a provider billing wall.
 *
 * # Response modes (`policy.spend_governance.billing_error_response`)
 *
 *   - `warn` (SEED DEFAULT) — emit banner + exit 0, do NOT write HALT. A
 *                        true non-freezing advisory: exit 0 so the
 *                        triggering Bash call is NOT marked failed (codex
 *                        round-12 P2), matching the other advisory
 *                        PostToolUse hooks; the banner surfaces the finding.
 *                        This is the seed default because a phrase-only
 *                        global freeze is unsafe without endpoint scoping
 *                        (round-12 P1).
 *   - `halt`           — write `.rea/HALT` + emit banner + exit 2. Explicit
 *                        opt-in for the freeze; becomes the default once
 *                        PR2's metered-endpoint scoping lands.
 *   - `off`            — silent no-op (exit 0) even on a match.
 *
 * `enabled: false` → silent no-op. An absent `spend_governance` block is the
 * opt-out DEFAULT (enabled, `warn`).
 *
 * # Fail posture (discussed explicitly per the incident lesson)
 *
 * A billing reflex that SILENTLY DISAPPEARS is the incident. So the two
 * failure surfaces are handled with opposite biases, on purpose:
 *
 *   - CLI-MISSING (shim tier): FAIL-CLOSED. The `billing-cap-halt.sh`
 *     shim sets `SHIM_FAIL_OPEN=0` and only reaches the "CLI missing"
 *     branch as relevant when the raw payload already carries a billing
 *     keyword — so a genuine billing signal with no CLI to enforce it
 *     surfaces loudly (banner + exit 2) instead of vanishing. A payload
 *     with no billing keyword and no CLI exits 0 (no spam on every Bash).
 *
 *   - MALFORMED / UNREADABLE payload (this body): FAIL-SAFE (exit 0, no
 *     HALT). We only ACT on a POSITIVE match in successfully-parsed
 *     content. Halting on unparseable input would be a self-inflicted
 *     denial-of-service — freezing the session on garbage input is itself
 *     an availability harm, and the parent incident was about SPEND, not
 *     input integrity. Conservatism against false-positive freezes (the
 *     explicit design constraint) governs here.
 *
 * HALT short-circuit is the first line, uniform with every other hook:
 * when `.rea/HALT` already exists we exit 2 with the shared banner and
 * never re-write it (idempotency falls out for free — a second billing
 * match under an existing freeze does not churn the file).
 */

import type { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkHalt, formatHaltBanner } from '../_lib/halt-check.js';
import {
  parsePostToolUsePayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import { writeHaltFile, sanitizeHaltReason } from '../../cli/freeze.js';
import { appendAuditRecord } from '../../audit/append.js';
import { InvocationStatus, Tier } from '../../policy/types.js';

export type BillingErrorResponse = 'halt' | 'warn' | 'off';

/**
 * Durable audit trail for a billing match (codex 0.51.0 round-13 P2). The
 * banner is ephemeral and `.rea/HALT` is removed on `rea unfreeze`, so
 * without this a `warn` match — or a freeze that was later cleared — leaves
 * no record that the spend-governance reflex ever fired. Appends one
 * hash-chained record to `.rea/audit.jsonl` (`rea.spend_governance.billing`)
 * carrying ONLY the sanitized, bounded signature (never raw vendor output),
 * the mode, and whether HALT was written. Best-effort: an audit failure must
 * NOT break the reflex, so this swallows errors — the banner/HALT are the
 * primary effect, the audit is secondary observability.
 */
async function recordBillingAudit(
  reaRoot: string,
  info: { action: 'warn' | 'halt'; matched: string; haltWritten: boolean; writeError?: string },
): Promise<void> {
  try {
    await appendAuditRecord(reaRoot, {
      tool_name: 'rea.spend_governance.billing',
      server_name: 'billing-cap-halt',
      // A freeze DENIES further work; a warn is an advisory that ALLOWS the
      // call to proceed. Reflect that in the audit status.
      status: info.action === 'halt' ? InvocationStatus.Denied : InvocationStatus.Allowed,
      tier: Tier.Destructive,
      metadata: {
        kind: 'billing-cap-halt',
        action: info.action,
        signature: info.matched,
        halt_written: info.haltWritten,
        ...(info.writeError !== undefined ? { halt_write_error: info.writeError } : {}),
      },
    });
  } catch {
    /* observability is secondary — never let an audit failure break the gate */
  }
}

export interface BillingCapHaltOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface BillingCapHaltResult {
  exitCode: number;
  stderr: string;
  /** What the reflex did. */
  action: 'halt' | 'warn' | 'noop';
  /** The billing signature that matched (sanitized snippet), or null. */
  matched: string | null;
  /** Whether this invocation wrote `.rea/HALT`. */
  haltWritten: boolean;
}

/**
 * Billing-class signature set. TERMINAL / non-retryable spend errors —
 * kept DISTINCT from the retryable rate-limit set on purpose (see the
 * file header). Conservative by design: each alternative is a
 * money-specific phrase that a 429 / throttle / quota-window error does
 * NOT contain, so a routine rate-limit never triggers a freeze.
 *
 * PROVIDER-SPECIFIC ONLY (codex 0.51.0 round-7 P2). This hook fires on
 * every Bash PostToolUse and has NO metered-endpoint scoping yet (that is
 * PR2), so the pattern is deliberately restricted to phrases that are
 * unambiguous MODEL-PROVIDER billing walls — not generic HTTP/business-
 * domain errors that a failing app-under-test legitimately emits. In
 * particular `payment required` / `402` (paywall & 402 flows) and
 * `insufficient funds|credits|balance` (banking / business-domain test
 * output) are EXCLUDED here; PR2 restores broader matching scoped to a
 * KNOWN metered host, where the ambiguity is resolved by the endpoint.
 *
 * Pattern list (case-insensitive), with provenance:
 *   - `spending cap`                         — field-proven (Gemini, the
 *                                              incident's own `BILLING_RE`)
 *   - `prepayment credits (are) depleted`    — field-proven (Gemini)
 *   - `credit balance is too low`            — Anthropic billing
 *   - `insufficient_quota`                   — OpenAI billing error CODE
 *                                              (the machine code, not the
 *                                              ambiguous prose)
 *
 * Deliberately NOT included: `payment required` / `402`, `insufficient
 * funds/credits/balance` (round-7 P2), AND the generic `billing (cap|limit)
 * … exceeded/reached` (round-14 P2) — the bare word "billing" appears in
 * ordinary subscription/billing-domain app errors ("billing limit for this
 * account exceeded"), so it is too broad for a hook with no endpoint
 * scoping. PR2 restores broader matching scoped to a KNOWN metered host,
 * where the ambiguity is resolved by the endpoint. Also excluded: the
 * retryable RATE_LIMIT_REGEX set (`429`, `rate limit`, `usage limit`,
 * `exceeded quota`, `too many requests`, `resource exhausted`, `deadline
 * exceeded`).
 */
export const BILLING_RE =
  /spending cap|prepayment credits (?:are )?depleted|credit balance is too low|insufficient_quota/i;

interface RawSpendGovernance {
  enabled?: unknown;
  billing_error_response?: unknown;
}

/**
 * Read `spend_governance.{enabled,billing_error_response}` permissively
 * from `.rea/policy.yaml`. We deliberately do NOT use the strict
 * `loadPolicy()` here (same reasoning as architecture-review-gate): the
 * strict zod schema throws on any legacy / unknown key ANYWHERE in the
 * file, which would silently disable the billing reflex for a consumer
 * whose policy has one stray field. The canonical `yaml.parse` accepts
 * the whole document; we pull just the two fields we need and validate
 * them locally.
 *
 * OPT-OUT model (codex 0.51.0 round-5): the reflex is ON for any present
 * rea policy unless positively disabled. This is the incident mandate
 * ("default ON, zero-exception") and it closes the upgrade dead-hook gap —
 * a repo upgrading from 0.50.x gets `billing-cap-halt.sh` registered but
 * has no `spend_governance` block yet; treating that absence as ENABLED
 * means the guard is live immediately instead of silently inert until
 * someone re-runs `rea init`.
 *
 * Returns `{ enabled: false }` (disabled) ONLY for:
 *   - a missing/unreadable policy FILE (genuine no-config — no rea policy
 *     for this checkout at all), OR
 *   - a present, valid block that POSITIVELY opts out:
 *     `spend_governance.enabled: false`, or `billing_error_response: off`
 *     (the caller treats `off` as no-op).
 *
 * Everything else on a PRESENT file resolves to PROTECTION
 * (`{ enabled: true, mode: 'warn' }` — the SEED default; see below):
 *   - absent `spend_governance` block (opt-out default),
 *   - unparseable YAML (syntax error / mid-edit merge conflict) — round-2 P2,
 *   - a malformed block shape the strict loader would reject
 *     (`spend_governance: []` / `"on"`, or `enabled: "true"`) — round-5 P2.
 * Dropping the last-resort spend guard during a broken/mid-edit policy is
 * the wrong direction for a safety control.
 *
 * The protection LEVEL is the SEED default `warn` (round-12 P1): the reflex
 * detects + banners + audits but does NOT freeze, because a phrase-only
 * global `halt` would false-freeze finance/payments-domain repos that emit
 * the same phrases. `halt` is an explicit opt-in and becomes the default
 * once PR2's metered-endpoint scoping supplies the provider discriminator.
 *
 * `billing_error_response` is validated against the enum; any other value
 * (including a typo the strict loader would reject) is treated as the
 * default `'warn'`.
 */
function readSpendGovernance(reaRoot: string): {
  enabled: boolean;
  mode: BillingErrorResponse;
} {
  const disabled = { enabled: false, mode: 'warn' as BillingErrorResponse };
  // PROTECT = enabled with the SEED default mode `warn` (round-12 P1): a
  // degraded/absent policy detects + banners + audits but does NOT freeze,
  // since a phrase-only global halt is unsafe without endpoint scoping.
  const protect = { enabled: true, mode: 'warn' as BillingErrorResponse };
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch (err) {
    // A MISSING file (ENOENT) is genuine no-config → disabled. Any OTHER
    // read failure — EACCES (permissions regression), EIO (transient), a
    // directory at the path (EISDIR) — is a PRESENT-but-degraded policy, so
    // fail toward PROTECTION, consistent with the parse-error / malformed-
    // block / CLI-missing posture (codex round-9 P2). A spend guard must not
    // silently vanish just because the file could not be read.
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return disabled;
    }
    return protect;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    // Present but UNPARSEABLE (syntax error / merge conflict) → fail-safe
    // toward protection rather than silently dropping the guard.
    return protect;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Present file whose whole document is not a mapping (bare scalar /
    // array) — malformed policy → protect.
    return protect;
  }
  const sg = (parsed as Record<string, unknown>)['spend_governance'];
  if (sg === undefined || sg === null || typeof sg !== 'object' || Array.isArray(sg)) {
    // OPT-OUT DEFAULT (round-5 P1/P2). An ABSENT block → protect: the reflex
    // is ON for any present rea policy unless positively disabled, so a repo
    // upgrading from 0.50.x (hook registered, no block yet) is guarded
    // immediately instead of shipping a dead hook. A malformed non-object
    // shape (`spend_governance: []` / `"on"`) — which the strict loader
    // rejects — also protects rather than silently disabling.
    return protect;
  }
  const block = sg as RawSpendGovernance;
  // Opt-out: enabled UNLESS positively set to the literal boolean false. A
  // malformed `enabled` (e.g. the string "true") is not literal false, so it
  // stays protected rather than silently disabling (round-5 P2).
  const enabled = block.enabled !== false;
  let mode: BillingErrorResponse = 'warn';
  const rawMode = block.billing_error_response;
  if (rawMode === 'warn' || rawMode === 'off' || rawMode === 'halt') {
    mode = rawMode;
  }
  return { enabled, mode };
}

function buildBanner(matched: string, mode: 'halt' | 'warn'): string {
  const head =
    mode === 'halt'
      ? 'BILLING HALT: metered-spend billing error detected — session frozen'
      : 'BILLING WARNING: metered-spend billing error detected';
  const lines = [
    `${head}\n`,
    '\n',
    `  Signature: ${matched}\n`,
    '\n',
    '  A billing-class error is TERMINAL — it is NOT a rate limit (429).\n',
    '  Retrying it multiplies spend against a metered endpoint. Do NOT retry.\n',
  ];
  if (mode === 'halt') {
    lines.push(
      '\n',
      '  .rea/HALT written — all governed tool calls are now blocked.\n',
      '  Investigate the billing state, then `rea unfreeze` to resume.\n',
    );
  } else {
    lines.push(
      '\n',
      '  spend_governance.billing_error_response is `warn` — no HALT written.\n',
      '  Stop issuing further requests to the metered endpoint.\n',
    );
  }
  return lines.join('');
}

/**
 * Banner for the degraded case where a billing signature matched under
 * `halt` mode but `.rea/HALT` could NOT be written. Must NOT claim the
 * session is frozen (it isn't) — it tells the operator the reflex is
 * degraded and the freeze must be applied manually.
 */
function buildWriteFailedBanner(matched: string, errMsg: string): string {
  return [
    'BILLING HALT (DEGRADED): billing error detected but .rea/HALT could NOT be written\n',
    '\n',
    `  Signature: ${matched}\n`,
    `  Write error: ${sanitizeHaltReason(errMsg).slice(0, 200)}\n`,
    '\n',
    '  A billing-class error is TERMINAL — do NOT retry.\n',
    '  The session is NOT frozen (the HALT file could not be created).\n',
    '  Stop all metered requests and run `rea freeze` manually, or fix the\n',
    '  filesystem permissions so the reflex can write .rea/HALT.\n',
  ].join('');
}

export async function runBillingCapHalt(
  options: BillingCapHaltOptions = {},
): Promise<BillingCapHaltResult> {
  const reaRoot = options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 1. HALT short-circuit (uniform with every hook). If already frozen we
  //    exit 2 with the shared banner and do NOT re-write HALT — this is
  //    what makes a repeated billing match idempotent.
  const halt = checkHalt(reaRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, action: 'noop', matched: null, haltWritten: false };
  }

  // 2. Policy gate. Absent block / enabled:false / mode:off → no-op.
  const { enabled, mode } = readSpendGovernance(reaRoot);
  if (!enabled || mode === 'off') {
    return { exitCode: 0, stderr, action: 'noop', matched: null, haltWritten: false };
  }

  // 3. Parse the payload (command + output). A parse failure is FAIL-SAFE:
  //    exit 0, no HALT (see the header — never a false-positive freeze on
  //    unparseable input). A one-line breadcrumb goes to stderr so the
  //    failure is observable without being a gate.
  //    Read with a GENEROUS byte cap (codex round-16 P2): the default
  //    1 MiB cap would truncate a verbose command's payload into invalid
  //    JSON, and a truncated document parses-fails → the "skip, no freeze"
  //    path → the billing wall at the END of the output is missed. Claude
  //    Code already truncates `tool_response` upstream, so a real
  //    PostToolUse payload is far under 32 MiB; the cap only bounds memory
  //    against a pathological caller. A payload beyond even this is treated
  //    as malformed (no-op, fail-safe) — the accepted residual.
  const BILLING_STDIN_CAP = 32 * 1024 * 1024;
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000, BILLING_STDIN_CAP);

  let payloadStderr = '';
  let payloadStdout = '';
  let errored = false;
  try {
    const payload = parsePostToolUsePayload(stdinRaw);
    payloadStderr = payload.stderr;
    payloadStdout = payload.stdout;
    errored = payload.errored;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr('billing-cap-halt: payload unreadable; skipping (no freeze on malformed input)\n');
      return { exitCode: 0, stderr, action: 'noop', matched: null, haltWritten: false };
    }
    throw err;
  }

  // 4. Scan STDERR, and ONLY when the command actually FAILED. A genuine
  //    billing wall is an ERROR: an unhandled SDK/CLI failure surfaces on
  //    stderr WITH a non-zero exit. Two guards, both load-bearing:
  //
  //    - Gate on `errored` (round-7 P1): a SUCCESSFUL command that prints a
  //      matching phrase to stderr — an example provider response, a
  //      business-domain log, a passing test's diagnostic — must not freeze
  //      the session. Only a failed command's stderr is a candidate.
  //    - stderr only, never stdout even on failure (round-4 P1): `grep -R
  //      "spending cap" docs missing_dir` exits non-zero on the missing path
  //      but prints real doc matches to stdout; its stderr is just "No such
  //      file". Scanning stdout there would false-freeze.
  //
  //    Command text is never scanned. The residual gap (a billing error
  //    printed only to a failed command's stdout) is accepted for this
  //    coarse backstop; PR2's metered-endpoint registry restores full-output
  //    scanning where a KNOWN metered host justifies it. `payloadStdout`
  //    stays parsed (shared parser, PR2-ready) but is not consulted here.
  void payloadStdout;
  const haystack = errored ? payloadStderr : '';
  const m = BILLING_RE.exec(haystack);
  if (m === null) {
    return { exitCode: 0, stderr, action: 'noop', matched: null, haltWritten: false };
  }

  // Sanitize + bound the matched snippet before it goes anywhere near a
  // banner or the HALT file — the match came from untrusted vendor output
  // and could carry terminal-escape / control bytes.
  const matched = sanitizeHaltReason(m[0]).slice(0, 120) || 'billing-class error';

  // 5. Act per mode.
  if (mode === 'warn') {
    // Advisory: emit the banner but exit 0 (codex round-12 P2). A
    // PostToolUse exit 2 marks the triggering Bash action failed; `warn`
    // is the non-freezing mode, so it must NOT block the call — it just
    // surfaces the banner (like the other advisory PostToolUse hooks).
    writeStderr(buildBanner(matched, 'warn'));
    await recordBillingAudit(reaRoot, { action: 'warn', matched, haltWritten: false });
    return { exitCode: 0, stderr, action: 'warn', matched, haltWritten: false };
  }

  // mode === 'halt'
  const reason = sanitizeHaltReason(
    `billing-cap-halt: billing-class error detected ("${matched}") — automated freeze, no retry`,
  );
  try {
    writeHaltFile(reaRoot, reason);
  } catch (err) {
    // Writing HALT failed (permissions, read-only FS). Do NOT emit the
    // standard "HALT written — all governed tool calls are now blocked"
    // banner: that would tell the operator the session is frozen when no
    // HALT file exists and later commands are still allowed (codex
    // round-1 P1). Emit an explicit degraded-state banner instead, still
    // exit 2 so the reflex does not silently disappear and the agent is
    // told to stop.
    const writeError = err instanceof Error ? err.message : String(err);
    writeStderr(buildWriteFailedBanner(matched, writeError));
    await recordBillingAudit(reaRoot, { action: 'halt', matched, haltWritten: false, writeError });
    return { exitCode: 2, stderr, action: 'halt', matched, haltWritten: false };
  }
  writeStderr(buildBanner(matched, 'halt'));
  await recordBillingAudit(reaRoot, { action: 'halt', matched, haltWritten: true });
  return { exitCode: 2, stderr, action: 'halt', matched, haltWritten: true };
}

/**
 * CLI entry — `rea hook billing-cap-halt`.
 */
export async function runHookBillingCapHalt(
  options: BillingCapHaltOptions = {},
): Promise<void> {
  const result = await runBillingCapHalt({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
